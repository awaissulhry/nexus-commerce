/**
 * Amazon Financial Events Ingestion (Phase 2A — Financial)
 *
 * Pulls /finances/v0/financialEvents by date range, matches each
 * OrderFinancialEvent.AmazonOrderId to an existing Order row, and
 * writes a summary FinancialTransaction per order.
 *
 * One FinancialTransaction row per Amazon order event:
 *   - transactionType: 'Order'   → principal charges
 *   - transactionType: 'Refund'  → refund events (separate row)
 *
 * Idempotency: checks (orderId, transactionType, amazonTransactionId)
 * before inserting — safe to re-run over the same date window.
 *
 * Rate limits:
 *   listFinancialEvents: 0.5 req/s (restore_rate 2)
 *   Call with 30-day chunks. Daily cron uses yesterday window.
 */

import prisma from '../db.js'
import {
  AmazonService,
  type AmazonOrderFinancialEvent,
  type AmazonRefundEvent,
  type AmazonChargeComponent,
  type AmazonFeeComponent,
} from './marketplaces/amazon.service.js'
import { logger } from '../utils/logger.js'

const amazonService = new AmazonService()

function parseAmount(str: string | undefined): number {
  const n = parseFloat(str ?? '0')
  return isNaN(n) ? 0 : n
}

/** DA-RT.18 — Amazon SP-API's listFinancialEvents response uses
 *  `CurrencyAmount: number` in the v0/v1 shapes our seller account
 *  receives; older API surfaces returned `Amount: string`. Read
 *  CurrencyAmount when present, fall back to Amount otherwise. The
 *  previous `?.Amount` only access silently returned 0 for every
 *  charge/fee, producing the 231 €0 FinancialTransaction rows
 *  surfaced by DA-RT.17's diagnostic. */
function moneyOf(m: { Amount?: string | number; CurrencyAmount?: number } | undefined): number {
  if (!m) return 0
  if (typeof m.CurrencyAmount === 'number') return m.CurrencyAmount
  if (typeof m.Amount === 'number') return m.Amount
  return parseAmount(typeof m.Amount === 'string' ? m.Amount : undefined)
}

function sumCharges(list: AmazonChargeComponent[] | undefined, type: string): number {
  return (list ?? [])
    .filter(c => c.ChargeType === type)
    .reduce((s, c) => s + moneyOf(c.ChargeAmount), 0)
}

function sumFees(list: AmazonFeeComponent[] | undefined, ...types: string[]): number {
  const set = new Set(types)
  return (list ?? [])
    .filter(f => set.has(f.FeeType))
    .reduce((s, f) => s + Math.abs(moneyOf(f.FeeAmount)), 0)
}

function sumAllFees(list: AmazonFeeComponent[] | undefined): number {
  return (list ?? []).reduce((s, f) => s + Math.abs(moneyOf(f.FeeAmount)), 0)
}

interface FinancialSyncSummary {
  windowStart: string
  windowEnd: string
  orderEventsFetched: number
  refundEventsFetched: number
  ordersMatched: number
  ordersSkipped: number
  txCreated: number
  txSkipped: number
  durationMs: number
  /**
   * P5.2 dry run — true when NOTHING was written. `txCreated` is then **0**, which is
   * the truth, and `txWouldCreate` carries the count. A field named `txCreated` holding
   * a number of rows that were not created is a claim that does not match its
   * measurement, and every existing reader of `txCreated` sums writes.
   */
  dryRun?: boolean
  /** Candidate provider identities absent from the new-key lookup, not approved money writes. */
  txWouldCreate?: number
  /** Legacy API field name: counts same-order/type v0 overlap RISK, not proven duplicate amounts. */
  txWouldDuplicateV0?: number
  /** Counts above assess identity/order overlap, not equivalence of financial amounts. */
  comparisonScope?: 'identity_and_order_overlap_only'
  transactionsWithoutOrderId?: number
  unmatchedTransactions?: number
  duplicateTransactions?: number
  accountId?: string
  marketplaceId?: string | null
  /** DA-RT.17 — diagnostics: first 10 AmazonOrderIds from fetched
   *  events whose row doesn't exist in our Order table, AND first 10
   *  channelOrderIds we DO have for AMAZON orders in the same window
   *  so the operator can eyeball whether the ID format differs. */
  unmatchedSampleIds?: string[]
  ourSampleChannelOrderIds?: string[]
  /** DA-RT.17 — for each unmatched ID, whether the order exists in
   *  our DB at ANY purchaseDate. If yes, window mismatch; if no,
   *  never ingested. */
  unmatchedLookup?: Array<{
    channelOrderId: string
    existsInOurDb: boolean
    purchaseDate: string | null
    status: string | null
    totalPrice: number | null
    existingFts: Array<{
      id: string
      transactionType: string
      grossRevenue: number
      amazonTransactionId: string | null
      transactionDate: string
    }>
  }>
  rawEventSample?: unknown
}

