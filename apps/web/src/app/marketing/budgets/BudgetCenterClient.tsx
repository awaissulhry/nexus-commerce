'use client'

/**
 * UM-series (P7) — Budget command center client.
 *
 * Pool cards with strategy/cooldown/max-shift/dry-run controls; per-pool
 * allocations + a rebalance preview that shows the current→proposed diff
 * (and guardrail notes: maxShift scaling, cooldown) before apply. Apply
 * routes through the guarded mutation path (Amazon sandbox until P8).
 */

import { useCallback, useState } from 'react'
import { Plus, Wallet, Scale, X, ArrowRight, Trash2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { useMarketingEvents } from '@/lib/sync/use-marketing-events'

interface Alloc {
  id: string; campaignId: string; channel: string; marketplace: string | null
  targetSharePct: string; minDailyBudgetCents: number; maxDailyBudgetCents: number | null
  campaign: { id: string; name: string; channel: string; budgetCents: number | null; currency: string }
}
export interface BudgetPool {
  id: string; name: string; description: string | null; scope: string; currency: string
  totalDailyCents: number; strategy: string; coolDownMinutes: number; maxShiftPerRebalancePct: number
  enabled: boolean; dryRun: boolean; lastRebalancedAt: string | null
  allocations: Alloc[]; _count?: { rebalances: number }
}
interface Proposal {
  campaignId: string; campaignName: string; channel: string; marketplace: string | null
  currentCents: number; proposedCents: number; shiftCents: number; weight: number
}
interface Preview {
  strategy: string; totalDailyCents: number; proposals: Proposal[]
  totalShiftCents: number; capped: boolean; cooldownActive: boolean; cooldownEndsAt: string | null; note: string | null
}

const STRATEGIES = ['STATIC', 'PROFIT_WEIGHTED', 'ROAS_WEIGHTED']
const eur = (c: number | null | undefined, cur = 'EUR') => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: cur }).format(c / 100))
const api = (p: string, body?: unknown, method = body ? 'POST' : 'GET') =>
  fetch(`${getBackendUrl()}/api/marketing/os${p}`, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) })

