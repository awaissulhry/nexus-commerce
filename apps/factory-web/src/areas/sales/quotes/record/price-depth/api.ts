import { z } from 'zod'
import { WATERFALL_KINDS } from '@nexus/factory-domain/sales/price-waterfall/rules'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'
import { getCostSheet } from '../../../../products/styles/api'
import { quoteSchema, type QuoteDetail } from '../../api'

/**
 * Prices on screen (B-W2b-343) on the merged API of B-W2b-330 (GET /sales/quotes/:quoteId/pricing, PUT …/lines/:lineId/price)
 * and B-W2b-325 (GET …/list-prices): every price and step is the price grain, a margin the margin grain — ABSENT (never 0)
 * when the person's grains do not reach it. The API's English (`why`, labels, `problem`) is never read: the screens say
 * each step from its kind, its reason code and its figures. The cost breakdown reads the revision's cost sheet (W1
 * costing, the cost grain and costing.view).
 */

const enc = encodeURIComponent

export const stepSchema = z.object({
  kind: z.enum(WATERFALL_KINDS),
  unitPrice: z.string().optional(),
  delta: z.string().optional(),
  pct: z.string().optional(),
  sizes: z.record(z.string(), z.string()).optional(),
  source: z.object({ type: z.string(), id: z.string() }).optional(),
  reasonCode: z.string().optional(),
  note: z.string().optional(),
})
export type PriceStep = z.infer<typeof stepSchema>

const basedOn = z.object({ revisionId: z.string().nullable(), revision: z.number().nullable(), revisionStatus: z.string().nullable(), on: z.string().nullable(), computedAt: z.string().nullable() })

export const pricingLineSchema = z.object({
  lineId: z.string(),
  seq: z.number(),
  kind: z.string(),
  feeKind: z.string().nullable(),
  styleId: z.string(),
  colourwayId: z.string(),
  quantity: z.number(),
  unitPrice: z.string().optional(),
  listUnitPrice: z.string().nullable().optional(),
  adjustmentReason: z.string().nullable(),
  /** As stored (QuoteLine.priceSteps); null: priced without one; absent: no price grain. */
  steps: z.array(stepSchema).nullable().optional(),
  /** A stored waterfall that would no longer add up (words of the API: only whether there is one is read). */
  stepsProblem: z.string().nullable(),
  /** What a LIST start writes now (NET last); null: no list prices the line. */
  fromList: z.array(stepSchema).nullable().optional(),
  suggested: z.object({ unitPrice: z.string().nullable().optional(), marginPct: z.string().nullable().optional(), basedOn: basedOn.nullable(), problem: z.string().nullable() }).nullable(),
  marginPct: z.string().nullable().optional(),
  belowFloor: z.boolean().optional(),
})
export type PricingLine = z.infer<typeof pricingLineSchema>

export const pricingSchema = z.object({
  quoteId: z.string(),
  versionId: z.string(),
  revision: z.number(),
  status: z.string(),
  currency: z.string(),
  priceBasis: z.enum(['NET', 'GROSS']),
  floor: z.object({ marginFloorPct: z.string().optional(), source: z.enum(['ROLE', 'COMPANY']), roleKey: z.string().nullable(), personId: z.string().nullable() }),
  lines: z.array(pricingLineSchema),
})
export type QuotePricing = z.infer<typeof pricingSchema>

export function readPricing(api: ApiClient, quoteId: string, signal?: AbortSignal): Promise<QuotePricing> {
  return api.get(`/sales/quotes/${enc(quoteId)}/pricing`, { schema: pricingSchema, signal })
}

export const listPriceLineSchema = z.object({
  lineId: z.string(),
  seq: z.number(),
  quantity: z.number(),
  list: z.object({ listId: z.string(), code: z.string(), versionId: z.string(), revision: z.number().nullable(), entryId: z.string(), validFrom: z.string().nullable(), validTo: z.string().nullable(), colourwayPrice: z.boolean(), depth: z.number() }).nullable(),
  listPrice: z.string().nullable().optional(),
  break: z.object({ breakId: z.string(), ownBreak: z.boolean(), minQuantity: z.number(), pieces: z.number(), unitPrice: z.string().optional(), discountPct: z.string().nullable().optional(), delta: z.string().optional() }).nullable(),
  sizeSurcharges: z.array(z.object({ size: z.string(), surchargeId: z.string(), scope: z.enum(['VERSION_STYLE', 'VERSION', 'STYLE']), amount: z.string().optional(), pct: z.string().nullable().optional() })),
})
export type ListPriceLine = z.infer<typeof listPriceLineSchema>

const listPricesSchema = z.object({ quoteId: z.string(), versionId: z.string(), day: z.string(), currency: z.string(), showDiscount: z.boolean(), lines: z.array(listPriceLineSchema) })
export type QuoteListPrices = z.infer<typeof listPricesSchema>

export function readListPrices(api: ApiClient, quoteId: string, signal?: AbortSignal): Promise<QuoteListPrices> {
  return api.get(`/sales/quotes/${enc(quoteId)}/list-prices`, { schema: listPricesSchema, signal })
}

const reasonSchema = z.object({ code: z.string(), labelIt: z.string(), labelEn: z.string(), needsDetail: z.boolean() })
export type PriceReason = z.infer<typeof reasonSchema>

/** The ACTIVE price adjustment reasons (signed in, no permission), in their list's order. */
export async function readPriceReasons(api: ApiClient, signal?: AbortSignal): Promise<PriceReason[]> {
  return (await api.get('/reasons', { query: { list: 'PRICE_ADJUSTMENT' }, schema: z.object({ reasons: z.array(reasonSchema) }), signal })).reasons
}

export interface PriceBody {
  start: 'LIST' | 'SUGGESTED' | 'MANUAL'
  startPrice?: string
  startReasonCode?: string
  startNote?: string | null
  discount?: { pct: string; reasonCode?: string | null }
  net?: { unitPrice: string; reasonCode: string; note?: string | null }
}

const priceAnswerSchema = z.object({ quote: quoteSchema, line: z.object({ lineId: z.string(), unitPrice: z.string().optional(), adjustmentReason: z.string().nullable() }) })
export type PriceAnswer = z.infer<typeof priceAnswerSchema>

/** One DRAFT size-grid line priced by its waterfall, at the quote's version (a moved quote is a 409, never overwritten). */
export function priceLine(api: ApiClient, quote: Pick<QuoteDetail, 'id' | 'version'>, lineId: string, body: PriceBody, idempotencyKey: string = newIdempotencyKey()): Promise<PriceAnswer> {
  return api.request('PUT', `/sales/quotes/${enc(quote.id)}/lines/${enc(lineId)}/price`, { body: { version: quote.version, ...body }, schema: priceAnswerSchema, idempotencyKey })
}

export { getCostSheet }
