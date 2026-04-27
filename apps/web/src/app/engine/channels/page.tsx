import { prisma } from '@nexus/database'
import PageHeader from '@/components/layout/PageHeader'

export const dynamic = 'force-dynamic'

const CHANNEL_ICONS: Record<string, string> = {
  AMAZON: '🟠',
  EBAY: '🔵',
  SHOPIFY: '🟢',
  WALMART: '🔷',
  ETSY: '🟤',
}

const CHANNEL_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  AMAZON: { bg: 'bg-orange-50', border: 'border-orange-200', text: 'text-orange-700' },
  EBAY: { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-700' },
  SHOPIFY: { bg: 'bg-green-50', border: 'border-green-200', text: 'text-green-700' },
  WALMART: { bg: 'bg-indigo-50', border: 'border-indigo-200', text: 'text-indigo-700' },
  ETSY: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700' },
}

export default async function ChannelConnectionsPage() {
  const channels = await prisma.channel.findMany({
    include: {
      _count: {
        select: { listings: true, orders: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  // Get sync stats per channel type
  const syncStats = await (prisma as any).marketplaceSync.groupBy({
    by: ['channel'],
    _count: { id: true },
    where: { lastSyncStatus: 'SUCCESS' },
  })

  const syncStatsMap: Record<string, number> = {}
  for (const s of syncStats) {
    syncStatsMap[s.channel] = s._count.id
  }

  const totalListings = channels.reduce((sum, c: any) => sum + c._count.listings, 0)
  const totalOrders = channels.reduce((sum, c: any) => sum + c._count.orders, 0)

  const formatDate = (date: Date) =>
    date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })

  return (
    <div>
      <PageHeader
        title="Channel Connections"
        subtitle="Manage your marketplace integrations and API connections"
        breadcrumbs={[
          { label: 'Nexus Engine', href: '/engine/logs' },
          { label: 'Channel Connections' },
        ]}
      />

      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-white rounded-lg shadow border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Connected Channels</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{channels.length}</p>
        </div>
        <div className="bg-white rounded-lg shadow border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Total Listings</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{totalListings}</p>
        </div>
        <div className="bg-white rounded-lg shadow border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Total Orders</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{totalOrders}</p>
        </div>
        <div className="bg-white rounded-lg shadow border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Successful Syncs</p>
          <p className="text-2xl font-bold text-green-700 mt-1">
            {Object.values(syncStatsMap).reduce((a, b) => a + b, 0)}
          </p>
        </div>
      </div>

      {/* Channel Cards */}
      {channels.length === 0 ? (
        <div className="bg-white rounded-lg shadow border border-gray-200 p-12 text-center">
          <div className="text-5xl mb-4">🔗</div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">No Channels Connected</h3>
          <p className="text-sm text-gray-500 max-w-md mx-auto">
            Connect your first marketplace channel to start syncing products and orders.
            Channels are configured via the API or database seed.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {channels.map((channel: any) => {
            const type = channel.type.toUpperCase()
            const icon = CHANNEL_ICONS[type] || '🔗'
            const colors = CHANNEL_COLORS[type] || {
              bg: 'bg-gray-50',
              border: 'border-gray-200',
              text: 'text-gray-700',
            }
            const successSyncs = syncStatsMap[type] || 0
            const hasCredentials = channel.credentials && channel.credentials.length > 10

            return (
              <div
                key={channel.id}
                className={`bg-white rounded-lg shadow border ${colors.border} overflow-hidden`}
              >
                {/* Header */}
                <div className={`${colors.bg} px-5 py-4 border-b ${colors.border}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">{icon}</span>
                      <div>
                        <h3 className="text-sm font-bold text-gray-900">{channel.name}</h3>
                        <p className="text-xs text-gray-500">{channel.type}</p>
                      </div>
                    </div>
                    <span
                      className={`px-2.5 py-1 rounded-full text-xs font-bold ${
                        hasCredentials
                          ? 'bg-green-100 text-green-700'
                          : 'bg-yellow-100 text-yellow-700'
                      }`}
                    >
                      {hasCredentials ? '● Connected' : '○ Pending'}
                    </span>
                  </div>
                </div>

                {/* Stats */}
                <div className="px-5 py-4">
                  <div className="grid grid-cols-3 gap-3 text-center">
                    <div>
                      <p className="text-lg font-bold text-gray-900">{channel._count.listings}</p>
                      <p className="text-xs text-gray-500">Listings</p>
                    </div>
                    <div>
                      <p className="text-lg font-bold text-gray-900">{channel._count.orders}</p>
                      <p className="text-xs text-gray-500">Orders</p>
                    </div>
                    <div>
                      <p className="text-lg font-bold text-green-700">{successSyncs}</p>
                      <p className="text-xs text-gray-500">Syncs</p>
                    </div>
                  </div>
                </div>

                {/* Footer */}
                <div className="px-5 py-3 bg-gray-50 border-t border-gray-100">
                  <div className="flex items-center justify-between text-xs text-gray-500">
                    <span>Connected {formatDate(channel.createdAt)}</span>
                    <span className="flex items-center gap-1">
                      {hasCredentials ? (
                        <>
                          <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
                          API Key Active
                        </>
                      ) : (
                        <>
                          <span className="w-2 h-2 rounded-full bg-yellow-500 inline-block" />
                          Setup Required
                        </>
                      )}
                    </span>
                  </div>
                </div>
              </div>
            )
          })}

          {/* Add Channel Card */}
          <div className="bg-white rounded-lg shadow border-2 border-dashed border-gray-300 overflow-hidden flex items-center justify-center min-h-[200px]">
            <div className="text-center p-6">
              <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-3">
                <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
              </div>
              <p className="text-sm font-medium text-gray-600">Add Channel</p>
              <p className="text-xs text-gray-400 mt-1">Connect a new marketplace</p>
            </div>
          </div>
        </div>
      )}

      {/* Integration Guide */}
      <div className="mt-8 bg-white rounded-lg shadow border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">🔧 Integration Guide</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-lg">1️⃣</span>
              <h4 className="text-sm font-medium text-gray-900">Configure API Keys</h4>
            </div>
            <p className="text-xs text-gray-600">
              Add your marketplace API credentials. Keys are encrypted with AES-256-GCM
              before storage.
            </p>
          </div>
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-lg">2️⃣</span>
              <h4 className="text-sm font-medium text-gray-900">Map Products</h4>
            </div>
            <p className="text-xs text-gray-600">
              Link your catalog products to marketplace listings. Use the eBay Sync Control
              panel for automated mapping.
            </p>
          </div>
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-lg">3️⃣</span>
              <h4 className="text-sm font-medium text-gray-900">Enable Auto-Sync</h4>
            </div>
            <p className="text-xs text-gray-600">
              The Nexus Engine runs sync jobs every 30 minutes. Monitor progress in the
              Sync Logs dashboard.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
