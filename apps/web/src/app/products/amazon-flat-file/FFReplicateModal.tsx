'use client'

import { useEffect, useState } from 'react'
import { ArrowRight, CheckCircle2, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'

const MARKETPLACES = ['IT', 'DE', 'FR', 'ES', 'UK']

interface ColumnGroup { id: string; labelEn: string; color: string }

interface Props {
  open: boolean
  onClose: () => void
  sourceMarket: string
  groups: ColumnGroup[]
  rowCount: number
  selectedRowCount: number
  /** Called when user confirms. Parent handles the actual copy. */
  onReplicate: (
    targets: string[],
    groupIds: Set<string>,
    selectedOnly: boolean,
  ) => Promise<{ copied: number; skipped: number }>
}

export function FFReplicateModal({
  open, onClose, sourceMarket, groups, rowCount, selectedRowCount, onReplicate,
}: Props) {
  const [targets, setTargets] = useState<string[]>([])
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set())
  const [allGroups, setAllGroups] = useState(true)
  const [scope, setScope] = useState<'all' | 'selected'>('all')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ copied: number; skipped: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Reset on open
  useEffect(() => {
    if (open) {
      setTargets([])
      setSelectedGroups(new Set())
      setAllGroups(true)
      setScope(selectedRowCount > 0 ? 'selected' : 'all')
      setRunning(false)
      setResult(null)
      setError(null)
    }
  }, [open, selectedRowCount])

  // Esc to close
  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !running) onClose() }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [open, running, onClose])

  const toggleTarget = (mp: string) =>
    setTargets((prev) => prev.includes(mp) ? prev.filter((x) => x !== mp) : [...prev, mp])

  const toggleGroup = (id: string) => {
    if (allGroups) {
      setAllGroups(false)
      setSelectedGroups(new Set(groups.map((g) => g.id).filter((x) => x !== id)))
    } else {
      setSelectedGroups((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    }
  }

  const isGroupSelected = (id: string) => allGroups || selectedGroups.has(id)

  const scopeCount = scope === 'selected' && selectedRowCount > 0 ? selectedRowCount : rowCount

  const handleRun = async () => {
    if (!targets.length) return
    setRunning(true)
    setError(null)
    try {
      const groupIds = allGroups
        ? new Set(groups.map((g) => g.id))
        : selectedGroups
      const r = await onReplicate(targets, groupIds, scope === 'selected' && selectedRowCount > 0)
      setResult(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  if (!open) return null

  const otherMarkets = MARKETPLACES.filter((mp) => mp !== sourceMarket)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={() => !running && !result && onClose()}
    >
      <div
        className="w-[560px] max-h-[90vh] bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            Replicate to other markets
          </h2>
          <button type="button" onClick={onClose} disabled={running} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">

          {/* Source → Target flow */}
          <div className="flex items-center gap-3">
            <div className="px-3 py-1.5 rounded-lg border border-blue-200 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/30 text-sm font-mono font-semibold text-blue-800 dark:text-blue-200">
              {sourceMarket}
            </div>
            <ArrowRight className="w-4 h-4 text-slate-400 flex-shrink-0" />
            <div className="flex flex-wrap gap-1.5">
              {otherMarkets.map((mp) => (
                <button
                  key={mp}
                  type="button"
                  onClick={() => toggleTarget(mp)}
                  className={cn(
                    'px-3 py-1.5 rounded-lg border text-sm font-mono font-medium transition-colors',
                    targets.includes(mp)
                      ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-200'
                      : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-slate-400',
                  )}
                >
                  {mp}
                </button>
              ))}
            </div>
            {targets.length > 1 && (
              <button type="button" onClick={() => setTargets([])} className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 flex-shrink-0">
                Clear
              </button>
            )}
          </div>

          {/* Scope */}
          <div>
            <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">Rows</div>
            <div className="flex gap-3">
              <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                <input type="radio" checked={scope === 'all'} onChange={() => setScope('all')}
                  className="w-3.5 h-3.5 border-slate-300 text-blue-600 focus:ring-blue-500" />
                All rows ({rowCount})
              </label>
              <label className={cn('flex items-center gap-2 text-xs cursor-pointer', selectedRowCount > 0 ? 'text-slate-700 dark:text-slate-300' : 'text-slate-400 dark:text-slate-500 cursor-not-allowed')}>
                <input type="radio" checked={scope === 'selected'} onChange={() => setScope('selected')}
                  disabled={selectedRowCount === 0}
                  className="w-3.5 h-3.5 border-slate-300 text-blue-600 focus:ring-blue-500" />
                Selected only ({selectedRowCount})
              </label>
            </div>
          </div>

          {/* Field groups */}
          {groups.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Field groups</div>
                <button
                  type="button"
                  onClick={() => { setAllGroups(true); setSelectedGroups(new Set()) }}
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                >
                  All
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {groups.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => toggleGroup(g.id)}
                    className={cn(
                      'px-2 py-1 rounded text-xs border transition-colors',
                      isGroupSelected(g.id)
                        ? 'border-blue-300 dark:border-blue-600 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300'
                        : 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-slate-300',
                    )}
                  >
                    {g.labelEn}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Result / error */}
          {result && (
            <div className="flex items-start gap-2 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded-lg px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <div>
                Copied <strong>{result.copied}</strong> row{result.copied !== 1 ? 's' : ''} to{' '}
                {targets.join(', ')}.
                {result.skipped > 0 && <span className="text-amber-600 dark:text-amber-400"> {result.skipped} skipped (no data).</span>}
              </div>
            </div>
          )}
          {error && (
            <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2 text-xs text-red-700 dark:text-red-300">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 flex-shrink-0">
          <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            {scopeCount} row{scopeCount !== 1 ? 's' : ''} × {targets.length || '0'} market{targets.length !== 1 ? 's' : ''}
            {' '}= <strong className="text-slate-700 dark:text-slate-300">{scopeCount * targets.length}</strong> writes
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-8 px-3 text-sm border border-slate-200 dark:border-slate-700 rounded-lg text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
            >
              {result ? 'Close' : 'Cancel'}
            </button>
            {!result && (
              <button
                type="button"
                onClick={handleRun}
                disabled={targets.length === 0 || running}
                className="h-8 px-4 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
              >
                {running && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Replicate to {targets.length || '…'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
