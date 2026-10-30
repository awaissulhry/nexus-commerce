import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'
import { WORK_ORDER_STATUSES } from '../_shared/api'
import { replacementSchema, type Replacement } from '../cutting/api'

/**
 * Scrap & rework (B-W2a-60; SCR-140): every call of the page, each answer checked by its schema — the rows and tiles
 * (`GET /production/scrap`, production.scrap.view; the value only with the cost grain), the lower-quantity requests
 * waiting for a decision (`GET /production/replacements?kind=REDUCE&status=OPEN`), a replacement asked for scrapped
 * garments (`POST /production/replacements`, production.scrap: a recut or a lower order quantity), and a lower
 * quantity approved or refused by another person (`…/approve|refuse`, production.scrap.approve). Per work order,
 * bundle, operation and station: never a person.
 */

export const SCRAP_KINDS = ['SCRAP', 'REWORK'] as const
export type ScrapKind = (typeof SCRAP_KINDS)[number]
export const REWORK_STATUSES = ['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED'] as const

export const scrapRowSchema = z.object({
  id: z.string(),
  kind: z.enum(SCRAP_KINDS),
  source: z.object({ type: z.enum(['SCAN', 'REWORK']), id: z.string() }),
  at: z.string(),
  workOrder: z.object({ id: z.string(), number: z.string(), status: z.enum(WORK_ORDER_STATUSES), style: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable() }),
  bundle: z.object({ id: z.string(), code: z.string() }).nullable(),
  operation: z.object({ id: z.string(), seq: z.number(), code: z.string(), name: z.string() }).nullable(),
  cell: z.object({ id: z.string(), colourwayCode: z.string(), size: z.string() }),
  part: z.string().nullable(),
  pieces: z.number(),
  reasonCode: z.string(),
  reasonLabel: z.object({ it: z.string(), en: z.string() }).nullable(),
  status: z.enum(REWORK_STATUSES).nullable(),
  station: z.object({ id: z.string(), code: z.string() }).nullable(),
  materials: z.array(z.object({ lotId: z.string(), lotCode: z.string(), hideId: z.string(), hideCode: z.string(), itemId: z.string(), uom: z.string(), area: z.string(), value: z.number().nullable().optional() })),
  replacements: z.array(z.object({ id: z.string(), kind: z.enum(['RECUT', 'REDUCE']), status: z.enum(['OPEN', 'APPROVED', 'REFUSED', 'DONE', 'CANCELLED']), quantity: z.number() })),
  /** Cost grain only (absent without money.cost). */
  value: z.number().nullable().optional(),
  currency: z.string().nullable().optional(),
})
export type ScrapRow = z.infer<typeof scrapRowSchema>

export const scrapTilesSchema = z.object({ scrapToday: z.number(), reworkOpen: z.number(), recutsToCut: z.number(), reductionsToApprove: z.number() })
export type ScrapTiles = z.infer<typeof scrapTilesSchema>

const scrapSchema = z.object({ rows: z.array(scrapRowSchema), tiles: scrapTilesSchema })
export type ScrapPage = z.infer<typeof scrapSchema>

/** The latest rows (at most 500) since `from`, with the tiles of the same scope. */
export function getScrap(api: ApiClient, query: { from: string | null }, signal?: AbortSignal): Promise<ScrapPage> {
  return api.get('/production/scrap', { query: { from: query.from ?? undefined, limit: 500 }, schema: scrapSchema, signal })
}

/** The lower-quantity requests waiting for a decision (their version and who asked: never the one who decides). */
export async function openReductions(api: ApiClient, signal?: AbortSignal): Promise<Replacement[]> {
  return (await api.get('/production/replacements', { query: { kind: 'REDUCE', status: 'OPEN', limit: 200 }, schema: z.object({ replacements: z.array(replacementSchema) }), signal })).replacements
}

export interface ReplacementAsk {
  readonly kind: 'RECUT' | 'REDUCE'
  readonly quantity: number
  readonly reason: string
  readonly part: string | null
  readonly sourceScanId?: string
  readonly reworkOrderId?: string
}

/** production.scrap: replace scrapped garments — a recut (the cutting room's list) or a lower order quantity (approved by another person). */
export function askReplacement(api: ApiClient, body: ReplacementAsk, idempotencyKey = newIdempotencyKey()) {
  return api.post('/production/replacements', {
    body: { kind: body.kind, quantity: body.quantity, reason: body.reason, ...(body.kind === 'RECUT' && body.part ? { part: body.part } : {}), ...(body.sourceScanId ? { sourceScanId: body.sourceScanId } : {}), ...(body.reworkOrderId ? { reworkOrderId: body.reworkOrderId } : {}) },
    schema: z.object({ replacement: replacementSchema }),
    idempotencyKey,
  })
}

/** production.scrap.approve: a lower order quantity approved (never by the person who asked). */
export function approveReduction(api: ApiClient, id: string, body: { version: number; note?: string }, idempotencyKey = newIdempotencyKey()) {
  return api.post(`/production/replacements/${encodeURIComponent(id)}/approve`, { body, schema: z.object({ replacement: replacementSchema }), idempotencyKey })
}

/** production.scrap.approve: refused, with a note that says why. */
export function refuseReduction(api: ApiClient, id: string, body: { version: number; note: string }, idempotencyKey = newIdempotencyKey()) {
  return api.post(`/production/replacements/${encodeURIComponent(id)}/refuse`, { body, schema: z.object({ replacement: replacementSchema }), idempotencyKey })
}
