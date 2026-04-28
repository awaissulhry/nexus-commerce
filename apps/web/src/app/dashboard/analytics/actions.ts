'use server'

import { prisma } from '@nexus/database'

export async function getAnalyticsData(period: '7d' | '30d' | '90d' | '1y') {
  try {
    const daysMap = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 }
    const days = daysMap[period]
    const since = new Date()
    since.setDate(since.getDate() - days)

    const [ordersByStatus, totalRevenue, recentOrders, topProducts] = await Promise.all([
      prisma.order.groupBy({
        by: ['status'],
        _count: { id: true },
        where: { createdAt: { gte: since } },
      }),
      prisma.order.aggregate({
        _sum: { totalPrice: true },
        _count: { id: true },
        where: { createdAt: { gte: since } },
      }),
      prisma.order.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: 30,
        select: { totalPrice: true, createdAt: true },
      }),
      prisma.orderItem.groupBy({
        by: ['sku'],
        _sum: { quantity: true },
        _count: { id: true },
        orderBy: { _sum: { quantity: 'desc' } },
        take: 5,
      }),
    ])

    return {
      success: true,
      data: {
        ordersByStatus: ordersByStatus.map((s: any) => ({
          status: s.status,
          count: s._count.id,
        })),
        totalRevenue: Number(totalRevenue._sum?.totalPrice || 0),
        totalOrders: totalRevenue._count?.id || 0,
        revenueByDay: recentOrders.map((o: any) => ({
          date: o.createdAt.toISOString().split('T')[0],
          amount: Number(o.totalPrice),
        })),
        topProducts: topProducts.map((p: any) => ({
          sku: p.sku,
          totalQuantity: p._sum.quantity || 0,
          orderCount: p._count.id,
        })),
      },
    }
  } catch (error: any) {
    return { success: false, error: error?.message || 'Failed to fetch analytics' }
  }
}
