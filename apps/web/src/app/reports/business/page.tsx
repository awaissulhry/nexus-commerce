import { prisma } from '@nexus/database'
import PageHeader from '@/components/layout/PageHeader'
import BusinessReportsClient from './BusinessReportsClient'

export const dynamic = 'force-dynamic'

export default async function BusinessReportsPage() {
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

  // U.61 — defensive try/catch. See /catalog/drafts for context.
  let orders: any[] = []
  let products: any[] = []
  try {
    ;[orders, products] = await Promise.all([
      prisma.order.findMany({
        where: { createdAt: { gte: thirtyDaysAgo } },
        include: { items: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.product.findMany({
        select: {
          id: true,
          name: true,
          sku: true,
          totalStock: true,
          basePrice: true,
        },
      }),
    ])
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[reports/business] prisma error:', err)
  }

  // Build daily sales data
  const byDate = new Map<string, { revenue: number; orders: number; units: number }>()
  for (let i = 29; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const key = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    byDate.set(key, { revenue: 0, orders: 0, units: 0 })
  }

  for (const order of orders) {
    const key = order.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    const entry = byDate.get(key) ?? { revenue: 0, orders: 0, units: 0 }
    entry.revenue += Number(order.totalPrice)
    entry.orders += 1
    entry.units += order.items.reduce((sum: number, item: any) => sum + item.quantity, 0)
    byDate.set(key, entry)
  }

  const salesData = Array.from(byDate.entries()).map(([date, data]) => ({
    date,
    revenue: Math.round(data.revenue * 100) / 100,
    orders: data.orders,
    units: data.units,
  }))

  // Build top products by revenue
  const productRevenue = new Map<string, { title: string; sku: string; revenue: number; units: number; orders: number }>()
  for (const order of orders) {
    for (const item of order.items) {
      const existing = productRevenue.get(item.sku) ?? { title: '', sku: item.sku, revenue: 0, units: 0, orders: 0 }
      existing.revenue += Number(item.price) * item.quantity
      existing.units += item.quantity
      existing.orders += 1
      // Try to find product title
      const product = products.find((p: any) => p.sku === item.sku)
      if (product) existing.title = product.name
      productRevenue.set(item.sku, existing)
    }
  }

  const topProducts = Array.from(productRevenue.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10)
    .map((p, idx) => ({ ...p, rank: idx + 1, revenue: Math.round(p.revenue * 100) / 100 }))

  // Summary stats
  const totalRevenue = salesData.reduce((s: number, d) => s + d.revenue, 0)
  const totalOrders = salesData.reduce((s: number, d) => s + d.orders, 0)
  const totalUnits = salesData.reduce((s: number, d) => s + d.units, 0)
  const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0

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
        summary={{
          totalRevenue: Math.round(totalRevenue * 100) / 100,
          totalOrders,
          totalUnits,
          avgOrderValue: Math.round(avgOrderValue * 100) / 100,
        }}
      />
    </div>
  )
}
