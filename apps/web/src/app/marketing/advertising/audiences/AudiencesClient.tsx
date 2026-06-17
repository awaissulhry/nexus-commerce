'use client'

/** AX3.4 — AMC-style no-SQL audience builder. */

import { useCallback, useEffect, useState } from 'react'
import { Users, Plus, Check, Archive } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Template { type: string; label: string; blurb: string; defaultLookbackDays: number; needsAsins: boolean; funnel: string }
interface Audience { id: string; name: string; audienceType: string; marketplace: string | null; lookbackDays: number; asins: string[]; estimatedReach: number | null; reachBasis: string | null; status: string; externalAudienceId: string | null }

const FUNNEL_CHIP: Record<string, string> = {
  awareness: 'bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300',
  consideration: 'bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300',
  conversion: 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
  retention: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
}
const num = (n: number | null) => (n == null ? '—' : new Intl.NumberFormat('en-US').format(n))

export function AudiencesClient() {
  const [templates, setTemplates] = useState<Template[]>([])
  const [audiences, setAudiences] = useState<Audience[]>([])
  const [picked, setPicked] = useState<Template | null>(null)
  const [form, setForm] = useState({ name: '', marketplace: 'IT', lookbackDays: 30, asins: '' })
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    fetch(`${getBackendUrl()}/api/advertising/audience-templates`, { cache: 'no-store' }).then((x) => x.json()).then((r) => setTemplates(r.templates ?? [])).catch(() => {})
    fetch(`${getBackendUrl()}/api/advertising/audiences`, { cache: 'no-store' }).then((x) => x.json()).then((r) => setAudiences(r.items ?? [])).catch(() => {})
  }, [])
  useEffect(() => { load() }, [load])

  const pick = (t: Template) => { setPicked(t); setForm({ name: `${t.label}`, marketplace: 'IT', lookbackDays: t.defaultLookbackDays, asins: '' }) }
  const create = async () => {
    if (!picked || !form.name.trim()) return
    setBusy(true)
    try {
      await fetch(`${getBackendUrl()}/api/advertising/audiences`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: form.name.trim(), audienceType: picked.type, marketplace: form.marketplace, lookbackDays: Number(form.lookbackDays) || 30, asins: form.asins.split(/[\n,]/).map((x) => x.trim()).filter(Boolean) }) })
      setPicked(null); load()
    } finally { setBusy(false) }
  }
  const act = async (id: string, action: 'activate' | 'archive') => { await fetch(`${getBackendUrl()}/api/advertising/audiences/${id}/${action}`, { method: 'POST' }); load() }

  return (
    <div className="max-w-[1150px]">
      <div className="flex items-center gap-2 mb-1"><Users size={20} className="text-indigo-500" /><h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Audiences</h1></div>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">Build AMC-grade audiences without SQL — pick a template, set a lookback and ASINs, activate. Use them in DSP / Sponsored Display to retarget, suppress, and find new-to-brand shoppers.</p>

      {/* Template gallery */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-5">
        {templates.map((t) => (
          <button key={t.type} onClick={() => pick(t)} className={`text-left p-3 rounded-lg border transition ${picked?.type === t.type ? 'border-indigo-400 bg-indigo-50/60 dark:bg-indigo-950/30' : 'border-default dark:border-slate-800 hover:border-indigo-300'}`}>
            <div className="flex items-center justify-between"><span className="font-medium text-slate-800 dark:text-slate-100 text-sm">{t.label}</span><span className={`text-[10px] px-1.5 py-0.5 rounded ${FUNNEL_CHIP[t.funnel]}`}>{t.funnel}</span></div>
            <div className="text-xs text-slate-500 mt-1">{t.blurb}</div>
          </button>
        ))}
      </div>

      {/* Builder */}
      {picked && (
        <div className="rounded-lg border border-indigo-200 dark:border-indigo-900/50 p-4 mb-5">
          <div className="text-sm font-medium mb-2">Build: {picked.label}</div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col text-[11px] text-slate-500">Audience name<input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="mt-0.5 px-2 py-1 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950 w-56" /></label>
            <label className="flex flex-col text-[11px] text-slate-500">Market<select value={form.marketplace} onChange={(e) => setForm((f) => ({ ...f, marketplace: e.target.value }))} className="mt-0.5 px-2 py-1 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950">{['IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'SE', 'PL', 'IE', 'UK'].map((m) => <option key={m}>{m}</option>)}</select></label>
            <label className="flex flex-col text-[11px] text-slate-500">Lookback (days)<input type="number" value={form.lookbackDays} onChange={(e) => setForm((f) => ({ ...f, lookbackDays: Number(e.target.value) }))} className="mt-0.5 px-2 py-1 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950 w-24" /></label>
            {picked.needsAsins && <label className="flex flex-col text-[11px] text-slate-500 flex-1 min-w-[200px]">ASINs (comma / newline)<input value={form.asins} onChange={(e) => setForm((f) => ({ ...f, asins: e.target.value }))} placeholder="B0… , B0…" className="mt-0.5 px-2 py-1 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950" /></label>}
            <button onClick={create} disabled={busy || !form.name.trim()} className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"><Plus size={14} /> {busy ? 'Saving…' : 'Create audience'}</button>
            <button onClick={() => setPicked(null)} className="px-2 py-1.5 text-sm text-slate-500 hover:text-slate-700">Cancel</button>
          </div>
        </div>
      )}

      {/* Saved audiences */}
      <div className="rounded-lg border border-default dark:border-slate-800 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr><th className="text-left px-3 py-2">Audience</th><th className="text-left px-3 py-2">Type</th><th className="text-left px-3 py-2">Market</th><th className="text-right px-3 py-2">Lookback</th><th className="text-right px-3 py-2">Est. reach</th><th className="text-left px-3 py-2">Status</th><th className="px-3 py-2"></th></tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {audiences.length === 0 && <tr><td colSpan={7} className="px-3 py-8 text-center text-tertiary text-xs">No audiences yet — pick a template above.</td></tr>}
            {audiences.map((a) => (
              <tr key={a.id} className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
                <td className="px-3 py-1.5 font-medium">{a.name}</td>
                <td className="px-3 py-1.5 text-xs text-slate-500">{a.audienceType.replace(/_/g, ' ').toLowerCase()}</td>
                <td className="px-3 py-1.5 text-xs">{a.marketplace ?? '—'}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">{a.lookbackDays}d</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{num(a.estimatedReach)}{a.reachBasis === 'amc-estimate' ? <span className="text-[10px] text-tertiary ml-1">via AMC</span> : null}</td>
                <td className="px-3 py-1.5"><span className={`px-1.5 py-0.5 rounded text-xs ${a.status === 'ACTIVE' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300' : a.status === 'ARCHIVED' ? 'bg-slate-100 text-slate-500 dark:bg-slate-800' : 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300'}`}>{a.status.toLowerCase()}</span></td>
                <td className="px-3 py-1.5 text-right whitespace-nowrap">
                  {a.status === 'DRAFT' && <button onClick={() => act(a.id, 'activate')} className="inline-flex items-center gap-1 text-xs text-emerald-600 hover:underline"><Check size={12} /> Activate</button>}
                  {a.status !== 'ARCHIVED' && <button onClick={() => act(a.id, 'archive')} className="inline-flex items-center gap-1 text-xs text-tertiary hover:text-slate-600 ml-3"><Archive size={12} /></button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-tertiary mt-3">Past-purchaser / suppression reach is computed from your order history; viewer / cart / lookalike audiences are sized once AMC is connected (activation creates a sandbox id until then).</p>
    </div>
  )
}
