'use client'

import { useState } from 'react'

interface SyncLogDetailsProps {
  syncId: string
  status: string
  channel: string
  productSku: string
  ebayItemId: string | null
  amazonAsin: string | null
  lastSyncAt: string
}

export default function SyncLogDetails({
  syncId,
  status,
  channel,
  productSku,
  ebayItemId,
  amazonAsin,
  lastSyncAt,
}: SyncLogDetailsProps) {
  const [isOpen, setIsOpen] = useState(false)

  const isFailed = status.toUpperCase() === 'FAILED'

  return (
    <div>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="inline-flex items-center px-3 py-1.5 text-xs font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
      >
        {isOpen ? '▼ Hide' : '▶ View'}
      </button>

      {isOpen && (
        <div className="mt-3 p-4 bg-gray-50 rounded-lg border border-gray-200 text-xs space-y-2 min-w-[280px]">
          <div className="flex justify-between">
            <span className="text-gray-500">Sync ID:</span>
            <span className="font-mono text-gray-700">{syncId.slice(0, 12)}…</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Channel:</span>
            <span className="font-medium text-gray-700">{channel}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">SKU:</span>
            <span className="font-mono text-gray-700">{productSku}</span>
          </div>
          {amazonAsin && (
            <div className="flex justify-between">
              <span className="text-gray-500">Amazon ASIN:</span>
              <span className="font-mono text-gray-700">{amazonAsin}</span>
            </div>
          )}
          {ebayItemId && (
            <div className="flex justify-between">
              <span className="text-gray-500">eBay Item ID:</span>
              <span className="font-mono text-gray-700">{ebayItemId}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-gray-500">Last Sync:</span>
            <span className="text-gray-700">
              {new Intl.DateTimeFormat('en-US', {
                dateStyle: 'medium',
                timeStyle: 'medium',
              }).format(new Date(lastSyncAt))}
            </span>
          </div>

          {isFailed && (
            <div className="mt-2 p-3 bg-red-50 border border-red-200 rounded-md">
              <p className="text-red-800 font-medium mb-1">⚠️ Sync Failed</p>
              <p className="text-red-700">
                The last synchronization attempt for this product failed.
                Check the API server logs for detailed error information.
              </p>
            </div>
          )}

          {!isFailed && ebayItemId && (
            <div className="mt-2 p-3 bg-green-50 border border-green-200 rounded-md">
              <p className="text-green-800 font-medium mb-1">✓ Successfully Published</p>
              <p className="text-green-700">
                This product is live on eBay with listing ID: {ebayItemId}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
