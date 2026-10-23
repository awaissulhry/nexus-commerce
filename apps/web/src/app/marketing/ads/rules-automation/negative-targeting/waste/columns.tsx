'use client'

/**
 * Negative Targeting page (2026-10-11, lane NVIEW) — the two tables' columns and cells, each registry naming every
 * column once (the grid, Customise and the tests read it). Cells only show: a click on a row (or Enter on a cell) opens
 * its detail; a link in a cell is a link (the DS path and the owner chip keep their click from the row).
 *
 *   Wasting  ☐ · Term (kind mark, words, match chip) · Where (portfolio › campaign › ad group) · Product · Spend ·
 *            Clicks · Orders · ×CPA · Who · State · the verb      (hidden: Impressions, ACoS, CPC, 90 d, Trend, Stock-out
 *            days, Still serves in)
 *   Stopped  ☐ · Term · Where · Product · Kept by · Since · Spend before · State · the verb  (hidden: Still serves in)
 *   Phone    Term (its path as line 2) · Spend · State — a tap opens the full-screen sheet (6-neg-design.md §7).
 *
 * Money is in the row's own currency; a money key the server left out (no ad-spend permission) reads as a dash. The
 * columns are built once per phone flag (useMemo), their handlers read through AG's `context` ref.
 */
import { memo } from 'react'
import { EntityPath, Sparkline, entityPathText } from '@/design-system/components'
import { Tooltip } from '@/design-system/primitives'
import { useTooltipsDisabled } from '@/design-system/primitives/Tooltip'
import type { EntityLinkComponent } from '@/design-system/components'
import {
  actionsColumn, entityLinksKeys, integerColumn, keepFromGrid, type ColDef, type ICellRendererParams, type RowVerb,
} from '@/design-system/grid'
import Link from '@/lib/workspaces/Link'
import { dayWords, money } from '../../bid/_shared/format'
import { OwnerChip } from '../../_shared/OwnerChip'
import { ProductCell } from '../../_shared/ProductCell'
import { ClashMark, KindMark, MatchChip, SkippedMark, StateMark, WaitingMark } from './marks'
import { ownerKeys, placeKeys, sinceKeys, verbKeys } from './cellKeys'
import {
  acosText, chipOwner, moneyOr, pathOf, plural, productWords, sinceView, stateWord, stoppedVerb, wasteVerb, xCpaText, type RowVerbView,
} from './wasteModel'
import type { Ref, StoppedRow, WasteRow } from './wasteTypes'
import styles from '../negatives.module.css'

const WorkspaceLink = Link as unknown as EntityLinkComponent

export type WasteGridRow = WasteRow & { path: Array<Ref | null> }
export type StoppedGridRow = StoppedRow & { path: Array<Ref | null> }
export const wasteGridRow = (r: WasteRow): WasteGridRow => ({ ...r, path: pathOf(r) })
export const stoppedGridRow = (r: StoppedRow): StoppedGridRow => ({ ...r, path: pathOf(r) })

/** What the cells ask the view (AG's `context`: a ref that never changes identity). */
export interface CellHandlers {
  verb(rowId: string, verb: RowVerbView): void
  /** A rule's chip opens the rule on this page (the Rules view). */
  ruleHref(ruleId: string): string
}
export interface CellContext { readonly current: CellHandlers }
type Cell<R> = ICellRendererParams<R> & { context?: CellContext }

/** The term: our keyword (Crosshair) or a shopper's search term (TextSearch), its words, its match chip; on a phone
 *  its path is line 2 (cut from the front, the ad group stays readable). */
