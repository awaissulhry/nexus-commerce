/**
 * CX A1 — exact money mapping for Amazon Finances 2024-06-19 transactions. Pure: no I/O.
 *
 * Official model: amzn/selling-partner-api-models, models/finances-api-model/finances_2024-06-19.json.
 * A `Transaction` has a `transactionId`, a `transactionType` (documented value: `Shipment`), a
 * `transactionStatus` (DEFERRED | RELEASED | DEFERRED_RELEASED — a deferred transaction's status is
 * updated to DEFERRED_RELEASED when released), `relatedIdentifiers` and a recursive tree of
 * `breakdowns`, each `{ breakdownType, breakdownAmount: { currencyAmount, currencyCode }, breakdowns }`.
 *
 * Every result is either a row in INTEGER MINOR UNITS or a named refusal. Nothing is guessed:
 * - only `Shipment` → `Order` and `Refund` → `Refund` become rows; other types are counted;
 * - one currency per transaction, from a per-currency decimal-places table; an unlisted currency is
 *   refused rather than assumed to have two decimals;
 * - amounts are exact decimals (BigInt), never floats; sub-minor-unit precision is refused, and a JSON
 *   number with more than 15 significant digits is refused because JSON.parse may already have
 *   rounded it (every decimal of ≤ 15 significant digits round-trips through a double exactly);
 * - every breakdown's children must sum to it, and the top-level breakdowns to `totalAmount`;
 * - a breakdown path not in the evidenced vocabulary below is refused, never folded into a column.
 *
 * Identity: a row is keyed by `transactionId` regardless of status; a later status for the same id
 * updates that row in place. A transaction that carries DEFERRED_TRANSACTION_ID is the release
 * record of another (deferred) transaction; its money is already the deferred original's, so it is
 * counted and never written — counting both would book the same sale twice.
 */

export const FINANCES_2024_SCHEME = 'AMAZON_FINANCES_2024' as const

/** ISO 4217 decimal places for the currencies Amazon marketplaces settle in. */
export const CURRENCY_MINOR_UNITS: Readonly<Record<string, number>> = Object.freeze({
  EUR: 2, GBP: 2, USD: 2, CAD: 2, MXN: 2, BRL: 2, SEK: 2, PLN: 2, TRY: 2, EGP: 2,
  SAR: 2, AED: 2, INR: 2, AUD: 2, SGD: 2, ZAR: 2, JPY: 0,
})

export const TRANSACTION_STATUSES = ['DEFERRED', 'RELEASED', 'DEFERRED_RELEASED'] as const
export type TransactionStatus = typeof TRANSACTION_STATUSES[number]

/** Where a leaf breakdown's money goes. Fees are signed as Amazon sends them (negative = charge). */
export type LeafCategory = 'principal' | 'shipping' | 'tax' | 'promotion' | 'commission' | 'fbaFee' | 'otherFee'

/**
 * The evidenced breakdown vocabulary, by full path. Only paths that appear in the official model are
 * listed (the transaction example's `Sales > Product Charges`, the item example's
 * `Product Charges > Principle` — Amazon's spelling). Amazon documents no breakdownType enumeration,
 * so anything else is refused until a measured census adds it here by review.
 * A listed path with children is validated through its children; as a leaf it maps to its category.
 */
export const TRANSACTION_BREAKDOWN_PATHS: Readonly<Record<string, LeafCategory | 'group'>> = Object.freeze({
  'Sales': 'group',
  'Sales > Product Charges': 'principal',
  'Sales > Product Charges > Principle': 'principal',
})
export const ITEM_BREAKDOWN_PATHS: Readonly<Record<string, LeafCategory | 'group'>> = Object.freeze({
  'Product Charges': 'principal',
  'Product Charges > Principle': 'principal',
})

export type Finances2024Refusal =
  | 'missing_transaction_id' | 'missing_transaction_type' | 'unknown_status'
  | 'missing_posted_date' | 'invalid_posted_date'
  | 'malformed_related_identifiers' | 'missing_order_id' | 'ambiguous_order_id' | 'ambiguous_deferral_links'
  | 'missing_total' | 'malformed_breakdowns' | 'missing_breakdowns'
  | 'unknown_currency' | 'mixed_currency'
  | 'invalid_amount' | 'sub_minor_unit' | 'precision_unverifiable' | 'amount_out_of_range'
  | 'child_sum_mismatch' | 'total_sum_mismatch' | 'item_sum_mismatch'
  | 'unknown_breakdown' | 'unexpected_sign'

