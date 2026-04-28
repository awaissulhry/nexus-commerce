'use server'

import { prisma } from '@nexus/database'

export async function getChannelAnalytics() {
  try {
    const channels = await prisma.channel.findMany({
      include: {
        _count: { select: { listings: true } },
      },
    })

    // Get order totals per channel
    const channelOrderTotals = await (prisma.order.groupBy as any)({
      by: ['channel'],
      _sum: { totalPrice: true },
      _count: { id: true },
    })

    const orderTotalMap: Record<string, { revenue: number; orders: number }> = {}
    for (const cot of channelOrderTotals) {
      orderTotalMap[cot.channel] = {
        revenue: Number(cot._sum?.totalPrice || 0),
        orders: cot._count?.id || 0,
      }
    }

    // Get sync statuses
    const syncStatuses = await (prisma as any).marketplaceSync.findMany({
      orderBy: { lastSyncAt: 'desc' },
      distinct: ['channel'],
      select: { channel: true, lastSyncStatus: true, lastSyncAt: true },
    })
    const syncMap: Record<string, { status: string; lastSync: string | null }> = {}
    for (const s of syncStatuses) {
      syncMap[s.channel] = {
        status: s.lastSyncStatus,
        lastSync: s.lastSyncAt?.toISOString() || null,
      }
    }

    // Get listing status breakdown per channel
    const listingsByChannel = await (prisma as any).listing.groupBy({
      by: ['channelId', 'status'],
      _count: { id: true },
    })
    const listingStatusMap: Record<string, { status: string; count: number }[]> = {}
    for (const l of listingsByChannel) {
      if (!listingStatusMap[l.channelId]) listingStatusMap[l.channelId] = []
      listingStatusMap[l.channelId].push({ status: l.status, count: l._count?.id ?? 0 })
    }

    const channelData = channels.map((ch: any) => {
      const syncInfo = syncMap[ch.type?.toUpperCase()] || { status: null, lastSync: null }
      const orderInfo = orderTotalMap[ch.id] || { revenue: 0, orders: 0 }
      return {
        id: ch.id,
        name: ch.name,
        type: ch.type,
        listingsCount: ch._count.listings,
        ordersCount: ch._count.orders,
        totalRevenue: orderInfo.revenue,
        syncStatus: syncInfo.status,
        lastSyncAt: syncInfo.lastSync,
        listingStatuses: listingStatusMap[ch.id] || [],
      }
    })

    // Overall totals
    const totalRevenue = channelData.reduce((sum: number, ch: any) => sum + ch.totalRevenue, 0)
    const totalListings = channelData.reduce((sum: number, ch: any) => sum + ch.listingsCount, 0)
    const totalOrders = channelData.reduce((sum: number, ch: any) => sum + ch.ordersCount, 0)

    return {
      success: true,
      data: {
        channels: channelData,
        totals: { totalRevenue, totalListings, totalOrders, channelCount: channels.length },
      },
    }
  } catch (error: any) {
    return { success: false, error: error?.message || 'Failed to fetch channel analytics' }
  }
}
