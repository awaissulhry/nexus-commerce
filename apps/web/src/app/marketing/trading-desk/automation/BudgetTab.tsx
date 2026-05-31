'use client'

/**
 * Automation ▸ Budget. Monthly cap per marketplace vs live spend + pace-to-date
 * (Pacvue/H10 Budget Manager): on-track / over / under, auto-pacing +
 * stop-over-spend toggles. /advertising/budget-manager (+ /plans upsert/delete).
 */

import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Trash2, Plus, ChevronLeft, ChevronRight } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Plan { id: string; marketplace: string; tag: string | null; month: string; monthlyBudgetCents: number; autoPacing: boolean; stopOverSpend: boolean; spendCents: number | null; pct: number | null; expectedPct: number; status: 'on-track' | 'over' | 'under' | 'no-budget' }
interface BMResult { month: string; daysInMonth: number; dayOfMonth: number; rows: Plan[]; totals: { budgetCents: number; spendCents: number; pct: number | null } }
const MARKETS = ['IT', 'DE', 'FR', 'ES']
const eur = (c: number | null | undefined) => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(c / 100))
const shiftMonth = (ym: string, d: number) => { const parts = ym.split('-').map(Number); let y = parts[0], m = parts[1] + d; while (m < 1) { m += 12; y-- } while (m > 12) { m -= 12; y++ } return `${y}-${String(m).padStart(2, '0')}` }
const STATUS: Record<string, { cls: string; label: string }> = { 'on-track': { cls: 'g', label: 'On track' }, over: { cls: 'r', label: 'Over pace' }, under: { cls: 'a', label: 'Under pace' }, 'no-budget': { cls: 'n', label: 'No budget' } }

export function BudgetTab() {
  const [month, setMonth] = useState<string | null>(null)
  const [data, setData] = useState<BMResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [addMkt, setAddMkt] = useState('IT')
  const [addEur, setAddEur] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try { const d = await fetch(`${getBackendUrl()}/api/advertising/budget-manager${month ? `?month=${month}` : ''}`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null); setData(d as BMResult) } finally { setLoading(false) }
  }, [month])
  useEffect(() => { void load() }, [load])

  const upsert = async (body: Record<string, unknown>) => { setBusy(JSON.stringify(body).slice(0, 40)); try { await fetch(`${getBackendUrl()}/api/advertising/budget-manager/plans`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); await load() } finally { setBusy(null) } }
  const del = async (id: string) => { if (!confirm('Delete this monthly cap?')) return; setBusy(id); try { await fetch(`${getBackendUrl()}/api/advertising/budget-manager/plans/${id}`, { method: 'DELETE' }); await load() } finally { setBusy(null) } }
  const addCap = async () => { const n = parseFloat(addEur); if (!Number.isFinite(n) || n <= 0 || !data) return; await upsert({ marketplace: addMkt, month: data.month, monthlyBudgetCents: Math.round(n * 100), autoPacing: true, stopOverSpend: false }); setAddEur('') }

  const m = data?.month ?? month ?? ''

  return (
    <div className="card">
      <div className="hd">
        Monthly budget caps
        <span className="spacer" style={{ flex: 1 }} />
        <button className="ctl" onClick={() => setMonth(shiftMonth(m, -1))} title="Previous month"><ChevronLeft size={14} /></button>
        <span style={{ fontWeight: 700, minWidth: 72, textAlign: 'center' }}>{m}</span>
        <button className="ctl" onClick={() => setMonth(shiftMonth(m, 1))} title="Next month"><ChevronRight size={14} /></button>
        <button className="ctl" onClick={() => void load()}><RefreshCw size={14} className={loading ? 'spin' : ''} /></button>
      </div>

      {data && (
        <div className="statrow" style={{ padding: '14px 14px 0' }}>
          <div className="stat"><div className="sv">{eur(data.totals.budgetCents)}</div><div className="sl">Total cap</div></div>
          <div className="stat"><div className="sv">{eur(data.totals.spendCents)}</div><div className="sl">Spent · {data.dayOfMonth}/{data.daysInMonth}d</div></div>
          <div className="stat"><div className="sv">{data.totals.pct != null ? `${Math.round(data.totals.pct * 100)}%` : '—'}</div><div className="sl">Of cap</div></div>
        </div>
      )}

      <div className="tablewrap"><table>
        <thead><tr><th className="l">Market</th><th>Monthly cap</th><th>Spent</th><th className="l">Pace</th><th>Status</th><th>Auto-pace</th><th>Stop overspend</th><th></th></tr></thead>
        <tbody>
          {!data && <tr><td colSpan={8} className="empty">Loading…</td></tr>}
          {data && data.rows.length === 0 && <tr><td colSpan={8} className="empty">No monthly caps for {m}. Add one below to enable pacing + stop-over-spend.</td></tr>}
          {data?.rows.map((p) => {
            const st = STATUS[p.status] ?? STATUS['on-track']
            const w = p.pct != null ? Math.min(100, p.pct * 100) : 0
            const mark = Math.min(100, p.expectedPct * 100)
            const barC = p.status === 'over' ? 'var(--red)' : p.status === 'under' ? 'var(--amber)' : 'var(--green)'
            return (
              <tr key={p.id}>
                <td className="l"><span className="cc az"><span className="dot" style={{ background: 'var(--az)' }} />{p.marketplace}</span>{p.tag && <span className="pill n" style={{ marginLeft: 4 }}>{p.tag}</span>}</td>
                <td className="num">{eur(p.monthlyBudgetCents)}</td>
                <td className="num">{p.spendCents == null ? <span className="sub">tag-level</span> : eur(p.spendCents)}</td>
                <td className="l"><div className="pacewrap"><div className="pacebar"><i style={{ width: `${w}%`, background: barC }} /><span className="pacemark" style={{ left: `${mark}%` }} title={`expected ${Math.round(mark)}%`} /></div><div className="sub" style={{ marginTop: 4 }}>{p.pct != null ? `${Math.round(w)}% used · ${Math.round(mark)}% expected` : 'awaiting spend'}</div></div></td>
                <td><span className={`pill ${st.cls}`}>{st.label}</span></td>
                <td><button className={`toggle ${p.autoPacing ? 'on' : ''}`} onClick={() => void upsert({ id: p.id, autoPacing: !p.autoPacing })}><span className="sw"><i /></span></button></td>
                <td><button className={`toggle ${p.stopOverSpend ? 'on' : ''}`} onClick={() => void upsert({ id: p.id, stopOverSpend: !p.stopOverSpend })}><span className="sw"><i /></span></button></td>
                <td><button className="iact" disabled={busy === p.id} onClick={() => void del(p.id)}><Trash2 size={12} /></button></td>
              </tr>
            )
          })}
        </tbody>
      </table></div>

      <div className="addcap">
        <div><label>Market</label><select className="inp sm2" value={addMkt} onChange={(e) => setAddMkt(e.target.value)}>{MARKETS.map((x) => <option key={x}>{x}</option>)}</select></div>
        <div><label>Monthly cap (€)</label><input className="inp sm2" type="number" min="1" value={addEur} onChange={(e) => setAddEur(e.target.value)} placeholder="e.g. 2000" /></div>
        <button className="btn ok" disabled={!addEur || !data} onClick={() => void addCap()}><Plus size={14} />Add cap</button>
        <span className="note" style={{ marginLeft: 'auto', alignSelf: 'center' }}>Stop-over-spend pauses campaigns when the cap is hit; auto-pace stretches spend across the month.</span>
      </div>
    </div>
  )
}
