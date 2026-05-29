import { prisma } from '@nexus/database'
import PageHeader from '@/components/layout/PageHeader'
import BusinessReportsClient from './BusinessReportsClient'

export const dynamic = 'force-dynamic'

/**
 * Business reports — 30-day sales rollup. Aggregation runs DB-side (was:
 * load every order + every product into JS and reduce). Three GROUP BY
 * queries instead of full-table scans, so it stays correct *and* fast on a
 * large order set; only the ≤10 top SKUs' names are fetched.
 */
interface DailyRow { day: Date; orders: number; revenue: unknown }
interface UnitRow { day: Date; units: number }
interface TopRow { sku: string; revenue: unknown; units: number; orders: number }

const numify = (v: unknown): number => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0 }
const round2 = (n: number) => Math.round(n * 100) / 100
const isoDay = (d: Date) => d.toISOString().slice(0, 10)

export default async function BusinessReportsPage() {
  const since = new Date()
  since.setDate(since.getDate() - 30)

  let daily: DailyRow[] = []
  let units: UnitRow[] = []
  let top: TopRow[] = []
  try {
    ;[daily, units, top] = await Promise.all([
      prisma.$queryRaw<DailyRow[]>`
        SELECT date_trunc('day', "createdAt") AS day,
               COUNT(*)::int               AS orders,
               COALESCE(SUM("totalPrice"),0) AS revenue
          FROM "Order"
         WHERE "createdAt" >= ${since}
         GROUP BY 1`,
      prisma.$queryRaw<UnitRow[]>`
        SELECT date_trunc('day', o."createdAt")   AS day,
               COALESCE(SUM(oi.quantity),0)::int  AS units
          FROM "OrderItem" oi
          JOIN "Order" o ON o.id = oi."orderId"
         WHERE o."createdAt" >= ${since}
         GROUP BY 1`,
      prisma.$queryRaw<TopRow[]>`
        SELECT oi.sku                                AS sku,
               COALESCE(SUM(oi.price * oi.quantity),0) AS revenue,
               COALESCE(SUM(oi.quantity),0)::int     AS units,
               COUNT(DISTINCT oi."orderId")::int     AS orders
          FROM "OrderItem" oi
          JOIN "Order" o ON o.id = oi."orderId"
         WHERE o."createdAt" >= ${since}
         GROUP BY oi.sku
         ORDER BY revenue DESC
         LIMIT 10`,
    ])
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[reports/business] prisma error:', err)
  }

  // Index aggregates by UTC day (matches date_trunc).
  const ordersByDay = new Map(daily.map((d) => [isoDay(new Date(d.day)), { orders: d.orders, revenue: numify(d.revenue) }]))
  const unitsByDay = new Map(units.map((u) => [isoDay(new Date(u.day)), u.units]))

  // 30-day skeleton (zero-filled), preserving the client's "Mon D" label.
  const salesData = Array.from({ length: 30 }, (_, idx) => {
    const dt = new Date()
    dt.setDate(dt.getDate() - (29 - idx))
    const iso = isoDay(dt)
    const o = ordersByDay.get(iso)
    return {
      date: dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      revenue: round2(o?.revenue ?? 0),
      orders: o?.orders ?? 0,
      units: unitsByDay.get(iso) ?? 0,
    }
  })

  // Top products: names only for the ≤10 winners.
  const topSkus = top.map((t) => t.sku)
  const prods = topSkus.length
    ? await prisma.product.findMany({ where: { sku: { in: topSkus } }, select: { sku: true, name: true } })
    : []
  const nameBySku = new Map(prods.map((p) => [p.sku, p.name]))
  const topProducts = top.map((t, idx) => ({
    rank: idx + 1,
    sku: t.sku,
    title: nameBySku.get(t.sku) ?? '',
    revenue: round2(numify(t.revenue)),
    units: t.units,
    orders: t.orders,
  }))

  const totalRevenue = round2(daily.reduce((s, d) => s + numify(d.revenue), 0))
  const totalOrders = daily.reduce((s, d) => s + d.orders, 0)
  const totalUnits = units.reduce((s, u) => s + u.units, 0)
  const avgOrderValue = totalOrders > 0 ? round2(totalRevenue / totalOrders) : 0

  return (
    <div>
      <PageHeader
        title="Business Reports"
        subtitle="Sales & traffic analytics for the last 30 days"
        breadcrumbs={[
          { label: 'Reports', href: '#' },
          { label: 'Business Reports' },
        ]}
      />

      <BusinessReportsClient
        salesData={salesData}
        topProducts={topProducts}
        summary={{ totalRevenue, totalOrders, totalUnits, avgOrderValue }}
      />
    </div>
  )
}
