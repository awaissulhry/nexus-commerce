'use client'

/** AX3.10 — Budget Manager: monthly budget vs live spend + pace, auto-pacing
 *  & stop-over-spend guards, per-day allocation calendar for tentpole events. */

import { useCallback, useEffect, useState } from 'react'
import { Wallet, Plus, Trash2, CalendarDays, X } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { eur0 as eur } from '@/app/_shared/ads-ui'

interface Plan { id: string; marketplace: string; tag: string | null; month: string; monthlyBudgetCents: number; autoPacing: boolean; stopOverSpend: boolean; calendar: Array<{ day: number; pct: number }>; spendCents: number | null; pct: number | null; expectedPct: number; status: 'on-track' | 'over' | 'under' | 'no-budget' }
interface Result { month: string; daysInMonth: number; dayOfMonth: number; rows: Plan[]; totals: { budgetCents: number; spendCents: number; pct: number | null } }

const STATUS_CHIP: Record<string, string> = {
  'on-track': 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
  over: 'bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300',
  under: 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
  'no-budget': 'bg-slate-100 text-slate-500 dark:bg-slate-800',
}
const MKTS = ['IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'SE', 'PL', 'IE', 'UK']
function monthOptions(): string[] {
  const out: string[] = []; const n = new Date()
  for (let i = -2; i <= 2; i++) { const d = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + i, 1)); out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`) }
  return out
}

export function BudgetManagerClient() {
  const [month, setMonth] = useState(() => { const n = new Date(); return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}` })
  const [data, setData] = useState<Result | null>(null)
  const [loading, setLoading] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [add, setAdd] = useState({ marketplace: 'IT', tag: '', budget: '1000' })
  const [calPlan, setCalPlan] = useState<Plan | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    fetch(`${getBackendUrl()}/api/advertising/budget-manager?month=${month}`, { cache: 'no-store' }).then((x) => x.json()).then(setData).catch(() => {}).finally(() => setLoading(false))
  }, [month])
  useEffect(() => { load() }, [load])

  const upsert = async (body: Record<string, unknown>) => { await fetch(`${getBackendUrl()}/api/advertising/budget-manager/plans`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {}); load() }
  const createPlan = async () => { await upsert({ marketplace: add.marketplace, tag: add.tag.trim() || null, month, monthlyBudgetCents: Math.round((parseFloat(add.budget) || 0) * 100) }); setAddOpen(false); setAdd((a) => ({ ...a, tag: '', budget: '1000' })) }
  const del = async (id: string) => { await fetch(`${getBackendUrl()}/api/advertising/budget-manager/plans/${id}`, { method: 'DELETE' }).catch(() => {}); load() }

  return (
    <div className="max-w-[1100px]">
      <div className="flex items-center gap-2 mb-1"><Wallet size={20} className="text-emerald-500" /><h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Budget Manager</h1></div>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">Set a monthly budget per market, watch live spend against the expected pace, and guard with auto-pacing + stop-over-spend. Use the calendar to weight spend toward tentpole events.{loading ? ' (loading…)' : ''}</p>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <select value={month} onChange={(e) => setMonth(e.target.value)} className="px-2 py-1.5 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">{monthOptions().map((m) => <option key={m}>{m}</option>)}</select>
        {data && <span className="text-xs text-slate-400">Day {data.dayOfMonth}/{data.daysInMonth} · total {eur(data.totals.spendCents)} of {eur(data.totals.budgetCents)} {data.totals.pct != null ? `(${(data.totals.pct * 100).toFixed(0)}%)` : ''}</span>}
        <button onClick={() => setAddOpen((o) => !o)} className="ml-auto inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700"><Plus size={14} /> Add budget</button>
      </div>

      {addOpen && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 mb-3 flex flex-wrap items-end gap-2">
          <label className="flex flex-col text-[11px] text-slate-500">Market<select value={add.marketplace} onChange={(e) => setAdd((a) => ({ ...a, marketplace: e.target.value }))} className="mt-0.5 px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900">{MKTS.map((m) => <option key={m}>{m}</option>)}</select></label>
          <label className="flex flex-col text-[11px] text-slate-500">Tag (optional)<input value={add.tag} onChange={(e) => setAdd((a) => ({ ...a, tag: e.target.value }))} placeholder="e.g. Brand / Generic" className="mt-0.5 px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 w-36" /></label>
          <label className="flex flex-col text-[11px] text-slate-500">Monthly budget €<input type="number" value={add.budget} onChange={(e) => setAdd((a) => ({ ...a, budget: e.target.value }))} className="mt-0.5 px-2 py-1 text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 w-28" /></label>
          <button onClick={createPlan} className="px-3 py-1 text-sm rounded bg-blue-600 text-white hover:bg-blue-700">Add</button>
        </div>
      )}

      <div className="rounded-lg border border-slate-200 dark:border-slate-800 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr><th className="text-left px-3 py-2">Market / Tag</th><th className="text-right px-3 py-2">Monthly budget</th><th className="text-right px-3 py-2">Spend</th><th className="text-left px-3 py-2 w-40">Pace</th><th className="text-center px-3 py-2">Auto-pace</th><th className="text-center px-3 py-2">Stop over-spend</th><th className="text-center px-3 py-2">Calendar</th><th className="px-3 py-2"></th></tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {(data?.rows ?? []).length === 0 && !loading && <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-400 text-xs">No budgets for {month} — add one above.</td></tr>}
            {(data?.rows ?? []).map((p) => (
              <tr key={p.id} className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
                <td className="px-3 py-1.5"><span className="font-medium">{p.marketplace}</span>{p.tag ? <span className="text-xs text-slate-400"> · {p.tag}</span> : null}</td>
                <td className="px-3 py-1.5 text-right tabular-nums"><BudgetCell plan={p} onSave={(cents) => upsert({ id: p.id, monthlyBudgetCents: cents })} /></td>
                <td className="px-3 py-1.5 text-right tabular-nums">{eur(p.spendCents)}</td>
                <td className="px-3 py-1.5">
                  <div className="flex items-center gap-2">
                    <span className="relative w-24 h-2 rounded bg-slate-100 dark:bg-slate-800 overflow-hidden">
                      <span className="absolute inset-y-0 left-0 bg-blue-500" style={{ width: `${Math.min(100, (p.pct ?? 0) * 100)}%` }} />
                      <span className="absolute inset-y-0 w-px bg-slate-500" style={{ left: `${Math.min(100, p.expectedPct * 100)}%` }} title="expected pace" />
                    </span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS_CHIP[p.status]}`}>{p.status === 'on-track' ? 'on track' : p.status}</span>
                  </div>
                </td>
                <td className="px-3 py-1.5 text-center"><Toggle on={p.autoPacing} onChange={(v) => upsert({ id: p.id, autoPacing: v })} /></td>
                <td className="px-3 py-1.5 text-center"><Toggle on={p.stopOverSpend} onChange={(v) => upsert({ id: p.id, stopOverSpend: v })} /></td>
                <td className="px-3 py-1.5 text-center"><button onClick={() => setCalPlan(p)} className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"><CalendarDays size={13} />{p.calendar.length ? ` ${p.calendar.length}d` : ''}</button></td>
                <td className="px-3 py-1.5 text-right"><button onClick={() => del(p.id)} className="text-slate-400 hover:text-rose-600"><Trash2 size={14} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-400 mt-3">Spend is live from your Amazon reports; tag-level rows show budget only (per-tag spend needs campaign tagging). The pace marker shows where spend <em>should</em> be today. <code className="px-1 rounded bg-slate-100 dark:bg-slate-800">stop-over-spend</code> + <code className="px-1 rounded bg-slate-100 dark:bg-slate-800">auto-pace</code> are honoured by the budget-pacing automation.</p>

      {calPlan && <CalendarModal plan={calPlan} daysInMonth={data?.daysInMonth ?? 30} onClose={() => setCalPlan(null)} onSave={(cal) => { upsert({ id: calPlan.id, calendar: cal }); setCalPlan(null) }} />}
    </div>
  )
}

function BudgetCell({ plan, onSave }: { plan: Plan; onSave: (cents: number) => void }) {
  const [edit, setEdit] = useState<string | null>(null)
  if (edit != null) return <span className="inline-flex items-center gap-1">€<input autoFocus type="number" value={edit} onChange={(e) => setEdit(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { onSave(Math.round((parseFloat(edit) || 0) * 100)); setEdit(null) } if (e.key === 'Escape') setEdit(null) }} onBlur={() => { onSave(Math.round((parseFloat(edit) || 0) * 100)); setEdit(null) }} className="w-20 px-1 py-0.5 text-right text-xs rounded border border-blue-400 bg-white dark:bg-slate-900" /></span>
  return <button onClick={() => setEdit((plan.monthlyBudgetCents / 100).toFixed(0))} className="hover:underline decoration-dotted">{eur(plan.monthlyBudgetCents)}</button>
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return <button onClick={() => onChange(!on)} className={`w-9 h-5 rounded-full relative transition ${on ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-700'}`}><span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition ${on ? 'left-4' : 'left-0.5'}`} /></button>
}

function CalendarModal({ plan, daysInMonth, onClose, onSave }: { plan: Plan; daysInMonth: number; onClose: () => void; onSave: (cal: Array<{ day: number; pct: number }>) => void }) {
  const even = +(100 / daysInMonth).toFixed(2)
  const [pcts, setPcts] = useState<Record<number, string>>(() => { const m: Record<number, string> = {}; for (const c of plan.calendar) m[c.day] = String(c.pct); return m })
  const total = Array.from({ length: daysInMonth }, (_, i) => parseFloat(pcts[i + 1] ?? String(even)) || 0).reduce((a, b) => a + b, 0)
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-lg shadow-xl max-w-[640px] w-full max-h-[85vh] overflow-y-auto p-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1"><h2 className="font-semibold text-slate-900 dark:text-slate-100">Budget calendar — {plan.marketplace}{plan.tag ? ` · ${plan.tag}` : ''}</h2><button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button></div>
        <p className="text-xs text-slate-500 mb-3">% of the monthly budget per day. Blank = even split ({even}%). Weight tentpole days (Prime Day / Black Friday) higher. Total: <span className={total > 101 ? 'text-rose-600' : 'text-slate-600 dark:text-slate-300'}>{total.toFixed(1)}%</span></p>
        <div className="grid grid-cols-7 gap-1 mb-3">
          {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((d) => (
            <div key={d} className="rounded border border-slate-200 dark:border-slate-700 p-1 text-center">
              <div className="text-[10px] text-slate-400">{d}</div>
              <input value={pcts[d] ?? ''} onChange={(e) => setPcts((m) => ({ ...m, [d]: e.target.value }))} placeholder={String(even)} className="w-full px-0.5 py-0.5 text-xs text-center rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950" />
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => onSave(Array.from({ length: daysInMonth }, (_, i) => i + 1).filter((d) => pcts[d] != null && pcts[d] !== '').map((d) => ({ day: d, pct: parseFloat(pcts[d]) || 0 })))} className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700">Save calendar</button>
          <button onClick={() => setPcts({})} className="px-3 py-1.5 text-sm rounded-md border border-slate-200 dark:border-slate-700">Reset to even</button>
        </div>
      </div>
    </div>
  )
}
