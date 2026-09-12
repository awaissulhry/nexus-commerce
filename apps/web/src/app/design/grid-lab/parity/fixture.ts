/**
 * AGL — the parity fixture. ONE dataset and ONE column list per contract, handed to BOTH engines.
 *
 * WHY FROZEN, WHY GENERATED
 * The ads console cannot be verified locally (every data region 401s), and a parity comparison needs
 * both grids to hold the SAME rows at the SAME moment. So the rows are frozen here and produced by a
 * seeded generator: 120 of them, deterministic on every load, so the runner's "first 8 identity texts"
 * mean the same thing on Monday and on Friday. No API.
 *
 * WHAT THE ROWS DELIBERATELY CONTAIN
 * - the console's identity anatomy: A/M targeting letter, SP/SB/SD product chip, a market chip, the
 *   hover-revealed Open pill (see IdentityCell.tsx — the markup the console renders, verbatim);
 * - 14 rows with `acos: null` (spent, sold nothing — an ACoS does not exist, and that is NOT 0%).
 *   These MUST sink in BOTH sort directions (KT.3); a fixture without them lets that regression through;
 * - ENABLED / PAUSED / ARCHIVED status so `enabledFirst` banding has three bands to order;
 * - names from 22 to ~95 characters, so the identity cell's ellipsis is exercised on both engines;
 * - a two-level hierarchy (portfolio → campaigns → a computed "Other campaigns" remainder) for the
 *   drill-down contract, in the FLAT, tree-ordered shape the grid takes.
 */
import type { GridColumn, GridFilter } from '@/design-system/patterns'
import type { Column } from '@/design-system/components'
import type { ReactNode } from 'react'
import { renderStatus, renderMarketPill, renderVerbs, renderNameOnly } from './IdentityCell'

export type Product = 'SP' | 'SB' | 'SD'
export type Targeting = 'A' | 'M'
export type Market = 'DE' | 'IT' | 'FR' | 'ES' | 'UK'
export type Status = 'ENABLED' | 'PAUSED' | 'ARCHIVED'

export interface ParityRow {
  id: string
  name: string
  targeting: Targeting
  product: Product
  market: Market
  status: Status
  /** €/day */
  budget: number
  spend: number
  sales: number
  /** null = sold nothing, so no ACoS exists. NOT zero. */
  acos: number | null
  impressions: number
  clicks: number
  /** null = no impressions, so no click-through rate exists. */
  ctr: number | null
  cpc: number | null
  orders: number
  /** the group band's key in the groupBy scenario */
  portfolio: string
  /** hierarchy scenario only */
  depth?: number
  parentId?: string
  expandable?: boolean
  remainder?: boolean
}

/* ── the generator ───────────────────────────────────────────────────────────────────────────── */

/** A tiny LCG. Same seed, same rows, every load — the runner's ordering assertions depend on it. */
const lcg = (seed: number) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed / 0x1_0000_0000
}

const HEADS = ['Brand Defense', 'Category', 'Competitor ASINs', 'Long Tail', 'Auto Discovery', 'Seasonal', 'Retargeting', 'Store Spotlight', 'Headline', 'Audiences', 'Product Targeting', 'Cross-sell', 'Launch', 'Best Sellers', 'Clearance']
const TAILS = ['Exact', 'Broad', 'Phrase', 'Views', 'Similar', 'In-Market', 'Top of Search', 'Video', 'Manual', 'Auto', 'Lifestyle', 'Gifting']
const MARKETS: Market[] = ['DE', 'IT', 'FR', 'ES', 'UK']
const PRODUCTS: Product[] = ['SP', 'SP', 'SP', 'SB', 'SD']
const PORTFOLIOS = ['Kitchen', 'Outdoor', 'Wellness', 'Office']
const LONG_SUFFIX = ' | Q4 2026 | EU expansion wave two | do not touch without asking the account owner first'

