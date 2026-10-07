/**
 * Sheet publish parity, build shape v2 (Owner 2026-10-04), phase P8 — the web side of the waiting Status and Action
 * values (`apps/api/src/routes/publish-actions.routes.ts`; shared wire shapes in `@nexus/shared/publish-actions`).
 *
 *   GET /api/products/:id/studio/publish-actions?channel&marketplace&accountId&aliasKey   → { rows, readAt }
 *   PUT /api/products/:id/studio/publish-actions/send/{partial|full|delete}
 *   PUT /api/products/:id/studio/publish-actions/status/{active|inactive|ended|not_listed|none}
 *       body { listingIds, expected } → { applied, refused, conflicts, started, leftOut }
 *
 * New listings (Owner 2026-10-04): a channel sheet's read also returns every family member with no listing on its
 * destination, with a `new:` listing id (`isNewRowId`). A Status write may name such ids (expected `null`): the server
 * starts the family's drafts first and answers `started.rows` (each `new:` id → the listing it is now).
 *
 * Setting a value sends nothing to a channel: Publish does, after the review. The GET goes through the studio's
 * bounded read (`fetchStudioRead`: one retry on a transient answer, a 30 s deadline); a PUT is never retried here —
 * a lost answer is read back by the caller instead (the compare-and-set makes a repeat safe, but it would report the
 * caller's own first write as someone else's change).
 */
import type { PublishActionCell, PublishActionChange, PublishActionWriteResult } from '@nexus/shared/publish-actions'
import { getBackendUrl } from '@/lib/backend-url'
import { fetchStudioRead } from '../studio-read'

/**
 * Which listing rows to read. Every field is optional: `{}` reads every destination of the product's family (the
 * shared scope), `{ channel, marketplace, accountId }` one channel sheet. `aliasKey` `''` is the primary listing; leave
 * it out to read every listing of the destination.
 */
export interface PublishActionsDestination {
  channel?: string | null
  marketplace?: string | null
  accountId?: string | null
  aliasKey?: string | null
  /**
   * The Matrix's Status columns (Owner 2026-10-07): with no filter, every destination is read as its own channel sheet
   * reads it — each main listing's members with no listing there are new rows (`newRows=every`). Its writes are each
   * market's own, never the Shared scope's.
   */
  newRows?: 'every' | null
}

/**
 * Whether this read's writes are the Shared scope's (`allCoordinates`: a product's every market, never starting a
 * listing): no channel named — except the Matrix's every-market read, whose cells are each market's own.
 */
export const isSharedScopeDestination = (destination: PublishActionsDestination): boolean => !destination.channel && destination.newRows !== 'every'

export interface PublishActionsRead {
  rows: PublishActionCell[]
  readAt: string
}

/** A refused or failed request, with the server's own words. */
export class PublishActionsError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

const base = (productId: string) => `${getBackendUrl()}/api/products/${encodeURIComponent(productId)}/studio/publish-actions`

export function publishActionsReadUrl(productId: string, destination: PublishActionsDestination): string {
  const query = new URLSearchParams()
  if (destination.channel) query.set('channel', destination.channel)
  if (destination.marketplace) query.set('marketplace', destination.marketplace)
  if (destination.accountId) query.set('accountId', destination.accountId)
  // '' is a real filter (the primary listing); only null / undefined mean "every listing".
  if (destination.aliasKey != null) query.set('aliasKey', destination.aliasKey)
  if (destination.newRows === 'every') query.set('newRows', 'every')
  const qs = query.toString()
  return qs ? `${base(productId)}?${qs}` : base(productId)
}

/** The path of one change: every value is its own route, so the permission manifest decides by path. */
export function publishActionsWritePath(productId: string, change: PublishActionChange): string {
  return change.column === 'send'
    ? `${base(productId)}/send/${change.mode}`
    : `${base(productId)}/status/${change.target ?? 'none'}`
}

const STATUS_WORDS: Record<number, string> = {
  401: 'Your session has expired. Sign in again to continue.',
  403: 'Your role cannot change what Publish sends here.',
}

