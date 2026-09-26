/**
 * CX Etsy E1 — one Etsy receipt, read back from Etsy, as the facts an order writer may use.
 *
 * PURE: no database, no network, no clock. It answers with a normalised receipt or with ONE named
 * refusal, and it never repairs a value — a receipt that does not prove what the writer needs is
 * refused with the reason, recorded, and retried or looked at; it is not guessed at.
 *
 * Field names and types are Etsy's OpenAPI v3 (`ShopReceipt`, `ShopReceiptTransaction`, `Money`),
 * fetched 2026-09-23 from https://www.etsy.com/openapi/generated/oas/3.0.0.json. Money semantics:
 * https://developers.etsy.com/documentation/essentials/definitions/ ("a listing for 500 in the
 * amount, will be divided by 100 pennies to come up with 5 dollars").
 *
 * What it does NOT decide (Owner questions, 2026-09-23 still open): when stock is held or taken,
 * and which historical receipts are ingested at all. Those belong to the writer (E3).
 */
import type { OrderStatus } from '@prisma/client'
import type { EtsyReceipt } from './receipts.service.js'

/**
 * The most units one Etsy transaction can carry. Etsy refuses a listing or variation quantity
 * above 999 ("Quantity cannot be greater than 999"), so one purchase cannot exceed it. Not in the
 * OpenAPI schema (which only says `minimum: 0`); a larger number here is a shape error, and it
 * would otherwise become a HARD stock hold.
 */
export const ETSY_MAX_LINE_QUANTITY = 999

/** Divisors whose value fits a `Decimal(·,2)` column EXACTLY: 1 → .00, 10 → .d0, 100 → .dd. */
const EXACT_DIVISORS = new Set([1, 10, 100])

/** `Order.totalPrice` is Decimal(12,2); `OrderItem.price` is Decimal(10,2). In minor units (cents). */
const RECEIPT_MONEY_LIMIT = 10n ** 12n
const LINE_MONEY_LIMIT = 10n ** 10n

/** The schema's own floor for every *_timestamp (2000-01-01T00:00:00Z). */
const MIN_TIMESTAMP = 946_684_800

export const ETSY_RECEIPT_STATUSES = ['open', 'payment processing', 'paid', 'completed', 'canceled', 'fully refunded', 'partially refunded'] as const
export type EtsyReceiptStatus = (typeof ETSY_RECEIPT_STATUSES)[number]

export type EtsyReceiptRefusalCode =
  | 'binding_invalid'
  | 'not_a_receipt'
  | 'receipt_id_invalid'
  | 'receipt_id_mismatch'
  | 'shop_mismatch'
  | 'seller_mismatch'
  | 'id_invalid'
  | 'status_unknown'
  | 'timestamp_invalid'
  | 'created_after_updated'
  | 'transactions_invalid'
  | 'paid_without_transactions'
  | 'transaction_receipt_mismatch'
  | 'duplicate_transaction'
  | 'quantity_invalid'
  | 'money_missing'
  | 'money_invalid'
  | 'money_divisor_unsupported'
  | 'money_currency_mixed'
  | 'money_exceeds_column'

export interface EtsyReceiptRefusal {
  code: EtsyReceiptRefusalCode
  /** A sentence for a person. Names the field; never contains buyer data. */
  message: string
  /** Where in the receipt, e.g. `transactions[1].price`. */
  path: string
}

export interface NormalizedMoney {
  /** Exact decimal string with two places — what a Decimal(·,2) column receives. */
  decimal: string
  /** The value in hundredths, for exact integer arithmetic. */
  cents: bigint
  /** Etsy's raw minor units, retained verbatim for metadata. */
  amount: number
  divisor: 1 | 10 | 100
  currencyCode: string
}

export interface NormalizedEtsyLine {
  /** Etsy's transaction_id — stable, the line's identity (`OrderItem.externalLineItemId`). */
  transactionId: string
  listingId: string | null
  /** Etsy's own product id inside the listing (not a Nexus Product id). */
  etsyProductId: string | null
  sku: string | null
  title: string | null
  /** 0..999. The schema's minimum is 0; a 0 line is kept, flagged, and never touches stock. */
  quantity: number
  /** quantity > 0: only these lines may hold or move stock. */
  stockEligible: boolean
  /** The unit price (receipt.total_price = Σ price × quantity, per the schema's description). */
  unitPrice: NormalizedMoney
  /** unitPrice × quantity, exact. */
  lineTotal: string
  shippingCost: NormalizedMoney | null
  paidAt: number | null
  shippedAt: number | null
  isDigital: boolean | null
}