function makeRows(n: number, seed = 20260905): ParityRow[] {
  const rnd = lcg(seed)
  const rows: ParityRow[] = []
  for (let i = 0; i < n; i++) {
    const product = PRODUCTS[Math.floor(rnd() * PRODUCTS.length)]
    const head = HEADS[Math.floor(rnd() * HEADS.length)]
    const tail = TAILS[Math.floor(rnd() * TAILS.length)]
    const auto = tail === 'Auto' || head === 'Auto Discovery'
    const market = MARKETS[Math.floor(rnd() * MARKETS.length)]
    const statusRoll = rnd()
    const status: Status = statusRoll < 0.62 ? 'ENABLED' : statusRoll < 0.86 ? 'PAUSED' : 'ARCHIVED'
    const budget = [15, 20, 25, 30, 40, 45, 60, 80, 120][Math.floor(rnd() * 9)]
    const impressions = status === 'ARCHIVED' && rnd() < 0.5 ? 0 : Math.floor(rnd() * 250_000)
    const clicks = impressions === 0 ? 0 : Math.floor(impressions * (0.004 + rnd() * 0.016))
    const spend = clicks === 0 ? 0 : Math.round(clicks * (0.18 + rnd() * 0.9) * 100) / 100
    // Every ~9th spending row sells nothing: ACoS is undefined there, not 0.
    const sold = spend > 0 && (i % 9 !== 4)
    const sales = sold ? Math.round(spend * (1.2 + rnd() * 4.5) * 100) / 100 : 0
    const orders = sold ? Math.max(1, Math.floor(clicks * (0.03 + rnd() * 0.08))) : 0
    const name = `${product} | ${head} | ${tail}${i % 17 === 6 ? LONG_SUFFIX : ''}`
    rows.push({
      id: `c${i + 1}`,
      name,
      targeting: auto ? 'A' : 'M',
      product,
      market,
      status,
      budget,
      spend,
      sales,
      acos: sold ? Math.round((spend / sales) * 10000) / 100 : null,
      impressions,
      clicks,
      ctr: impressions === 0 ? null : Math.round((clicks / impressions) * 10000) / 100,
      cpc: clicks === 0 ? null : Math.round((spend / clicks) * 100) / 100,
      orders,
      portfolio: PORTFOLIOS[Math.floor(rnd() * PORTFOLIOS.length)],
    })
  }
  return rows
}

/** 120 rows: paging shows (100/page), and the pager has a second page to land on. */
export const ROWS_120: ParityRow[] = makeRows(120)
/** The Ad Manager's chromeless mode takes rows VERBATIM and the page sorts them (design §7): its 24, Spend ↓. */
export const ROWS_24_BY_SPEND: ParityRow[] = [...makeRows(120).slice(0, 24)].sort((a, b) => b.spend - a.spend)
export const ROWS_50: ParityRow[] = ROWS_120.slice(0, 50)
export const ROWS_36: ParityRow[] = ROWS_120.slice(0, 36)
export const ROWS_24: ParityRow[] = ROWS_120.slice(0, 24)
export const ROWS_12: ParityRow[] = ROWS_120.slice(0, 12)
export const NO_ROWS: ParityRow[] = []

/**
 * The drill-down shape: FLAT rows in tree order, each reporting its depth. Two portfolios open, one
 * closed, and under each open one a computed remainder row ("Other campaigns") that is arithmetic —
 * styled as a note, never selectable.
 */
export const TREE_EXPANDED_INITIAL = new Set<string>(['p-kitchen', 'p-outdoor'])
export const ROWS_TREE: ParityRow[] = (() => {
  const out: ParityRow[] = []
  for (const p of PORTFOLIOS.slice(0, 3)) {
    const kids = ROWS_120.filter((r) => r.portfolio === p).slice(0, 4)
    const sum = (f: (r: ParityRow) => number) => kids.reduce((a, r) => a + f(r), 0)
    const pid = `p-${p.toLowerCase()}`
    out.push({
      ...kids[0], id: pid, name: `${p} portfolio`, depth: 0, expandable: true, portfolio: p,
      budget: sum((r) => r.budget), spend: sum((r) => r.spend), sales: sum((r) => r.sales),
      impressions: sum((r) => r.impressions), clicks: sum((r) => r.clicks), orders: sum((r) => r.orders),
      acos: sum((r) => r.sales) > 0 ? Math.round((sum((r) => r.spend) / sum((r) => r.sales)) * 10000) / 100 : null,
      ctr: null, cpc: null, status: 'ENABLED',
    })
    if (!TREE_EXPANDED_INITIAL.has(pid)) continue
    for (const k of kids) out.push({ ...k, id: `${pid}/${k.id}`, depth: 1, parentId: pid, expandable: false })
    out.push({
      ...kids[0], id: `${pid}/rest`, name: 'Other campaigns', depth: 1, parentId: pid, remainder: true, expandable: false,
      budget: 35, spend: 122.4, sales: 301.2, acos: 40.64, impressions: 30_100, clicks: 288, ctr: 0.96, cpc: 0.43, orders: 9, status: 'ENABLED',
    })
  }
  return out
})()

