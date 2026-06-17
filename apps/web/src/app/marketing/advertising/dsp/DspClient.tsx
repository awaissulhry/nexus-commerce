'use client'

/** AX3.3 — Amazon DSP + DSP Plus (Performance+ / Brand+) builder. */

import { useCallback, useEffect, useState } from 'react'
import { Tv, Target, Megaphone, ChevronLeft } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

type DspMode = 'PERFORMANCE_PLUS' | 'BRAND_PLUS'
interface Meta { channels: Record<DspMode, string[]>; objectives: Record<DspMode, Array<{ key: string; label: string }>> }
interface DspCampaign { id: string; name: string; status: string; marketplace: string | null; dailyBudget: string; mode: DspMode | null; objective: string | null; channels: string[]; audienceName: string | null; spend: string; sales: string }
interface Audience { id: string; name: string; audienceType: string; status: string }

const MODE_CARD: Record<DspMode, { label: string; blurb: string; icon: typeof Target; accent: string }> = {
  PERFORMANCE_PLUS: { label: 'Performance+', blurb: 'Lower-funnel. AI bids on Amazon’s first-party signals to drive conversions / ROAS. Launches in 5 steps.', icon: Target, accent: 'text-emerald-500' },
  BRAND_PLUS: { label: 'Brand+', blurb: 'Upper-funnel. Maximize reach & brand lift across Fire TV, Twitch, Freevee and premium 3P inventory.', icon: Megaphone, accent: 'text-sky-500' },
}