export interface NormalizedEtsyReceipt {
  receiptId: string
  /** The account's shop the receipt was read from (the receipt itself carries no shop id). */
  shopId: string
  sellerUserId: string | null
  buyerUserId: string | null
  etsyStatus: EtsyReceiptStatus
  /** The status exactly as Etsy sent it. A real receipt says "Completed" where the schema says "completed". */
  etsyStatusRaw: string
  /** Etsy's state as a Nexus order status. Merge it with `mergeStatus`, never assign it. */
  status: OrderStatus
  isPaid: boolean
  isShipped: boolean
  /** Epoch seconds, as Etsy sends them. */
  createdAt: number
  updatedAt: number
  currencyCode: string
  grandTotal: NormalizedMoney
  subtotal: NormalizedMoney | null
  totalPrice: NormalizedMoney | null
  totalShipping: NormalizedMoney | null
  totalTax: NormalizedMoney | null
  totalVat: NormalizedMoney | null
  discount: NormalizedMoney | null
  giftWrap: NormalizedMoney | null
  buyer: { name: string | null; email: string | null }
  shippingAddress: {
    name: string | null; firstLine: string | null; secondLine: string | null; city: string | null
    state: string | null; zip: string | null; countryIso: string | null; formatted: string | null
  }
  lines: NormalizedEtsyLine[]
  refunds: Array<{ amount: NormalizedMoney; createdAt: number | null; status: string | null }>
  checks: {
    /**
     * Σ unit price × quantity against `total_price`. REPORTED, not refused: the relation is Etsy's
     * schema description, not yet observed on a real receipt here. null when total_price is absent.
     */
    linesMatchTotalPrice: boolean | null
    shippedLines: number
    /** Transaction ids of lines with quantity 0 (allowed by the schema; no stock effect). */
    zeroQuantityLines: string[]
    /**
     * OPTIONAL amounts Nexus could not read exactly (divisor 0, an empty currency…). Nexus stores
     * none of them in a column, so they are reported here and read as null — never a reason to
     * refuse the order. The stored amounts (grandtotal, line prices) are still refused.
     */
    unreadableMoney: Array<{ path: string; code: EtsyReceiptRefusalCode; message: string }>
  }
}

export type EtsyReceiptNormalization =
  | { ok: true; receipt: NormalizedEtsyReceipt }
  | { ok: false; refusal: EtsyReceiptRefusal }

/**
 * What the receipt must be bound to. All three come from Nexus, never from the receipt.
 *
 * `sellerUserId` is the connection's `externalAccountId`, which for Etsy is the seller's USER id
 * (for example user 900000001, shop 10000001). It is compared with `seller_user_id`; the
 * shop id is not, because the receipt has no shop field — the shop binding is the account's
 * verified shop, the one the receipt path was built from, and any shop an event claimed.
 */
export interface EtsyReceiptBinding {
  shopId: string
  sellerUserId: string
  /** The shop a webhook named (`shop_id`), when the read was triggered by one. */
  claimedShopId?: string | null
  /** The receipt a webhook named, when there was one. */
  expectedReceiptId?: string | null
}

class Refused extends Error {
  constructor(readonly refusal: EtsyReceiptRefusal) { super(refusal.message) }
}
const refuse = (code: EtsyReceiptRefusalCode, path: string, message: string): never => {
  throw new Refused({ code, path, message })
}

const CANONICAL_ID = /^[1-9]\d*$/
const isCanonicalId = (value: unknown): value is string =>
  typeof value === 'string' && CANONICAL_ID.test(value) && Number.isSafeInteger(Number(value))

/**
 * A positive safe integer id → its canonical decimal string. `optional` allows null/absent;
 * `zeroIsNull` reads 0 as absent, for the one id whose schema minimum is 0 (listing_id).
 */