export const ROW_ID = (r: ParityRow) => r.id
export const FIRST_SORT_VALUE = (r: ParityRow) => r.name
export const SEARCH_VALUE = (r: ParityRow) => `${r.name} ${r.market}`

/* ── formatting ──────────────────────────────────────────────────────────────────────────────── */

export const eur = (n: number) => `€${n.toFixed(2)}`
const pct = (n: number) => `${n.toFixed(2)}%`
/** A blank is an em dash, never "0.00%": the column exists to carry that distinction. */
const pctOrBlank = (n: number | null) => (n === null ? '—' : pct(n))
const eurOrBlank = (n: number | null) => (n === null ? '—' : eur(n))
const int = (n: number) => n.toLocaleString('en-GB')
const sum = (rows: ParityRow[], f: (r: ParityRow) => number) => rows.reduce((a, r) => a + f(r), 0)

/* ── WorkspaceGrid columns — ONE array, both engines ──────────────────────────────────────────── */

const rStatus = (r: ParityRow) => renderStatus(r.status)
const rMarket = (r: ParityRow) => renderMarketPill(r.market)
const rBudget = (r: ParityRow) => eur(r.budget)
const rSpend = (r: ParityRow) => eur(r.spend)
const rSales = (r: ParityRow) => eur(r.sales)
const rAcos = (r: ParityRow) => pctOrBlank(r.acos)
const rImpr = (r: ParityRow) => int(r.impressions)
const rClicks = (r: ParityRow) => int(r.clicks)
const rCtr = (r: ParityRow) => pctOrBlank(r.ctr)
const rCpc = (r: ParityRow) => eurOrBlank(r.cpc)
const rOrders = (r: ParityRow) => int(r.orders)
const rVerbs = (r: ParityRow) => renderVerbs(r)

const tBudget = (rows: ParityRow[]) => eur(sum(rows, (r) => r.budget))
const tSpend = (rows: ParityRow[]) => eur(sum(rows, (r) => r.spend))
const tSales = (rows: ParityRow[]) => eur(sum(rows, (r) => r.sales))
const tImpr = (rows: ParityRow[]) => int(sum(rows, (r) => r.impressions))
const tClicks = (rows: ParityRow[]) => int(sum(rows, (r) => r.clicks))
const tOrders = (rows: ParityRow[]) => int(sum(rows, (r) => r.orders))
const tAcos = (rows: ParityRow[]) => { const s = sum(rows, (r) => r.sales); return s > 0 ? pct((sum(rows, (r) => r.spend) / s) * 100) : '—' }

const sStatus = (r: ParityRow) => r.status
const sMarket = (r: ParityRow) => r.market
const sBudget = (r: ParityRow) => r.budget
const sSpend = (r: ParityRow) => r.spend
const sSales = (r: ParityRow) => r.sales
const sAcos = (r: ParityRow) => r.acos
const sImpr = (r: ParityRow) => r.impressions
const sClicks = (r: ParityRow) => r.clicks
const sCtr = (r: ParityRow) => r.ctr
const sCpc = (r: ParityRow) => r.cpc
const sOrders = (r: ParityRow) => r.orders

const fAcos = (r: ParityRow) => r.acos ?? NaN
const fSpend = (r: ParityRow) => r.spend

/**
 * The console's column anatomy: a left "settings" cell (status), the metric set with tips and
 * totals, a centred market column, a `defaultHidden` CPC, and two right-pinned columns with widths
 * (the decision verbs, and the budget beside them — `fzr0` lands on the leftmost pinned one).
 */
