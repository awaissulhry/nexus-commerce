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
import { Settings2, Download, Wand2, Plus, X, ChevronDown, ChevronUp, ChevronsUpDown, Library, Book, Search, Trash2, Lightbulb, ExternalLink, ListChecks, Pencil, Shuffle } from 'lucide-react'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import { getBackendUrl } from '@/lib/backend-url'
import { FilterDropdown, H10Select, HoverCard } from './FilterDropdown'
import { AdManagerGraph } from './AdManagerGraph'
import { InfoTip } from './InfoTip'

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
  // CBN.2h.6 — Bulk-Actions-managed settings (from dynamicBidding). targetAcos is
  // a fraction (0.3 = 30%); placements hold the ToS/PDP/RoS bid multipliers (%).
  targetAcos?: number | null; bidAutomation?: boolean
  placements?: { tos: number | null; pdp: number | null; ros: number | null }
  // P3 — UI-only until Amazon fields exist (bid algorithm + min/max bid/budget range)
  bidAlgorithm?: string | null
  minMaxBid?: { min: number | null; max: number | null } | null
  minMaxBudget?: { min: number | null; max: number | null } | null
}
type Mode = 'metrics' | 'edit'
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0)
const eur = (v: number) => `€${v.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const pct = (v: unknown) => { if (v == null || v === '') return '—'; const n = Number(v); return Number.isFinite(n) ? `${(n <= 1 ? n * 100 : n).toFixed(2)}%` : '—' }
const fmtDate = (iso?: string | null) => { if (!iso) return '—'; const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) }
// PATCH a JSON body; true iff the response is ok and not an `{ ok: false }` envelope.
async function patchJson(url: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const r = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    return r.ok && j?.ok !== false
  } catch { return false }
}
const AMZ_PLACEMENT: Record<string, string> = { TOS: 'PLACEMENT_TOP', PP: 'PLACEMENT_PRODUCT_PAGE', ROS: 'PLACEMENT_REST_OF_SEARCH' }

const STRAT_LABEL: Record<string, string> = { LEGACY_FOR_SALES: 'Down only', AUTO_FOR_SALES: 'Up and Down', MANUAL: 'Fixed' }
const STRAT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'LEGACY_FOR_SALES', label: 'Down only' },
  { value: 'AUTO_FOR_SALES', label: 'Up and Down' },
  { value: 'MANUAL', label: 'Fixed' },
]
const TYPE_LABEL: Record<string, string> = { SPONSORED_PRODUCTS: 'Sponsored Products', SPONSORED_BRANDS: 'Sponsored Brands', SPONSORED_DISPLAY: 'Sponsored Display', SP: 'Sponsored Products', SB: 'Sponsored Brands', SD: 'Sponsored Display' }

// ── column catalog (H10 "Table Customization") — the exact 44-item model ─────
// One checklist item per entry, in H10's grid order. Campaign is frozen + locked
// (rendered outside this list). The "Bid Algorithm" item expands in the grid to
// the 4-column Adtomic cluster (Bid Rule · Target ACoS · Min/Max Bid · Bid
// Automation); every other item is a single column.
interface ColDef { key: string; label: string }
const ALL_COLS: ColDef[] = [
  { key: 'bidAlgorithm', label: 'Bid Algorithm' },
  { key: 'status', label: 'Status' },
  { key: 'minMaxBudget', label: 'Min/Max Budget' },
  { key: 'rules', label: 'Rules' },
  { key: 'biddingStrategy', label: 'Bidding Strategy' },
  { key: 'bidMultiplier', label: 'Bid Multiplier' },
  { key: 'startDate', label: 'Start Date' },
  { key: 'endDate', label: 'End Date' },
  { key: 'dailyBudget', label: 'Daily Budget' },
  { key: 'curBudgetUtil', label: 'Current Budget Utilization' },
  { key: 'avgBudgetUtil', label: 'Average Budget Utilization' },
  { key: 'spend', label: 'Spend' },
  { key: 'sales', label: 'Sales' },
  { key: 'acos', label: 'ACoS' },
  { key: 'roas', label: 'ROAS' },
  { key: 'impressions', label: 'Impressions' },
  { key: 'clicks', label: 'Clicks' },
  { key: 'cpc', label: 'CPC' },
  { key: 'cvr', label: 'CVR' },
  { key: 'ctr', label: 'CTR' },
  { key: 'ppcOrders', label: 'PPC Orders' },
  { key: 'kindleReads', label: 'Kindle Reads' },
  { key: 'kindleRoyalties', label: 'Kindle Royalties' },
  { key: 'saleUnits', label: 'Sale Units' },
  { key: 'cpa', label: 'CPA' },
  { key: 'viewImpr', label: 'View Impr.' },
  { key: 'aov', label: 'AOV' },
  { key: 'asp', label: 'ASP' },
  { key: 'otherSales', label: 'Other Sales' },
  { key: 'otherSalesPct', label: 'Other Sales %' },
  { key: 'ntbOrders', label: 'NTB-Orders' },
  { key: 'ntbOrdersPct', label: 'NTB-Orders%' },
  { key: 'ntbOrderRate', label: 'NTB-OrderRate' },
  { key: 'ntbSales', label: 'NTB-Sales' },
  { key: 'ntbSalesPct', label: 'NTB-Sales%' },
  { key: 'ntbUnits', label: 'NTB-Units' },
  { key: 'ntbUnitsPct', label: 'NTB-Units%' },
  { key: 'sameSkuSales', label: 'SameSKU Sales' },
  { key: 'sameSkuSaleUnits', label: 'SameSKU Sale Units' },
  { key: 'sameSkuOrders', label: 'SameSKU Orders' },
  { key: 'actBidHours', label: 'ActBid Hours' },
  { key: 'oobHours', label: 'OOB Hours' },
  { key: 'topOfSearchIS', label: 'Top of search IS' },
]
const COL_BY_KEY: Record<string, ColDef> = Object.fromEntries(ALL_COLS.map((c) => [c.key, c]))
const ALL_KEYS = ALL_COLS.map((c) => c.key)
// H10 ships with every column visible (Select All on).
const DEFAULT_VISIBLE = ALL_KEYS
const COLS_KEY = 'h10-am-columns-v2' // bumped: catalog rebuilt to H10's 44-col model

// Physical grid columns. Most checklist items are one column; "Bid Algorithm"
// expands to the Adtomic cluster. `metric` → numeric/sortable cell (renderCol);
// otherwise a settings cell (settingsCell, left-aligned).
interface PhysCol { key: string; label: string; metric: boolean }
const CLUSTER: PhysCol[] = [
  { key: 'bidRule', label: 'Bid Rule', metric: false },
  { key: 'targetAcos', label: 'Target ACoS', metric: false },
  { key: 'minMaxBid', label: 'Min/Max Bid', metric: false },
  { key: 'bidAutomation', label: 'Bid Automation', metric: false },
]
const SETTINGS_KEYS = new Set(['status', 'minMaxBudget', 'rules', 'biddingStrategy', 'bidMultiplier', 'startDate', 'endDate', 'dailyBudget', 'curBudgetUtil', 'avgBudgetUtil'])
function physCols(itemKey: string): PhysCol[] {
  if (itemKey === 'bidAlgorithm') return CLUSTER
  const it = COL_BY_KEY[itemKey]
  if (!it) return []
  return [{ key: itemKey, label: it.label, metric: !SETTINGS_KEYS.has(itemKey) }]
}
// physical column → its Customize checklist item. The Adtomic cluster's 4 columns
// all map to one item ("bidAlgorithm"), so header drag-reorder moves whole items.
const CLUSTER_KEY_SET = new Set(CLUSTER.map((c) => c.key))
const physToItem = (k: string): string => (CLUSTER_KEY_SET.has(k) ? 'bidAlgorithm' : k)

// Numeric/metric cell. Settings columns are rendered by settingsCell instead.
// Columns without a Nexus data source render "—" (H10-parity placeholders, P4).
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
    case 'ppcOrders': return orders ? orders.toLocaleString() : '0'
    case 'cpa': return orders ? eur(spend / orders) : '—'
    case 'aov': return orders ? eur(sales / orders) : '—'
    default: return '—' // parity placeholders (no data source yet)
  }
}

// Filter bar range fields (label · unit) — matches the H10 Ad Manager filter row.
const RANGE_FIELDS: Array<{ key: string; label: string; unit: '%' | '€' | '' }> = [
  { key: 'acos', label: 'ACoS', unit: '%' }, { key: 'roas', label: 'ROAS', unit: '' },
  { key: 'spend', label: 'Spend', unit: '€' }, { key: 'sales', label: 'Sales', unit: '€' },
  { key: 'clicks', label: 'Clicks', unit: '' }, { key: 'ppcOrders', label: 'PPC Orders', unit: '' },
  { key: 'cpc', label: 'CPC', unit: '€' }, { key: 'ctr', label: 'CTR', unit: '%' },
  { key: 'cvr', label: 'CVR', unit: '%' }, { key: 'impressions', label: 'Impressions', unit: '' },
  { key: 'dailyBudget', label: 'Daily Budget', unit: '' },
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
// Verbatim Helium 10 Ad Manager tooltip copy (captured from the live product).
const RANGE_TIPS: Record<string, string> = {
  acos: 'ACoS (Advertising Cost of Sales) is the percent of attributed sales spent on advertising within the specified timeframe. This is calculated by dividing total PPC spend by total PPC sales.',
  roas: 'ROAS (Return on Ad Spend) is the total sales generated for every unit of currency spent on advertising. This is calculated by dividing total PPC sales by total PPC spend.',
  spend: 'The total cost spent on clicks.',
  sales: 'The total value of all products sold to shoppers within the specified timeframe. Note this could include sales for products other than what is being advertised in the PPC campaign.',
  clicks: 'The number of times your ads were clicked.',
  ppcOrders: 'The number of Amazon orders shoppers submitted after clicking on your ads. Note this could include orders for products other than what is being advertised in the PPC campaign.',
  cpc: 'Cost-per-click (CPC) is the average amount you paid for each click on an ad.',
  ctr: 'Click-through rate (CTR) is the ratio of how often shoppers click on your PPC ad when displayed. This is calculated as clicks divided by impressions.',
  cvr: 'Conversion rate (CVR) is the percentage of shoppers who clicked on an ad and placed an order. This is calculated as orders divided by clicks.',
  impressions: 'The number of times ads were displayed.',
}
// Header hover tooltips per column (verbatim H10 copy). Metric columns reuse the
// RANGE_TIPS copy; settings / NTB / SameSKU tooltips captured from the live product.
const COL_TIPS: Record<string, string> = {
  ...RANGE_TIPS,
  bidRule: 'Custom Bid Rule - Create your own bid change logic using PPC metrics available in Analytics',
  targetAcos: 'Only if "Target ACoS" is selected for the Bid Algorithm. This selection dictates the ACoS goal. Click the Edit Campaigns button to edit the displayed ACoS',
  minMaxBid: 'Max bid settings do not currently take into account placement modifiers. CPCs may be higher than max bid due to placement modifiers.',
  bidAutomation: 'Active will automate the keyword bid suggestions currently found on the Suggestions page. Changes will be recorded in the Change Log',
  minMaxBudget: 'The Minimum and Maximum Budget limits for this campaign will be used by Budget Manager. Minimum Budget: the lowest daily budget this campaign can receive. Maximum Budget: the highest daily budget this campaign can receive.',
  ntbOrdersPct: 'The percentage of total orders that are new-to-brand. Only relevant for SB and SD',
  ntbSalesPct: 'The percentage of total sales (in local currency) that are new-to-brand sales. Only relevant for SB and SD',
  ntbUnits: 'The total sale units (in local currency) of new-to-brand orders. Only relevant for SB and SD',
  sameSkuSales: 'Sales where the purchased ASIN/SKU was the same as the ASIN/SKU advertised.',
  sameSkuOrders: 'Orders where the purchased ASIN/SKU was the same as the ASIN/SKU advertised.',
  actBidHours: 'Average hours ads were actually bidding (Actual bidding hours = Available bidding hours − Out of budget hours).',
  oobHours: 'Average Out of Budget Time.',
  topOfSearchIS: 'Top-of-search impression share — the percentage of top-of-search impressions your ads received out of those available.',
}
const STATUS_OPTS: Array<{ value: string; label: string }> = [
  { value: 'ENABLED', label: 'Enabled' },
  { value: 'PAUSED', label: 'Paused' },
  { value: 'ARCHIVED', label: 'Archived' },
]
// H10 default — Status preselects Enabled + Paused (Archived hidden until opted in).
const DEFAULT_STATUSES = ['ENABLED', 'PAUSED']
const TYPE_OPTS: Array<{ value: string; label: string }> = [
  { value: 'SP_AUTO', label: 'Sponsored Products - Auto' },
  { value: 'SP_MANUAL', label: 'Sponsored Products - Manual' },
  { value: 'SPONSORED_BRANDS', label: 'Sponsored Brands' },
  { value: 'SPONSORED_DISPLAY', label: 'Sponsored Display' },
  { value: 'SPONSORED_TV', label: 'Sponsored TV' },
]
const typeKey = (c: Camp): string => {
  const v = (c.adProduct ?? c.type ?? '').toUpperCase()
  if (v.includes('BRAND') || v === 'SB') return 'SPONSORED_BRANDS'
  if (v.includes('DISPLAY') || v === 'SD') return 'SPONSORED_DISPLAY'
  if (v.includes('TV')) return 'SPONSORED_TV'
  // SP split into Auto/Manual, inferred from the campaign name (matches targetingLetter).
  return /(^|[^a-z])auto([^a-z]|$)/i.test(c.name) ? 'SP_AUTO' : 'SP_MANUAL'
}
type FilterPreset = { name: string; statuses: string[]; types: string[]; portfolio: string; campaigns: string[]; ranges: Record<string, Range> }
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
  // H10 always shows the count (e.g. "5 selected" / "2 selected"), never "All".
  const text = selected.length === 0 ? 'None'
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
          <label className="h10-ms-opt all"><input type="checkbox" ref={(el) => { if (el) el.indeterminate = selected.length > 0 && !allOn }} checked={allOn} onChange={() => onChange(allOn ? [] : options.map((o) => o.value))} /><span>Select all</span></label>
          {options.map((o) => (
            <label className={`h10-ms-opt ${selected.includes(o.value) ? 'sel' : ''}`} key={o.value}><input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} /><span>{o.label}</span></label>
          ))}
        </div>
      )}
    </div>
  )
}

// H10's "Select a Campaign" — searchable multi-select (search box + checkbox
// list). Drives the set of campaign names the grid filters to.
function CampaignMultiSelect({ names, selected, onChange }: { names: string[]; selected: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useClickAway<HTMLDivElement>(() => { setOpen(false); setQ('') })
  const ql = q.trim().toLowerCase()
  const matches = (ql ? names.filter((n) => n.toLowerCase().includes(ql)) : names).slice(0, 200)
  const text = selected.length === 0 ? 'Select a Campaign'
    : selected.length === 1 ? selected[0]
    : `${selected.length} selected`
  const toggle = (n: string) => onChange(selected.includes(n) ? selected.filter((x) => x !== n) : [...selected, n])
  return (
    <div className={`h10-ms h10-cms ${open ? 'open' : ''}`} ref={ref}>
      <button type="button" className={`h10-ms-btn ${selected.length ? '' : 'ph'}`} onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open} aria-label="Campaign">
        <span>{text}</span><ChevronDown size={14} />
      </button>
      {open && (
        <div className="h10-ms-pop" role="listbox">
          <div className="h10-cms-search"><Search size={13} /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search campaigns…" aria-label="Search campaigns" /></div>
          {matches.length === 0
            ? <div className="h10-cms-empty">No campaigns</div>
            : matches.map((n) => (
                <label className={`h10-ms-opt ${selected.includes(n) ? 'sel' : ''}`} key={n} title={n}><input type="checkbox" checked={selected.includes(n)} onChange={() => toggle(n)} /><span className="h10-cms-nm">{n}</span></label>
              ))}
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
      {library.length === 0 ? (
        <div className="h10-libpop-empty">
          <div className="ill"><Library size={20} /></div>
          <div className="t">Save filter presets</div>
          <div className="d">Begin by choosing the filters you want, then save them as presets for quick searches.</div>
        </div>
      ) : (
        <>
          <div className="h10-libpop-h">Saved Filters</div>
          <div className="h10-libpop-list">
            {library.map((p, i) => (
              <div className="h10-libpop-row" key={i}>
                <button type="button" className="nm" onClick={() => onApply(p)}>{p.name}</button>
                <button type="button" className="del" onClick={() => onDelete(i)} aria-label={`Delete ${p.name}`}><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ── Table Customization (H10 "Customize") — flat 4-column popover anchored under
// the Customize button. Campaign is locked (always shown); every other column
// toggles live (no Apply/Cancel/Reset). A transparent backdrop closes it.
function CustomizePanel({ visible, onChange, onReset, onClose }: { visible: string[]; onChange: (v: string[]) => void; onReset: () => void; onClose: () => void }) {
  const ref = useClickAway<HTMLDivElement>(onClose) // close on outside click — no blocking backdrop, so the page + grid stay scrollable
  const vis = new Set(visible)
  const allOn = ALL_KEYS.every((k) => vis.has(k))
  const toggle = (k: string) => { const n = new Set(vis); if (n.has(k)) n.delete(k); else n.add(k); onChange([...n]) }
  return (
    <div className="h10-custpop" ref={ref} role="dialog" aria-label="Table Customization">
        <div className="h10-custpop-h">Table Customization<button type="button" className="h10-custpop-reset" onClick={onReset}>Reset to default</button></div>
        <div className="h10-custpop-colsh">
          <span className="ti">Columns</span>
          <label className="h10-custpop-all"><input type="checkbox" ref={(el) => { if (el) el.indeterminate = !allOn && vis.size > 0 }} checked={allOn} onChange={() => onChange(allOn ? [] : [...ALL_KEYS])} /> Select All</label>
        </div>
        <div className="h10-custpop-grid">
          <label className="h10-custpop-ck locked"><input type="checkbox" checked readOnly disabled /> <span>Campaign</span></label>
          {ALL_COLS.map((c) => (
            <label className="h10-custpop-ck" key={c.key}>
              <input type="checkbox" checked={vis.has(c.key)} onChange={() => toggle(c.key)} />
              <span>{c.label}</span>
            </label>
          ))}
        </div>
    </div>
  )
}

// ── Bulk Actions (CBN.2h.6) — H10's separate two-step modal. Step 1 is a checkbox
// table (Item · Action): tick a row to enable that change and set its value; the
// Apply button stays disabled until ≥1 row is ticked. Step 2 reviews the staged
// changes before the gated Submit. Mirrors the Helium 10 Ads "Bulk Actions" dialog.
const STATUS_ACTIONS: Array<{ value: 'ENABLED' | 'PAUSED' | 'ARCHIVED'; label: string }> = [
  { value: 'ENABLED', label: 'Enable' }, { value: 'PAUSED', label: 'Pause' }, { value: 'ARCHIVED', label: 'Archive' },
]
const STATUS_RESULT: Record<string, { label: string; cls: string }> = {
  ENABLED: { label: 'Enabled', cls: 'ok' }, PAUSED: { label: 'Paused', cls: 'warn' }, ARCHIVED: { label: 'Archived', cls: 'arch' },
}
const BUDGET_MODES: Array<{ value: 'set' | 'incPct' | 'decPct'; label: string }> = [
  { value: 'set', label: 'Set Budget to (€)' }, { value: 'incPct', label: 'Increase Budget by (%)' }, { value: 'decPct', label: 'Decrease Budget by (%)' },
]
const PLACEMENT_OPTS: Array<{ value: string; label: string }> = [
  { value: 'TOS', label: 'Top of Search' }, { value: 'PP', label: 'Product Pages' }, { value: 'ROS', label: 'Rest of Search' },
]
export type BulkChanges = {
  status?: { value: 'ENABLED' | 'PAUSED' | 'ARCHIVED'; label: string }
  budget?: { mode: 'set' | 'incPct' | 'decPct'; value: number; label: string }
  automation?: boolean
  acos?: number
  multiplier?: { placement: string; placementLabel: string; value: number }
  strategy?: { value: string; label: string }
}
function BulkActionsModal({ onSubmit, onClose }: { onSubmit: (c: BulkChanges) => void; onClose: () => void }) {
  const [step, setStep] = useState<1 | 2>(1)
  const [enStatus, setEnStatus] = useState(false); const [statusVal, setStatusVal] = useState<'ENABLED' | 'PAUSED' | 'ARCHIVED'>('ENABLED')
  const [enBudget, setEnBudget] = useState(false); const [budgetMode, setBudgetMode] = useState<'set' | 'incPct' | 'decPct'>('set'); const [budgetVal, setBudgetVal] = useState('0')
  const [enAuto, setEnAuto] = useState(false); const [autoOn, setAutoOn] = useState(false)
  const [enAcos, setEnAcos] = useState(false); const [acosVal, setAcosVal] = useState('30')
  const [enMult, setEnMult] = useState(false); const [placement, setPlacement] = useState('TOS'); const [multVal, setMultVal] = useState('')
  const [enStrat, setEnStrat] = useState(false); const [stratVal, setStratVal] = useState('LEGACY_FOR_SALES')

  const any = enStatus || enBudget || enAuto || enAcos || enMult || enStrat
  const allOn = enStatus && enBudget && enAuto && enAcos && enMult && enStrat
  const setAll = (v: boolean) => { setEnStatus(v); setEnBudget(v); setEnAuto(v); setEnAcos(v); setEnMult(v); setEnStrat(v) }
  const changes: BulkChanges = {}
  if (enStatus) changes.status = { value: statusVal, label: STATUS_ACTIONS.find((s) => s.value === statusVal)!.label }
  if (enBudget) changes.budget = { mode: budgetMode, value: Number(budgetVal) || 0, label: BUDGET_MODES.find((b) => b.value === budgetMode)!.label }
  if (enAuto) changes.automation = autoOn
  if (enAcos) changes.acos = Number(acosVal) || 0
  if (enMult) changes.multiplier = { placement, placementLabel: PLACEMENT_OPTS.find((p) => p.value === placement)!.label, value: Number(multVal) || 0 }
  if (enStrat) changes.strategy = { value: stratVal, label: STRAT_LABEL[stratVal] ?? stratVal }
  const budgetUnit = budgetMode === 'set' ? '€' : '%'

  return (
    <div className="h10-modal-backdrop" onClick={onClose}>
      <div className="h10-modal bulk" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Bulk Actions">
        <div className="h10-modal-h"><b>Bulk Actions</b><button type="button" className="h10-modal-x" onClick={onClose} aria-label="Close"><X size={16} /></button></div>
        <div className="h10-modal-sub">{step === 1 ? 'Select items and make changes' : 'Review the changes'}</div>

        {step === 1 ? (<>
          <div className="h10-modal-b">
            <div className="h10-bulk">
              <div className="h10-bulk-hd"><label className="ck"><input type="checkbox" ref={(el) => { if (el) el.indeterminate = any && !allOn }} checked={allOn} onChange={() => setAll(!allOn)} aria-label="Select all items" /></label><span className="it">Item</span><span className="ac">Action</span></div>

              <div className="h10-bulk-row">
                <label className="ck"><input type="checkbox" checked={enStatus} onChange={() => setEnStatus((v) => !v)} aria-label="Change Campaign Status" /></label>
                <span className="it">Campaign Status</span>
                <div className="ac"><H10Select width={150} options={STATUS_ACTIONS} value={statusVal} onChange={(v) => setStatusVal(v as typeof statusVal)} ariaLabel="Campaign status action" /></div>
              </div>

              <div className="h10-bulk-row">
                <label className="ck"><input type="checkbox" checked={enBudget} onChange={() => setEnBudget((v) => !v)} aria-label="Change Campaign Budget" /></label>
                <span className="it">Campaign Budget</span>
                <div className="ac">
                  <H10Select width={190} options={BUDGET_MODES} value={budgetMode} onChange={(v) => setBudgetMode(v as typeof budgetMode)} ariaLabel="Budget mode" />
                  <span className="h10-bulk-inp"><span className="pf">{budgetUnit}</span><input type="number" min="0" step="1" value={budgetVal} onChange={(e) => setBudgetVal(e.target.value)} aria-label="Budget value" /></span>
                </div>
              </div>

              <div className="h10-bulk-row">
                <label className="ck"><input type="checkbox" checked={enAuto} onChange={() => setEnAuto((v) => !v)} aria-label="Change Bid Automation" /></label>
                <span className="it">Bid Automation</span>
                <div className="ac"><button type="button" className={`h10-bktoggle ${autoOn ? 'on' : ''}`} onClick={() => setAutoOn((v) => !v)} role="switch" aria-checked={autoOn} aria-label="Bid Automation"><span /></button></div>
              </div>

              <div className="h10-bulk-row">
                <label className="ck"><input type="checkbox" checked={enAcos} onChange={() => setEnAcos((v) => !v)} aria-label="Change Target ACoS" /></label>
                <span className="it">Target ACoS</span>
                <div className="ac"><span className="h10-bulk-inp"><span className="pf">%</span><input type="number" min="0" step="1" value={acosVal} onChange={(e) => setAcosVal(e.target.value)} aria-label="Target ACoS value" /></span></div>
              </div>

              <div className="h10-bulk-row">
                <label className="ck"><input type="checkbox" checked={enMult} onChange={() => setEnMult((v) => !v)} aria-label="Change Bid Multiplier" /></label>
                <span className="it">Bid Multiplier</span>
                <div className="ac">
                  <H10Select width={158} options={PLACEMENT_OPTS} value={placement} onChange={setPlacement} ariaLabel="Bid multiplier placement" />
                  <span className="set">Set</span>
                  <span className="h10-bulk-inp sf"><input type="number" min="0" step="1" value={multVal} onChange={(e) => setMultVal(e.target.value)} aria-label="Bid multiplier value" /><span className="sfx">%</span></span>
                </div>
              </div>

              <div className="h10-bulk-row">
                <label className="ck"><input type="checkbox" checked={enStrat} onChange={() => setEnStrat((v) => !v)} aria-label="Change Bidding Strategy" /></label>
                <span className="it">Bidding Strategy</span>
                <div className="ac"><span className="set">Set</span><H10Select width={158} options={STRAT_OPTIONS} value={stratVal} onChange={setStratVal} ariaLabel="Bidding strategy" /></div>
              </div>
            </div>
          </div>
          <div className="h10-modal-f"><span className="grow" /><button type="button" className="h10-am-btn primary" disabled={!any} onClick={() => setStep(2)}>Apply</button></div>
        </>) : (<>
          <div className="h10-modal-b">
            <div className="h10-bulk-review">
              <div className="rh">Changes</div>
              {changes.status && <div className="rr"><span className="f">Campaign Status</span><span className="v"><span className={`h10-pill ${STATUS_RESULT[changes.status.value].cls}`}>{STATUS_RESULT[changes.status.value].label}</span></span></div>}
              {changes.budget && <div className="rr"><span className="f">Campaign Budget</span><span className="v">{changes.budget.mode === 'set' ? eur(changes.budget.value) : `${changes.budget.mode === 'incPct' ? 'Increase' : 'Decrease'} by ${changes.budget.value}%`}</span></div>}
              {changes.automation != null && <div className="rr"><span className="f">Bid Automation</span><span className="v"><span className="h10-rv-pill">{changes.automation ? 'On' : 'Off'}</span></span></div>}
              {changes.acos != null && <div className="rr"><span className="f">Target ACoS</span><span className="v">{changes.acos.toFixed(2)}%</span></div>}
              {changes.multiplier && <div className="rr"><span className="f">Bid Multiplier</span><span className="v">{changes.multiplier.placementLabel} {changes.multiplier.value}%</span></div>}
              {changes.strategy && <div className="rr"><span className="f">Bidding Strategy</span><span className="v">{changes.strategy.label}</span></div>}
            </div>
          </div>
          <div className="h10-modal-f"><button type="button" className="h10-am-link back" onClick={() => setStep(1)}>Back</button><span className="grow" /><button type="button" className="h10-am-btn primary" onClick={() => onSubmit(changes)}>Submit Changes</button></div>
        </>)}
      </div>
    </div>
  )
}

// P3 — H10 "Campaign Bidding Strategy" modal (3 strategies, verbatim copy).
// Confirm → gated campaign PATCH (live markets push to Amazon).
const STRATEGY_DEFS: Array<{ value: string; title: string; desc: string }> = [
  { value: 'LEGACY_FOR_SALES', title: 'Dynamic Bids - Down only', desc: 'Amazon lowers your bids in real time when your ad may be less likely to convert to a sale.' },
  { value: 'AUTO_FOR_SALES', title: 'Dynamic Bids - Up and Down', desc: 'Amazon raises your bids (by a maximum of 100%) in real time when your ad may be more likely to convert to a sale, and lower your bids when less likely to convert to a sale.' },
  { value: 'MANUAL', title: 'Fixed Bid', desc: "Amazon uses your exact bid and any manual adjustments you set, and won't change your bids based on likelihood of a sale." },
]
function StrategyModal({ campaign, onConfirm, onClose }: { campaign: Camp; onConfirm: (v: string) => void; onClose: () => void }) {
  const [v, setV] = useState(campaign.biddingStrategy ?? 'LEGACY_FOR_SALES')
  return (
    <div className="h10-modal-backdrop" onClick={onClose}>
      <div className="h10-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Campaign Bidding Strategy">
        <div className="h10-modal-h"><b>Campaign Bidding Strategy</b><button type="button" className="h10-modal-x" onClick={onClose} aria-label="Close"><X size={16} /></button></div>
        <div className="h10-modal-sub">Select a strategy to optimize your campaign bidding performance</div>
        <div className="h10-modal-b">
          {STRATEGY_DEFS.map((s) => (
            <label className={`h10-radio-card ${v === s.value ? 'on' : ''}`} key={s.value}>
              <input type="radio" name="bidstrat" checked={v === s.value} onChange={() => setV(s.value)} />
              <span className="rc-b"><span className="rc-t">{s.title}</span><span className="rc-d">{s.desc}</span></span>
            </label>
          ))}
        </div>
        <div className="h10-modal-f"><button type="button" className="h10-am-btn" onClick={onClose}>Cancel</button><span className="grow" /><button type="button" className="h10-am-btn primary" onClick={() => onConfirm(v)}>Confirm</button></div>
      </div>
    </div>
  )
}

// P3 — H10 "Bid Multiplier" modal (placement % + boosts). Confirm → /placements
// PATCH (TOS/PP/ROS). The boost toggles are UI-faithful (no Amazon field yet).
function BidMultiplierModal({ campaign, onConfirm, onClose }: { campaign: Camp; onConfirm: (pl: { tos: number | null; pdp: number | null; ros: number | null }) => void; onClose: () => void }) {
  const p = campaign.placements ?? { tos: null, pdp: null, ros: null }
  const [tos, setTos] = useState(p.tos != null ? String(p.tos) : '')
  const [pdp, setPdp] = useState(p.pdp != null ? String(p.pdp) : '')
  const [ros, setRos] = useState(p.ros != null ? String(p.ros) : '')
  const [video, setVideo] = useState(false); const [business, setBusiness] = useState(false); const [audience, setAudience] = useState(false)
  const norm = (s: string) => (s.trim() === '' ? null : Math.max(0, Math.min(900, Math.round(Number(s) || 0))))
  const field = (label: string, tip: string | null, val: string, set: (v: string) => void) => (
    <label className="h10-bm-f"><span className="l">{label}{tip && <InfoTip tip={tip} />}</span><span className="h10-bulk-inp sf"><input inputMode="decimal" placeholder="0 - 900" value={val} onChange={(e) => set(e.target.value)} aria-label={label} /><span className="sfx">%</span></span></label>
  )
  const boost = (title: string, tip: string, desc: string | null, on: boolean, set: () => void, label: string) => (
    <div className="h10-bm-boost">
      <div className="bt">{title} <InfoTip tip={tip} /></div>
      {desc && <div className="bd">{desc}</div>}
      <label className="h10-bm-tog"><button type="button" className={`h10-bktoggle ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={label} onClick={set}><span /></button> {label}</label>
    </div>
  )
  return (
    <div className="h10-modal-backdrop" onClick={onClose}>
      <div className="h10-modal bm" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Bid Multiplier">
        <div className="h10-modal-h"><b>Bid Multiplier</b><button type="button" className="h10-modal-x" onClick={onClose} aria-label="Close"><X size={16} /></button></div>
        <div className="h10-modal-sub">Set how much you want to increase your bid based on the placement</div>
        <div className="h10-modal-b">
          <div className="h10-bm-sec">Placement</div>
          <div className="h10-bm-pl">
            {field('Top of Search', 'Increase your bid by a specified % when your ad competes for the top row of the first page.', tos, setTos)}
            {field('Product Pages', 'Increase your bid by a specified % when your ad competes for placements off the top of search, primarily product detail pages.', pdp, setPdp)}
            {field('Rest of Search', null, ros, setRos)}
          </div>
          {boost('Further increase bids for video ads', 'These increases apply on top of placement adjustments.', 'These increases apply on top of placement adjustments.', video, () => setVideo((v) => !v), 'Enable Video Bid Boost')}
          {boost('Amazon Business Bid Boost', 'Further increase bids across placements on Amazon Business.', 'Further increase bids across placements on Amazon Business', business, () => setBusiness((v) => !v), 'Enable Amazon Business Bid Boost')}
          {boost('Audience Bid Modifier', 'Increase bids on a custom audience created in Amazon Marketing cloud (AMC). The percentage value set is the percentage of the original bid including any other bid adjustments such as placement bidding. For example, a placement bidding with 50% adjustment on a $1.00 bid would increase the bid to $1.50, and a Audience Bid Modifier with 100% adjustment would further increase the bid to $3.00.', null, audience, () => setAudience((v) => !v), 'Enable Audience Bid Modifier')}
        </div>
        <div className="h10-modal-f"><button type="button" className="h10-am-btn" onClick={onClose}>Cancel</button><span className="grow" /><button type="button" className="h10-am-btn primary" onClick={() => onConfirm({ tos: norm(tos), pdp: norm(pdp), ros: norm(ros) })}>Confirm</button></div>
      </div>
    </div>
  )
}

