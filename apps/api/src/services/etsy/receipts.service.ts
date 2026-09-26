/**
 * P2.5 — pull an Etsy shop's receipts (Etsy's word for orders).
 *
 * Etsy orders have never entered Nexus. There is an `EstySyncService.syncOrders`, and
 * `jobs/etsy-sync.job.ts` wraps it as `syncEstyOrders` — but **nothing calls either**:
 * a grep for `syncEstyOrders` across `apps/api/src` finds only its own definition, with
 * `startTrackingPushbackCron` (3 hits: definition, import, call) as the control. And it
 * would have returned immediately anyway: it reads `ConfigManager.getConfig("ETSY")`,
 * which needs five `ETSY_*` environment variables, and production has none of them.
 *
 * So this is written against the account-scoped reader instead — the same path
 * `information-content.ts` already uses, which resolves the connection's own token and
 * goes through the channel gateway. No environment variables, one shop per account.
 *
 * Pull, not push, on purpose: a webhook tells us an order CHANGED, and this is what
 * then reads the authoritative version. It is also the whole ingest path whenever the
 * webhook is not configured, which is the state every installation starts in.
 */
import { logger } from '../../utils/logger.js'
import { EtsyReadError, etsyReader } from './read-client.js'

/**
 * Etsy's Money. `amount` is in the currency's smallest unit and `divisor` turns it into the
 * currency value (500 / 100 = 5.00). Source: developers.etsy.com → Essentials → Definitions, and
 * the OpenAPI `Money` schema (amount int64, divisor int64 ≥ 0, currency_code string).
 */
export interface EtsyMoney { amount: number; divisor: number; currency_code: string }

/**
 * A `ShopReceiptTransaction`, as the OpenAPI v3 schema names its fields (fetched 2026-09-23 from
 * https://www.etsy.com/openapi/generated/oas/3.0.0.json). Only the fields Nexus reads are typed;
 * `unknown` is used where the value is passed through rather than interpreted.
 */
export interface EtsyReceiptTransaction {
  transaction_id: number
  receipt_id?: number
  seller_user_id?: number
  buyer_user_id?: number
  title?: string | null
  listing_id?: number | null
  product_id?: number | null
  sku?: string | null
  /** int64, minimum 0 in the schema. */
  quantity?: number
  /** The unit price: the receipt's `total_price` is "the sum of the individual listings' (price * quantity)". */
  price?: EtsyMoney
  shipping_cost?: EtsyMoney
  created_timestamp?: number
  create_timestamp?: number
  paid_timestamp?: number | null
  shipped_timestamp?: number | null
  is_digital?: boolean
  transaction_type?: string
  variations?: unknown[]
  product_data?: unknown[]
  /** `number` (float) in the schema — never used as money here. */
  buyer_coupon?: number
  shop_coupon?: number
}

export interface EtsyReceipt {
  receipt_id: number
  receipt_type?: number
  seller_user_id?: number
  buyer_user_id?: number
  seller_email?: string | null
  buyer_email?: string | null
  name?: string
  first_line?: string | null
  second_line?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
  country_iso?: string | null
  formatted_address?: string | null
  /** 'paid' | 'completed' | 'open' | 'payment processing' | 'canceled' | 'fully refunded' | 'partially refunded' */
  status?: string
  payment_method?: string
  is_paid?: boolean
  is_shipped?: boolean
  created_timestamp?: number
  create_timestamp?: number
  updated_timestamp?: number
  update_timestamp?: number
  is_gift?: boolean
  grandtotal?: EtsyMoney
  subtotal?: EtsyMoney
  total_price?: EtsyMoney
  total_shipping_cost?: EtsyMoney
  total_tax_cost?: EtsyMoney
  total_vat_cost?: EtsyMoney
  discount_amt?: EtsyMoney
  gift_wrap_price?: EtsyMoney
  shipments?: Array<{ receipt_shipping_id?: number | null; shipment_notification_timestamp?: number; carrier_name?: string; tracking_code?: string }>
  transactions?: EtsyReceiptTransaction[]
  refunds?: Array<{ amount?: EtsyMoney; created_timestamp?: number; reason?: string | null; note_from_issuer?: string | null; status?: string | null }>
}

/**
 * Why one receipt could not be read. Only Etsy's 404 is "not in this shop" (`pullEtsyReceipt` →
 * null). `not_sent` is Nexus refusing to send (a gate, a missing account), as distinct from
 * `no_answer`, where the request went out and nothing came back.
 */
export type EtsyReceiptReadFailure = 'unauthorized' | 'forbidden' | 'rate_limited' | 'server_error' | 'rejected' | 'not_sent' | 'no_answer'

/**
 * A receipt read that failed for a reason OTHER than "Etsy has no such receipt in this shop".
 * An expired token, a rate limit or an Etsy outage is not a routing answer, and recording it as one
 * hid which of them was happening.
 */
export class EtsyReceiptReadError extends Error {
  constructor(
    readonly kind: EtsyReceiptReadFailure,
    readonly status: number | null,
    readonly receiptId: string,
    /** What the reader threw. Kept for diagnosis; never copied into the message (no response bodies). */
    readonly cause: unknown,
    /** Nexus's own sentence when Nexus refused or held the call (never an Etsy response body). */
    detail?: string,
  ) {
    super(`Etsy receipt ${receiptId} could not be read: ${kind.replace('_', ' ')}${status === null ? '' : ` (HTTP ${status})`}.${detail ? ` ${detail}` : ''}`)
    this.name = 'EtsyReceiptReadError'
  }
}

/**
 * What went wrong when the reader threw something other than an Etsy HTTP answer: the gateway
 * refused or held the call (its code and sentence say why), the account needs re-authorising, or
 * nothing answered. Loaded lazily, as the reader loads the gateway.
 */
