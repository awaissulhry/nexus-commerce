'use client'

import { useState } from 'react'
import { CheckCircle2, Clock, Minus, ChevronUp, ChevronDown } from 'lucide-react'

interface Decision {
  id: string
  oldPrice: string
  newPrice: string
  reason: string
  buyBoxPrice: string | null
  lowestCompPrice: string | null
  applied: boolean
  capped: string | null
  createdAt: string
  rule: {
    id: string
    channel: string
    marketplace: string | null
    strategy: string
    product: { id: string; name: string; brand: string | null }
  }
}

const STRATEGY_LABEL: Record<string, string> = {
  match_buy_box: 'Match Buy Box',
  beat_lowest_by_pct: 'Beat Lowest %',
  beat_lowest_by_amount: 'Beat Lowest €',
  fixed_to_buy_box_minus: 'Buy Box − Fixed',
  maximize_margin_win_box: 'Max Margin Win Box',
  manual: 'Manual',
}

const CHANNEL_COLORS: Record<string, string> = {
  AMAZON: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900',
  EBAY:   'bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:ring-blue-900',
  SHOPIFY:'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900',
}

function fmt(price: string | null): string {
  if (!price) return '—'
  return `€${Number(price).toFixed(2)}`
}

function PriceDelta({ oldPrice, newPrice }: { oldPrice: string; newPrice: string }) {
  const old = Number(oldPrice)
  const next = Number(newPrice)
  const delta = next - old
  if (Math.abs(delta) < 0.01) {
    return (
      <span className="text-slate-400 text-xs flex items-center gap-0.5">
        <Minus className="h-3 w-3" /> no change
      </span>
    )
  }
  const up = delta > 0
  return (
    <span className={`text-xs flex items-center gap-0.5 font-medium ${up ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}`}>
      {up ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      {fmt(String(Math.abs(delta)))}
    </span>
  )
}

export function RepricingDecisionsClient({ initialDecisions }: { initialDecisions: Decision[] }) {
  const [filter, setFilter] = useState<'all' | 'applied' | 'pending'>('all')

  const displayed = initialDecisions.filter((d) => {
    if (filter === 'applied') return d.applied
    if (filter === 'pending') return !d.applied && Math.abs(Number(d.newPrice) - Number(d.oldPrice)) > 0.01
    return true
  })

  return (
    <div className="space-y-4">
      {/* Filter tabs */}
      <div className="flex items-center gap-2">
        {(['all', 'applied', 'pending'] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`px-2.5 py-1 text-xs rounded-full ring-1 ring-inset transition-colors ${
              filter === f
                ? 'bg-violet-600 text-white ring-violet-600'
                : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 ring-slate-300 dark:ring-slate-700 hover:bg-slate-50'
            }`}
          >
            {f === 'all' ? 'All' : f === 'applied' ? 'Applied' : 'Pending review'}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md overflow-hidden">
        {displayed.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-slate-500 dark:text-slate-400">
            No repricing decisions yet — run the evaluator cron or wait for the next tick.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-medium">Product</th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-medium">Channel</th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-medium">Strategy</th>
                <th className="px-3 py-2 text-right text-[10px] uppercase tracking-wider text-slate-500 font-medium">Old</th>
                <th className="px-3 py-2 text-right text-[10px] uppercase tracking-wider text-slate-500 font-medium">New</th>
                <th className="px-3 py-2 text-right text-[10px] uppercase tracking-wider text-slate-500 font-medium">Δ</th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-medium">Reason</th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-medium">Buy Box</th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-medium">Status</th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-medium">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {displayed.map((d) => (
                <tr key={d.id} className="group hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <td className="px-3 py-2 max-w-48">
                    <div className="font-medium text-slate-900 dark:text-slate-100 text-xs leading-tight truncate">
                      {d.rule.product.name}
                    </div>
                    {d.rule.product.brand && (
                      <div className="text-[10px] text-slate-400">{d.rule.product.brand}</div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset font-medium ${CHANNEL_COLORS[d.rule.channel] ?? ''}`}>
                      {d.rule.channel}
                    </span>
                    {d.rule.marketplace && (
                      <span className="text-[10px] text-slate-400 ml-1">{d.rule.marketplace}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-400">
                    {STRATEGY_LABEL[d.rule.strategy] ?? d.rule.strategy}
                  </td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums text-slate-500">{fmt(d.oldPrice)}</td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums font-medium text-slate-900 dark:text-slate-100">{fmt(d.newPrice)}</td>
                  <td className="px-3 py-2 text-right">
                    <PriceDelta oldPrice={d.oldPrice} newPrice={d.newPrice} />
                  </td>
                  <td className="px-3 py-2 max-w-52">
                    <span className="text-xs text-slate-600 dark:text-slate-400 line-clamp-2">{d.reason}</span>
                    {d.capped && (
                      <span className="text-[10px] text-rose-600 dark:text-rose-400 mt-0.5 block">
                        capped at {d.capped}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs tabular-nums text-slate-500">{fmt(d.buyBoxPrice)}</td>
                  <td className="px-3 py-2">
                    {d.applied ? (
                      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900">
                        <CheckCircle2 className="h-3 w-3" />
                        Applied
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900">
                        <Clock className="h-3 w-3" />
                        Logged
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-400 whitespace-nowrap">
                    {new Date(d.createdAt).toLocaleDateString('en-GB', {
                      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
