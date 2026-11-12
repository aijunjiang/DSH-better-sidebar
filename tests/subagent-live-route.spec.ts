/**
 * Host route tests for the Subagent live-preview batch API ('subagents.live').
 * The route must enumerate the tree ONCE, keep only catalog-running
 * non-Side-Chat children, fold only non-empty activity from their session
 * logs, and degrade to a 503 when the host subagent runtime is absent.
 */
import { describe, expect, it, vi } from 'vitest'
import { buildSubagentLiveApi } from '../src/subagent-live-route.ts'
import { SidebarError } from '../src/wire.ts'
import type {
  Context,
  SidebarSessionEvent,
  SidebarSubagentDescendantEntry,
  SidebarSubagentsService,
} from '../src/context-types.ts'

/** One child descendant row. */
function child(
  id: string,
  over: Partial<Extract<SidebarSubagentDescendantEntry, { kind: 'child' }>> = {},
): SidebarSubagentDescendantEntry {
  return {
    kind: 'child',
    id,
    activity: 'running',
    hasChildren: false,
    mode: 'one-shot',
    parentId: 'root',
    depth: 1,
    ...over,
  }
}

/** One diagnostic descendant row. */
function diagnostic(id: string): SidebarSubagentDescendantEntry {
  return { kind: 'diagnostic', id, reason: 'corrupt', parentId: 'root', depth: 1 }
}

/** A session with the given raw events. */
function session(events: SidebarSessionEvent[]): { header: { cwd: string }; snapshotEvents(): readonly SidebarSessionEvent[] } {
  return { header: { cwd: '/p' }, snapshotEvents: () => events }
}

/** A context whose `get` serves only the subagents face, with a session store. */
function ctxWith(subagents: unknown, sessions: unknown): Context {
  return {
    sessions,
    get: (key: string) => (key === 'subagents' ? subagents : undefined),
  } as unknown as Context
}

/** One tool call event. */
const call = (callId: string, name: string, args = '{}', seq = 0, time = 0): SidebarSessionEvent =>
  ({ type: 'tool/call', seq, time, data: { callId, name, arguments: args } })

/** A settled tool result for one call id (kept for upcoming fold specs). */
export const result = (callId: string, seq = 0, time = 0): SidebarSessionEvent =>
  ({ type: 'tool/result', seq, time, data: { message: { source: { kind: 'tool', callId } } } })

/** A descriptor event marking a Side Chat thread (the plugin's own marker). */
const sidechatDescriptor = (seq = 0): SidebarSessionEvent => ({
  type: 'subagent/descriptor',
  seq,
  time: 0,
  data: { mode: 'continuable', provider: 'sidechat', label: 'Side: chat' },
})

/** An assistant message carrying text. */
const reply = (text: string, seq = 0, time = 0): SidebarSessionEvent =>
  ({ type: 'assistant/message', seq, time, data: { message: { content: [{ type: 'text', text }] } } })

