'use client'

import { useEffect, useState } from 'react'

interface WorkerStatus {
  isRunning: boolean
  isProcessing: boolean
  totalSyncsProcessed: number
  totalErrors: number
  lastProcessingTime: string | null
}

export default function AutopilotIndicator() {
  const [status, setStatus] = useState<WorkerStatus | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const response = await fetch('/api/outbound/worker-status')
        if (response.ok) {
          const data = await response.json()
          setStatus(data.status)
        }
      } catch (error) {
        console.error('Failed to fetch worker status:', error)
      } finally {
        setIsLoading(false)
      }
    }

    fetchStatus()
    // Poll every 5 seconds for status updates
    const interval = setInterval(fetchStatus, 5000)
    return () => clearInterval(interval)
  }, [])

  if (isLoading || !status) {
    return null
  }

  return (
    <div className="bg-gradient-to-r from-green-50 to-emerald-50 rounded-lg shadow p-6 border border-green-200">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          {/* Pulsing indicator dot */}
          <div className="relative">
            <div className="w-4 h-4 bg-green-500 rounded-full animate-pulse"></div>
            <div className="absolute inset-0 w-4 h-4 bg-green-500 rounded-full opacity-75 animate-ping"></div>
          </div>

          <div>
            <h3 className="text-lg font-bold text-gray-900">🤖 Autopilot: Active</h3>
            <p className="text-sm text-gray-600 mt-1">
              Background sync worker running every minute • {status.totalSyncsProcessed} syncs processed
            </p>
          </div>
        </div>

        <div className="text-right">
          <div className="text-2xl font-bold text-green-600">{status.totalSyncsProcessed}</div>
          <p className="text-xs text-gray-500">Total Syncs</p>
          {status.totalErrors > 0 && (
            <p className="text-xs text-red-600 font-medium mt-1">⚠️ {status.totalErrors} errors</p>
          )}
        </div>
      </div>

      {/* Status details */}
      <div className="mt-4 pt-4 border-t border-green-200 grid grid-cols-3 gap-4">
        <div>
          <p className="text-xs text-gray-600">Status</p>
          <p className="text-sm font-semibold text-gray-900">
            {status.isProcessing ? '⏳ Processing' : '✓ Ready'}
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-600">Last Run</p>
          <p className="text-sm font-semibold text-gray-900">
            {status.lastProcessingTime
              ? new Date(status.lastProcessingTime).toLocaleTimeString()
              : 'Pending'}
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-600">Schedule</p>
          <p className="text-sm font-semibold text-gray-900">Every 1 min</p>
        </div>
      </div>

      <div className="mt-4 p-3 bg-green-100 rounded border border-green-300">
        <p className="text-xs text-green-900">
          ✓ Your inventory is being synced automatically 24/7. The 'Force Sync' button below can be used to trigger an immediate sync if needed.
        </p>
      </div>
    </div>
  )
}
