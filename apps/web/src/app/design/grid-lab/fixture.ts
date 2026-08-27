/**
 * AG.2 — the parity fixture. ONE dataset and ONE column list, fed to BOTH engines.
 *
 * WHY A FIXTURE AND NOT REAL DATA
 * The ads console is unverifiable locally: every data region 401s with no CORS, so a local page
 * renders chrome and empty grids. A parity comparison needs both grids to hold the SAME rows at
 * the SAME moment, which a live fetch cannot guarantee even on prod. So the rows are frozen here
 * and the lab needs no API at all.
 *
 * WHY THE NULLS ARE THE POINT
 * `acos` and `ctr` are null on rows that genuinely have no measurement — a campaign that spent
 * nothing has no ACoS, and that is NOT an ACoS of zero. Those rows exist so the lab can show
 * where the blanks land when you sort. AG Grid's default would lead them ascending and trail
 * them descending; `GridColumn.sortValue` is contractually the opposite (KT.3 — a blank sinks
 * BOTH ways). A fixture with no nulls in it would let that regression through silently.
 */
import type { GridColumn } from '@/design-system/patterns/workspace-grid/WorkspaceGrid'

export interface LabRow {
  id: string
  name: string
  kind: 'SP' | 'SB' | 'SD'
  live: boolean
  spend: number
  sales: number
  /** null = never measured. NOT zero. */
  acos: number | null
  impressions: number
  clicks: number
  /** null = no impressions, so a click-through rate does not exist. */
  ctr: number | null
  orders: number
  budget: number
}

const eur = (n: number) => `€${n.toFixed(2)}`
const pct = (n: number) => `${n.toFixed(2)}%`

/**
 * A rounded 0.00% is not a zero. `toFixed` on a null would print "0.00%" and destroy the
 * distinction the column exists to carry, so the blank is rendered as an em dash and the sort
 * value stays null.
 */
const pctOrBlank = (n: number | null) => (n === null ? '—' : pct(n))

export const LAB_ROWS: LabRow[] = [
  { id: 'c1',  name: 'SP | Brand Defense | Exact',        kind: 'SP', live: true,  spend: 412.55, sales: 2104.30, acos: 19.60, impressions: 84210, clicks: 1204, ctr: 1.43, orders: 96, budget: 60 },
  { id: 'c2',  name: 'SP | Category | Broad',             kind: 'SP', live: true,  spend: 988.12, sales: 3410.88, acos: 28.97, impressions: 210433, clicks: 2988, ctr: 1.42, orders: 141, budget: 120 },
  { id: 'c3',  name: 'SB | Headline | Top of Search',     kind: 'SB', live: true,  spend: 220.00, sales: 640.10,  acos: 34.37, impressions: 41022, clicks: 604,  ctr: 1.47, orders: 24, budget: 40 },
  { id: 'c4',  name: 'SD | Retargeting | Views',          kind: 'SD', live: false, spend: 0,      sales: 0,       acos: null,  impressions: 0,     clicks: 0,    ctr: null, orders: 0,  budget: 25 },
  { id: 'c5',  name: 'SP | Competitor ASINs',             kind: 'SP', live: true,  spend: 640.71, sales: 1188.02, acos: 53.93, impressions: 96440, clicks: 1811, ctr: 1.88, orders: 47, budget: 80 },
  { id: 'c6',  name: 'SP | Long Tail | Phrase',           kind: 'SP', live: true,  spend: 74.20,  sales: 512.44,  acos: 14.48, impressions: 18220, clicks: 244,  ctr: 1.34, orders: 22, budget: 20 },
  { id: 'c7',  name: 'SB | Video | Category',             kind: 'SB', live: false, spend: 0,      sales: 0,       acos: null,  impressions: 0,     clicks: 0,    ctr: null, orders: 0,  budget: 35 },
  { id: 'c8',  name: 'SD | Product Targeting | Similar',  kind: 'SD', live: true,  spend: 155.90, sales: 289.77,  acos: 53.80, impressions: 60110, clicks: 402,  ctr: 0.67, orders: 11, budget: 30 },
  { id: 'c9',  name: 'SP | Auto | Discovery',             kind: 'SP', live: true,  spend: 301.44, sales: 1502.10, acos: 20.07, impressions: 72900, clicks: 981,  ctr: 1.35, orders: 63, budget: 45 },
  { id: 'c10', name: 'SP | Seasonal | Exact',             kind: 'SP', live: false, spend: 12.05,  sales: 0,       acos: null,  impressions: 3110,  clicks: 40,   ctr: 1.29, orders: 0,  budget: 15 },
  { id: 'c11', name: 'SB | Store Spotlight',              kind: 'SB', live: true,  spend: 480.33, sales: 2290.14, acos: 20.97, impressions: 130400, clicks: 1502, ctr: 1.15, orders: 88, budget: 70 },
  { id: 'c12', name: 'SD | Audiences | In-Market',        kind: 'SD', live: true,  spend: 96.18,  sales: 144.20,  acos: 66.70, impressions: 44300, clicks: 288,  ctr: 0.65, orders: 6,  budget: 20 },
]

