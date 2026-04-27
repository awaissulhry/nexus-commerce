'use server'

import { prisma } from '@nexus/database'

export async function getRevenueAnalytics(period: '7d' | '30d' | '90d' | '1y') {
  try {
    const daysMap = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 }
    const days = daysMap[period]
    const since = new Date()
    since.setDate(since.getDate() - days)

    const prevSince = new Date(since)
    prevSince.setDate(prevSince.getDate() - days)

    const [currentOrders, previousOrders, recentOrders, topOrderItems] = await Promise.all([
      prisma.order.aggregate({
        _sum: { totalAmount: true },
        _count: { id: true },
        _avg: { totalAmount: true },
        where: { createdAt: { gte: since } },
      }),
      prisma.order.aggregate({
        _sum: { totalAmount: true },
        _count: { id: true },
        where: { createdAt: { gte: prevSince, lt: since } },
      }),
      prisma.order.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: { totalAmount: true, createdAt: true, status: true },
      }),
      prisma.orderItem.groupBy({
        by: ['sku'],
        _sum: { quantity: true, price: true },
        orderBy: { _sum: { price: 'desc' } },
        take: 10,
      }),
    ])

    const currentRevenue = Number(currentOrders._sum.totalAmount || 0)
    const previousRevenue = Number(previousOrders._sum.totalAmount || 0)
    const revenueChange = previousRevenue > 0
      ? ((currentRevenue - previousRevenue) / previousRevenue) * 100
      : 0

    const currentCount = currentOrders._count.id
    const previousCount = previousOrders._count.id
    const ordersChange = previousCount > 0
      ? ((currentCount - previousCount) / previousCount) * 100
      : 0

    // Group revenue by day
    const byDay: Record<string, { revenue: number; orders: number }> = {}
    for (const o of recentOrders) {
      const day = (o as any).createdAt.toISOString().split('T')[0]
      if (!byDay[day]) byDay[day] = { revenue: 0, orders: 0 }
      byDay[day].revenue += Number((o as any).totalAmount)
      byDay[day].orders += 1
    }

    const revenueByDay = Object.entries(byDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, data]) => ({ date, ...data }))

    // Revenue by status
    const byStatus: Record<string, number> = {}
    for (const o of recentOrders) {
      const status = (o as any).status || 'Unknown'
      byStatus[status] = (byStatus[status] || 0) + Number((o as any).totalAmount)
    }
    const revenueByStatus = Object.entries(byStatus).map(([status, amount]) => ({ status, amount }))

    return {
      success: true,
      data: {
        totalRevenue: currentRevenue,
        previousRevenue,
        revenueChange: Math.round(revenueChange * 10) / 10,
        totalOrders: currentCount,
        previousOrders: previousCount,
        ordersChange: Math.round(ordersChange * 10) / 10,
        avgOrderValue: Number(currentOrders._avg.totalAmount || 0),
        revenueByDay,
        revenueByStatus,
        topRevenueProducts: topOrderItems.map((p: any) => ({
          sku: p.sku,
          totalRevenue: Number(p._sum.price || 0),
          totalQuantity: p._sum.quantity || 0,
        })),
      },
    }
  } catch (error: any) {
    return { success: false, error: error?.message || 'Failed to fetch revenue analytics' }
  }
}
