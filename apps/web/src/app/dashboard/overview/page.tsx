import { prisma } from '@nexus/database'
import PageHeader from '@/components/layout/PageHeader'
import StatCard from '@/components/StatCard'
import DashboardHomeClient from '../DashboardClient'
import RealTimeStockMonitor from '@/components/dashboard/RealTimeStockMonitor'

export const dynamic = 'force-dynamic'

export default async function OverviewPage() {
  // KPI counts — each wrapped separately so one failure doesn't kill the page
  let totalProducts = 0, totalOrders = 0, totalListings = 0, totalChannels = 0
  try {
    ;[totalProducts, totalOrders, totalListings, totalChannels] = await Promise.all([
      prisma.product.count(),
      prisma.order.count(),
      prisma.listing.count(),
      prisma.channel.count(),
    ])
  } catch (err: any) {
    console.error('[OVERVIEW] KPI counts failed', { message: err.message, code: err.code, meta: err.meta })
  }

  let totalRevenue = 0
  try {
    const revenueResult = await prisma.order.aggregate({ _sum: { totalPrice: true } })
    totalRevenue = Number(revenueResult._sum.totalPrice || 0)
  } catch (err: any) {
    console.error('[OVERVIEW] Revenue aggregate failed', { message: err.message, code: err.code, meta: err.meta })
  }

  // Recent orders
  let recentOrders: any[] = []
  try {
    const recentOrdersRaw = await prisma.order.findMany({
      take: 10,
      orderBy: { createdAt: 'desc' },
    })
    recentOrders = recentOrdersRaw.map((o: any) => ({
      id: o.id,
      channelOrderId: o.channelOrderId,
      status: o.status,
      totalPrice: Number(o.totalPrice),
      customerName: o.customerName,
      createdAt: o.createdAt.toISOString(),
    }))
  } catch (err: any) {
    console.error('[OVERVIEW] Recent orders failed', { message: err.message, code: err.code, meta: err.meta })
  }

  // Low stock products
  let lowStockProducts: any[] = []
  try {
    const lowStockRaw = await prisma.product.findMany({
      where: { totalStock: { lt: 10 } },
      orderBy: { totalStock: 'asc' },
      take: 20,
      select: { id: true, sku: true, name: true, totalStock: true },
    })
    lowStockProducts = lowStockRaw.map((p) => ({
      id: p.id,
      sku: p.sku,
      name: p.name,
      totalStock: p.totalStock,
    }))
  } catch (err: any) {
    console.error('[OVERVIEW] Low stock query failed', { message: err.message, code: err.code, meta: err.meta })
  }

  // Channel health — two queries, both optional
  let channelHealth: any[] = []
  try {
    const channelsRaw = await prisma.channel.findMany({
      include: { _count: { select: { listings: true } } },
    })

    let syncMap: Record<string, string> = {}
    try {
      const syncStatuses = await (prisma as any).marketplaceSync.findMany({
        orderBy: { lastSyncAt: 'desc' },
        distinct: ['channel'],
        select: { channel: true, lastSyncStatus: true },
      })
      for (const s of syncStatuses) syncMap[s.channel] = s.lastSyncStatus
    } catch (err: any) {
      console.error('[OVERVIEW] MarketplaceSync query failed', { message: err.message, code: err.code, meta: err.meta })
    }

    channelHealth = channelsRaw.map((ch: any) => ({
      id: ch.id,
      name: ch.name,
      type: ch.type,
      listingsCount: ch._count.listings,
      lastSyncStatus: syncMap[ch.type.toUpperCase()] || null,
    }))
  } catch (err: any) {
    console.error('[OVERVIEW] Channel health failed', { message: err.message, code: err.code, meta: err.meta })
  }

  const formatCurrency = (amount: number) =>
    amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

  return (
    <div>
      <PageHeader
        title="Command Center"
        subtitle="Overview of your commerce operations"
        breadcrumbs={[{ label: 'Dashboard' }, { label: 'Overview' }]}
      />

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <StatCard title="Total Revenue" value={formatCurrency(totalRevenue)} icon="💰" color="green" />
        <StatCard title="Total Orders" value={totalOrders.toLocaleString()} icon="🛒" color="blue" />
        <StatCard title="Products" value={totalProducts.toLocaleString()} icon="📦" color="purple" />
        <StatCard title="Active Listings" value={totalListings.toLocaleString()} icon="📋" color="yellow" />
        <StatCard title="Channels" value={totalChannels.toLocaleString()} icon="🔗" color="blue" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <DashboardHomeClient
          recentOrders={recentOrders}
          lowStockProducts={lowStockProducts}
          channelHealth={channelHealth}
        />
        <RealTimeStockMonitor />
      </div>
    </div>
  )
}