async function processOrderEvent(event: AmazonOrderFinancialEvent): Promise<{ created: number; skipped: number }> {
  const amazonOrderId = event.AmazonOrderId
  if (!amazonOrderId) return { created: 0, skipped: 1 }

  // Find the matching Order in Nexus
  const order = await prisma.order.findFirst({
    where: { channel: 'AMAZON', channelOrderId: amazonOrderId },
    select: { id: true, currencyCode: true },
  })

  if (!order) return { created: 0, skipped: 1 }

  // Idempotency: skip if we already have an Order-type tx for this Amazon order
  const existing = await prisma.financialTransaction.findFirst({
    where: { orderId: order.id, transactionType: 'Order', amazonTransactionId: amazonOrderId },
    select: { id: true },
  })
  if (existing) return { created: 0, skipped: 1 }

  // Aggregate all item-level charges across all shipment items
  const allItemCharges = (event.ShipmentItemList ?? []).flatMap(i => i.ItemChargeList ?? [])
  const allItemFees = (event.ShipmentItemList ?? []).flatMap(i => i.ItemFeeList ?? [])
  const allOrderCharges = event.OrderChargeList ?? []
  const allOrderFees = event.OrderFeeList ?? []

  const allCharges = [...allItemCharges, ...allOrderCharges]
  const allFees = [...allItemFees, ...allOrderFees]

  // Amazon charge types: Principal, Tax, ShippingCharge, ShippingTax, GiftWrapCharge, etc.
  const principal = sumCharges(allCharges, 'Principal')
  const tax = sumCharges(allCharges, 'Tax') + sumCharges(allCharges, 'MarketplaceFacilitatorTax-Principal')
  const shippingCharge = sumCharges(allCharges, 'ShippingCharge') + sumCharges(allCharges, 'ShippingTax')
  const grossRevenue = principal + shippingCharge // pre-tax gross

  // DA-RT.19 — sum buyer-facing promotions/discounts (always negative).
  // These reduce the gross-with-tax total Amazon charged the buyer
  // (= Order.totalPrice). Without subtracting them, FinancialTransaction
  // .amount overshoots Order.totalPrice and the drift detector fires
  // a false-positive ~€4 per affected order.
  const allPromotions = (event.ShipmentItemList ?? []).flatMap(i => i.PromotionList ?? [])
  const promotionAdjustment = allPromotions.reduce(
    (s, p) => s + moneyOf(p.PromotionAmount as { Amount?: string; CurrencyAmount?: number }),
    0,
  )

  // Amazon fee types: Commission, FBAPerUnitFulfillmentFee, FBAPerOrderFulfillmentFee,
  //   FBAWeightBasedFee, ShippingChargeback, VariableClosingFee, etc.
  const fbaFee = sumFees(allFees,
    'FBAPerUnitFulfillmentFee', 'FBAPerOrderFulfillmentFee',
    'FBAWeightBasedFee', 'FBAPickAndPack',
    'FBAStorageFee', 'LowInventoryLevelFee',
  )
  const commission = sumFees(allFees, 'Commission', 'VariableClosingFee', 'FixedClosingFee')
  const otherFees = Math.max(0, sumAllFees(allFees) - fbaFee - commission)
  const totalFees = fbaFee + commission + otherFees

  const netRevenue = grossRevenue - totalFees
  const currencyCode = event.ShipmentItemList?.[0]?.ItemChargeList?.[0]?.ChargeAmount?.CurrencyCode
    ?? order.currencyCode ?? 'EUR'

  const postedDate = event.PostedDate ? new Date(event.PostedDate) : new Date()

  await prisma.financialTransaction.create({
    data: {
      amazonTransactionId: amazonOrderId,
      orderId: order.id,
      transactionType: 'Order',
      transactionDate: postedDate,
      // DA-RT.19 — amount = full gross-with-tax total Amazon charged
      // the buyer (matches Order.totalPrice). promotionAdjustment is
      // already negative so adding it subtracts the discount.
      amount: grossRevenue + tax + promotionAdjustment,
      currencyCode,
      amazonFee: commission,
      fbaFee,
      paymentServicesFee: 0,
      ebayFee: 0,
      paypalFee: 0,
      otherFees,
      grossRevenue,
      netRevenue,
      status: 'Completed',
      amazonMetadata: {
        postedDate: event.PostedDate,
        itemCount: event.ShipmentItemList?.length ?? 0,
        principal,
        tax,
        shippingCharge,
        commission,
        fbaFee,
        otherFees,
      },
    },
  })

  return { created: 1, skipped: 0 }
}