export const WS_COLUMNS: GridColumn<ParityRow>[] = [
  { key: 'status', label: 'Status', align: 'left', sortable: true, render: rStatus, sortValue: sStatus, tip: 'Amazon state of the campaign' },
  { key: 'spend', label: 'Spend', sortable: true, width: 120, render: rSpend, sortValue: sSpend, total: tSpend, filterValue: fSpend, tip: 'Ad spend in the period' },
  { key: 'sales', label: 'Sales', sortable: true, width: 130, render: rSales, sortValue: sSales, total: tSales, tip: 'Attributed sales (7-day)' },
  { key: 'acos', label: 'ACoS', sortable: true, width: 110, render: rAcos, sortValue: sAcos, total: tAcos, filterValue: fAcos, tip: 'Spend ÷ sales. Blank where nothing sold — that is not 0%.' },
  { key: 'impressions', label: 'Impressions', sortable: true, width: 130, render: rImpr, sortValue: sImpr, total: tImpr },
  { key: 'clicks', label: 'Clicks', sortable: true, width: 100, render: rClicks, sortValue: sClicks, total: tClicks },
  { key: 'ctr', label: 'CTR', sortable: true, width: 100, render: rCtr, sortValue: sCtr, tip: 'Clicks ÷ impressions' },
  { key: 'cpc', label: 'CPC', sortable: true, width: 100, render: rCpc, sortValue: sCpc, defaultHidden: true, tip: 'Spend ÷ clicks' },
  { key: 'orders', label: 'PPC Orders', sortable: true, width: 110, render: rOrders, sortValue: sOrders, total: tOrders },
  { key: 'market', label: 'Market', align: 'center', sortable: true, width: 96, render: rMarket, sortValue: sMarket },
  { key: 'budget', label: 'Daily Budget', sortable: true, width: 130, freezeRight: true, render: rBudget, sortValue: sBudget, total: tBudget, tip: 'The daily cap Amazon enforces' },
  { key: 'verbs', label: 'Actions', align: 'center', sortable: false, width: 112, freezeRight: true, render: rVerbs },
]

/** The chromeless scenario's controlled prefs: a subset, in an operator's order, verbs first. */
export const WS_PREFS_SUBSET = ['verbs', 'status', 'spend', 'acos', 'budget', 'orders']

export const WS_FILTERS: GridFilter[] = [
  { key: 'acos', label: 'ACoS', kind: 'range', unit: '%', tip: 'Rows with no ACoS leave the view when a range is set — they were never measured against it.' },
  { key: 'spend', label: 'Spend', kind: 'range', unit: '€' },
  {
    key: 'product', label: 'Type', kind: 'select',
    options: [{ value: 'SP', label: 'Sponsored Products' }, { value: 'SB', label: 'Sponsored Brands' }, { value: 'SD', label: 'Sponsored Display' }],
    value: (r) => (r as ParityRow).product,
  },
  {
    key: 'status', label: 'Status', kind: 'select',
    options: [{ value: 'ENABLED', label: 'Enabled' }, { value: 'PAUSED', label: 'Paused' }, { value: 'ARCHIVED', label: 'Archived' }],
    value: (r) => (r as ParityRow).status,
  },
  {
    key: 'market', label: 'Market', kind: 'multiselect', searchable: true,
    options: MARKETS.map((m) => ({ value: m, label: m })),
    value: (r) => (r as ParityRow).market,
  },
]

/** groupBy with `order`: SP · SB · SD, the console's product order — never alphabetical (SB before SD before SP). */
const PRODUCT_ORDER: Record<Product, number> = { SP: 0, SB: 1, SD: 2 }
const PRODUCT_LABEL: Record<Product, string> = { SP: 'Sponsored Products', SB: 'Sponsored Brands', SD: 'Sponsored Display' }
export const GROUP_BY_PRODUCT = (r: ParityRow) => ({ key: r.product, label: PRODUCT_LABEL[r.product], order: PRODUCT_ORDER[r.product] })

export const ENABLED_FIRST = (r: ParityRow) => r.status

/* ── DataGrid columns — ONE array, both engines ───────────────────────────────────────────────── */

