'use client'

import { useMemo } from 'react'
import { CheckCircle2, ChevronDown, ChevronRight, Filter, Target } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface UnsatisfiedEntry {
  id: string
  channelKey: string
}

interface PerChannelStats {
  channelKey: string
  required: number
  filled: number
}

interface Props {
  totalRequired: number
  totalFilled: number
  unsatisfied: UnsatisfiedEntry[]
  perChannel: PerChannelStats[]
  activeTab: string
  onTabChange: (tab: string) => void
  showOnlyUnfilled: boolean
  onToggleFilter: () => void
  onJumpToNext: () => void
  expanded: boolean
  onToggleExpand: () => void
}

/**
 * U.4 — Always-visible compact validation surface for Step 4 Attributes.
 * Replaces the bottom "X field × channel pairs unsatisfied" line with
 * an actionable bar: progress, per-channel breakdown, filter, jump-next.
 */
export default function ValidationSummary({
  totalRequired,
  totalFilled,
  unsatisfied,
  perChannel,
  activeTab,
  onTabChange,
  showOnlyUnfilled,
  onToggleFilter,
  onJumpToNext,
  expanded,
  onToggleExpand,
}: Props) {
  const allReady = unsatisfied.length === 0
  const pct = totalRequired === 0 ? 100 : Math.round((totalFilled / totalRequired) * 100)

  const groupedByChannel = useMemo(() => {
    const groups = new Map<string, string[]>()
    for (const u of unsatisfied) {
      const list = groups.get(u.channelKey) ?? []
      list.push(u.id)
      groups.set(u.channelKey, list)
    }
    return groups
  }, [unsatisfied])

  return (
    <div
      className={cn(
        'sticky top-0 z-10 -mx-6 mb-3 px-6 py-3 border-b backdrop-blur',
        allReady
          ? 'bg-emerald-50/80 border-emerald-200'
          : 'bg-amber-50/80 border-amber-200',
      )}
    >
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {allReady ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
            ) : (
              <button
                type="button"
                onClick={onToggleExpand}
                className="inline-flex items-center gap-1 text-amber-700 hover:text-amber-900"
                aria-expanded={expanded}
                aria-controls="validation-summary-detail"
                title={expanded ? 'Hide details' : 'Show per-channel breakdown'}
              >
                {expanded ? (
                  <ChevronDown className="w-4 h-4" />
                ) : (
                  <ChevronRight className="w-4 h-4" />
                )}
              </button>
            )}
            <div className="text-md font-semibold tabular-nums">
              <span className={allReady ? 'text-emerald-800' : 'text-amber-900'}>
                {totalFilled} / {totalRequired}
              </span>
              <span className={cn('ml-2 text-base font-normal', allReady ? 'text-emerald-700' : 'text-amber-800')}>
                {allReady
                  ? 'required values complete across selected channels'
                  : `required values · ${unsatisfied.length} unfilled across ${groupedByChannel.size} channel${groupedByChannel.size === 1 ? '' : 's'}`}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            {!allReady && (
              <>
                <button
                  type="button"
                  onClick={onToggleFilter}
                  className={cn(
                    'inline-flex items-center gap-1 h-7 px-2 text-sm border rounded transition-colors',
                    showOnlyUnfilled
                      ? 'border-amber-400 text-amber-900 bg-amber-100 hover:bg-amber-200'
                      : 'border-slate-300 text-slate-700 bg-white hover:bg-slate-50',
                  )}
                  title="Hide every field that's already filled — focus the view on what's left"
                >
                  <Filter className="w-3 h-3" />
                  {showOnlyUnfilled ? 'Showing only unfilled' : 'Show only unfilled'}
                </button>
                <button
                  type="button"
                  onClick={onJumpToNext}
                  className="inline-flex items-center gap-1 h-7 px-2 text-sm font-medium border border-amber-300 text-amber-900 bg-white rounded hover:bg-amber-100"
                  title="Jump to the next unfilled required field (⌘/Ctrl + J)"
                >
                  <Target className="w-3 h-3" />
                  Jump to next
                  <kbd className="ml-1 px-1 py-px text-xs bg-amber-100 border border-amber-200 rounded font-mono text-amber-900">
                    ⌘J
                  </kbd>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Progress bar */}
        <div className="mt-2 h-1.5 w-full bg-white/60 rounded overflow-hidden">
          <div
            className={cn(
              'h-full transition-all',
              allReady ? 'bg-emerald-500' : 'bg-amber-500',
            )}
            style={{ width: `${pct}%` }}
          />
        </div>

        {/* Expanded per-channel detail */}
        {expanded && !allReady && (
          <div
            id="validation-summary-detail"
            className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2"
          >
            {perChannel.map((c) => {
              const channelUnsatisfied = groupedByChannel.get(c.channelKey)?.length ?? 0
              const channelPct = c.required === 0 ? 100 : Math.round((c.filled / c.required) * 100)
              const isActive = activeTab === c.channelKey
              const ready = channelUnsatisfied === 0
              return (
                <button
                  key={c.channelKey}
                  type="button"
                  onClick={() => onTabChange(c.channelKey)}
                  className={cn(
                    'text-left border rounded-md px-2 py-1.5 transition-colors',
                    isActive
                      ? 'border-blue-400 bg-blue-50/50 ring-1 ring-blue-200'
                      : ready
                      ? 'border-emerald-200 bg-white hover:bg-emerald-50'
                      : 'border-amber-200 bg-white hover:bg-amber-50',
                  )}
                  title={`Switch to ${c.channelKey} tab${ready ? '' : ` — ${channelUnsatisfied} unfilled`}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-sm text-slate-900 truncate">
                      {c.channelKey}
                    </span>
                    <span
                      className={cn(
                        'text-xs font-semibold tabular-nums flex-shrink-0',
                        ready ? 'text-emerald-700' : 'text-amber-700',
                      )}
                    >
                      {c.filled}/{c.required}
                    </span>
                  </div>
                  <div className="mt-1 h-1 w-full bg-slate-100 rounded overflow-hidden">
                    <div
                      className={cn('h-full', ready ? 'bg-emerald-500' : 'bg-amber-500')}
                      style={{ width: `${channelPct}%` }}
                    />
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
