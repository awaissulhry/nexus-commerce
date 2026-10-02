/**
 * MCP full control 07 O6 — the order desk's reports, for Claude's `order-report`: counts and totals only, never a
 * buyer. Each kind reads the business the call runs in (row-level security).
 *
 *   orders            orders by status, channel and marketplace over the last N days; sales per currency; to ship, late
 *   sync-health       per channel: the newest order bought and the newest order Nexus received, and the last 24 h
 *   shipping          the ship queue by urgency (orders Amazon ships counted apart), shipments by status, tracking uploads
 *   returns           returns by status, refund status and reason over the last N days; the return rate
 *   refund-deadlines  received returns not refunded yet, against Italy's 14 days from receipt: overdue, due soon, later
 *   review-requests   review requests by status and channel over the last N days
 *   corrispettivi     one day's B2C summary by VAT rate (the preview; it is never sent from here)
 */

import prisma from '../../db.js'
import { pendingOrdersWhere } from '../fulfillment/shipment-read.service.js'
import { generateCorrispettiviDaily } from '../corrispettivi.service.js'

export const REPORT_KINDS = ['orders', 'sync-health', 'shipping', 'returns', 'refund-deadlines', 'review-requests', 'corrispettivi'] as const
export type ReportKind = (typeof REPORT_KINDS)[number]

const DAY = 86_400_000
/** Italy: the refund is due within 14 days of receiving the return (Codice del Consumo art. 56). */
export const REFUND_DAYS = 14
const DUE_SOON_DAYS = 3
const LISTED = 20

const counted = <K extends string>(rows: Array<Record<K, unknown> & { _count: { _all: number } }>, key: K) =>
  Object.fromEntries(rows.map((row) => [String(row[key] ?? 'none'), row._count._all]))
const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null)

async function ordersReport(days: number) {
  const since = new Date(Date.now() - days * DAY)
  const where = { deletedAt: null, purchaseDate: { gte: since } }
  const live = { ...where, status: { notIn: ['CANCELLED' as const, 'REFUNDED' as const] } }
  const { where: merchantQueue, now } = pendingOrdersWhere({})
  const [total, byStatus, byChannel, byMarketplace, sales, toShip, late] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.groupBy({ by: ['status'], where, _count: { _all: true } }),
    prisma.order.groupBy({ by: ['channel'], where, _count: { _all: true } }),
    prisma.order.groupBy({ by: ['marketplace'], where, _count: { _all: true } }),
    prisma.order.groupBy({ by: ['currencyCode'], where: live, _sum: { totalPrice: true }, _count: { _all: true } }),
    prisma.order.count({ where: merchantQueue }),
    prisma.order.count({ where: { AND: [merchantQueue, { shipByDate: { lt: now } }] } }),
  ])
  return {
    days,
    total,
    byStatus: counted(byStatus, 'status'),
    byChannel: counted(byChannel, 'channel'),
    byMarketplace: counted(byMarketplace, 'marketplace'),
    salesByCurrency: Object.fromEntries(sales.map((row) => [row.currencyCode ?? 'none', Number(row._sum.totalPrice ?? 0)])),
    toShip,
    lateToShip: late,
  }
}

async function syncHealthReport() {
  const dayAgo = new Date(Date.now() - DAY)
  const [newestBought, newestReceived, lastDay] = await Promise.all([
    prisma.order.groupBy({ by: ['channel'], where: { deletedAt: null }, _max: { purchaseDate: true } }),
    prisma.order.groupBy({ by: ['channel'], where: { deletedAt: null }, _max: { createdAt: true } }),
    prisma.order.groupBy({ by: ['channel'], where: { deletedAt: null, createdAt: { gte: dayAgo } }, _count: { _all: true } }),
  ])
  const received = new Map(newestReceived.map((row) => [row.channel, row._max.createdAt]))
  const recent = new Map(lastDay.map((row) => [row.channel, row._count._all]))
  return {
    channels: newestBought.map((row) => ({
      channel: row.channel,
      newestPurchase: iso(row._max.purchaseDate),
      newestReceived: iso(received.get(row.channel) ?? null),
      receivedLast24h: recent.get(row.channel) ?? 0,
    })),
  }
}

