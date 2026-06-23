'use client'

/**
 * BM.B1 — Budget Manager, the Helium 10-matched monthly-budget cockpit.
 * One row per marketplace (H10's "Profile"): Auto Pacing · Stop Over Spend ·
 * Last Month · This Month · Next Month Budget, over the shared AdsDataGrid +
 * AdsPageHeader so the whole ads console moves in lockstep. The gear opens a
 * Settings modal (monthly budget + per-day distribution), the kebab opens a
 * More drawer (per-campaign min/max limits), and the header's primary button
 * opens the FAQ drawer. Spend + sparklines + pacing come live from
 * GET /advertising/budget-manager (BM.B2). Plan writes go through POST /plans
 * (idempotent by marketplace+month); limits through POST /campaign-limit.
 *
 * Auto Pacing / Stop Over Spend are flags here; the dry-run-safe enforcement
 * engine that acts on them (and floors bids instead of pausing) lands in BM.B3.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Info, Settings, MoreVertical, ChevronDown, ChevronLeft, ChevronRight, Pencil, AlertTriangle, BadgeDollarSign, Sparkles, Network } from 'lucide-react'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import { AdsDataGrid, type GridColumn, type GridSelectFilter } from '../campaigns/_grid/AdsDataGrid'
import { getBackendUrl } from '@/lib/backend-url'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import { Modal, Drawer } from '@/design-system/components'
import './budget-manager.css'
import { AllocationCanvas } from './AllocationCanvas'

// ── types (mirror ads-budget-manager.service BudgetManagerResult) ──────────
interface SpendSlice { month: string; budgetCents: number; spendCents: number | null; pct: number | null; daily: number[] }
interface Row {
  id: string | null; marketplace: string; tag: string | null; month: string
  monthlyBudgetCents: number; autoPacing: boolean; stopOverSpend: boolean
  calendar: Array<{ day: number; pct: number }>; campaignLimitCount: number
  spendCents: number | null; pct: number | null; expectedPct: number
  status: 'on-track' | 'over' | 'under' | 'no-budget'
  daily: number[]; forecastSpendCents: number | null; projectedOverspend: boolean
  lastMonth: SpendSlice; nextMonthBudgetCents: number | null
}
interface Result {
  month: string; prevMonth: string; nextMonth: string; daysInMonth: number; dayOfMonth: number
  rows: Row[]
  totals: { budgetCents: number; spendCents: number; pct: number | null; lastMonthSpendCents: number; nextMonthBudgetCents: number }
}
// BM.B3 enforcement preview (drives the pacing banner + Allocation Map canvas).
interface EnfCampaign { id: string; name: string; currentDailyCents: number; targetDailyCents: number | null; deltaCents: number; clamp: 'min' | 'max' | 'floor' | null; suppress: boolean; restore: boolean; currentlySuppressed: boolean }
interface EnfPlan { marketplace: string; month: string; capCents: number; mtdSpendCents: number; remainingBudgetCents: number; remainingDays: number; dayOfMonth: number; daysInMonth: number; autoPacing: boolean; stopOverSpend: boolean; capReached: boolean; todayTargetCents: number | null; campaigns: EnfCampaign[] }
interface EnforcementResult { month: string; plans: EnfPlan[]; totals: { plans: number; budgetChanges: number; suppressing: number; restoring: number; netDeltaCents: number } }

const FLAG: Record<string, string> = { IT: '🇮🇹', DE: '🇩🇪', FR: '🇫🇷', ES: '🇪🇸', GB: '🇬🇧', UK: '🇬🇧', NL: '🇳🇱', SE: '🇸🇪', PL: '🇵🇱', BE: '🇧🇪', IE: '🇮🇪', US: '🇺🇸' }
const MARKET_NAME: Record<string, string> = { IT: 'Italy', DE: 'Germany', FR: 'France', ES: 'Spain', GB: 'United Kingdom', UK: 'United Kingdom', NL: 'Netherlands', SE: 'Sweden', PL: 'Poland', BE: 'Belgium', IE: 'Ireland', US: 'United States' }
const mktName = (m: string) => MARKET_NAME[m] ?? m

const API = () => getBackendUrl()
const eur = (c: number | null | undefined) => (c == null ? '—' : `€${(c / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const pctTxt = (p: number | null | undefined) => (p == null ? '—' : `${(p * 100).toFixed(p >= 1 ? 0 : 1)}%`)
const STATUS_COLOR: Record<Row['status'], string> = { 'on-track': '#1f9d5b', over: '#d9534f', under: '#1f6fde', 'no-budget': '#9aa3b0' }
const STATUS_LABEL: Record<Row['status'], string> = { 'on-track': 'On track', over: 'Over pace', under: 'Under pace', 'no-budget': 'No budget' }

const nowMonth = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}` }
const shiftM = (month: string, d: number) => { const [y, m] = month.split('-').map(Number); const x = new Date(Date.UTC(y, m - 1 + d, 1)); return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}` }
const monthLabel = (month: string) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }) }
const daysIn = (month: string) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate() }
const parseEur = (s: string) => Math.max(0, Math.round((parseFloat(s.replace(',', '.')) || 0) * 100))

async function postJson(path: string, body: Record<string, unknown>): Promise<boolean> {
  try { const r = await fetch(`${API()}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const j = await r.json().catch(() => ({})); return r.ok && j?.error == null } catch { return false }
}

// ── tiny inline SVG sparkline ──────────────────────────────────────────────
function Sparkline({ data, color = '#1f6fde' }: { data: number[]; color?: string }) {
  const w = 92, h = 26, pad = 2
  if (!data || data.length === 0) return <svg className="bm-spark" width={w} height={h} aria-hidden="true" />
  const max = Math.max(...data, 1), n = data.length
  const hasData = data.some((v) => v > 0)
  const pts = data.map((v, i) => { const x = n === 1 ? w / 2 : pad + (i / (n - 1)) * (w - pad * 2); const y = h - pad - (v / max) * (h - pad * 2); return `${x.toFixed(1)},${y.toFixed(1)}` }).join(' ')
  return (
    <svg className="bm-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      {hasData
        ? <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        : <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} stroke="#dfe3e9" strokeWidth="1.5" />}
    </svg>
  )
}

// ── inline Active / Paused control (matches H10's pill + chevron menu) ──────
function StatusControl({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="bm-status">
      <button type="button" className={`bm-pill ${value ? 'on' : 'off'}`} onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>{value ? 'Active' : 'Paused'} <ChevronDown size={12} /></button>
      {open && <>
        <button type="button" className="bm-back" aria-label="Close" onClick={() => setOpen(false)} />
        <div className="bm-statusmenu" role="listbox">
          <button type="button" role="option" aria-selected={value} className={value ? 'on' : ''} onClick={() => { onChange(true); setOpen(false) }}>Active</button>
          <button type="button" role="option" aria-selected={!value} className={!value ? 'on' : ''} onClick={() => { onChange(false); setOpen(false) }}>Paused</button>
        </div>
      </>}
    </span>
  )
}

// ── Settings modal: monthly budget + per-day distribution ───────────────────
function SettingsModal({ row, month, onClose, onSaved, toast }: { row: Row; month: string; onClose: () => void; onSaved: () => void; toast: (m: string) => void }) {
  const dim = daysIn(month)
  const [budget, setBudget] = useState(row.monthlyBudgetCents ? (row.monthlyBudgetCents / 100).toFixed(2) : '')
  const [autoPacing, setAutoPacing] = useState(row.autoPacing)
  const [stopOverSpend, setStopOverSpend] = useState(row.stopOverSpend)
  const [custom, setCustom] = useState(row.calendar.length > 0)
  const evenPct = +(100 / dim).toFixed(2)
  const [cal, setCal] = useState<number[]>(() => { const a = Array(dim).fill(evenPct); for (const c of row.calendar) if (c.day >= 1 && c.day <= dim) a[c.day - 1] = c.pct; return a })
  const [saving, setSaving] = useState(false)
  const sum = cal.reduce((s, v) => s + (Number(v) || 0), 0)
  const budgetCents = parseEur(budget)
  const perDay = budgetCents > 0 ? budgetCents / dim : 0

  const save = async () => {
    setSaving(true)
    const calendar = custom ? cal.map((pct, i) => ({ day: i + 1, pct: Number(pct) || 0 })) : []
    const ok = await postJson('/api/advertising/budget-manager/plans', { ...(row.id ? { id: row.id } : {}), marketplace: row.marketplace, month, monthlyBudgetCents: budgetCents, autoPacing, stopOverSpend, calendar })
    setSaving(false)
    if (ok) { toast('Budget saved.'); onSaved(); onClose() } else toast('Save failed.')
  }

  return (
    <Modal open onClose={onClose} title={`${FLAG[row.marketplace] ?? '🏳️'} ${mktName(row.marketplace)} — ${monthLabel(month)}`} subtitle="Set the monthly budget and how it is distributed across the month." size="lg"
      footer={<><button type="button" className="h10-am-btn" onClick={onClose}>Cancel</button><button type="button" className="h10-am-btn primary" disabled={saving || (custom && Math.abs(sum - 100) > 0.5)} onClick={save}>{saving ? 'Saving…' : 'Save budget'}</button></>}>
      <div className="bm-set">
        <label className="bm-set-field">
          <span className="lbl">Monthly budget</span>
          <span className="bm-eurin"><span className="pf">€</span><input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="0.00" aria-label="Monthly budget" /></span>
          <span className="hint">{budgetCents > 0 ? `≈ ${eur(Math.round(perDay))}/day even across ${dim} days` : 'Set a monthly cap for this market.'}</span>
        </label>

        <div className="bm-set-controls">
          <label className="bm-swrow"><span><b>Auto Pacing</b><em>Distribute the monthly budget across the month automatically.</em></span><button type="button" className={`h10-bktoggle ${autoPacing ? 'on' : ''}`} role="switch" aria-checked={autoPacing} aria-label="Auto Pacing" onClick={() => setAutoPacing((v) => !v)}><span /></button></label>
          <label className="bm-swrow"><span><b>Stop Over Spend</b><em>When the monthly cap is reached, suppress delivery (bid-floor, never pause).</em></span><button type="button" className={`h10-bktoggle ${stopOverSpend ? 'on' : ''}`} role="switch" aria-checked={stopOverSpend} aria-label="Stop Over Spend" onClick={() => setStopOverSpend((v) => !v)}><span /></button></label>
        </div>

        <div className="bm-set-dist">
          <label className="bm-swrow tight"><span><b>Custom daily distribution</b><em>Weight specific days (tentpole events) instead of an even split.</em></span><button type="button" className={`h10-bktoggle ${custom ? 'on' : ''}`} role="switch" aria-checked={custom} aria-label="Custom daily distribution" onClick={() => setCustom((v) => !v)}><span /></button></label>
          {custom && <>
            <div className="bm-cal-tools">
              <button type="button" className="h10-am-btn" onClick={() => setCal(Array(dim).fill(evenPct))}>Distribute evenly</button>
              <span className={`bm-cal-sum ${Math.abs(sum - 100) > 0.5 ? 'bad' : 'ok'}`}>Total {sum.toFixed(1)}%{Math.abs(sum - 100) > 0.5 ? ' — must equal 100%' : ''}</span>
            </div>
            <div className="bm-cal-grid">
              {cal.map((v, i) => (
                <label key={i} className="bm-cal-day" title={`Day ${i + 1}`}>
                  <span className="d">{i + 1}</span>
                  <input inputMode="decimal" value={v} onChange={(e) => setCal((c) => c.map((x, j) => (j === i ? (Number(e.target.value) || 0) : x)))} aria-label={`Day ${i + 1} percent`} />
                </label>
              ))}
            </div>
          </>}
        </div>
      </div>
    </Modal>
  )
}

// ── More drawer: per-campaign min/max budget limits ─────────────────────────
interface BmCampaign { id: string; name: string; status: string; dailyBudgetCents: number; minCents: number | null; maxCents: number | null }
function MoreDrawer({ row, month, onClose, onSaved, toast }: { row: Row; month: string; onClose: () => void; onSaved: () => void; toast: (m: string) => void }) {
  const [camps, setCamps] = useState<BmCampaign[] | null>(null)
  const [edits, setEdits] = useState<Record<string, { min: string; max: string }>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const j = await fetch(`${API()}/api/advertising/budget-manager/campaigns?marketplace=${encodeURIComponent(row.marketplace)}&month=${month}`).then((r) => r.json())
        if (!alive) return
        const list: BmCampaign[] = Array.isArray(j?.campaigns) ? j.campaigns : []
        setCamps(list)
        setEdits(Object.fromEntries(list.map((c) => [c.id, { min: c.minCents != null ? (c.minCents / 100).toFixed(2) : '', max: c.maxCents != null ? (c.maxCents / 100).toFixed(2) : '' }])))
      } catch { if (alive) setCamps([]) }
    })()
    return () => { alive = false }
  }, [row.marketplace, month])

  const dirty = useMemo(() => {
    if (!camps) return [] as BmCampaign[]
    return camps.filter((c) => { const e = edits[c.id]; if (!e) return false; const min = e.min === '' ? null : parseEur(e.min); const max = e.max === '' ? null : parseEur(e.max); return min !== c.minCents || max !== c.maxCents })
  }, [camps, edits])

  const saveAll = async () => {
    setSaving(true)
    let ok = 0
    for (const c of dirty) {
      const e = edits[c.id]
      const good = await postJson('/api/advertising/budget-manager/campaign-limit', { marketplace: row.marketplace, month, campaignId: c.id, minCents: e.min === '' ? null : parseEur(e.min), maxCents: e.max === '' ? null : parseEur(e.max) })
      if (good) ok++
    }
    setSaving(false)
    toast(ok ? `Saved limits for ${ok} campaign${ok === 1 ? '' : 's'}.` : 'Save failed.')
    if (ok) { onSaved() }
  }

  return (
    <Drawer open onClose={onClose} title={`Campaign Budget Limits — ${mktName(row.marketplace)}`}
      footer={<><span className="bm-more-foot">{dirty.length ? `${dirty.length} change${dirty.length === 1 ? '' : 's'}` : 'No changes'}</span><button type="button" className="h10-am-btn primary" disabled={saving || !dirty.length} onClick={saveAll}>{saving ? 'Saving…' : 'Save limits'}</button></>}>
      <p className="bm-more-intro">Set a minimum and maximum daily budget per campaign. Auto Pacing keeps each campaign within these bounds when it redistributes this market’s monthly budget.</p>
      {camps == null ? <div className="bm-more-loading">Loading campaigns…</div>
        : camps.length === 0 ? <div className="bm-more-empty">No active campaigns in {mktName(row.marketplace)}.</div>
        : (
          <div className="bm-more-list">
            <div className="bm-more-head"><span>Campaign</span><span>Daily</span><span>Min €/day</span><span>Max €/day</span></div>
            {camps.map((c) => (
              <div className="bm-more-row" key={c.id}>
                <span className="nm"><span className={`bm-cdot ${c.status === 'ENABLED' ? 'on' : c.status === 'PAUSED' ? 'pa' : 'ar'}`} />{c.name}</span>
                <span className="db">{eur(c.dailyBudgetCents)}</span>
                <span className="lim"><input inputMode="decimal" placeholder="—" value={edits[c.id]?.min ?? ''} onChange={(e) => setEdits((p) => ({ ...p, [c.id]: { min: e.target.value, max: p[c.id]?.max ?? '' } }))} aria-label={`Min for ${c.name}`} /></span>
                <span className="lim"><input inputMode="decimal" placeholder="—" value={edits[c.id]?.max ?? ''} onChange={(e) => setEdits((p) => ({ ...p, [c.id]: { min: p[c.id]?.min ?? '', max: e.target.value } }))} aria-label={`Max for ${c.name}`} /></span>
              </div>
            ))}
          </div>
        )}
    </Drawer>
  )
}

// ── FAQ drawer ───────────────────────────────────────────────────────────────
const FAQ: Array<{ q: string; a: string }> = [
  { q: 'What is Budget Manager?', a: 'A cockpit for your monthly Amazon ad budget per market. It reads live spend, compares it to your cap and the expected pace-to-date, and (when enabled) automatically distributes the budget across campaigns and suppresses delivery before you overspend.' },
  { q: 'How does Auto Pacing allocate the budget?', a: 'It turns your monthly cap into daily campaign budgets, weighted by your distribution calendar and how much of the month remains, then flexes each campaign within the min/max limits you set under “More”. Every change is previewed (dry-run) and audited before it is applied.' },
  { q: 'What does Stop Over Spend do at the cap?', a: 'When month-to-date spend reaches the cap, it suppresses delivery by dropping bids to the floor (~€0.02) — it never pauses campaigns, which would disrupt Amazon’s ranking. Bids restore automatically next month or when you raise the cap.' },
  { q: 'How is “This Month” pace calculated?', a: 'Expected pace is the share of the month elapsed (or your calendar’s weighting through today). If spend is more than 10 points ahead it shows “Over pace”, more than 10 behind “Under pace”, otherwise “On track”.' },
  { q: 'Can I keep full manual control?', a: 'Yes. Leave Auto Pacing off and edit every budget by hand. Pacing and Stop Over Spend are independent per market, and nothing writes to Amazon until the enforcement engine is explicitly enabled.' },
  { q: 'What is the Next Month Budget column?', a: 'A budget you pre-set for next month so pacing starts on day one. Click the cell to set it; it creates next month’s plan for that market.' },
  { q: 'Does it support multiple markets?', a: 'Yes — one row per Amazon marketplace (Italy, Germany, France, Spain, …). Use the market selector to focus on one, or manage them all at once.' },
  { q: 'Where can I see what changed?', a: 'Every budget and bid change is recorded in the change log with its reason (manual vs automation), so you can audit and reverse any adjustment.' },
]
function FaqDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [openIdx, setOpenIdx] = useState(0)
  return (
    <Drawer open={open} onClose={onClose} title="Budget Manager — FAQ">
      <div className="bm-faq">
        {FAQ.map((f, i) => (
          <div className={`bm-faq-item ${openIdx === i ? 'open' : ''}`} key={i}>
            <button type="button" className="bm-faq-q" aria-expanded={openIdx === i} onClick={() => setOpenIdx((x) => (x === i ? -1 : i))}>{f.q}<ChevronDown size={16} /></button>
            {openIdx === i && <p className="bm-faq-a">{f.a}</p>}
          </div>
        ))}
      </div>
    </Drawer>
  )
}

// ── main ─────────────────────────────────────────────────────────────────────
export function BudgetManagerClient() {
  const [month, setMonth] = useState(nowMonth())
  const [result, setResult] = useState<Result | null>(null)
  const [loading, setLoading] = useState(true)
  const [market, setMarket] = useState('all')
  const [settingsFor, setSettingsFor] = useState<Row | null>(null)
  const [moreFor, setMoreFor] = useState<Row | null>(null)
  const [faqOpen, setFaqOpen] = useState(false)
  const [editingNext, setEditingNext] = useState<string | null>(null)
  const [nextDraft, setNextDraft] = useState('')
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const [enforcement, setEnforcement] = useState<EnforcementResult | null>(null)
  const [canvasOpen, setCanvasOpen] = useState(false)
  const [canvasMarket, setCanvasMarket] = useState('')
  const toast = useCallback((m: string) => { setToastMsg(m); window.setTimeout(() => setToastMsg((cur) => (cur === m ? null : cur)), 2600) }, [])

  const load = useCallback(async (m: string) => {
    setLoading(true)
    try {
      const r = await fetch(`${API()}/api/advertising/budget-manager?month=${m}`).then((x) => x.json())
      if (!r || !Array.isArray(r.rows)) { setResult(null); return }
      // Normalise once so a transient pre-BM.B2 payload (deploy lag) can't crash a render.
      const rows: Row[] = r.rows.map((x: Partial<Row>) => ({
        ...x,
        daily: Array.isArray(x.daily) ? x.daily : [],
        calendar: Array.isArray(x.calendar) ? x.calendar : [],
        campaignLimitCount: x.campaignLimitCount ?? 0,
        lastMonth: x.lastMonth ?? { month: r.prevMonth ?? '', budgetCents: 0, spendCents: null, pct: null, daily: [] },
        nextMonthBudgetCents: x.nextMonthBudgetCents ?? null,
      }) as Row)
      setResult({ ...r, rows })
      // refresh the BM.B3 enforcement preview alongside (non-blocking)
      fetch(`${API()}/api/advertising/budget-manager/enforcement?month=${m}`).then((x) => x.json()).then((e) => setEnforcement(e && Array.isArray(e.plans) ? e : null)).catch(() => setEnforcement(null))
    } catch { setResult(null) } finally { setLoading(false) }
  }, [])
  useEffect(() => { load(month) }, [month, load])

  const setFlag = async (row: Row, field: 'autoPacing' | 'stopOverSpend', value: boolean) => {
    const ok = await postJson('/api/advertising/budget-manager/plans', { ...(row.id ? { id: row.id } : {}), marketplace: row.marketplace, month, [field]: value })
    if (ok) { toast('Status updated successfully.'); load(month) } else toast('Update failed.')
  }
  const saveNext = async (row: Row) => {
    const cents = parseEur(nextDraft)
    setEditingNext(null)
    const ok = await postJson('/api/advertising/budget-manager/plans', { marketplace: row.marketplace, month: result!.nextMonth, monthlyBudgetCents: cents })
    if (ok) { toast('Next month budget saved.'); load(month) } else toast('Save failed.')
  }

  const markets = useMemo(() => {
    // Header dropdown offers real country markets only; legacy account-id rows
    // (e.g. a pre-merge profile id) still appear in the "All markets" grid.
    const set = new Set<string>((result?.rows ?? []).map((r) => r.marketplace).filter((m) => MARKET_NAME[m]))
    if (set.size === 0) ['IT', 'DE', 'FR', 'ES'].forEach((m) => set.add(m))
    return [...set].sort()
  }, [result])

  const shownRows = useMemo(() => (result?.rows ?? []).filter((r) => market === 'all' || r.marketplace === market), [result, market])

  const columns: GridColumn<Row>[] = useMemo(() => [
    { key: 'autoPacing', label: 'Auto Pacing', metric: false, sortable: true, tip: 'Automatically distribute the monthly budget across the month.', sortValue: (r) => (r.autoPacing ? 1 : 0), render: (r) => <StatusControl value={r.autoPacing} onChange={(v) => setFlag(r, 'autoPacing', v)} /> },
    { key: 'stopOverSpend', label: 'Stop Over Spend', metric: false, sortable: true, tip: 'Suppress delivery (bid-floor, never pause) once the monthly cap is reached.', sortValue: (r) => (r.stopOverSpend ? 1 : 0), render: (r) => <StatusControl value={r.stopOverSpend} onChange={(v) => setFlag(r, 'stopOverSpend', v)} /> },
    { key: 'lastMonth', label: 'Last Month', metric: false, sortable: true, sortValue: (r) => r.lastMonth.spendCents ?? 0, render: (r) => (<span className="bm-cell"><Sparkline data={r.lastMonth.daily} color="#9aa3b0" /><span className="bm-cellv">{eur(r.lastMonth.spendCents)}<i>{pctTxt(r.lastMonth.pct)}</i></span></span>) },
    { key: 'thisMonth', label: 'This Month', metric: false, sortable: true, sortValue: (r) => r.spendCents ?? 0, render: (r) => (<span className="bm-cell"><Sparkline data={r.daily} color={STATUS_COLOR[r.status]} /><span className="bm-cellv">{eur(r.spendCents)}<i className={`st st-${r.status}`} title={STATUS_LABEL[r.status]}>{pctTxt(r.pct)}</i></span></span>) },
    { key: 'nextMonthBudget', label: 'Next Month Budget', metric: false, sortable: true, sortValue: (r) => r.nextMonthBudgetCents ?? -1, render: (r) => (
      editingNext === r.marketplace
        ? <span className="bm-nextedit"><span className="pf">€</span><input autoFocus inputMode="decimal" value={nextDraft} onChange={(e) => setNextDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveNext(r); if (e.key === 'Escape') setEditingNext(null) }} onBlur={() => saveNext(r)} aria-label="Next month budget" /></span>
        : <button type="button" className="bm-nextbtn" onClick={() => { setEditingNext(r.marketplace); setNextDraft(r.nextMonthBudgetCents != null ? (r.nextMonthBudgetCents / 100).toFixed(2) : '') }}>{r.nextMonthBudgetCents != null ? eur(r.nextMonthBudgetCents) : <span className="ph">Set budget</span>}<Pencil size={11} /></button>
    ) },
  ], [editingNext, nextDraft, month, result]) // eslint-disable-line react-hooks/exhaustive-deps

  const filters: GridSelectFilter[] = [
    { key: 'autoPacing', label: 'Auto Pacing', kind: 'select', placeholder: 'All', value: (row) => ((row as Row).autoPacing ? 'Active' : 'Paused'), options: [{ value: 'Active', label: 'Active' }, { value: 'Paused', label: 'Paused' }] },
    { key: 'stopOverSpend', label: 'Stop Over Spend', kind: 'select', placeholder: 'All', value: (row) => ((row as Row).stopOverSpend ? 'Active' : 'Paused'), options: [{ value: 'Active', label: 'Active' }, { value: 'Paused', label: 'Paused' }] },
  ]

  const renderFirst = (r: Row): ReactNode => (
    <span className="bm-first">
      <button type="button" className="bm-ic" aria-label={`More for ${mktName(r.marketplace)}`} onClick={() => setMoreFor(r)}><MoreVertical size={15} /></button>
      <button type="button" className="bm-ic" aria-label={`Settings for ${mktName(r.marketplace)}`} onClick={() => setSettingsFor(r)}><Settings size={14} /></button>
      <span className="bm-flag">{FLAG[r.marketplace] ?? '🌐'}</span>
      <span className="bm-mkt">{mktName(r.marketplace)}{r.tag ? <em> · {r.tag}</em> : null}{r.campaignLimitCount > 0 ? <span className="bm-lim" title={`${r.campaignLimitCount} campaign limit${r.campaignLimitCount === 1 ? '' : 's'}`}>{r.campaignLimitCount} limit{r.campaignLimitCount === 1 ? '' : 's'}</span> : null}</span>
      {r.projectedOverspend && <span className="bm-warn" title={`Projected month-end spend ${eur(r.forecastSpendCents)} exceeds budget`}><AlertTriangle size={13} /></span>}
    </span>
  )

  return (
    <div className="bm-page">
      <AdsPageHeader
        title="Budget Manager"
        subtitle="Monthly ad budget per market — pacing, spend, and limits."
        markets={markets} market={market} onMarketChange={setMarket}
        onDataSync={() => load(month)} syncing={loading}
        showDateRange={false}
        primaryAction={{ label: 'Budget Manager FAQ', icon: <Info size={14} />, onClick: () => setFaqOpen(true) }}
      />

      <div className="bm-monthbar">
        <button type="button" className="bm-mnav" aria-label="Previous month" onClick={() => setMonth(shiftM(month, -1))}><ChevronLeft size={16} /></button>
        <b>{monthLabel(month)}</b>
        <button type="button" className="bm-mnav" aria-label="Next month" onClick={() => setMonth(shiftM(month, 1))}><ChevronRight size={16} /></button>
        {month !== nowMonth() && <button type="button" className="bm-today" onClick={() => setMonth(nowMonth())}>This month</button>}
        {result && <span className="bm-mb-sum">Budget <b>{eur(result.totals.budgetCents)}</b> · Spent <b>{eur(result.totals.spendCents)}</b>{result.totals.pct != null && <em> ({pctTxt(result.totals.pct)})</em>}</span>}
        <span className="bm-grow" />
        <button type="button" className="h10-am-btn" onClick={() => { setCanvasMarket(enforcement?.plans[0]?.marketplace ?? markets[0] ?? ''); setCanvasOpen(true) }}><Network size={13} /> Allocation Map</button>
        {result && <span className="bm-mb-day">Day {result.dayOfMonth} of {result.daysInMonth}</span>}
      </div>

      {enforcement && (enforcement.totals.budgetChanges > 0 || enforcement.totals.suppressing > 0 || enforcement.totals.restoring > 0) && (
        <div className="bm-pacebar">
          <span className="ico"><Sparkles size={15} /></span>
          <span className="txt"><b>Auto Pacing preview</b> — {enforcement.totals.budgetChanges} budget change{enforcement.totals.budgetChanges === 1 ? '' : 's'}{enforcement.totals.suppressing > 0 ? ` · ${enforcement.totals.suppressing} suppressing` : ''}{enforcement.totals.restoring > 0 ? ` · ${enforcement.totals.restoring} restoring` : ''} today <em>· dry-run, nothing applied</em></span>
          <span className="bm-grow" />
          <button type="button" className="h10-am-btn" onClick={() => { setCanvasMarket(enforcement.plans[0]?.marketplace ?? ''); setCanvasOpen(true) }}><Network size={13} /> View Allocation Map</button>
        </div>
      )}

      <AdsDataGrid<Row>
        rows={shownRows}
        loading={loading}
        rowId={(r) => r.id ?? `${r.marketplace}:${r.tag ?? ''}`}
        noun="Market"
        firstColLabel="Marketplace"
        renderFirst={renderFirst}
        firstSortValue={(r) => mktName(r.marketplace)}
        columns={columns}
        filters={filters}
        selectable={false}
        customizable={false}
        searchable
        searchPlaceholder="Search markets…"
        searchValue={(r) => mktName(r.marketplace)}
        pagerCentered
        defaultSort={{ key: 'thisMonth', dir: 'desc' }}
        emptyNode={<div className="bm-empty"><span className="ill"><BadgeDollarSign size={26} /></span><b>No budgets yet</b><span>Open a market’s settings (the gear) to set a monthly budget, then turn on Auto Pacing.</span></div>}
      />

      {settingsFor && <SettingsModal row={settingsFor} month={month} onClose={() => setSettingsFor(null)} onSaved={() => load(month)} toast={toast} />}
      {moreFor && <MoreDrawer row={moreFor} month={month} onClose={() => setMoreFor(null)} onSaved={() => load(month)} toast={toast} />}
      <FaqDrawer open={faqOpen} onClose={() => setFaqOpen(false)} />
      {canvasOpen && (
        <Modal open onClose={() => setCanvasOpen(false)} size="xl" title="Allocation Map" subtitle="How Auto Pacing would redistribute each market’s monthly envelope today — dry-run preview, nothing is applied.">
          {!enforcement || enforcement.plans.length === 0 ? (
            <div className="bm-more-empty">No markets have Auto Pacing or Stop Over Spend enabled this month. Turn one on to preview the allocation.</div>
          ) : (<>
            <div className="bm-canvas-head">
              {enforcement.plans.map((p) => (
                <button type="button" key={p.marketplace} className={`bm-canvas-tab ${canvasMarket === p.marketplace ? 'on' : ''}`} onClick={() => setCanvasMarket(p.marketplace)}>{FLAG[p.marketplace] ?? '🌐'} {mktName(p.marketplace)}</button>
              ))}
            </div>
            <AllocationCanvas plan={enforcement.plans.find((x) => x.marketplace === canvasMarket) ?? enforcement.plans[0]} />
          </>)}
        </Modal>
      )}

      {toastMsg && <div className="bm-toast" role="status">{toastMsg}</div>}
    </div>
  )
}
