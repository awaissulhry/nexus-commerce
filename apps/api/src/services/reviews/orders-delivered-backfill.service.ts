/**
 * RV.7 — Real historical backfill of Order.deliveredAt via SP-API report.
 *
 * Replaces the RV.2 "shippedAt + 3 business days" heuristic with the
 * authoritative signal from Amazon: the
 *   GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL
 * report. The report's `order-status` column transitions to "Delivered"
 * once Amazon's logistics confirms FBA delivery (or the seller confirms
 * for FBM). Its `last-updated-date` is the corresponding timestamp.
 *
 * Source-authority guard (mirrors amazon-orders.service.ts):
 *   AMAZON_API > AMAZON_REPORT > CARRIER_WEBHOOK > MCF_API > MANUAL
 * are all "authoritative" — never overwritten by lower-rank sources.
 *   HEURISTIC_FBA_3D is lower-rank — gets replaced when this report
 *     returns a real Delivered timestamp.
 *
 * Runs daily under the same NEXUS_ENABLE_REVIEW_INGEST gate as the
 * mailer, since both feed the same review pipeline.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { fetchSpApiReport } from '../sp-api-reports.service.js'

const REPORT_TYPE = 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL'

// RV.7.3 — delivery-estimate heuristic. The report almost never returns
// order-status='Delivered' (FBM never, FBA rarely), so the report pass updates
// ~0 rows and the review pipeline stalls. We estimate delivery as shippedAt + N
// business days so it isn't permanently blocked. FBA + FBM both default to 3
// business days (operator preference); each stays independently env-tunable so
// they can diverge later. Real AMAZON_API / AMAZON_REPORT / CARRIER_WEBHOOK
// values still override these when they actually arrive.
const FBA_HEURISTIC_DAYS = Math.max(1, Number(process.env.NEXUS_DELIVERY_HEURISTIC_FBA_DAYS) || 3)
const FBM_HEURISTIC_DAYS = Math.max(1, Number(process.env.NEXUS_DELIVERY_HEURISTIC_FBM_DAYS) || 3)
// Only estimate for orders shipped within this window — older orders are well
// outside the Solicitations 4–30d window, so estimating them is pointless churn.
const HEURISTIC_MAX_SHIP_AGE_DAYS = 60

function addBusinessDays(date: Date, days: number): Date {
  const d = new Date(date)
  let added = 0
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1)
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6) added++
  }
  return d
}

// Lower-rank sources (heuristic / null) get replaced when the report
// returns a real Delivered timestamp. Higher-rank sources are preserved.
const HIGHER_AUTHORITY_SOURCES = new Set([
  'AMAZON_API',
  'AMAZON_REPORT',  // already from a prior backfill run
  'CARRIER_WEBHOOK',
  'MCF_API',
  'MANUAL',
])

export interface OrdersDeliveredBackfillResult {
  marketplaces: number
  reports: number
  rowsParsed: number
  ordersUpdated: number
  ordersAlreadyAuthoritative: number
  ordersNotFound: number
  heuristicScanned: number
  heuristicUpdated: number
  errors: number
  durationMs: number
}

/**
 * Parse the flat-file (TSV) order report into a stream of `{ orderId,
 * status, lastUpdatedDate }` shapes. The first line is the header row.
 * Each subsequent line is one order. Returns only the rows where
 * order-status === 'Delivered' since we don't care about other states
 * for review-pipeline purposes.
 */
interface DeliveredRow {
  amazonOrderId: string
  lastUpdatedDate: Date
}

