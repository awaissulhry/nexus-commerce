'use client'

/**
 * CBN.2 — Ad Manager (campaigns grid), pixel-matched to Helium 10 Ads.
 *   CBN.2a = grid core (toolbar + metrics/edit modes + real rows + selection)
 *   CBN.2b = filter bar (range fields + presets)
 *   CBN.2c.1 = Customize Columns (full catalog incl. NTB + profit/settings, drag-reorder, show/hide, persisted)
 * Edit-mode inline batch (Discard/Apply) + Bulk Actions modal land in CBN.2c.2/c.3.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Settings2, Download, Wand2, Plus, GripVertical, X, ChevronDown, Info, Library, Trash2, MapPin } from 'lucide-react'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import {
  DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { getBackendUrl } from '@/lib/backend-url'
import { AdManagerGraph } from './AdManagerGraph'

interface Camp {
  id: string; name: string; marketplace: string | null; status: string
  adProduct?: string | null; type?: string | null
  biddingStrategy?: string | null; dailyBudget?: string | number | null
  spend?: number | string; sales?: number | string; acos?: number | string | null; roas?: number | string | null
  impressions?: number | string; clicks?: number | string; ppcOrders?: number; orders?: number
  trueProfitCents?: number | null; trueProfitMarginPct?: number | string | null
  portfolioId?: string | null; startDate?: string | null; endDate?: string | null
  deliveryStatus?: string | null; deliveryReasons?: string[] | null
  lastSyncedAt?: string | null
}
type Mode = 'metrics' | 'edit'
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0)
const eur = (v: number) => `€${v.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const pct = (v: unknown) => { if (v == null || v === '') return '—'; const n = Number(v); return Number.isFinite(n) ? `${(n <= 1 ? n * 100 : n).toFixed(2)}%` : '—' }
const fmtDate = (iso?: string | null) => { if (!iso) return '—'; const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) }

const EDIT_COLS = ['Bid Rule', 'Target ACoS', 'Min/Max Bid', 'Bid Automation', 'Min/Max Budget', 'Rules', 'Bidding Strategy', 'Bid Multiplier', 'Start Date', 'End Date', 'Daily Budget', 'Budget Utilization'] as const
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

// ── filter metadata (Helium 10 Ad Manager match) ────────────────────────────
// ⓘ tooltip copy per metric, shown next to the range-field labels.
const RANGE_TIPS: Record<string, string> = {
  acos: 'Advertising Cost of Sales — Spend ÷ Sales',
  roas: 'Return on Ad Spend — Sales ÷ Spend',
  spend: 'Total advertising spend',
  sales: 'Total advertised sales',
  clicks: 'Total ad clicks',
  ppcOrders: 'Orders attributed to advertising',
  cpc: 'Cost per click — Spend ÷ Clicks',
  ctr: 'Click-through rate — Clicks ÷ Impressions',
  cvr: 'Conversion rate — Orders ÷ Clicks',
  impressions: 'Total ad impressions',
  dailyBudget: 'Campaign daily budget',
}
const STATUS_OPTS: Array<{ value: string; label: string }> = [
  { value: 'ENABLED', label: 'Enabled' },
  { value: 'PAUSED', label: 'Paused' },
  { value: 'ARCHIVED', label: 'Archived' },
]
const TYPE_OPTS: Array<{ value: string; label: string }> = [
  { value: 'SPONSORED_PRODUCTS', label: 'Sponsored Products' },
  { value: 'SPONSORED_BRANDS', label: 'Sponsored Brands' },
  { value: 'SPONSORED_DISPLAY', label: 'Sponsored Display' },
]
const typeKey = (c: Camp): string => {
  const v = (c.adProduct ?? c.type ?? '').toUpperCase()
  if (v.includes('BRAND') || v === 'SB') return 'SPONSORED_BRANDS'
  if (v.includes('DISPLAY') || v === 'SD') return 'SPONSORED_DISPLAY'
  return 'SPONSORED_PRODUCTS'
}
type FilterPreset = { name: string; statuses: string[]; types: string[]; portfolio: string; search: string; ranges: Record<string, Range> }
const LIB_KEY = 'h10-am-preset-lib'

// Dismiss a popover on outside-click (shared by the multi-selects, the campaign
// combobox, and the Filter Library popover).
function useClickAway<T extends HTMLElement>(onAway: () => void) {
  const ref = useRef<T>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onAway() }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [onAway])
  return ref
}

// Checkbox dropdown — renders "All" / "N selected" like H10's Status + Campaign
// Type filters. `selected` always holds the concrete chosen values.
function MultiSelect({ options, selected, onChange, ariaLabel }: {
  options: Array<{ value: string; label: string }>
  selected: string[]
  onChange: (v: string[]) => void
  ariaLabel: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useClickAway<HTMLDivElement>(() => setOpen(false))
  const allOn = selected.length === options.length
  const text = allOn ? 'All'
    : selected.length === 0 ? 'None'
    : selected.length === 1 ? (options.find((o) => o.value === selected[0])?.label ?? '1 selected')
    : `${selected.length} selected`
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v])
  return (
    <div className={`h10-ms ${open ? 'open' : ''}`} ref={ref}>
      <button type="button" className="h10-ms-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}>
        <span>{text}</span><ChevronDown size={14} />
      </button>
      {open && (
        <div className="h10-ms-pop" role="listbox">
          <label className="h10-ms-opt all"><input type="checkbox" checked={allOn} onChange={() => onChange(allOn ? [] : options.map((o) => o.value))} /><span>Select all</span></label>
          {options.map((o) => (
            <label className="h10-ms-opt" key={o.value}><input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} /><span>{o.label}</span></label>
          ))}
        </div>
      )}
    </div>
  )
}

// H10's "Select a Campaign" — typeahead over campaign names. Drives the same
// name-search state the grid filters on (type to filter, pick to pin one name).
function CampaignCombo({ names, value, onChange }: { names: string[]; value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useClickAway<HTMLDivElement>(() => setOpen(false))
  const q = value.trim().toLowerCase()
  const matches = (q ? names.filter((n) => n.toLowerCase().includes(q)) : names).slice(0, 60)
  return (
    <div className={`h10-combo ${open ? 'open' : ''}`} ref={ref}>
      <input value={value} placeholder="Select a Campaign" onChange={(e) => { onChange(e.target.value); setOpen(true) }} onFocus={() => setOpen(true)} aria-label="Campaign" />
      {value
        ? <button type="button" className="cx" onClick={() => { onChange(''); setOpen(false) }} aria-label="Clear campaign"><X size={13} /></button>
        : <ChevronDown size={14} />}
      {open && matches.length > 0 && (
        <div className="h10-combo-pop" role="listbox">
          {matches.map((n) => <button type="button" key={n} onClick={() => { onChange(n); setOpen(false) }} title={n}>{n}</button>)}
        </div>
      )}
    </div>
  )
}

// Saved-filter library popover anchored to the "Filter Library" button.
function FilterLibrary({ library, onApply, onDelete, onClose }: {
  library: FilterPreset[]
  onApply: (p: FilterPreset) => void
  onDelete: (i: number) => void
  onClose: () => void
}) {
  const ref = useClickAway<HTMLDivElement>(onClose)
  return (
    <div className="h10-libpop" ref={ref} role="dialog" aria-label="Filter Library">
      <div className="h10-libpop-h">Saved Filters</div>
      {library.length === 0 ? (
        <div className="h10-libpop-empty">No saved filters yet. Set your filters, then “Save Filter Preset”.</div>
      ) : (
        <div className="h10-libpop-list">
          {library.map((p, i) => (
            <div className="h10-libpop-row" key={i}>
              <button type="button" className="nm" onClick={() => onApply(p)}>{p.name}</button>
              <button type="button" className="del" onClick={() => onDelete(i)} aria-label={`Delete ${p.name}`}><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

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

// Row icon cluster (H10): targeting letter (A=auto / M=manual, inferred from the
// campaign name) + product badge (SP/SB/SD). Status renders as a coloured pill.
const productBadge = (c: Camp): string => (c.adProduct === 'SPONSORED_BRANDS' || c.type === 'SB') ? 'SB' : (c.adProduct === 'SPONSORED_DISPLAY' || c.type === 'SD') ? 'SD' : 'SP'
const targetingLetter = (c: Camp): string => /(^|[^a-z])auto([^a-z]|$)/i.test(c.name) ? 'A' : 'M'
const STATUS_PILL: Record<string, { label: string; cls: string }> = {
  ENABLED: { label: 'Enabled', cls: 'ok' },
  PAUSED: { label: 'Paused', cls: 'warn' },
  ARCHIVED: { label: 'Archived', cls: 'arch' },
}

export function CampaignsGrid() {
  const [rows, setRows] = useState<Camp[]>([])
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<Mode>('metrics')
  const [search, setSearch] = useState('')
  const [sel, setSel] = useState<Set<string>>(new Set())
  // CBN.2b — filter bar (Helium 10 Ad Manager match). `statuses`/`types` hold the
  // concrete selected values; full-length == "All" (no filter applied).
  const [statuses, setStatuses] = useState<string[]>(STATUS_OPTS.map((o) => o.value))
  const [types, setTypes] = useState<string[]>(TYPE_OPTS.map((o) => o.value))
  const [portfolio, setPortfolio] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(true)
  const [library, setLibrary] = useState<FilterPreset[]>([])
  const [showLibrary, setShowLibrary] = useState(false)
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
  // CBN.2d — header controls
  const [market, setMarket] = useState('all')
  const [rangePreset, setRangePreset] = useState('last7')
  const [syncing, setSyncing] = useState(false)
  const [showGraph, setShowGraph] = useState(false)
  const [page, setPage] = useState(1)
  const [rowsPerPage, setRowsPerPage] = useState(100)
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null)

  const load = useCallback(async (opts?: { sync?: boolean }) => {
    if (opts?.sync) setSyncing(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`, { cache: 'no-store' })
      const d = await r.json()
      setRows((d.items ?? []) as Camp[])
    } catch { /* ignore */ } finally { setLoading(false); setSyncing(false) }
  }, [])

  useEffect(() => {
    void load()
    try { const s = localStorage.getItem(LIB_KEY); if (s) { const p = JSON.parse(s); if (Array.isArray(p)) setLibrary(p as FilterPreset[]) } } catch { /* ignore */ }
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
  const allStatuses = STATUS_OPTS.map((o) => o.value)
  const allTypes = TYPE_OPTS.map((o) => o.value)
  const clearFilters = () => { setStatuses(allStatuses); setTypes(allTypes); setPortfolio(''); setRanges({}); setSearch('') }
  const persistLibrary = (next: FilterPreset[]) => { setLibrary(next); try { localStorage.setItem(LIB_KEY, JSON.stringify(next)) } catch { /* ignore */ } }
  const savePreset = () => {
    persistLibrary([...library, { name: `Preset ${library.length + 1}`, statuses, types, portfolio, search, ranges }])
    setPresetMsg('Saved'); setTimeout(() => setPresetMsg(''), 1500); setShowLibrary(true)
  }
  const applyPreset = (p: FilterPreset) => {
    setStatuses(p.statuses ?? allStatuses); setTypes(p.types ?? allTypes); setPortfolio(p.portfolio ?? '')
    setSearch(p.search ?? ''); setRanges(p.ranges ?? {}); setShowLibrary(false)
  }
  const deletePreset = (i: number) => persistLibrary(library.filter((_, idx) => idx !== i))
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

  const markets = useMemo(() => Array.from(new Set(rows.map((r) => r.marketplace).filter(Boolean) as string[])).sort(), [rows])
  // Portfolio options derived from the data (no portfolio-name endpoint yet, so
  // labels fall back to a short id). Campaign names back the typeahead combobox.
  const portfolios = useMemo(() => {
    const ids = Array.from(new Set(rows.map((r) => r.portfolioId).filter(Boolean) as string[])).sort()
    return ids.map((id) => ({ id, label: `Portfolio ${id.slice(0, 6)}` }))
  }, [rows])
  const campaignNames = useMemo(() => Array.from(new Set(rows.map((r) => r.name))).sort((a, b) => a.localeCompare(b)), [rows])

  const statusAll = statuses.length === STATUS_OPTS.length
  const typeAll = types.length === TYPE_OPTS.length
  const hasActiveFilters = !statusAll || !typeAll || !!portfolio || !!search.trim()
    || Object.values(ranges).some((r) => r && (r.min || r.max))

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const sAll = statuses.length === STATUS_OPTS.length
    const tAll = types.length === TYPE_OPTS.length
    return rows.filter((c) => {
      if (market !== 'all' && c.marketplace !== market) return false
      if (portfolio && c.portfolioId !== portfolio) return false
      if (q && !c.name.toLowerCase().includes(q)) return false
      if (!sAll && !statuses.includes(c.status)) return false
      if (!tAll && !types.includes(typeKey(c))) return false
      for (const f of RANGE_FIELDS) {
        const r = ranges[f.key]; if (!r || (!r.min && !r.max)) continue
        const v = metricVal(c, f.key)
        if (r.min && v < Number(r.min)) return false
        if (r.max && v > Number(r.max)) return false
      }
      return true
    })
  }, [rows, search, statuses, types, portfolio, ranges, market])

  const allSel = filtered.length > 0 && filtered.every((c) => sel.has(c.id))
  const toggleAll = () => setSel(allSel ? new Set() : new Set(filtered.map((c) => c.id)))
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  // edit-mode cells (label-keyed). Bidding Strategy + Daily Budget are inline-
  // editable; edits stage into `edits` and surface in the Discard/Apply footer.
  const editCell = (c: Camp, col: string): ReactNode => {
    const e = edits[c.id]
    switch (col) {
      case 'Bid Rule': return <span className="h10-bidrule">🎯 Target ACOS</span>
      case 'Target ACoS': return '30.00%'
      case 'Min/Max Bid': return 'None'
      case 'Bid Automation': return <span className="h10-toggle off" aria-hidden />
      case 'Min/Max Budget': return 'None - None'
      case 'Rules': return <span className="h10-rules"><b>0</b> <Settings2 size={12} /></span>
      case 'Bidding Strategy': {
        const dirty = !!e?.biddingStrategy && e.biddingStrategy !== (c.biddingStrategy ?? 'LEGACY_FOR_SALES')
        return (
          <select className={`h10-stratsel ${dirty ? 'dirty' : ''}`} value={effStrat(c)} onChange={(ev) => setEdit(c.id, { biddingStrategy: ev.target.value })} aria-label={`Bidding strategy for ${c.name}`}>
            {STRAT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )
      }
      case 'Bid Multiplier': return <Settings2 size={14} className="h10-gear" aria-label="Bid multiplier" />
      case 'Start Date': return fmtDate(c.startDate)
      case 'End Date': return c.endDate ? fmtDate(c.endDate) : '-'
      case 'Daily Budget': {
        const dirty = e?.dailyBudget != null && e.dailyBudget !== '' && Number(e.dailyBudget) !== num(c.dailyBudget)
        return (
          <span className={`h10-bud ${dirty ? 'dirty' : ''}`}>
            <span className="cur">€</span>
            <input type="number" min="1" step="1" value={effBudget(c)} onChange={(ev) => setEdit(c.id, { dailyBudget: ev.target.value })} aria-label={`Daily budget for ${c.name}`} />
          </span>
        )
      }
      case 'Budget Utilization': return <span className="h10-util" aria-hidden><span className="uf" style={{ width: '2%' }} /></span>
      default: return '—'
    }
  }

  const isMetrics = mode === 'metrics'
  const headerCols: string[] = isMetrics ? metricCols : [...EDIT_COLS]
  const headerLabel = (k: string) => (isMetrics ? COL_BY_KEY[k]?.label ?? k : k)

  // sortable columns (click a header; metrics keys sort numerically, name/status text)
  const sorted = useMemo(() => {
    if (!sort) return filtered
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      if (sort.key === 'name') return a.name.toLowerCase() < b.name.toLowerCase() ? -dir : a.name.toLowerCase() > b.name.toLowerCase() ? dir : 0
      if (sort.key === 'status') return a.status < b.status ? -dir : a.status > b.status ? dir : 0
      return (metricVal(a, sort.key) - metricVal(b, sort.key)) * dir
    })
  }, [filtered, sort])
  const onSort = (key: string) => setSort((s) => (s?.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }))
  const sortIcon = (key: string) => (sort?.key === key ? (sort.dir === 'asc' ? '↑' : '↓') : '⇅')

  // client-side pagination (H10 "Rows per page") + the Latest Report stamp
  const pageCount = Math.max(1, Math.ceil(filtered.length / rowsPerPage))
  const safePage = Math.min(page, pageCount)
  const paged = sorted.slice((safePage - 1) * rowsPerPage, safePage * rowsPerPage)
  const viewStart = filtered.length === 0 ? 0 : (safePage - 1) * rowsPerPage + 1
  const viewEnd = Math.min(safePage * rowsPerPage, filtered.length)
  const latestReport = (() => {
    let max = 0
    for (const r of rows) { const t = r.lastSyncedAt ? Date.parse(r.lastSyncedAt) : 0; if (t > max) max = t }
    return max ? new Date(max).toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
  })()

  return (
    <div className="h10-am">
      <AdsPageHeader
        title="Ad Manager" subtitle="Create and manage your campaigns"
        markets={markets} market={market} onMarketChange={setMarket}
        rangePreset={rangePreset} onRangePreset={setRangePreset}
        onDataSync={() => void load({ sync: true })} syncing={syncing}
        actions={[
          { label: 'Create Campaign', href: '/marketing/ads-console/campaign-builder/guided' },
          { label: 'Create Rule', href: '/marketing/ads/rules-automation' },
          { label: showGraph ? 'Hide Graph' : 'Show Graph', onClick: () => setShowGraph((v) => !v) },
        ]}
      />

      {showGraph && <AdManagerGraph market={market} rangePreset={rangePreset} />}

      {/* filter bar — Helium 10 Ad Manager match */}
      <div className="h10-am-fpanel">
        <div className="fphead">
          <h3>Filters</h3>
          <button type="button" className="h10-am-link tog" onClick={() => setFiltersOpen((v) => !v)}>
            <ChevronDown size={14} className={filtersOpen ? 'up' : ''} />{filtersOpen ? 'Hide Filters' : 'Show Filters'}
          </button>
        </div>
        {filtersOpen && (
          <>
            <div className="fppresets">
              <span className="lbl">Filter Presets:</span>
              <div className="h10-libwrap">
                <button type="button" className="h10-am-libbtn" onClick={() => setShowLibrary((v) => !v)} aria-haspopup="dialog" aria-expanded={showLibrary}>
                  <Library size={14} /> Filter Library{library.length ? ` (${library.length})` : ''}
                </button>
                {showLibrary && <FilterLibrary library={library} onApply={applyPreset} onDelete={deletePreset} onClose={() => setShowLibrary(false)} />}
              </div>
            </div>

            <div className="frow">
              <div className="ffield wide"><span>Portfolio</span>
                <div className="h10-fsel">
                  <select value={portfolio} onChange={(e) => setPortfolio(e.target.value)} aria-label="Portfolio">
                    <option value="">Select a Portfolio</option>
                    {portfolios.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>
                  <ChevronDown size={14} />
                </div>
              </div>
              <div className="ffield wide"><span>Campaign</span>
                <CampaignCombo names={campaignNames} value={search} onChange={setSearch} />
              </div>
              <div className="ffield wide"><span>Campaign Type</span>
                <MultiSelect options={TYPE_OPTS} selected={types} onChange={setTypes} ariaLabel="Campaign Type" />
              </div>

              <div className="ffield"><span>Status</span>
                <MultiSelect options={STATUS_OPTS} selected={statuses} onChange={setStatuses} ariaLabel="Status" />
              </div>
              <div className="ffield"><span>Bid Automation</span>
                <div className="h10-fsel"><select defaultValue="All" aria-label="Bid Automation"><option>All</option><option>On</option><option>Off</option></select><ChevronDown size={14} /></div>
              </div>
              <div className="ffield"><span>Rule</span>
                <div className="h10-fsel"><select defaultValue="All campaigns" aria-label="Rule"><option>All campaigns</option><option>Has rules</option><option>No rules</option></select><ChevronDown size={14} /></div>
              </div>

              {RANGE_FIELDS.map((f) => (
                <div className="ffield" key={f.key}>
                  <span>{f.label}<span className="info" title={RANGE_TIPS[f.key] ?? ''}><Info size={12} /></span></span>
                  <div className="mm">
                    {(['min', 'max'] as const).map((side) => (
                      <div className={`mmin ${f.unit === '€' ? 'cur' : f.unit === '%' ? 'pct' : ''}`} key={side}>
                        {f.unit === '€' && <span className="ad">€</span>}
                        <input inputMode="decimal" placeholder={side === 'min' ? 'Min' : 'Max'} value={ranges[f.key]?.[side] ?? ''} onChange={(e) => setRange(f.key, side, e.target.value)} aria-label={`${f.label} ${side}`} />
                        {f.unit === '%' && <span className="ad">%</span>}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="fft">
              <span className="grow" />
              <button type="button" className="h10-am-link" onClick={savePreset} disabled={!hasActiveFilters}>{presetMsg || 'Save Filter Preset'}</button>
              <button type="button" className="h10-am-btn sm" onClick={clearFilters}>Clear</button>
            </div>
          </>
        )}
      </div>

      {/* toolbar */}
      <div className="h10-am-toolbar">
        <span className="cnt">{sel.size > 0 ? <b>Selected {sel.size}</b> : `Viewing ${viewStart}-${viewEnd} of ${filtered.length} Campaigns`}</span>
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
              <th className="nm fz"><button type="button" className="sortable" onClick={() => onSort('name')}>Campaign <i>{sortIcon('name')}</i></button></th>
              <th className="st"><button type="button" className="sortable" onClick={() => onSort('status')}>Status <i>{sortIcon('status')}</i></button></th>
              {headerCols.map((k) => <th key={k} className={isMetrics ? 'num' : 'ed'}>{isMetrics ? <button type="button" className="sortable" onClick={() => onSort(k)}>{headerLabel(k)} <i>{sortIcon(k)}</i></button> : headerLabel(k)}</th>)}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={`sk${i}`} className="sk">
                  <td className="ck"><span className="skb" style={{ width: 15 }} /></td>
                  <td className="nm fz"><span className="skb" style={{ width: 160 }} /></td>
                  <td className="st"><span className="skb" style={{ width: 58 }} /></td>
                  {headerCols.map((k) => <td key={k} className={isMetrics ? 'num' : 'ed'}><span className="skb" style={{ width: 52 }} /></td>)}
                </tr>
              ))
            ) : filtered.length === 0 ? (
              <tr><td colSpan={headerCols.length + 3} className="empty">No campaigns.</td></tr>
            ) : paged.map((c) => {
              const sp = STATUS_PILL[c.status] ?? { label: c.status, cls: '' }
              return (
                <tr key={c.id} className={sel.has(c.id) ? 'on' : ''}>
                  <td className="ck"><input type="checkbox" checked={sel.has(c.id)} onChange={() => toggle(c.id)} aria-label={`Select ${c.name}`} /></td>
                  <td className="nm fz">
                    <MapPin size={13} className="pin" aria-hidden />
                    <span className="tg" title={targetingLetter(c) === 'A' ? 'Auto targeting' : 'Manual targeting'}>{targetingLetter(c)}</span>
                    <span className="pb" data-p={productBadge(c)}>{productBadge(c)}</span>
                    <span className="t" title={c.name}>{c.name}</span>
                    {c.marketplace && <span className="mk">{c.marketplace}</span>}
                  </td>
                  <td className="st"><span className={`h10-pill ${sp.cls}`}>{sp.label}</span></td>
                  {headerCols.map((k) => <td key={k} className={isMetrics ? 'num' : 'ed'}>{isMetrics ? renderCol(c, k) : editCell(c, k)}</td>)}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* pagination + latest report (H10 footer) */}
      <div className="h10-am-pager">
        <span className="grow" />
        <div className="pg">
          <button type="button" className="pgbtn" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label="Previous page">‹</button>
          {Array.from({ length: Math.min(pageCount, 9) }).map((_, i) => (
            <button type="button" key={i} className={`pgbtn ${safePage === i + 1 ? 'on' : ''}`} onClick={() => setPage(i + 1)}>{i + 1}</button>
          ))}
          <button type="button" className="pgbtn" disabled={safePage >= pageCount} onClick={() => setPage((p) => Math.min(pageCount, p + 1))} aria-label="Next page">›</button>
        </div>
        <div className="rpp">Rows per page:
          <select value={rowsPerPage} onChange={(e) => { setRowsPerPage(Number(e.target.value)); setPage(1) }} aria-label="Rows per page">
            <option value={50}>50</option><option value={100}>100</option><option value={200}>200</option><option value={500}>500</option>
          </select>
        </div>
      </div>
      <div className="h10-am-latest"><b>Latest Report:</b> {latestReport} · Performance data is not real-time. <span className="lk">Learn More</span></div>

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
