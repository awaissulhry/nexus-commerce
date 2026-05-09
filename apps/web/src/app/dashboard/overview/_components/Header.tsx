'use client'

import { Loader2, RefreshCw } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { cn } from '@/lib/utils'
import RelativeTimestamp from './RelativeTimestamp'
import { WINDOWS, type T, type WindowKey } from '../_lib/types'

/**
 * Command Center page header. Title + subtitle on the left, window
 * selector + refresh + last-refreshed timestamp on the right via
 * PageHeader's `actions` slot.
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
          <div className="inline-flex items-center border border-slate-200 rounded-md p-0.5 bg-white">
            {WINDOWS.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => onWindowChange(w.id)}
                className={cn(
                  'h-6 px-2.5 text-sm rounded transition-colors',
                  w.id === currentWindow
                    ? 'bg-slate-900 text-white font-semibold'
                    : 'text-slate-600 hover:text-slate-900',
                )}
              >
                {t(`overview.window.${w.id}`)}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 h-7 px-2.5 text-sm font-medium text-slate-700 border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-50"
          >
            {refreshing ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3" />
            )}
            {t('overview.refresh')}
          </button>
          <RelativeTimestamp t={t} at={lastRefreshed} />
        </>
      }
    />
  )
}