async function processRefundEvent(event: AmazonRefundEvent): Promise<{ created: number; skipped: number }> {
  const amazonOrderId = event.AmazonOrderId
  if (!amazonOrderId) return { created: 0, skipped: 1 }

  const order = await prisma.order.findFirst({
    where: { channel: 'AMAZON', channelOrderId: amazonOrderId },
    select: { id: true, currencyCode: true },
  })
  if (!order) return { created: 0, skipped: 1 }

  const existing = await prisma.financialTransaction.findFirst({
    where: { orderId: order.id, transactionType: 'Refund', amazonTransactionId: amazonOrderId },
    select: { id: true },
  })
  if (existing) return { created: 0, skipped: 1 }

  const allCharges = (event.ShipmentItemAdjustmentList ?? []).flatMap(i => i.ItemChargeAdjustmentList ?? [])
  const allFees = (event.ShipmentItemAdjustmentList ?? []).flatMap(i => i.ItemFeeAdjustmentList ?? [])

  const refundAmount = Math.abs(sumCharges(allCharges, 'Principal'))
  const refundFee = sumFees(allFees, 'RefundCommission', 'Commission')

  const currencyCode = allCharges[0]?.ChargeAmount?.CurrencyCode ?? order.currencyCode ?? 'EUR'

  await prisma.financialTransaction.create({
    data: {
      amazonTransactionId: amazonOrderId,
      orderId: order.id,
      transactionType: 'Refund',
      transactionDate: event.PostedDate ? new Date(event.PostedDate) : new Date(),
      amount: -refundAmount,
      currencyCode,
      amazonFee: refundFee,
      fbaFee: 0,
      paymentServicesFee: 0,
      ebayFee: 0,
      paypalFee: 0,
      otherFees: 0,
      grossRevenue: -refundAmount,
      netRevenue: -(refundAmount - refundFee),
      status: 'Completed',
      amazonMetadata: { postedDate: event.PostedDate, isRefund: true },
    },
  })

  return { created: 1, skipped: 0 }
}

