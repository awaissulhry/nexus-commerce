import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import { listFiles } from '../../../../record-panels/api'
import { PRICE_MATCHES } from '../api'

/**
 * F-CP-114 (customer page plan C2d, C3; design 11-money §1.2, §3.3; review A3; the API's B-CP-017) — the calls of the ONE customer's-
 * price editor, kept out of so/api.ts (the order lane edits it): the price check of one order, the customer's prices saved at the
 * versions read, and this order's files for "PO file". Only a price holder reaches them (the door is drawn with the price grain only;
 * the API answers 403 to anyone else). Amounts are minor units of the order's currency, without VAT; unit prices decimal strings.
 */

export const BRAND_PRICE_SOURCES = ['PORTAL', 'CUSTOMER_PO', 'OFFICE'] as const
export type BrandPriceSource = (typeof BRAND_PRICE_SOURCES)[number]
/** What the office types: from the customer's PO, or typed by us (PORTAL is the customer's own). */
export type OfficeSource = Exclude<BrandPriceSource, 'PORTAL'>

const rowSchema = z.object({
  id: z.string(),
  /** A line's unit price (decimal string); null: its line total, or the order's total row. */
  unitPrice: z.string().nullable(),
  /** A line's total, or the order's total (minor units); null: a unit price. */
  netAmount: z.number().nullable(),
  currency: z.string(),
  source: z.enum(BRAND_PRICE_SOURCES),
  sourceFile: z.object({ id: z.string(), name: z.string() }).nullable(),
  note: z.string().nullable(),
  enteredBy: z.object({ name: z.string() }).nullable(),
  enteredAt: z.string(),
  version: z.number(),
})
export type BrandPriceRow = z.infer<typeof rowSchema>

export const priceCheckSchema = z.object({
  orderId: z.string(),
  number: z.string(),
  currency: z.string(),
  status: z.string(),
  lines: z.array(
    z.object({
      lineId: z.string(),
      seq: z.number(),
      label: z.string(),
      pieces: z.number(),
      ourUnitPrice: z.string(),
      ourAmount: z.number(),
      brandAmount: z.number().nullable(),
      priceMatch: z.enum(PRICE_MATCHES).nullable(),
      priceDiff: z.number().nullable(),
      row: rowSchema.nullable(),
    }),
  ),
  total: z.object({
    ourPrice: z.number(),
    brandPrice: z.number().nullable(),
    priceMatch: z.enum(PRICE_MATCHES),
    priceDiff: z.number().nullable(),
    priceNotEqualLines: z.number(),
    priceMissingLines: z.number(),
    priceOtherCurrency: z.number(),
    row: rowSchema.nullable(),
  }),
  fromRequest: z.object({ requestId: z.string(), number: z.string().nullable(), lines: z.number() }).nullable(),
  /** The API's `why` is English (for logs): the dialog says its own words from the order's status. */
  mayWrite: z.object({ allowed: z.boolean(), why: z.string().nullable() }),
})
export type PriceCheck = z.infer<typeof priceCheckSchema>
export type PriceCheckLine = PriceCheck['lines'][number]

/** One row sent: a line's unit price or line total (one of the two), or the order's total (`lineId` null). */
export interface BrandPriceRowBody {
  readonly lineId: string | null
  readonly unitPrice?: string
  readonly netAmount?: number
  readonly source: OfficeSource
  readonly sourceFileId: string | null
  readonly note: string | null
  /** The row's version as read; absent: the line (or the order) had no customer's price yet. */
  readonly version?: number
}

export interface SaveBrandPricesBody {
  /** The order's currency as read (the API checks it). */
  readonly currency: string
  readonly rows: readonly BrandPriceRowBody[]
  readonly remove: readonly { readonly id: string; readonly version: number }[]
}

/** GET /sales/orders/:orderId/price-check (orders.view + the price grain over the order). */
export function readPriceCheck(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<PriceCheck> {
  return api.get(`/sales/orders/${encodeURIComponent(orderId)}/price-check`, { schema: priceCheckSchema, signal })
}

/** PUT /sales/orders/:orderId/brand-prices (orders.manage + the price grain): one command at the versions read; the check as now. */
export function saveBrandPrices(api: ApiClient, orderId: string, body: SaveBrandPricesBody, idempotencyKey: string): Promise<PriceCheck> {
  return api.request('PUT', `/sales/orders/${encodeURIComponent(orderId)}/brand-prices`, { body, schema: priceCheckSchema, idempotencyKey })
}

/** This order's files, for "PO file" (the record's own list: a price holder reads every file of it, priced ones too). */
export async function readOrderFiles(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<readonly { readonly id: string; readonly name: string }[]> {
  const answer = await listFiles(api, { type: 'SalesOrder', id: orderId }, signal)
  return answer.files.filter((file) => file.status === 'AVAILABLE' && !file.locked).map((file) => ({ id: file.id, name: file.originalName }))
}
