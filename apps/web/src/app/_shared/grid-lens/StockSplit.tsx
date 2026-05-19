'use client'

import { Lock } from 'lucide-react'

export type StockSplitProps = {
  fba: number | null | undefined
  fbm: number | null | undefined
  /** Tiny variant — single line, separator-delimited. Use in dense cells. */
  inline?: boolean
  /** When true, both values render in muted slate (no traffic-light tone). */
  muted?: boolean
  /** Low-stock cutoff for the FBM tone. Defaults to undefined (no tone). */
  fbmLowThreshold?: number
}

function toneFor(n: number, threshold?: number): string {
  if (threshold === undefined) return 'text-slate-700 dark:text-slate-200'
  if (n === 0) return 'text-rose-600 dark:text-rose-400'
  if (n <= 5) return 'text-orange-600 dark:text-orange-400'
  if (n <= threshold) return 'text-amber-600 dark:text-amber-400'
  return 'text-slate-700 dark:text-slate-200'
}

export function StockSplit({ fba, fbm, inline, muted, fbmLowThreshold }: StockSplitProps) {
  const fbaQty = fba ?? 0
  const fbmQty = fbm ?? 0
  const fbaTone = muted ? 'text-slate-400 dark:text-slate-500' : 'text-orange-700 dark:text-orange-400'
  const fbmTone = muted ? 'text-slate-400 dark:text-slate-500' : toneFor(fbmQty, fbmLowThreshold)

  if (inline) {
    return (
      <span className="text-xs tabular-nums whitespace-nowrap">
        <span className={`font-semibold ${fbaTone}`}>{fbaQty}</span>
        <span className="text-[10px] uppercase tracking-wider ml-0.5 text-slate-400 dark:text-slate-500">FBA</span>
        <Lock size={9} className="inline ml-0.5 -mt-0.5 text-slate-300 dark:text-slate-600" />
        <span className="mx-1 text-slate-300 dark:text-slate-600">·</span>
        <span className={`font-semibold ${fbmTone}`}>{fbmQty}</span>
        <span className="text-[10px] uppercase tracking-wider ml-0.5 text-slate-400 dark:text-slate-500">FBM</span>
      </span>
    )
  }

  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1.5 text-sm tabular-nums">
        <span className={`font-semibold ${fbaTone}`}>{fbaQty}</span>
        <span className="text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500">FBA</span>
        <Lock size={10} className="text-slate-300 dark:text-slate-600" aria-label="Amazon-managed; read-only" />
      </div>
      <div className="flex items-center gap-1.5 text-sm tabular-nums">
        <span className={`font-semibold ${fbmTone}`}>{fbmQty}</span>
        <span className="text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500">FBM</span>
      </div>
    </div>
  )
}
