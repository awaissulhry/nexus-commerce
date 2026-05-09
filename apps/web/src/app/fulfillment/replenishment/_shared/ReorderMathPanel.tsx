'use client'

/**
 * W9.6e — Extracted from ReplenishmentWorkspace.tsx (R.4 origin).
 *
 * Reorder math snapshot panel. Shows the four primitives (EOQ,
 * safety stock, reorder point, recommended qty) plus the constraint
 * annotations that explain why the final qty is what it is. Pulled
 * from the latest ACTIVE ReplenishmentRecommendation.
 *
 * Panels rendered conditionally:
 *   - MOQ / case-pack / EOQ-below-MOQ explanation list (R.4)
 *   - Cost basis with EUR conversion when supplier quotes non-EUR (R.15)
 *   - Landed cost = unit + freight when shipping profile applied (R.19)
 *   - σ_LT term explainer when supplier has ≥3 PO observations (R.11)
 *
 * Adds dark-mode classes throughout the chrome (the inline version
 * was bright-only on the panel background, header, dividers, grid
 * labels, and explanation list rows).
 */

import type { DetailResponse } from './types'

export function ReorderMathPanel({
  rec,
}: {
  rec: NonNullable<DetailResponse['recommendation']>
}) {
  const constraints = rec.constraintsApplied ?? []
  const hasMoq = constraints.includes('MOQ_APPLIED')
  const hasCasePack = constraints.includes('CASE_PACK_ROUNDED_UP')
  const hasEoqBelowMoq = constraints.includes('EOQ_BELOW_MOQ')

  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded p-3 bg-slate-50/50 dark:bg-slate-950/40">
      <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-2">
        Reorder math
      </div>
      <div className="grid grid-cols-2 gap-y-1.5 gap-x-4 text-base">
        <div className="flex items-center justify-between">
          <span className="text-slate-500 dark:text-slate-400">EOQ</span>
          <span className="tabular-nums font-semibold text-slate-900 dark:text-slate-100">
            {rec.eoqUnits != null ? rec.eoqUnits : '—'}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-slate-500 dark:text-slate-400">Safety stock</span>
          <span className="tabular-nums font-semibold text-slate-900 dark:text-slate-100">
            {rec.safetyStockUnits != null ? rec.safetyStockUnits : '—'}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-slate-500 dark:text-slate-400">Reorder point</span>
          <span className="tabular-nums font-semibold text-slate-900 dark:text-slate-100">
            {rec.reorderPoint}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-slate-500 dark:text-slate-400">Recommended qty</span>
          <span className="tabular-nums font-bold text-slate-900 dark:text-slate-100">
            {rec.reorderQuantity}
          </span>
        </div>
      </div>
      {(hasMoq || hasCasePack || hasEoqBelowMoq) && (
        <ul className="mt-2 pt-2 border-t border-slate-200 dark:border-slate-800 space-y-0.5 text-sm text-slate-600 dark:text-slate-400">
          {hasEoqBelowMoq && (
            <li>↑ EOQ was below supplier MOQ — ordering more than the math optimum</li>
          )}
          {hasMoq && <li>↑ rounded up to supplier MOQ</li>}
          {hasCasePack && <li>↑ rounded up to case-pack multiple</li>}
        </ul>
      )}
      {rec.unitCostCents != null && (
        <div className="mt-2 pt-2 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
          {/* R.15 — show native currency + EUR conversion when supplier
              quotes in something other than EUR. */}
          {rec.unitCostCurrency && rec.unitCostCurrency !== 'EUR' && rec.fxRateUsed ? (
            <>
              Cost basis:{' '}
              <span className="font-mono">
                {(rec.unitCostCents / 100).toFixed(2)} {rec.unitCostCurrency}/unit
              </span>
              <span className="text-slate-400 dark:text-slate-500 ml-1">
                (≈{(rec.unitCostCents / 100 / Number(rec.fxRateUsed)).toFixed(2)} EUR @ 1
                EUR = {Number(rec.fxRateUsed).toFixed(4)} {rec.unitCostCurrency})
              </span>
            </>
          ) : (
            <>
              Cost basis:{' '}
              <span className="font-mono">
                {(rec.unitCostCents / 100).toFixed(2)} EUR/unit
              </span>
            </>
          )}
          {/* R.19 — landed cost (unit + freight) when a supplier
              shipping profile produced a freight allocation. Both
              already in EUR cents post-FX. */}
          {rec.freightCostPerUnitCents != null && rec.landedCostPerUnitCents != null && (
            <div className="mt-1">
              <span className="text-slate-500 dark:text-slate-400">Landed: </span>
              <span className="font-mono text-slate-700 dark:text-slate-300">
                {(rec.landedCostPerUnitCents / 100).toFixed(2)} EUR/unit
              </span>
              <span className="text-slate-400 dark:text-slate-500 ml-1">
                (= {(rec.unitCostCents / 100).toFixed(2)} unit +{' '}
                {(rec.freightCostPerUnitCents / 100).toFixed(2)} freight)
              </span>
            </div>
          )}
        </div>
      )}
      {/* R.11 — supplier lead-time variance applied. Renders only when
          σ_LT > 0 (the supplier has ≥3 PO observations); otherwise the
          formula collapses to deterministic-LT and there's nothing to
          show. */}
      {rec.leadTimeStdDevDays != null && Number(rec.leadTimeStdDevDays) > 0 && (
        <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Lead-time variance:{' '}
          <span className="font-mono">
            σ_LT = {Number(rec.leadTimeStdDevDays).toFixed(2)}d
          </span>
          <span className="text-slate-400 dark:text-slate-500">
            {' '}
            · safety stock includes σ_LT term
          </span>
        </div>
      )}
    </div>
  )
}
