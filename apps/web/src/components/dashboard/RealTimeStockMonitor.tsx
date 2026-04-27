'use client'

import { useEffect, useState } from 'react'

interface StockAdjustment {
  id: string
  sku: string
  productId: string
  previousQuantity: number
  newQuantity: number
  quantityChanged: number
  reason: 'SALE' | 'RESTOCK' | 'ADJUSTMENT' | 'RETURN'
  affectedChannels: string[]
  timestamp: Date
  lowStockThreshold?: number  // Phase 23.2: Low-stock threshold
  stockBuffer?: number        // Phase 23.2: Stock buffer for overselling protection
}

export default function RealTimeStockMonitor() {
  const [adjustments, setAdjustments] = useState<StockAdjustment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [lowStockAlerts, setLowStockAlerts] = useState<Set<string>>(new Set())

  // Fetch recent adjustments
  const fetchAdjustments = async () => {
    try {
      const response = await fetch('/api/webhooks/recent-adjustments?limit=15')
      if (!response.ok) throw new Error('Failed to fetch adjustments')
      const data = await response.json()
      setAdjustments(data.data.adjustments || [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  // Initial fetch
  useEffect(() => {
    fetchAdjustments()
  }, [])

  // Auto-refresh every 5 seconds
  useEffect(() => {
    if (!autoRefresh) return

    const interval = setInterval(() => {
      fetchAdjustments()
    }, 5000)

    return () => clearInterval(interval)
  }, [autoRefresh])

  const getReasonColor = (reason: string) => {
    switch (reason) {
      case 'SALE':
        return 'text-red-600 bg-red-50'
      case 'RESTOCK':
        return 'text-green-600 bg-green-50'
      case 'RETURN':
        return 'text-blue-600 bg-blue-50'
      case 'ADJUSTMENT':
        return 'text-yellow-600 bg-yellow-50'
      default:
        return 'text-gray-600 bg-gray-50'
    }
  }

  const getReasonIcon = (reason: string) => {
    switch (reason) {
      case 'SALE':
        return '📉'
      case 'RESTOCK':
        return '📈'
      case 'RETURN':
        return '↩️'
      case 'ADJUSTMENT':
        return '⚙️'
      default:
        return '•'
    }
  }

  // Phase 23.2: Check if stock is at or below threshold
  const isLowStock = (adjustment: StockAdjustment): boolean => {
    if (!adjustment.lowStockThreshold) return false
    return adjustment.newQuantity <= adjustment.lowStockThreshold
  }

  // Phase 23.2: Get low-stock alert styling
  const getLowStockStyle = (adjustment: StockAdjustment) => {
    if (isLowStock(adjustment)) {
      return 'border-red-300 bg-red-50 hover:border-red-400'
    }
    return 'border-gray-200 bg-gray-50 hover:border-gray-300'
  }

  const formatTime = (timestamp: Date | string) => {
    const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    const seconds = Math.floor(diff / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)

    if (seconds < 60) return `${seconds}s ago`
    if (minutes < 60) return `${minutes}m ago`
    if (hours < 24) return `${hours}h ago`
    return date.toLocaleDateString()
  }

  return (
    <div className="col-span-full lg:col-span-2 bg-white rounded-lg border border-gray-200 shadow-sm">
      {/* Header */}
      <div className="flex flex-row items-center justify-between space-y-0 pb-4 px-6 pt-6 border-b border-gray-200">
        <div>
          <h3 className="flex items-center gap-2 text-lg font-semibold text-gray-900">
            <span className="text-xl">📊</span>
            Real-time Stock Monitor
          </h3>
          <p className="text-sm text-gray-600 mt-1">Live feed of inventory adjustments across all channels</p>
        </div>
        <button
          onClick={() => setAutoRefresh(!autoRefresh)}
          className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
            autoRefresh
              ? 'bg-green-100 text-green-700 hover:bg-green-200'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          {autoRefresh ? '🔴 Live' : '⚪ Paused'}
        </button>
      </div>

      {/* Content */}
      <div className="px-6 py-4">
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
            Error: {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin">⏳</div>
            <span className="ml-2 text-gray-600">Loading adjustments...</span>
          </div>
        ) : adjustments.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            <p className="text-lg">No stock adjustments yet</p>
            <p className="text-sm">Adjustments will appear here as they happen</p>
          </div>
        ) : (
          <div className="space-y-3 max-h-96 overflow-y-auto">
            {adjustments.map((adj) => (
              <div
                key={adj.id}
                className={`flex items-start gap-3 p-3 rounded-lg border transition-colors ${getLowStockStyle(adj)}`}
              >
                {/* Icon & Reason */}
                <div className={`flex-shrink-0 w-8 h-8 rounded flex items-center justify-center text-lg ${getReasonColor(adj.reason)}`}>
                  {getReasonIcon(adj.reason)}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 mb-1">
                    <span className="font-semibold text-gray-900">{adj.sku}</span>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded ${getReasonColor(adj.reason)}`}>
                      {adj.reason}
                    </span>
                    {/* Phase 23.2: Low-stock alert indicator */}
                    {isLowStock(adj) && (
                      <span className="text-xs font-bold px-2 py-0.5 rounded bg-red-200 text-red-800 flex items-center gap-1">
                        ⚠️ LOW STOCK
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 text-sm text-gray-600 mb-2">
                    <span>
                      {adj.previousQuantity} → {adj.newQuantity}
                    </span>
                    <span className={adj.quantityChanged < 0 ? 'text-red-600 font-medium' : 'text-green-600 font-medium'}>
                      {adj.quantityChanged > 0 ? '+' : ''}
                      {adj.quantityChanged}
                    </span>
                    {/* Phase 23.2: Show threshold and buffer info */}
                    {adj.lowStockThreshold && (
                      <span className="text-xs text-gray-500 ml-2">
                        (threshold: {adj.lowStockThreshold}
                        {adj.stockBuffer ? `, buffer: ${adj.stockBuffer}` : ''})
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 text-xs text-gray-500">
                    <span>📡 {adj.affectedChannels.length} channel{adj.affectedChannels.length !== 1 ? 's' : ''}</span>
                    <span>•</span>
                    <span>{formatTime(adj.timestamp)}</span>
                  </div>

                  {adj.affectedChannels.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {adj.affectedChannels.map((channel) => (
                        <span
                          key={channel}
                          className="inline-block px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded"
                        >
                          {channel}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Timestamp */}
                <div className="flex-shrink-0 text-xs text-gray-400 text-right">
                  {new Date(adj.timestamp).toLocaleTimeString()}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Footer */}
        <div className="mt-4 pt-4 border-t border-gray-200 flex items-center justify-between text-xs text-gray-500">
          <span>Showing {adjustments.length} recent adjustments</span>
          <button
            onClick={fetchAdjustments}
            className="text-blue-600 hover:text-blue-700 font-medium"
          >
            Refresh now
          </button>
        </div>
      </div>
    </div>
  )
}