export function DspClient() {
  const [meta, setMeta] = useState<Meta | null>(null)
  const [campaigns, setCampaigns] = useState<DspCampaign[]>([])
  const [audiences, setAudiences] = useState<Audience[]>([])
  const [mode, setMode] = useState<DspMode | null>(null)
  const [f, setF] = useState({ name: '', objective: '', marketplace: 'IT', dailyBudgetEur: '50', audienceId: '', channels: [] as string[], creativeNote: '', targetValue: '' })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(() => {
    fetch(`${getBackendUrl()}/api/advertising/dsp/meta`, { cache: 'no-store' }).then((x) => x.json()).then(setMeta).catch(() => {})
    fetch(`${getBackendUrl()}/api/advertising/dsp`, { cache: 'no-store' }).then((x) => x.json()).then((r) => setCampaigns(r.items ?? [])).catch(() => {})
    fetch(`${getBackendUrl()}/api/advertising/audiences`, { cache: 'no-store' }).then((x) => x.json()).then((r) => setAudiences((r.items ?? []).filter((a: Audience) => a.status !== 'ARCHIVED'))).catch(() => {})
  }, [])
  useEffect(() => { load() }, [load])

  const start = (m: DspMode) => { setMode(m); setMsg(''); setF((s) => ({ ...s, objective: meta?.objectives[m][0]?.key ?? '', channels: meta?.channels[m] ?? [] })) }
  const toggleChannel = (c: string) => setF((s) => ({ ...s, channels: s.channels.includes(c) ? s.channels.filter((x) => x !== c) : [...s.channels, c] }))
  const create = async () => {
    if (!mode || !f.name.trim() || !f.objective) { setMsg('Name + objective required'); return }
    setBusy(true); setMsg('')
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/dsp/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: f.name.trim(), mode, objective: f.objective, marketplace: f.marketplace, dailyBudgetEur: parseFloat(f.dailyBudgetEur) || 50, channels: f.channels, audienceId: f.audienceId || undefined, creativeNote: f.creativeNote || undefined, targetValue: f.targetValue ? parseFloat(f.targetValue) : undefined }) }).then((x) => x.json())
      if (r?.error) throw new Error(r.error)
      setMode(null); setF((s) => ({ ...s, name: '', creativeNote: '', targetValue: '' })); load()
    } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) }
  }

  if (mode) {
    const card = MODE_CARD[mode]
    return (
      <div className="max-w-[820px]">
        <button onClick={() => setMode(null)} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-2"><ChevronLeft size={14} /> DSP</button>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-1">New {card.label} campaign</h1>
        <p className="text-sm text-slate-500 mb-4">{card.blurb}</p>
        <div className="space-y-3">
          <label className="block text-xs text-slate-500">Campaign name<input value={f.name} onChange={(e) => setF((s) => ({ ...s, name: e.target.value }))} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950" /></label>
          <div className="flex gap-2">
            <label className="flex-1 text-xs text-slate-500">Objective<select value={f.objective} onChange={(e) => setF((s) => ({ ...s, objective: e.target.value }))} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950">{meta?.objectives[mode].map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}</select></label>
            <label className="flex-1 text-xs text-slate-500">Market<select value={f.marketplace} onChange={(e) => setF((s) => ({ ...s, marketplace: e.target.value }))} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950">{['IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'SE', 'PL', 'IE', 'UK'].map((m) => <option key={m}>{m}</option>)}</select></label>
            <label className="flex-1 text-xs text-slate-500">Daily budget €<input value={f.dailyBudgetEur} onChange={(e) => setF((s) => ({ ...s, dailyBudgetEur: e.target.value }))} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950" /></label>
          </div>
          <label className="block text-xs text-slate-500">Audience (AMC){' '}<select value={f.audienceId} onChange={(e) => setF((s) => ({ ...s, audienceId: e.target.value }))} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950"><option value="">Auto (Amazon selects high-intent)</option>{audiences.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
          <div className="text-xs text-slate-500">Inventory channels
            <div className="flex flex-wrap gap-2 mt-1">{(meta?.channels[mode] ?? []).map((c) => <label key={c} className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-xs cursor-pointer ${f.channels.includes(c) ? 'border-blue-400 bg-blue-50 dark:bg-blue-950/30' : 'border-default dark:border-slate-700'}`}><input type="checkbox" checked={f.channels.includes(c)} onChange={() => toggleChannel(c)} className="hidden" />{c}</label>)}</div>
          </div>
          <label className="block text-xs text-slate-500">Creative note<input value={f.creativeNote} onChange={(e) => setF((s) => ({ ...s, creativeNote: e.target.value }))} placeholder="e.g. 15s hero video + shoppable display" className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950" /></label>
          <div className="flex items-center gap-3 pt-1">
            <button onClick={create} disabled={busy || !f.name.trim()} className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">{busy ? 'Launching…' : 'Launch campaign'}</button>
            {msg && <span className="text-sm text-rose-600">{msg}</span>}
          </div>
          <p className="text-xs text-tertiary">DSP requires a DSP advertiser entitlement to push live; until that&apos;s wired the campaign is created locally (sandbox id) so you can plan the full funnel now.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-[1100px]">
      <div className="flex items-center gap-2 mb-1"><Tv size={20} className="text-violet-500" /><h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Amazon DSP</h1></div>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">Full-funnel programmatic with DSP Plus — Performance+ for conversion, Brand+ for awareness across CTV and premium inventory. Plan both in one place, powered by your AMC audiences.</p>

      <div className="grid md:grid-cols-2 gap-4 mb-6">
        {(['PERFORMANCE_PLUS', 'BRAND_PLUS'] as DspMode[]).map((m) => { const c = MODE_CARD[m]; const Icon = c.icon; return (
          <button key={m} onClick={() => start(m)} className="text-left p-4 rounded-lg border border-default dark:border-slate-800 hover:border-blue-400 hover:shadow-sm transition">
            <Icon size={24} className={`${c.accent} mb-2`} />
            <div className="font-semibold text-slate-800 dark:text-slate-100">{c.label}</div>
            <div className="text-xs text-slate-500 mt-1">{c.blurb}</div>
            <div className="mt-3 inline-block px-3 py-1.5 text-sm rounded-md bg-slate-900 text-white dark:bg-slate-700">Build campaign</div>
          </button>
        ) })}
      </div>

      <div className="rounded-lg border border-default dark:border-slate-800 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr><th className="text-left px-3 py-2">Campaign</th><th className="text-left px-3 py-2">Mode</th><th className="text-left px-3 py-2">Objective</th><th className="text-left px-3 py-2">Audience</th><th className="text-left px-3 py-2">Channels</th><th className="text-right px-3 py-2">Budget/d</th></tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {campaigns.length === 0 && <tr><td colSpan={6} className="px-3 py-8 text-center text-tertiary text-xs">No DSP campaigns yet — build a Performance+ or Brand+ campaign above.</td></tr>}
            {campaigns.map((c) => (
              <tr key={c.id} className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
                <td className="px-3 py-1.5 font-medium">{c.name}</td>
                <td className="px-3 py-1.5"><span className={`px-1.5 py-0.5 rounded text-[11px] ${c.mode === 'PERFORMANCE_PLUS' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300' : 'bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300'}`}>{c.mode === 'PERFORMANCE_PLUS' ? 'Performance+' : c.mode === 'BRAND_PLUS' ? 'Brand+' : '—'}</span></td>
                <td className="px-3 py-1.5 text-xs text-slate-500">{c.objective ?? '—'}</td>
                <td className="px-3 py-1.5 text-xs">{c.audienceName ?? <span className="text-tertiary">Auto</span>}</td>
                <td className="px-3 py-1.5 text-xs text-slate-500 max-w-[220px] truncate">{c.channels.join(', ')}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">€{Number(c.dailyBudget || 0).toFixed(0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
