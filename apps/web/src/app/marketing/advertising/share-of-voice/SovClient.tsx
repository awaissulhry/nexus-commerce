'use client'

/** AX2.6 — Share of Voice + impression-share intelligence. */

import { useCallback, useEffect, useState } from 'react'
import { Radar, Download } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { eur, num, pct } from '@/app/_shared/ads-ui'

interface SovRow {
  query: string; impressions: number; clicks: number; costCents: number; orders: number
  ctr: number | null; cvr: number | null; cpcCents: number | null; sovPct: number
  campaignCount: number; topCampaignSharePct: number; cannibalized: boolean
  flag: 'outbid' | 'weak-relevance' | null
}
interface SovResult { windowDays: number; totalImpressions: number; queries: number; rows: SovRow[]; summary: { cannibalizedQueries: number; outbidQueries: number; weakRelevanceQueries: number } }


const DAYS = [7, 14, 30, 60, 90]
const FLAG_CHIP: Record<string, string> = {
  outbid: 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
  'weak-relevance': 'bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300',
}

export function SovClient() {
  const [days, setDays] = useState(30)
  const [data, setData] = useState<SovResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState<'all' | 'cannibalized' | 'outbid' | 'weak-relevance'>('all')

  const load = useCallback(() => {
    setLoading(true)
    fetch(`${getBackendUrl()}/api/advertising/share-of-voice?windowDays=${days}&limit=300`, { cache: 'no-store' })
      .then((x) => x.json()).then(setData).catch(() => {}).finally(() => setLoading(false))
  }, [days])
  useEffect(() => { load() }, [load])

  const rows = (data?.rows ?? []).filter((r) => filter === 'all' ? true : filter === 'cannibalized' ? r.cannibalized : r.flag === filter)

  const csv = () => {
    const head = 'query,impressions,sov%,clicks,ctr%,cpc,orders,cvr%,campaigns,top_campaign_share%,cannibalized,flag\n'
    const body = (data?.rows ?? []).map((r) => `"${r.query.replace(/"/g, '""')}",${r.impressions},${(r.sovPct * 100).toFixed(2)},${r.clicks},${r.ctr != null ? (r.ctr * 100).toFixed(2) : ''},${r.cpcCents != null ? (r.cpcCents / 100).toFixed(2) : ''},${r.orders},${r.cvr != null ? (r.cvr * 100).toFixed(2) : ''},${r.campaignCount},${(r.topCampaignSharePct * 100).toFixed(0)},${r.cannibalized},${r.flag ?? ''}`).join('\n')
    const blob = new Blob([head + body], { type: 'text/csv' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `share-of-voice-${days}d.csv`; a.click()
  }

  return (
    <div className="max-w-[1200px]">
      <div className="flex items-center gap-2 mb-1"><Radar size={20} className="text-sky-500" /><h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Share of voice</h1></div>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">Which search queries you dominate, where your own campaigns compete with each other, and where you&apos;re likely being outbid. Impression share within your tracked search-term data — a true competitive-IS feed requires Amazon&apos;s impression-share report subscription.{loading ? ' (loading…)' : ''}</p>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex gap-1">{DAYS.map((d) => <button key={d} onClick={() => setDays(d)} className={`px-2.5 py-1 text-xs rounded-md border ${days === d ? 'bg-blue-600 text-white border-blue-600' : 'border-default dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>{d}d</button>)}</div>
        <div className="inline-flex rounded-md border border-default dark:border-slate-700 overflow-hidden">
          {([['all', 'All'], ['cannibalized', 'Cannibalized'], ['outbid', 'Outbid'], ['weak-relevance', 'Weak CTR']] as const).map(([v, label]) => (
            <button key={v} onClick={() => setFilter(v)} className={`px-2.5 py-1.5 text-xs border-l first:border-l-0 border-default dark:border-slate-700 ${filter === v ? 'bg-slate-900 text-white dark:bg-slate-700' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>{label}</button>
          ))}
        </div>
        <button onClick={csv} className="inline-flex items-center gap-1 py-1.5 px-2 text-sm rounded-md border border-default dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"><Download size={14} /> CSV</button>
        <span className="text-xs text-tertiary ml-auto">{rows.length} of {data?.queries ?? 0} queries · {num(data?.totalImpressions ?? 0)} impressions</span>
      </div>

      {data && (
        <div className="grid grid-cols-3 gap-2 mb-3 text-sm">
          <div className="rounded-lg border border-default dark:border-slate-800 px-3 py-2"><div className="text-xs text-slate-500">Cannibalized queries</div><div className="text-lg font-semibold text-violet-600">{data.summary.cannibalizedQueries}</div></div>
          <div className="rounded-lg border border-default dark:border-slate-800 px-3 py-2"><div className="text-xs text-slate-500">Likely outbid</div><div className="text-lg font-semibold text-amber-600">{data.summary.outbidQueries}</div></div>
          <div className="rounded-lg border border-default dark:border-slate-800 px-3 py-2"><div className="text-xs text-slate-500">Weak relevance (low CTR)</div><div className="text-lg font-semibold text-rose-600">{data.summary.weakRelevanceQueries}</div></div>
        </div>
      )}

      <div className="rounded-lg border border-default dark:border-slate-800 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr>
            <th className="text-left px-3 py-2">Search query</th><th className="text-right px-3 py-2">Impressions</th><th className="text-right px-3 py-2">SOV</th><th className="text-right px-3 py-2">Clicks</th><th className="text-right px-3 py-2">CTR</th><th className="text-right px-3 py-2">CPC</th><th className="text-right px-3 py-2">Orders</th><th className="text-right px-3 py-2">Campaigns</th><th className="text-right px-3 py-2">Top share</th><th className="px-3 py-2">Flag</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.length === 0 ? <tr><td colSpan={10} className="px-3 py-8 text-center text-tertiary text-xs">No search-term data yet — run the search-terms report cycle.</td></tr> : rows.map((r) => (
              <tr key={r.query} className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
                <td className="px-3 py-1.5 max-w-[280px] truncate">{r.query}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{num(r.impressions)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums"><span className="inline-flex items-center gap-1.5"><span className="w-10 h-1.5 rounded bg-slate-100 dark:bg-slate-800 overflow-hidden inline-block"><span className="block h-full bg-sky-500" style={{ width: `${Math.min(100, r.sovPct * 100 * 4)}%` }} /></span>{pct(r.sovPct, 2)}</span></td>
                <td className="px-3 py-1.5 text-right tabular-nums">{num(r.clicks)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{pct(r.ctr, 2)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{eur(r.cpcCents)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{num(r.orders)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.cannibalized ? <span className="text-violet-600 font-medium">{r.campaignCount}</span> : r.campaignCount}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{pct(r.topCampaignSharePct, 0)}</td>
                <td className="px-3 py-1.5">{r.flag ? <span className={`px-1.5 py-0.5 rounded text-[11px] ${FLAG_CHIP[r.flag]}`}>{r.flag === 'outbid' ? 'Outbid' : 'Weak CTR'}</span> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