export async function syncFinancialEvents(
  windowStart: Date,
  windowEnd: Date,
): Promise<FinancialSyncSummary> {
  const t0 = Date.now()

  if (!(await amazonService.isConfigured())) {
    throw new Error('Amazon SP-API not configured')
  }

  logger.info('[fin-events] Fetching', {
    from: windowStart.toISOString(),
    to: windowEnd.toISOString(),
  })

  const payload = await amazonService.fetchFinancialEvents(windowStart, windowEnd)

  logger.info('[fin-events] Fetched', {
    orderEvents: payload.orderEvents.length,
    refundEvents: payload.refundEvents.length,
  })

  let txCreated = 0
  let txSkipped = 0
  let ordersMatched = 0
  let ordersSkipped = 0
  // DA-RT.17 — capture per-event match/no-match for the diagnostic
  // sample so operator can eyeball whether IDs are mismatched format.
  const unmatchedIds: string[] = []

  for (const event of payload.orderEvents) {
    const r = await processOrderEvent(event)
    txCreated += r.created
    txSkipped += r.skipped
    if (r.created > 0) {
      ordersMatched++
    } else {
      ordersSkipped++
      if (event.AmazonOrderId && unmatchedIds.length < 10) {
        unmatchedIds.push(event.AmazonOrderId)
      }
    }
  }

  for (const event of payload.refundEvents) {
    const r = await processRefundEvent(event)
    txCreated += r.created
    txSkipped += r.skipped
  }

  // Pull a small sample of our own AMAZON channelOrderIds from the
  // same window so the operator can compare format side-by-side.
  const ourSample = await prisma.order.findMany({
    where: {
      channel: 'AMAZON',
      purchaseDate: { gte: windowStart, lt: windowEnd },
    },
    select: { channelOrderId: true },
    take: 10,
    orderBy: { purchaseDate: 'desc' },
  })

  // DA-RT.17 — for each unmatched ID, check whether the order exists
  // in our Order table at ANY purchaseDate, AND what FinancialTransaction
  // rows already exist for it. If existingFtCount > 0, the idempotency
  // check is the skip reason → reveals the existing rows' grossRevenue
  // for diagnosis (€0 = broken-write history; real = audit query bug).
  const unmatchedLookup = await Promise.all(
    unmatchedIds.map(async (channelOrderId) => {
      const o = await prisma.order.findFirst({
        where: { channel: 'AMAZON', channelOrderId },
        select: { id: true, purchaseDate: true, status: true, totalPrice: true },
      })
      let existingFts: Array<{
        id: string
        transactionType: string
        grossRevenue: number
        amazonTransactionId: string | null
        transactionDate: string
      }> = []
      if (o) {
        const rows = await prisma.financialTransaction.findMany({
          where: { orderId: o.id },
          select: { id: true, transactionType: true, grossRevenue: true, amazonTransactionId: true, transactionDate: true },
        })
        existingFts = rows.map((r) => ({
          id: r.id,
          transactionType: r.transactionType,
          grossRevenue: Number(r.grossRevenue),
          amazonTransactionId: r.amazonTransactionId,
          transactionDate: r.transactionDate.toISOString(),
        }))
      }
      return {
        channelOrderId,
        existsInOurDb: !!o,
        purchaseDate: o?.purchaseDate?.toISOString() ?? null,
        status: o?.status ?? null,
        totalPrice: o ? Number(o.totalPrice) : null,
        existingFts,
      }
    }),
  )

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    orderEventsFetched: payload.orderEvents.length,
    refundEventsFetched: payload.refundEvents.length,
    ordersMatched,
    ordersSkipped,
    txCreated,
    txSkipped,
    durationMs: Date.now() - t0,
    unmatchedSampleIds: unmatchedIds,
    ourSampleChannelOrderIds: ourSample.map((o) => o.channelOrderId).filter((s): s is string => !!s),
    unmatchedLookup,
    // DA-RT.17 — raw JSON of first order event, capped at 4kB so we
    // can see Amazon's actual response shape vs what our parser
    // expects. Reveals whether ItemChargeList is empty / a different
    // key name / nested differently.
    rawEventSample: payload.orderEvents[0] ? JSON.parse(JSON.stringify(payload.orderEvents[0])) : null,
  }
}

