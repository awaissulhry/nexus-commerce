'use client'

/**
 * IN.1 — Inheritance state badge for flat file rows.
 *
 * Shows nothing when all fields inherit from master.
 * Shows an amber chip "N ↕" when any field has an active override
 * (ChannelListing.followMaster* = false).
 *
 * Clicking opens a popover with per-field state and reset actions.
 * Reset calls PATCH /api/listings/:id { followMasterX: true } using
 * the existing endpoint — no new API surface needed.
 */

import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, GitBranch, Loader2, RotateCcw, X } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

// ── Types ─────────────────────────────────────────────────────────────

export type InheritanceState = 'INHERITED' | 'OVERRIDE'

export interface FieldStates {
  price?: InheritanceState
  title?: InheritanceState
  description?: InheritanceState
  quantity?: InheritanceState
  bulletPoints?: InheritanceState
}

export interface MasterValues {
  price?: number | null
  title?: string | null
  description?: string | null
  quantity?: number | null
}

// For eBay: per-market breakdown
export interface MarketFieldStates {
  [market: string]: { price?: InheritanceState; quantity?: InheritanceState; title?: InheritanceState }
}

interface Props {
  listingId?: string | null
  fieldStates?: FieldStates | null
  masterValues?: MasterValues | null
  // eBay-specific: per-market listing IDs + states
  marketListingIds?: Record<string, string> | null
  marketFieldStates?: MarketFieldStates | null
}

// ── Helpers ───────────────────────────────────────────────────────────

const FIELD_LABELS: Record<keyof FieldStates, string> = {
  price:        'Price',
  title:        'Title',
  description:  'Description',
  quantity:     'Quantity',
  bulletPoints: 'Bullets',
}

// Map field key → followMaster* body param name
const FOLLOW_MASTER_KEY: Record<keyof FieldStates, string> = {
  price:        'followMasterPrice',
  title:        'followMasterTitle',
  description:  'followMasterDescription',
  quantity:     'followMasterQuantity',
  bulletPoints: 'followMasterBulletPoints',
}

function countOverrides(states?: FieldStates | null): number {
  if (!states) return 0
  return Object.values(states).filter((v) => v === 'OVERRIDE').length
}

function formatMasterValue(field: keyof FieldStates, val: MasterValues | null | undefined): string | null {
  if (!val) return null
  const v = val[field as keyof MasterValues]
  if (v == null) return null
  if (field === 'price') return `€${Number(v).toFixed(2)}`
  if (typeof v === 'string' && v.length > 40) return v.slice(0, 40) + '…'
  return String(v)
}

// ── Main component ─────────────────────────────────────────────────────

export function OverrideBadge({
  listingId,
  fieldStates,
  masterValues,
  marketListingIds,
  marketFieldStates,
}: Props) {
  const overrideCount = countOverrides(fieldStates)

  // Also count market-level overrides for eBay
  const marketOverrideCount = marketFieldStates
    ? Object.values(marketFieldStates).reduce(
        (sum, mf) => sum + Object.values(mf).filter((v) => v === 'OVERRIDE').length,
        0,
      )
    : 0

  const totalOverrides = marketFieldStates ? marketOverrideCount : overrideCount
  if (totalOverrides === 0) return null

  return <OverrideBadgeInner
    listingId={listingId}
    initialFieldStates={fieldStates}
    masterValues={masterValues}
    marketListingIds={marketListingIds}
    marketFieldStates={marketFieldStates}
  />
}

