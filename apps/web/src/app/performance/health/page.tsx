import { prisma } from '@nexus/database'
import PageHeader from '@/components/layout/PageHeader'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

interface HealthMetric {
  label: string
  status: 'good' | 'at-risk' | 'critical'
  value: string
  target: string
  description: string
}

export default async function AccountHealthPage() {
  // U.61 — defensive try/catch. See /catalog/drafts for context.
  let totalOrders = 0
  let returnCount = 0
  let pendingReturns = 0
  let lowStockCount = 0
  let unlinkedListings = 0
  let recentFailedSyncs = 0
  try {
    ;[
      totalOrders,
      returnCount,
      pendingReturns,
      lowStockCount,
      unlinkedListings,
      recentFailedSyncs,
    ] = await Promise.all([
      prisma.order.count(),
      (prisma as any)['return'].count(),
      (prisma as any)['return'].count({ where: { status: 'REQUESTED' } }),
      prisma.product.count({ where: { totalStock: { lte: 5 } } }),
      prisma.listing.count({ where: { productId: null } }),
      prisma.marketplaceSync.count({
        where: {
          lastSyncStatus: 'FAILED',
          lastSyncAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        },
      }),
    ])
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[performance/health] prisma error:', err)
  }

  // Derive health metrics
  const returnRate = totalOrders > 0 ? (returnCount / totalOrders) * 100 : 0
  const returnRateStatus: HealthMetric['status'] =
    returnRate > 10 ? 'critical' : returnRate > 5 ? 'at-risk' : 'good'

  const syncHealthStatus: HealthMetric['status'] =
    recentFailedSyncs > 5 ? 'critical' : recentFailedSyncs > 2 ? 'at-risk' : 'good'

  const inventoryHealthStatus: HealthMetric['status'] =
    lowStockCount > 10 ? 'critical' : lowStockCount > 3 ? 'at-risk' : 'good'

  const listingHealthStatus: HealthMetric['status'] =
    unlinkedListings > 10 ? 'critical' : unlinkedListings > 3 ? 'at-risk' : 'good'

  const metrics: HealthMetric[] = [
    {
      label: 'Order Defect Rate',
      status: returnRateStatus,
      value: `${returnRate.toFixed(1)}%`,
      target: '< 1%',
      description: 'Percentage of orders with defects (returns, claims, chargebacks)',
    },
    {
      label: 'Return Rate',
      status: returnRateStatus,
      value: `${returnRate.toFixed(1)}%`,
      target: '< 5%',
      description: `${returnCount} returns out of ${totalOrders} total orders`,
    },
    {
      label: 'Pending Returns',
      status: pendingReturns > 5 ? 'critical' : pendingReturns > 0 ? 'at-risk' : 'good',
      value: String(pendingReturns),
      target: '0',
      description: 'Return requests awaiting action',
    },
    {
      label: 'Sync Health',
      status: syncHealthStatus,
      value: `${recentFailedSyncs} failures`,
      target: '0 failures',
      description: 'Failed sync operations in the last 7 days',
    },
    {
      label: 'Inventory Health',
      status: inventoryHealthStatus,
      value: `${lowStockCount} low stock`,
      target: '0 low stock',
      description: 'Products with stock ≤ 5 units',
    },
    {
      label: 'Listing Health',
      status: listingHealthStatus,
      value: `${unlinkedListings} unlinked`,
      target: '0 unlinked',
      description: 'Listings not linked to any product',
    },
  ]

  const overallStatus: HealthMetric['status'] = metrics.some((m) => m.status === 'critical')
    ? 'critical'
    : metrics.some((m) => m.status === 'at-risk')
      ? 'at-risk'
      : 'good'

  const statusConfig = {
    good: { bg: 'bg-green-50', border: 'border-green-200', text: 'text-green-800', badge: 'bg-green-100 text-green-700', icon: '✅', label: 'Healthy' },
    'at-risk': { bg: 'bg-yellow-50', border: 'border-yellow-200', text: 'text-yellow-800', badge: 'bg-yellow-100 text-yellow-700', icon: '⚠️', label: 'At Risk' },
    critical: { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-800', badge: 'bg-red-100 text-red-700', icon: '🚨', label: 'Critical' },
  }

  return (
    <div>
      <PageHeader
        title="Account Health"
        subtitle="Monitor your seller account health metrics"
        breadcrumbs={[
          { label: 'Performance', href: '#' },
          { label: 'Account Health' },
        ]}
      />

      {/* Overall Health Banner */}
      <div className={`${statusConfig[overallStatus].bg} ${statusConfig[overallStatus].border} border rounded-lg p-6 mb-6`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-3xl">{statusConfig[overallStatus].icon}</span>
            <div>
              <h2 className={`text-lg font-bold ${statusConfig[overallStatus].text}`}>
                Account Health: {statusConfig[overallStatus].label}
              </h2>
              <p className={`text-sm ${statusConfig[overallStatus].text} opacity-80 mt-1`}>
                {overallStatus === 'good'
                  ? 'All metrics are within acceptable thresholds.'
                  : overallStatus === 'at-risk'
                    ? 'Some metrics need attention to maintain good standing.'
                    : 'Immediate action required on critical metrics.'}
              </p>
            </div>
          </div>
          <span className={`px-4 py-2 rounded-full text-sm font-bold ${statusConfig[overallStatus].badge}`}>
            {metrics.filter((m) => m.status === 'good').length}/{metrics.length} Passing
          </span>
        </div>
      </div>

      {/* Health Metrics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        {metrics.map((metric) => {
          const cfg = statusConfig[metric.status]
          return (
            <div key={metric.label} className={`${cfg.bg} ${cfg.border} border rounded-lg p-5`}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-900">{metric.label}</h3>
                <span className={`px-2.5 py-0.5 rounded-full text-xs font-bold ${cfg.badge}`}>
                  {cfg.label}
                </span>
              </div>
              <p className="text-2xl font-bold text-gray-900">{metric.value}</p>
              <p className="text-xs text-gray-500 mt-1">Target: {metric.target}</p>
              <p className="text-xs text-gray-600 mt-2">{metric.description}</p>
            </div>
          )
        })}
      </div>

      {/* Quick Actions */}
      <div className="bg-white rounded-lg shadow border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-900 mb-4">Recommended Actions</h3>
        <div className="space-y-3">
          {pendingReturns > 0 && (
            <div className="flex items-center justify-between py-2 border-b border-gray-100">
              <div className="flex items-center gap-3">
                <span className="text-lg">↩️</span>
                <div>
                  <p className="text-sm font-medium text-gray-900">Process pending returns</p>
                  <p className="text-xs text-gray-500">{pendingReturns} return{pendingReturns !== 1 ? 's' : ''} awaiting action</p>
                </div>
              </div>
              <Link href="/orders?lens=returns" className="px-3 py-1.5 text-xs font-medium bg-blue-50 text-blue-700 rounded-md hover:bg-blue-100 transition-colors">
                Review Returns
              </Link>
            </div>
          )}
          {lowStockCount > 0 && (
            <div className="flex items-center justify-between py-2 border-b border-gray-100">
              <div className="flex items-center gap-3">
                <span className="text-lg">📦</span>
                <div>
                  <p className="text-sm font-medium text-gray-900">Restock low inventory</p>
                  <p className="text-xs text-gray-500">{lowStockCount} product{lowStockCount !== 1 ? 's' : ''} with stock ≤ 5</p>
                </div>
              </div>
              <Link href="/products" className="px-3 py-1.5 text-xs font-medium bg-blue-50 text-blue-700 rounded-md hover:bg-blue-100 transition-colors">
                View Products
              </Link>
            </div>
          )}
          {unlinkedListings > 0 && (
            <div className="flex items-center justify-between py-2 border-b border-gray-100">
              <div className="flex items-center gap-3">
                <span className="text-lg">🔗</span>
                <div>
                  <p className="text-sm font-medium text-gray-900">Link unlinked listings</p>
                  <p className="text-xs text-gray-500">{unlinkedListings} listing{unlinkedListings !== 1 ? 's' : ''} need linking</p>
                </div>
              </div>
              <Link href="/listings" className="px-3 py-1.5 text-xs font-medium bg-blue-50 text-blue-700 rounded-md hover:bg-blue-100 transition-colors">
                Link Listings
              </Link>
            </div>
          )}
          {recentFailedSyncs > 0 && (
            <div className="flex items-center justify-between py-2 border-b border-gray-100">
              <div className="flex items-center gap-3">
                <span className="text-lg">⚙️</span>
                <div>
                  <p className="text-sm font-medium text-gray-900">Investigate sync failures</p>
                  <p className="text-xs text-gray-500">{recentFailedSyncs} failed sync{recentFailedSyncs !== 1 ? 's' : ''} this week</p>
                </div>
              </div>
              <Link href="/sync-logs" className="px-3 py-1.5 text-xs font-medium bg-blue-50 text-blue-700 rounded-md hover:bg-blue-100 transition-colors">
                View Logs
              </Link>
            </div>
          )}
          {overallStatus === 'good' && (
            <p className="text-sm text-green-700 py-2">✅ No immediate actions required. Keep up the good work!</p>
          )}
        </div>
      </div>
    </div>
  )
}