function parseDeliveredRows(rawTsv: string): { rows: DeliveredRow[]; totalRows: number } {
  const lines = rawTsv.split(/\r?\n/).filter(l => l.trim().length > 0)
  if (lines.length === 0) return { rows: [], totalRows: 0 }

  const header = lines[0].split('\t').map(c => c.trim().toLowerCase())
  const idIdx = header.findIndex(c => c === 'amazon-order-id' || c === 'order-id')
  const statusIdx = header.findIndex(c => c === 'order-status')
  const updatedIdx = header.findIndex(c => c === 'last-updated-date')
  if (idIdx === -1 || statusIdx === -1 || updatedIdx === -1) {
    throw new Error(
      `orders-delivered-backfill: report missing expected columns (amazon-order-id, order-status, last-updated-date). Got: ${header.join(', ')}`,
    )
  }

  const rows: DeliveredRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t')
    const status = (cols[statusIdx] ?? '').trim()
    if (status !== 'Delivered') continue
    const id = (cols[idIdx] ?? '').trim()
    const tsRaw = (cols[updatedIdx] ?? '').trim()
    if (!id || !tsRaw) continue
    const d = new Date(tsRaw)
    if (Number.isNaN(d.getTime())) continue
    rows.push({ amazonOrderId: id, lastUpdatedDate: d })
  }
  return { rows, totalRows: lines.length - 1 }
}

/**
 * Apply a batch of Delivered rows to the DB. Only updates rows where the
 * existing deliveredAtSource is null, HEURISTIC_FBA_3D, or AMAZON_REPORT
 * (the same authority level, refreshed value). Preserves stronger sources.
 */
async function applyDeliveredRows(rows: DeliveredRow[]): Promise<{
  updated: number
  alreadyAuthoritative: number
  notFound: number
}> {
  let updated = 0
  let alreadyAuthoritative = 0
  let notFound = 0

  for (const row of rows) {
    const order = await prisma.order.findFirst({
      where: { channel: 'AMAZON', channelOrderId: row.amazonOrderId },
      select: { id: true, deliveredAtSource: true },
    })
    if (!order) {
      notFound++
      continue
    }
    if (order.deliveredAtSource && HIGHER_AUTHORITY_SOURCES.has(order.deliveredAtSource) && order.deliveredAtSource !== 'AMAZON_REPORT' && order.deliveredAtSource !== 'HEURISTIC_FBA_3D') {
      alreadyAuthoritative++
      continue
    }
    await prisma.order.update({
      where: { id: order.id },
      data: {
        deliveredAt: row.lastUpdatedDate,
        deliveredAtSource: 'AMAZON_REPORT',
      },
    })
    updated++
  }
  return { updated, alreadyAuthoritative, notFound }
}

/**
 * RV.7.3 — Delivery-estimate pass. For SHIPPED Amazon orders with a shippedAt
 * but no authoritative deliveredAt, set deliveredAt = shippedAt + N business days
 * (FBA 3 / FBM 5 by default). This is what actually keeps the review pipeline
 * moving, since the report pass above returns ~0 Delivered rows. Runs
 * independently of the (flaky) report fetch. Idempotent — recomputes the same
 * value for already-heuristic rows and skips the write.
 */
async function applyShipDeliveryHeuristic(): Promise<{ scanned: number; updated: number }> {
  const since = new Date(Date.now() - HEURISTIC_MAX_SHIP_AGE_DAYS * 24 * 60 * 60 * 1000)
  const candidates = await prisma.order.findMany({
    where: {
      channel: 'AMAZON',
      deletedAt: null,
      status: 'SHIPPED',
      shippedAt: { not: null, gte: since },
      // Only fill where we don't already have an authoritative date. Legacy
      // HEURISTIC_FBM_5D rows are included so they recompute to the new 3d value.
      OR: [{ deliveredAtSource: null }, { deliveredAtSource: { in: ['HEURISTIC_FBA_3D', 'HEURISTIC_FBM_3D', 'HEURISTIC_FBM_5D'] } }],
    },
    select: { id: true, shippedAt: true, fulfillmentMethod: true, deliveredAt: true, deliveredAtSource: true },
  })
  const now = Date.now()
  let updated = 0
  for (const o of candidates) {
    if (!o.shippedAt) continue
    const isFba = o.fulfillmentMethod === 'FBA'
    const projected = addBusinessDays(o.shippedAt, isFba ? FBA_HEURISTIC_DAYS : FBM_HEURISTIC_DAYS)
    if (projected.getTime() > now) continue // estimated delivery still in the future
    const source = isFba ? 'HEURISTIC_FBA_3D' : 'HEURISTIC_FBM_3D'
    if (o.deliveredAt && o.deliveredAtSource === source && Math.abs(o.deliveredAt.getTime() - projected.getTime()) < 60_000) continue
    await prisma.order.update({ where: { id: o.id }, data: { deliveredAt: projected, deliveredAtSource: source } })
    updated++
  }
  return { scanned: candidates.length, updated }
}