async function failure(response: Response, fallback: string): Promise<PublishActionsError> {
  const body = await response.json().catch(() => null) as { message?: unknown; error?: unknown } | null
  const words = typeof body?.message === 'string' && body.message.trim() ? body.message.trim() : null
  return new PublishActionsError(words ?? STATUS_WORDS[response.status] ?? `${fallback} (${response.status}).`, response.status)
}

export async function readPublishActions(productId: string, destination: PublishActionsDestination, signal?: AbortSignal): Promise<PublishActionsRead> {
  const response = await fetchStudioRead(publishActionsReadUrl(productId, destination), signal)
  if (!response.ok) throw await failure(response, 'The Status and Action values could not be read')
  const data = await response.json().catch(() => null) as Partial<PublishActionsRead> | null
  if (!data || !Array.isArray(data.rows)) throw new PublishActionsError('The Status and Action values came back empty. Reload the sheet.', response.status)
  return { rows: data.rows, readAt: typeof data.readAt === 'string' ? data.readAt : new Date().toISOString() }
}

// ── One shared read per destination (review 2026-10-05, m2) ─────────────────────────────────────────────────────────
//
// One channel sheet reads the same destination three times — its Status and Action columns (`usePublishActions`), the
// studio bar's listing picker (`useListingChoices`) and the toolbar mark's alias names (`usePublicationStatus`) — and
// the Publish window reads the family's every destination once more. They share ONE request: a read in flight is joined,
// an answer is reused for a few seconds, and a read that must be newer than an event says so (`since`). The rows are
// shared between the callers: read them, never change them.

/** How long an answer is reused by a later caller that does not ask for a newer one. */
export const PUBLISH_ACTIONS_READ_TTL_MS = 5_000

export interface SharedReadOptions {
  /** Reuse only a read that STARTED at or after this time (ms): an event at this time made older answers stale. */
  since?: number
}

/** What a cache subscriber hears: an answer arrived (for `key`), or a family's reads were dropped (read again). */
export type PublishActionsCacheEvent =
  | { type: 'read'; key: string; read: PublishActionsRead; startedAt: number }
  | { type: 'invalidated' }

/** The cache key of one read: the product and the destination's filter, as the request names them. */
export function publishActionsReadKey(productId: string, destination: PublishActionsDestination): string {
  return JSON.stringify([productId, destination.channel || null, destination.marketplace || null, destination.accountId || null, destination.aliasKey ?? null,
    ...(destination.newRows === 'every' ? ['every'] : [])])
}

interface Flight {
  productId: string
  startedAt: number
  promise: Promise<PublishActionsRead>
  controller: AbortController
  waiters: number
  /** When the answer arrived (ms); null while in flight. */
  answeredAt: number | null
}

const abortReason = (signal: AbortSignal) => signal.reason ?? new DOMException('The read was cancelled.', 'AbortError')

/**
 * The shared reads, React-free so it can be tested: `read` joins a read in flight or reuses an answer younger than the
 * TTL (and, with `since`, started no earlier than that); `invalidate` drops a product's reads and tells its subscribers.
 * A caller's own abort only stops its wait; the request is cancelled when nobody waits for it any more. A failed read is
 * never kept.
 */
export class PublishActionsReadCache {
  private readonly flights = new Map<string, Flight>()
  private readonly listeners = new Map<string, Set<(event: PublishActionsCacheEvent) => void>>()

  constructor(
    private readonly reader: (productId: string, destination: PublishActionsDestination, signal: AbortSignal) => Promise<PublishActionsRead> = readPublishActions,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = PUBLISH_ACTIONS_READ_TTL_MS,
  ) {}

  read(productId: string, destination: PublishActionsDestination, signal?: AbortSignal, options: SharedReadOptions = {}): Promise<PublishActionsRead> {
    if (signal?.aborted) return Promise.reject(abortReason(signal))
    const key = publishActionsReadKey(productId, destination)
    const at = this.now()
    this.sweep(at)
    let flight = this.flights.get(key)
    const usable = flight && (flight.answeredAt === null || at - flight.answeredAt < this.ttlMs) && (options.since === undefined || flight.startedAt >= options.since)
    if (!flight || !usable) flight = this.start(key, productId, destination, at)
    return this.wait(key, flight, signal)
  }

  /** Drop every read of this product (in flight or answered) and tell its subscribers to read again. */
  invalidate(productId: string): void {
    for (const [key, flight] of this.flights) if (flight.productId === productId) this.flights.delete(key)
    for (const listener of [...(this.listeners.get(productId) ?? [])]) listener({ type: 'invalidated' })
  }

