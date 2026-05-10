/**
 * eBay Financial Events Ingestion (Phase 2B — Financial)
 *
 * Pulls transactions from the eBay Sell Finances API
 * (GET /sell/finances/v1/transaction) for the active seller account,
 * matches each SALE/REFUND to an existing Order row, and writes a
 * FinancialTransaction record.
 *
 * eBay transaction types → FinancialTransaction.transactionType:
 *   SALE         → 'Order'
 *   REFUND       → 'Refund'
 *   NON_SALE_CHARGE / CREDIT / DEBIT → skipped (no order linkage needed)
 *
 * Idempotency: skips on (orderId, transactionType, ebayTransactionId).
 * Rate limit: eBay Sell Finances API allows 15 requests/second.
 *
 * Auth: user-level OAuth via EbayAuthService.getValidToken(connectionId).
 */

import prisma from '../db.js'
import { ebayAuthService } from './ebay-auth.service.js'
import { logger } from '../utils/logger.js'

const EBAY_API_BASE = process.env.EBAY_API_BASE ?? 'https://api.ebay.com'

interface EbayTransaction {
  transactionId: string
  transactionDate: string
  transactionType: string // SALE | REFUND | NON_SALE_CHARGE | CREDIT | DEBIT | DISPUTE | etc.
  transactionStatus: string // PAYOUT | FUNDS_AVAILABLE_FOR_PAYOUT | FUNDS_ON_HOLD | FAILED | etc.
  amount: { value: string; currency: string }
  totalFeeAmount?: { value: string; currency: string }
  orderId?: string
  paymentsEntity?: string
  references?: Array<{ referenceId: string; referenceType: string }>
}

interface FinancialSummary {
  windowStart: string
  windowEnd: string
  txFetched: number
  txCreated: number
  txSkipped: number
  ordersMatched: number
  durationMs: number
}

async function fetchEbayTransactions(
  accessToken: string,
  filterStr: string,
): Promise<EbayTransaction[]> {
  const all: EbayTransaction[] = []
  let cursor: string | undefined

  do {
    const url = new URL(`${EBAY_API_BASE}/sell/finances/v1/transaction`)
    url.searchParams.set('filter', filterStr)
    url.searchParams.set('limit', '200')
    if (cursor) url.searchParams.set('offset', cursor)

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '(no body)')
      throw new Error(`eBay GET /finances/v1/transaction failed: ${res.status} ${body}`)
    }
    const data: any = await res.json()
    const txs: EbayTransaction[] = data.transactions ?? []
    all.push(...txs)
    cursor = data.next ? String(data.next) : undefined
    if (!cursor || txs.length === 0) break
  } while (cursor)

  return all
}

function parseAmount(val: string | undefined): number {
  const n = parseFloat(val ?? '0')
  return isNaN(n) ? 0 : n
}

async function processTransaction(
  tx: EbayTransaction,
): Promise<{ created: boolean; skipped: boolean }> {
  if (tx.transactionType !== 'SALE' && tx.transactionType !== 'REFUND') {
    return { created: false, skipped: true }
  }

  // eBay order ID is in orderId field or references array
  const ebayOrderId =
    tx.orderId ??
    tx.references?.find(r => r.referenceType === 'ORDER_ID')?.referenceId

  if (!ebayOrderId) return { created: false, skipped: true }

  const order = await prisma.order.findFirst({
    where: { channel: 'EBAY', channelOrderId: ebayOrderId },
    select: { id: true, currencyCode: true },
  })
  if (!order) return { created: false, skipped: true }

  const txType = tx.transactionType === 'SALE' ? 'Order' : 'Refund'

  // Idempotency check
  const existing = await prisma.financialTransaction.findFirst({
    where: { orderId: order.id, transactionType: txType, ebayTransactionId: tx.transactionId },
    select: { id: true },
  })
  if (existing) return { created: false, skipped: true }

  const amount = parseAmount(tx.amount.value)
  const totalFee = parseAmount(tx.totalFeeAmount?.value)
  const signedAmount = tx.transactionType === 'REFUND' ? -Math.abs(amount) : amount
  const currency = tx.amount.currency

  await prisma.financialTransaction.create({
    data: {
      ebayTransactionId: tx.transactionId,
      orderId: order.id,
      transactionType: txType,
      transactionDate: new Date(tx.transactionDate),
      amount: signedAmount,
      currencyCode: currency,
      amazonFee: 0,
      fbaFee: 0,
      paymentServicesFee: 0,
      ebayFee: totalFee,
      paypalFee: 0,
      otherFees: 0,
      grossRevenue: signedAmount,
      netRevenue: signedAmount - totalFee,
      status: tx.transactionStatus === 'PAYOUT' ? 'Completed' : 'Pending',
      amazonMetadata: {
        ebayTransactionType: tx.transactionType,
        ebayTransactionStatus: tx.transactionStatus,
        ebayOrderId,
      },
    },
  })

  return { created: true, skipped: false }
}

export async function syncEbayFinancialEvents(
  windowStart: Date,
  windowEnd: Date,
): Promise<FinancialSummary> {
  const t0 = Date.now()

  // Get active eBay connection
  const connection = await prisma.channelConnection.findFirst({
    where: { channelType: 'EBAY', isActive: true },
    select: { id: true, displayName: true },
  })
  if (!connection) throw new Error('No active eBay ChannelConnection')

  const accessToken = await ebayAuthService.getValidToken(connection.id)

  // eBay filter format: transactionDate:[2026-01-01T00:00:00Z..2026-02-01T00:00:00Z]
  const filterStr = `transactionDate:[${windowStart.toISOString()}..${windowEnd.toISOString()}]`

  logger.info('[ebay-fin] Fetching transactions', { filterStr })
  const txs = await fetchEbayTransactions(accessToken, filterStr)
  logger.info('[ebay-fin] Fetched', { count: txs.length })

  let txCreated = 0
  let txSkipped = 0
  let ordersMatched = 0

  for (const tx of txs) {
    const r = await processTransaction(tx)
    if (r.created) { txCreated++; ordersMatched++ }
    else txSkipped++
  }

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    txFetched: txs.length,
    txCreated,
    txSkipped,
    ordersMatched,
    durationMs: Date.now() - t0,
  }
}

export async function syncEbayYesterdayFinancials(): Promise<FinancialSummary> {
  const now = new Date()
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000)
  return syncEbayFinancialEvents(start, end)
}
