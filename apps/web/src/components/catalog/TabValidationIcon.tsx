'use client'

import { AlertCircle, CheckCircle2, XCircle } from 'lucide-react'

interface TabValidationIconProps {
  status: 'VALID' | 'WARNING' | 'ERROR'
  errorCount?: number
}

export default function TabValidationIcon({ status, errorCount = 0 }: TabValidationIconProps) {
  const getStatusConfig = () => {
    switch (status) {
      case 'VALID':
        return {
          icon: CheckCircle2,
          color: 'text-green-600',
          bgColor: 'bg-green-100',
          show: false, // Don't show badge for valid status
        }
      case 'WARNING':
        return {
          icon: AlertCircle,
          color: 'text-yellow-600',
          bgColor: 'bg-yellow-100',
          show: true,
        }
      case 'ERROR':
        return {
          icon: XCircle,
          color: 'text-red-600',
          bgColor: 'bg-red-100',
          show: true,
        }
      default:
        return {
          icon: CheckCircle2,
          color: 'text-gray-400',
          bgColor: 'bg-gray-100',
          show: false,
        }
    }
  }

  const config = getStatusConfig()
  const Icon = config.icon

  // Don't show badge for valid status
  if (!config.show) {
    return null
  }

  return (
    <div className="relative inline-flex">
      {/* Notification dot/badge */}
      <div className={`${config.bgColor} rounded-full p-1`}>
        <Icon className={`${config.color} h-3 w-3`} />
      </div>

      {/* Error count badge (if > 0) */}
      {errorCount > 0 && (
        <div className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-xs font-bold text-white">
          {errorCount > 9 ? '9+' : errorCount}
        </div>
      )}
    </div>
  )
}
