import { z } from 'zod'
import { PRODUCT_TYPES } from '@nexus/factory-domain/product/styles/rules'
import { MINIMUM_ACTIONS, MINIMUM_PER } from '@nexus/factory-domain/sales/pricing-depth/rules'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { entrySchema, versionSchema, type PriceVersion } from '../api'

/**
 * Price lists in depth on screen (B-W2b-343) on B-W2b-325's API (apps/factory-api modules/sales/pricing-depth): a
 * version's quantity breaks and size surcharges (the record's Breaks & surcharges tab), its dated prices (Prices › Valid
 * from–to), the list's discount on documents, the minimum order quantities of its customers, a version's prices as the
 * import's file. Every price, break and surcharge is the price grain: ABSENT (never null) without it. Each write sends
 * the version's (or list's, or minimum's) `version` as read and its own Idempotency-Key; a moved record is a 409. Every
 * break and surcharge row sends BOTH money fields (null for none; both null removes it).
 */

const enc = encodeURIComponent
const listPath = (id: string) => `/sales/price-lists/${enc(id)}`
const versionPath = (listId: string, versionId: string) => `${listPath(listId)}/versions/${enc(versionId)}`

const label = z.object({ code: z.string(), name: z.string() })

export const surchargeSchema = z.object({
  id: z.string(),
  /** Null: every style of the version. */
  styleId: z.string().nullable(),
  style: label.nullable(),
  size: z.string(),
  amount: z.string().nullable().optional(),
  currency: z.string().nullable(),
  pct: z.string().nullable().optional(),
  version: z.number(),
})
export type Surcharge = z.infer<typeof surchargeSchema>

export const breakSchema = z.object({
  id: z.string(),
  /** Null: every price of the version (a discount). */
  entryId: z.string().nullable(),
  entry: z.object({ id: z.string(), styleId: z.string(), style: label, colourwayId: z.string().nullable(), colourway: label.nullable(), unitPrice: z.string().optional(), validFrom: z.string().nullable(), validTo: z.string().nullable() }).nullable(),
  minQuantity: z.number(),
  unitPrice: z.string().nullable().optional(),
  discountPct: z.string().nullable().optional(),
  version: z.number(),
})
export type PriceBreak = z.infer<typeof breakSchema>

export const rulesSchema = z.object({
  list: z.object({ id: z.string(), code: z.string(), currency: z.string(), showDiscount: z.boolean() }),
  version: z.object({ id: z.string(), revision: z.number(), status: z.enum(['DRAFT', 'ACTIVE']), version: z.number(), updatedAt: z.string() }),
  breaks: z.array(breakSchema),
  sizeSurcharges: z.array(surchargeSchema),
  styleSurcharges: z.array(surchargeSchema),
})
export type VersionRules = z.infer<typeof rulesSchema>

export function readRules(api: ApiClient, listId: string, versionId: string, signal?: AbortSignal): Promise<VersionRules> {
  return api.get(`${versionPath(listId, versionId)}/rules`, { schema: rulesSchema, signal })
}

export interface BreakRow {
  entryId: string | null
  minQuantity: number
  unitPrice: string | null
  discountPct: string | null
}

/** A DRAFT's breaks set (or removed: both money fields null), at the version's `version`. */
export function setBreaks(api: ApiClient, listId: string, version: Pick<VersionRules['version'], 'id' | 'version'>, breaks: readonly BreakRow[]): Promise<VersionRules> {
  return api.request('PUT', `${versionPath(listId, version.id)}/breaks`, { body: { version: version.version, breaks }, schema: rulesSchema, idempotencyKey: newIdempotencyKey() })
}

export interface SurchargeRow {
  styleId: string | null
  size: string
  amount: string | null
  pct: string | null
}

/** A DRAFT's size surcharges (every style or one), set or removed (both null). */
export function setSurcharges(api: ApiClient, listId: string, version: Pick<VersionRules['version'], 'id' | 'version'>, surcharges: readonly SurchargeRow[]): Promise<VersionRules> {
  return api.request('PUT', `${versionPath(listId, version.id)}/size-surcharges`, { body: { version: version.version, surcharges }, schema: rulesSchema, idempotencyKey: newIdempotencyKey() })
}

