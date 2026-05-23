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

  if (!amazonService.isConfigured()) {
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
// Amazon migrated Finance API access to /finances/2024-06-19/transactions.
// Existing v0 endpoints (/financialEvents, /financialEventGroups) return
// 403 for new authorizations even when "Finance and Accounting" is granted.
// Probe at GET /api/amazon/finance/probe confirms 2024-06-19 returns 200.
//
// The new Transaction model is flatter than v0's FinancialEvent — one row
// per transaction (vs nested ShipmentItemList). Mapping to FinancialTransaction:
//   - amazonOrderId  ← relatedIdentifiers[AMAZON_ORDER_ID].relatedIdentifierValue
//   - transactionType ← 'Order' (Shipment) | 'Refund' | other
//   - amount         ← totalAmount.currencyAmount
//   - fees           ← breakdowns by breakdownType (Commission, FBA Fees, etc.)
// ─────────────────────────────────────────────────────────────────────

interface NewMoney {
  currencyAmount?: number
  currencyCode?: string
}
interface NewBreakdown {
  breakdownType?: string
  breakdownAmount?: NewMoney
}
interface NewRelatedId {
  relatedIdentifierName?: string
  relatedIdentifierValue?: string
}
interface NewTransaction {
  sellerOrderItemId?: string
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

async function getLwaAccessToken(): Promise<string> {
  const clientId = process.env.AMAZON_LWA_CLIENT_ID
  const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET
  const refreshToken = process.env.AMAZON_REFRESH_TOKEN
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('LWA credentials missing')
  }
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  })
  if (!res.ok) throw new Error(`LWA failed: ${await res.text()}`)
  const data = (await res.json()) as { access_token: string }
  return data.access_token
}

function sumBreakdowns(
  breakdowns: NewBreakdown[] | undefined,
  matcher: (type: string) => boolean,
): number {
  return (breakdowns ?? [])
    .filter((b) => b.breakdownType && matcher(b.breakdownType))
    .reduce((s, b) => s + (b.breakdownAmount?.currencyAmount ?? 0), 0)
}

function findRelatedId(
  ids: NewRelatedId[] | undefined,
  name: string,
): string | undefined {
  return ids?.find((r) => r.relatedIdentifierName === name)?.relatedIdentifierValue
}

async function processNewTransaction(
  tx: NewTransaction,
): Promise<{ created: number; skipped: number }> {
  const amazonOrderId = findRelatedId(tx.relatedIdentifiers, 'AMAZON_ORDER_ID')
  if (!amazonOrderId) return { created: 0, skipped: 1 }

  const order = await prisma.order.findFirst({
    where: { channel: 'AMAZON', channelOrderId: amazonOrderId },
    select: { id: true, currencyCode: true },
  })
  if (!order) return { created: 0, skipped: 1 }

  // Map Amazon transactionType → Nexus transactionType
  // Shipment = Order revenue, Refund = Refund, all others kept as raw string
  const rawType = tx.transactionType ?? 'Unknown'
  const txType =
    rawType === 'Shipment' ? 'Order' :
    rawType === 'Refund' ? 'Refund' :
    rawType

  // Idempotency: unique key is (orderId, transactionType, amazonTransactionId).
  // Use sellerOrderItemId + postedDate as transaction-level uniqueness so we
  // can ingest multiple shipments/refunds for the same order.
  const txIdentifier = tx.sellerOrderItemId
    ? `${amazonOrderId}/${tx.sellerOrderItemId}/${tx.postedDate ?? ''}`
    : `${amazonOrderId}/${tx.postedDate ?? ''}`

  const existing = await prisma.financialTransaction.findFirst({
    where: {
      orderId: order.id,
      transactionType: txType,
      amazonTransactionId: txIdentifier,
    },
    select: { id: true },
  })
  if (existing) return { created: 0, skipped: 1 }

  // Sum breakdowns — Amazon uses negative numbers for fees, positive for revenue
  const principal = sumBreakdowns(tx.breakdowns, (t) => t === 'Principal')
  const tax = sumBreakdowns(tx.breakdowns, (t) => t === 'Tax' || t.endsWith('Tax'))
  const shipping = sumBreakdowns(tx.breakdowns, (t) => t.startsWith('Shipping'))
  const commission = Math.abs(
    sumBreakdowns(tx.breakdowns, (t) => t === 'Commission' || t === 'RefundCommission'),
  )
  const fbaFee = Math.abs(
    sumBreakdowns(tx.breakdowns, (t) =>
      t.startsWith('FBA') || t === 'Fulfillment Fees' || t === 'FBAFees',
    ),
  )
  const otherFees = Math.abs(
    sumBreakdowns(tx.breakdowns, (t) =>
      !['Principal', 'Tax', 'Commission', 'RefundCommission'].includes(t) &&
      !t.startsWith('Shipping') && !t.startsWith('FBA') &&
      t !== 'Fulfillment Fees' && t !== 'FBAFees' && !t.endsWith('Tax'),
    ),
  )

  const totalAmount = tx.totalAmount?.currencyAmount ?? 0
  const currencyCode = tx.totalAmount?.currencyCode ?? order.currencyCode ?? 'EUR'
  const grossRevenue = principal + shipping
  const totalFees = commission + fbaFee + otherFees
  const netRevenue = grossRevenue - totalFees + tax

  const postedDate = tx.postedDate ? new Date(tx.postedDate) : new Date()

  await prisma.financialTransaction.create({
    data: {
      amazonTransactionId: txIdentifier,
      orderId: order.id,
      transactionType: txType,
      transactionDate: postedDate,
      amount: totalAmount,
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
        source: 'finances/2024-06-19/transactions',
        postedDate: tx.postedDate,
        rawTransactionType: rawType,
        description: tx.description,
        sellerOrderItemId: tx.sellerOrderItemId,
        breakdowns: (tx.breakdowns ?? []) as unknown as Array<Record<string, unknown>>,
      } as unknown as object,
    },
  })

  return { created: 1, skipped: 0 }
}