function id(value: unknown, path: string, optional: boolean, zeroIsNull = false): string | null {
  if (zeroIsNull && value === 0) return null
  if (value === null || value === undefined) {
    if (optional) return null
    return refuse(path === 'receipt_id' ? 'receipt_id_invalid' : 'id_invalid', path, `Etsy sent no ${path}.`)
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    return refuse(path === 'receipt_id' ? 'receipt_id_invalid' : 'id_invalid', path, `Etsy's ${path} is not a positive whole number.`)
  }
  return String(value)
}

function timestamp(value: unknown, path: string, optional: boolean): number | null {
  if (value === null || value === undefined) {
    if (optional) return null
    return refuse('timestamp_invalid', path, `Etsy sent no ${path}.`)
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < MIN_TIMESTAMP) {
    return refuse('timestamp_invalid', path, `Etsy's ${path} is not an epoch-seconds time.`)
  }
  return value
}

/** Etsy sends both spellings (`created_timestamp` and the older `create_timestamp`). They must agree. */
function eitherTimestamp(record: Record<string, unknown>, current: string, legacy: string, path: string, optional: boolean): number | null {
  const a = timestamp(record[current], `${path}${current}`, true)
  const b = timestamp(record[legacy], `${path}${legacy}`, true)
  if (a !== null && b !== null && a !== b) refuse('timestamp_invalid', `${path}${current}`, `Etsy's ${path}${current} and ${path}${legacy} disagree.`)
  const value = a ?? b
  if (value === null && !optional) refuse('timestamp_invalid', `${path}${current}`, `Etsy sent no ${path}${current}.`)
  return value
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const flag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)

/** Hundredths as an exact two-place decimal string. Integer arithmetic only. */
export function centsToDecimal(cents: bigint): string {
  const sign = cents < 0n ? '-' : ''
  const abs = cents < 0n ? -cents : cents
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`
}

/**
 * One Etsy Money object → an exact decimal, or a refusal.
 *
 * `amount` must be a whole, non-negative JSON number (the schema's int64): a string — "1999" or
 * "19.99" alike — is refused, because it is not what Etsy documents and accepting it would mean
 * guessing its unit. `divisor` must be 1, 10 or 100 so that the value fits two decimal places
 * exactly; 1000 (three decimals) would need rounding, which on money is a refusal, not a choice.
 */
export function normalizeEtsyMoney(value: unknown, path: string, limit: bigint = RECEIPT_MONEY_LIMIT): NormalizedMoney {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse('money_invalid', path, `Etsy's ${path} is not a money object.`)
  const { amount, divisor, currency_code: currency } = value as Record<string, unknown>
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) {
    return refuse('money_invalid', path, `Etsy's ${path}.amount is not a whole, non-negative number of minor units.`)
  }
  if (typeof divisor !== 'number' || !EXACT_DIVISORS.has(divisor)) {
    return refuse('money_divisor_unsupported', path, `Etsy's ${path}.divisor (${String(divisor)}) cannot be stored exactly with two decimals.`)
  }
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    return refuse('money_invalid', path, `Etsy's ${path}.currency_code is not a three-letter currency code.`)
  }
  const cents = BigInt(amount) * (100n / BigInt(divisor))
  if (cents >= limit) return refuse('money_exceeds_column', path, `Etsy's ${path} is larger than Nexus can store for it.`)
  return { decimal: centsToDecimal(cents), cents, amount, divisor: divisor as 1 | 10 | 100, currencyCode: currency }
}

/** Etsy's receipt state as a Nexus order status (see `mergeStatus` for how it may change a stored one). */
export function mapEtsyStatus(status: EtsyReceiptStatus, isShipped: boolean, lines: ReadonlyArray<{ shippedAt: number | null }>): OrderStatus {
  switch (status) {
    case 'open':
    case 'payment processing':
      return 'AWAITING_PAYMENT'
    case 'canceled':
      return 'CANCELLED'
    case 'fully refunded':
      return 'REFUNDED'
    case 'completed':
      // "The order has been shipped and is considered complete." (Definitions → Order Status Values)
      return 'SHIPPED'
    case 'paid':
    case 'partially refunded': {
      // A partial refund keeps the fulfilment state underneath it.
      const shipped = lines.filter((line) => line.shippedAt !== null).length
      if (isShipped || (lines.length > 0 && shipped === lines.length)) return 'SHIPPED'
      if (shipped > 0) return 'PARTIALLY_SHIPPED'
      return 'PROCESSING'
    }
  }
}