  /** Hear this product's answers and invalidations (whoever asked for them). */
  subscribe(productId: string, listener: (event: PublishActionsCacheEvent) => void): () => void {
    const set = this.listeners.get(productId) ?? new Set()
    set.add(listener)
    this.listeners.set(productId, set)
    return () => {
      set.delete(listener)
      if (!set.size && this.listeners.get(productId) === set) this.listeners.delete(productId)
    }
  }

  /** Reads kept now (tests). */
  get size(): number { return this.flights.size }

  private start(key: string, productId: string, destination: PublishActionsDestination, at: number): Flight {
    const controller = new AbortController()
    const flight: Flight = { productId, startedAt: at, controller, waiters: 0, answeredAt: null, promise: this.reader(productId, destination, controller.signal) }
    this.flights.set(key, flight)
    flight.promise.then(read => {
      flight.answeredAt = this.now()
      for (const listener of [...(this.listeners.get(productId) ?? [])]) listener({ type: 'read', key, read, startedAt: flight.startedAt })
    }, () => { if (this.flights.get(key) === flight) this.flights.delete(key) })
    return flight
  }

  private wait(key: string, flight: Flight, signal?: AbortSignal): Promise<PublishActionsRead> {
    flight.waiters += 1
    return new Promise<PublishActionsRead>((resolve, reject) => {
      let done = false
      const leave = () => {
        if (done) return false
        done = true
        flight.waiters -= 1
        signal?.removeEventListener('abort', onAbort)
        return true
      }
      const onAbort = () => {
        if (!leave()) return
        // Nobody waits for this request any more: stop it, and never hand its answer to a later caller.
        if (flight.answeredAt === null && flight.waiters === 0) {
          flight.controller.abort()
          if (this.flights.get(key) === flight) this.flights.delete(key)
        }
        reject(abortReason(signal!))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      flight.promise.then(read => { if (leave()) resolve(read) }, error => { if (leave()) reject(error) })
    })
  }

  private sweep(at: number): void {
    for (const [key, flight] of this.flights) if (flight.answeredAt !== null && at - flight.answeredAt >= this.ttlMs) this.flights.delete(key)
  }
}

/** The page's one cache. */
export const publishActionsReads = new PublishActionsReadCache()

/** Read one destination's (or the family's every) Status and Action values through the shared cache. */
export function readPublishActionsShared(productId: string, destination: PublishActionsDestination, signal?: AbortSignal, options?: SharedReadOptions): Promise<PublishActionsRead> {
  return publishActionsReads.read(productId, destination, signal, options)
}

/** Drop the product's shared reads and tell every reader of it to read again (a listing of it changed). */
export function invalidatePublishActions(productId: string): void {
  publishActionsReads.invalidate(productId)
}

/** One write: set (or clear) one column on many rows. `expected` maps each row to the `setAt` this sheet last read. */
export async function writePublishActions(productId: string, change: PublishActionChange,
  body: { listingIds: readonly string[]; expected: Record<string, string | null>; sharedScope?: boolean }, signal?: AbortSignal): Promise<PublishActionWriteResult> {
  const response = await fetch(publishActionsWritePath(productId, change), {
    method: 'PUT', credentials: 'include', cache: 'no-store', signal: signal ?? AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json' },
    // The Shared scope says so (`allCoordinates`): the server refuses its writes on a deleted market.
    body: JSON.stringify({ listingIds: [...body.listingIds], expected: body.expected, ...(body.sharedScope ? { allCoordinates: true } : {}) }),
  })
  if (!response.ok) throw await failure(response, 'The change could not be saved')
  const data = await response.json().catch(() => null) as Partial<PublishActionWriteResult> | null
  if (!data || !Array.isArray(data.applied)) throw new PublishActionsError('The server did not confirm the change. Reload the sheet to check it.', response.status)
  // New listings: the drafts a choice started (each `new:` id → its listing) and the Shared scope's markets left out.
  return { applied: data.applied, refused: data.refused ?? [], conflicts: data.conflicts ?? [], started: data.started ?? null, leftOut: data.leftOut ?? null }
}