/**
 * Public entrypoint. Iterates all active Amazon marketplaces with a
 * marketplaceId set, fetches the orders-delivered report covering the
 * last `daysBack` days, parses Delivered rows, applies updates.
 *
 * @param daysBack window depth in days (default 30, max 60 — Amazon caps
 *                  flat-file reports at ~60d in practice for performance)
 */
export async function runOrdersDeliveredBackfill(
  opts: { daysBack?: number } = {},
): Promise<OrdersDeliveredBackfillResult> {
  const startedAt = Date.now()
  const daysBack = Math.min(Math.max(opts.daysBack ?? 30, 7), 60)

  const result: OrdersDeliveredBackfillResult = {
    marketplaces: 0,
    reports: 0,
    rowsParsed: 0,
    ordersUpdated: 0,
    ordersAlreadyAuthoritative: 0,
    ordersNotFound: 0,
    heuristicScanned: 0,
    heuristicUpdated: 0,
    errors: 0,
    durationMs: 0,
  }

  // RV.7.3 — run the delivery-estimate heuristic FIRST, independent of the
  // report fetch below (which intermittently hangs + auto-fails). This is what
  // unblocks the review scheduler day-to-day.
  try {
    const h = await applyShipDeliveryHeuristic()
    result.heuristicScanned = h.scanned
    result.heuristicUpdated = h.updated
    logger.info('[orders-delivered-backfill] heuristic pass', h)
  } catch (err) {
    result.errors++
    logger.warn('[orders-delivered-backfill] heuristic pass failed', { error: err instanceof Error ? err.message : String(err) })
  }

  // Find every Amazon marketplace we should query. Active rows with a
  // marketplaceId set — Amazon-only since the Solicitations + report flow
  // is Amazon-specific.
  const marketplaces = await prisma.marketplace.findMany({
    where: {
      channel: 'AMAZON',
      isActive: true,
      marketplaceId: { not: null },
    },
    select: { code: true, marketplaceId: true },
  })
  result.marketplaces = marketplaces.length

  const dataEndTime = new Date()
  const dataStartTime = new Date(dataEndTime.getTime() - daysBack * 24 * 60 * 60 * 1000)

  for (const mp of marketplaces) {
    if (!mp.marketplaceId) continue
    try {
      logger.info('[orders-delivered-backfill] fetching report', {
        marketplace: mp.code,
        marketplaceId: mp.marketplaceId,
        dataStartTime: dataStartTime.toISOString(),
        dataEndTime: dataEndTime.toISOString(),
      })
      const report = await fetchSpApiReport<string>({
        reportType: REPORT_TYPE,
        marketplaceId: mp.marketplaceId,
        dataStartTime,
        dataEndTime,
      })
      result.reports++

      if (typeof report.payload !== 'string') {
        logger.warn('[orders-delivered-backfill] report not a TSV string, skipping', {
          marketplace: mp.code,
          payloadType: typeof report.payload,
        })
        continue
      }
      const { rows, totalRows } = parseDeliveredRows(report.payload)
      result.rowsParsed += totalRows
      logger.info('[orders-delivered-backfill] parsed', {
        marketplace: mp.code,
        totalRows,
        deliveredRows: rows.length,
      })

      const applied = await applyDeliveredRows(rows)
      result.ordersUpdated += applied.updated
      result.ordersAlreadyAuthoritative += applied.alreadyAuthoritative
      result.ordersNotFound += applied.notFound
    } catch (err) {
      result.errors++
      logger.warn('[orders-delivered-backfill] marketplace failed', {
        marketplace: mp.code,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  result.durationMs = Date.now() - startedAt
  logger.info('[orders-delivered-backfill] tick complete', result)
  return result
}