// Inner component holds state (avoids hook call when badge renders nothing)
function OverrideBadgeInner({
  listingId,
  initialFieldStates,
  masterValues,
  marketListingIds,
  marketFieldStates: initialMarketFieldStates,
}: {
  listingId?: string | null
  initialFieldStates?: FieldStates | null
  masterValues?: MasterValues | null
  marketListingIds?: Record<string, string> | null
  marketFieldStates?: MarketFieldStates | null
}) {
  const [open, setOpen] = useState(false)
  const [fieldStates, setFieldStates] = useState<FieldStates | null>(initialFieldStates ?? null)
  const [marketFieldStates, setMarketFieldStates] = useState<MarketFieldStates | null>(
    initialMarketFieldStates ?? null,
  )
  const [resetting, setResetting] = useState<string | null>(null) // field key or 'all'
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const currentOverrides = marketFieldStates
    ? Object.values(marketFieldStates).reduce(
        (sum, mf) => sum + Object.values(mf).filter((v) => v === 'OVERRIDE').length,
        0,
      )
    : countOverrides(fieldStates)

  if (currentOverrides === 0) return null

  async function resetField(listId: string, field: keyof FieldStates) {
    setResetting(field)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/listings/${listId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [FOLLOW_MASTER_KEY[field]]: true }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setFieldStates((prev) => prev ? { ...prev, [field]: 'INHERITED' } : prev)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed')
    } finally {
      setResetting(null)
    }
  }

  async function resetAll() {
    if (!listingId) return
    setResetting('all')
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/listings/${listingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          followMasterPrice: true,
          followMasterTitle: true,
          followMasterDescription: true,
          followMasterQuantity: true,
          followMasterBulletPoints: true,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setFieldStates({
        price: 'INHERITED', title: 'INHERITED',
        description: 'INHERITED', quantity: 'INHERITED', bulletPoints: 'INHERITED',
      })
      setOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed')
    } finally {
      setResetting(null)
    }
  }

  async function resetMarketField(market: string, field: 'price' | 'quantity' | 'title') {
    const lId = marketListingIds?.[market]
    if (!lId) return
    const fKey = field === 'price' ? 'followMasterPrice'
      : field === 'quantity' ? 'followMasterQuantity'
      : 'followMasterTitle'
    setResetting(`${market}:${field}`)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/listings/${lId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [fKey]: true }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setMarketFieldStates((prev) =>
        prev ? { ...prev, [market]: { ...prev[market], [field]: 'INHERITED' } } : prev,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed')
    } finally {
      setResetting(null)
    }
  }

  const isEbay = !!marketFieldStates

  return (
    <div ref={ref} className="relative" onPointerDown={(e) => e.stopPropagation()}>
      {/* Chip */}
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
        className={cn(
          'flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-semibold leading-none transition-colors',
          'bg-amber-100 text-amber-700 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:hover:bg-amber-900/60',
        )}
        title={`${currentOverrides} field${currentOverrides !== 1 ? 's' : ''} overriding master`}
      >
        <GitBranch className="h-2.5 w-2.5" />
        {currentOverrides}
      </button>

      {/* Popover */}
      {open && (
        <div
          className={cn(
            'absolute left-0 top-full mt-1 z-50 min-w-[220px] rounded-lg border border-slate-200 dark:border-slate-700',
            'bg-white dark:bg-slate-900 shadow-lg overflow-hidden',
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100 dark:border-slate-800">
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
              Field Overrides
            </span>
            <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Field list — single listing (Amazon) */}
          {!isEbay && fieldStates && (
            <div className="divide-y divide-slate-50 dark:divide-slate-800">
              {(Object.entries(fieldStates) as Array<[keyof FieldStates, InheritanceState]>).map(
                ([field, state]) => {
                  const masterVal = formatMasterValue(field, masterValues)
                  return (
                    <div key={field} className="flex items-center gap-2 px-3 py-1.5">
                      <span className="text-xs text-slate-600 dark:text-slate-400 w-20 shrink-0">
                        {FIELD_LABELS[field]}
                      </span>
                      {state === 'INHERITED' ? (
                        <span className="flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
                          <CheckCircle2 className="h-3 w-3" /> Inherited
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400 flex-1">
                          <GitBranch className="h-3 w-3" /> Override
                          {masterVal && <span className="text-slate-400 ml-1">↩{masterVal}</span>}
                        </span>
                      )}
                      {state === 'OVERRIDE' && listingId && (
                        <button
                          onClick={() => resetField(listingId, field)}
                          disabled={!!resetting}
                          className="ml-auto shrink-0 text-[10px] text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50 flex items-center gap-0.5"
                          title={`Reset ${FIELD_LABELS[field]} to master value`}
                        >
                          {resetting === field
                            ? <Loader2 className="h-3 w-3 animate-spin" />
                            : <RotateCcw className="h-3 w-3" />}
                        </button>
                      )}
                    </div>
                  )
                },
              )}
            </div>
          )}

          {/* Field list — per market (eBay) */}
          {isEbay && marketFieldStates && (
            <div className="divide-y divide-slate-50 dark:divide-slate-800 max-h-52 overflow-y-auto">
              {Object.entries(marketFieldStates).map(([market, states]) => {
                const marketOverrides = Object.values(states).filter((v) => v === 'OVERRIDE').length
                if (marketOverrides === 0) return null
                return (
                  <div key={market} className="px-3 py-1.5">
                    <div className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 mb-1">
                      {market}
                    </div>
                    {(Object.entries(states) as Array<['price' | 'quantity' | 'title', InheritanceState]>).map(
                      ([field, state]) =>
                        state === 'OVERRIDE' ? (
                          <div key={field} className="flex items-center gap-2">
                            <span className="text-[10px] text-amber-600 dark:text-amber-400 capitalize flex-1">
                              {field} overridden
                            </span>
                            <button
                              onClick={() => resetMarketField(market, field)}
                              disabled={!!resetting}
                              className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50"
                            >
                              {resetting === `${market}:${field}`
                                ? <Loader2 className="h-3 w-3 animate-spin" />
                                : <RotateCcw className="h-3 w-3" />}
                            </button>
                          </div>
                        ) : null,
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="px-3 py-1.5 text-[10px] text-red-600 dark:text-red-400 border-t border-slate-100 dark:border-slate-800">
              {error}
            </div>
          )}

          {/* Reset all — single listing only */}
          {!isEbay && listingId && countOverrides(fieldStates) > 0 && (
            <div className="px-3 py-2 border-t border-slate-100 dark:border-slate-800">
              <button
                onClick={resetAll}
                disabled={!!resetting}
                className="w-full flex items-center justify-center gap-1.5 text-[10px] font-medium text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50"
              >
                {resetting === 'all'
                  ? <Loader2 className="h-3 w-3 animate-spin" />
                  : <RotateCcw className="h-3 w-3" />}
                Reset all to master
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
