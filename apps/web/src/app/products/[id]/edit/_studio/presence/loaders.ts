import type { z } from 'zod'
import { getBackendUrl } from '@/lib/backend-url'
import { coordinateSchema, presencePageSchema, presenceOneSchema, historySchema, amazonPostureSchema, verifyResponseSchema } from './types'
import type { ListingCoordinate } from './types'

export class PresenceReadError extends Error {
  constructor(message: string, readonly status: number | null, readonly code: string | null,
    readonly current: unknown = null) { super(message); this.name = 'PresenceReadError' }
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
const base = (id: string) => `${getBackendUrl()}/api/products/${encodeURIComponent(id)}/studio/presence`
export function coordinateQuery(input: ListingCoordinate): URLSearchParams {
  const c = coordinateSchema.parse(input)
  return new URLSearchParams({ channel: c.channel, market: c.marketplace,
    accountId: c.channelConnectionId === null ? 'null' : c.channelConnectionId, aliasKey: c.aliasKey })
}
async function request<T>(url: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  let response: Response
  try { response = await fetch(url, { credentials: 'include', cache: 'no-store',
    ...init, signal: init.signal ?? AbortSignal.timeout(30_000) }) }
  catch (error) {
    if (init.signal?.aborted) throw error
    throw new PresenceReadError('Presence could not load. The channel state is not known.', null, null)
  }
  let raw: unknown
  try { raw = await response.json() }
  catch { throw new PresenceReadError('Presence could not load: the response was unreadable.', response.status, null) }
  if (!response.ok) {
    const data = record(raw) ? raw : null
    const message = typeof data?.refusal === 'string' ? data.refusal : typeof data?.message === 'string' ? data.message
      : typeof data?.error === 'string' ? data.error : `Presence could not load (HTTP ${response.status}).`
    throw new PresenceReadError(message, response.status, typeof data?.code === 'string' ? data.code : null, data?.current)
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new PresenceReadError(`Presence could not load: the response did not report ${parsed.error.issues[0]?.path.join('.') || 'the required data'}.`, response.status, 'INVALID_PRESENCE_RESPONSE')
  return parsed.data
}
export async function loadPresence(productId: string, options: { includeFamily?: boolean; signal?: AbortSignal } = {}) {
  const page = await request(`${base(productId)}${options.includeFamily ? '?includeFamily=true' : ''}`, presencePageSchema, { signal: options.signal })
  if (page.coverage.requestedProductId !== productId || page.coverage.scope !== (options.includeFamily ? 'family' : 'product')) {
    throw new PresenceReadError('Presence could not load: the response did not cover the requested products.', 200, 'INVALID_PRESENCE_COVERAGE')
  }
  return page
}
export async function loadPresenceOne(coordinate: ListingCoordinate, signal?: AbortSignal) {
  const expected = coordinateSchema.parse(coordinate)
  const result = await request(`${base(expected.productId)}/one?${coordinateQuery(expected)}`, presenceOneSchema, { signal })
  if (JSON.stringify(result.row.coordinate) !== JSON.stringify(expected)) {
    throw new PresenceReadError('Presence could not load: the response named a different listing coordinate.', 200, 'INVALID_PRESENCE_COORDINATE')
  }
  return result
}
export function loadPresenceHistory(coordinate: ListingCoordinate, options: { cursor?: string; limit?: number; signal?: AbortSignal } = {}) {
  const query = coordinateQuery(coordinate)
  if (options.cursor !== undefined) query.set('cursor', options.cursor)
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  return request(`${base(coordinate.productId)}/history?${query}`, historySchema, { signal: options.signal })
}
export function loadAmazonPosture(coordinate: ListingCoordinate, signal?: AbortSignal) {
  coordinateSchema.parse(coordinate)
  if (coordinate.channel !== 'AMAZON') throw new PresenceReadError('Amazon posture requires an Amazon coordinate.', null, 'INVALID_CHANNEL')
  return request(`${base(coordinate.productId)}/amazon-posture?${coordinateQuery(coordinate)}`, amazonPostureSchema, { signal })
}
/** Explicit operator channel read; never called by a page load or timer. */
export function verifyPresence(productId: string, coordinates: readonly ListingCoordinate[], reason: string, signal?: AbortSignal) {
  const checked = coordinates.map(c => coordinateSchema.parse(c))
  if (!checked.length || checked.some(c => c.productId !== productId)) throw new PresenceReadError('Name this product’s coordinates before checking the channel.', null, 'INVALID_COORDINATES')
  return request(`${base(productId)}/verify`, verifyResponseSchema, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ coordinates: checked, reason }),
  })
}