// P3 — bid algorithms (the "Bid Rule" cell dropdown). UI-only until Amazon
// exposes a per-campaign bid-algorithm field; selection updates local state.
const BID_ALGOS: Array<{ value: string; label: string; desc: string }> = [
  { value: 'TARGET_ACOS', label: 'Target ACOS', desc: 'A bid algorithm for products in a performance stage that should target an ACoS for scalable advertising.' },
  { value: 'MAX_IMPRESSIONS', label: 'Max Impressions', desc: 'A bid algorithm for products in a launch stage that need to get as many impressions as possible.' },
  { value: 'MAX_ORDERS', label: 'Max Orders', desc: 'A bid algorithm for products in a liquidate stage that should target maximum orders to clear out inventory.' },
]
const bidAlgoLabel = (c: Camp): string => BID_ALGOS.find((a) => a.value === (c.bidAlgorithm ?? 'TARGET_ACOS'))?.label ?? 'Target ACOS'

// P3 — H10 "Campaign Rules for …" modal. Per-campaign rules aren't exposed yet,
// so it lists none and routes "Add Rule" to the Rules & Automation builder.
function CampaignRulesModal({ campaign, onClose }: { campaign: Camp; onClose: () => void }) {
  return (
    <div className="h10-modal-backdrop" onClick={onClose}>
      <div className="h10-modal bm" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Campaign Rules">
        <div className="h10-modal-h"><b>Campaign Rules for &ldquo;{campaign.name}&rdquo;</b><button type="button" className="h10-modal-x" onClick={onClose} aria-label="Close"><X size={16} /></button></div>
        <div className="h10-modal-sub">Click on rules to edit or view details. Suggestions generated by rules will appear on the Suggestions Page.</div>
        <div className="h10-modal-b">
          <div className="h10-rules-top"><span className="cnt">0 Rules</span><Link href="/marketing/ads/rules-automation" className="h10-am-btn primary sm"><Plus size={13} /> Add Rule</Link></div>
          <div className="h10-rules-empty">No rules are applied to this campaign yet. Create one in Rules &amp; Automation.</div>
        </div>
        <div className="h10-modal-f"><span className="grow" /><button type="button" className="h10-am-btn primary" onClick={onClose}>Close</button></div>
      </div>
    </div>
  )
}

