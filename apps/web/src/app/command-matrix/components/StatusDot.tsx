'use client'

import { cn } from '@/lib/utils'
import type { SyncStatus } from '../lib/types'
import type { RolledUpChannel } from '../lib/rollup'

const DOT_CLASS: Record<SyncStatus, string> = {
  SYNCED: 'bg-green-500',
  OVERRIDE: 'bg-amber-400',
  ERROR: 'bg-red-500',
  UNLISTED: 'bg-slate-300',
}

const LABEL: Record<SyncStatus, string> = {
  SYNCED: 'Synced',
  OVERRIDE: 'Override',
  ERROR: 'Error',
  UNLISTED: 'Unlisted',
}

interface StatusDotProps {
  status: SyncStatus
  /** When > 0, shows a small count badge alongside the dot (rollup). */
  badCount?: number
  className?: string
}

export function StatusDot({ status, badCount, className }: StatusDotProps) {
  return (
    <span
      className={cn('inline-flex items-center gap-1', className)}
      title={LABEL[status]}
    >
      <span
        className={cn(
          'inline-block w-2.5 h-2.5 rounded-full flex-shrink-0',
          DOT_CLASS[status],
        )}
      />
      {badCount !== undefined && badCount > 0 && (
        <span className="text-[10px] font-semibold text-slate-500 leading-none">
          {badCount}
        </span>
      )}
    </span>
  )
}

/** Rolled-up dot for a master row — shows worst status + count badge. */
export function RolledUpStatusDot({
  rollup,
  className,
}: {
  rollup: RolledUpChannel
  className?: string
}) {
  return (
    <StatusDot
      status={rollup.status}
      badCount={rollup.badCount}
      className={className}
    />
  )
}
