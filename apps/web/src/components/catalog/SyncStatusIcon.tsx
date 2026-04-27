'use client'

import { CheckCircle2, AlertCircle, Clock, Loader2, XCircle } from 'lucide-react'

interface SyncStatusIconProps {
  status: 'IDLE' | 'PENDING' | 'SYNCING' | 'IN_SYNC' | 'FAILED'
  lastSyncAt?: Date | null
}

// Helper to format time difference
const formatTimeAgo = (date: Date): string => {
  const now = new Date()
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000)
  
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export default function SyncStatusIcon({ status, lastSyncAt }: SyncStatusIconProps) {
  const getStatusConfig = () => {
    switch (status) {
      case 'IDLE':
        return {
          icon: Clock,
          color: 'text-gray-400',
          bgColor: 'bg-gray-100',
          label: 'Idle',
          tooltip: 'Not synced yet',
        }
      case 'PENDING':
        return {
          icon: AlertCircle,
          color: 'text-yellow-600',
          bgColor: 'bg-yellow-100',
          label: 'Pending',
          tooltip: 'Waiting to sync',
        }
      case 'SYNCING':
        return {
          icon: Loader2,
          color: 'text-blue-600',
          bgColor: 'bg-blue-100',
          label: 'Syncing',
          tooltip: 'Currently syncing...',
          animate: true,
        }
      case 'IN_SYNC':
        return {
          icon: CheckCircle2,
          color: 'text-green-600',
          bgColor: 'bg-green-100',
          label: 'In Sync',
          tooltip: lastSyncAt ? `Synced ${formatTimeAgo(new Date(lastSyncAt))}` : 'Synced',
        }
      case 'FAILED':
        return {
          icon: XCircle,
          color: 'text-red-600',
          bgColor: 'bg-red-100',
          label: 'Failed',
          tooltip: 'Sync failed - retry needed',
        }
      default:
        return {
          icon: Clock,
          color: 'text-gray-400',
          bgColor: 'bg-gray-100',
          label: 'Unknown',
          tooltip: 'Unknown status',
        }
    }
  }

  const config = getStatusConfig()
  const Icon = config.icon

  return (
    <div className="group relative inline-flex">
      <div className={`${config.bgColor} rounded-full p-1.5`}>
        <Icon className={`${config.color} h-4 w-4 ${config.animate ? 'animate-spin' : ''}`} />
      </div>
      
      {/* Tooltip */}
      <div className="absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-gray-900 px-2 py-1 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100 pointer-events-none">
        {config.tooltip}
        <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900" />
      </div>
    </div>
  )
}
