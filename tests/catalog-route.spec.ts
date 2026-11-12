/**
 * Host route tests for the catalog read route ('subagents.catalog'): the
 * parent's direct children folded off its durable log, which is the only
 * authoritative source for a child spawned after this client loaded its
 * projections.
 *
 * The fold mirrors the host's own `subagentCatalog` projection (see
 * `@deepseek-ai/dsh-subagent`'s `catalog.ts`): `subagent/catalog` rows past
 * the fork-inherited prefix, last-wins per child id, external children and
 * malformed rows dropped.
 */
import { describe, expect, it, vi } from 'vitest'
import { buildCatalogApi, catalogEntriesOf } from '../src/catalog-route.ts'
import { SidebarError } from '../src/wire.ts'
import type { Context, SidebarSessionEvent } from '../src/context-types.ts'

/** One `subagent/catalog` event. */
const row = (
  childId: string,
  over: Record<string, unknown> = {},
  seq = 0,
): SidebarSessionEvent => ({
  type: 'subagent/catalog',
  seq,
  time: seq,
  data: { version: 1, childId, childCreatedAt: 1000 + seq, mode: 'continuable', label: `L-${childId}`, ...over },
})

describe('catalogEntriesOf', () => {
  it('folds catalog rows in event order', () => {
    expect(catalogEntriesOf([row('a', {}, 0), row('b', { mode: 'one-shot' }, 1)], 0)).toEqual([
      { id: 'a', createdAt: 1000, mode: 'continuable', label: 'L-a' },
      { id: 'b', createdAt: 1001, mode: 'one-shot', label: 'L-b' },
    ])
  })

  it('ignores rows inside the fork-inherited prefix', () => {
    // The ancestor's children are not this session's children.
    expect(catalogEntriesOf([row('inherited', {}, 0), row('own', {}, 2)], 2)).toEqual([
      { id: 'own', createdAt: 1002, mode: 'continuable', label: 'L-own' },
    ])
  })

  it('drops external children and malformed rows, keeps unknown modes', () => {
    const entries = catalogEntriesOf([
      row('external', { mode: 'external' }, 0),
      { type: 'subagent/catalog', seq: 1, time: 1, data: { childId: '' } },
      { type: 'subagent/catalog', seq: 2, time: 2, data: {} },
      row('weird', { mode: 'future-mode' }, 3),
      { type: 'assistant/message', seq: 4, time: 4, data: {} },
    ], 0)
    expect(entries).toEqual([{ id: 'weird', createdAt: 1003, mode: 'unknown', label: 'L-weird' }])
  })

  it('keeps the last fact about a child (the log is append-only)', () => {
    expect(catalogEntriesOf([
      row('a', { label: 'first' }, 0),
      row('a', { label: 'second' }, 1),
    ], 0)).toEqual([{ id: 'a', createdAt: 1001, mode: 'continuable', label: 'second' }])
  })

  it('omits an empty label instead of carrying it', () => {
    expect(catalogEntriesOf([row('a', { label: '' }, 0)], 0)).toEqual([
      { id: 'a', createdAt: 1000, mode: 'continuable' },
    ])
  })
})

/** A context serving the subagents catalog route's dependencies. */
function ctxWith(sessions: unknown, persistence: unknown): Context {
  return {
    sessions,
    get: (key: string) => {
      if (key === 'sessionPersistence') return persistence
      return undefined
    },
  } as unknown as Context
}

describe('subagents.catalog route', () => {
  it('reads a live session log without touching persistence', async () => {
    const persistence = { open: vi.fn() }
    const ctx = ctxWith(
      { get: () => ({ header: { cwd: '/p' }, snapshotEvents: () => [row('child', {}, 0)] }) },
      persistence,
    )
    const api = buildCatalogApi(ctx)
    await expect(api.subagentsCatalog({ sessionId: 'parent' })).resolves.toEqual({
      entries: [{ id: 'child', createdAt: 1000, mode: 'continuable', label: 'L-child' }],
    })
    expect(persistence.open).not.toHaveBeenCalled()
  })

  it('reads a cold session through the persistence handle and closes it', async () => {
    const close = vi.fn(async () => {})
    const open = vi.fn(async () => ({
      header: { cwd: '/p' },
      inheritedEventCount: 0,
      read: async () => ({ events: [row('cold-child', {}, 0)] }),
      close,
    }))
    const api = buildCatalogApi(ctxWith({ get: () => undefined }, { open }))
    await expect(api.subagentsCatalog({ sessionId: 'parent' })).resolves.toEqual({
      entries: [{ id: 'cold-child', createdAt: 1000, mode: 'continuable', label: 'L-cold-child' }],
    })
    expect(close).toHaveBeenCalled()
  })

  it('answers an empty catalog for a session that cannot be read', async () => {
    const open = vi.fn(async () => { throw new Error('missing') })
    const api = buildCatalogApi(ctxWith({ get: () => undefined }, { open }))
    await expect(api.subagentsCatalog({ sessionId: 'gone' })).resolves.toEqual({ entries: [] })
  })

  it('degrades to a 503 when a cold read has no persistence service', async () => {
    const api = buildCatalogApi(ctxWith({ get: () => undefined }, undefined))
    await expect(api.subagentsCatalog({ sessionId: 'parent' })).rejects.toThrowError(
      expect.objectContaining<Partial<SidebarError>>({ code: 'subagents-unavailable', status: 503 }),
    )
  })

  it('requires a sessionId', async () => {
    const api = buildCatalogApi(ctxWith({ get: () => undefined }, {}))
    await expect(api.subagentsCatalog({})).rejects.toThrowError(
      expect.objectContaining<Partial<SidebarError>>({ code: 'bad-request' }),
    )
  })
})
