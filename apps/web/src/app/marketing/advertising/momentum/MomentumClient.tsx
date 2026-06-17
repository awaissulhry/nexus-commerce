'use client'

/** AX3.12 — Live Ad Momentum: top movers by sales (campaigns / keywords /
 *  ASINs), delivery counts, and sales-by-placement for the latest day. */

import { useCallback, useEffect, useState } from 'react'
import { Zap } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { eur0 as eur, pct } from '@/app/_shared/ads-ui'

interface Entity { id: string; label: string; status?: string | null; impressions: number; clicks: number; spendCents: number; salesCents: number; orders: number; acos: number | null }
interface Result { date: string | null; counts: { enabled: number; paused: number }; campaigns: Entity[]; keywords: Entity[]; asins: Entity[]; placements: Array<{ placement: string; spendCents: number; salesCents: number; sharePct: number }> }

function TopList({ title, rows }: { title: string; rows: Entity[] }) {
  const max = Math.max(1, ...rows.map((r) => r.salesCents))
  return (
    <div className="rounded-lg border border-default dark:border-slate-800 overflow-hidden">
      <div className="px-3 py-2 bg-slate-50 dark:bg-slate-900/60 text-xs font-medium text-slate-600 dark:text-slate-300">{title}</div>
      <div className="divide-y divide-slate-100 dark:divide-slate-800">
        {rows.length === 0 ? <div className="px-3 py-6 text-center text-tertiary text-xs">No data.</div> : rows.map((r, i) => (
          <div key={r.id} className="px-3 py-1.5 flex items-center gap-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-900/40">
            <span className="text-xs text-tertiary w-4 text-right">{i + 1}</span>
            <span className="flex-1 min-w-0 truncate" title={r.label}>{r.label}</span>
            <span className="relative w-16 h-1.5 rounded bg-slate-100 dark:bg-slate-800 overflow-hidden hidden sm:inline-block"><span className="absolute inset-y-0 left-0 bg-violet-500" style={{ width: `${(r.salesCents / max) * 100}%` }} /></span>
            <span className="tabular-nums text-right w-16">{eur(r.salesCents)}</span>
            <span className="tabular-nums text-right w-12 text-tertiary text-xs">{pct(r.acos)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function MomentumClient() {
  const [data, setData] = useState<Result | null>(null)
  const [loading, setLoading] = useState(false)
  const load = useCallback(() => { setLoading(true); fetch(`${getBackendUrl()}/api/advertising/momentum`, { cache: 'no-store' }).then((x) => x.json()).then(setData).catch(() => {}).finally(() => setLoading(false)) }, [])
  useEffect(() => { load() }, [load])

  return (
    <div className="max-w-[1200px]">
      <div className="flex items-center gap-2 mb-1"><Zap size={20} className="text-amber-500" /><h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Live Ad Momentum</h1></div>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">Today&apos;s movers — top campaigns, keywords and ASINs by sales, plus where sales land by placement.{data?.date ? ` Latest reported day: ${data.date}.` : ''}{loading ? ' (loading…)' : ''}</p>

      {data && (
        <div className="flex flex-wrap items-center gap-2 mb-3 text-sm">
          <div className="rounded-lg border border-emerald-200 dark:border-emerald-900/50 px-3 py-2"><div className="text-xs text-slate-500">Enabled campaigns</div><div className="text-lg font-semibold text-emerald-600">{data.counts.enabled}</div></div>
          <div className="rounded-lg border border-amber-200 dark:border-amber-900/50 px-3 py-2"><div className="text-xs text-slate-500">Paused</div><div className="text-lg font-semibold text-amber-600">{data.counts.paused}</div></div>
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-3 mb-4">
        <TopList title="Top campaigns" rows={data?.campaigns ?? []} />
        <TopList title="Top keywords / targets" rows={data?.keywords ?? []} />
        <TopList title="Top ASINs" rows={data?.asins ?? []} />
      </div>

      {/* Sales by placement */}
      <div className="rounded-lg border border-default dark:border-slate-800 overflow-hidden">
        <div className="px-3 py-2 bg-slate-50 dark:bg-slate-900/60 text-xs font-medium text-slate-600 dark:text-slate-300">Sales by placement</div>
        <table className="w-full text-sm">
          <thead className="text-xs text-slate-500"><tr><th className="text-left px-3 py-1.5">Placement</th><th className="text-left px-3 py-1.5 w-1/3">Share</th><th className="text-right px-3 py-1.5">Spend</th><th className="text-right px-3 py-1.5">Sales</th></tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {(data?.placements ?? []).length === 0 ? <tr><td colSpan={4} className="px-3 py-6 text-center text-tertiary text-xs">No placement data for this day.</td></tr> : (data?.placements ?? []).map((p) => (
              <tr key={p.placement}><td className="px-3 py-1.5">{p.placement}</td><td className="px-3 py-1.5"><span className="relative block w-full h-2 rounded bg-slate-100 dark:bg-slate-800 overflow-hidden"><span className="absolute inset-y-0 left-0 bg-sky-500" style={{ width: `${p.sharePct * 100}%` }} /></span></td><td className="px-3 py-1.5 text-right tabular-nums">{eur(p.spendCents)}</td><td className="px-3 py-1.5 text-right tabular-nums">{eur(p.salesCents)} <span className="text-xs text-tertiary">({(p.sharePct * 100).toFixed(0)}%)</span></td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-tertiary mt-3">Day-grain from your Amazon reports. Hour-of-day momentum + the live sales funnel unlock once Amazon Marketing Stream is delivering hourly data.</p>
    </div>
  )
}
