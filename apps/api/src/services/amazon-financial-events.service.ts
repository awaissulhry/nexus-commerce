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

function sumCharges(list: AmazonChargeComponent[] | undefined, type: string): number {
  return (list ?? [])
    .filter(c => c.ChargeType === type)
    .reduce((s, c) => s + parseAmount(c.ChargeAmount?.Amount), 0)
}

function sumFees(list: AmazonFeeComponent[] | undefined, ...types: string[]): number {
  const set = new Set(types)
  return (list ?? [])
    .filter(f => set.has(f.FeeType))
    .reduce((s, f) => s + Math.abs(parseAmount(f.FeeAmount?.Amount)), 0)
}

function sumAllFees(list: AmazonFeeComponent[] | undefined): number {
  return (list ?? []).reduce((s, f) => s + Math.abs(parseAmount(f.FeeAmount?.Amount)), 0)
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
      amount: grossRevenue + tax,
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

  for (const event of payload.orderEvents) {
    const r = await processOrderEvent(event)
    txCreated += r.created
    txSkipped += r.skipped
    if (r.created > 0) ordersMatched++; else ordersSkipped++
  }

  for (const event of payload.refundEvents) {
    const r = await processRefundEvent(event)
    txCreated += r.created
    txSkipped += r.skipped
  }

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