describe('subagents.live route', () => {
  it('reports every child with its catalog flag and folded range', async () => {
    const subagents: SidebarSubagentsService = {
      listDescendants: vi.fn(async () => [
        child('running-a', { label: 'A' }),
        child('running-b', { label: 'B' }),
        child('inactive', { activity: 'inactive', label: 'C' }),
        child('side-chat', { label: 'Side: chat' }),
        diagnostic('corrupt-row'),
      ]),
    }
    const sessions = {
      get: (id: string) => {
        if (id === 'running-a') return session([reply('hello', 1, 1)])
        if (id === 'running-b') return session([call('c1', 'bash', '{"command":"ls"}', 1, 1)])
        if (id === 'side-chat') return session([sidechatDescriptor()])
        return session([])
      },
    }
    const api = buildSubagentLiveApi(ctxWith(subagents, sessions))
    const live = (await api.live({ rootSessionId: 'root' })).live
    // The topology root is reported too (its activity flag is the caller's).
    expect(live.root).toEqual({})
    expect(live['running-a']?.running).toBe(true)
    expect(live['running-a']?.text).toBe('hello')
    expect(live['running-b']?.summary).toEqual({
      counts: [{ kind: 'commands', count: 1 }],
      running: 'commands',
      runningDetail: 'ls',
    })
    // A settled child is still a row: its summary drives its card.
    expect(live.inactive?.running).toBe(false)
    // Side Chat threads and diagnostics are not topology.
    expect(live['side-chat']).toBeUndefined()
    expect(live['corrupt-row']).toBeUndefined()
    expect(subagents.listDescendants).toHaveBeenCalledWith('root')
  })

  it('keeps an ordinary child whose LABEL starts with the side-chat prefix', async () => {
    // `listDescendants` fills `label` from the parent's `subagent/catalog`
    // row — the CREATION label, which is model-authored text. A spawn label
    // that merely reads "Side: ..." is not a thread: only the descriptor's
    // provider marks one. This child must keep its live line.
    const subagents: SidebarSubagentsService = {
      listDescendants: vi.fn(async () => [
        child('lookalike', { label: 'Side: migrate the parser' }),
        child('thread', { label: 'Side: chat' }),
      ]),
    }
    const sessions = {
      get: (id: string) => {
        if (id === 'lookalike') return session([reply('working on it', 1, 1)])
        return session([sidechatDescriptor()])
      },
    }
    const api = buildSubagentLiveApi(ctxWith(subagents, sessions))
    const live = (await api.live({ rootSessionId: 'root' })).live
    expect(live.lookalike?.text).toBe('working on it')
    expect(live.thread).toBeUndefined()
  })

  it('does not inherit the side-chat marker through a fork seed', async () => {
    // A seeded child replays its ANCESTOR's descriptor in the fork-inherited
    // prefix; only its OWN descriptor (seq >= inheritedEventCount) decides,
    // so an ordinary subagent spawned from inside a thread is not hidden.
    const subagents: SidebarSubagentsService = {
      listDescendants: vi.fn(async () => [child('seeded', { label: 'worker' })]),
    }
    const persistence = {
      open: vi.fn(async () => ({
        header: { cwd: '/p' },
        inheritedEventCount: 1,
        read: async () => ({
          events: [
            // Inherited: the parent thread's own descriptor.
            { type: 'subagent/descriptor', seq: 0, time: 0, data: { mode: 'continuable', provider: 'sidechat', label: 'Side: chat' } },
            // Own: an ordinary one-shot child.
            { type: 'subagent/descriptor', seq: 1, time: 1, data: { mode: 'one-shot', provider: 'dsh' } },
          ] as SidebarSessionEvent[],
        }),
        close: async () => {},
      })),
    }
    const ctx = {
      sessions: { get: () => undefined },
      get: (key: string) => (key === 'subagents' ? subagents : key === 'sessionPersistence' ? persistence : undefined),
    } as unknown as Context
    const live = (await buildSubagentLiveApi(ctx).live({ rootSessionId: 'root' })).live
    expect(live.seeded).toEqual({ running: true })
  })

  it('degrades to a 503 when the subagent runtime is absent', async () => {
    const api = buildSubagentLiveApi(ctxWith(undefined, { get: () => undefined }))
    await expect(api.live({ rootSessionId: 'root' })).rejects.toThrowError(
      expect.objectContaining<Partial<SidebarError>>({ code: 'subagents-unavailable', status: 503 }),
    )
  })

  it('degrades to a 503 when listDescendants fails', async () => {
    const subagents: SidebarSubagentsService = {
      listDescendants: vi.fn(async () => { throw new Error('projection unavailable') }),
    }
    const api = buildSubagentLiveApi(ctxWith(subagents, { get: () => undefined }))
    await expect(api.live({ rootSessionId: 'root' })).rejects.toThrowError(
      expect.objectContaining<Partial<SidebarError>>({ code: 'subagents-unavailable', status: 503 }),
    )
  })

  it('rejects a missing rootSessionId as bad-request', async () => {
    const api = buildSubagentLiveApi(ctxWith(undefined, { get: () => undefined }))
    await expect(api.live({})).rejects.toThrowError(
      expect.objectContaining<Partial<SidebarError>>({ code: 'bad-request' }),
    )
  })
})
