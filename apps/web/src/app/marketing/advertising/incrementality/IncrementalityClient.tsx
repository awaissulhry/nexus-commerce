'use client'

/** AX3.5 — iROAS / incrementality (modeled): true ad-driven lift, not last-touch. */

import { useCallback, useEffect, useState } from 'react'
import { Crosshair, Download } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { eur0 as eur, x2 } from '@/app/_shared/ads-ui'

interface Row { campaignId: string; name: string; marketplace: string | null; branded: boolean; spendCents: number; adSalesCents: number; roas: number | null; incrementalityFactor: number; incrementalSalesCents: number; iroas: number | null }
interface Result { windowDays: number; brandTerms: string[]; brandedFactor: number; nonBrandedFactor: number; totals: { spendCents: number; adSalesCents: number; roas: number | null; incrementalSalesCents: number; iroas: number | null; brandedSpendCents: number; nonBrandedSpendCents: number }; rows: Row[]; note: string }

const DAYS = [7, 14, 30, 60, 90]

export function IncrementalityClient() {
  const [data, setData] = useState<Result | null>(null)
  const [loading, setLoading] = useState(false)
  const [days, setDays] = useState(30)
  const [brandTerms, setBrandTerms] = useState('Xavia')
  const [brandedFactor, setBrandedFactor] = useState(0.3)
  const [nonBrandedFactor, setNonBrandedFactor] = useState(0.85)

  const load = useCallback(() => {
    setLoading(true)
    const qs = new URLSearchParams({ windowDays: String(days), brandedFactor: String(brandedFactor), nonBrandedFactor: String(nonBrandedFactor), ...(brandTerms.trim() ? { brandTerms: brandTerms.trim() } : {}) })
    fetch(`${getBackendUrl()}/api/advertising/incrementality?${qs}`, { cache: 'no-store' }).then((x) => x.json()).then(setData).catch(() => {}).finally(() => setLoading(false))
  }, [days, brandTerms, brandedFactor, nonBrandedFactor])
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t) }, [load])

  const csv = () => {
    const head = 'campaign,branded,spend,ad_sales,roas,incrementality_factor,incremental_sales,iroas\n'
    const body = (data?.rows ?? []).map((r) => `"${r.name.replace(/"/g, '""')}",${r.branded},${(r.spendCents / 100).toFixed(2)},${(r.adSalesCents / 100).toFixed(2)},${r.roas?.toFixed(2) ?? ''},${r.incrementalityFactor},${(r.incrementalSalesCents / 100).toFixed(2)},${r.iroas?.toFixed(2) ?? ''}`).join('\n')
    const blob = new Blob([head + body], { type: 'text/csv' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `incrementality-${days}d.csv`; a.click()
  }

  const t = data?.totals
  return (
    <div className="max-w-[1150px]">
      <div className="flex items-center gap-2 mb-1"><Crosshair size={20} className="text-fuchsia-500" /><h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">iROAS &amp; incrementality</h1></div>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">Not every attributed sale is incremental — branded-search buyers would mostly convert anyway. This models the *incremental* return your ads actually drive. Tune the factors; for measured truth, run an AMC holdout.{loading ? ' (loading…)' : ''}</p>

      {/* Controls */}
      <div className="flex flex-wrap items-end gap-3 mb-3">
        <div className="flex gap-1">{DAYS.map((d) => <button key={d} onClick={() => setDays(d)} className={`px-2.5 py-1 text-xs rounded-md border ${days === d ? 'bg-blue-600 text-white border-blue-600' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>{d}d</button>)}</div>
        <label className="flex flex-col text-[11px] text-slate-500">Brand terms (comma-sep)<input value={brandTerms} onChange={(e) => setBrandTerms(e.target.value)} className="mt-0.5 px-2 py-1 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 w-48" /></label>
        <label className="flex flex-col text-[11px] text-slate-500">Branded incrementality ({Math.round(brandedFactor * 100)}%)<input type="range" min="0" max="1" step="0.05" value={brandedFactor} onChange={(e) => setBrandedFactor(Number(e.target.value))} className="mt-1 w-36" /></label>
        <label className="flex flex-col text-[11px] text-slate-500">Non-branded ({Math.round(nonBrandedFactor * 100)}%)<input type="range" min="0" max="1" step="0.05" value={nonBrandedFactor} onChange={(e) => setNonBrandedFactor(Number(e.target.value))} className="mt-1 w-36" /></label>
        <button onClick={csv} className="inline-flex items-center gap-1 py-1.5 px-2 text-sm rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"><Download size={14} /> CSV</button>
      </div>

      {/* Headline tiles */}
      {t && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
          <Tile label="Ad spend" value={eur(t.spendCents)} />
          <Tile label="Reported ROAS" value={x2(t.roas)} tone="slate" />
          <Tile label="Incremental sales" value={eur(t.incrementalSalesCents)} tone="emerald" sub={`of ${eur(t.adSalesCents)} attributed`} />
          <Tile label="iROAS (modeled)" value={x2(t.iroas)} tone="fuchsia" sub="incremental ÷ spend" />
        </div>
      )}

      <div className="rounded-lg border border-slate-200 dark:border-slate-800 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr>
            <th className="text-left px-3 py-2">Campaign</th><th className="text-left px-3 py-2">Type</th><th className="text-right px-3 py-2">Spend</th><th className="text-right px-3 py-2">Ad sales</th><th className="text-right px-3 py-2">ROAS</th><th className="text-right px-3 py-2">Incr. factor</th><th className="text-right px-3 py-2">Incr. sales</th><th className="text-right px-3 py-2">iROAS</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {(data?.rows ?? []).length === 0 && !loading && <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-400 text-xs">No spend data in this window.</td></tr>}
            {(data?.rows ?? []).map((r) => (
              <tr key={r.campaignId} className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
                <td className="px-3 py-1.5 max-w-[260px] truncate">{r.name}</td>
                <td className="px-3 py-1.5"><span className={`px-1.5 py-0.5 rounded text-[11px] ${r.branded ? 'bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300' : 'bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300'}`}>{r.branded ? 'Branded' : 'Non-brand'}</span></td>
                <td className="px-3 py-1.5 text-right tabular-nums">{eur(r.spendCents)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{eur(r.adSalesCents)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-slate-400">{x2(r.roas)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-slate-400">×{r.incrementalityFactor}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-emerald-600">{eur(r.incrementalSalesCents)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums font-medium text-fuchsia-600">{x2(r.iroas)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && <p className="text-xs text-slate-400 mt-3">{data.note}</p>}
    </div>
  )
}

function Tile({ label, value, sub, tone = 'slate' }: { label: string; value: string; sub?: string; tone?: 'slate' | 'emerald' | 'fuchsia' }) {
  const c = tone === 'emerald' ? 'text-emerald-600' : tone === 'fuchsia' ? 'text-fuchsia-600' : 'text-slate-900 dark:text-slate-100'
  return <div className="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2"><div className="text-xs text-slate-500">{label}</div><div className={`text-lg font-semibold ${c}`}>{value}</div>{sub && <div className="text-[11px] text-slate-400">{sub}</div>}</div>
}
