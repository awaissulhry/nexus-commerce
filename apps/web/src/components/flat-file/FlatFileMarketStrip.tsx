'use client'

/**
 * FlatFileMarketStrip — shared market (IT/DE/FR/ES/UK) switcher for the
 * flat-file editors. A compact "Market" label + chip row with the active
 * market highlighted, an optional per-market unsaved-count badge, Alt+1..N
 * shortcuts, and ARIA. Modeled on the Amazon flat-file's inline switcher so
 * the two surfaces feel the same; eBay wires it in to scope the grid to one
 * market at a time.
 */

import { useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  markets: string[]
  active: string
  onSelect: (market: string) => void
  /** market → count of unsaved changes (renders an amber badge). */
  dirtyCounts?: Record<string, number>
  /** EFX P4 — markets whose rows carry data (price/qty/item id); INACTIVE
   *  chips in this list show a small dot ("Has data — switch to view"). */
  dataMarkets?: string[]
  /** market currently (re)loading — shows a spinner on that chip. */
  loadingMarket?: string | null
  /** Bind Alt+1..N to the first nine markets (default true). */
  enableShortcuts?: boolean
  label?: string
}

export function FlatFileMarketStrip({
  markets,
  active,
  onSelect,
  dirtyCounts = {},
  dataMarkets = [],
  loadingMarket = null,
  enableShortcuts = true,
  label = 'Market',
}: Props) {
  useEffect(() => {
    if (!enableShortcuts) return
    function onKey(e: KeyboardEvent) {
      if (!e.altKey || e.metaKey || e.ctrlKey) return
      // Don't hijack Alt+digit while the operator is typing in a field.
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const n = parseInt(e.key, 10)
      if (Number.isNaN(n) || n < 1 || n > Math.min(markets.length, 9)) return
      const m = markets[n - 1]
      if (m && m !== active) { e.preventDefault(); onSelect(m) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [markets, active, onSelect, enableShortcuts])

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-slate-400 font-medium">{label}</span>
      <div className="flex gap-0.5">
        {markets.map((m, idx) => {
          const isActive = active === m
          const isLoading = loadingMarket === m
          const dirty = dirtyCounts[m] ?? 0
          // EFX P4 — inactive markets whose rows carry data get a small dot.
          const hasData = !isActive && dataMarkets.includes(m)
          const hint = enableShortcuts && idx < 9 ? ` (Alt+${idx + 1})` : ''
          return (
            <button
              key={m}
              type="button"
              onClick={() => { if (!isActive) onSelect(m) }}
              aria-pressed={isActive}
              aria-label={`Switch to ${m} marketplace${hint}${dirty > 0 ? ` (${dirty} unsaved)` : ''}${hasData ? ' (has data)' : ''}`}
              title={hasData
                ? `${m} marketplace${hint} — Has data — switch to view`
                : `${m} marketplace${hint}${dirty > 0 ? ` — ${dirty} unsaved change${dirty === 1 ? '' : 's'}` : ''}`}
              className={cn(
                'inline-flex items-center text-xs font-medium px-2 py-0.5 rounded border transition-colors',
                isActive
                  ? 'bg-slate-800 text-white border-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:border-slate-100'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-slate-400',
              )}
            >
              {isLoading && <Loader2 className="w-2.5 h-2.5 mr-1 animate-spin" aria-hidden />}
              {m}
              {hasData && (
                <span
                  className="ml-1 w-1.5 h-1.5 rounded-full bg-blue-500 dark:bg-blue-400 shrink-0"
                  aria-hidden
                />
              )}
              {dirty > 0 && (
                <span className="ml-1 inline-flex items-center justify-center min-w-[14px] h-3.5 px-1 rounded-sm bg-amber-500 text-white text-[9px] font-semibold leading-none">
                  {dirty}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
