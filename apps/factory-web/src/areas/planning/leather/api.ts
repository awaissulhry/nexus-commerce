import { z } from 'zod'
import { SHADE_RULES } from '@nexus/factory-domain/inventory/reservations/shade'
import { FEASIBILITY } from '@nexus/factory-domain/planning/leather/feasibility'
import { LOSS_DECISIONS, LOSS_SOURCES, PROPOSAL_STATES } from '@nexus/factory-domain/planning/leather/loss'
import { PROTECTOR_STATES } from '@nexus/factory-domain/planning/leather/protectors'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'

/**
 * Every call of Planning › Leather & cut plan (SCR-252), the answers checked with zod (unknown fields dropped, so a new API
 * field never breaks the page). The shapes mirror apps/factory-api modules/planning/leather/contract.ts (B-W2b-132); the enum
 * lists are factory-domain's own. Three reads, each its own section (a failed one never blanks the others). The actions the
 * shade drawer offers go to their own routes: a reservation (inventory), the Draft PO of What to buy & make (purchasing),
 * a note on the order's thread (Sales asks the customer). Money only where the API sent it (the cost grain).
 */

const named = z.object({ id: z.string(), code: z.string(), name: z.string() })
const site = z.object({ id: z.string(), code: z.string(), name: z.string(), timeZone: z.string() })
const run = z.object({ id: z.string(), finishedAt: z.string(), orderLines: z.number() }).nullable()
const lot = z.object({ key: z.string(), lotId: z.string(), lotCode: z.string(), shadeLabel: z.string().nullable(), free: z.string(), count: z.number(), ordersOwn: z.boolean() })

export const needRowSchema = z.object({
  id: z.string(),
  order: z.object({ id: z.string(), number: z.string() }),
  orderLine: z.object({ id: z.string(), seq: z.number(), dueDate: z.string().nullable() }),
  style: named,
  revision: z.object({ id: z.string(), revision: z.number(), status: z.string() }).nullable(),
  colourway: named.nullable(),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), baseUom: z.string(), thicknessMinMm: z.string().nullable(), thicknessMaxMm: z.string().nullable() }),
  colour: named.nullable(),
  requirement: z.object({ id: z.string(), version: z.number(), decision: z.enum(['OPEN', 'ORDERED', 'IGNORED']), suggestedQuantity: z.string(), suggestedUom: z.string() }),
  sizes: z.array(z.object({ size: z.string(), pieces: z.number(), area: z.string(), issued: z.string() })),
  parts: z.array(z.object({ part: z.string(), sizes: z.array(z.object({ size: z.string(), area: z.string() })) })),
  pieces: z.number(),
  area: z.string(),
  issued: z.string(),
  reserved: z.string(),
  toFind: z.string(),
  netArea: z.string().nullable(),
  lossPct: z.string().nullable(),
  lossSource: z.enum(LOSS_SOURCES).nullable(),
  hides: z.number().nullable(),
  gradeMix: z.array(z.object({ code: z.string().nullable(), pct: z.string(), area: z.string() })),
  workOrders: z.array(z.object({ id: z.string(), number: z.string() })),
  heldLots: z.array(z.object({ lotCode: z.string(), shadeLabel: z.string().nullable() })),
  feasibility: z.enum(FEASIBILITY),
  best: lot.nullable(),
  split: z.array(z.object({ lotKey: z.string(), lotId: z.string(), lotCode: z.string(), shadeLabel: z.string().nullable(), sizes: z.array(z.string()), area: z.string() })).nullable(),
  buy: z.object({ area: z.string(), hides: z.number().nullable(), lotCode: z.string().nullable(), shadeLabel: z.string().nullable() }).nullable(),
  proposal: z.object({ hideIds: z.array(z.string()), count: z.number(), area: z.string() }).nullable(),
  lots: z.array(lot),
  demand: z.object({ workOrderId: z.string().nullable(), salesOrderLineId: z.string().nullable() }),
  value: z.number().nullable().optional(),
  currency: z.string(),
})
export type NeedRow = z.infer<typeof needRowSchema>
export type NeedLot = z.infer<typeof lot>

const needSchema = z.object({ site, run, rule: z.enum(SHADE_RULES), rows: z.array(needRowSchema) })
export type LeatherNeed = z.infer<typeof needSchema>

