/**
 * The catalog read route of the Subagent page ('subagents.catalog'): the
 * parent's direct children read from the HOST's durable log instead of the
 * client's projection snapshot.
 *
 * Why the plugin cannot trust the snapshot alone: DSH 0.1.7 loads every
 * session's projections once per connection and refreshes them only for
 * sessions it already tracks (`refreshProjections` returns early once a
 * session reads `ready`). A child Session created BY the running agent never
 * enters that tracked set for the parent that spawned it — its
 * `subagent/catalog` row is appended host-side after the connection's one
 * read. The official catalog lives with it because its footer counts
 * descendants from the list feed, but a page that renders the topology needs
 * the rows themselves.
 *
 * Reading `subagentCatalog` off the parent's log is the same fold the host
 * applies in `listDescendants` (`list-children.ts`), against the same
 * append-only event the projection folds (`subagent/catalog`), scoped the
 * same way (rows at or after the fork-inherited prefix are ignored). It
 * never touches DSH source and never activates an Agent.
 *
 * Degradation contract:
 * - `sessionPersistence` absent → 503 (this route cannot read a cold log).
 * - An unreadable log (missing / corrupt) → the row with an empty catalog:
 *   the page keeps its snapshot view instead of an error banner, because an
 *   empty answer is indistinguishable from "no subagents here" downstream.
 */
import type { Context, SidebarSubagentCatalogEntry } from './context-types.ts'
import { readPersistedSessionOf } from './session-store.ts'
import { requireString, SidebarError } from './wire.ts'

/** The catalog routes of the /sidebar JSON API. */
export interface SidebarCatalogRoutes {
  /**
   * Read one session's direct-child catalog from its durable log.
   * @param payload - `{ sessionId }`.
   * @returns `{ entries }` in parent catalog event order (empty when the
   *   session exists but never spawned a child).
   */
  subagentsCatalog(payload: unknown): Promise<{ entries: SidebarSubagentCatalogEntry[] }>
}

/** One `subagent/catalog` payload field reader set. */
interface CatalogEventData {
  version?: unknown
  childId?: unknown
  childCreatedAt?: unknown
  mode?: unknown
  label?: unknown
}

/** The known child modes; anything else is surfaced as `unknown`. */
function knownMode(value: unknown): 'one-shot' | 'continuable' | 'external' | 'unknown' {
  return value === 'one-shot' || value === 'continuable' || value === 'external'
    ? value
    : 'unknown'
}

/**
 * Fold one session's own `subagent/catalog` events into direct-child rows.
 *
 * Event data is treated structurally, never trusted: a malformed row is
 * dropped rather than failing the whole catalog (the host validates at write
 * time; this is a read of already-durable data).
 *
 * @param events - the session's durable event log (oldest → newest).
 * @param inheritedEventCount - fork-inherited prefix length; rows inside it
 *   belong to an ancestor's catalog and are ignored, exactly like the host
 *   projection's `seq < inheritedEventCount` guard.
 * @returns direct-child rows in event order, last-wins per child id.
 */
export function catalogEntriesOf(
  events: readonly { type: string; seq: number; data: Record<string, unknown> }[],
  inheritedEventCount: number,
): SidebarSubagentCatalogEntry[] {
  const byId = new Map<string, SidebarSubagentCatalogEntry>()
  for (const event of events) {
    if (event.type !== 'subagent/catalog') continue
    if (event.seq < inheritedEventCount) continue
    const data = event.data as CatalogEventData
    const id = data.childId
    if (typeof id !== 'string' || id === '') continue
    const mode = knownMode(data.mode)
    // External children own no local Session: the topology has no branch to
    // draw for them and the host's own recursive listing skips their logs.
    if (mode === 'external') continue
    const entry: SidebarSubagentCatalogEntry = {
      id,
      createdAt: typeof data.childCreatedAt === 'number' ? data.childCreatedAt : 0,
      mode,
      ...typeof data.label === 'string' && data.label !== '' ? { label: data.label } : {},
    }
    // A later fact about the same child wins (the list is append-only).
    byId.delete(id)
    byId.set(id, entry)
  }
  return [...byId.values()]
}

/**
 * Build the catalog routes bound to the plugin context.
 * @param ctx - host plugin context.
 */
export function buildCatalogApi(ctx: Context): SidebarCatalogRoutes {
  return {
    async subagentsCatalog(payload) {
      const sessionId = requireString(payload, 'sessionId')
      // A live session's log is authoritative and free to read; the persisted
      // read only fills in a session this host process does not hold.
      const live = ctx.sessions.get(sessionId)
      if (live !== undefined) {
        const events = live.snapshotEvents() as readonly {
          type: string
          seq: number
          data: Record<string, unknown>
        }[]
        return { entries: catalogEntriesOf(events, 0) }
      }
      if (ctx.get('sessionPersistence') === undefined) {
        throw new SidebarError(
          'subagents-unavailable',
          'reading a cold catalog requires the sessionPersistence service',
          503,
        )
      }
      const persisted = await readPersistedSessionOf(ctx, sessionId)
      if (persisted === undefined) return { entries: [] }
      return { entries: catalogEntriesOf(persisted.events, persisted.inheritedEventCount) }
    },
  }
}