/** Convenience: sync yesterday's financial events. Used by daily cron. */
export async function syncYesterdayFinancialEvents(): Promise<FinancialSyncSummary> {
  const now = new Date()
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate()) // midnight today
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000) // midnight yesterday
  return syncFinancialEvents(start, end)
}

// ─────────────────────────────────────────────────────────────────────
// 2024-06-19 Transactions API — replacement for the deprecated v0 path
//
// Finances 2024-06-19 identifies transactions by transactionId and orders by
// relatedIdentifiers[ORDER_ID]. Its recursive monetary breakdowns do not have
// the v0 writer's semantics. This reader measures overlap only; cutover is held.
// Official model: amzn/selling-partner-api-models, finances_2024-06-19.json.

interface NewMoney {
  currencyAmount?: number
  currencyCode?: string
}
interface NewBreakdown {
  breakdownType?: string
  breakdownAmount?: NewMoney
  breakdowns?: NewBreakdown[]
}
interface NewRelatedId {
  relatedIdentifierName?: string
  relatedIdentifierValue?: string
}
interface NewTransaction {
  transactionId?: string
  transactionType?: string
  postedDate?: string
  totalAmount?: NewMoney
  description?: string
  relatedIdentifiers?: NewRelatedId[]
  breakdowns?: NewBreakdown[]
  items?: unknown[]
  contexts?: unknown[]
  marketplaceDetails?: { marketplaceId?: string; marketplaceName?: string }
}

/** Accept either observed envelope. An unreadable page is never a quiet day. */
export function readTransactionsPage(body: unknown): { transactions: NewTransaction[]; nextToken?: string } {
  const root = (body ?? {}) as Record<string, unknown>
  const payload = (root.payload ?? {}) as Record<string, unknown>

  for (const envelope of [root, payload]) {
    if (Array.isArray(envelope.transactions)) {
      if (envelope.nextToken != null && (typeof envelope.nextToken !== 'string' || !envelope.nextToken.trim())) {
        throw new Error('[fin-tx-2024] invalid nextToken; pagination completeness cannot be established.')
      }
      return {
        transactions: envelope.transactions as NewTransaction[],
        // The token travels with the list it paginates: a `payload` envelope carries
        // its own `nextToken`, and reading the root's would page the wrong thing.
        nextToken: typeof envelope.nextToken === 'string' ? envelope.nextToken : undefined,
      }
    }
  }

  throw new Error(
    '[fin-tx-2024] the response carries no transactions list in either envelope ' +
      `(root keys: ${Object.keys(root).join(', ') || 'none'}; ` +
      `payload keys: ${Object.keys(payload).join(', ') || 'none'}). ` +
      'Nothing was recorded — this is a parse failure, not a day with no transactions.',
  )
}

function transactionOrderId(tx: NewTransaction): string | undefined {
  for (const id of tx.relatedIdentifiers ?? []) {
    if (!id || typeof id !== 'object' || Array.isArray(id) ||
        typeof id.relatedIdentifierName !== 'string' || !id.relatedIdentifierName.trim() ||
        typeof id.relatedIdentifierValue !== 'string' || !id.relatedIdentifierValue.trim() ||
        id.relatedIdentifierName.trim() !== id.relatedIdentifierName || id.relatedIdentifierValue.trim() !== id.relatedIdentifierValue) {
      throw new Error('Finances transaction has a malformed related identifier.')
    }
  }
  const ids = (tx.relatedIdentifiers ?? []).filter(id => id.relatedIdentifierName === 'ORDER_ID')
    .map(id => id.relatedIdentifierValue)
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size > 1) {
    throw new Error('Finances transaction has invalid or ambiguous ORDER_ID identifiers.')
  }
  return ids[0]
}

