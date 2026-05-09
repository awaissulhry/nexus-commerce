'use client'

/**
 * W9.6 — Extracted from the 4407-line ReplenishmentWorkspace.tsx
 * to reduce file weight and concurrent-session edit collisions.
 *
 * Two co-located components + one tone map:
 *   - URGENCY_TONE      tone classes per CRITICAL/HIGH/MEDIUM/LOW
 *   - UrgencyTile       single tile (count + tone pill); clicking
 *                       calls the parent-supplied filter setter
 *   - UpcomingEventsBanner
 *                       horizontal banner of the next ≤3 events
 *                       with prep deadlines, lift multipliers, and
 *                       passed-window styling
 *
 * No behavior change vs the inline versions in the workspace —
 * pure code-split. Tests + dark mode classes preserved.
 */

import { CalendarClock, FileWarning } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/utils'

export const URGENCY_TONE: Record<string, string> = {
  CRITICAL:
    'bg-rose-50 text-rose-700 border-rose-300 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-900',
  HIGH: 'bg-amber-50 text-amber-700 border-amber-300 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900',
  MEDIUM:
    'bg-blue-50 text-blue-700 border-blue-300 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-900',
  LOW: 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800',
}

export interface UpcomingEvent {
  id: string
  name: string
  startDate: string
  endDate: string
  channel: string | null
  marketplace: string | null
  productType: string | null
  expectedLift: number
  prepLeadTimeDays: number
  prepDeadline: string
  daysUntilStart: number
  daysUntilDeadline: number
  description: string | null
}

export function UrgencyTile({
  label,
  value,
  tone,
  onClick,
}: {
  label: string
  value: number
  tone: string
  onClick: () => void
}) {
  return (
    <button onClick={onClick} className="text-left">
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[24px] font-semibold tabular-nums text-slate-900 dark:text-slate-100">
              {value}
            </div>
            <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 mt-1">
              {label}
            </div>
          </div>
          <span
            className={cn(
              'inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded',
              URGENCY_TONE[tone],
            )}
          >
            {tone}
          </span>
        </div>
      </Card>
    </button>
  )
}

export function UpcomingEventsBanner({ events }: { events: UpcomingEvent[] }) {
  return (
    <div className="border border-violet-200 bg-violet-50/60 dark:bg-violet-950/30 dark:border-violet-900 rounded-md p-3">
      <div className="flex items-center gap-2 mb-2">
        <CalendarClock className="w-4 h-4 text-violet-700 dark:text-violet-400" />
        <span className="text-base uppercase tracking-wider text-violet-800 dark:text-violet-300 font-semibold">
          Upcoming retail events
        </span>
      </div>
      <div className="space-y-1.5">
        {events.map((e) => {
          const isPastDeadline = e.daysUntilDeadline <= 0
          return (
            <div
              key={e.id}
              className="flex items-center justify-between gap-3 text-base"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-semibold text-slate-900 dark:text-slate-100 truncate">
                  {e.name}
                </span>
                <span className="text-slate-500 dark:text-slate-400">
                  {e.daysUntilStart > 0
                    ? `in ${e.daysUntilStart} day${e.daysUntilStart === 1 ? '' : 's'}`
                    : `started ${Math.abs(e.daysUntilStart)} day${Math.abs(e.daysUntilStart) === 1 ? '' : 's'} ago`}
                </span>
                <span className="text-slate-400 dark:text-slate-500">·</span>
                <span className="text-slate-600 dark:text-slate-300">
                  expected lift {e.expectedLift.toFixed(1)}×
                </span>
                {(e.channel || e.marketplace) && (
                  <span className="text-slate-400 dark:text-slate-500 font-mono text-xs">
                    {[e.channel, e.marketplace].filter(Boolean).join(':')}
                  </span>
                )}
              </div>
              <span
                className={cn(
                  'text-sm font-medium tabular-nums',
                  isPastDeadline
                    ? 'text-rose-700 dark:text-rose-400'
                    : 'text-amber-700 dark:text-amber-400',
                )}
              >
                {isPastDeadline ? (
                  <span className="inline-flex items-center gap-1">
                    <FileWarning className="w-3 h-3" /> prep window passed
                  </span>
                ) : (
                  <>last day to PO: {e.prepDeadline}</>
                )}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