/**
 * How far along an order is. A stored status only ever moves UP this order; ties keep what is
 * stored. Terminal states sit above every fulfilment state, so a stale poll or a late webhook can
 * never walk a SHIPPED order back to PROCESSING, or un-cancel one (the O.7 guard's rule, applied
 * to every pair instead of terminal ones only). REFUNDED outranks CANCELLED: a cancelled order is
 * refunded, and a refunded one stays refunded.
 */
export const ORDER_STATUS_RANK: Readonly<Record<OrderStatus, number>> = {
  PENDING: 0,
  AWAITING_PAYMENT: 1,
  PROCESSING: 2,
  ON_HOLD: 2,
  PARTIALLY_SHIPPED: 3,
  SHIPPED: 4,
  DELIVERED: 5,
  RETURNED: 6,
  CANCELLED: 7,
  REFUNDED: 8,
}

/** The status to store when the channel reports `incoming` for an order stored as `existing`. */
export function mergeStatus(existing: OrderStatus | null | undefined, incoming: OrderStatus): OrderStatus {
  if (!existing) return incoming
  return ORDER_STATUS_RANK[incoming] > ORDER_STATUS_RANK[existing] ? incoming : existing
}

const PAID_STATUSES: ReadonlySet<EtsyReceiptStatus> = new Set(['paid', 'completed', 'partially refunded', 'fully refunded'])

function normalizeLines(raw: unknown, receiptId: string, binding: EtsyReceiptBinding, unreadable: Unreadable): NormalizedEtsyLine[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) return refuse('transactions_invalid', 'transactions', "Etsy's transactions is not a list.")
  const seen = new Set<string>()
  return raw.map((entry: unknown, index): NormalizedEtsyLine => {
    const path = `transactions[${index}]`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return refuse('transactions_invalid', path, `Etsy's ${path} is not a transaction.`)
    const t = entry as Record<string, unknown>
    const transactionId = id(t.transaction_id, `${path}.transaction_id`, false) as string
    if (seen.has(transactionId)) refuse('duplicate_transaction', `${path}.transaction_id`, `Etsy's receipt lists transaction ${transactionId} twice.`)
    seen.add(transactionId)
    const lineReceipt = id(t.receipt_id, `${path}.receipt_id`, true)
    if (lineReceipt !== receiptId) refuse('transaction_receipt_mismatch', `${path}.receipt_id`, `Etsy's ${path} does not belong to receipt ${receiptId}.`)
    const lineSeller = id(t.seller_user_id, `${path}.seller_user_id`, true)
    if (lineSeller !== null && lineSeller !== binding.sellerUserId) refuse('seller_mismatch', `${path}.seller_user_id`, `Etsy's ${path} was sold by a different Etsy user from this account.`)
    const quantity = t.quantity
    if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 0 || quantity > ETSY_MAX_LINE_QUANTITY) {
      refuse('quantity_invalid', `${path}.quantity`, `Etsy's ${path}.quantity is not a whole number from 0 to ${ETSY_MAX_LINE_QUANTITY}.`)
    }
    if (t.price === undefined || t.price === null) refuse('money_missing', `${path}.price`, `Etsy sent no price for ${path}.`)
    const unitPrice = normalizeEtsyMoney(t.price, `${path}.price`, LINE_MONEY_LIMIT)
    const lineCents = unitPrice.cents * BigInt(quantity as number)
    if (lineCents >= RECEIPT_MONEY_LIMIT) refuse('money_exceeds_column', `${path}.price`, `Etsy's ${path} total is larger than Nexus can store for it.`)
    return {
      transactionId,
      listingId: id(t.listing_id, `${path}.listing_id`, true, true),
      etsyProductId: id(t.product_id, `${path}.product_id`, true),
      sku: text(t.sku),
      title: text(t.title),
      quantity: quantity as number,
      stockEligible: (quantity as number) > 0,
      unitPrice,
      lineTotal: centsToDecimal(lineCents),
      shippingCost: optionalMoney(t.shipping_cost, `${path}.shipping_cost`, unreadable, LINE_MONEY_LIMIT),
      paidAt: timestamp(t.paid_timestamp, `${path}.paid_timestamp`, true),
      shippedAt: timestamp(t.shipped_timestamp, `${path}.shipped_timestamp`, true),
      isDigital: flag(t.is_digital),
    }
  })
}

