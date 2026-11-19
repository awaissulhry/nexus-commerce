import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { ownPriceOf } from '../neworder/model'

/**
 * F-CP-143 (customer page plan C3, D2, D3; Owner O4; 11 §3.4; review B2, C3): the customer's own price check of its order, in its
 * portal — the portal half of the price check (the draft's "Your price" cell is F-CP-154). Kept out of the order lane's
 * `orders/{api,model}.ts` (B01, C05): its own calls, schemas and rules here.
 *
 *   GET /portal/sales-orders/:orderId/price-check    the customer's Buyer, Finance, Admin (the price grain of their role): each line —
 *                                                    our unit price and amount beside the customer's own, the check, the difference;
 *                                                    the order's total the same way; whether this person may give its price now
 *   PUT /portal/sales-orders/:orderId/brand-prices   the Buyer and the Admin (portal.salesOrders.ask + the grain): ONE command that gives,
 *                                                    changes and takes away the customer's LINE prices at the versions read (409:
 *                                                    "Someone changed these prices meanwhile. Here they are now.")
 *
 * Finance reads only. The Designer, Production, Quality and Viewer never get a call: "Prices are not part of your access." A row the
 * factory typed says so in words only ("Typed by the factory") — never the office's note, never who typed it (review C3). The card
 * says "Our prices agree" · "Our prices differ on {count} lines: change your price (you can add a note)" — never "write to us" (review
 * B2: production reads the thread) · "You have not given your price yet". Money: minor units of the order's currency; unit prices as
 * the API's decimal strings. Brand wall: the API answers only the customer's own order ("Order not found." for any other).
 */

/** The check of a line and of the order (factory-domain sales/brand-prices/match PRICE_MATCHES). */
export const PRICE_MATCHES = ['EQUAL', 'NOT_EQUAL', 'NO_BRAND_PRICE'] as const
export type PriceMatch = (typeof PRICE_MATCHES)[number]
/** Where a customer's price came from: typed here (PORTAL), or typed by the factory from the customer's PO or by itself. */
export const BRAND_PRICE_SOURCES = ['PORTAL', 'CUSTOMER_PO', 'OFFICE'] as const
export type BrandPriceSource = (typeof BRAND_PRICE_SOURCES)[number]

const pair = z.object({ it: z.string(), en: z.string() })
const rowSchema = z.object({
  id: z.string(),
  /** A line's unit price (decimal); null: a line total, or the order's total row. */
  unitPrice: z.string().nullable(),
  netAmount: z.number().nullable(),
  currency: z.string(),
  source: z.enum(BRAND_PRICE_SOURCES),
  note: z.string().nullable(),
  enteredAt: z.string(),
  version: z.number(),
})
export type PortalPriceRow = z.infer<typeof rowSchema>

export const priceCheckSchema = z.object({
  orderId: z.string(),
  currency: z.string(),
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
  /** May this person give or change its price now (the API's words when not are not drawn: the page says its own). */
  mayWrite: z.object({ allowed: z.boolean(), why: pair.nullable() }),
})
export type PortalPriceCheck = z.infer<typeof priceCheckSchema>
export type PortalPriceLine = PortalPriceCheck['lines'][number]

const checkPath = (orderId: string) => `/portal/sales-orders/${encodeURIComponent(orderId)}`

/** The customer's price check of its own order (a reader without the price grain is never asked: the page says prices.none). */
export const fetchPriceCheck = (api: ApiClient, orderId: string, signal?: AbortSignal): Promise<PortalPriceCheck> => api.get(`${checkPath(orderId)}/price-check`, { schema: priceCheckSchema, signal })

export interface BrandPricesBody {
  /** The order's currency as read (the API checks it). */
  currency: string
  rows: { lineId: string; unitPrice: string; note?: string; version?: number }[]
  remove: { id: string; version: number }[]
}

/** ONE save of the customer's line prices (the body names no party or company: the session's own order, W-CP-1). */
export const saveBrandPrices = (api: ApiClient, orderId: string, body: BrandPricesBody, idempotencyKey: string = newIdempotencyKey()): Promise<PortalPriceCheck> =>
  api.request('PUT', `${checkPath(orderId)}/brand-prices`, { body, schema: priceCheckSchema, idempotencyKey })

// ── who sees and who writes ────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * The reader's part: none (no price grain — the Designer, Production, Quality, Viewer: no call, "Prices are not part of your access."),
 * read (Finance, or an order no longer open), write (the Buyer and the Admin while the order is open).
 */
export function priceCheckAccessOf(seesPrices: boolean, check: Pick<PortalPriceCheck, 'mayWrite'> | null): 'none' | 'read' | 'write' {
  if (!seesPrices) return 'none'
  return check?.mayWrite.allowed ? 'write' : 'read'
}

/** Why "Your prices…" cannot open now (a key), or null: a preview or offline first, then a closed order, then a role that reads only. */
export function priceHeldKeyOf(input: { readonly allowed: boolean; readonly closed: boolean; readonly preview: boolean; readonly offline: boolean }): string | null {
  if (input.preview) return 'held.preview'
  if (input.offline) return 'held.offline'
  if (input.allowed) return null
  return input.closed ? 'priceCheck.closed' : 'priceCheck.readsOnly'
}

/** An order no longer open for prices (CLOSED or CANCELLED keep theirs). */
export const pricesClosed = (status: string): boolean => status === 'CLOSED' || status === 'CANCELLED'