/** Identity-only overlap assessment. No money mapping or write is implied by a candidate. */
async function assessNewTransaction(tx: NewTransaction, accountId: string, amazonOrderId?: string): Promise<{
  created: number; skipped: number; wouldDuplicateV0: number; orderId?: string;
  reason?: 'without_order' | 'unmatched_order' | 'existing';
}> {
  if (!amazonOrderId) return { created: 0, skipped: 1, wouldDuplicateV0: 0, reason: 'without_order' }
  const order = await prisma.order.findFirst({
    where: { channel: 'AMAZON', channelOrderId: amazonOrderId, channelConnectionId: accountId },
    select: { id: true },
  })
  if (!order) return { created: 0, skipped: 1, wouldDuplicateV0: 0, reason: 'unmatched_order' }
  const transactionType = tx.transactionType === 'Shipment' ? 'Order' : tx.transactionType!
  const existing = await prisma.financialTransaction.findFirst({
    where: { orderId: order.id, transactionType, amazonTransactionId: tx.transactionId },
    select: { id: true },
  })
  if (existing) return { created: 0, skipped: 1, wouldDuplicateV0: 0, orderId: order.id, reason: 'existing' }
  const legacy = await prisma.financialTransaction.findFirst({
    where: { orderId: order.id, transactionType, amazonTransactionId: amazonOrderId },
    select: { id: true },
  })
  return { created: 1, skipped: 0, wouldDuplicateV0: legacy ? 1 : 0, orderId: order.id }
}

/** One-page envelope probe, never a financial write. A live call still needs approval. */
export interface FinancialEnvelopeProbe {
  ok: boolean
  /** 'bare' = {transactions}, 'payload' = {payload:{transactions}}, null = neither. */
  envelope: 'bare' | 'payload' | null
  transactionsOnFirstPage: number
  hasNextToken: boolean
  /** The top-level keys Amazon sent, so an unexpected shape is nameable. */
  rootKeys: string[]
  windowStart: string
  windowEnd: string
  marketplaceId: string | null
  accountId?: string
  error?: string
}

