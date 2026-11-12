/**
 * Component-level regression for the Subagent page catalog FRESHNESS overlay:
 * a child spawned after the client loaded its projections must still appear.
 *
 * DSH loads every session's projections once per connection and
 * `refreshProjections` returns early on a `ready` session, so the parent's
 * newly appended `subagent/catalog` row never reaches the snapshot. The page
 * therefore re-reads the tree's catalogs from the host (`subagents.catalog`)
 * and folds only the rows the snapshot does not have yet.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { SubagentView } from '../src/client/SubagentView.tsx'
import type { Context, SidebarSessionList } from '../src/context-types.ts'

setupReactAct()

/** A subscribable sessions-list snapshot (mirror of the runtime list feed). */
function makeStore(initial: SidebarSessionList) {
  const snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
  }
}

function jsonResponse(value: unknown): Response {
  return { ok: true, status: 200, json: async () => value } as unknown as Response
}

/** The snapshot as this client's single projection read left it: one child. */
function staleSnapshot(): SidebarSessionList {
  return {
    byId: {
      root: { id: 'root', displayTitle: '主会话' },
      early: { id: 'early', displayTitle: 'Early', origin: 'subagent', parentId: 'root', running: true },
    },
    projectionsBySession: {
      root: {
        values: { subagentCatalog: [{ id: 'early', createdAt: 1_000, mode: 'one-shot', label: 'Early' }] },
        state: 'ready',
        error: null,
      },
      early: { values: { subagentCatalog: [] }, state: 'ready', error: null },
    },
  }
}

function makeCtx(store: ReturnType<typeof makeStore>): Context {
  return {
    sessions: { list: store, open: () => {} },
    get: () => undefined,
  } as unknown as Context
}

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  for (const el of document.querySelectorAll('body > div')) el.remove()
})

describe('SubagentView catalog freshness', () => {
  it('renders a child the snapshot never carried, read from the host', async () => {
    vi.useFakeTimers()
    const catalogCalls: string[] = []
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split('/').pop()
      const body = JSON.parse(String(init?.body ?? '{}')) as { rootSessionId?: string; sessionId?: string }
      if (method === 'subagents.catalog') {
        catalogCalls.push(body.sessionId ?? '')
        // The host knows the child the snapshot predates.
        return jsonResponse({
          ok: true,
          value: {
            entries: body.sessionId === 'root'
              ? [
                { id: 'early', createdAt: 1_000, mode: 'one-shot', label: 'Early' },
                { id: 'late', createdAt: 2_000, mode: 'one-shot', label: 'Late' },
              ]
              : [],
          },
        })
      }
      if (method === 'subagents.live') {
        return jsonResponse({ ok: true, value: { live: { early: { running: true }, late: { running: true } } } })
      }
      if (method === 'workflows.list') return jsonResponse({ ok: true, value: { runs: [] } })
      return jsonResponse({ ok: true, value: {} })
    })

    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(makeStore(staleSnapshot())) }),
    )
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })

    // The overlay asked the host about the tree's parents…
    expect(catalogCalls).toContain('root')
    // …and the child only the host knew about is in the topology now.
    expect(container.querySelector('[data-graph-node="late"]')).not.toBeNull()
    // The snapshot's own child is not duplicated by the overlay.
    expect(container.querySelectorAll('[data-graph-node="early"]').length).toBe(1)
    unmount()
  })
})
