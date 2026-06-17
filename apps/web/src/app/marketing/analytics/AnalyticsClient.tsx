'use client'

/**
 * UM-series (P14) — cross-channel analytics client. Totals + per-channel +
 * per-market rollups (EUR-normalized) + a daily spend/sales trend, live
 * via useMarketingEvents. ROAS/ACOS labeled channel-reported.
 */

import { useCallback, useState } from 'react'
import { BarChart3, Wallet, TrendingUp, MousePointerClick, Info } from 'lucide-react'
import { KpiStrip, type KpiTileSpec } from '@/app/_shared/grid-lens'
import { getBackendUrl } from '@/lib/backend-url'
import { useMarketingEvents } from '@/lib/sync/use-marketing-events'

interface Row {
  key: string; spendEurCents: number; salesCents: number
  impressions?: number; clicks?: number; orders7d?: number; roas: number | null; acos: number | null
}
export interface AnalyticsData {
  from: string; to: string; attributionNote: string
  totals: { spendEurCents: number; salesCents: number; impressions: number; clicks: number; orders7d: number }
  byChannel: Row[]; byMarketplace: Row[]
  daily: Array<{ date: string; spendEurCents: number; salesCents: number }>
}

const eur = (c: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100)
const num = (n: number) => new Intl.NumberFormat('en-US').format(n)

const CHANNEL_DOT: Record<string, string> = {
  AMAZON: 'bg-amber-500', EBAY: 'bg-blue-500', SHOPIFY: 'bg-emerald-500',
  GOOGLE: 'bg-sky-500', META: 'bg-indigo-500', TIKTOK: 'bg-fuchsia-500', INTERNAL: 'bg-slate-400',
}

export function AnalyticsClient({ initial }: { initial: AnalyticsData }) {
  const [data, setData] = useState(initial)
  const refetch = useCallback(async () => {
    const res = await fetch(`${getBackendUrl()}/api/marketing/os/analytics`, { cache: 'no-store' })
    if (res.ok) setData(await res.json())
  }, [])
  useMarketingEvents(useCallback(() => void refetch(), [refetch]))

  const t = data.totals
  const roas = t.spendEurCents > 0 ? (t.salesCents / t.spendEurCents).toFixed(2) : '—'
  const tiles: KpiTileSpec[] = [
    { icon: Wallet, label: 'Spend (EUR)', value: eur(t.spendEurCents), tone: 'amber', detail: `${data.from} → ${data.to}` },
    { icon: TrendingUp, label: 'Attributed sales', value: eur(t.salesCents), tone: 'violet', detail: `ROAS ${roas} · channel-reported` },
    { icon: MousePointerClick, label: 'Clicks', value: num(t.clicks), tone: 'blue', detail: `${num(t.impressions)} impressions` },
    { icon: BarChart3, label: 'Orders (7d)', value: num(t.orders7d), tone: 'emerald' },
  ]

  const maxDaily = Math.max(1, ...data.daily.map((d) => Math.max(d.spendEurCents, d.salesCents)))

  const Table = ({ title, rows, isChannel }: { title: string; rows: Row[]; isChannel?: boolean }) => (
    <div className="rounded-lg border border-default dark:border-slate-800 overflow-hidden">
      <div className="px-3 py-2 bg-slate-50 dark:bg-slate-900/60 text-xs font-medium uppercase text-slate-500">{title}</div>
      <table className="w-full text-sm">
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {rows.length === 0 && <tr><td className="px-3 py-4 text-tertiary text-xs">No data in window.</td></tr>}
          {rows.map((r) => (
            <tr key={r.key} className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
              <td className="px-3 py-1.5">{isChannel && <span className={`inline-block w-2 h-2 rounded-full mr-1.5 ${CHANNEL_DOT[r.key] ?? CHANNEL_DOT.INTERNAL}`} />}<span className="text-slate-700 dark:text-slate-200">{r.key || '—'}</span></td>
              <td className="px-3 py-1.5 text-right tabular-nums text-slate-600 dark:text-slate-300">{eur(r.spendEurCents)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-slate-600 dark:text-slate-300">{eur(r.salesCents)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{r.roas != null ? r.roas.toFixed(2) : '—'}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{r.acos != null ? `${(r.acos * 100).toFixed(0)}%` : '—'}</td>
            </tr>
          ))}
        </tbody>
        {rows.length > 0 && (
          <thead className="text-[10px] uppercase text-tertiary"><tr><th /><th className="text-right px-3 font-normal">spend</th><th className="text-right px-3 font-normal">sales</th><th className="text-right px-3 font-normal">roas</th><th className="text-right px-3 font-normal">acos</th></tr></thead>
        )}
      </table>
    </div>
  )

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
      <header className="mb-4">
        <div className="flex items-center gap-2"><BarChart3 size={20} className="text-blue-500" /><h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Cross-channel analytics</h1></div>
        <p className="text-sm text-slate-500 dark:text-slate-400 flex items-center gap-1 mt-1"><Info size={13} /> {data.attributionNote}</p>
      </header>

      <KpiStrip tiles={tiles} className="mb-4" />

      {/* Daily trend */}
      {data.daily.length > 0 && (
        <div className="rounded-lg border border-default dark:border-slate-800 p-3 mb-4">
          <div className="text-xs font-medium uppercase text-slate-500 mb-2">Daily spend vs sales (EUR)</div>
          <div className="flex items-end gap-0.5 h-28">
            {data.daily.map((d) => (
              <div key={d.date} className="flex-1 flex flex-col justify-end gap-px group relative" title={`${d.date}: spend ${eur(d.spendEurCents)} · sales ${eur(d.salesCents)}`}>
                <div className="bg-violet-400/70" style={{ height: `${(d.salesCents / maxDaily) * 100}%` }} />
                <div className="bg-amber-500/80" style={{ height: `${(d.spendEurCents / maxDaily) * 100}%` }} />
              </div>
            ))}
          </div>
          <div className="flex gap-3 mt-1 text-[10px] text-tertiary"><span className="inline-flex items-center gap-1"><span className="w-2 h-2 bg-amber-500/80" /> spend</span><span className="inline-flex items-center gap-1"><span className="w-2 h-2 bg-violet-400/70" /> sales</span></div>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        <Table title="By channel" rows={data.byChannel} isChannel />
        <Table title="By market" rows={data.byMarketplace} />
      </div>
    </div>
  )
}
