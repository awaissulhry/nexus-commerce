'use client'

import { memo } from 'react'
import { AlertCircle } from 'lucide-react'
import type { TrafficLight } from './types'

interface Props {
  status: TrafficLight
  isParent: boolean
  errorChildCount: number
  overrideChildCount: number
  totalChildren: number
}

const STATUS_GLYPH: Record<TrafficLight, string> = {
  live: '🟢',
  override: '🟡',
  error: '🔴',
  none: '⚪',
}

const STATUS_LABEL: Record<TrafficLight, string> = {
  live: 'Live / Synced',
  override: 'Live with override',
  error: 'Sync error',
  none: 'Not listed',
}

const STATUS_BG: Record<TrafficLight, string> = {
  live: 'bg-green-50 dark:bg-green-950/30',
  override: 'bg-amber-50 dark:bg-amber-950/30',
  error: 'bg-red-50 dark:bg-red-950/30',
  none: 'bg-transparent',
}

export const MatrixChannelCell = memo(function MatrixChannelCell({
  status,
  isParent,
  errorChildCount,
  overrideChildCount,
  totalChildren,
}: Props) {
  const hasBadge = isParent && (errorChildCount > 0 || overrideChildCount > 0)
  const badgeCount = errorChildCount > 0 ? errorChildCount : overrideChildCount
  const badgeStatus: TrafficLight = errorChildCount > 0 ? 'error' : 'override'

  return (
    <div
      data-status={status}
      title={STATUS_LABEL[status]}
      className={`flex items-center justify-center h-full w-full gap-1 ${STATUS_BG[status]}`}
    >
      <span className="text-base leading-none select-none" aria-label={STATUS_LABEL[status]}>
        {STATUS_GLYPH[status]}
      </span>

      {/* Roll-up badge: shows how many children have this status */}
      {hasBadge && (
        <span
          title={`${badgeCount} of ${totalChildren} variant${totalChildren !== 1 ? 's' : ''} ${badgeStatus === 'error' ? 'have errors' : 'have overrides'}`}
          className={`inline-flex items-center gap-0.5 text-[10px] font-medium px-1 py-0 rounded-full leading-4 ${
            badgeStatus === 'error'
              ? 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-400'
              : 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400'
          }`}
        >
          {badgeStatus === 'error' && <AlertCircle size={9} />}
          {badgeCount}/{totalChildren}
        </span>
      )}
    </div>
  )
})
