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
