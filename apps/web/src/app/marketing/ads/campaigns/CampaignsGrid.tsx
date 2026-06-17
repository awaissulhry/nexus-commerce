'use client'

/**
 * CBN.2 — Ad Manager (campaigns grid), pixel-matched to Helium 10 Ads.
 *   CBN.2a = grid core (toolbar + metrics/edit modes + real rows + selection)
 *   CBN.2b = filter bar (range fields + presets)
 *   CBN.2c.1 = Customize Columns (full catalog incl. NTB + profit/settings, drag-reorder, show/hide, persisted)
 * Edit-mode inline batch (Discard/Apply) + Bulk Actions modal land in CBN.2c.2/c.3.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Settings2, Download, Wand2, Plus, Search, GripVertical, X } from 'lucide-react'
import {
  DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { getBackendUrl } from '@/lib/backend-url'

interface Camp {
  id: string; name: string; marketplace: string | null; status: string
  adProduct?: string | null; type?: string | null
  biddingStrategy?: string | null; dailyBudget?: string | number | null
  spend?: number | string; sales?: number | string; acos?: number | string | null; roas?: number | string | null
  impressions?: number | string; clicks?: number | string; ppcOrders?: number; orders?: number
  trueProfitCents?: number | null; trueProfitMarginPct?: number | string | null
  portfolioId?: string | null; startDate?: string | null; endDate?: string | null
  deliveryStatus?: string | null; deliveryReasons?: string[] | null
}
type Mode = 'metrics' | 'edit'
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0)
const eur = (v: number) => `€${v.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const pct = (v: unknown) => { if (v == null || v === '') return '—'; const n = Number(v); return Number.isFinite(n) ? `${(n <= 1 ? n * 100 : n).toFixed(2)}%` : '—' }
const fmtDate = (iso?: string | null) => { if (!iso) return '—'; const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) }

const EDIT_COLS = ['Target ACoS', 'Bid Automation', 'Min/Max Budget', 'Rules', 'Bidding Strategy', 'Start Date'] as const
const STRAT_LABEL: Record<string, string> = { LEGACY_FOR_SALES: 'Down only', AUTO_FOR_SALES: 'Up and Down', MANUAL: 'Fixed' }
const STRAT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'LEGACY_FOR_SALES', label: 'Down only' },
  { value: 'AUTO_FOR_SALES', label: 'Up and Down' },
  { value: 'MANUAL', label: 'Fixed' },
]
const TYPE_LABEL: Record<string, string> = { SPONSORED_PRODUCTS: 'Sponsored Products', SPONSORED_BRANDS: 'Sponsored Brands', SPONSORED_DISPLAY: 'Sponsored Display', SP: 'Sponsored Products', SB: 'Sponsored Brands', SD: 'Sponsored Display' }

// ── column catalog (Customize Columns) ──────────────────────────────────────
type ColGroup = 'Performance' | 'New to Brand' | 'Campaign Settings'
interface ColDef { key: string; label: string; group: ColGroup }
const ALL_COLS: ColDef[] = [
  { key: 'spend', label: 'Spend', group: 'Performance' },
  { key: 'sales', label: 'Sales', group: 'Performance' },
  { key: 'acos', label: 'ACoS', group: 'Performance' },
  { key: 'roas', label: 'ROAS', group: 'Performance' },
  { key: 'impressions', label: 'Impressions', group: 'Performance' },
  { key: 'clicks', label: 'Clicks', group: 'Performance' },
  { key: 'cpc', label: 'CPC', group: 'Performance' },
  { key: 'ctr', label: 'CTR', group: 'Performance' },
  { key: 'cvr', label: 'CVR', group: 'Performance' },
  { key: 'orders', label: 'Orders', group: 'Performance' },
  { key: 'profit', label: 'True Profit', group: 'Performance' },
  { key: 'margin', label: 'Profit Margin', group: 'Performance' },
  { key: 'ntbOrders', label: 'NTB Orders', group: 'New to Brand' },
  { key: 'ntbOrdersPct', label: 'NTB Orders %', group: 'New to Brand' },
  { key: 'ntbSales', label: 'NTB Sales', group: 'New to Brand' },
  { key: 'ntbSalesPct', label: 'NTB Sales %', group: 'New to Brand' },
  { key: 'ntbUnits', label: 'NTB Units', group: 'New to Brand' },
  { key: 'ntbUnitsPct', label: 'NTB Units %', group: 'New to Brand' },
  { key: 'ntbOrderRate', label: 'NTB Order Rate', group: 'New to Brand' },
  { key: 'type', label: 'Campaign Type', group: 'Campaign Settings' },
  { key: 'portfolio', label: 'Portfolio', group: 'Campaign Settings' },
  { key: 'dailyBudget', label: 'Daily Budget', group: 'Campaign Settings' },
  { key: 'biddingStrategy', label: 'Bidding Strategy', group: 'Campaign Settings' },
  { key: 'startDate', label: 'Start Date', group: 'Campaign Settings' },
  { key: 'endDate', label: 'End Date', group: 'Campaign Settings' },
  { key: 'delivery', label: 'Delivery', group: 'Campaign Settings' },
]
const COL_BY_KEY: Record<string, ColDef> = Object.fromEntries(ALL_COLS.map((c) => [c.key, c]))
const ALL_KEYS = ALL_COLS.map((c) => c.key)
const DEFAULT_VISIBLE = ['spend', 'sales', 'acos', 'roas', 'impressions', 'clicks', 'cpc', 'ctr', 'cvr', 'orders']
const COLS_KEY = 'h10-am-columns'

function deliveryLabel(c: Camp): string {
  if (!c.deliveryStatus) return c.status === 'ENABLED' ? 'Delivering' : '—'
  return c.deliveryStatus.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (m) => m.toUpperCase())
}
function renderCol(c: Camp, key: string): ReactNode {
  const spend = num(c.spend), sales = num(c.sales), clicks = num(c.clicks), impr = num(c.impressions), orders = num(c.ppcOrders ?? c.orders)
  switch (key) {
    case 'spend': return eur(spend)
    case 'sales': return eur(sales)
    case 'acos': { const a = pct(c.acos); return a !== '—' ? a : (sales ? `${((spend / sales) * 100).toFixed(2)}%` : '—') }
    case 'roas': { const r = c.roas != null ? Number(c.roas) : (spend ? sales / spend : NaN); return Number.isFinite(r) ? r.toFixed(2) : '—' }
    case 'impressions': return impr.toLocaleString()
    case 'clicks': return clicks.toLocaleString()
    case 'cpc': return clicks ? eur(spend / clicks) : '—'
    case 'ctr': return impr ? `${((clicks / impr) * 100).toFixed(2)}%` : '—'
    case 'cvr': return clicks ? `${((orders / clicks) * 100).toFixed(2)}%` : '—'
    case 'orders': return orders ? orders.toLocaleString() : '0'
    case 'profit': return c.trueProfitCents != null ? eur(num(c.trueProfitCents) / 100) : '—'
    case 'margin': return c.trueProfitMarginPct != null ? pct(c.trueProfitMarginPct) : '—'
    case 'type': return TYPE_LABEL[c.type ?? c.adProduct ?? ''] ?? (c.type ?? 'SP')
    case 'portfolio': return c.portfolioId ? 'Assigned' : '—'
    case 'dailyBudget': return c.dailyBudget != null && c.dailyBudget !== '' ? eur(num(c.dailyBudget)) : '—'
    case 'biddingStrategy': return STRAT_LABEL[c.biddingStrategy ?? ''] ?? '—'
    case 'startDate': return fmtDate(c.startDate)
    case 'endDate': return c.endDate ? fmtDate(c.endDate) : '—'
    case 'delivery': return deliveryLabel(c)
    default: return '—' // NTB + anything without local data
  }
}

// Filter bar range fields (label · unit) — matches the H10 Ad Manager filter row.
const RANGE_FIELDS: Array<{ key: string; label: string; unit: '%' | '€' | '' }> = [
  { key: 'acos', label: 'ACoS', unit: '%' }, { key: 'roas', label: 'ROAS', unit: '' },
  { key: 'spend', label: 'Spend', unit: '€' }, { key: 'sales', label: 'Sales', unit: '€' },
  { key: 'clicks', label: 'Clicks', unit: '' }, { key: 'ppcOrders', label: 'PPC Orders', unit: '' },
  { key: 'cpc', label: 'CPC', unit: '€' }, { key: 'ctr', label: 'CTR', unit: '%' },
  { key: 'cvr', label: 'CVR', unit: '%' }, { key: 'impressions', label: 'Impressions', unit: '' },
  { key: 'dailyBudget', label: 'Daily Budget', unit: '€' },
]
function metricVal(c: Camp, key: string): number {
  const spend = num(c.spend), sales = num(c.sales), clicks = num(c.clicks), impr = num(c.impressions), orders = num(c.ppcOrders ?? c.orders)
  switch (key) {
    case 'acos': { const a = c.acos != null ? Number(c.acos) : (sales ? spend / sales : 0); return a <= 1 ? a * 100 : a }
    case 'roas': return c.roas != null ? Number(c.roas) : (spend ? sales / spend : 0)
    case 'spend': return spend; case 'sales': return sales; case 'clicks': return clicks; case 'ppcOrders': return orders
    case 'cpc': return clicks ? spend / clicks : 0; case 'ctr': return impr ? (clicks / impr) * 100 : 0
    case 'cvr': return clicks ? (orders / clicks) * 100 : 0; case 'impressions': return impr; case 'dailyBudget': return num(c.dailyBudget)
  }
  return 0
}
type Range = { min: string; max: string }
const PRESET_KEY = 'h10-am-filters'

// ── Customize Columns modal ─────────────────────────────────────────────────
function SortableColRow({ id, checked, onToggle }: { id: string; checked: boolean; onToggle: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const def = COL_BY_KEY[id]
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.55 : 1 }} className="h10-colrow">
      <button type="button" className="h10-colgrip" {...attributes} {...listeners} aria-label="Reorder column"><GripVertical size={14} /></button>
      <label className="h10-colck"><input type="checkbox" checked={checked} onChange={onToggle} /><span>{def.label}</span></label>
      <span className="grp">{def.group}</span>
    </div>
  )
}
function CustomizeModal({ order, visible, onApply, onClose }: { order: string[]; visible: string[]; onApply: (o: string[], v: string[]) => void; onClose: () => void }) {
  const [ord, setOrd] = useState<string[]>(order)
  const [vis, setVis] = useState<Set<string>>(new Set(visible))
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (over && active.id !== over.id) setOrd((o) => arrayMove(o, o.indexOf(String(active.id)), o.indexOf(String(over.id))))
  }
  const visCount = ord.filter((k) => vis.has(k)).length
  return (
    <div className="h10-modal-backdrop" onClick={onClose}>
      <div className="h10-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Customize Columns">
        <div className="h10-modal-h"><b>Customize Columns</b><button type="button" className="h10-modal-x" onClick={onClose} aria-label="Close"><X size={16} /></button></div>
        <div className="h10-modal-sub">{visCount} of {ALL_KEYS.length} columns shown · drag to reorder</div>
        <div className="h10-modal-b">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={ord} strategy={verticalListSortingStrategy}>
              {ord.filter((k) => COL_BY_KEY[k]).map((k) => (
                <SortableColRow key={k} id={k} checked={vis.has(k)} onToggle={() => setVis((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n })} />
              ))}
            </SortableContext>
          </DndContext>
        </div>
        <div className="h10-modal-f">
          <button type="button" className="h10-am-link" onClick={() => { setOrd([...ALL_KEYS]); setVis(new Set(DEFAULT_VISIBLE)) }}>Reset to default</button>
          <span className="grow" />
          <button type="button" className="h10-am-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="h10-am-btn primary" onClick={() => onApply(ord, [...vis])}>Apply</button>
        </div>
      </div>
    </div>
  )
}

// ── Bulk Actions modal (CBN.2c.3) — stages edits onto the selected set, then the
// edit-mode footer + diff-confirm handle the gated Apply (one safe write path). ──
function BulkActionsModal({ campaigns, onStage, onClose }: { campaigns: Camp[]; onStage: (e: Record<string, { biddingStrategy?: string; dailyBudget?: string }>) => void; onClose: () => void }) {
  const [action, setAction] = useState<'strategy' | 'budget'>('strategy')
  const [strat, setStrat] = useState('AUTO_FOR_SALES')
  const [budgetMode, setBudgetMode] = useState<'set' | 'incPct' | 'decPct'>('incPct')
  const [budgetVal, setBudgetVal] = useState('10')
  const stage = () => {
    const out: Record<string, { biddingStrategy?: string; dailyBudget?: string }> = {}
    for (const c of campaigns) {
      if (action === 'strategy') { out[c.id] = { biddingStrategy: strat }; continue }
      const cur = num(c.dailyBudget); const v = Number(budgetVal) || 0
      let next = budgetMode === 'set' ? v : budgetMode === 'incPct' ? cur * (1 + v / 100) : cur * (1 - v / 100)
      next = Math.max(1, Math.round(next))
      out[c.id] = { dailyBudget: String(next) }
    }
    onStage(out)
  }
  return (
    <div className="h10-modal-backdrop" onClick={onClose}>
      <div className="h10-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Bulk Actions">
        <div className="h10-modal-h"><b>Bulk Actions</b><button type="button" className="h10-modal-x" onClick={onClose} aria-label="Close"><X size={16} /></button></div>
        <div className="h10-modal-sub">Apply to {campaigns.length} selected campaign{campaigns.length > 1 ? 's' : ''} · staged for review before write</div>
        <div className="h10-modal-b">
          <div className="h10-bulk-actions">
            <button type="button" className={action === 'strategy' ? 'on' : ''} onClick={() => setAction('strategy')}>Set Bidding Strategy</button>
            <button type="button" className={action === 'budget' ? 'on' : ''} onClick={() => setAction('budget')}>Adjust Daily Budget</button>
          </div>
          {action === 'strategy' ? (
            <label className="h10-bulk-field"><span>Bidding Strategy</span>
              <select value={strat} onChange={(e) => setStrat(e.target.value)}>{STRAT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
            </label>
          ) : (
            <div className="h10-bulk-field"><span>Daily Budget</span>
              <div className="row">
                <select value={budgetMode} onChange={(e) => setBudgetMode(e.target.value as typeof budgetMode)}>
                  <option value="set">Set to (€)</option>
                  <option value="incPct">Increase by (%)</option>
                  <option value="decPct">Decrease by (%)</option>
                </select>
                <input type="number" min="0" step="1" value={budgetVal} onChange={(e) => setBudgetVal(e.target.value)} aria-label="Budget value" />
              </div>
            </div>
          )}
        </div>
        <div className="h10-modal-f">
          <span className="grow" />
          <button type="button" className="h10-am-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="h10-am-btn primary" onClick={stage}>Stage to {campaigns.length} campaign{campaigns.length > 1 ? 's' : ''}</button>
        </div>
      </div>
    </div>
  )
}

export function CampaignsGrid() {
  const [rows, setRows] = useState<Camp[]>([])
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<Mode>('metrics')
  const [search, setSearch] = useState('')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [status, setStatus] = useState('all')
  const [ranges, setRanges] = useState<Record<string, Range>>({})
  const [presetMsg, setPresetMsg] = useState('')
  const [colOrder, setColOrder] = useState<string[]>(ALL_KEYS)
  const [colVisible, setColVisible] = useState<string[]>(DEFAULT_VISIBLE)
  const [showCustomize, setShowCustomize] = useState(false)
  // CBN.2c.2 — Edit-mode inline batch (staged → diff → gated Apply)
  const [edits, setEdits] = useState<Record<string, { biddingStrategy?: string; dailyBudget?: string }>>({})
  const [showApply, setShowApply] = useState(false)
  const [applying, setApplying] = useState(false)
  const [applyMsg, setApplyMsg] = useState('')
  const [showBulk, setShowBulk] = useState(false)

  useEffect(() => {
    void fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setRows((d.items ?? []) as Camp[]))
      .catch(() => {})
      .finally(() => setLoading(false))
    try { const s = localStorage.getItem(PRESET_KEY); if (s) { const p = JSON.parse(s); setStatus(p.status ?? 'all'); setRanges(p.ranges ?? {}) } } catch { /* ignore */ }
    try {
      const s = localStorage.getItem(COLS_KEY)
      if (s) {
        const p = JSON.parse(s) as { order?: string[]; visible?: string[] }
        // reconcile against catalog: keep stored order, append any new keys, drop unknown
        const stored = (p.order ?? []).filter((k) => COL_BY_KEY[k])
        const order = [...stored, ...ALL_KEYS.filter((k) => !stored.includes(k))]
        setColOrder(order)
        setColVisible((p.visible ?? DEFAULT_VISIBLE).filter((k) => COL_BY_KEY[k]))
      }
    } catch { /* ignore */ }
  }, [])

  const setRange = (key: string, side: 'min' | 'max', v: string) => setRanges((m) => ({ ...m, [key]: { ...(m[key] ?? { min: '', max: '' }), [side]: v } }))
  const clearFilters = () => { setStatus('all'); setRanges({}); setSearch('') }
  const savePreset = () => { try { localStorage.setItem(PRESET_KEY, JSON.stringify({ status, ranges })); setPresetMsg('Saved'); setTimeout(() => setPresetMsg(''), 1500) } catch { /* ignore */ } }
  const applyColumns = (order: string[], visible: string[]) => {
    setColOrder(order); setColVisible(visible); setShowCustomize(false)
    try { localStorage.setItem(COLS_KEY, JSON.stringify({ order, visible })) } catch { /* ignore */ }
  }

  const setEdit = (id: string, patch: { biddingStrategy?: string; dailyBudget?: string }) =>
    setEdits((m) => ({ ...m, [id]: { ...m[id], ...patch } }))
  const stageBulk = (add: Record<string, { biddingStrategy?: string; dailyBudget?: string }>) => {
    setEdits((m) => { const n = { ...m }; for (const [id, e] of Object.entries(add)) n[id] = { ...n[id], ...e }; return n })
    setMode('edit'); setShowBulk(false)
  }
  const effStrat = (c: Camp) => edits[c.id]?.biddingStrategy ?? c.biddingStrategy ?? 'LEGACY_FOR_SALES'
  const effBudget = (c: Camp) => edits[c.id]?.dailyBudget ?? (c.dailyBudget != null && c.dailyBudget !== '' ? String(num(c.dailyBudget)) : '')

  // per-campaign diff vs original (drives the footer + Apply confirmation)
  const diffs = useMemo(() => {
    const out: Array<{ c: Camp; changes: Array<{ field: string; from: string; to: string }> }> = []
    for (const c of rows) {
      const e = edits[c.id]; if (!e) continue
      const ch: Array<{ field: string; from: string; to: string }> = []
      const origStrat = c.biddingStrategy ?? 'LEGACY_FOR_SALES'
      if (e.biddingStrategy && e.biddingStrategy !== origStrat) ch.push({ field: 'Bidding Strategy', from: STRAT_LABEL[origStrat] ?? '—', to: STRAT_LABEL[e.biddingStrategy] ?? e.biddingStrategy })
      if (e.dailyBudget != null && e.dailyBudget !== '' && Number(e.dailyBudget) > 0 && Number(e.dailyBudget) !== num(c.dailyBudget)) ch.push({ field: 'Daily Budget', from: c.dailyBudget != null && c.dailyBudget !== '' ? eur(num(c.dailyBudget)) : '—', to: eur(Number(e.dailyBudget)) })
      if (ch.length) out.push({ c, changes: ch })
    }
    return out
  }, [rows, edits])

  const applyAll = async () => {
    setApplying(true)
    let ok = 0; let fail = 0
    const applied: Record<string, { biddingStrategy?: string; dailyBudget?: string }> = {}
    for (const d of diffs) {
      const e = edits[d.c.id]
      const body: Record<string, unknown> = { applyImmediately: true, reason: 'Ad Manager inline edit' }
      const origStrat = d.c.biddingStrategy ?? 'LEGACY_FOR_SALES'
      if (e.biddingStrategy && e.biddingStrategy !== origStrat) body.biddingStrategy = e.biddingStrategy
      if (e.dailyBudget != null && e.dailyBudget !== '' && Number(e.dailyBudget) > 0 && Number(e.dailyBudget) !== num(d.c.dailyBudget)) body.dailyBudget = Number(e.dailyBudget)
      try {
        const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${d.c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        const j = await r.json().catch(() => ({}))
        if (r.ok && j?.ok !== false) { ok++; applied[d.c.id] = e } else fail++
      } catch { fail++ }
    }
    // optimistic local update for the rows that succeeded
    setRows((rs) => rs.map((x) => {
      const a = applied[x.id]; if (!a) return x
      return { ...x, biddingStrategy: a.biddingStrategy ?? x.biddingStrategy, dailyBudget: a.dailyBudget != null && a.dailyBudget !== '' ? a.dailyBudget : x.dailyBudget }
    }))
    setApplying(false); setEdits({}); setShowApply(false)
    setApplyMsg(`Applied ${ok} change${ok !== 1 ? 's' : ''}${fail ? ` · ${fail} failed (write-gate or non-live market)` : ''}`)
    setTimeout(() => setApplyMsg(''), 5000)
  }

  const visKeySet = useMemo(() => new Set(colVisible), [colVisible])
  const metricCols = useMemo(() => colOrder.filter((k) => visKeySet.has(k)), [colOrder, visKeySet])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((c) => {
      if (q && !c.name.toLowerCase().includes(q)) return false
      if (status === 'enabled' && c.status !== 'ENABLED') return false
      if (status === 'paused' && c.status !== 'PAUSED') return false
      if (status === 'archived' && c.status !== 'ARCHIVED') return false
      for (const f of RANGE_FIELDS) {
        const r = ranges[f.key]; if (!r || (!r.min && !r.max)) continue
        const v = metricVal(c, f.key)
        if (r.min && v < Number(r.min)) return false
        if (r.max && v > Number(r.max)) return false
      }
      return true
    })
  }, [rows, search, status, ranges])

  const allSel = filtered.length > 0 && filtered.every((c) => sel.has(c.id))
  const toggleAll = () => setSel(allSel ? new Set() : new Set(filtered.map((c) => c.id)))
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  // edit-mode cells (label-keyed). Bidding Strategy + Daily Budget are inline-
  // editable; edits stage into `edits` and surface in the Discard/Apply footer.
  const editCell = (c: Camp, col: string): ReactNode => {
    const e = edits[c.id]
    switch (col) {
      case 'Target ACoS': return '30.00%'
      case 'Bid Automation': return <span className="h10-toggle off" aria-hidden />
      case 'Min/Max Budget': {
        const dirty = e?.dailyBudget != null && e.dailyBudget !== '' && Number(e.dailyBudget) !== num(c.dailyBudget)
        return (
          <span className={`h10-bud ${dirty ? 'dirty' : ''}`}>
            <span className="cur">€</span>
            <input type="number" min="1" step="1" value={effBudget(c)} onChange={(ev) => setEdit(c.id, { dailyBudget: ev.target.value })} aria-label={`Daily budget for ${c.name}`} />
          </span>
        )
      }
      case 'Rules': return <span className="h10-rulecount">0 ⚙</span>
      case 'Bidding Strategy': {
        const dirty = !!e?.biddingStrategy && e.biddingStrategy !== (c.biddingStrategy ?? 'LEGACY_FOR_SALES')
        return (
          <select className={`h10-stratsel ${dirty ? 'dirty' : ''}`} value={effStrat(c)} onChange={(ev) => setEdit(c.id, { biddingStrategy: ev.target.value })} aria-label={`Bidding strategy for ${c.name}`}>
            {STRAT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )
      }
      case 'Start Date': return fmtDate(c.startDate)
      default: return '—'
    }
  }

  const isMetrics = mode === 'metrics'
  const headerCols: string[] = isMetrics ? metricCols : [...EDIT_COLS]
  const headerLabel = (k: string) => (isMetrics ? COL_BY_KEY[k]?.label ?? k : k)

  return (
    <div className="h10-am">
      {/* filter bar */}
      <div className="h10-am-fpanel">
        <div className="frow">
          <label className="ffield"><span>Status</span><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="all">All</option><option value="enabled">Enabled</option><option value="paused">Paused</option><option value="archived">Archived</option></select></label>
          <label className="ffield"><span>Bid Automation</span><select defaultValue="All"><option>All</option><option>On</option><option>Off</option></select></label>
          <label className="ffield"><span>Rule</span><select defaultValue="All campaigns"><option>All campaigns</option><option>Has rules</option><option>No rules</option></select></label>
          <div className="ffield"><span>Search</span><div className="h10-am-search sm"><Search size={13} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Campaign name…" /></div></div>
          {RANGE_FIELDS.map((f) => (
            <div className="ffield" key={f.key}>
              <span>{f.label}{f.unit ? ` (${f.unit})` : ''}</span>
              <div className="mm">
                <input placeholder="Min" value={ranges[f.key]?.min ?? ''} onChange={(e) => setRange(f.key, 'min', e.target.value)} />
                <input placeholder="Max" value={ranges[f.key]?.max ?? ''} onChange={(e) => setRange(f.key, 'max', e.target.value)} />
              </div>
            </div>
          ))}
        </div>
        <div className="fft">
          <span className="grow" />
          <button type="button" className="h10-am-link" onClick={savePreset}>{presetMsg || 'Save Filter Preset'}</button>
          <button type="button" className="h10-am-link" onClick={clearFilters}>Clear</button>
        </div>
      </div>

      {/* toolbar */}
      <div className="h10-am-toolbar">
        <span className="cnt">{sel.size > 0 ? <b>Selected {sel.size}</b> : `Viewing 1-${Math.min(filtered.length, 500)} of ${filtered.length} Campaigns`}</span>
        <div className="seg">
          <button type="button" className={isMetrics ? 'on' : ''} onClick={() => setMode('metrics')}>Metrics</button>
          <button type="button" className={!isMetrics ? 'on' : ''} onClick={() => setMode('edit')}>Edit Campaigns</button>
        </div>
        {sel.size > 0 && <>
          <button type="button" className="h10-am-btn" onClick={() => setShowBulk(true)}>Bulk Actions</button>
          <button type="button" className="h10-am-btn" onClick={() => setMode('edit')}>Edit Campaigns</button>
        </>}
        <span className="grow" />
        <button type="button" className="h10-am-btn" onClick={() => setShowCustomize(true)}><Settings2 size={13} /> Customize</button>
        <button type="button" className="h10-am-btn"><Download size={13} /> Export Data</button>
        <Link href="/marketing/ads/rules-automation" className="h10-am-btn"><Wand2 size={13} /> Create Rule</Link>
        <Link href="/marketing/ads-console/campaign-builder/guided" className="h10-am-btn primary"><Plus size={13} /> Campaign</Link>
      </div>

      {/* grid */}
      <div className="h10-am-grid">
        <table>
          <thead>
            <tr>
              <th className="ck"><input type="checkbox" checked={allSel} onChange={toggleAll} aria-label="Select all" /></th>
              <th className="nm">Campaign</th>
              {headerCols.map((k) => <th key={k} className="num">{headerLabel(k)}</th>)}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={headerCols.length + 2} className="empty">Loading campaigns…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={headerCols.length + 2} className="empty">No campaigns.</td></tr>
            ) : filtered.map((c) => (
              <tr key={c.id} className={sel.has(c.id) ? 'on' : ''}>
                <td className="ck"><input type="checkbox" checked={sel.has(c.id)} onChange={() => toggle(c.id)} aria-label={`Select ${c.name}`} /></td>
                <td className="nm">
                  <span className={`dot ${c.status === 'ENABLED' ? 'live' : ''}`} />
                  <span className="badge">{c.adProduct === 'SPONSORED_BRANDS' ? 'SB' : c.adProduct === 'SPONSORED_DISPLAY' ? 'SD' : 'SP'}</span>
                  <span className="t" title={c.name}>{c.name}</span>
                  {c.marketplace && <span className="mk">{c.marketplace}</span>}
                </td>
                {headerCols.map((k) => <td key={k} className="num">{isMetrics ? renderCol(c, k) : editCell(c, k)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* CBN.2c.2 — edit-mode Discard/Apply footer */}
      {mode === 'edit' && diffs.length > 0 && (
        <div className="h10-am-editbar">
          <span className="lbl"><b>{diffs.length}</b> campaign{diffs.length > 1 ? 's' : ''} edited · {diffs.reduce((n, d) => n + d.changes.length, 0)} change{diffs.reduce((n, d) => n + d.changes.length, 0) > 1 ? 's' : ''}</span>
          <span className="grow" />
          <button type="button" className="h10-am-btn" onClick={() => setEdits({})} disabled={applying}>Discard</button>
          <button type="button" className="h10-am-btn primary" onClick={() => setShowApply(true)} disabled={applying}>Review &amp; Apply</button>
        </div>
      )}

      {/* Apply confirmation — diff-then-apply (gated writes) */}
      {showApply && (
        <div className="h10-modal-backdrop" onClick={() => !applying && setShowApply(false)}>
          <div className="h10-modal wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Apply changes">
            <div className="h10-modal-h"><b>Apply changes to {diffs.length} campaign{diffs.length > 1 ? 's' : ''}</b><button type="button" className="h10-modal-x" onClick={() => !applying && setShowApply(false)} aria-label="Close"><X size={16} /></button></div>
            <div className="h10-modal-sub">Live markets push to Amazon (write-gate enforced); non-live markets update locally only.</div>
            <div className="h10-modal-b">
              {diffs.map((d) => (
                <div className="h10-diffrow" key={d.c.id}>
                  <div className="dr-nm"><span className="t" title={d.c.name}>{d.c.name}</span>{d.c.marketplace && <span className="mk">{d.c.marketplace}</span>}</div>
                  {d.changes.map((ch, i) => (
                    <div className="dr-ch" key={i}><span className="f">{ch.field}</span><span className="from">{ch.from}</span><span className="arr">→</span><span className="to">{ch.to}</span></div>
                  ))}
                </div>
              ))}
            </div>
            <div className="h10-modal-f">
              <span className="grow" />
              <button type="button" className="h10-am-btn" onClick={() => setShowApply(false)} disabled={applying}>Cancel</button>
              <button type="button" className="h10-am-btn primary" onClick={applyAll} disabled={applying}>{applying ? 'Applying…' : `Apply ${diffs.length} campaign${diffs.length > 1 ? 's' : ''}`}</button>
            </div>
          </div>
        </div>
      )}

      {applyMsg && <div className="h10-am-toast">{applyMsg}</div>}

      {showCustomize && <CustomizeModal order={colOrder} visible={colVisible} onApply={applyColumns} onClose={() => setShowCustomize(false)} />}
      {showBulk && <BulkActionsModal campaigns={rows.filter((c) => sel.has(c.id))} onStage={stageBulk} onClose={() => setShowBulk(false)} />}
    </div>
  )
}
