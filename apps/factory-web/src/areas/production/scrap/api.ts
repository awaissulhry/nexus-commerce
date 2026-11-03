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

/** B-W2b-126: SECOND is a downgrade to second quality (its own read, shown as a row of the same list). */
export const SCRAP_KINDS = ['SCRAP', 'REWORK', 'SECOND'] as const
export type ScrapKind = (typeof SCRAP_KINDS)[number]
export const REWORK_STATUSES = ['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED'] as const

// ---- B-W2b-126: second quality (MES-133) and the repair station (MES-132) ----------------------------------------------------

export const downgradeSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  workOrder: z.object({ id: z.string(), number: z.string(), status: z.enum(WORK_ORDER_STATUSES), style: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable() }),
  cell: z.object({ id: z.string(), colourwayCode: z.string(), size: z.string() }),
  bundle: z.object({ id: z.string(), code: z.string(), part: z.string().nullable() }).nullable(),
  source: z.object({ type: z.enum(['SCAN', 'REWORK']), id: z.string() }).nullable(),
  quantity: z.number(),
  reasonCode: z.string(),
  note: z.string().nullable(),
  target: z.enum(['SKU', 'ITEM']),
  item: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  sku: z.object({ id: z.string(), sku: z.string() }).nullable(),
  place: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  moveId: z.string().nullable(),
  withdrawnMoveId: z.string().nullable(),
  withdrawn: z.object({ at: z.string(), reason: z.string() }).nullable(),
  version: z.number(),
  createdAt: z.string(),
})
export type Downgrade = z.infer<typeof downgradeSchema>

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
  /** B-W2b-126: a SECOND row's downgrade (the list's own field, never the API's scrap rows). */
  downgrade: downgradeSchema.nullable().optional(),
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

// ---- B-W2b-126: second quality (MES-133) and the repair station (MES-132) ----------------------------------------------------

const downgradesSchema = z.object({ downgrades: z.array(downgradeSchema), garments: z.object({ today: z.number(), period: z.number() }) })
export type DowngradePage = z.infer<typeof downgradesSchema>

/** production.scrap.view: the downgrades of the period, newest first, with today's and the period's garments (not withdrawn). */
export function getDowngrades(api: ApiClient, query: { from: string | null }, signal?: AbortSignal): Promise<DowngradePage> {
  return api.get('/production/downgrades', { query: { from: query.from ?? undefined, limit: 500 }, schema: downgradesSchema, signal })
}

export const downgradeOptionsSchema = z.object({
  source: z.object({ type: z.enum(['SCAN', 'REWORK']), id: z.string() }),
  workOrder: z.object({ id: z.string(), number: z.string(), status: z.enum(WORK_ORDER_STATUSES) }),
  cell: z.object({ id: z.string(), colourwayCode: z.string(), size: z.string() }),
  bundle: z.object({ id: z.string(), code: z.string(), part: z.string().nullable() }).nullable(),
  scrapped: z.number(),
  downgraded: z.number(),
  left: z.number(),
  approval: z.enum(['WAITING', 'REFUSED']).nullable(),
  ppe: z.boolean(),
  sku: z.object({ variantId: z.string(), sku: z.string() }).nullable(),
  items: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })),
  places: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string(), finishedGoods: z.boolean() })),
  reasons: z.array(z.string()),
  held: z.object({ code: z.string(), message: z.string() }).nullable(),
  may: z.boolean(),
})
export type DowngradeOptions = z.infer<typeof downgradeOptionsSchema>

/** What the downgrade dialog needs for one scrap row (read when it opens). */
export function getDowngradeOptions(api: ApiClient, source: { sourceScanId?: string; reworkOrderId?: string }, signal?: AbortSignal): Promise<DowngradeOptions> {
  return api.get('/production/downgrades/options', { query: source, schema: downgradeOptionsSchema, signal })
}

export interface DowngradeAsk {
  readonly sourceScanId?: string
  readonly reworkOrderId?: string
  readonly quantity: number
  readonly reasonCode: string
  readonly note?: string
  readonly target: 'SKU' | 'ITEM'
  readonly itemId?: string
  readonly toLocationId: string
  readonly ppeConfirmed?: boolean
}

/** production.downgrade: the garments go to second quality instead of scrap (into the place, as the SKU or the item). */
export function postDowngrade(api: ApiClient, body: DowngradeAsk, idempotencyKey = newIdempotencyKey()) {
  return api.post('/production/downgrades', { body, schema: z.object({ downgrade: downgradeSchema }), idempotencyKey })
}

/** production.downgrade: a wrong downgrade withdrawn with the reason (its garments come out of the place again). */
export function withdrawDowngrade(api: ApiClient, id: string, body: { version: number; reason: string }, idempotencyKey = newIdempotencyKey()) {
  return api.post(`/production/downgrades/${encodeURIComponent(id)}/withdraw`, { body, schema: z.object({ downgrade: downgradeSchema }), idempotencyKey })
}

export const repairSchema = z.object({
  reworkId: z.string(),
  workOrder: z.object({ id: z.string(), number: z.string() }),
  status: z.enum(REWORK_STATUSES),
  state: z.enum(['WAITING', 'IN_REPAIR']).nullable(),
  repairInAt: z.string().nullable(),
  repairOutAt: z.string().nullable(),
  station: z.object({ id: z.string(), code: z.string() }).nullable(),
  minutes: z.number().nullable(),
  goodQuantity: z.number(),
  scrapQuantity: z.number(),
  scannedInBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  scannedOutBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  workerHidden: z.boolean(),
})
export type Repair = z.infer<typeof repairSchema>

/** production.scrap.view: a rework's repair at the repair station (who scanned only behind the PERFORMANCE gate). */
export async function getRepair(api: ApiClient, reworkId: string, signal?: AbortSignal): Promise<Repair> {
  return (await api.get(`/production/repair/${encodeURIComponent(reworkId)}`, { schema: z.object({ repair: repairSchema }), signal })).repair
}