export interface DatedRow {
  styleId: string
  colourwayId: string | null
  validFrom: string | null
  validTo: string | null
  /** Null removes the price (with its own breaks). */
  unitPrice: string | null
}

const versionAnswer = z.object({ version: versionSchema, entries: z.array(entrySchema) })

/** A DRAFT's prices with their days, keyed by style, colourway and first day (a style with dated prices is written here). */
export function setDatedPrices(api: ApiClient, listId: string, version: Pick<PriceVersion, 'id' | 'version'>, prices: readonly DatedRow[]) {
  return api.request('PUT', `${versionPath(listId, version.id)}/dated-prices`, { body: { version: version.version, prices }, schema: versionAnswer, idempotencyKey: newIdempotencyKey() })
}

/** SAL-170: the list's documents show the list price and the discount, or the net price only. */
export function setDiscountDisplay(api: ApiClient, list: { id: string; version: number }, showDiscount: boolean) {
  return api.request('PUT', `${listPath(list.id)}/discount-display`, { body: { version: list.version, showDiscount }, schema: z.object({ list: z.object({ id: z.string(), code: z.string(), showDiscount: z.boolean(), version: z.number() }) }), idempotencyKey: newIdempotencyKey() })
}

/** One version's prices as the import's file (CSV or XLSX, the price grain), a plain link through this app's `/api`. */
export function exportHref(listId: string, versionId: string, format: 'csv' | 'xlsx', numberFormat: 'it' | 'en'): string {
  return `/api${versionPath(listId, versionId)}/export?${new URLSearchParams({ format, numberFormat }).toString()}`
}

// ---- minimum order quantities (SAL-178) ----------------------------------------------------------------------------------

export const minimumSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  priceListId: z.string().nullable(),
  subject: z.enum(['STYLE', 'PRODUCT_TYPE', 'MATERIAL']),
  styleId: z.string().nullable(),
  style: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  productType: z.enum(PRODUCT_TYPES).nullable(),
  itemId: z.string().nullable(),
  item: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  minQuantity: z.number(),
  per: z.enum(MINIMUM_PER),
  action: z.enum(MINIMUM_ACTIONS),
  surchargeAmount: z.string().nullable().optional(),
  currency: z.string().nullable(),
  surchargePct: z.string().nullable().optional(),
  note: z.string().nullable(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Minimum = z.infer<typeof minimumSchema>

export function listMinimums(api: ApiClient, priceListId: string, signal?: AbortSignal): Promise<Minimum[]> {
  return api.get('/sales/minimums', { query: { priceListId, status: 'ALL' }, schema: z.object({ minimums: z.array(minimumSchema) }), signal }).then((answer) => answer.minimums)
}

export interface NewMinimumBody {
  companyId: string | null
  priceListId: string
  styleId?: string
  productType?: (typeof PRODUCT_TYPES)[number]
  itemId?: string
  minQuantity: number
  per: (typeof MINIMUM_PER)[number]
  action: (typeof MINIMUM_ACTIONS)[number]
  surchargeAmount?: string | null
  currency?: string | null
  surchargePct?: string | null
  note?: string | null
}

export function createMinimum(api: ApiClient, body: NewMinimumBody): Promise<Minimum> {
  return api.post('/sales/minimums', { body, schema: z.object({ minimum: minimumSchema }), idempotencyKey: newIdempotencyKey() }).then((answer) => answer.minimum)
}

export function moveMinimum(api: ApiClient, minimum: Pick<Minimum, 'id' | 'version'>, move: 'archive' | 'reactivate'): Promise<Minimum> {
  return api.post(`/sales/minimums/${enc(minimum.id)}/${move}`, { body: { version: minimum.version }, schema: z.object({ minimum: minimumSchema }), idempotencyKey: newIdempotencyKey() }).then((answer) => answer.minimum)
}