export interface Finances2024Money {
  amount: bigint; grossRevenue: bigint; netRevenue: bigint
  amazonFee: bigint; fbaFee: bigint; otherFees: bigint; paymentServicesFee: bigint
  /** The provider's totalAmount, for the record; not a v0 column. */
  total: bigint
}

export interface Finances2024Row {
  scheme: typeof FINANCES_2024_SCHEME
  providerTransactionId: string
  providerType: 'Shipment' | 'Refund'
  transactionType: 'Order' | 'Refund'
  transactionStatus: TransactionStatus
  /** FinancialTransaction.status: a deferred transaction is not yet Completed. */
  status: 'Pending' | 'Completed'
  amazonOrderId: string
  postedAt: Date
  currencyCode: string
  minorUnits: number
  money: Finances2024Money
  releaseTransactionId?: string
  marketplaceId?: string
}

interface Common { transactionType: string | null; transactionStatus: string | null; paths: string[] }
/** Internal equality key for validated monetary observations; never included in the census/logs. */
interface ValidatedMoney { moneyFingerprint: string }
export type Finances2024Mapping =
  | (Common & ValidatedMoney & { kind: 'row'; row: Finances2024Row })
  | (Common & ValidatedMoney & { kind: 'counted'; reason: 'unmapped_type' | 'deferral_release_record' })
  | (Common & { kind: 'refused'; reason: Finances2024Refusal })

class Refusal extends Error { constructor(readonly reason: Finances2024Refusal) { super(reason) } }
const refuse = (reason: Finances2024Refusal): never => { throw new Refusal(reason) }
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Column limits: Decimal(12,2) for amount/revenue, Decimal(10,2) for fee columns, in hundredths. */
const MAX_AMOUNT_HUNDREDTHS = 999_999_999_999n
const MAX_FEE_HUNDREDTHS = 9_999_999_999n
const MAX_DEPTH = 8

/**
 * An exact decimal for a provider amount. A JS number is read through its shortest round-trip
 * string; beyond 15 significant digits that string may not be what Amazon sent, so it is refused.
 */
export function exactDecimal(value: unknown): { digits: bigint; scale: number } {
  let text: string
  let fromNumber = false
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) refuse('invalid_amount')
    text = Object.is(value, -0) ? '0' : String(value)
    fromNumber = true
  } else if (typeof value === 'string') {
    text = value
  } else return refuse('invalid_amount')
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text)
  if (!match || (!fromNumber && match[4] !== undefined)) refuse('invalid_amount')
  const [, sign, whole, fraction = '', exponent = '0'] = match!
  const mantissa = (whole + fraction).replace(/^0+/, '')
  if (fromNumber && mantissa.replace(/0+$/, '').length > 15) refuse('precision_unverifiable')
  let digits = BigInt(whole + fraction || '0')
  let scale = fraction.length - Number(exponent)
  if (scale < 0) { digits *= 10n ** BigInt(-scale); scale = 0 }
  while (scale > 0 && digits % 10n === 0n) { digits /= 10n; scale-- }
  return { digits: sign === '-' ? -digits : digits, scale }
}

/** Integer minor units of `value` for a currency with `places` decimals; sub-unit precision is refused. */
export function toMinorUnits(value: unknown, places: number): bigint {
  const { digits, scale } = exactDecimal(value)
  if (scale > places) refuse('sub_minor_unit')
  return digits * 10n ** BigInt(places - scale)
}

/** A minor-unit amount as the decimal text a numeric column stores. */
export function minorToDecimal(minor: bigint, places: number): string {
  const negative = minor < 0n
  const text = (negative ? -minor : minor).toString().padStart(places + 1, '0')
  const whole = places ? text.slice(0, -places) : text
  return `${negative ? '-' : ''}${whole}${places ? `.${text.slice(-places)}` : ''}`
}