export function BudgetCenterClient({ initialPools }: { initialPools: BudgetPool[] }) {
  const [pools, setPools] = useState(initialPools)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ name: '', totalEur: '', strategy: 'PROFIT_WEIGHTED', maxShift: '20', cooldown: '60', dryRun: true })
  const [preview, setPreview] = useState<{ poolId: string; data: Preview } | null>(null)
  const [addingTo, setAddingTo] = useState<string | null>(null)
  const [newCampaignId, setNewCampaignId] = useState('')

  const refetch = useCallback(async () => {
    const res = await api('/budgets')
    if (res.ok) setPools((await res.json()).items ?? [])
  }, [])
  useMarketingEvents(useCallback(() => void refetch(), [refetch]), { eventTypes: ['budget.rebalanced', 'campaign.mutated'] })

  const createPool = async () => {
    await api('/budgets', { name: form.name, totalDailyCents: Math.round(parseFloat(form.totalEur || '0') * 100), strategy: form.strategy, maxShiftPerRebalancePct: parseInt(form.maxShift, 10) || 20, coolDownMinutes: parseInt(form.cooldown, 10) || 60, dryRun: form.dryRun, enabled: true })
    setCreating(false); setForm({ name: '', totalEur: '', strategy: 'PROFIT_WEIGHTED', maxShift: '20', cooldown: '60', dryRun: true })
    void refetch()
  }
  const patchPool = async (id: string, body: Record<string, unknown>) => { await api(`/budgets/${id}`, body, 'PATCH'); void refetch() }
  const delPool = async (id: string) => { await api(`/budgets/${id}`, undefined, 'DELETE'); void refetch() }
  const addAlloc = async (poolId: string) => { if (!newCampaignId.trim()) return; await api(`/budgets/${poolId}/allocations`, { campaignId: newCampaignId.trim() }); setAddingTo(null); setNewCampaignId(''); void refetch() }
  const delAlloc = async (allocId: string) => { await api(`/allocations/${allocId}`, undefined, 'DELETE'); void refetch() }
  const doPreview = async (poolId: string) => { const res = await api(`/budgets/${poolId}/rebalance/preview`); if (res.ok) setPreview({ poolId, data: await res.json() }) }
  const doApply = async (poolId: string) => { await api(`/budgets/${poolId}/rebalance/apply`, {}, 'POST'); setPreview(null); void refetch() }

  return (
    <div className="p-4 sm:p-6 max-w-[1200px] mx-auto">
      <header className="flex flex-wrap items-center gap-3 mb-4">
        <div className="flex items-center gap-2"><Wallet size={20} className="text-amber-500" /><h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Budget command center</h1></div>
        <p className="w-full sm:w-auto text-sm text-slate-500 dark:text-slate-400">Cross-channel pools, FX-normalized. Preview the rebalance diff before applying; max-shift %, cooldown, and dry-run bound every move (Amazon sandbox until cutover).</p>
        <button onClick={() => setCreating(true)} className="ml-auto inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md bg-amber-600 text-white hover:bg-amber-700"><Plus size={14} /> New pool</button>
      </header>

      {pools.length === 0 && <div className="rounded-lg border border-default dark:border-slate-800 p-10 text-center text-tertiary">No budget pools yet. Create one and allocate campaigns across channels.</div>}

      <div className="space-y-4">
        {pools.map((p) => (
          <div key={p.id} className="rounded-lg border border-default dark:border-slate-800 overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 bg-slate-50 dark:bg-slate-900/60 border-b border-default dark:border-slate-800">
              <span className="font-medium text-slate-800 dark:text-slate-100">{p.name}</span>
              <span className="text-sm text-slate-500">{eur(p.totalDailyCents, p.currency)}/day</span>
              <select value={p.strategy} onChange={(e) => patchPool(p.id, { strategy: e.target.value })} className="text-xs px-1.5 py-0.5 rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950">{STRATEGIES.map((s) => <option key={s}>{s}</option>)}</select>
              <span className="text-xs text-tertiary">max-shift {p.maxShiftPerRebalancePct}% · cooldown {p.coolDownMinutes}m</span>
              <button onClick={() => patchPool(p.id, { dryRun: !p.dryRun })} className={`px-1.5 py-0.5 rounded text-xs font-medium ${p.dryRun ? 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' : 'bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300'}`}>{p.dryRun ? 'dry-run' : 'LIVE'}</button>
              <div className="ml-auto flex gap-2">
                <button onClick={() => setAddingTo(p.id)} className="text-xs px-2 py-1 rounded border border-default dark:border-slate-700 hover:bg-white dark:hover:bg-slate-800">+ Campaign</button>
                <button onClick={() => doPreview(p.id)} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"><Scale size={12} /> Preview rebalance</button>
                <button onClick={() => delPool(p.id)} className="text-rose-500 p-1"><Trash2 size={13} /></button>
              </div>
            </div>

            {addingTo === p.id && (
              <div className="px-4 py-2 flex items-center gap-2 border-b border-subtle dark:border-slate-800 bg-blue-50/30 dark:bg-blue-950/10">
                <input autoFocus placeholder="Campaign id to allocate" value={newCampaignId} onChange={(e) => setNewCampaignId(e.target.value)} className="flex-1 px-2 py-1 text-xs rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950" />
                <button onClick={() => addAlloc(p.id)} className="text-xs px-2 py-1 rounded bg-blue-600 text-white">Add</button>
                <button onClick={() => { setAddingTo(null); setNewCampaignId('') }} className="text-xs text-tertiary">Cancel</button>
              </div>
            )}

            <table className="w-full text-sm">
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {p.allocations.length === 0 && <tr><td className="px-4 py-3 text-xs text-tertiary">No campaigns allocated.</td></tr>}
                {p.allocations.map((a) => (
                  <tr key={a.id} className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
                    <td className="px-4 py-1.5"><span className="text-slate-700 dark:text-slate-200">{a.campaign.name}</span> <span className="text-xs text-tertiary">{a.channel}{a.marketplace ? `·${a.marketplace}` : ''}</span></td>
                    <td className="px-4 py-1.5 text-right tabular-nums text-slate-500">{eur(a.campaign.budgetCents, a.campaign.currency)}/day</td>
                    <td className="px-4 py-1.5 text-right"><button onClick={() => delAlloc(a.id)} className="text-rose-400"><X size={13} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>

            {preview?.poolId === p.id && (
              <div className="border-t border-blue-200 dark:border-blue-900 bg-blue-50/40 dark:bg-blue-950/20 p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-blue-700 dark:text-blue-300">Rebalance preview ({preview.data.strategy}) — total shift {eur(preview.data.totalShiftCents)}</span>
                  <div className="flex gap-2">
                    <button onClick={() => doApply(p.id)} className="text-xs px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700">{p.dryRun ? 'Apply (dry-run audit)' : 'Apply live'}</button>
                    <button onClick={() => setPreview(null)}><X size={14} /></button>
                  </div>
                </div>
                {(preview.data.note || preview.data.cooldownActive) && <div className="text-[11px] text-amber-600 mb-1">{preview.data.cooldownActive ? `⏳ cooldown active until ${preview.data.cooldownEndsAt?.slice(0, 16)} · ` : ''}{preview.data.note}</div>}
                <table className="w-full text-xs">
                  <tbody>
                    {preview.data.proposals.map((pr) => (
                      <tr key={pr.campaignId}>
                        <td className="py-0.5 text-slate-600 dark:text-slate-300">{pr.campaignName} <span className="text-tertiary">{pr.channel}</span></td>
                        <td className="py-0.5 text-right tabular-nums text-slate-500">{eur(pr.currentCents)}</td>
                        <td className="py-0.5 px-2 text-center text-tertiary"><ArrowRight size={11} className="inline" /></td>
                        <td className="py-0.5 text-right tabular-nums font-medium text-slate-800 dark:text-slate-100">{eur(pr.proposedCents)}</td>
                        <td className={`py-0.5 pl-3 text-right tabular-nums ${pr.shiftCents > 0 ? 'text-emerald-600' : pr.shiftCents < 0 ? 'text-rose-600' : 'text-tertiary'}`}>{pr.shiftCents > 0 ? '+' : ''}{eur(pr.shiftCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
      </div>

      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setCreating(false)}>
          <div className="bg-white dark:bg-slate-900 rounded-lg shadow-xl w-full max-w-md p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3"><h2 className="font-semibold">New budget pool</h2><button onClick={() => setCreating(false)}><X size={16} /></button></div>
            <div className="space-y-3">
              <input autoFocus placeholder="Pool name (e.g. EU Helmets Q4)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950" />
              <div className="flex gap-2">
                <label className="flex-1 text-xs text-slate-500">Daily total €<input value={form.totalEur} onChange={(e) => setForm({ ...form, totalEur: e.target.value })} placeholder="500.00" className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950" /></label>
                <label className="flex-1 text-xs text-slate-500">Strategy<select value={form.strategy} onChange={(e) => setForm({ ...form, strategy: e.target.value })} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950">{STRATEGIES.map((s) => <option key={s}>{s}</option>)}</select></label>
              </div>
              <div className="flex gap-2">
                <label className="flex-1 text-xs text-slate-500">Max-shift %<input value={form.maxShift} onChange={(e) => setForm({ ...form, maxShift: e.target.value })} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950" /></label>
                <label className="flex-1 text-xs text-slate-500">Cooldown min<input value={form.cooldown} onChange={(e) => setForm({ ...form, cooldown: e.target.value })} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950" /></label>
                <label className="flex items-center gap-1 text-xs text-slate-500 mt-4"><input type="checkbox" checked={form.dryRun} onChange={(e) => setForm({ ...form, dryRun: e.target.checked })} /> dry-run</label>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4"><button onClick={() => setCreating(false)} className="px-3 py-1.5 text-sm rounded border border-default dark:border-slate-700">Cancel</button><button onClick={createPool} disabled={!form.name || !form.totalEur} className="px-3 py-1.5 text-sm rounded bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50">Create</button></div>
          </div>
        </div>
      )}
    </div>
  )
}
