'use client'

import { RefreshCw } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import RelativeTimestamp from './RelativeTimestamp'
import {
  COMPARES,
  WINDOWS,
  type CompareKey,
  type T,
  type WindowKey,
} from '../_lib/types'

/**
 * Command Center page header. Title + subtitle on the left, window
 * selector + comparison-period dropdown + refresh + last-refreshed
 * timestamp on the right via PageHeader's `actions` slot.
 *
 * Window selector stays as a custom inline pill cluster — Button
 * carries chrome (border, focus ring, h-7) that would break the
 * tight 5-segment pill look. Refresh wears the standard Button to
 * pick up dark-mode + focus-ring + loading state for free.
 */
export default function Header({
  t,
  currentWindow,
  onWindowChange,
  currentCompare,
  onCompareChange,
  lastRefreshed,
  refreshing,
  onRefresh,
}: {
  t: T
  currentWindow: WindowKey
  onWindowChange: (w: WindowKey) => void
  currentCompare: CompareKey
  onCompareChange: (c: CompareKey) => void
  lastRefreshed: number
  refreshing: boolean
  onRefresh: () => void
}) {
  return (
    <PageHeader
      title={t('overview.title')}
      description={t('overview.subtitle')}
      actions={
        <>
          <div
            role="tablist"
            aria-label={t('overview.title')}
            className="inline-flex items-center border border-slate-200 dark:border-slate-700 rounded-md p-0.5 bg-white dark:bg-slate-900"
          >
            {WINDOWS.map((w) => (
              <button
                key={w.id}
                type="button"
                role="tab"
                aria-selected={w.id === currentWindow}
                onClick={() => onWindowChange(w.id)}
                className={cn(
                  'h-6 px-2.5 text-sm rounded transition-colors',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
                  w.id === currentWindow
                    ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-semibold'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100',
                )}
              >
                {t(`overview.window.${w.id}`)}
              </button>
            ))}
          </div>
          {/* DO.11 — comparison-period dropdown. Native <select> is
              the right primitive here: it wears the platform's
              keyboard / screen-reader affordances for free, mobile
              gives a wheel picker, and the option set is small. */}
          <select
            aria-label={t('overview.compare.aria')}
            value={currentCompare}
            onChange={(e) => onCompareChange(e.target.value as CompareKey)}
            className={cn(
              'h-7 pl-2 pr-7 text-sm rounded-md border bg-white dark:bg-slate-900',
              'border-slate-200 dark:border-slate-700',
              'text-slate-700 dark:text-slate-300',
              'hover:bg-slate-50 dark:hover:bg-slate-800',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
            )}
          >
            {COMPARES.map((c) => (
              <option key={c.id} value={c.id}>
                {t('overview.compare.prefix')} {t(`overview.compare.${c.id}`)}
              </option>
            ))}
          </select>
          <Button
            variant="secondary"
            size="sm"
            onClick={onRefresh}
            loading={refreshing}
            icon={!refreshing ? <RefreshCw className="w-3 h-3" /> : undefined}
          >
            {t('overview.refresh')}
          </Button>
          <RelativeTimestamp t={t} at={lastRefreshed} />
        </>
      }
    />
  )
}