function TermView({ row, phone }: { row: WasteGridRow | StoppedGridRow; phone?: boolean }) {
  return (
    <span className={styles.term}>
      <span className={styles.termLine}>
        <KindMark kind={row.kind} match={row.match} />
        <span className={phone ? styles.termWrap : styles.termText} title={row.text}>{row.text}</span>
        {row.kind !== 'TERM' || row.id.startsWith('neg:') ? <MatchChip match={row.match} /> : null}
      </span>
      {phone && (
        // The leaf only (its ad group, else its campaign): the one name that tells two rows apart; the record has the path.
        <span className={styles.termSub} onClickCapture={keepFromGrid} title={entityPathText(row.path)}>
          <EntityPath items={[row.adGroup ?? row.campaign]} linkAs={WorkspaceLink} label="Ad group" />
        </span>
      )}
    </span>
  )
}
const TermCell = memo(function TermCell({ data }: Cell<WasteGridRow | StoppedGridRow>) { return data ? <TermView row={data} /> : null })
const PhoneTermCell = memo(function PhoneTermCell({ data }: Cell<WasteGridRow | StoppedGridRow>) { return data ? <TermView row={data} phone /> : null })

/**
 * Where (audit M7): the campaign on line 1 and the ad group on line 2, each with the column's whole width, so both read
 * at 1440 px; the portfolio and the whole path are on hover and in the accessible name. A campaign-wide negative says
 * "Whole campaign" on line 2. Enter follows the campaign, ⇧ Enter the ad group (`placeKeys`).
 */
const WhereCell = memo(function WhereCell({ data }: Cell<WasteGridRow | StoppedGridRow>) {
  if (!data) return null
  const full = entityPathText(data.path)
  const campaignWide = 'level' in data && data.level === 'CAMPAIGN'
  return (
    <span className={styles.where} title={full} aria-label={`Where: ${full}${campaignWide ? ', whole campaign' : ''}`} role="group" onClickCapture={keepFromGrid}>
      <span className={styles.whereLine}><EntityPath items={[data.campaign]} linkAs={WorkspaceLink} label="Campaign" /></span>
      <span className={styles.whereSub}>
        {campaignWide || !data.adGroup ? <span className="nds-cell-muted">Whole campaign</span> : <EntityPath items={[data.adGroup]} linkAs={WorkspaceLink} label="Ad group" />}
      </span>
    </span>
  )
})

/** The product: its link, or "2 products" on a shared campaign (its campaign holds them; hover says so). */
const ProductRenderer = memo(function ProductRenderer({ data }: Cell<WasteGridRow | StoppedGridRow>) {
  if (!data) return null
  return <ProductCell product={data.product} count={'productCount' in data ? data.productCount : 0} />
})

const SpendCell = memo(function SpendCell({ data }: Cell<WasteGridRow>) {
  if (!data) return null
  return <span title={data.stockOutDays ? `${plural(data.stockOutDays, 'day')} out of stock left out` : undefined}>{moneyOr(data.d?.spendCents, data.currency)}</span>
})

const XCpaCell = memo(function XCpaCell({ data }: Cell<WasteGridRow>) {
  if (!data) return null
  const x = data.d?.xCpa
  const bar = data.test.xCpaBar
  const title = typeof x === 'number' ? `Spend ${xCpaText(x)} the target cost per order${bar ? ` · the bar is ${xCpaText(bar)}` : ''}` : 'No target cost per order'
  // Red only for a row that wastes (its test is met): a seller is never painted as waste (audit N5).
  return <span className={typeof x === 'number' && bar != null && x >= bar && data.test.met ? styles.over : 'nds-cell-muted'} title={title}>{xCpaText(x)}</span>
})

const OwnerCell = memo(function OwnerCell({ data, context }: Cell<WasteGridRow | StoppedGridRow>) {
  if (!data) return null
  const o = chipOwner(data.owner)
  return (
    <span className={styles.cellFill} onClickCapture={keepFromGrid}>
      <OwnerChip kind={o.kind} label={o.label} hint={o.hint} locked={o.locked} href={o.ruleId ? context?.current.ruleHref(o.ruleId) : null} />
    </span>
  )
})

const WasteStateCell = memo(function WasteStateCell({ data }: Cell<WasteGridRow>) {
  if (!data) return null
  return (
    <span className={styles.marks}>
      <StateMark row={data} />
      {data.clash && <ClashMark clash={data.clash} />}
      {data.waiting && <WaitingMark waiting={data.waiting} />}
      {data.skipped && <SkippedMark skipped={data.skipped} />}
    </span>
  )
})

