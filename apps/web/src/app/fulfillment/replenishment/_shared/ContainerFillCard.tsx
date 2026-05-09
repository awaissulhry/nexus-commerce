'use client'

/**
 * W9.6l — Container fill card (R.19 origin).
 *
 * Extracted from ReplenishmentWorkspace.tsx. Supplier-level
 * container fill summary. One row per supplier with a
 * SupplierShippingProfile. Surfaces fill %, freight cost, and
 * top-up suggestions to push toward 100% container utilization.
 *
 * The ContainerFillEntry shape is exported so the workspace's
 * ReplenishmentResponse type can reference it without circular
 * import.
 *
 * Adds dark-mode classes throughout (per-supplier card surface,
 * fill bar track, top-up list, freight-cost subline).
 */

import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/utils'

export interface ContainerFillEntry {
  supplierId: string
  supplierName: string
  mode: 'AIR' | 'SEA_LCL' | 'SEA_FCL_20' | 'SEA_FCL_40' | 'ROAD'
  totalCbm: number
  totalKg: number
  fillPercentByCbm: number | null
  fillPercentByWeight: number | null
  freightCostCents: number
  topUpSuggestions: Array<{
    productId: string
    sku: string
    addUnits: number
    marginalFreightSavedCents: number
  }>
}

export function ContainerFillCard({
  entries,
}: {
  entries: ContainerFillEntry[]
}) {
  return (
    <Card className="p-4 mb-3">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
          Container fill
        </span>
        <span className="text-xs text-slate-400 dark:text-slate-500">
          {entries.length} supplier{entries.length === 1 ? '' : 's'} with shipping
          profile
        </span>
      </div>
      <div className="space-y-3">
        {entries.map((e) => {
          const isFcl = e.mode === 'SEA_FCL_20' || e.mode === 'SEA_FCL_40'
          const fill = e.fillPercentByCbm ?? null
          const fillColor =
            fill == null
              ? 'bg-slate-300 dark:bg-slate-700'
              : fill >= 90
                ? 'bg-emerald-500 dark:bg-emerald-600'
                : fill >= 70
                  ? 'bg-sky-500 dark:bg-sky-600'
                  : 'bg-amber-500 dark:bg-amber-600'
          return (
            <div
              key={e.supplierId}
              className="border border-slate-200 dark:border-slate-800 rounded p-2"
            >
              <div className="flex items-center justify-between text-base mb-1.5">
                <span className="font-semibold text-slate-900 dark:text-slate-100">
                  {e.supplierName}
                </span>
                <span className="text-slate-500 dark:text-slate-400 font-mono text-xs">
                  {e.mode}
                </span>
              </div>
              {isFcl && fill != null && (
                <>
                  <div className="h-2 rounded bg-slate-100 dark:bg-slate-800 overflow-hidden mb-1">
                    <div
                      className={cn('h-full', fillColor)}
                      style={{ width: `${Math.min(100, fill)}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-sm text-slate-500 dark:text-slate-400">
                    <span>{fill.toFixed(1)}% by volume</span>
                    <span className="font-mono">
                      {e.totalCbm.toFixed(2)} m³ ·{' '}
                      {(e.freightCostCents / 100).toFixed(0)} EUR
                    </span>
                  </div>
                </>
              )}
              {!isFcl && (
                <div className="flex items-center justify-between text-sm text-slate-500 dark:text-slate-400">
                  <span className="font-mono">
                    {e.totalCbm.toFixed(2)} m³ · {e.totalKg.toFixed(0)} kg
                  </span>
                  <span className="font-mono">
                    {(e.freightCostCents / 100).toFixed(0)} EUR freight
                  </span>
                </div>
              )}
              {e.topUpSuggestions.length > 0 && (
                <div className="mt-2 pt-2 border-t border-slate-200 dark:border-slate-800">
                  <div className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">
                    Top-up suggestions
                  </div>
                  <ul className="space-y-0.5">
                    {e.topUpSuggestions.slice(0, 3).map((t) => (
                      <li
                        key={t.productId}
                        className="text-sm flex items-center justify-between"
                      >
                        <span className="font-mono truncate text-slate-700 dark:text-slate-300">
                          {t.sku}
                        </span>
                        <span className="text-slate-600 dark:text-slate-400">
                          +{t.addUnits}u → save{' '}
                          <span className="text-emerald-700 dark:text-emerald-400 font-semibold">
                            €{(t.marginalFreightSavedCents / 100).toFixed(0)}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Card>
  )
}