/** Minor units rescaled to the hundredths the FinancialTransaction numeric(…,2) columns hold. */
export function toHundredths(minor: bigint, places: number): bigint {
  if (places > 2) throw new Error('A currency with more than two decimals cannot be stored in these columns.')
  return minor * 10n ** BigInt(2 - places)
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/

function readInstant(value: unknown): Date {
  if (value === undefined || value === null || value === '') return refuse('missing_posted_date')
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return refuse('invalid_posted_date')
  const at = new Date(value)
  if (!Number.isFinite(at.getTime())) refuse('invalid_posted_date')
  return at
}

function nonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.trim() === value && value.length <= 255
}

interface Links { orderIds: string[]; deferred: string[]; release: string[] }
function readLinks(related: unknown): Links {
  if (related === undefined) return { orderIds: [], deferred: [], release: [] }
  if (!Array.isArray(related)) return refuse('malformed_related_identifiers')
  const links: Links = { orderIds: [], deferred: [], release: [] }
  for (const id of related) {
    if (!isObject(id) || !nonblank(id.relatedIdentifierName) || !nonblank(id.relatedIdentifierValue)) refuse('malformed_related_identifiers')
    const value = (id as { relatedIdentifierValue: string }).relatedIdentifierValue
    switch ((id as { relatedIdentifierName: string }).relatedIdentifierName) {
      case 'ORDER_ID': links.orderIds.push(value); break
      case 'DEFERRED_TRANSACTION_ID': links.deferred.push(value); break
      case 'RELEASE_TRANSACTION_ID': links.release.push(value); break
    }
  }
  const distinct = (values: string[]) => [...new Set(values)]
  return { orderIds: distinct(links.orderIds), deferred: distinct(links.deferred), release: distinct(links.release) }
}

interface Walk { currency: string | null; places: number; paths: string[]; leaves: Array<{ path: string; minor: bigint }> }

function readMoney(money: unknown, walk: Walk): bigint {
  if (!isObject(money)) return refuse('malformed_breakdowns')
  const code = money.currencyCode
  if (typeof code !== 'string' || !/^[A-Z]{3}$/.test(code)) return refuse('unknown_currency')
  if (walk.currency === null) {
    const places = CURRENCY_MINOR_UNITS[code]
    if (places === undefined) refuse('unknown_currency')
    walk.currency = code
    walk.places = places
  } else if (walk.currency !== code) refuse('mixed_currency')
  return toMinorUnits(money.currencyAmount, walk.places)
}

/** Validates a breakdown list (children sum to each parent) and returns the list's exact sum. */
function walkBreakdowns(list: unknown, prefix: string, depth: number, walk: Walk): bigint {
  if (!Array.isArray(list) || depth > MAX_DEPTH) return refuse('malformed_breakdowns')
  let sum = 0n
  for (const node of list) {
    if (!isObject(node) || !nonblank(node.breakdownType) || (node.breakdowns !== undefined && !Array.isArray(node.breakdowns))) refuse('malformed_breakdowns')
    const path = prefix ? `${prefix} > ${node.breakdownType as string}` : node.breakdownType as string
    walk.paths.push(path)
    const amount = readMoney(node.breakdownAmount, walk)
    const children = (node.breakdowns ?? []) as unknown[]
    if (children.length) {
      if (walkBreakdowns(children, path, depth + 1, walk) !== amount) refuse('child_sum_mismatch')
    } else walk.leaves.push({ path, minor: amount })
    sum += amount
  }
  return sum
}

function classify(leaves: Walk['leaves'], vocabulary: Readonly<Record<string, LeafCategory | 'group'>>): Record<LeafCategory, bigint> {
  const totals: Record<LeafCategory, bigint> = { principal: 0n, shipping: 0n, tax: 0n, promotion: 0n, commission: 0n, fbaFee: 0n, otherFee: 0n }
  for (const leaf of leaves) {
    const category = vocabulary[leaf.path]
    if (category === undefined) refuse('unknown_breakdown')
    if (category === 'group') { if (leaf.minor !== 0n) refuse('unknown_breakdown'); continue }
    totals[category as LeafCategory] += leaf.minor
  }
  return totals
}

function withinColumns(money: Finances2024Money, places: number) {
  const abs = (v: bigint) => (v < 0n ? -v : v)
  for (const key of ['amount', 'grossRevenue', 'netRevenue'] as const) if (abs(toHundredths(money[key], places)) > MAX_AMOUNT_HUNDREDTHS) refuse('amount_out_of_range')
  for (const key of ['amazonFee', 'fbaFee', 'otherFees', 'paymentServicesFee'] as const) if (abs(toHundredths(money[key], places)) > MAX_FEE_HUNDREDTHS) refuse('amount_out_of_range')
}

