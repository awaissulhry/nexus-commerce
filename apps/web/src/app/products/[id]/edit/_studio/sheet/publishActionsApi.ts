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
}

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