export const protectorRowSchema = z.object({
  id: z.string(),
  order: z.object({ id: z.string(), number: z.string() }),
  orderLine: z.object({ id: z.string(), seq: z.number(), dueDate: z.string().nullable() }),
  style: named,
  colourway: named.nullable(),
  placement: z.string().nullable(),
  sizes: z.array(z.object({ size: z.string(), pieces: z.number() })),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), baseUom: z.string() }),
  needed: z.string(),
  certificate: z.object({ id: z.string(), number: z.string(), standard: z.string(), validTo: z.string() }).nullable(),
  lots: z.object({ count: z.number(), available: z.string(), withCertificate: z.number() }),
  state: z.enum(PROTECTOR_STATES),
  substitutes: z.array(named),
})
export type ProtectorRow = z.infer<typeof protectorRowSchema>
const protectorsSchema = z.object({ site, run, rows: z.array(protectorRowSchema) })
export type LeatherProtectors = z.infer<typeof protectorsSchema>

export const yieldRowSchema = z.object({
  style: named,
  revision: z.object({ id: z.string(), revision: z.number() }).nullable(),
  draft: z.object({ id: z.string(), revision: z.number(), version: z.number() }).nullable(),
  hides: z.number(),
  cuts: z.number(),
  plannedArea: z.string(),
  actualArea: z.string(),
  uom: z.string().nullable(),
  plannedLossPct: z.string().nullable(),
  plannedSource: z.enum(LOSS_SOURCES).nullable(),
  actualLossPct: z.string().nullable(),
  trend: z.array(z.object({ workOrder: z.string(), lossPct: z.string().nullable() })),
  proposal: z.object({ state: z.enum(PROPOSAL_STATES), fromPct: z.string().nullable(), toPct: z.string().nullable(), cuts: z.number() }),
  lastDecision: z.object({ decision: z.enum(LOSS_DECISIONS), toPct: z.string(), cuts: z.number(), at: z.string(), reason: z.string().nullable(), revision: z.number().nullable() }).nullable(),
  extraLossValue: z.number().nullable().optional(),
  currency: z.string().nullable(),
})
export type YieldRow = z.infer<typeof yieldRowSchema>
const yieldSchema = z.object({ site, from: z.string(), minCuts: z.number(), driftPoints: z.string(), maxLossPct: z.string(), rows: z.array(yieldRowSchema) })
export type LeatherYield = z.infer<typeof yieldSchema>

const decidedSchema = z.object({
  styleId: z.string(),
  siteId: z.string(),
  decision: z.enum(LOSS_DECISIONS),
  fromPct: z.string().nullable(),
  toPct: z.string(),
  cuts: z.number(),
  decidedAt: z.string(),
  carriedIn: z.object({ revisionId: z.string(), revision: z.number(), plannedHideYieldPct: z.string(), wastagePct: z.string(), lines: z.number() }).nullable(),
})
export type LossDecided = z.infer<typeof decidedSchema>

export const getNeed = (api: ApiClient, siteId: string, signal?: AbortSignal): Promise<LeatherNeed> => api.get('/planning/leather/need', { query: { siteId }, schema: needSchema, signal })
export const getProtectors = (api: ApiClient, siteId: string, signal?: AbortSignal): Promise<LeatherProtectors> => api.get('/planning/leather/protectors', { query: { siteId }, schema: protectorsSchema, signal })
export const getYield = (api: ApiClient, siteId: string, signal?: AbortSignal): Promise<LeatherYield> => api.get('/planning/leather/yield', { query: { siteId }, schema: yieldSchema, signal })

export function acceptLoss(api: ApiClient, styleId: string, body: { siteId: string; toPct: string; cuts: number; draftVersion: number | null }): Promise<LossDecided> {
  return api.post(`/planning/leather/styles/${encodeURIComponent(styleId)}/loss/accept`, { body, schema: decidedSchema, idempotencyKey: newIdempotencyKey() })
}

export function dismissLoss(api: ApiClient, styleId: string, body: { siteId: string; toPct: string; cuts: number; reason: string }): Promise<LossDecided> {
  return api.post(`/planning/leather/styles/${encodeURIComponent(styleId)}/loss/dismiss`, { body, schema: decidedSchema, idempotencyKey: newIdempotencyKey() })
}

/** POST /inventory/reservations (B-W2a-10, B-W2b-100): the order's hides (one shade lot) or a lot's area per garment split. */
export function reserveLeather(
  api: ApiClient,
  body: { siteId: string; workOrderId?: string; salesOrderLineId?: string; note: string; lines: ({ hideId: string } | { lotId: string; quantity: string })[] },
): Promise<unknown> {
  return api.post('/inventory/reservations', { body, idempotencyKey: newIdempotencyKey() })
}
