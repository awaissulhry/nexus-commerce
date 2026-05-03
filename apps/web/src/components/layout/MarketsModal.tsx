'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Plug, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'

// Region groupings for the modal. Order matters — Europe first since
// it's Xavia's primary, then Americas, then MEA, then Asia-Pacific.
// A code that doesn't appear here falls into "Other".
const REGIONS: ReadonlyArray<{ name: string; codes: ReadonlyArray<string> }> = [
  {
    name: 'Europe',
    codes: ['IT', 'DE', 'FR', 'ES', 'UK', 'NL', 'SE', 'PL', 'BE', 'AT', 'CH', 'IE', 'TR'],
  },
  { name: 'Americas', codes: ['US', 'CA', 'MX', 'BR'] },
  { name: 'Middle East', codes: ['AE', 'SA'] },
  { name: 'Asia-Pacific', codes: ['JP', 'AU', 'HK', 'SG', 'MY'] },
]

interface Props {
  open: boolean
  onClose: () => void
  channelLabel: string
  channelPath: string
  /** Merged supported + actual counts (Map<marketCode, count>). */
  markets: Map<string, number>
  countryNames: Record<string, string>
  /** Only meaningful for channels with single-token OAuth (eBay).
   *  When set, drives the status dot + "Connect" link affordance. */
  connectionStatus?: 'connected' | 'not-connected'
}

export default function MarketsModal({
  open,
  onClose,
  channelLabel,
  channelPath,
  markets,
  countryNames,
  connectionStatus,
}: Props) {
  const [search, setSearch] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus search on open; reset query on close so reopening is clean.
  useEffect(() => {
    if (!open) {
      setSearch('')
      return
    }
    inputRef.current?.focus()
  }, [open])

  // Esc-to-close + body scroll lock while open.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open, onClose])

  // Group + filter (memoized — search runs entirely client-side, no
  // API calls per keystroke).
  const grouped = useMemo(() => {
    if (!open) return []
    const q = search.trim().toLowerCase()
    const matches = (code: string) => {
      if (!q) return true
      const name = (countryNames[code] ?? code).toLowerCase()
      return code.toLowerCase().includes(q) || name.includes(q)
    }
    const claimed = new Set<string>()
    const out: Array<{ name: string; rows: Array<[string, number]> }> = []
    for (const region of REGIONS) {
      const rows: Array<[string, number]> = []
      for (const code of region.codes) {
        if (!markets.has(code)) continue
        if (!matches(code)) continue
        rows.push([code, markets.get(code) ?? 0])
        claimed.add(code)
      }
      if (rows.length > 0) out.push({ name: region.name, rows })
    }
    // Catch-all for codes the channel supports but we haven't placed
    // in a region. Keeps the modal honest as new marketplaces land.
    const orphans: Array<[string, number]> = []
    for (const [code, count] of markets) {
      if (claimed.has(code)) continue
      if (!matches(code)) continue
      orphans.push([code, count])
    }
    if (orphans.length > 0) out.push({ name: 'Other', rows: orphans })
    return out
  }, [open, search, markets, countryNames])

  if (!open) return null

  const totalShown = grouped.reduce((acc, g) => acc + g.rows.length, 0)
  const totalAll = markets.size

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 backdrop-blur-sm pt-[8vh] px-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`All ${channelLabel} markets`}
    >
      <div
        className="bg-white rounded-lg shadow-xl border border-slate-200 w-[560px] max-w-[92vw] flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 flex-shrink-0">
          <div>
            <h2 className="text-[15px] font-semibold text-slate-900">
              All {channelLabel} markets
            </h2>
            <p className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
              {totalAll} marketplace{totalAll === 1 ? '' : 's'}
              {search.trim() && totalShown !== totalAll && (
                <span className="text-slate-400">
                  {' '}
                  · {totalShown} matching
                </span>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 -mr-1 p-1 rounded hover:bg-slate-50"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search */}
        <div className="px-5 py-3 border-b border-slate-100 flex-shrink-0">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by country or code…"
              className="w-full h-8 pl-7 pr-3 text-[13px] border border-slate-200 rounded-md bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {grouped.length === 0 ? (
            <div className="px-5 py-8 text-center text-[13px] text-slate-500">
              No markets match &quot;{search}&quot;.
            </div>
          ) : (
            grouped.map((region) => (
              <div key={region.name} className="mb-3 last:mb-0">
                <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  {region.name}
                </div>
                <div className="space-y-0.5">
                  {region.rows.map(([code, count]) => {
                    const dotClass =
                      connectionStatus === 'connected'
                        ? count > 0
                          ? 'bg-emerald-500'
                          : 'bg-amber-500'
                        : connectionStatus === 'not-connected'
                          ? 'bg-slate-300'
                          : null
                    const isConnected =
                      connectionStatus !== 'not-connected'
                    return (
                      <Link
                        key={code}
                        href={`${channelPath}/${code.toLowerCase()}`}
                        onClick={onClose}
                        className="flex items-center gap-3 px-3 py-1.5 rounded-md text-[13px] text-slate-700 hover:bg-slate-50 transition-colors"
                      >
                        {dotClass && (
                          <span
                            className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', dotClass)}
                            aria-hidden="true"
                          />
                        )}
                        <span className="font-mono text-[11px] font-semibold bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded">
                          {code}
                        </span>
                        <span className="flex-1 truncate">
                          {countryNames[code] ?? code}
                        </span>
                        {!isConnected ? (
                          <span className="text-[11px] text-blue-700 inline-flex items-center gap-1">
                            <Plug className="w-3 h-3" />
                            Connect
                          </span>
                        ) : count > 0 ? (
                          <span className="text-[11px] tabular-nums text-slate-600">
                            {count} active
                          </span>
                        ) : (
                          <span className="text-[11px] text-slate-400">
                            0 listings
                          </span>
                        )}
                      </Link>
                    )
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        {connectionStatus === 'not-connected' && (
          <div className="px-5 py-3 border-t border-slate-100 flex-shrink-0">
            <Link
              href="/settings/channels"
              onClick={onClose}
              className="inline-flex items-center gap-1.5 text-[12px] text-blue-700 hover:text-blue-900"
            >
              <Plug className="w-3.5 h-3.5" />
              Connect {channelLabel} to enable listings
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}
