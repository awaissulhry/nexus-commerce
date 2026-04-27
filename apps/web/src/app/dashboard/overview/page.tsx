import { prisma } from '@nexus/database'
import PageHeader from '@/components/layout/PageHeader'
import StatCard from '@/components/StatCard'
import DashboardHomeClient from '../DashboardClient'
import RealTimeStockMonitor from '@/components/dashboard/RealTimeStockMonitor'

export const dynamic = 'force-dynamic'

export default async function OverviewPage() {
  const [totalProducts, totalOrders, totalListings, totalChannels] = await Promise.all([
    prisma.product.count(),
    prisma.order.count(),
    prisma.listing.count(),
    prisma.channel.count(),
  ])

  const revenueResult = await prisma.order.aggregate({
    _sum: { totalPrice: true },
  })
  const totalRevenue = Number(revenueResult._sum.totalPrice || 0)

  // Recent orders
  const recentOrdersRaw = await prisma.order.findMany({
    take: 10,
    orderBy: { createdAt: 'desc' },
  })
  const recentOrders = recentOrdersRaw.map((o: any) => ({
    id: o.id,
    channelOrderId: o.channelOrderId,
    status: o.status,
    totalPrice: Number(o.totalPrice),
    customerName: o.customerName,
    createdAt: o.createdAt.toISOString(),
  }))

  // Low stock products
  const lowStockRaw = await prisma.product.findMany({
    where: { totalStock: { lt: 10 } },
    orderBy: { totalStock: 'asc' },
    take: 20,
    select: { id: true, sku: true, name: true, totalStock: true },
  })
  const lowStockProducts = lowStockRaw.map((p) => ({
    id: p.id,
    sku: p.sku,
    name: p.name,
    totalStock: p.totalStock,
  }))

  // Channel health
  const channelsRaw = await prisma.channel.findMany({
    include: {
      _count: { select: { listings: true } },
    },
  })

  const syncStatuses = await (prisma as any).marketplaceSync.findMany({
    orderBy: { lastSyncAt: 'desc' },
    distinct: ['channel'],
    select: { channel: true, lastSyncStatus: true },
  })
  const syncMap: Record<string, string> = {}
  for (const s of syncStatuses) {
    syncMap[s.channel] = s.lastSyncStatus
  }

  const channelHealth = channelsRaw.map((ch: any) => ({
    id: ch.id,
    name: ch.name,
    type: ch.type,
    listingsCount: ch._count.listings,
    lastSyncStatus: syncMap[ch.type.toUpperCase()] || null,
  }))

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