/** Exact amounts by breakdown path, independent of list order or decimal spelling. */
function leafMoney(leaves: Walk['leaves']) {
  const totals = new Map<string, bigint>()
  for (const { path, minor } of leaves) totals.set(path, (totals.get(path) ?? 0n) + minor)
  return [...totals].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, minor]) => [path, minor.toString()])
}

/** Preserve money's association with stable item identifiers, independent of identifier order. */
function itemIdentity(related: unknown): string[] {
  if (related === undefined) return []
  if (!Array.isArray(related)) return refuse('malformed_related_identifiers')
  const identifiers = new Set<string>()
  for (const id of related) {
    if (!isObject(id) || !nonblank(id.itemRelatedIdentifierName) || !nonblank(id.itemRelatedIdentifierValue)) refuse('malformed_related_identifiers')
    identifiers.add(JSON.stringify([id.itemRelatedIdentifierName, id.itemRelatedIdentifierValue]))
  }
  return [...identifiers].sort()
}

/**
 * Validates every monetary part of a transaction and returns its money context. Shared by written and
 * counted types, so a census reports invariant failures for every transaction it sees.
 */
function validateMoney(tx: Record<string, unknown>, paths: string[]) {
  const walk: Walk = { currency: null, places: 2, paths, leaves: [] }
  if (tx.totalAmount === undefined || tx.totalAmount === null) refuse('missing_total')
  const total = readMoney(tx.totalAmount, walk)
  const hasBreakdowns = !(tx.breakdowns === undefined || tx.breakdowns === null || (Array.isArray(tx.breakdowns) && tx.breakdowns.length === 0))
  if (hasBreakdowns && walkBreakdowns(tx.breakdowns, '', 0, walk) !== total) refuse('total_sum_mismatch')
  // Items describe the same money line by line: validated, never added to the transaction's columns.
  const itemLeaves: Walk['leaves'] = []
  const itemMoney: string[] = []
  if (tx.items !== undefined) {
    if (!Array.isArray(tx.items)) refuse('malformed_breakdowns')
    for (const item of tx.items as unknown[]) {
      if (!isObject(item)) return refuse('malformed_breakdowns')
      const identity = itemIdentity(item.relatedIdentifiers)
      const itemTotal = item.totalAmount === undefined ? null : readMoney(item.totalAmount, walk)
      if (item.breakdowns === undefined) { itemMoney.push(JSON.stringify([identity, itemTotal?.toString() ?? null, []])); continue }
      const itemWalk: Walk = { currency: walk.currency, places: walk.places, paths: [], leaves: [] }
      const itemSum = walkBreakdowns(item.breakdowns, '', 0, itemWalk)
      if (itemTotal !== null && (item.breakdowns as unknown[]).length && itemSum !== itemTotal) refuse('item_sum_mismatch')
      itemMoney.push(JSON.stringify([identity, itemTotal?.toString() ?? null, leafMoney(itemWalk.leaves)]))
      itemLeaves.push(...itemWalk.leaves)
      paths.push(...itemWalk.paths.map(path => `item: ${path}`))
    }
  }
  // Parent sums are already verified, so leaves retain every component without counting money twice.
  const moneyFingerprint = JSON.stringify([walk.currency, total.toString(), leafMoney(walk.leaves), itemMoney.sort()])
  return { walk, total, hasBreakdowns, itemLeaves, moneyFingerprint }
}