const StoppedStateCell = memo(function StoppedStateCell({ data }: Cell<StoppedGridRow>) {
  if (!data) return null
  return <span className={styles.marks}><StateMark row={data} /></span>
})

/**
 * NFIX — the day it was added (or kept), "—" when no record says; how it is known, or why not, in the DS tooltip on hover
 * and on keyboard focus (Enter on the cell focuses the day: `sinceKeys`), and for a screen reader in the cell's words.
 */
const SinceCell = memo(function SinceCell({ data }: Cell<StoppedGridRow>) {
  const quiet = useTooltipsDisabled()
  if (!data) return null
  const v = sinceView(data)
  if (!v.hint) return <span>{v.text}</span>
  const day = (
    <span data-since-day="" tabIndex={-1} title={quiet ? v.hint : undefined}>
      {v.text}<span className="nds-vh">{data.since ? '. ' : ': not known. '}{v.hint}</span>
    </span>
  )
  return quiet ? day : <Tooltip label={v.hint} portal>{day}</Tooltip>
})

const SpendBeforeCell = memo(function SpendBeforeCell({ data }: Cell<StoppedGridRow>) {
  if (!data) return null
  return <span title="Spend in the 30 days before it stopped">{moneyOr(data.spendBeforeCents, data.currency)}</span>
})

const TrendCell = memo(function TrendCell({ data }: Cell<WasteGridRow>) {
  if (!data) return null
  return (
    <span className="nds-cell-spark">
      <Sparkline values={data.spark ?? []} label="Spend per week, 8 weeks" format={(n) => money(n, data.currency)} width={72} />
    </span>
  )
})

/** The row's one verb as the DS row button (held with the server's reason when it may not run). */
const verbOf = (v: RowVerbView | null): readonly [RowVerb<WasteGridRow | StoppedGridRow>] | readonly [] => (v ? [{
  id: v.action,
  label: v.short,
  // The blue fill only for a row that wastes (its test is met): every other row's verb is the quiet button (audit S3).
  tone: v.primary ? 'primary' : 'default',
  ariaLabel: () => v.sentence,
  disabled: () => v.held,
}] as const : [])

/** Numbers sort the highest first on the first click (the waste is at the top). */
const DESC_FIRST = { sortingOrder: ['desc', 'asc', null] as Array<'desc' | 'asc' | null> }
const numeric = { type: 'rightAligned', headerClass: 'nds-ag-head-num', ...DESC_FIRST } as const
/** No ⋮ menu on the headers (as the Bid page's Bids view): the toolbar's Customise holds the columns; the names keep
 *  their room. */
const H = { suppressHeaderMenuButton: true } as const
const num = ['nds-ag-cell', 'nds-ag-num']
const moneyOf = (p: { value: unknown; data?: { currency: string } }) => moneyOr(p.value as number | null, p.data?.currency ?? 'EUR')

export type ColumnSpec = { key: string; label: string; locked?: boolean; hidden?: boolean }

export const WASTE_COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { key: 'term', label: 'Term', locked: true },
  { key: 'where', label: 'Where' },
  { key: 'product', label: 'Product' },
  { key: 'spend', label: 'Spend' },
  { key: 'clicks', label: 'Clicks' },
  { key: 'orders', label: 'Orders' },
  { key: 'xCpa', label: '×CPA' },
  { key: 'owner', label: 'Who' },
  { key: 'state', label: 'State' },
  { key: 'impressions', label: 'Impressions', hidden: true },
  { key: 'acos', label: 'ACoS', hidden: true },
  { key: 'cpc', label: 'CPC', hidden: true },
  { key: 'spend90', label: 'Spend 90 d', hidden: true },
  { key: 'trend', label: 'Trend', hidden: true },
  { key: 'stockOut', label: 'Out of stock', hidden: true },
  { key: 'stillServes', label: 'Still serves in', hidden: true },
]