// P3 — H10 range popover (None / Set a Range). Used for Min/Max Bid + Min/Max
// Budget. UI-only (local) for now — no Amazon field exists yet.
function RangePopover({ title, rangeLabel, initial, x, y, onApply, onClose }: { title: string; rangeLabel: string; initial: { min: number | null; max: number | null } | null; x: number; y: number; onApply: (mm: { min: number | null; max: number | null } | null) => void; onClose: () => void }) {
  const [range, setRange] = useState(!!(initial && (initial.min != null || initial.max != null)))
  const [min, setMin] = useState(initial?.min != null ? String(initial.min) : '')
  const [max, setMax] = useState(initial?.max != null ? String(initial.max) : '')
  return (
    <>
      <button type="button" className="h10-menu-back" aria-label="Close" onClick={onClose} />
      <div className="h10-mmbid" style={{ position: 'fixed', left: x, top: y }} role="dialog" aria-label={title}>
        <div className="h">{title}</div>
        <label className="r"><input type="radio" name="rangepop" checked={!range} onChange={() => setRange(false)} /> None</label>
        <label className="r"><input type="radio" name="rangepop" checked={range} onChange={() => setRange(true)} /> {rangeLabel}</label>
        {range && (
          <div className="mmrow">
            <span className="h10-bulk-inp"><span className="pf">€</span><input inputMode="decimal" placeholder="Min" value={min} onChange={(e) => setMin(e.target.value)} aria-label="Min" /></span>
            <span className="h10-bulk-inp"><span className="pf">€</span><input inputMode="decimal" placeholder="Max" value={max} onChange={(e) => setMax(e.target.value)} aria-label="Max" /></span>
          </div>
        )}
        <div className="f"><button type="button" className="h10-am-link" onClick={onClose}>Cancel</button><button type="button" className="h10-am-btn primary sm" onClick={() => onApply(range ? { min: min.trim() === '' ? null : Number(min), max: max.trim() === '' ? null : Number(max) } : null)}>Apply</button></div>
      </div>
    </>
  )
}