const dName = (r: ParityRow) => renderNameOnly(r)
const dsAcos = (r: ParityRow) => r.acos ?? Number.NEGATIVE_INFINITY

/**
 * The DS DataGrid's shape in the ads console (the eBay wizard, the rule tabs, the change log): a
 * sticky identity column with a width, a status pill, a centred type column with its own class, the
 * figures as `numeric`, a `defaultHidden`-less roster grouped for the Customise dialog, and a
 * right-pinned actions column whose label is empty (so `prefsLabel` names it in the dialog).
 */
export const DG_COLUMNS: Column<ParityRow>[] = [
  { key: 'name', label: 'Campaign', render: dName, sortable: true, sortValue: FIRST_SORT_VALUE, sticky: true, width: 260, group: 'Identity' },
  { key: 'status', label: 'Status', render: rStatus, sortable: true, sortValue: sStatus, group: 'Identity' },
  { key: 'product', label: 'Type', render: (r) => r.product, align: 'center', className: 'lab-col-type', group: 'Identity', prefsLabel: 'Campaign type' },
  { key: 'market', label: 'Market', render: (r) => r.market, align: 'center', group: 'Identity' },
  { key: 'budget', label: 'Daily Budget', render: rBudget, numeric: true, sortable: true, sortValue: sBudget, total: tBudget(ROWS_36), group: 'Figures' },
  { key: 'spend', label: 'Spend', render: rSpend, numeric: true, sortable: true, sortValue: sSpend, total: tSpend(ROWS_36), group: 'Figures' },
  { key: 'sales', label: 'Sales', render: rSales, numeric: true, sortable: true, sortValue: sSales, total: tSales(ROWS_36), group: 'Figures' },
  { key: 'acos', label: 'ACoS', render: rAcos, numeric: true, sortable: true, sortValue: dsAcos, total: tAcos(ROWS_36), group: 'Figures', prefsLocked: true },
  { key: 'impressions', label: 'Impressions', render: rImpr, numeric: true, sortable: true, sortValue: sImpr, total: tImpr(ROWS_36), group: 'Figures' },
  { key: 'clicks', label: 'Clicks', render: rClicks, numeric: true, sortable: true, sortValue: sClicks, total: tClicks(ROWS_36), group: 'Figures' },
  { key: 'orders', label: 'Orders', render: rOrders, numeric: true, sortable: true, sortValue: sOrders, total: tOrders(ROWS_36), group: 'Figures' },
  { key: 'actions', label: '', render: rVerbs, align: 'right', stickyRight: true, width: 112, prefsLabel: 'Actions' },
]

export const DG_PREFS_SORT_FIELDS = [
  { value: 'spend', label: 'Spend' },
  { value: 'sales', label: 'Sales' },
  { value: 'acos', label: 'ACoS' },
] as const

/** Children for `getSubRows`: three ad groups under every campaign, deterministic from the parent. */
const SUB_ROWS = new Map<string, ParityRow[]>()
export const GET_SUB_ROWS = (r: ParityRow): ParityRow[] | undefined => {
  if (r.parentId) return undefined
  let kids = SUB_ROWS.get(r.id)
  if (!kids) {
    kids = [0.5, 0.3, 0.2].map((share, i) => ({
      ...r,
      id: `${r.id}/ag${i + 1}`,
      parentId: r.id,
      name: ['Exact match', 'Phrase match', 'Broad match'][i],
      budget: Math.round(r.budget * share * 100) / 100,
      spend: Math.round(r.spend * share * 100) / 100,
      sales: Math.round(r.sales * share * 100) / 100,
      impressions: Math.round(r.impressions * share),
      clicks: Math.round(r.clicks * share),
      orders: Math.round(r.orders * share),
    }))
    SUB_ROWS.set(r.id, kids)
  }
  return kids
}

export const DG_EXPANDED_INITIAL = new Set<string>(['c1', 'c3'])
export const DG_SELECTED_INITIAL = new Set<string>(['c2', 'c5'])
export const WS_SELECTED_INITIAL = new Set<string>(['c2', 'c5'])

/** The expanded panel: a full-width note under the row — the caller's node, mounted unchanged. */
export const renderExpandedPanel = (r: ParityRow): ReactNode => renderNameOnly(r, true)