type Unreadable = NormalizedEtsyReceipt['checks']['unreadableMoney']

/** An amount Nexus never stores in a column: absent or unreadable reads as null; unreadable is reported. */
function optionalMoney(value: unknown, path: string, unreadable: Unreadable, limit: bigint = RECEIPT_MONEY_LIMIT): NormalizedMoney | null {
  if (value === undefined || value === null) return null
  try {
    return normalizeEtsyMoney(value, path, limit)
  } catch (error) {
    if (!(error instanceof Refused)) throw error
    unreadable.push({ path: error.refusal.path, code: error.refusal.code, message: error.refusal.message })
    return null
  }
}

function normalize(input: unknown, binding: EtsyReceiptBinding): NormalizedEtsyReceipt {
  if (!binding || !isCanonicalId(binding.shopId) || !isCanonicalId(binding.sellerUserId)) {
    return refuse('binding_invalid', 'binding', 'The Etsy account has no verified shop and seller identity to check this receipt against.')
  }
  if (binding.claimedShopId !== undefined && binding.claimedShopId !== null && binding.claimedShopId !== binding.shopId) {
    refuse('shop_mismatch', 'shop_id', 'The event names a different Etsy shop from its connected account.')
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return refuse('not_a_receipt', 'receipt', 'Etsy did not return a receipt object.')
  const r = input as Record<string, unknown>

  const receiptId = id(r.receipt_id, 'receipt_id', false) as string
  if (binding.expectedReceiptId !== undefined && binding.expectedReceiptId !== null && binding.expectedReceiptId !== receiptId) {
    refuse('receipt_id_mismatch', 'receipt_id', `Etsy returned receipt ${receiptId} for a request about receipt ${binding.expectedReceiptId}.`)
  }
  const sellerUserId = id(r.seller_user_id, 'seller_user_id', true)
  if (sellerUserId !== null && sellerUserId !== binding.sellerUserId) {
    refuse('seller_mismatch', 'seller_user_id', 'The receipt was sold by a different Etsy user from this account.')
  }
  const buyerUserId = id(r.buyer_user_id, 'buyer_user_id', true)

  // Read without regard to case or surrounding space: a real getShopReceipt answer says
  // "Completed" (etsy/open-api discussion #1356) where the schema's enum says "completed".
  const statusKey = typeof r.status === 'string' ? r.status.trim().toLowerCase() : null
  if (statusKey === null || !(ETSY_RECEIPT_STATUSES as readonly string[]).includes(statusKey)) {
    refuse('status_unknown', 'status', `Etsy's receipt status ${JSON.stringify(typeof r.status === 'string' ? r.status : null)} is not one Nexus knows.`)
  }
  const etsyStatus = statusKey as EtsyReceiptStatus
  const createdAt = eitherTimestamp(r, 'created_timestamp', 'create_timestamp', '', false) as number
  const updatedAt = eitherTimestamp(r, 'updated_timestamp', 'update_timestamp', '', false) as number
  if (createdAt > updatedAt) refuse('created_after_updated', 'updated_timestamp', "Etsy's receipt was updated before it was created.")

  const isPaid = r.is_paid === true
  const isShipped = r.is_shipped === true
  const unreadable: Unreadable = []
  const lines = normalizeLines(r.transactions, receiptId, binding, unreadable)
  if (lines.length === 0 && (isPaid || PAID_STATUSES.has(etsyStatus))) {
    refuse('paid_without_transactions', 'transactions', 'Etsy says this receipt is paid but lists nothing that was bought.')
  }

  if (r.grandtotal === undefined || r.grandtotal === null) refuse('money_missing', 'grandtotal', 'Etsy sent no grandtotal.')
  const grandTotal = normalizeEtsyMoney(r.grandtotal, 'grandtotal')
  const totals = {
    subtotal: optionalMoney(r.subtotal, 'subtotal', unreadable),
    totalPrice: optionalMoney(r.total_price, 'total_price', unreadable),
    totalShipping: optionalMoney(r.total_shipping_cost, 'total_shipping_cost', unreadable),
    totalTax: optionalMoney(r.total_tax_cost, 'total_tax_cost', unreadable),
    totalVat: optionalMoney(r.total_vat_cost, 'total_vat_cost', unreadable),
    discount: optionalMoney(r.discount_amt, 'discount_amt', unreadable),
    giftWrap: optionalMoney(r.gift_wrap_price, 'gift_wrap_price', unreadable),
  }
  // Refunds are reported, not stored: the receipt's status says whether it was refunded.
  let rawRefunds: unknown[] = []
  if (Array.isArray(r.refunds)) rawRefunds = r.refunds
  else if (r.refunds !== undefined && r.refunds !== null) unreadable.push({ path: 'refunds', code: 'money_invalid', message: "Etsy's refunds is not a list." })
  const refunds = rawRefunds.flatMap((refund, index) => {
    const entry = (refund && typeof refund === 'object' ? refund : {}) as Record<string, unknown>
    const path = `refunds[${index}].amount`
    if (entry.amount === undefined || entry.amount === null) {
      unreadable.push({ path, code: 'money_missing', message: `Etsy sent no amount for refunds[${index}].` })
      return []
    }
    const amount = optionalMoney(entry.amount, path, unreadable)
    return amount ? [{ amount, createdAt: timestamp(entry.created_timestamp, `refunds[${index}].created_timestamp`, true), status: text(entry.status) }] : []
  })

  // One currency per receipt: every money object on it, lines and refunds included.
  const monies: Array<[string, NormalizedMoney | null]> = [
    ['grandtotal', grandTotal],
    ...Object.entries(totals),
    ...lines.flatMap((line, i): Array<[string, NormalizedMoney | null]> => [[`transactions[${i}].price`, line.unitPrice], [`transactions[${i}].shipping_cost`, line.shippingCost]]),
    ...refunds.map((refund, i): [string, NormalizedMoney] => [`refunds[${i}].amount`, refund.amount]),
  ]
  for (const [path, money] of monies) {
    if (money && money.currencyCode !== grandTotal.currencyCode) {
      refuse('money_currency_mixed', path, `Etsy's ${path} is in ${money.currencyCode}, the receipt in ${grandTotal.currencyCode}.`)
    }
  }

  const linesCents = lines.reduce((sum, line) => sum + line.unitPrice.cents * BigInt(line.quantity), 0n)
  return {
    receiptId,
    shopId: binding.shopId,
    sellerUserId,
    buyerUserId,
    etsyStatus,
    etsyStatusRaw: r.status as string,
    status: mapEtsyStatus(etsyStatus, isShipped, lines),
    isPaid,
    isShipped,
    createdAt,
    updatedAt,
    currencyCode: grandTotal.currencyCode,
    grandTotal,
    ...totals,
    buyer: { name: text(r.name), email: text(r.buyer_email) },
    shippingAddress: {
      name: text(r.name), firstLine: text(r.first_line), secondLine: text(r.second_line), city: text(r.city),
      state: text(r.state), zip: text(r.zip), countryIso: text(r.country_iso), formatted: text(r.formatted_address),
    },
    lines,
    refunds,
    checks: {
      linesMatchTotalPrice: totals.totalPrice ? totals.totalPrice.cents === linesCents : null,
      shippedLines: lines.filter((line) => line.shippedAt !== null).length,
      zeroQuantityLines: lines.filter((line) => !line.stockEligible).map((line) => line.transactionId),
      unreadableMoney: unreadable,
    },
  }
}

/** A receipt Etsy returned, checked against the account it was read for. Never throws for bad input. */
export function normalizeEtsyReceipt(input: EtsyReceipt | unknown, binding: EtsyReceiptBinding): EtsyReceiptNormalization {
  try {
    return { ok: true, receipt: normalize(input, binding) }
  } catch (error) {
    if (error instanceof Refused) return { ok: false, refusal: error.refusal }
    throw error
  }
}
