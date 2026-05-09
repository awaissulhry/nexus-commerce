'use client'

import { RefreshCw } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import RelativeTimestamp from './RelativeTimestamp'
import { WINDOWS, type T, type WindowKey } from '../_lib/types'

/**
 * Command Center page header. Title + subtitle on the left, window
 * selector + refresh + last-refreshed timestamp on the right via
 * PageHeader's `actions` slot.
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
  lastRefreshed,
  refreshing,
  onRefresh,
}: {
  t: T
  currentWindow: WindowKey
  onWindowChange: (w: WindowKey) => void
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