async function shippingReport(days: number) {
  const since = new Date(Date.now() - days * DAY)
  const { where: merchant, now, t24, t48, t7d } = pendingOrdersWhere({})
  const { where: amazonQueue } = pendingOrdersWhere({}, { amazonShips: 'only' })
  const bucket = (shipByDate: Record<string, unknown> | null) => prisma.order.count({ where: { AND: [merchant, { shipByDate }] } })
  const [overdue, today, tomorrow, thisWeek, later, unknown, amazonShips, shipments, uploads] = await Promise.all([
    bucket({ lt: now }),
    bucket({ gte: now, lt: t24 }),
    bucket({ gte: t24, lt: t48 }),
    bucket({ gte: t48, lt: t7d }),
    bucket({ gte: t7d }),
    bucket(null),
    prisma.order.count({ where: amazonQueue }),
    prisma.shipment.groupBy({ by: ['status'], where: { deletedAt: null, createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.trackingMessageLog.groupBy({ by: ['status'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
  ])
  return {
    days,
    queue: { overdue, today, tomorrow, thisWeek, later, unknown },
    amazonShipsNotQueued: amazonShips,
    shipmentsByStatus: counted(shipments, 'status'),
    trackingUploadsByStatus: counted(uploads, 'status'),
  }
}

async function returnsReport(days: number) {
  const since = new Date(Date.now() - days * DAY)
  const where = { createdAt: { gte: since } }
  const [total, byStatus, byRefundStatus, byReason, orders, fba] = await Promise.all([
    prisma.return.count({ where }),
    prisma.return.groupBy({ by: ['status'], where, _count: { _all: true } }),
    prisma.return.groupBy({ by: ['refundStatus'], where, _count: { _all: true } }),
    prisma.return.groupBy({ by: ['reason'], where, _count: { _all: true }, orderBy: { _count: { reason: 'desc' } }, take: 10 }),
    prisma.order.count({ where: { deletedAt: null, purchaseDate: { gte: since } } }),
    prisma.return.count({ where: { ...where, isFbaReturn: true } }),
  ])
  return {
    days,
    total,
    fbaReturns: fba,
    byStatus: counted(byStatus, 'status'),
    byRefundStatus: counted(byRefundStatus, 'refundStatus'),
    topReasons: byReason.map((row) => ({ reason: row.reason, count: row._count._all })),
    returnRatePct: orders ? Math.round((total / orders) * 1000) / 10 : null,
  }
}

async function refundDeadlinesReport() {
  const now = Date.now()
  const rows = await prisma.return.findMany({
    where: { receivedAt: { not: null }, refundedAt: null, status: { notIn: ['REFUNDED', 'REJECTED', 'SCRAPPED'] } },
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    select: { id: true, rmaNumber: true, channel: true, marketplace: true, status: true, refundStatus: true, refundCents: true, currencyCode: true, receivedAt: true, isFbaReturn: true },
  })
  const withDue = rows.map((row) => {
    const dueBy = row.receivedAt!.getTime() + REFUND_DAYS * DAY
    return { ...row, dueBy, daysLeft: Math.floor((dueBy - now) / DAY) }
  })
  const overdue = withDue.filter((row) => row.dueBy < now)
  const dueSoon = withDue.filter((row) => row.dueBy >= now && row.daysLeft <= DUE_SOON_DAYS)
  return {
    rule: `Italy: refund within ${REFUND_DAYS} days of receiving the return`,
    open: withDue.length,
    overdue: overdue.length,
    dueSoon: dueSoon.length,
    later: withDue.length - overdue.length - dueSoon.length,
    mostUrgent: withDue.slice(0, LISTED).map((row) => ({
      returnId: row.id,
      rmaNumber: row.rmaNumber,
      channel: row.channel,
      marketplace: row.marketplace,
      status: row.status,
      refundStatus: row.refundStatus,
      refundCents: row.refundCents,
      currencyCode: row.currencyCode,
      isFbaReturn: row.isFbaReturn,
      receivedAt: iso(row.receivedAt),
      dueBy: new Date(row.dueBy).toISOString(),
      daysLeft: row.daysLeft,
    })),
  }
}

async function reviewRequestsReport(days: number) {
  const since = new Date(Date.now() - days * DAY)
  const where = { createdAt: { gte: since } }
  const [byStatus, byChannel] = await Promise.all([
    prisma.reviewRequest.groupBy({ by: ['status'], where, _count: { _all: true } }),
    prisma.reviewRequest.groupBy({ by: ['channel'], where, _count: { _all: true } }),
  ])
  return { days, byStatus: counted(byStatus, 'status'), byChannel: counted(byChannel, 'channel') }
}

async function corrispettiviReport(date: string) {
  const { xml: _xml, filename: _filename, ...summary } = await generateCorrispettiviDaily(date)
  return { ...summary, note: 'Preview only: Nexus sends the corrispettivi from the Fiscal page, never from here.' }
}

/** One report. `days` is clamped to 1…365; `date` (YYYY-MM-DD) is for corrispettivi only. */
export async function orderReport(kind: ReportKind, options: { days?: number; date?: string } = {}) {
  const days = Math.min(365, Math.max(1, Math.trunc(options.days ?? 30)))
  switch (kind) {
    case 'orders': return ordersReport(days)
    case 'sync-health': return syncHealthReport()
    case 'shipping': return shippingReport(days)
    case 'returns': return returnsReport(days)
    case 'refund-deadlines': return refundDeadlinesReport()
    case 'review-requests': return reviewRequestsReport(days)
    case 'corrispettivi': return corrispettiviReport(options.date ?? new Date(Date.now() - DAY).toISOString().slice(0, 10))
  }
}