// P3 — single-value edit popover (Target ACoS %, Daily Budget €), opened from the
// hover pencil. Target ACoS writes to /automation; Daily Budget to the campaign PATCH.
function ValuePopover({ title, prefix, suffix, initial, x, y, onApply, onClose }: { title: string; prefix?: string; suffix?: string; initial: string; x: number; y: number; onApply: (v: string) => void; onClose: () => void }) {
  const [v, setV] = useState(initial)
  return (
    <>
      <button type="button" className="h10-menu-back" aria-label="Close" onClick={onClose} />
      <div className="h10-editpop" style={{ position: 'fixed', left: x, top: y }} role="dialog" aria-label={title}>
        <div className="h">{title}</div>
        <span className={`h10-bulk-inp ${suffix ? 'sf' : ''}`}>{prefix && <span className="pf">{prefix}</span>}<input inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} aria-label={title} autoFocus />{suffix && <span className="sfx">{suffix}</span>}</span>
        <div className="f"><button type="button" className="h10-am-link" onClick={onClose}>Cancel</button><button type="button" className="h10-am-btn primary sm" onClick={() => onApply(v)}>Apply</button></div>
      </div>
    </>
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
  const [campaignSel, setCampaignSel] = useState<string[]>([])
  const [sel, setSel] = useState<Set<string>>(new Set())
  // CBN.2b — filter bar (Helium 10 Ad Manager match). `statuses`/`types` hold the
  // concrete selected values; full-length == "All" (no filter applied).
  const [statuses, setStatuses] = useState<string[]>(DEFAULT_STATUSES)
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
  const [adjustOpen, setAdjustOpen] = useState(false)
  const [adjMode, setAdjMode] = useState<'set' | 'incPct' | 'decPct'>('set')
  const [adjVal, setAdjVal] = useState('0')
  const [bulkConfirm, setBulkConfirm] = useState<'ENABLED' | 'PAUSED' | 'ARCHIVED' | null>(null)
  // P2b — bulk assign selected campaigns to a portfolio (real names from /portfolios).
  const [portfolioMenu, setPortfolioMenu] = useState(false)
  const [pfOptions, setPfOptions] = useState<Array<{ portfolioId: string; name: string }>>([])
  // P3 — per-row interactions (open a modal/menu for a single campaign)
  const [strategyModal, setStrategyModal] = useState<Camp | null>(null)
  const [multiplierModal, setMultiplierModal] = useState<Camp | null>(null)
  const [statusMenu, setStatusMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [rulesModal, setRulesModal] = useState<Camp | null>(null)
  const [bidRuleMenu, setBidRuleMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [editPop, setEditPop] = useState<{ id: string; kind: 'targetAcos' | 'dailyBudget' | 'minMaxBid' | 'minMaxBudget'; x: number; y: number } | null>(null)
  const colHiRef = useRef<string | null>(null) // header hover → column highlight, toggled via direct DOM (no grid re-render)
  // pointer-based column reorder — smooth chip + live drop-indicator driven by
  // direct DOM (NO per-move grid re-renders); the reorder commits once on release.
  // `drag` is set only once per drag (start) so the grid doesn't thrash.
  const [drag, setDrag] = useState<{ item: string; label: string } | null>(null)
  const dragRef = useRef<{ item: string; startX: number; startY: number; dragging: boolean; label: string; bounds: Array<{ item: string; left: number; right: number; center: number }>; drop: string | null; before: boolean; gridTop: number; gridH: number; lastX: number; lastY: number; scrollEl: HTMLElement | null; initScroll: number; frozenRight: number; rafId: number } | null>(null)
  const chipRef = useRef<HTMLDivElement>(null)
  const indRef = useRef<HTMLDivElement>(null)
  const suppressClick = useRef(false) // a drag must not also fire the sort onClick
  // CBN.2d — header controls
  const [market, setMarket] = useState('all')
  const [rangePreset, setRangePreset] = useState('last7')
  const [dateRange, setDateRange] = useState(() => { const e = new Date(); e.setHours(0, 0, 0, 0); const s = new Date(e); s.setDate(s.getDate() - 6); return { start: s, end: e } })
  const [syncing, setSyncing] = useState(false)
  const [showGraph, setShowGraph] = useState(false)
  const [page, setPage] = useState(1)
  const [rowsPerPage, setRowsPerPage] = useState(100)
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null)

  const load = useCallback(async (opts?: { sync?: boolean; range?: { start: Date; end: Date } }) => {
    if (opts?.sync) setSyncing(true)
    try {
      const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const qs = opts?.range ? `&startDate=${ymd(opts.range.start)}&endDate=${ymd(opts.range.end)}` : ''
      const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500${qs}`, { cache: 'no-store' })
      const d = await r.json()
      setRows((d.items ?? []) as Camp[])
    } catch { /* ignore */ } finally { setLoading(false); setSyncing(false) }
  }, [])

  useEffect(() => {
    void load({ range: dateRange })
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
  const clearFilters = () => { setStatuses(DEFAULT_STATUSES); setTypes(allTypes); setPortfolio(''); setRanges({}); setCampaignSel([]) }
  const persistLibrary = (next: FilterPreset[]) => { setLibrary(next); try { localStorage.setItem(LIB_KEY, JSON.stringify(next)) } catch { /* ignore */ } }
  const savePreset = () => {
    persistLibrary([...library, { name: `Preset ${library.length + 1}`, statuses, types, portfolio, campaigns: campaignSel, ranges }])
    setPresetMsg('Saved'); setTimeout(() => setPresetMsg(''), 1500); setShowLibrary(true)
  }
  const applyPreset = (p: FilterPreset) => {
    setStatuses(p.statuses ?? allStatuses); setTypes(p.types ?? allTypes); setPortfolio(p.portfolio ?? '')
    setCampaignSel(p.campaigns ?? []); setRanges(p.ranges ?? {}); setShowLibrary(false)
  }
  const deletePreset = (i: number) => persistLibrary(library.filter((_, idx) => idx !== i))
  // live show/hide from the Customize popover (no Apply step; persists each toggle)
  const onColsChange = (visible: string[]) => {
    setColVisible(visible)
    try { localStorage.setItem(COLS_KEY, JSON.stringify({ order: colOrder, visible })) } catch { /* ignore */ }
  }
  // restore H10's default column order + visibility (undoes drag-reorder + hides)
  const resetCols = () => {
    setColOrder(ALL_KEYS)
    setColVisible(DEFAULT_VISIBLE)
    try { localStorage.setItem(COLS_KEY, JSON.stringify({ order: ALL_KEYS, visible: DEFAULT_VISIBLE })) } catch { /* ignore */ }
  }
  // column hover highlight — toggle .colhi on the column's cells via DOM (NOT React
  // state) so sweeping across headers never re-renders the 100-row grid.
  const setColHi = (key: string | null) => {
    if (document.body.classList.contains('col-dragging')) return
    if (colHiRef.current === key) return
    if (colHiRef.current) document.querySelectorAll(`.h10-am-grid [data-col="${CSS.escape(colHiRef.current)}"]`).forEach((el) => el.classList.remove('colhi'))
    if (key) document.querySelectorAll(`.h10-am-grid [data-col="${CSS.escape(key)}"]`).forEach((el) => el.classList.add('colhi'))
    colHiRef.current = key
  }
  // Pointer-driven LIVE reorder: as the cursor crosses a header, the dragged item
  // moves next to it immediately (grid re-renders → columns shift in real time).
  // Click vs drag is disambiguated by a 5px threshold; the new order persists on drop.
  // Operates on Customize items so the Adtomic cluster moves as one unit.
  const startColDrag = (pc: PhysCol, startX: number, startY: number, button: number) => {
    if (button !== 0) return
    const item = physToItem(pc.key)
    dragRef.current = { item, startX, startY, dragging: false, label: pc.label, bounds: [], drop: null, before: true, gridTop: 0, gridH: 0, lastX: startX, lastY: startY, scrollEl: null, initScroll: 0, frozenRight: 0, rafId: 0 }
    // One update tick: chip follows cursor, edge-auto-scroll, recompute the drop
    // position. All direct DOM (no React render). Driven by rAF so it keeps going
    // while the pointer is held at an edge (continuous auto-scroll).
    const update = () => {
      const d = dragRef.current; if (!d || !d.dragging) return
      const x = d.lastX, y = d.lastY
      if (chipRef.current) { chipRef.current.style.opacity = '1'; chipRef.current.style.transform = `translate(${x + 14}px, ${y + 12}px)` }
      const g = d.scrollEl
      if (g) {
        const gr = g.getBoundingClientRect(); const EDGE = 72, MAX = 24
        if (x < gr.left + EDGE) g.scrollLeft -= Math.ceil(MAX * Math.min(1, (gr.left + EDGE - x) / EDGE))
        else if (x > gr.right - EDGE) g.scrollLeft += Math.ceil(MAX * Math.min(1, (x - (gr.right - EDGE)) / EDGE))
      }
      const delta = (g ? g.scrollLeft : 0) - d.initScroll
      const others = d.bounds.filter((b) => b.item !== d.item)
      if (!others.length) return
      let idx = others.length
      for (let i = 0; i < others.length; i++) { if (x < others[i].center - delta) { idx = i; break } }
      if (idx < others.length) { d.drop = others[idx].item; d.before = true } else { d.drop = others[others.length - 1].item; d.before = false }
      let lineX = (idx < others.length ? others[idx].left : others[others.length - 1].right) - delta
      if (g) { const gr = g.getBoundingClientRect(); lineX = Math.max(d.frozenRight, Math.min(lineX, gr.right - 2)) }
      if (indRef.current) { indRef.current.style.opacity = '1'; indRef.current.style.top = `${d.gridTop}px`; indRef.current.style.height = `${d.gridH}px`; indRef.current.style.transform = `translateX(${lineX}px)` }
    }
    const rafLoop = () => { const d = dragRef.current; if (!d || !d.dragging) return; update(); d.rafId = requestAnimationFrame(rafLoop) }
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current; if (!d) return
      d.lastX = ev.clientX; d.lastY = ev.clientY
      if (!d.dragging) {
        if (Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) < 5) return
        d.dragging = true
        setColHi(null) // clear any hover highlight before the drag takes over
        document.body.style.userSelect = 'none'
        document.body.classList.add('col-dragging') // suppresses header tooltips while dragging
        const g = document.querySelector('.h10-am-grid') as HTMLElement | null
        d.scrollEl = g; d.initScroll = g?.scrollLeft ?? 0
        // freeze each visible column's bounds ONCE (incl. off-screen ones) → stable
        // hit-testing; we account for auto-scroll via the scrollLeft delta.
        const byItem = new Map<string, { item: string; left: number; right: number }>()
        document.querySelectorAll('.h10-am-grid thead th[data-item]').forEach((el) => {
          const r = el.getBoundingClientRect(); const it = el.getAttribute('data-item') as string
          const cur = byItem.get(it)
          if (cur) { cur.left = Math.min(cur.left, r.left); cur.right = Math.max(cur.right, r.right) }
          else byItem.set(it, { item: it, left: r.left, right: r.right })
        })
        d.bounds = Array.from(byItem.values()).map((b) => ({ ...b, center: (b.left + b.right) / 2 })).sort((a, b) => a.left - b.left)
        const fz = document.querySelector('.h10-am-grid thead th.nm.fz') as HTMLElement | null
        const gr = g?.getBoundingClientRect()
        const head = (g?.querySelector('thead') as HTMLElement | null)?.getBoundingClientRect()
        d.frozenRight = fz ? fz.getBoundingClientRect().right : (gr?.left ?? 0)
        d.gridTop = head?.top ?? gr?.top ?? 0; d.gridH = head?.height ?? 0 // drop-line spans only the header row
        setDrag({ item: d.item, label: d.label }) // one re-render: mount chip + indicator + dim source
        d.rafId = requestAnimationFrame(rafLoop)
      }
      update()
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp)
      const d = dragRef.current
      if (d?.rafId) cancelAnimationFrame(d.rafId)
      document.body.style.userSelect = ''; document.body.classList.remove('col-dragging')
      dragRef.current = null; setDrag(null)
      if (d?.dragging && d.drop && d.drop !== d.item) {
        suppressClick.current = true
        const from = d.item, drop = d.drop, before = d.before
        setColOrder((order) => {
          const arr = order.filter((k) => k !== from)
          let i = arr.indexOf(drop); if (i < 0) return order
          if (!before) i += 1
          arr.splice(i, 0, from)
          try { localStorage.setItem(COLS_KEY, JSON.stringify({ order: arr, visible: colVisible })) } catch { /* ignore */ }
          return arr
        })
      }
    }
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp); window.addEventListener('pointercancel', onUp)
  }

  const setEdit = (id: string, patch: { biddingStrategy?: string; dailyBudget?: string }) =>
    setEdits((m) => ({ ...m, [id]: { ...m[id], ...patch } }))
  // CBN.2h.6 — apply the Bulk Actions modal's staged changes. Per campaign, up to
  // three real writes: (1) Status / Budget / Bidding Strategy → the gated campaign
  // PATCH (live → Amazon, non-live → local); (2) Bid Automation / Target ACoS →
  // the /automation settings (dynamicBidding, fraction); (3) Bid Multiplier →
  // /placements, merging the chosen placement with the campaign's current ones.
  const applyBulkChanges = async (ch: BulkChanges) => {
    setShowBulk(false)
    const targets = rows.filter((c) => sel.has(c.id))
    if (targets.length === 0) return
    setApplying(true)
    const base = getBackendUrl()
    let ok = 0; let fail = 0; const patched: Record<string, Partial<Camp>> = {}
    for (const c of targets) {
      const calls: Array<Promise<boolean>> = []
      const opt: Partial<Camp> = {}
      // 1) status / budget / strategy — gated PATCH (pushes to Amazon for live markets)
      if (ch.status || ch.budget || ch.strategy) {
        const body: Record<string, unknown> = { applyImmediately: true, reason: 'Ad Manager bulk action' }
        if (ch.status) { body.status = ch.status.value; opt.status = ch.status.value }
        if (ch.strategy) { body.biddingStrategy = ch.strategy.value; opt.biddingStrategy = ch.strategy.value }
        if (ch.budget) {
          const cur = num(c.dailyBudget); const v = ch.budget.value
          let next = ch.budget.mode === 'set' ? v : ch.budget.mode === 'incPct' ? cur * (1 + v / 100) : cur * (1 - v / 100)
          next = Math.max(1, Math.round(next)); body.dailyBudget = next; opt.dailyBudget = String(next)
        }
        calls.push(patchJson(`${base}/api/advertising/campaigns/${c.id}`, body))
      }
      // 2) bid automation / target ACoS — local automation settings (dynamicBidding)
      if (ch.automation != null || ch.acos != null) {
        const body: Record<string, unknown> = {}
        if (ch.automation != null) { body.bidAutomation = ch.automation; opt.bidAutomation = ch.automation }
        if (ch.acos != null) { const frac = ch.acos / 100; body.targetAcos = frac; opt.targetAcos = frac }
        calls.push(patchJson(`${base}/api/advertising/campaigns/${c.id}/automation`, body))
      }
      // 3) bid multiplier — placement bidding (merge chosen placement with current)
      if (ch.multiplier) {
        const cur = c.placements ?? { tos: null, pdp: null, ros: null }
        const entries: Array<{ placement: string; percentage: number }> = []
        for (const [k, v] of [['TOS', cur.tos], ['PP', cur.pdp], ['ROS', cur.ros]] as Array<['TOS' | 'PP' | 'ROS', number | null]>) {
          const p = ch.multiplier.placement === k ? ch.multiplier.value : (v ?? 0)
          if (p > 0) entries.push({ placement: AMZ_PLACEMENT[k], percentage: p })
        }
        calls.push(patchJson(`${base}/api/advertising/campaigns/${c.id}/placements`, { adjustments: entries }))
        const npl = { tos: cur.tos, pdp: cur.pdp, ros: cur.ros }
        const slot = ch.multiplier.placement === 'TOS' ? 'tos' : ch.multiplier.placement === 'PP' ? 'pdp' : 'ros'
        npl[slot] = ch.multiplier.value
        opt.placements = npl
      }
      const results = await Promise.all(calls)
      if (results.length > 0 && results.every(Boolean)) { ok++; patched[c.id] = opt } else fail++
    }
    setRows((rs) => rs.map((x) => (patched[x.id] ? { ...x, ...patched[x.id] } : x)))
    setApplying(false); setSel(new Set())
    setApplyMsg(`Applied to ${ok} campaign${ok !== 1 ? 's' : ''}${fail ? ` · ${fail} failed (write-gate / non-live / not yet deployed)` : ''}`)
    setTimeout(() => setApplyMsg(''), 6000)
  }
  const applyAdjustBudget = () => {
    setAdjustOpen(false)
    void applyBulkChanges({ budget: { mode: adjMode, value: Number(adjVal) || 0, label: BUDGET_MODES.find((b) => b.value === adjMode)!.label } })
  }
  // CBN.2h.2 — bulk status (Enable/Archive/Pause) via the gated campaign PATCH,
  // behind a confirmation. Live markets push to Amazon; non-live update locally.
  const applyBulkStatus = async (status: 'ENABLED' | 'PAUSED' | 'ARCHIVED') => {
    setApplying(true)
    const targets = rows.filter((c) => sel.has(c.id))
    let ok = 0; let fail = 0; const done = new Set<string>()
    for (const c of targets) {
      try {
        const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status, applyImmediately: true, reason: `Ad Manager bulk ${status}` }) })
        const j = await r.json().catch(() => ({}))
        if (r.ok && j?.ok !== false) { ok++; done.add(c.id) } else fail++
      } catch { fail++ }
    }
    setRows((rs) => rs.map((x) => (done.has(x.id) ? { ...x, status } : x)))
    setApplying(false); setBulkConfirm(null); setSel(new Set())
    setApplyMsg(`${status === 'ENABLED' ? 'Enabled' : status === 'PAUSED' ? 'Paused' : 'Archived'} ${ok} campaign${ok !== 1 ? 's' : ''}${fail ? ` · ${fail} failed (write-gate or non-live)` : ''}`)
    setTimeout(() => setApplyMsg(''), 5000)
  }
  // P2b — load portfolios (real names) for the bulk-assign picker.
  useEffect(() => {
    fetch(`${getBackendUrl()}/api/advertising/portfolios`, { cache: 'no-store' })
      .then((r) => r.json()).then((d) => setPfOptions(Array.isArray(d?.portfolios) ? d.portfolios : [])).catch(() => {})
  }, [])
  // P2b — bulk assign selected campaigns to a portfolio (or clear) via the gated campaign PATCH.
  const applyBulkPortfolio = async (portfolioId: string | null, name: string) => {
    setPortfolioMenu(false); setApplying(true)
    const targets = rows.filter((c) => sel.has(c.id))
    let ok = 0; let fail = 0; const done = new Set<string>()
    for (const c of targets) {
      try {
        const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ portfolioId, applyImmediately: true, reason: 'Ad Manager bulk portfolio assign' }) })
        const j = await r.json().catch(() => ({}))
        if (r.ok && j?.ok !== false) { ok++; done.add(c.id) } else fail++
      } catch { fail++ }
    }
    setRows((rs) => rs.map((x) => (done.has(x.id) ? { ...x, portfolioId: portfolioId ?? null } : x)))
    setApplying(false); setSel(new Set())
    setApplyMsg(`Assigned ${ok} campaign${ok !== 1 ? 's' : ''} to ${name}${fail ? ` · ${fail} failed (write-gate or non-live)` : ''}`)
    setTimeout(() => setApplyMsg(''), 5000)
  }
  // P3 — single-campaign writes (operator actions), same gated endpoints as bulk.
  const toast = (m: string) => { setApplyMsg(m); setTimeout(() => setApplyMsg(''), 5000) }
  const setCampaignStatus = async (c: Camp, status: 'ENABLED' | 'PAUSED' | 'ARCHIVED') => {
    setStatusMenu(null)
    const ok = await patchJson(`${getBackendUrl()}/api/advertising/campaigns/${c.id}`, { status, applyImmediately: true, reason: `Ad Manager status ${status}` })
    if (ok) setRows((rs) => rs.map((x) => (x.id === c.id ? { ...x, status } : x)))
    toast(ok ? `${STATUS_PILL[status]?.label ?? status} · ${c.name}` : `Failed (write-gate / non-live / not deployed) · ${c.name}`)
  }
  const setCampaignStrategy = async (c: Camp, biddingStrategy: string) => {
    setStrategyModal(null)
    const ok = await patchJson(`${getBackendUrl()}/api/advertising/campaigns/${c.id}`, { biddingStrategy, applyImmediately: true, reason: 'Ad Manager bidding strategy' })
    if (ok) setRows((rs) => rs.map((x) => (x.id === c.id ? { ...x, biddingStrategy } : x)))
    toast(ok ? `Bidding strategy → ${STRAT_LABEL[biddingStrategy] ?? biddingStrategy} · ${c.name}` : `Failed (write-gate / non-live / not deployed) · ${c.name}`)
  }
  const setCampaignPlacements = async (c: Camp, pl: { tos: number | null; pdp: number | null; ros: number | null }) => {
    setMultiplierModal(null)
    const adjustments: Array<{ placement: string; percentage: number }> = []
    for (const [k, v] of [['TOS', pl.tos], ['PP', pl.pdp], ['ROS', pl.ros]] as Array<['TOS' | 'PP' | 'ROS', number | null]>) { if (v && v > 0) adjustments.push({ placement: AMZ_PLACEMENT[k], percentage: v }) }
    const ok = await patchJson(`${getBackendUrl()}/api/advertising/campaigns/${c.id}/placements`, { adjustments })
    if (ok) setRows((rs) => rs.map((x) => (x.id === c.id ? { ...x, placements: pl } : x)))
    toast(ok ? `Bid multiplier updated · ${c.name}` : `Failed (write-gate / non-live / not deployed) · ${c.name}`)
  }
  // Bid algorithm + Min/Max bid have no Amazon field yet — update locally only.
  const setCampaignBidAlgo = (c: Camp, bidAlgorithm: string) => {
    setBidRuleMenu(null)
    setRows((rs) => rs.map((x) => (x.id === c.id ? { ...x, bidAlgorithm } : x)))
    toast(`Bid algorithm → ${BID_ALGOS.find((a) => a.value === bidAlgorithm)?.label ?? bidAlgorithm} · ${c.name} (local — Amazon field pending)`)
  }
  const setCampaignMinMaxBid = (c: Camp, mm: { min: number | null; max: number | null } | null) => {
    setEditPop(null)
    setRows((rs) => rs.map((x) => (x.id === c.id ? { ...x, minMaxBid: mm } : x)))
    toast(`Min/Max bid updated · ${c.name} (local — Amazon field pending)`)
  }
  const setCampaignMinMaxBudget = (c: Camp, mm: { min: number | null; max: number | null } | null) => {
    setEditPop(null)
    setRows((rs) => rs.map((x) => (x.id === c.id ? { ...x, minMaxBudget: mm } : x)))
    toast(`Min/Max budget updated · ${c.name} (local — Amazon field pending)`)
  }
  // Target ACoS → real /automation write (fraction); Daily Budget → gated PATCH.
  const setCampaignTargetAcos = async (c: Camp, pctStr: string) => {
    setEditPop(null)
    const pct = Number(pctStr); if (!Number.isFinite(pct)) return
    const frac = Math.max(0, Math.min(5, pct / 100))
    const ok = await patchJson(`${getBackendUrl()}/api/advertising/campaigns/${c.id}/automation`, { targetAcos: frac })
    if (ok) setRows((rs) => rs.map((x) => (x.id === c.id ? { ...x, targetAcos: frac } : x)))
    toast(ok ? `Target ACoS → ${pct.toFixed(2)}% · ${c.name}` : `Failed (write-gate / non-live / not deployed) · ${c.name}`)
  }
  const setCampaignDailyBudget = async (c: Camp, valStr: string) => {
    setEditPop(null)
    const v = Math.max(1, Math.round(Number(valStr) || 0))
    const ok = await patchJson(`${getBackendUrl()}/api/advertising/campaigns/${c.id}`, { dailyBudget: v, applyImmediately: true, reason: 'Ad Manager daily budget' })
    if (ok) setRows((rs) => rs.map((x) => (x.id === c.id ? { ...x, dailyBudget: String(v) } : x)))
    toast(ok ? `Daily budget → ${eur(v)} · ${c.name}` : `Failed (write-gate / non-live / not deployed) · ${c.name}`)
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
  // Portfolio filter options — resolve real names from /advertising/portfolios (pfOptions,
  // the same v3-backed source Amazon shows + the bulk-assign picker uses). Fall back to a short
  // id only for a portfolio we have no name for; sort by name so the dropdown reads like Amazon.
  const portfolios = useMemo(() => {
    const nameById = new Map(pfOptions.map((p) => [p.portfolioId, p.name]))
    const ids = Array.from(new Set(rows.map((r) => r.portfolioId).filter(Boolean) as string[]))
    return ids
      .map((id) => ({ id, label: nameById.get(id) ?? `Portfolio ${id.slice(0, 6)}` }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [rows, pfOptions])
  const campaignNames = useMemo(() => Array.from(new Set(rows.map((r) => r.name))).sort((a, b) => a.localeCompare(b)), [rows])

  const statusActive = statuses.length !== DEFAULT_STATUSES.length || !DEFAULT_STATUSES.every((s) => statuses.includes(s))
  const typeAll = types.length === TYPE_OPTS.length
  const hasActiveFilters = statusActive || !typeAll || !!portfolio || campaignSel.length > 0
    || Object.values(ranges).some((r) => r && (r.min || r.max))

  const filtered = useMemo(() => {
    const sAll = statuses.length === STATUS_OPTS.length
    const tAll = types.length === TYPE_OPTS.length
    return rows.filter((c) => {
      if (market !== 'all' && c.marketplace !== market) return false
      if (portfolio && c.portfolioId !== portfolio) return false
      if (campaignSel.length && !campaignSel.includes(c.name)) return false
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
  }, [rows, campaignSel, statuses, types, portfolio, ranges, market])

  const allSel = filtered.length > 0 && filtered.every((c) => sel.has(c.id))
  const toggleAll = () => setSel(allSel ? new Set() : new Set(filtered.map((c) => c.id)))
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  // edit-mode cells (label-keyed). Bidding Strategy + Daily Budget are inline-
  // editable; edits stage into `edits` and surface in the Discard/Apply footer.
  const settingsCell = (c: Camp, key: string): ReactNode => {
    const e = edits[c.id]
    // hover-revealed edit pencil (H10: pencil appears on row hover only); opens a
    // popover anchored under the cell.
    const ed = (display: ReactNode, kind: 'targetAcos' | 'dailyBudget' | 'minMaxBid' | 'minMaxBudget') => (
      <span className="h10-edcell">{display}<button type="button" className="h10-editpen" aria-label="Edit" onClick={(ev) => { const td = (ev.currentTarget as HTMLElement).closest('td'); const r = (td ?? (ev.currentTarget as HTMLElement)).getBoundingClientRect(); setEditPop({ id: c.id, kind, x: r.left, y: r.bottom + 4 }) }}><Pencil size={11} /></button></span>
    )
    switch (key) {
      case 'bidRule': return <span className="h10-edcell"><span className="h10-bidrule"><Shuffle size={13} /> {bidAlgoLabel(c)}</span><button type="button" className="h10-editpen" aria-label="Edit bid rule" onClick={(ev) => { const td = (ev.currentTarget as HTMLElement).closest('td'); const r = (td ?? (ev.currentTarget as HTMLElement)).getBoundingClientRect(); setBidRuleMenu({ id: c.id, x: r.left, y: r.bottom + 4 }) }}><Pencil size={11} /></button></span>
      case 'targetAcos': return ed(`${((c.targetAcos ?? 0.3) * 100).toFixed(2)}%`, 'targetAcos') // 0.3 = optimizer default when unset
      case 'minMaxBid': return ed(c.minMaxBid && (c.minMaxBid.min != null || c.minMaxBid.max != null) ? `${c.minMaxBid.min != null ? eur(c.minMaxBid.min) : '—'} – ${c.minMaxBid.max != null ? eur(c.minMaxBid.max) : '—'}` : 'None', 'minMaxBid')
      case 'bidAutomation': return <span className={`h10-toggle ${c.bidAutomation ? 'on' : 'off'}`} aria-hidden />
      case 'status': { const sp = STATUS_PILL[c.status] ?? { label: c.status, cls: '' }; return <span className="h10-statuscell"><span className={`h10-pill ${sp.cls}`}>{sp.label}</span><button type="button" className="ch" aria-label={`Change status for ${c.name}`} onClick={(ev) => { const r = (ev.currentTarget as HTMLElement).getBoundingClientRect(); setStatusMenu({ id: c.id, x: Math.max(8, r.right - 156), y: r.bottom + 5 }) }}><ChevronDown size={13} aria-hidden /></button></span> }
      case 'minMaxBudget': return ed(c.minMaxBudget && (c.minMaxBudget.min != null || c.minMaxBudget.max != null) ? `${c.minMaxBudget.min != null ? eur(c.minMaxBudget.min) : '—'} – ${c.minMaxBudget.max != null ? eur(c.minMaxBudget.max) : '—'}` : 'None - None', 'minMaxBudget')
      case 'rules': return <button type="button" className="h10-rules" onClick={() => setRulesModal(c)}><b>0</b> <Settings2 size={12} /></button>
      case 'biddingStrategy': return <span className="h10-edcell">{STRAT_LABEL[effStrat(c)] ?? '—'}<button type="button" className="h10-editpen" aria-label="Edit bidding strategy" onClick={() => setStrategyModal(c)}><Pencil size={11} /></button></span>
      case 'bidMultiplier': return <button type="button" className="h10-gearbtn" aria-label={`Bid multiplier for ${c.name}`} onClick={() => setMultiplierModal(c)}><Settings2 size={14} className="h10-gear" /></button>
      case 'startDate': return fmtDate(c.startDate)
      case 'endDate': return c.endDate ? fmtDate(c.endDate) : '-'
      case 'dailyBudget': {
        if (mode === 'edit') {
          const dirty = e?.dailyBudget != null && e.dailyBudget !== '' && Number(e.dailyBudget) !== num(c.dailyBudget)
          return (
            <span className={`h10-bud ${dirty ? 'dirty' : ''}`}>
              <span className="cur">€</span>
              <input type="number" min="1" step="1" value={effBudget(c)} onChange={(ev) => setEdit(c.id, { dailyBudget: ev.target.value })} aria-label={`Daily budget for ${c.name}`} />
            </span>
          )
        }
        return ed(c.dailyBudget != null && c.dailyBudget !== '' ? eur(num(c.dailyBudget)) : '—', 'dailyBudget')
      }
      case 'curBudgetUtil':
      case 'avgBudgetUtil': return <span className="h10-util" aria-hidden><span className="uf" style={{ width: '0%' }} /></span>
      default: return '—'
    }
  }

  // unified, fully-customizable column set (H10: one continuous scroll). Each
  // visible checklist item expands to its physical grid column(s) — "Bid
  // Algorithm" becomes the 4-col Adtomic cluster (Bid Rule · Target ACoS ·
  // Min/Max Bid · Bid Automation).
  const physical = useMemo(() => metricCols.flatMap(physCols), [metricCols])

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
  const sortIcon = (key: string) => (sort?.key === key ? (sort.dir === 'asc' ? <ChevronUp size={13} className="sa on" /> : <ChevronDown size={13} className="sa on" />) : <ChevronsUpDown size={13} className="sa" />)

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
        onDateRange={(s, e) => { const r = { start: s, end: e }; setDateRange(r); void load({ range: r }) }}
        onDataSync={() => void load({ sync: true, range: dateRange })} syncing={syncing}
        actions={[
          { label: 'Create Campaign', href: '/marketing/ads/campaign-builder' },
          { label: 'Create Rule', href: '/marketing/ads/rules-automation' },
          { label: showGraph ? 'Hide Graph' : 'Show Graph', onClick: () => setShowGraph((v) => !v) },
        ]}
      />

      {showGraph && <AdManagerGraph market={market} rangePreset={rangePreset} />}

      {/* filter bar — Helium 10 Ad Manager match */}
      <div className={`h10-am-fpanel${filtersOpen ? '' : ' is-collapsed'}`}>
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
                  <Book size={14} /> Filter Library{library.length ? ` (${library.length})` : ''}
                </button>
                {showLibrary && <FilterLibrary library={library} onApply={applyPreset} onDelete={deletePreset} onClose={() => setShowLibrary(false)} />}
              </div>
            </div>

            <div className="frow">
              <div className="ffield wide"><span>Portfolio</span>
                <FilterDropdown options={portfolios.map((p) => ({ value: p.id, label: p.label }))} value={portfolio} onChange={setPortfolio} emptyLabel="Select a Portfolio" emptyIsPlaceholder searchable searchPlaceholder="Search portfolios…" ariaLabel="Portfolio" />
              </div>
              <div className="ffield wide"><span>Campaign</span>
                <CampaignMultiSelect names={campaignNames} selected={campaignSel} onChange={setCampaignSel} />
              </div>
              <div className="ffield wide"><span>Campaign Type</span>
                <MultiSelect options={TYPE_OPTS} selected={types} onChange={setTypes} ariaLabel="Campaign Type" />
              </div>

              <div className="ffield"><span>Status</span>
                <MultiSelect options={STATUS_OPTS} selected={statuses} onChange={setStatuses} ariaLabel="Status" />
              </div>
              <div className="ffield"><span>Bid Automation</span>
                <FilterDropdown options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} emptyLabel="All" ariaLabel="Bid Automation" />
              </div>
              <div className="ffield"><span>Rule</span>
                <FilterDropdown options={[{ value: 'has', label: 'Has rules' }, { value: 'none', label: 'No rules' }]} emptyLabel="All campaigns" ariaLabel="Rule" />
              </div>

              {RANGE_FIELDS.map((f) => (
                <div className="ffield" key={f.key}>
                  <span>{f.label}{RANGE_TIPS[f.key] && <InfoTip tip={RANGE_TIPS[f.key]} />}</span>
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

      {/* toolbar — H10 selection-aware actions (CBN.2h.6) */}
      <div className="h10-am-toolbar">
        <span className="cnt">{sel.size > 0 ? <b>{`Selected ${sel.size} Campaign${sel.size > 1 ? 's' : ''}`}</b> : `Viewing ${viewStart}-${viewEnd} of ${filtered.length} Campaigns`}</span>
        <button type="button" className={`h10-am-btn ${sel.size > 0 ? 'on' : ''}`} disabled={sel.size === 0} onClick={() => setShowBulk(true)}><ListChecks size={13} /> Bulk Actions</button>
        <button type="button" className={`h10-am-btn ${mode === 'edit' ? 'on' : ''}`} onClick={() => setMode(mode === 'edit' ? 'metrics' : 'edit')}><Pencil size={13} /> Edit Campaigns</button>
        <div className="h10-bulkwrap">
          <button type="button" className="h10-am-btn" disabled={sel.size === 0} onClick={() => setPortfolioMenu((v) => !v)}><Plus size={13} /> Portfolio</button>
          {portfolioMenu && sel.size > 0 && <>
            <button type="button" className="h10-menu-back" aria-label="Close" onClick={() => setPortfolioMenu(false)} />
            <div className="h10-menu" role="dialog" aria-label="Assign to portfolio" style={{ maxHeight: 320, overflowY: 'auto' }}>
              <button type="button" onClick={() => void applyBulkPortfolio(null, 'No portfolio')}>No portfolio</button>
              {pfOptions.map((p) => (
                <button type="button" key={p.portfolioId} onClick={() => void applyBulkPortfolio(p.portfolioId, p.name)}>{p.name}</button>
              ))}
              {pfOptions.length === 0 && <span className="sub" style={{ padding: '8px 11px' }}>No portfolios yet — create one first.</span>}
            </div>
          </>}
        </div>
        {sel.size > 0 && <>
          <div className="h10-bulkwrap">
            <button type="button" className="h10-am-btn" onClick={() => setAdjustOpen((v) => !v)}>Adjust Budget</button>
            {adjustOpen && <>
              <button type="button" className="h10-menu-back" aria-label="Close" onClick={() => setAdjustOpen(false)} />
              <div className="h10-menu adjbud" role="dialog" aria-label="Adjust Budget">
                <div className="abh">Adjust Budget</div>
                {BUDGET_MODES.map((m) => (
                  <label className="abr" key={m.value}><input type="radio" name="adjmode" checked={adjMode === m.value} onChange={() => setAdjMode(m.value)} /> {m.label}</label>
                ))}
                <div className="abrow">
                  <span className="h10-bulk-inp"><span className="pf">{adjMode === 'set' ? '€' : '%'}</span><input type="number" min="0" step="1" value={adjVal} onChange={(e) => setAdjVal(e.target.value)} aria-label="Budget value" /></span>
                  <button type="button" className="h10-am-btn primary sm" onClick={applyAdjustBudget}>Apply</button>
                </div>
              </div>
            </>}
          </div>
          <button type="button" className="h10-am-btn" onClick={() => setBulkConfirm('ENABLED')}>Enable</button>
          <button type="button" className="h10-am-btn" onClick={() => setBulkConfirm('ARCHIVED')}>Archive</button>
          <button type="button" className="h10-am-btn" onClick={() => setBulkConfirm('PAUSED')}>Pause</button>
        </>}
        <span className="grow" />
        <div className="h10-custwrap">
          <button type="button" className={`h10-am-btn ${showCustomize ? 'on' : ''}`} onClick={() => setShowCustomize((v) => !v)} aria-haspopup="dialog" aria-expanded={showCustomize}><Settings2 size={13} /> Customize</button>
          {showCustomize && <CustomizePanel visible={colVisible} onChange={onColsChange} onReset={resetCols} onClose={() => setShowCustomize(false)} />}
        </div>
        <button type="button" className="h10-am-btn"><Download size={13} /> Export Data</button>
        <Link href="/marketing/ads/rules-automation" className="h10-am-btn"><Wand2 size={13} /> Create Rule</Link>
        <Link href="/marketing/ads/campaign-builder" className="h10-am-btn primary"><Plus size={13} /> Campaign</Link>
      </div>

      {/* grid */}
      <div className="h10-am-grid">
        <table>
          <thead>
            <tr>
              <th className="ck"><input type="checkbox" checked={allSel} onChange={toggleAll} aria-label="Select all" /></th>
              <th className="nm fz"><button type="button" className="sortable" onClick={() => onSort('name')}>Campaign {sortIcon('name')}</button></th>
              {physical.map((pc) => (
                <th key={pc.key}
                    data-item={physToItem(pc.key)} data-col={pc.key}
                    className={`${pc.metric ? 'num' : 'ed'} ${drag?.item === physToItem(pc.key) ? 'dragging' : ''}`}
                    onPointerDown={(e) => startColDrag(pc, e.clientX, e.clientY, e.button)}
                    onMouseEnter={() => setColHi(pc.key)} onMouseLeave={() => { if (colHiRef.current === pc.key) setColHi(null) }}>
                  <button type="button" className="sortable" onClick={() => { if (suppressClick.current) { suppressClick.current = false; return } onSort(pc.key) }}>
                    {COL_TIPS[pc.key]
                      ? <HoverCard text={COL_TIPS[pc.key]} placement="above" delay={800}><span className="hl">{pc.label} {sortIcon(pc.key)}</span></HoverCard>
                      : <span className="hl">{pc.label} {sortIcon(pc.key)}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={`sk${i}`} className="sk">
                  <td className="ck"><span className="skb" style={{ width: 15 }} /></td>
                  <td className="nm fz"><span className="skb" style={{ width: 160 }} /></td>
                  {physical.map((pc) => <td key={pc.key} className={pc.metric ? 'num' : 'ed'}><span className="skb" style={{ width: 52 }} /></td>)}
                </tr>
              ))
            ) : filtered.length === 0 ? (
              <tr><td colSpan={physical.length + 2} className="empty">No campaigns.</td></tr>
            ) : paged.map((c) => {
              return (
                <tr key={c.id} className={sel.has(c.id) ? 'on' : ''}>
                  <td className="ck"><input type="checkbox" checked={sel.has(c.id)} onChange={() => toggle(c.id)} aria-label={`Select ${c.name}`} /></td>
                  <td className="nm fz">
                    <div className="nmw">
                      {/* lightbulb = Budget Manager Auto Pacing status (own tooltip, below) */}
                      <HoverCard placement="below" text="This campaign is not managed by Budget Manager Auto Pacing">
                        <span className="bulb"><Lightbulb size={12} aria-hidden /></span>
                      </HoverCard>
                      {/* A/M + SP = campaign info card (above) */}
                      <HoverCard rows={[
                        ['Status', STATUS_PILL[c.status]?.label ?? c.status],
                        ['Daily Budget', c.dailyBudget != null && c.dailyBudget !== '' ? eur(num(c.dailyBudget)) : '—'],
                        ['Targeting Type', targetingLetter(c) === 'A' ? 'Auto' : 'Manual'],
                        ['Campaign Type', TYPE_LABEL[c.type ?? c.adProduct ?? ''] ?? 'Sponsored Products'],
                      ]}>
                        <span className="tg" data-t={targetingLetter(c)}>{targetingLetter(c)}</span>
                        <span className="pb">{productBadge(c)}</span>
                      </HoverCard>
                      <span className="t" title={c.name}>{c.name}</span>
                      {c.marketplace && <span className="mk">{c.marketplace}</span>}
                      <a className="h10-open" href={`/marketing/ads/campaigns/${c.id}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}><ExternalLink size={11} /> Open</a>
                    </div>
                  </td>
                  {physical.map((pc) => <td key={pc.key} data-col={pc.key} className={`${pc.metric ? 'num' : 'ed'} ${drag?.item === physToItem(pc.key) ? 'dragging' : ''}`}>{pc.metric ? renderCol(c, pc.key) : settingsCell(c, pc.key)}</td>)}
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
          <H10Select width={84} options={[{ value: '50', label: '50' }, { value: '100', label: '100' }, { value: '200', label: '200' }, { value: '500', label: '500' }]} value={String(rowsPerPage)} onChange={(v) => { setRowsPerPage(Number(v)); setPage(1) }} ariaLabel="Rows per page" />
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

      {/* CBN.2h.2 — bulk status (Enable / Archive / Pause) confirmation */}
      {bulkConfirm && (
        <div className="h10-modal-backdrop" onClick={() => !applying && setBulkConfirm(null)}>
          <div className="h10-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Bulk status change">
            <div className="h10-modal-h"><b>{bulkConfirm === 'ENABLED' ? 'Enable' : bulkConfirm === 'PAUSED' ? 'Pause' : 'Archive'} {sel.size} campaign{sel.size > 1 ? 's' : ''}</b><button type="button" className="h10-modal-x" onClick={() => !applying && setBulkConfirm(null)} aria-label="Close"><X size={16} /></button></div>
            <div className="h10-modal-sub">Live markets push to Amazon (write-gate enforced); non-live markets update locally only.</div>
            <div className="h10-modal-b">
              {rows.filter((c) => sel.has(c.id)).slice(0, 60).map((c) => (
                <div className="h10-diffrow" key={c.id}><div className="dr-nm"><span className="t" title={c.name}>{c.name}</span>{c.marketplace && <span className="mk">{c.marketplace}</span>}<span className="to" style={{ marginLeft: 'auto' }}>→ {bulkConfirm === 'ENABLED' ? 'Enabled' : bulkConfirm === 'PAUSED' ? 'Paused' : 'Archived'}</span></div></div>
              ))}
            </div>
            <div className="h10-modal-f">
              <span className="grow" />
              <button type="button" className="h10-am-btn" onClick={() => setBulkConfirm(null)} disabled={applying}>Cancel</button>
              <button type="button" className="h10-am-btn primary" onClick={() => void applyBulkStatus(bulkConfirm)} disabled={applying}>{applying ? 'Applying…' : `${bulkConfirm === 'ENABLED' ? 'Enable' : bulkConfirm === 'PAUSED' ? 'Pause' : 'Archive'} ${sel.size}`}</button>
            </div>
          </div>
        </div>
      )}

      {showBulk && <BulkActionsModal onSubmit={(c) => void applyBulkChanges(c)} onClose={() => setShowBulk(false)} />}
      {drag && (<>
        <div ref={chipRef} className="h10-dragchip">{drag.label}</div>
        <div ref={indRef} className="h10-dropline" />
      </>)}

      {/* P3 — per-row Bidding Strategy / Bid Multiplier modals + Status menu */}
      {strategyModal && <StrategyModal campaign={strategyModal} onConfirm={(v) => void setCampaignStrategy(strategyModal, v)} onClose={() => setStrategyModal(null)} />}
      {multiplierModal && <BidMultiplierModal campaign={multiplierModal} onConfirm={(pl) => void setCampaignPlacements(multiplierModal, pl)} onClose={() => setMultiplierModal(null)} />}
      {statusMenu && (() => {
        const c = rows.find((x) => x.id === statusMenu.id)
        if (!c) return null
        return (
          <>
            <button type="button" className="h10-menu-back" aria-label="Close" onClick={() => setStatusMenu(null)} />
            <div className="h10-statusmenu" style={{ position: 'fixed', left: statusMenu.x, top: statusMenu.y }} role="menu">
              <button type="button" role="menuitem" onClick={() => void setCampaignStatus(c, 'ARCHIVED')}>Archive</button>
              <button type="button" role="menuitem" onClick={() => void setCampaignStatus(c, 'PAUSED')}>Pause</button>
              <button type="button" role="menuitem" onClick={() => void setCampaignStatus(c, 'ENABLED')}>Enable</button>
            </div>
          </>
        )
      })()}
      {rulesModal && <CampaignRulesModal campaign={rulesModal} onClose={() => setRulesModal(null)} />}
      {bidRuleMenu && (() => {
        const c = rows.find((x) => x.id === bidRuleMenu.id)
        if (!c) return null
        const cur = c.bidAlgorithm ?? 'TARGET_ACOS'
        return (
          <>
            <button type="button" className="h10-menu-back" aria-label="Close" onClick={() => setBidRuleMenu(null)} />
            <div className="h10-algomenu" style={{ position: 'fixed', left: bidRuleMenu.x, top: bidRuleMenu.y }} role="menu">
              {BID_ALGOS.map((a) => (
                <button key={a.value} type="button" role="menuitem" className={cur === a.value ? 'on' : ''} onClick={() => setCampaignBidAlgo(c, a.value)}>
                  <span className="t"><Shuffle size={12} /> {a.label}</span>
                  <span className="d">{a.desc}</span>
                </button>
              ))}
            </div>
          </>
        )
      })()}
      {editPop && (() => {
        const c = rows.find((x) => x.id === editPop.id)
        if (!c) return null
        const close = () => setEditPop(null)
        if (editPop.kind === 'targetAcos') return <ValuePopover title="Target ACoS" suffix="%" initial={((c.targetAcos ?? 0.3) * 100).toFixed(2)} x={editPop.x} y={editPop.y} onApply={(v) => void setCampaignTargetAcos(c, v)} onClose={close} />
        if (editPop.kind === 'dailyBudget') return <ValuePopover title="Daily Budget" prefix="€" initial={c.dailyBudget != null && c.dailyBudget !== '' ? String(num(c.dailyBudget)) : ''} x={editPop.x} y={editPop.y} onApply={(v) => void setCampaignDailyBudget(c, v)} onClose={close} />
        if (editPop.kind === 'minMaxBid') return <RangePopover title="Min/Max Bid" rangeLabel="Set a Min/Max Bid Range" initial={c.minMaxBid ?? null} x={editPop.x} y={editPop.y} onApply={(mm) => setCampaignMinMaxBid(c, mm)} onClose={close} />
        return <RangePopover title="Min/Max Budget" rangeLabel="Set a Min/Max Budget Range" initial={c.minMaxBudget ?? null} x={editPop.x} y={editPop.y} onApply={(mm) => setCampaignMinMaxBudget(c, mm)} onClose={close} />
      })()}
    </div>
  )
}