async function classifyUnanswered(error: unknown): Promise<{ kind: EtsyReceiptReadFailure; status: number | null; detail?: string }> {
  const [{ GatewayRefusal }, { ConnectionNeedsReauth }] = await Promise.all([import('../gateway/gateway.js'), import('../cx/token.service.js')])
  const isA = <T>(type: unknown, value: unknown): value is T => typeof type === 'function' && value instanceof (type as new (...args: never[]) => T)
  if (isA<InstanceType<typeof ConnectionNeedsReauth>>(ConnectionNeedsReauth, error)) return { kind: 'unauthorized', status: null, detail: error.message }
  if (isA<InstanceType<typeof GatewayRefusal>>(GatewayRefusal, error)) {
    const kind: EtsyReceiptReadFailure = error.code === 'RATE_LIMITED_LOCAL' || error.statusCode === 429 ? 'rate_limited'
      : error.code === 'ACCOUNT_NEEDS_SIGNIN' || error.code === 'TOKEN_UNAVAILABLE' || error.statusCode === 401 ? 'unauthorized'
        : 'not_sent'
    return { kind, status: error.statusCode, detail: error.message }
  }
  return { kind: 'no_answer', status: null, detail: error instanceof Error && error.name === 'GatewayNoAnswer' ? error.message : undefined }
}

function readFailureKind(status: number): EtsyReceiptReadFailure {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'server_error'
  return 'rejected'
}

/** Etsy's documented ceilings (Essentials → URL Syntax): limit ≤ 100, offset ≤ 12000. */
export const ETSY_RECEIPTS_PAGE = 100
export const ETSY_MAX_OFFSET = 12_000

/** A bounded recent-update page, or a fixed creation-window reconciliation page. */
export type EtsyReceiptPage = { minCreated: number; offset: number; limit?: number } & (
  | { minLastModified: number; maxCreated?: never }
  | { maxCreated: number; minLastModified?: never }
)

/**
 * Updated receipts are only the fast path (newest first). Completeness comes from recurring
 * creation-window scans ordered by the documented unique receipt_id, whose position an update
 * cannot change. Etsy provides no snapshot cursor; a changed count restarts reconciliation.
 */
export async function pullEtsyReceiptsPage(accountId: string, page: EtsyReceiptPage): Promise<{ shopId: string; count: number; results: unknown[] }> {
  const limit = page.limit ?? ETSY_RECEIPTS_PAGE
  const seconds = (value: number, name: string) => {
    if (!Number.isSafeInteger(value) || value < 946_684_800) throw new Error(`${name} must be epoch seconds after 2000-01-01.`)
  }
  seconds(page.minCreated, 'min_created')
  let filter: string
  if (page.minLastModified !== undefined) {
    seconds(page.minLastModified, 'min_last_modified')
    filter = `min_created=${page.minCreated}&min_last_modified=${page.minLastModified}&sort_on=updated&sort_order=desc`
  } else {
    seconds(page.maxCreated, 'max_created')
    if (page.maxCreated < page.minCreated) throw new Error('max_created must not precede min_created.')
    filter = `min_created=${page.minCreated}&max_created=${page.maxCreated}&sort_on=receipt_id&sort_order=asc`
  }
  if (!Number.isSafeInteger(page.offset) || page.offset < 0 || page.offset > ETSY_MAX_OFFSET) throw new Error(`offset must be 0..${ETSY_MAX_OFFSET}.`)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ETSY_RECEIPTS_PAGE) throw new Error(`limit must be 1..${ETSY_RECEIPTS_PAGE}.`)
  const { get, shopId } = await etsyReader(accountId)
  const body = await get<{ count?: unknown; results?: unknown }>(`/shops/${shopId}/receipts?limit=${limit}&offset=${page.offset}&${filter}`)
  if (!body || !Array.isArray(body.results)) throw new Error('Etsy answered without a receipt list.')
  if (typeof body.count !== 'number' || !Number.isSafeInteger(body.count) || body.count < 0) throw new Error('Etsy answered without a valid receipt count; reconciliation remains held.')
  return { shopId, count: body.count, results: body.results }
}

/**
 * One receipt by id, which is what a webhook names.
 *
 * `null` means exactly one thing: Etsy answered 404 for this shop's receipt path. Every other
 * failure throws an `EtsyReceiptReadError` naming its kind, so a caller never records an expired
 * token or an outage as "not in this shop".
 */
export async function pullEtsyReceipt(accountId: string, receiptId: string | number, expectedShopId?: string): Promise<EtsyReceipt | null> {
  const id = String(receiptId)
  if (!/^[1-9]\d*$/.test(id)) throw new Error('An Etsy receipt id must be a positive whole number.')
  const { get, shopId } = await etsyReader(accountId)
  if (expectedShopId !== undefined && expectedShopId !== shopId) throw new Error('The Etsy receipt names a different shop from its connected account.')
  try {
    return await get<EtsyReceipt>(`/shops/${shopId}/receipts/${id}`)
  } catch (error) {
    if (error instanceof EtsyReadError && error.status === 404) {
      // A receipt id from an unverified source may simply not belong to this shop. That
      // is a routing answer, not a failure of the pull.
      logger.warn('[etsy-receipts] Etsy has no such receipt in this shop', { accountId, shopId, receiptId: id })
      return null
    }
    if (error instanceof EtsyReadError) throw new EtsyReceiptReadError(readFailureKind(error.status), error.status, id, error)
    const { kind, status, detail } = await classifyUnanswered(error)
    throw new EtsyReceiptReadError(kind, status, id, error, detail)
  }
}