export const STOPPED_COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { key: 'term', label: 'Term', locked: true },
  { key: 'where', label: 'Where' },
  { key: 'product', label: 'Product' },
  { key: 'owner', label: 'Kept by' },
  { key: 'since', label: 'Since' },
  { key: 'spendBefore', label: 'Spend before' },
  { key: 'state', label: 'State' },
  { key: 'stillServes', label: 'Still serves in', hidden: true },
]

const LABEL = (specs: ReadonlyArray<ColumnSpec>) => Object.fromEntries(specs.map((c) => [c.key, c.label])) as Record<string, string>
const hide = (specs: ReadonlyArray<ColumnSpec>, cols: ColDef[]) => {
  const hidden = new Set(specs.filter((c) => c.hidden).map((c) => c.key))
  return cols.map((c) => (hidden.has(c.colId as string) ? { ...c, hide: true } : c))
}
/** The server orders the Wasting view: a header's sort is sent as `?sort=`; the grid never re-sorts a page. */
const serverSort = { comparator: () => 0 }

export function wasteColumns(phone: boolean): ColDef<WasteGridRow>[] {
  const L = LABEL(WASTE_COLUMN_SPECS)
  if (phone) {
    const phoneCols: ColDef<WasteGridRow>[] = [
      { colId: 'term', headerName: L.term, valueGetter: (p) => p.data?.text ?? '', cellRenderer: PhoneTermCell, flex: 1, minWidth: 120, cellClass: 'nds-ag-cell', sortable: false, autoHeight: false },
      { colId: 'spend', headerName: L.spend, valueGetter: (p) => p.data?.d?.spendCents ?? null, valueFormatter: moneyOf, cellRenderer: SpendCell, width: 70, cellClass: num, ...numeric, sortable: false },
      { colId: 'state', headerName: '', valueGetter: (p) => (p.data ? stateWord(p.data.state) : ''), cellRenderer: WasteStateCell, width: 46, cellClass: 'nds-ag-cell', sortable: false, headerTooltip: 'State' },
    ]
    return phoneCols.map((c) => ({ ...c, ...H }))
  }
  const cols: ColDef<WasteGridRow>[] = [
    { colId: 'term', headerName: L.term, valueGetter: (p) => p.data?.text ?? '', cellRenderer: TermCell, pinned: 'left', width: 220, cellClass: 'nds-ag-cell', ...serverSort },
    { colId: 'where', headerName: L.where, valueGetter: (p) => (p.data ? entityPathText(p.data.path) : ''), cellRenderer: WhereCell, flex: 1, minWidth: 240, cellClass: 'nds-ag-cell', suppressKeyboardEvent: placeKeys as ColDef<WasteGridRow>['suppressKeyboardEvent'], ...serverSort, headerTooltip: 'Campaign, then its ad group; the portfolio on hover. Enter: the campaign · Shift+Enter: the ad group' },
    { colId: 'product', headerName: L.product, valueGetter: (p) => (p.data ? productWords(p.data) : ''), cellRenderer: ProductRenderer, suppressKeyboardEvent: entityLinksKeys as ColDef<WasteGridRow>['suppressKeyboardEvent'], width: 124, cellClass: 'nds-ag-cell', ...serverSort },
    { colId: 'spend', headerName: L.spend, valueGetter: (p) => p.data?.d?.spendCents ?? null, valueFormatter: moneyOf, cellRenderer: SpendCell, width: 92, cellClass: num, ...numeric, ...serverSort, headerTooltip: 'Spend in the window, out-of-stock days left out' },
    { ...integerColumn<WasteGridRow>('d.clicks'), colId: 'clicks', headerName: L.clicks, width: 74, ...DESC_FIRST, ...serverSort },
    { ...integerColumn<WasteGridRow>('d.orders'), colId: 'orders', headerName: L.orders, width: 78, ...DESC_FIRST, ...serverSort, headerTooltip: 'Orders up to today: a late order can only save a row' },
    { colId: 'xCpa', headerName: L.xCpa, valueGetter: (p) => p.data?.d?.xCpa ?? null, valueFormatter: (p) => xCpaText(p.value as number | null), cellRenderer: XCpaCell, width: 72, cellClass: num, ...numeric, ...serverSort, headerTooltip: 'Spend ÷ the product\'s target cost per order' },
    { colId: 'owner', headerName: L.owner, valueGetter: (p) => (p.data ? chipOwner(p.data.owner).hint : ''), cellRenderer: OwnerCell, width: 104, cellClass: 'nds-ag-cell', suppressKeyboardEvent: ownerKeys as ColDef<WasteGridRow>['suppressKeyboardEvent'], ...serverSort },
    { colId: 'state', headerName: L.state, valueGetter: (p) => (p.data ? stateWord(p.data.state) : ''), cellRenderer: WasteStateCell, width: 76, cellClass: 'nds-ag-cell', ...serverSort },
    { ...integerColumn<WasteGridRow>('d.impressions'), colId: 'impressions', headerName: L.impressions, width: 116, sortable: false },
    { colId: 'acos', headerName: L.acos, valueGetter: (p) => p.data?.d?.acosPct ?? null, valueFormatter: (p) => acosText(p.value as number | null), width: 92, cellClass: num, ...numeric, sortable: false },
    { colId: 'cpc', headerName: L.cpc, valueGetter: (p) => p.data?.d?.cpcCents ?? null, valueFormatter: moneyOf, width: 88, cellClass: num, ...numeric, sortable: false },
    { colId: 'spend90', headerName: L.spend90, valueGetter: (p) => p.data?.d90?.spendCents ?? null, valueFormatter: moneyOf, width: 112, cellClass: num, ...numeric, sortable: false },
    { colId: 'trend', headerName: L.trend, valueGetter: (p) => p.data?.spark ?? null, cellRenderer: TrendCell, width: 104, cellClass: 'nds-ag-cell', sortable: false, getQuickFilterText: () => '', valueFormatter: () => '' },
    { ...integerColumn<WasteGridRow>('stockOutDays'), colId: 'stockOut', headerName: L.stockOut, width: 120, sortable: false, headerTooltip: 'Days left out: the product was out of stock' },
    { ...integerColumn<WasteGridRow>('stillServesIn'), colId: 'stillServes', headerName: L.stillServes, width: 128, sortable: false, headerTooltip: 'Other ad groups where these words still spend' },
    actionsColumn<WasteGridRow>({
      primary: (row) => verbOf(wasteVerb(row)) as never,
      prefsLabel: 'Action',
    }),
  ]
  return hide(WASTE_COLUMN_SPECS, cols.map((c) => ({ ...c, ...H })) as ColDef[]) as ColDef<WasteGridRow>[]
}

