'use client'

/**
 * CD.10 — Profit lens. Surfaces the campaign's TRUE landed-cost profit
 * (trueProfitCents / trueProfitMarginPct already on the payload, previously
 * unused) — a real edge over Pacvue/Perpetua, which optimise on ACOS/ROAS and
 * don't natively know unit cost. Profit is lifetime-grain (per-period profit
 * isn't derivable — we lack per-period COGS on ad-attributed sales), so it is
 * labelled "lifetime" and kept distinct from the windowed KPI tiles.
 */

import { Coins } from 'lucide-react'

const eur = (c: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100)

export function CampaignProfitLens({ trueProfitCents, trueProfitMarginPct, lifetimeSpendCents }: { trueProfitCents: number; trueProfitMarginPct: string | null; lifetimeSpendCents: number }) {
  if (trueProfitCents === 0 && lifetimeSpendCents === 0) return null
  const margin = trueProfitMarginPct != null ? parseFloat(trueProfitMarginPct) : null
  const profitPerAdEur = lifetimeSpendCents > 0 ? trueProfitCents / lifetimeSpendCents : null
  const positive = trueProfitCents >= 0
  return (
    <div className="mb-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-700 dark:text-slate-200">
          <Coins size={14} className="text-emerald-500" /> Profitability <span className="text-xs font-normal text-slate-400">· lifetime · true landed-cost</span>
        </span>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-slate-400">True profit</div>
          <div className={`text-lg font-semibold tabular-nums ${positive ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>{eur(trueProfitCents)}</div>
        </div>
        {margin != null && (
          <div>
            <div className="text-[11px] uppercase tracking-wide text-slate-400">Profit margin</div>
            <div className={`text-lg font-semibold tabular-nums ${margin >= 0 ? 'text-slate-800 dark:text-slate-100' : 'text-rose-600 dark:text-rose-400'}`}>{margin.toFixed(1)}%</div>
          </div>
        )}
        {profitPerAdEur != null && (
          <div title="True profit returned per €1 of ad spend (lifetime)">
            <div className="text-[11px] uppercase tracking-wide text-slate-400">Profit / ad €</div>
            <div className={`text-lg font-semibold tabular-nums ${profitPerAdEur >= 0 ? 'text-slate-800 dark:text-slate-100' : 'text-rose-600 dark:text-rose-400'}`}>{profitPerAdEur.toFixed(2)}×</div>
          </div>
        )}
      </div>
    </div>
  )
}