/**
 * Pulls /finances/2024-06-19/transactions for the window, paginates via
 * nextToken, and writes one FinancialTransaction per Amazon Transaction.
 * Idempotent — re-running over the same window skips existing rows.
 */
export async function syncFinancialTransactions(
  windowStart: Date,
  windowEnd: Date,
  marketplaceId?: string,
): Promise<FinancialSyncSummary> {
  const t0 = Date.now()
  const mid = marketplaceId ?? process.env.AMAZON_MARKETPLACE_ID ?? 'APJ6JRA9NG5V4'
  const region = (process.env.AMAZON_REGION ?? 'eu') as string
  const host = `sellingpartnerapi-${region}.amazon.com`

  // Clamp upper bound to "now - 3min" — same SP-API data-propagation guard
  // we use for getOrders.
  const SP_API_CLOCK_SKEW_MS = 180_000
  const minAgo = new Date(Date.now() - SP_API_CLOCK_SKEW_MS)
  const upperBound = windowEnd.getTime() > minAgo.getTime() ? minAgo : windowEnd

  const accessToken = await getLwaAccessToken()

  const collected: NewTransaction[] = []
  let nextToken: string | undefined
  let pages = 0
  while (true) {
    const params: Record<string, string> = nextToken
      ? { nextToken }
      : {
          postedAfter: windowStart.toISOString(),
          postedBefore: upperBound.toISOString(),
          marketplaceId: mid,
        }
    const qs = new URLSearchParams(params).toString()
    const res = await fetch(`https://${host}/finances/2024-06-19/transactions?${qs}`, {
      headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
    })
    if (!res.ok) {
      const body = await res.text()
      logger.error('[fin-tx-2024] fetch failed', { status: res.status, body: body.slice(0, 300) })
      throw new Error(`finances/2024-06-19/transactions ${res.status}: ${body.slice(0, 200)}`)
    }
    const data = (await res.json()) as { transactions?: NewTransaction[]; nextToken?: string }
    collected.push(...(data.transactions ?? []))
    pages++
    nextToken = data.nextToken
    if (!nextToken || pages >= 50) break
    // light pacing — endpoint is generous but be polite
    await new Promise((r) => setTimeout(r, 200))
  }

  logger.info('[fin-tx-2024] Fetched', { transactions: collected.length, pages })

  let txCreated = 0
  let txSkipped = 0
  let ordersMatched = 0
  for (const tx of collected) {
    const r = await processNewTransaction(tx)
    txCreated += r.created
    txSkipped += r.skipped
    if (r.created > 0) ordersMatched++
  }

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: upperBound.toISOString(),
    orderEventsFetched: collected.length,
    refundEventsFetched: 0,
    ordersMatched,
    ordersSkipped: 0,
    txCreated,
    txSkipped,
    durationMs: Date.now() - t0,
  }
}
