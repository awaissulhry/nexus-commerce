'use client'

import { useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Download } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface PortfolioRow {
  id: string
  sku: string
  name: string
  brand: string | null
  healthScore: number
  qualityScore: number | null
  totalUnits30d: number
  totalRevenue30d: number
  totalAvailable: number
  daysOfInventory: number | null
  stockoutRisk: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN'
  channelCount: number
  actionTags: string[]
}

interface RoasRow {
  sku: string
  revenue30d: number
  adSpend30d: number
  roas: number | null
}

const RISK_STYLES: Record<string, string> = {
  HIGH: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900',
  MEDIUM: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900',
  LOW: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900',
  UNKNOWN: 'bg-slate-100 text-slate-500 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700',
}

function HealthBar({ score }: { score: number }) {
  const color = score >= 70 ? 'bg-emerald-500' : score >= 50 ? 'bg-amber-500' : 'bg-rose-500'
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${score}%` }} />
      </div>
      <span className={`text-xs font-semibold tabular-nums ${score >= 70 ? 'text-emerald-700 dark:text-emerald-400' : score >= 50 ? 'text-amber-700 dark:text-amber-400' : 'text-rose-700 dark:text-rose-400'}`}>
        {score}
      </span>
    </div>
  )
}

export function PortfolioClient({
  initialProducts,
  initialRoas,
}: {
  initialProducts: PortfolioRow[]
  initialRoas: RoasRow[]
}) {
  const [filter, setFilter] = useState<'all' | 'attention'>('attention')

  const displayed = filter === 'attention'
    ? initialProducts.filter((p) => p.healthScore < 60)
    : initialProducts

  const exportUrl = `${getBackendUrl()}/api/analytics/portfolio?format=csv&limit=500`

  return (
    <div className="space-y-6">
      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        {(['attention', 'all'] as const).map((f) => (
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
            {f === 'attention' ? `Needs attention (${initialProducts.filter((p) => p.healthScore < 60).length})` : `All products (${initialProducts.length})`}
          </button>
        ))}
        <div className="ml-auto">
          <a
            href={exportUrl}
            download="portfolio.csv"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded ring-1 ring-inset ring-slate-300 dark:ring-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-50"
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </a>
        </div>
      </div>

      {/* Portfolio table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md overflow-hidden">
        {displayed.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-slate-500">
            {filter === 'attention'
              ? 'No products need attention — all health scores are ≥60.'
              : 'No products found.'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-medium">Health</th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-medium">Product</th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-medium">Quality</th>
                <th className="px-3 py-2 text-right text-[10px] uppercase tracking-wider text-slate-500 font-medium">30d Units</th>
                <th className="px-3 py-2 text-right text-[10px] uppercase tracking-wider text-slate-500 font-medium">30d Revenue</th>
                <th className="px-3 py-2 text-right text-[10px] uppercase tracking-wider text-slate-500 font-medium">Stock</th>
                <th className="px-3 py-2 text-right text-[10px] uppercase tracking-wider text-slate-500 font-medium">Days on hand</th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-medium">Risk</th>
                <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {displayed.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 group">
                  <td className="px-3 py-2">
                    <HealthBar score={p.healthScore} />
                  </td>
                  <td className="px-3 py-2 max-w-52">
                    <Link
                      href={`/products/${p.id}/edit`}
                      className="text-sm font-medium text-slate-900 dark:text-slate-100 hover:text-violet-600 dark:hover:text-violet-400 line-clamp-1"
                    >
                      {p.name}
                    </Link>
                    <div className="text-[10px] font-mono text-slate-400">{p.sku}</div>
                  </td>
                  <td className="px-3 py-2">
                    {p.qualityScore != null ? (
                      <span className={`text-xs font-medium ${p.qualityScore >= 75 ? 'text-emerald-700 dark:text-emerald-400' : p.qualityScore >= 50 ? 'text-amber-700 dark:text-amber-400' : 'text-rose-700 dark:text-rose-400'}`}>
                        {p.qualityScore}/100
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums">{p.totalUnits30d}</td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums">€{p.totalRevenue30d.toFixed(0)}</td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums">{p.totalAvailable}</td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums">
                    {p.daysOfInventory != null ? `${p.daysOfInventory}d` : '—'}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ring-1 ring-inset inline-flex items-center gap-0.5 ${RISK_STYLES[p.stockoutRisk]}`}>
                      {p.stockoutRisk === 'HIGH' && <AlertTriangle className="h-2.5 w-2.5" />}
                      {p.stockoutRisk}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1 flex-wrap">
                      {p.actionTags.map((tag) => (
                        <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
                          {tag.replace(/_/g, ' ')}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ROAS table */}
      {initialRoas.length > 0 && (
        <section>
          <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
            Inventory-to-Ad-Spend (30d)
          </h2>
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800">
                <tr>
                  {['SKU', '30d Revenue', '30d Ad Spend', 'ROAS', 'Net Contribution'].map((h) => (
                    <th key={h} className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {initialRoas.sort((a, b) => (a.roas ?? 0) - (b.roas ?? 0)).map((r) => {
                  const net = r.revenue30d - r.adSpend30d
                  const roasWarn = r.roas != null && r.roas < 2
                  return (
                    <tr key={r.sku} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className="px-3 py-2 text-xs font-mono text-slate-600 dark:text-slate-400">{r.sku}</td>
                      <td className="px-3 py-2 text-xs tabular-nums">€{r.revenue30d.toFixed(2)}</td>
                      <td className="px-3 py-2 text-xs tabular-nums">€{r.adSpend30d.toFixed(2)}</td>
                      <td className={`px-3 py-2 text-xs tabular-nums font-medium ${roasWarn ? 'text-rose-700 dark:text-rose-400' : 'text-emerald-700 dark:text-emerald-400'}`}>
                        {r.roas != null ? r.roas.toFixed(2) : '—'}x
                      </td>
                      <td className={`px-3 py-2 text-xs tabular-nums ${net < 0 ? 'text-rose-700 dark:text-rose-400' : 'text-slate-700 dark:text-slate-300'}`}>
                        €{net.toFixed(2)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}
