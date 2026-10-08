/**
 * Amazon sheet gaps — when an open product sheet or Matrix re-reads because listings of its family changed
 * somewhere else (another window, the other view, a background job). ONE rule for both views, pure so it is tested.
 *
 * Events (all through the invalidation channel; `use-listing-events.ts` bridges the server's stream into it):
 *   listing.values_changed      the shared write services, after commit (`meta`: family root, listings + versions,
 *                               fields); also emitted locally by a view after its own applied write
 *   inventory.stock_changed     stock moved for one product (`id`)
 *   publication.status_changed  a product sheet publication of this family settled (`meta.terminal`)
 *
 * Decision: `none` (another family, or the writer's own echo: every listing it names is already held here at that
 * version or newer) · `stock` (only Mode / Qty / Buffer / Sync moved, or stock moved for one of the family's
 * products) · `full` (anything else — price, sale, offer, draft, fulfilment, ASIN — or a terminal publication).
 * A view keeps every version a write answered with (`MatrixWriteOutcome.listings`) in `knownVersions`, so its own
 * echo, an EU write landing on several markets included, reads as `none`.
 *
 * Bursts are coalesced (400 ms, the strongest decision wins), and a window that comes back after more than 60 s
 * away re-reads in full: events are hints, and many writers (marketplace syncs, imports) announce nothing.
 */
import type { InvalidationEvent, InvalidationType } from '@/lib/sync/invalidation-channel'

export type LiveRefresh = 'none' | 'stock' | 'full'

export interface LiveScope {
  /** The family root (`MatrixRead.productId`); `null` = nothing loaded yet, every event is `none`. */
  familyId: string | null
  /** Every product the view shows, the root included. */
  memberIds: ReadonlySet<string> | readonly string[]
  /** listingId → the `ChannelListing.version` the view holds. */
  knownVersions: ReadonlyMap<string, number>
}

/** The invalidation types the live rule reads. */
export const LIVE_EVENT_TYPES: InvalidationType[] = ['listing.values_changed', 'inventory.stock_changed', 'publication.status_changed']

/** Fields whose change moves only the stock cells (`stockSource` = "Sells from", Step 2). Anything else, or no field list at all, is a full re-read. */
export const STOCK_ONLY_FIELDS: readonly string[] = ['quantityMode', 'quantity', 'stockBuffer', 'syncState', 'stockSource']

export const LIVE_COALESCE_MS = 400
export const LIVE_AWAY_MS = 60_000

const RANK: Readonly<Record<LiveRefresh, number>> = { none: 0, stock: 1, full: 2 }

export const strongerRefresh = (a: LiveRefresh, b: LiveRefresh): LiveRefresh => (RANK[b] > RANK[a] ? b : a)

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

interface ChangedListing { listingId: string; productId: string; version: number }

function listingsOf(value: unknown): ChangedListing[] {
  if (!Array.isArray(value)) return []
  const out: ChangedListing[] = []
  for (const raw of value) {
    const l = raw as Record<string, unknown> | null
    if (l && typeof l.listingId === 'string' && typeof l.version === 'number') out.push({ listingId: l.listingId, productId: text(l.productId), version: l.version })
  }
  return out
}

const fieldsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((f): f is string => typeof f === 'string') : [])

export function liveRefreshNeeded(event: Pick<InvalidationEvent, 'type' | 'id' | 'fields' | 'meta'>, scope: LiveScope): LiveRefresh {
  const familyId = scope.familyId
  if (!familyId) return 'none'
  const members = scope.memberIds
  const ours = (id: string) => !!id && (id === familyId || (members instanceof Set ? members.has(id) : (members as readonly string[]).includes(id)))
  const meta = event.meta ?? {}
  switch (event.type) {
    case 'listing.values_changed': {
      const listings = listingsOf(meta.listings)
      if (!ours(text(meta.productId) || text(event.id)) && !listings.some((l) => ours(l.productId))) return 'none'
      if (listings.length > 0 && listings.every((l) => (scope.knownVersions.get(l.listingId) ?? -1) >= l.version)) return 'none'
      const fields = fieldsOf(meta.fields ?? event.fields)
      return fields.length > 0 && fields.every((f) => STOCK_ONLY_FIELDS.includes(f)) ? 'stock' : 'full'
    }
    case 'inventory.stock_changed':
      return ours(text(meta.productId) || text(event.id)) ? 'stock' : 'none'
    case 'publication.status_changed':
      return meta.terminal === true && ours(text(meta.productId)) ? 'full' : 'none'
    default:
      return 'none'
  }
}

/** Back after more than 60 s with the window hidden. */
export const awayTooLong = (hiddenAt: number | null, now: number): boolean => hiddenAt !== null && now - hiddenAt > LIVE_AWAY_MS

export interface LiveCoalescer {
  push: (decision: LiveRefresh) => void
  cancel: () => void
}

interface Timers {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const DEFAULT_TIMERS: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * One window per burst, opened by its FIRST event (a steady stream cannot postpone the re-read forever); the window
 * hands on the strongest decision it saw. `none` never opens one.
 */
export function createLiveCoalescer(onFlush: (decision: Exclude<LiveRefresh, 'none'>) => void, delayMs = LIVE_COALESCE_MS, timers: Timers = DEFAULT_TIMERS): LiveCoalescer {
  let pending: LiveRefresh = 'none'
  let handle: unknown = null
  return {
    push(decision) {
      if (decision === 'none') return
      pending = strongerRefresh(pending, decision)
      if (handle !== null) return
      handle = timers.set(() => {
        handle = null
        const out = pending
        pending = 'none'
        if (out !== 'none') onFlush(out)
      }, delayMs)
    },
    cancel() {
      if (handle !== null) timers.clear(handle)
      handle = null
      pending = 'none'
    },
  }
}