export async function probeFinancialTransactionsEnvelope(
  windowStart: Date,
  windowEnd: Date,
  marketplaceId?: string | null,
  accountId?: string,
): Promise<FinancialEnvelopeProbe> {
  if (marketplaceId === null && !accountId) throw new Error('An account-wide Finances probe requires an explicit accountId.')
  const mid = marketplaceId === null ? null : marketplaceId ?? process.env.AMAZON_MARKETPLACE_ID ?? 'APJ6JRA9NG5V4'
  const upperBound = new Date(Math.min(windowEnd.getTime(), Date.now() - 180_000))
  const base: FinancialEnvelopeProbe = {
    ok: false, envelope: null, transactionsOnFirstPage: 0, hasNextToken: false, rootKeys: [],
    windowStart: windowStart.toISOString(), windowEnd: upperBound.toISOString(), marketplaceId: mid,
  }
  try {
    const authorization = await import('../lib/amazon-sp-client.js')
    const account = await authorization.amazonAccount({ accountId })
    const qs = new URLSearchParams({
      postedAfter: windowStart.toISOString(),
      postedBefore: upperBound.toISOString(),
      ...(mid !== null ? { marketplaceId: mid } : {}),
    }).toString()
    // P1.2 — through the channel gateway, like the sync itself. A read.
    const res = await (await import('./gateway/amazon-sdk.js')).amazonSellerFetch({
      accountId: account.id, path: `/finances/2024-06-19/transactions?${qs}`, operation: 'finances.listTransactions',
    })
    if (!res.ok) {
      const body = await res.text()
      return { ...base, error: `HTTP ${res.status}: ${body.slice(0, 300)}` }
    }
    const body = (await res.json()) as Record<string, unknown>
    // Keys only. A probe that logged the body would put settlement data in a log line.
    const rootKeys = Object.keys(body ?? {})
    const envelope: 'bare' | 'payload' | null =
      Array.isArray(body?.transactions) ? 'bare'
      : Array.isArray((body?.payload as Record<string, unknown> | undefined)?.transactions) ? 'payload'
      : null
    const page = envelope ? readTransactionsPage(body) : { transactions: [], nextToken: undefined }
    return {
      ...base,
      accountId: account.id,
      ok: envelope !== null,
      envelope,
      transactionsOnFirstPage: page.transactions.length,
      hasNextToken: !!page.nextToken,
      rootKeys,
      ...(envelope === null ? { error: 'no transactions list in either envelope' } : {}),
    }
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * P5.2 — may this request run as a dry run? Returns the refusal, or `null` to proceed.
 *
 * 🔴 A dry run exists on the 2024-06-19 path ONLY. `syncFinancialEvents` (v0) has no
 * dry-run arm, so letting the flag through on that path would accept a flag and IGNORE
 * it — and the thing ignored is the difference between counting money and writing it.
 * The rule lives here, next to the two paths, rather than in the route, so it is one
 * predicate with one test rather than a sentence a reader has to trust.
 */
export function financialsDryRunRefusal(body: { useV0?: boolean; dryRun?: boolean; probe?: boolean; accountId?: string }): string | null {
  for (const flag of ['useV0', 'dryRun', 'probe'] as const) {
    if (body[flag] !== undefined && typeof body[flag] !== 'boolean') return `${flag} must be a boolean. Nothing was written.`
  }
  if (body.accountId !== undefined && body.useV0 !== false && body.probe !== true) return 'accountId is supported only by the 2024 probe or dry run. The v0 writer was not called.'
  if (body.useV0 === false && body.dryRun !== true && body.probe !== true) return 'Finances 2024 cutover is held pending reconciliation. Use dryRun: true. Nothing was written.'
  if (body.dryRun !== true) return null
  if (body.useV0 === false) return null
  return 'dryRun is only available on the 2024-06-19 path. Send {"useV0": false, "dryRun": true}. Nothing was written.'
}

/**
 * P5.2 — bounded identity/order-overlap measurement, with no financial writes.
 * Provider transaction IDs do not bridge v0's order-level money records. Until that
 * reconciliation and monetary mapping are proved, the new writer is deliberately held.
 */
export async function syncFinancialTransactions(
  windowStart: Date,
  windowEnd: Date,
  marketplaceId?: string | null,
  opts: { dryRun?: boolean; accountId?: string } = {},
): Promise<FinancialSyncSummary> {
  const t0 = Date.now()
  if (opts.dryRun !== true) throw new Error('Finances 2024 cutover is held pending reconciliation. Use dryRun: true; no channel call or money write was made.')
  if (opts.accountId !== undefined && (typeof opts.accountId !== 'string' || !opts.accountId.trim())) throw new Error('accountId must be a nonempty string.')
  const dryRun = true
  if (marketplaceId !== null && (typeof marketplaceId !== 'string' || !marketplaceId.trim())) throw new Error('Choose an explicit marketplaceId, or null with an accountId for an account-wide Finances comparison.')
  if (marketplaceId === null && !opts.accountId) throw new Error('An account-wide Finances comparison requires an explicit accountId.')
  const mid = marketplaceId

  // Clamp upper bound to "now - 3min" — same SP-API data-propagation guard
  // we use for getOrders.
  const SP_API_CLOCK_SKEW_MS = 180_000
  const minAgo = new Date(Date.now() - SP_API_CLOCK_SKEW_MS)
  const upperBound = windowEnd.getTime() > minAgo.getTime() ? minAgo : windowEnd
  const span = upperBound.getTime() - windowStart.getTime()
  if (!Number.isFinite(span) || span <= 0 || span > 180 * 86_400_000) {
    throw new Error('The Finances date window must be valid, increasing, and no longer than 180 days.')
  }
  const authorization = await import('../lib/amazon-sp-client.js')
  const account = await authorization.amazonAccount({ accountId: opts.accountId })

  const collected: NewTransaction[] = []
  let nextToken: string | undefined
  let pages = 0
  const tokens = new Set<string>()
  while (true) {
    const params: Record<string, string> = {
          postedAfter: windowStart.toISOString(),
          postedBefore: upperBound.toISOString(),
          ...(mid !== null ? { marketplaceId: mid } : {}),
          ...(nextToken ? { nextToken } : {}),
    }
    const qs = new URLSearchParams(params).toString()
    // P1.2 — through the channel gateway (the same account; rate bucket; call ledger).
    const res = await (await import('./gateway/amazon-sdk.js')).amazonSellerFetch({
      accountId: account.id, path: `/finances/2024-06-19/transactions?${qs}`, operation: 'finances.listTransactions',
    })
    if (!res.ok) {
      const body = await res.text()
      logger.error('[fin-tx-2024] fetch failed', { status: res.status, body: body.slice(0, 300) })
      throw new Error(`finances/2024-06-19/transactions ${res.status}: ${body.slice(0, 200)}`)
    }
    const page = readTransactionsPage(await res.json())
    collected.push(...page.transactions)
    pages++
    nextToken = page.nextToken
    if (!nextToken) break
    if (pages >= 50 || tokens.has(nextToken)) throw new Error('Finances pagination is incomplete: page bound or repeated nextToken.')
    tokens.add(nextToken)
    // light pacing — endpoint is generous but be polite
    await new Promise((r) => setTimeout(r, 200))
  }

  logger.info('[fin-tx-2024] Fetched', { transactions: collected.length, pages, dryRun })

  let txWouldCreate = 0
  let txSkipped = 0
  let ordersMatched = 0
  let txWouldDuplicateV0 = 0
  let transactionsWithoutOrderId = 0, unmatchedTransactions = 0, duplicateTransactions = 0
  const transactionIds = new Map<string, string>()
  const matchedOrders = new Set<string>()
  for (const tx of collected) {
    if (!tx || typeof tx.transactionId !== 'string' || !tx.transactionId.trim()) throw new Error('Finances transaction has no valid transactionId.')
    if (typeof tx.transactionType !== 'string' || !tx.transactionType.trim()) throw new Error('Finances transaction has no valid transactionType.')
    if (tx.relatedIdentifiers !== undefined && !Array.isArray(tx.relatedIdentifiers)) throw new Error('Finances transaction has invalid relatedIdentifiers.')
    const orderId = transactionOrderId(tx)
    const identity = JSON.stringify([tx.transactionType, orderId ?? null])
    if (transactionIds.has(tx.transactionId)) {
      if (transactionIds.get(tx.transactionId) !== identity) throw new Error('Finances pagination returned conflicting identities for one transactionId.')
      txSkipped++; duplicateTransactions++; continue
    }
    transactionIds.set(tx.transactionId, identity)
    const r = await assessNewTransaction(tx, account.id, orderId)
    txWouldCreate += r.created
    txSkipped += r.skipped
    txWouldDuplicateV0 += r.wouldDuplicateV0
    if (r.orderId) matchedOrders.add(r.orderId)
    if (r.reason === 'without_order') transactionsWithoutOrderId++
    if (r.reason === 'unmatched_order') unmatchedTransactions++
  }
  ordersMatched = matchedOrders.size

  if (dryRun) {
    logger.info('[fin-tx-2024] DRY RUN — nothing written', {
      txWouldCreate, txSkipped, txWouldDuplicateV0, transactions: collected.length,
    })
  }

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: upperBound.toISOString(),
    orderEventsFetched: collected.length,
    refundEventsFetched: 0,
    ordersMatched,
    ordersSkipped: unmatchedTransactions,
    // 🔴 Zero on a dry run, because zero rows were created. Every existing reader of
    // this field sums writes, and a dry run must not add to that sum.
    txCreated: 0,
    txSkipped,
    durationMs: Date.now() - t0,
    dryRun,
    txWouldCreate,
    txWouldDuplicateV0,
    comparisonScope: 'identity_and_order_overlap_only',
    accountId: account.id, marketplaceId: mid,
    transactionsWithoutOrderId, unmatchedTransactions, duplicateTransactions,
  }
}
