'use client'

/** AX3.1 — Retail-readiness guard: stop advertising products you can't sell.
 *  Native (stock + Buy Box + price live in this DB) — no integration needed. */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { PackageX, ShieldCheck, Pause } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

type Verdict = 'pause' | 'watch' | 'ok'
interface CampaignReadiness { campaignId: string; name: string; marketplace: string | null; status: string; products: number; outOfStock: number; lostBuyBox: number; uncompetitive: number; unknown: number; verdict: Verdict; reason: string }
interface ReadinessResult { generatedAt: string; campaigns: CampaignReadiness[]; summary: { pause: number; watch: number; ok: number; atRiskSpendNote: string } }

const VERDICT_CHIP: Record<Verdict, string> = {
  pause: 'bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300',
  watch: 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
  ok: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
}

export function RetailReadinessClient() {
  const [data, setData] = useState<ReadinessResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState<Verdict | 'all'>('all')
  const [busy, setBusy] = useState<string | null>(null)
  const [paused, setPaused] = useState<Set<string>>(new Set())

  const load = useCallback(() => {
    setLoading(true); setPaused(new Set())
    fetch(`${getBackendUrl()}/api/advertising/retail-readiness`, { cache: 'no-store' }).then((x) => x.json()).then(setData).catch(() => {}).finally(() => setLoading(false))
  }, [])
  useEffect(() => { load() }, [load])

  const pause = async (ids: string[]) => {
    if (ids.length === 0) return
    setBusy(ids.length === 1 ? ids[0] : 'all')
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/retail-readiness/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaignIds: ids }) }).then((x) => x.json())
      if (Array.isArray(r?.paused)) setPaused((s) => { const n = new Set(s); r.paused.forEach((id: string) => n.add(id)); return n })
    } finally { setBusy(null) }
  }

  const rows = (data?.campaigns ?? []).filter((c) => filter === 'all' ? true : c.verdict === filter)
  const atRisk = (data?.campaigns ?? []).filter((c) => c.verdict === 'pause' && !paused.has(c.campaignId)).map((c) => c.campaignId)

  return (
    <div className="max-w-[1100px]">
      <div className="flex items-center gap-2 mb-1"><PackageX size={20} className="text-rose-500" /><h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Retail readiness</h1></div>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">Don&apos;t pay for clicks you can&apos;t fulfil. Every enabled campaign is checked against live stock, Buy Box, and price — campaigns advertising only unsellable products are flagged to pause.{loading ? ' (loading…)' : ''}</p>

      {data && (
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <div className="rounded-lg border border-rose-200 dark:border-rose-900/50 px-3 py-2"><div className="text-xs text-slate-500">Pause now</div><div className="text-lg font-semibold text-rose-600">{data.summary.pause}</div></div>
          <div className="rounded-lg border border-amber-200 dark:border-amber-900/50 px-3 py-2"><div className="text-xs text-slate-500">Watch</div><div className="text-lg font-semibold text-amber-600">{data.summary.watch}</div></div>
          <div className="rounded-lg border border-emerald-200 dark:border-emerald-900/50 px-3 py-2"><div className="text-xs text-slate-500">Healthy</div><div className="text-lg font-semibold text-emerald-600">{data.summary.ok}</div></div>
          <button onClick={() => pause(atRisk)} disabled={atRisk.length === 0 || busy === 'all'} className="ml-auto inline-flex items-center gap-1 py-1.5 px-3 text-sm rounded-md bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-40"><Pause size={14} /> {busy === 'all' ? 'Pausing…' : `Pause all at-risk (${atRisk.length})`}</button>
        </div>
      )}

      <div className="inline-flex rounded-md border border-slate-200 dark:border-slate-700 overflow-hidden mb-3">
        {([['all', 'All'], ['pause', 'Pause'], ['watch', 'Watch'], ['ok', 'Healthy']] as const).map(([v, label]) => (
          <button key={v} onClick={() => setFilter(v)} className={`px-2.5 py-1.5 text-xs border-l first:border-l-0 border-slate-200 dark:border-slate-700 ${filter === v ? 'bg-slate-900 text-white dark:bg-slate-700' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>{label}</button>
        ))}
      </div>

      <div className="rounded-lg border border-slate-200 dark:border-slate-800 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr>
            <th className="text-left px-3 py-2">Campaign</th><th className="text-left px-3 py-2">Status</th><th className="text-right px-3 py-2">Products</th><th className="text-right px-3 py-2">OOS</th><th className="text-right px-3 py-2">Lost BB</th><th className="text-right px-3 py-2">Uncompet.</th><th className="text-left px-3 py-2">Reason</th><th className="px-3 py-2"></th>
          </tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.length === 0 && !loading && <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-400 text-xs">No campaigns to show.</td></tr>}
            {rows.map((c) => {
              const done = paused.has(c.campaignId)
              return (
                <tr key={c.campaignId} className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
                  <td className="px-3 py-1.5"><Link href={`/marketing/advertising/campaigns/${c.campaignId}`} className="text-blue-600 hover:underline truncate block max-w-[240px]">{c.name}</Link></td>
                  <td className="px-3 py-1.5"><span className={`px-1.5 py-0.5 rounded text-xs ${VERDICT_CHIP[c.verdict]}`}>{done ? 'paused ✓' : c.verdict}</span></td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{c.products}</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums ${c.outOfStock ? 'text-rose-600 font-medium' : 'text-slate-400'}`}>{c.outOfStock}</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums ${c.lostBuyBox ? 'text-rose-600 font-medium' : 'text-slate-400'}`}>{c.lostBuyBox}</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums ${c.uncompetitive ? 'text-amber-600' : 'text-slate-400'}`}>{c.uncompetitive}</td>
                  <td className="px-3 py-1.5 text-xs text-slate-500 max-w-[320px] truncate">{c.reason}</td>
                  <td className="px-3 py-1.5 text-right">{c.verdict === 'pause' && !done ? <button disabled={busy === c.campaignId} onClick={() => pause([c.campaignId])} className="text-xs text-rose-600 hover:underline disabled:opacity-40">{busy === c.campaignId ? '…' : 'Pause'}</button> : c.verdict === 'ok' ? <ShieldCheck size={14} className="text-emerald-500 inline" /> : null}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-400 mt-3">Auto-pilot: set <code className="px-1 rounded bg-slate-100 dark:bg-slate-800">NEXUS_ADS_RETAIL_GUARD_APPLY=1</code> + enable the ads cron to pause at-risk campaigns automatically. Writes honour the live-write gate (sandbox-safe until go-live).</p>
    </div>
  )
}
