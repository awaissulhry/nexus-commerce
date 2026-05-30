/**
 * RX.5 — Returns intelligence.
 *
 * Two layers the surface lacked:
 *   1. Customer-level returner risk (serial returners / abuse signal).
 *      The existing risk-scores service is SKU-level; this is the
 *      who-not-what view, complementing the CI-series RFM work.
 *   2. Refund leakage / retention ratio + a cost-of-returns estimate —
 *      the financial lens on whether returns end as cash out the door
 *      vs retained value (store credit / exchange / restocked).
 *
 * All computed read-only over a rolling window; no schema, no writes.
 */

import prisma from '../db.js'

export interface ReturnerRisk {
  email: string
  customerName: string | null
  returnCount: number
  orderCount: number
  returnRatePct: number | null
  refundCents: number
  flagged: boolean
  reason: string
}

export interface IntelligenceSummary {
  windowDays: number
  serialReturners: ReturnerRisk[]
  retention: {
    cash: number
    storeCredit: number
    exchange: number
    cashCents: number
    storeCreditCents: number
    exchangeCents: number
    /** Share of resolved refunds retained as credit/exchange vs cash. */
    retentionPct: number | null
  }
  costOfReturns: {
    cashRefundCents: number
    handlingCents: number
    totalCents: number
    returnCount: number
    perReturnHandlingCents: number
  }
  generatedAt: string
}

export async function computeReturnsIntelligence(opts?: { windowDays?: number }): Promise<IntelligenceSummary> {
  const windowDays = Math.max(7, Math.min(365, opts?.windowDays ?? 90))
  const since = new Date(Date.now() - windowDays * 86_400_000)
  const PER_RETURN_HANDLING_CENTS = Math.max(0, Number(process.env.NEXUS_RETURNS_HANDLING_CENTS) || 500)
  const SERIAL_MIN_RETURNS = Math.max(2, Number(process.env.NEXUS_RETURNS_SERIAL_MIN) || 3)

  const [returnsByCustomer, ordersByCustomer, refundsByKind, returnCount] = await Promise.all([
    // Returns + refund total per customer (joins to Order for identity).
    prisma.$queryRaw<Array<{ email: string; name: string | null; return_count: bigint; refund_cents: bigint }>>`
      SELECT o."customerEmail" AS email,
             MAX(o."customerName") AS name,
             COUNT(DISTINCT r.id)::bigint AS return_count,
             COALESCE(SUM(r."refundCents"), 0)::bigint AS refund_cents
      FROM "Return" r
      JOIN "Order" o ON o.id = r."orderId"
      WHERE r."createdAt" >= ${since} AND o."customerEmail" IS NOT NULL
      GROUP BY o."customerEmail"
    `,
    prisma.$queryRaw<Array<{ email: string; order_count: bigint }>>`
      SELECT "customerEmail" AS email, COUNT(*)::bigint AS order_count
      FROM "Order"
      WHERE "createdAt" >= ${since} AND "customerEmail" IS NOT NULL
      GROUP BY "customerEmail"
    `,
    // Posted refunds by kind — the retention/leakage lens.
    prisma.refund.groupBy({
      by: ['kind'],
      _count: { _all: true },
      _sum: { amountCents: true },
      where: { channelStatus: 'POSTED', createdAt: { gte: since } },
    }),
    prisma.return.count({ where: { createdAt: { gte: since } } }),
  ])

  const orderCountByEmail = new Map<string, number>(
    ordersByCustomer.map((r) => [r.email, Number(r.order_count)]),
  )

  const serialReturners: ReturnerRisk[] = returnsByCustomer
    .map((r) => {
      const returnCnt = Number(r.return_count)
      const orderCnt = orderCountByEmail.get(r.email) ?? returnCnt
      const ratePct = orderCnt > 0 ? (returnCnt / orderCnt) * 100 : null
      const flagged = returnCnt >= SERIAL_MIN_RETURNS || (ratePct != null && ratePct >= 50 && returnCnt >= 2)
      const reason = returnCnt >= SERIAL_MIN_RETURNS
        ? `${returnCnt} returns in ${windowDays}d`
        : ratePct != null && ratePct >= 50
          ? `${ratePct.toFixed(0)}% of orders returned`
          : 'within normal range'
      return {
        email: r.email,
        customerName: r.name,
        returnCount: returnCnt,
        orderCount: orderCnt,
        returnRatePct: ratePct,
        refundCents: Number(r.refund_cents),
        flagged,
        reason,
      }
    })
    .sort((a, b) => b.returnCount - a.returnCount || (b.returnRatePct ?? 0) - (a.returnRatePct ?? 0))
    .slice(0, 25)

  const kindMap = new Map<string, { count: number; cents: number }>()
  for (const row of refundsByKind) {
    kindMap.set(row.kind, { count: row._count._all, cents: row._sum.amountCents ?? 0 })
  }
  const cash = kindMap.get('CASH') ?? { count: 0, cents: 0 }
  const storeCredit = kindMap.get('STORE_CREDIT') ?? { count: 0, cents: 0 }
  const exchange = kindMap.get('EXCHANGE') ?? { count: 0, cents: 0 }
  const totalRefundN = cash.count + storeCredit.count + exchange.count
  const retentionPct = totalRefundN > 0 ? ((storeCredit.count + exchange.count) / totalRefundN) * 100 : null

  const handlingCents = returnCount * PER_RETURN_HANDLING_CENTS
  const cashRefundCents = cash.cents

  return {
    windowDays,
    serialReturners,
    retention: {
      cash: cash.count,
      storeCredit: storeCredit.count,
      exchange: exchange.count,
      cashCents: cash.cents,
      storeCreditCents: storeCredit.cents,
      exchangeCents: exchange.cents,
      retentionPct,
    },
    costOfReturns: {
      cashRefundCents,
      handlingCents,
      totalCents: cashRefundCents + handlingCents,
      returnCount,
      perReturnHandlingCents: PER_RETURN_HANDLING_CENTS,
    },
    generatedAt: new Date().toISOString(),
  }
}