const sum = (rows: LabRow[], f: (r: LabRow) => number) => rows.reduce((a, r) => a + f(r), 0)

/**
 * The shared column list. Both engines receive this exact array — if a cell differs between the
 * two panels, the difference is the ENGINE, because the column definition cannot vary.
 */
export const LAB_COLUMNS: GridColumn<LabRow>[] = [
  {
    key: 'kind',
    label: 'Type',
    align: 'left',
    sortable: true,
    width: 90,
    render: (r) => r.kind,
    sortValue: (r) => r.kind,
  },
  {
    key: 'spend',
    label: 'Spend',
    sortable: true,
    width: 120,
    render: (r) => eur(r.spend),
    sortValue: (r) => r.spend,
    total: (rows) => eur(sum(rows, (r) => r.spend)),
  },
  {
    key: 'sales',
    label: 'Sales',
    sortable: true,
    width: 130,
    render: (r) => eur(r.sales),
    sortValue: (r) => r.sales,
    total: (rows) => eur(sum(rows, (r) => r.sales)),
  },
  {
    key: 'acos',
    label: 'ACoS',
    sortable: true,
    width: 110,
    render: (r) => pctOrBlank(r.acos),
    // Stays null for "never measured" — the blank-sinking case.
    sortValue: (r) => r.acos,
  },
  {
    key: 'impressions',
    label: 'Impressions',
    sortable: true,
    width: 130,
    render: (r) => r.impressions.toLocaleString('en-GB'),
    sortValue: (r) => r.impressions,
    total: (rows) => sum(rows, (r) => r.impressions).toLocaleString('en-GB'),
  },
  {
    key: 'clicks',
    label: 'Clicks',
    sortable: true,
    width: 100,
    render: (r) => r.clicks.toLocaleString('en-GB'),
    sortValue: (r) => r.clicks,
    total: (rows) => sum(rows, (r) => r.clicks).toLocaleString('en-GB'),
  },
  {
    key: 'ctr',
    label: 'CTR',
    sortable: true,
    width: 100,
    render: (r) => pctOrBlank(r.ctr),
    sortValue: (r) => r.ctr,
  },
  {
    key: 'orders',
    label: 'Orders',
    sortable: true,
    width: 100,
    render: (r) => r.orders,
    sortValue: (r) => r.orders,
    total: (rows) => sum(rows, (r) => r.orders),
  },
  {
    key: 'budget',
    label: 'Budget',
    sortable: true,
    width: 110,
    freezeRight: true,
    render: (r) => eur(r.budget),
    sortValue: (r) => r.budget,
    total: (rows) => eur(sum(rows, (r) => r.budget)),
  },
]

export const LAB_ROW_ID = (r: LabRow) => r.id
