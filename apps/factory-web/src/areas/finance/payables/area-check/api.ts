import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * The leather area check on a supplier invoice (B-W2b-425 on B-W2b-403's API; design finance.payables rec:Supplier invoice
 * Match "Leather area check (W2b): invoiced sq ft vs measured sq ft received; beyond tolerance → 'Open area claim'"). Areas
 * are decimal strings in the material's base area unit; no money. The outcome list mirrors factory-domain
 * payables/area-check (the tests hold it equal); the answer's words are never drawn.
 */

export const AREA_LINE_OUTCOMES = ['WITHIN', 'SHORT', 'OVER', 'NOT_RECEIVED'] as const
export type AreaOutcome = (typeof AREA_LINE_OUTCOMES)[number]
export const TOLERANCE_SOURCES = ['ORDER_LINE', 'COMPANY', 'TENANT', 'DEFAULT'] as const

const checkSchema = z.object({
  invoiced: z.string(),
  invoicedTotal: z.string(),
  received: z.string(),
  measured: z.string(),
  measuredHides: z.number(),
  unmeasuredHides: z.number(),
  difference: z.string(),
  differencePercent: z.string(),
  outcome: z.enum(AREA_LINE_OUTCOMES),
  opensClaim: z.boolean(),
  shortfall: z.string(),
})
export type AreaCheck = z.infer<typeof checkSchema>

export const areaLineSchema = z.object({
  lineId: z.string(),
  seq: z.number(),
  description: z.string(),
  quantity: z.string().nullable(),
  uom: z.string().nullable(),
  order: z.object({ id: z.string(), number: z.string(), lineId: z.string(), lineSeq: z.number(), siteId: z.string(), uom: z.string() }),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), baseUom: z.string() }),
  tolerancePercent: z.string(),
  toleranceFrom: z.enum(TOLERANCE_SOURCES),
  lots: z.array(z.object({ id: z.string(), code: z.string() })),
  hides: z.array(z.object({ id: z.string(), code: z.string(), lotId: z.string(), received: z.string(), measured: z.string().nullable() })),
  check: checkSchema.nullable(),
  claim: z.object({ opens: z.boolean(), held: z.string().nullable(), existing: z.array(z.object({ id: z.string(), number: z.string(), status: z.string() })) }),
})
export type AreaLine = z.infer<typeof areaLineSchema>

const enc = encodeURIComponent

/** GET /payables/invoices/:id/area-check (payables.view): each leather line's invoiced area against what was measured. */
export async function areaCheck(api: ApiClient, invoiceId: string, signal?: AbortSignal): Promise<AreaLine[]> {
  return (await api.get(`/payables/invoices/${enc(invoiceId)}/area-check`, { schema: z.object({ invoiceId: z.string(), lines: z.array(areaLineSchema) }), signal })).lines
}

/** POST /payables/invoices/:id/area-check/:lineId/claim (purchasing.claims.manage): a DRAFT area claim for the shortfall. */
export async function openAreaClaim(api: ApiClient, invoiceId: string, lineId: string, idempotencyKey: string): Promise<{ id: string; number: string; status: string }> {
  return (await api.post(`/payables/invoices/${enc(invoiceId)}/area-check/${enc(lineId)}/claim`, { body: {}, schema: z.object({ claim: z.object({ id: z.string(), number: z.string(), status: z.string() }) }), idempotencyKey })).claim
}
