'use client'

/**
 * PullHistoryDrawer — Phase 4
 *
 * Side drawer showing the last N applied pulls for the current channel
 * + marketplace. Backed by GET /api/flat-file/pull-history. Each entry
 * exposes a "Re-pull" action so the operator can rerun the same scope
 * + column groups against current eBay/Amazon data with one click —
 * the editor wires the callback into its existing pull-job kickoff.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle, History, RefreshCw, Repeat, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import { Button } from '@/components/ui/Button'
import {
  GROUP_BADGE_CLASS,
  GROUP_LABEL,
  type PullGroupId,
} from './pull-field-groups'

export interface PullHistoryRecord {
  id: string
  channel: 'AMAZON' | 'EBAY' | string
  marketplace: string
  productType: string
  jobId: string | null
  skusRequested: string[]
  skusReturned: number
  columnsApplied: string[]   // PullGroupId[] | ['all']
  rowsApplied: number
  fieldsApplied: number
  appliedAt: string | null
  pulledAt: string
  operatorNote: string | null
}

export interface PullHistoryDrawerProps {
  open: boolean
  channel: 'AMAZON' | 'EBAY'
  marketplace: string
  productType?: string                  // Amazon only — eBay ignores
  onRePull: (rec: PullHistoryRecord) => void
  onClose: () => void
}

const RELATIVE_FORMATTER = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

function relativeTime(iso: string | null): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (!then || isNaN(then)) return ''
  const deltaSec = Math.round((then - Date.now()) / 1000)
  const abs = Math.abs(deltaSec)
  if (abs < 60)    return RELATIVE_FORMATTER.format(deltaSec, 'second')
  if (abs < 3600)  return RELATIVE_FORMATTER.format(Math.round(deltaSec / 60), 'minute')
  if (abs < 86400) return RELATIVE_FORMATTER.format(Math.round(deltaSec / 3600), 'hour')
  return RELATIVE_FORMATTER.format(Math.round(deltaSec / 86400), 'day')
}

function absoluteTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '' : d.toLocaleString()
}

export function PullHistoryDrawer({
  open, channel, marketplace, productType, onRePull, onClose,
}: PullHistoryDrawerProps) {
  const [records, setRecords] = useState<PullHistoryRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const drawerRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ channel, marketplace, limit: '25' })
      if (channel === 'AMAZON' && productType) params.set('productType', productType)
      const res = await fetch(`${getBackendUrl()}/api/flat-file/pull-history?${params.toString()}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      setRecords(Array.isArray(data.records) ? data.records : [])
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load history')
    } finally {
      setLoading(false)
    }
  }, [channel, marketplace, productType])

  // Load on open and on filter change.
  useEffect(() => {
    if (open) void load()
  }, [open, load])

  // Click-outside / Esc to close.
  useEffect(() => {
    if (!open) return
    function onMouse(e: MouseEvent) {
      if (!drawerRef.current?.contains(e.target as Node)) onClose()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onMouse, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onMouse, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[65] bg-black/30 backdrop-blur-[1px]">
      <div
        ref={drawerRef}
        className="absolute right-0 top-0 h-full w-[440px] max-w-full bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-700 shadow-2xl flex flex-col"
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between flex-shrink-0">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
              <History className="w-4 h-4 text-blue-600" />
              Pull history
              <span className="text-xs font-normal text-slate-500">
                · {channel === 'AMAZON' ? 'Amazon' : 'eBay'} {marketplace}
              </span>
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Last {records.length || 0} applied pull{records.length === 1 ? '' : 's'}
              {channel === 'AMAZON' && productType && <> · {productType}</>}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void load()}
              className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded"
              title="Refresh"
              disabled={loading}
            >
              <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded"
              title="Close (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
          {error && (
            <div className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded p-3">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {!loading && !error && records.length === 0 && (
            <div className="text-center py-10 text-sm text-slate-500 dark:text-slate-400">
              No applied pulls yet. Run "Pull from {channel === 'AMAZON' ? 'Amazon' : 'eBay'}" and apply changes to see them here.
            </div>
          )}

          {records.map((rec) => {
            const isAllCols = rec.columnsApplied.includes('all') || rec.columnsApplied.length === 0
            const cols = rec.columnsApplied.filter((c) => c !== 'all') as PullGroupId[]
            return (
              <div
                key={rec.id}
                className="border border-slate-200 dark:border-slate-700 rounded-lg p-3 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-600 transition-colors"
              >
                {/* Top row: time + re-pull */}
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="text-xs text-slate-700 dark:text-slate-200">
                    <span className="font-medium">{relativeTime(rec.appliedAt ?? rec.pulledAt)}</span>
                    <span className="text-slate-400 ml-1.5">
                      {absoluteTime(rec.appliedAt ?? rec.pulledAt)}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onRePull(rec)}
                    title="Re-pull these SKUs with the same scope and columns"
                    className="text-xs h-6 px-2"
                  >
                    <Repeat className="w-3 h-3 mr-1" />
                    Re-pull
                  </Button>
                </div>

                {/* Stats */}
                <div className="flex items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400 mb-2">
                  <span>
                    <span className="text-slate-800 dark:text-slate-200 font-medium">{rec.skusRequested.length}</span> requested
                  </span>
                  <span>
                    <span className="text-slate-800 dark:text-slate-200 font-medium">{rec.skusReturned}</span> returned
                  </span>
                  <span>
                    <span className="text-slate-800 dark:text-slate-200 font-medium">{rec.rowsApplied}</span> applied
                  </span>
                  <span>
                    <span className="text-slate-800 dark:text-slate-200 font-medium">{rec.fieldsApplied}</span> cells
                  </span>
                </div>

                {/* Column groups */}
                <div className="flex flex-wrap gap-1 mb-2">
                  {isAllCols ? (
                    <span className="text-[10px] font-medium uppercase px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      All columns
                    </span>
                  ) : cols.length === 0 ? (
                    <span className="text-[10px] italic text-slate-400">no column data</span>
                  ) : cols.map((c) => (
                    <span
                      key={c}
                      className={cn(
                        'text-[10px] font-medium uppercase px-1.5 py-0.5 rounded',
                        GROUP_BADGE_CLASS[c] ?? GROUP_BADGE_CLASS.other,
                      )}
                    >
                      {GROUP_LABEL[c] ?? c}
                    </span>
                  ))}
                </div>

                {/* SKUs preview */}
                {rec.skusRequested.length > 0 && (
                  <div className="text-[10px] font-mono text-slate-500 dark:text-slate-400 truncate">
                    {rec.skusRequested.slice(0, 3).join(', ')}
                    {rec.skusRequested.length > 3 && ` + ${rec.skusRequested.length - 3} more`}
                  </div>
                )}

                {rec.operatorNote && (
                  <div className="text-[11px] text-slate-600 dark:text-slate-300 mt-1.5 italic">
                    "{rec.operatorNote}"
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
