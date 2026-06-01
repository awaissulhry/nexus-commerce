'use client'

/**
 * Budget pacing — monthly ad-spend budgets per marketplace with auto-pacing and
 * a never-overspend stop. Live from GET /budget-manager (plan rows + spend vs
 * expected-pace), create via POST /budget-manager/plans, delete via DELETE.
 */

import { useEffect, useState } from 'react'
import { Wallet, Plus, Trash2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface PlanRow { id: string; marketplace: string; tag?: string | null; month: string; monthlyBudgetCents: number; autoPacing: boolean; stopOverSpend: boolean; spendCents: number | null; pct: number | null; expectedPct: number | null; status: string }
interface Resp { month: string; daysInMonth: number; dayOfMonth: number; rows: PlanRow[]; totals: { budgetCents: number; spendCents: number; pct: number | null } }
const eur = (c: number | null | undefined) => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(c / 100))
const MARKETS = ['IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'SE', 'PL', 'IE', 'UK']
const statusColor: Record<string, string> = { 'on-track': 'var(--green)', over: '#cc1100', under: 'var(--amber)', 'no-budget': 'var(--ink2)' }

export function BudgetPacingTab() {
  const [d, setD] = useState<Resp | null>(null)
  const [mkt, setMkt] = useState('IT')
  const [budget, setBudget] = useState('1000')
  const [autoPace, setAutoPace] = useState(true)
  const [stopOver, setStopOver] = useState(true)
  const [busy, setBusy] = useState(false)
  const load = () => void fetch(`${getBackendUrl()}/api/advertising/budget-manager`, { cache: 'no-store' }).then((r) => r.json()).then(setD).catch(() => {})
  useEffect(load, [])

  const create = async () => {
    setBusy(true)
    try {
      await fetch(`${getBackendUrl()}/api/advertising/budget-manager/plans`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ marketplace: mkt, month: d?.month, monthlyBudgetCents: Math.round((Number(budget) || 0) * 100), autoPacing: autoPace, stopOverSpend: stopOver }) })
      load()
    } finally { setBusy(false) }
  }
  const del = async (id: string) => { setBusy(true); try { await fetch(`${getBackendUrl()}/api/advertising/budget-manager/plans/${id}`, { method: 'DELETE' }); load() } finally { setBusy(false) } }

  return (
    <div style={{ paddingTop: 4 }}>
      <div className="az-hero">
        <div className="az-stat"><div className="k">Month</div><div className="v" style={{ fontSize: 16 }}>{d?.month ?? '…'}</div><div className="s">day {d?.dayOfMonth ?? '–'} of {d?.daysInMonth ?? '–'}</div></div>
        <div className="az-stat"><div className="k">Budgeted</div><div className="v">{eur(d?.totals.budgetCents)}</div><div className="s">across {d?.rows.length ?? 0} plan(s)</div></div>
        <div className="az-stat"><div className="k">Spent</div><div className="v">{eur(d?.totals.spendCents)}</div><div className="s">{d?.totals.pct != null ? `${(d.totals.pct * 100).toFixed(0)}% of budget` : '—'}</div></div>
      </div>

      <div className="az-eng-card" style={{ marginBottom: 16 }}>
        <h4><Plus size={15} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />New monthly budget</h4>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ fontSize: 12, color: 'var(--ink2)' }}>Marketplace<br /><select value={mkt} onChange={(e) => setMkt(e.target.value)} style={{ marginTop: 4, border: '1px solid var(--border)', borderRadius: 6, padding: '7px 9px', font: 'inherit', cursor: 'pointer' }}>{MARKETS.map((m) => <option key={m}>{m}</option>)}</select></label>
          <label style={{ fontSize: 12, color: 'var(--ink2)' }}>Monthly budget (€)<br /><input type="number" value={budget} onChange={(e) => setBudget(e.target.value)} style={{ marginTop: 4, border: '1px solid var(--border)', borderRadius: 6, padding: '7px 9px', font: 'inherit', width: 130 }} /></label>
          <label className="az-rowstat" style={{ fontSize: 12.5, cursor: 'pointer' }}><input type="checkbox" checked={autoPace} onChange={(e) => setAutoPace(e.target.checked)} style={{ marginRight: 6 }} />Auto-pace evenly</label>
          <label className="az-rowstat" style={{ fontSize: 12.5, cursor: 'pointer' }}><input type="checkbox" checked={stopOver} onChange={(e) => setStopOver(e.target.checked)} style={{ marginRight: 6 }} />Stop at cap (never overspend)</label>
          <button className="az-btn dark" disabled={busy} onClick={() => void create()}>Create</button>
        </div>
      </div>

      <div className="az-tablewrap">
        <table className="az-table">
          <thead><tr><th className="l">Marketplace</th><th>Monthly budget</th><th>Spent</th><th className="l">Pace</th><th className="l">Status</th><th className="l">Settings</th><th /></tr></thead>
          <tbody>
            {(d?.rows ?? []).length === 0 && <tr><td className="az-empty" colSpan={7}>No budget plans yet — set one above to cap &amp; pace monthly spend.</td></tr>}
            {(d?.rows ?? []).map((r) => (
              <tr key={r.id}>
                <td className="l" style={{ fontWeight: 600 }}>{r.marketplace}{r.tag ? ` · ${r.tag}` : ''}</td>
                <td className="num">{eur(r.monthlyBudgetCents)}</td>
                <td className="num">{eur(r.spendCents)}</td>
                <td className="l" style={{ minWidth: 160 }}>
                  <div style={{ position: 'relative', height: 8, background: 'var(--bg2)', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ position: 'absolute', height: '100%', width: `${Math.min(100, (r.pct ?? 0) * 100)}%`, background: statusColor[r.status] ?? 'var(--link)' }} />
                    {r.expectedPct != null && <div style={{ position: 'absolute', height: '100%', width: 2, left: `${Math.min(100, r.expectedPct * 100)}%`, background: 'var(--ink)' }} title="expected pace" />}
                  </div>
                  <span className="sub">{r.pct != null ? `${(r.pct * 100).toFixed(0)}% spent` : '—'}{r.expectedPct != null ? ` · ${(r.expectedPct * 100).toFixed(0)}% expected` : ''}</span>
                </td>
                <td className="l"><span style={{ fontWeight: 700, color: statusColor[r.status] ?? 'var(--ink)', textTransform: 'capitalize' }}>{r.status.replace('-', ' ')}</span></td>
                <td className="l"><span className="sub">{r.autoPacing ? 'auto-pace' : 'flat'}{r.stopOverSpend ? ' · hard stop' : ''}</span></td>
                <td><button className="az-kebab" disabled={busy} onClick={() => void del(r.id)} style={{ color: '#cc1100' }}><Trash2 size={15} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ color: 'var(--ink2)', fontSize: 12, padding: '12px 2px' }}><Wallet size={12} style={{ verticalAlign: 'text-bottom' }} /> Pair with the <b>Monthly spend cap</b> automations (Library) for a hard failsafe that pauses everything at your limit.</div>
    </div>
  )
}