/** The verb button's click goes through the context (the column objects never change). */
export function withVerbHandler<R extends WasteGridRow | StoppedGridRow>(cols: ColDef<R>[], handlers: CellContext, kind: 'waste' | 'stopped'): ColDef<R>[] {
  return cols.map((c) => {
    if (c.colId !== 'actions') return c
    const params = (c.cellRendererParams ?? {}) as Record<string, unknown>
    return {
      ...c,
      suppressKeyboardEvent: verbKeys as ColDef<R>['suppressKeyboardEvent'],
      cellRendererParams: {
        ...params,
        primary: (row: R) => {
          const v = kind === 'waste' ? wasteVerb(row as WasteGridRow) : stoppedVerb(row as StoppedGridRow)
          if (!v) return []
          return [{ ...verbOf(v)[0]!, onClick: (d: R) => handlers.current.verb(d.id, v) }]
        },
        // The row's second action in its ⋯ (a wasting keyword with a negative over it: Remove negative…).
        items: (row: R) => {
          const v = kind === 'waste' ? wasteVerb(row as WasteGridRow) : null
          const second = v?.second
          if (!second) return []
          return [{ id: second.action, label: second.label, title: second.sentence, disabled: !!second.held, description: second.held ?? undefined, onSelect: () => handlers.current.verb(row.id, second) }]
        },
        menuLabel: (row: R) => `More for ${row.text}`,
      },
    }
  })
}