/** Map one provider transaction. Never throws for provider data; a refusal is a value. */
export function mapFinances2024(input: unknown): Finances2024Mapping {
  const tx = isObject(input) ? input : {}
  const transactionType = typeof tx.transactionType === 'string' ? tx.transactionType : null
  const transactionStatus = typeof tx.transactionStatus === 'string' ? tx.transactionStatus : null
  const paths: string[] = []
  const common = { transactionType, transactionStatus, paths }
  try {
    if (!isObject(input)) refuse('missing_transaction_id')
    if (!nonblank(tx.transactionId)) refuse('missing_transaction_id')
    if (!nonblank(transactionType)) refuse('missing_transaction_type')
    if (!TRANSACTION_STATUSES.includes(transactionStatus as TransactionStatus)) refuse('unknown_status')
    const postedAt = readInstant(tx.postedDate)
    const links = readLinks(tx.relatedIdentifiers)
    const { walk, total, hasBreakdowns, itemLeaves, moneyFingerprint } = validateMoney(tx, paths)
    const written = transactionType === 'Shipment' ? 'Order' : transactionType === 'Refund' ? 'Refund' : null
    if (!written) return { ...common, moneyFingerprint, kind: 'counted', reason: 'unmapped_type' }
    if (links.deferred.length && links.release.length) refuse('ambiguous_deferral_links')
    if (links.deferred.length > 1 || links.release.length > 1) refuse('ambiguous_deferral_links')
    if (links.orderIds.length === 0) refuse('missing_order_id')
    if (links.orderIds.length > 1) refuse('ambiguous_order_id')
    if (links.deferred.length) return { ...common, moneyFingerprint, kind: 'counted', reason: 'deferral_release_record' }
    if (!hasBreakdowns) refuse('missing_breakdowns')
    const leaf = classify(walk.leaves, TRANSACTION_BREAKDOWN_PATHS)
    classify(itemLeaves, ITEM_BREAKDOWN_PATHS)
    // A sale's principal is not negative and its fees are charges; a refund's principal is not
    // positive and its fees are refunded. Either sign reversed is a transaction this mapping does
    // not understand — the fee columns hold magnitudes, so storing it would invert its meaning.
    const sale = written === 'Order'
    if (sale ? leaf.principal < 0n : leaf.principal > 0n) refuse('unexpected_sign')
    for (const fee of [leaf.commission, leaf.fbaFee, leaf.otherFee]) if (sale ? fee > 0n : fee < 0n) refuse('unexpected_sign')
    const fees = leaf.commission + leaf.fbaFee + leaf.otherFee
    const abs = (v: bigint) => (v < 0n ? -v : v)
    const grossRevenue = leaf.principal + leaf.shipping
    const money: Finances2024Money = {
      amount: grossRevenue + leaf.tax + leaf.promotion,
      grossRevenue,
      // Signed fees: a sale nets its charges off; a refund gets its refunded fees back (as v0 does).
      netRevenue: grossRevenue + fees,
      amazonFee: abs(leaf.commission), fbaFee: abs(leaf.fbaFee), otherFees: abs(leaf.otherFee), paymentServicesFee: 0n,
      total,
    }
    withinColumns(money, walk.places)
    const marketplace = isObject(tx.marketplaceDetails) && nonblank(tx.marketplaceDetails.marketplaceId) ? tx.marketplaceDetails.marketplaceId : undefined
    const status = transactionStatus as TransactionStatus
    return {
      ...common, moneyFingerprint, kind: 'row', row: {
        scheme: FINANCES_2024_SCHEME, providerTransactionId: tx.transactionId as string,
        providerType: transactionType as 'Shipment' | 'Refund', transactionType: written,
        transactionStatus: status, status: status === 'DEFERRED' ? 'Pending' : 'Completed',
        amazonOrderId: links.orderIds[0]!, postedAt, currencyCode: walk.currency!, minorUnits: walk.places, money,
        ...(links.release[0] ? { releaseTransactionId: links.release[0] } : {}),
        ...(marketplace ? { marketplaceId: marketplace } : {}),
      },
    }
  } catch (error) {
    if (error instanceof Refusal) return { ...common, kind: 'refused', reason: error.reason }
    throw error
  }
}

/** Status precedence for one transactionId seen more than once: a release supersedes a deferral. */
export function statusRank(status: string | null): number {
  return status === 'DEFERRED_RELEASED' || status === 'RELEASED' ? 2 : status === 'DEFERRED' ? 1 : 0
}

/** The in-place status move a stored row may make: only DEFERRED → released advances; any other
 *  change (released → deferred, RELEASED ↔ DEFERRED_RELEASED) is refused, never applied. */
export function statusTransition(from: string, to: string): 'same' | 'advance' | 'regression' {
  if (from === to) return 'same'
  return statusRank(to) > statusRank(from) ? 'advance' : 'regression'
}
