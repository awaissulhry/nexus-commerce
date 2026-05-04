// Bottom-of-grid status row: save status on the left, selection stats
// + copy flash + initial-fetch timing on the right.

import { AlertCircle, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatMetric } from '../lib/grid-columns'
import type { SaveStatus, SelectionMetrics } from '../lib/types'

export function StatusBar({
  status,
  pendingCount,
  fetchMs,
  loading,
  selectedCellCount,
  selectionMetrics,
  copyFlashCount,
}: {
  status: SaveStatus
  pendingCount: number
  fetchMs: number | null
  loading: boolean
  /** 0 when nothing is selected; otherwise how many cells the
   *  current range covers. */
  selectedCellCount: number
  /** Step 6: Sum/Avg/Min/Max etc. Null when no selection or only
   *  the large-selection count is available. */
  selectionMetrics: SelectionMetrics | null
  /** Non-null for ~2s after a successful copy — drives the green
   *  "Copied N cells" pill. */
  copyFlashCount: number | null
}) {
  const left = (() => {
    if (loading) return <span>Fetching…</span>
    if (status.kind === 'saving')
      return (
        <span>
          Saving {pendingCount} change{pendingCount === 1 ? '' : 's'}…
        </span>
      )
    if (status.kind === 'saved')
      return (
        <span className="flex items-center gap-1.5 text-green-700">
          <CheckCircle2 className="w-3 h-3" />
          Saved {status.count} change{status.count === 1 ? '' : 's'}
        </span>
      )
    if (status.kind === 'partial')
      return (
        <span className="flex items-center gap-1.5 text-amber-700">
          <AlertCircle className="w-3 h-3" />
          Saved {status.saved}, {status.failed} failed — see red cells
        </span>
      )
    if (status.kind === 'error')
      return (
        <span className="flex items-center gap-1.5 text-red-700">
          <AlertCircle className="w-3 h-3" />
          Save failed: {status.message}
        </span>
      )
    if (pendingCount > 0)
      return (
        <span>
          {pendingCount} unsaved change{pendingCount === 1 ? '' : 's'} ·{' '}
          <kbd className="text-[10px] bg-slate-100 px-1 rounded">Cmd+S</kbd>{' '}
          to save
        </span>
      )
    return <span>All changes saved</span>
  })()

  return (
    <div
      className={cn(
        'flex-shrink-0 mt-2 flex items-center justify-between text-[11px] px-1',
        status.kind === 'saved' && 'text-green-700',
        status.kind === 'partial' && 'text-amber-700',
        status.kind === 'error' && 'text-red-700',
        status.kind !== 'saved' &&
          status.kind !== 'partial' &&
          status.kind !== 'error' &&
          'text-slate-500',
      )}
    >
      <span className="flex items-center gap-1.5">{left}</span>
      <span className="flex items-center gap-2 text-slate-500 text-[12px]">
        {copyFlashCount != null ? (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-green-50 border border-green-200 rounded">
            <CheckCircle2 className="w-3 h-3 text-green-600" />
            <span className="text-green-900 tabular-nums">
              Copied {copyFlashCount} cell{copyFlashCount === 1 ? '' : 's'}
            </span>
          </span>
        ) : selectedCellCount > 0 ? (
          <>
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-blue-50 border border-blue-200 rounded">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-600" />
              <span className="text-blue-900 tabular-nums">
                {selectedCellCount === 1
                  ? '1 cell · Enter or type to edit'
                  : `${selectedCellCount} cells`}
              </span>
            </span>
            {selectionMetrics?.isLarge && (
              <span className="text-slate-400 italic">
                large selection — metrics off
              </span>
            )}
            {selectionMetrics &&
              !selectionMetrics.isLarge &&
              selectionMetrics.numericCount !== undefined &&
              selectionMetrics.numericCount > 0 && (
                <>
                  <span className="text-slate-300">·</span>
                  <span className="text-slate-500">Sum:</span>
                  <span className="font-semibold text-slate-700 tabular-nums">
                    {formatMetric(selectionMetrics.sum!)}
                  </span>
                  <span className="text-slate-300">·</span>
                  <span className="text-slate-500">Avg:</span>
                  <span className="font-semibold text-slate-700 tabular-nums">
                    {formatMetric(selectionMetrics.avg!)}
                  </span>
                  <span className="text-slate-300">·</span>
                  <span className="text-slate-500">Min:</span>
                  <span className="font-semibold text-slate-700 tabular-nums">
                    {formatMetric(selectionMetrics.min!)}
                  </span>
                  <span className="text-slate-300">·</span>
                  <span className="text-slate-500">Max:</span>
                  <span className="font-semibold text-slate-700 tabular-nums">
                    {formatMetric(selectionMetrics.max!)}
                  </span>
                  {selectionMetrics.numericCount <
                    selectionMetrics.count && (
                    <span className="text-slate-400 italic">
                      ({selectionMetrics.numericCount} numeric)
                    </span>
                  )}
                </>
              )}
          </>
        ) : null}
        {fetchMs != null && <span>Initial fetch: {fetchMs}ms</span>}
      </span>
    </div>
  )
}