export function stoppedColumns(phone: boolean): ColDef<StoppedGridRow>[] {
  const L = LABEL(STOPPED_COLUMN_SPECS)
  if (phone) {
    const phoneCols: ColDef<StoppedGridRow>[] = [
      { colId: 'term', headerName: L.term, valueGetter: (p) => p.data?.text ?? '', cellRenderer: PhoneTermCell, flex: 1, minWidth: 120, cellClass: 'nds-ag-cell' },
      { colId: 'since', headerName: L.since, valueGetter: (p) => p.data?.since ?? null, cellRenderer: SinceCell, width: 72, cellClass: 'nds-ag-cell', suppressKeyboardEvent: sinceKeys as ColDef<StoppedGridRow>['suppressKeyboardEvent'] },
      { colId: 'state', headerName: '', valueGetter: (p) => (p.data ? stateWord(p.data.state) : ''), cellRenderer: StoppedStateCell, width: 52, cellClass: 'nds-ag-cell', headerTooltip: 'State' },
    ]
    return phoneCols.map((c) => ({ ...c, ...H }))
  }
  const cols: ColDef<StoppedGridRow>[] = [
    { colId: 'term', headerName: L.term, valueGetter: (p) => p.data?.text ?? '', cellRenderer: TermCell, pinned: 'left', width: 220, cellClass: 'nds-ag-cell' },
    { colId: 'where', headerName: L.where, valueGetter: (p) => (p.data ? entityPathText(p.data.path) : ''), cellRenderer: WhereCell, flex: 1, minWidth: 240, cellClass: 'nds-ag-cell', suppressKeyboardEvent: placeKeys as ColDef<StoppedGridRow>['suppressKeyboardEvent'], headerTooltip: 'Campaign, then its ad group (or the whole campaign); the portfolio on hover. Enter: the campaign · Shift+Enter: the ad group' },
    { colId: 'product', headerName: L.product, valueGetter: (p) => (p.data ? productWords(p.data) : ''), cellRenderer: ProductRenderer, suppressKeyboardEvent: entityLinksKeys as ColDef<StoppedGridRow>['suppressKeyboardEvent'], width: 132, cellClass: 'nds-ag-cell' },
    { colId: 'owner', headerName: L.owner, valueGetter: (p) => (p.data ? chipOwner(p.data.owner).hint : ''), cellRenderer: OwnerCell, width: 116, cellClass: 'nds-ag-cell', suppressKeyboardEvent: ownerKeys as ColDef<StoppedGridRow>['suppressKeyboardEvent'] },
    { colId: 'since', headerName: L.since, valueGetter: (p) => p.data?.since ?? null, cellRenderer: SinceCell, width: 92, cellClass: 'nds-ag-cell', valueFormatter: (p) => dayWords(p.value as string | null), suppressKeyboardEvent: sinceKeys as ColDef<StoppedGridRow>['suppressKeyboardEvent'], headerTooltip: 'When it was added or paused, from the record that says so. Enter: how it is known' },
    { colId: 'spendBefore', headerName: L.spendBefore, valueGetter: (p) => p.data?.spendBeforeCents ?? null, valueFormatter: moneyOf, cellRenderer: SpendBeforeCell, width: 124, cellClass: num, ...numeric, headerTooltip: 'Spend in the 30 days before it stopped' },
    { colId: 'state', headerName: L.state, valueGetter: (p) => (p.data ? stateWord(p.data.state) : ''), cellRenderer: StoppedStateCell, width: 80, cellClass: 'nds-ag-cell' },
    { ...integerColumn<StoppedGridRow>('stillServesIn'), colId: 'stillServes', headerName: L.stillServes, width: 128, headerTooltip: 'Other ad groups where these words still spend' },
    actionsColumn<StoppedGridRow>({ primary: (row) => verbOf(stoppedVerb(row)) as never, prefsLabel: 'Action' }),
  ]
  return hide(STOPPED_COLUMN_SPECS, cols.map((c) => ({ ...c, ...H })) as ColDef[]) as ColDef<StoppedGridRow>[]
}