// ── the card ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * The card's one line: "Our prices agree" · "Our prices differ on {count} lines: change your price (you can add a note)" (or on the
 * order's total) · "You have not given your price yet" — and how many lines still lack the customer's price. Never "write to us".
 */
export function priceCardOf(check: Pick<PortalPriceCheck, 'total' | 'lines'>): { key: string; tone: 'success' | 'danger' | 'neutral'; count?: number; missing: number } {
  const missing = check.total.priceMissingLines
  if (check.total.priceMatch === 'NOT_EQUAL') {
    const count = check.total.priceNotEqualLines
    return count > 0 ? { key: 'priceCheck.differ', tone: 'danger', count, missing } : { key: 'priceCheck.differTotal', tone: 'danger', missing }
  }
  if (check.total.priceMatch === 'EQUAL') return { key: 'priceCheck.agree', tone: 'success', missing }
  return { key: 'priceCheck.none', tone: 'neutral', missing }
}

/** A line's (or the order's) check in words: Equal · Not equal · No price of yours yet. */
export const matchKey = (match: PriceMatch | null): string => `priceCheck.match.${match ?? 'NO_BRAND_PRICE'}`

/** The tone of a check (never colour alone: the words go with it). */
export const matchTone = (match: PriceMatch | null): 'neutral' | 'danger' => (match === 'NOT_EQUAL' ? 'danger' : 'neutral')

/** Where the customer's price came from, in its words: "Typed by you", "From your PO, typed by the factory", "Typed by the factory". */
export const sourceKey = (source: BrandPriceSource): string => `priceCheck.source.${source}`

/** The difference, our price minus the customer's, signed: "+€50.00" (we ask more), "−€10.00" (we ask less); null: none. */
export function diffText(minor: number | null, money: (minor: number) => string): string | null {
  if (minor === null) return null
  if (minor === 0) return money(0)
  return `${minor > 0 ? '+' : '−'}${money(Math.abs(minor))}`
}

/**
 * The customer's own price on a line, as the page shows it: the unit price (or, typed as a line total, none per piece), the amount,
 * where it came from, and the customer's OWN note only (a row the factory typed never shows the office's words, review C3).
 */
export function yourPriceOf(line: Pick<PortalPriceLine, 'row' | 'brandAmount'>): { unit: string | null; amount: number | null; source: BrandPriceSource | null; note: string | null } {
  const row = line.row
  if (!row) return { unit: null, amount: line.brandAmount, source: null, note: null }
  return { unit: row.unitPrice, amount: line.brandAmount, source: row.source, note: row.source === 'PORTAL' ? row.note : null }
}

// ── "Your prices…" ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface PriceDraft {
  /** By line: the unit price as typed ('' = none). */
  prices: Readonly<Record<string, string>>
  /** One note of the customer's that goes with the prices it changes. */
  note: string
}

/** The window as the check holds it: each line's unit price (the factory's too: typing over it replaces it), the note empty. */
export function priceDraftOf(check: Pick<PortalPriceCheck, 'lines'>, locale: 'it' | 'en' = 'en'): PriceDraft {
  const prices: Record<string, string> = {}
  for (const line of check.lines) prices[line.lineId] = line.row?.unitPrice ? (locale === 'it' ? line.row.unitPrice.replace('.', ',') : line.row.unitPrice) : ''
  return { prices, note: '' }
}

/** A typed price that does not read as one, by line (keys); a note longer than the API takes. */
export function priceDraftProblems(draft: PriceDraft): { lines: Record<string, string>; note: string | null } {
  const lines: Record<string, string> = {}
  for (const [lineId, typed] of Object.entries(draft.prices)) {
    const read = ownPriceOf(typed)
    if ('problem' in read) lines[lineId] = 'priceCheck.problem'
  }
  return { lines, note: draft.note.trim().length > 1000 ? 'priceCheck.noteLong' : null }
}

const sameDecimal = (a: string | null, b: string | null): boolean => (a === null || b === null ? a === b : Number(a) === Number(b))

/**
 * What "Save your prices" sends: a line typed differently from what it holds goes as a row at the version read (a row the factory
 * typed is replaced by the customer's own); an emptied line that holds the customer's OWN price is taken away; an emptied line the
 * factory priced stays as it is (the factory's row is replaced, never only removed). The note goes with the rows sent. Nothing changed:
 * null (no call).
 */
export function priceBodyOf(check: Pick<PortalPriceCheck, 'lines' | 'currency'>, draft: PriceDraft): BrandPricesBody | null {
  const note = draft.note.trim()
  const rows: BrandPricesBody['rows'] = []
  const remove: BrandPricesBody['remove'] = []
  for (const line of check.lines) {
    const typed = draft.prices[line.lineId]
    if (typed === undefined) continue
    const read = ownPriceOf(typed)
    if ('problem' in read) continue
    const row = line.row
    if (read.value === null) {
      if (row && row.source === 'PORTAL') remove.push({ id: row.id, version: row.version })
      continue
    }
    if (row && row.unitPrice !== null && sameDecimal(row.unitPrice, read.value) && (row.source !== 'PORTAL' || note === '')) continue
    rows.push({ lineId: line.lineId, unitPrice: read.value, ...(note ? { note } : {}), ...(row ? { version: row.version } : {}) })
  }
  return rows.length === 0 && remove.length === 0 ? null : { currency: check.currency, rows, remove }
}
