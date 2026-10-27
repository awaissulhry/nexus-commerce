'use client'

/**
 * Negative Targeting page (2026-10-11, lane NVIEW) — the two tables' columns and cells, each registry naming every
 * column once (the grid, Customise and the tests read it). Cells only show: a click on a row (or Enter on a cell) opens
 * its detail; a link in a cell is a link (the DS path and the owner chip keep their click from the row).
 *
 *   Wasting  ☐ · Term (kind mark, words, match chip) · Where (portfolio › campaign › ad group) · Product · Spend ·
 *            Clicks · Orders · ×CPA · Who · State · the verb      (hidden: Impressions, ACoS, CPC, 90 d, Trend, Stock-out
 *            days, Still serves in)
 *   Stopped  ☐ · Term · Where · Product · Kept by · Since · Spend before · Saved · State · the verb  (hidden: Still serves
 *            in). Saved (step 4, "Did it work?"): the money saved since the stop, "Too early" for the first 14 days.
 *   Phone    the same columns, scrolling sideways in the card (the redesign, D16): Term first (150 px, two lines), no
 *            ticks, the verb last; a tap opens the full-screen sheet.
 *   Step 4   a protected row's Term cell holds the protected term as line 2 (a chip; its panel: match, scope, why, Open
 *            record) — Shift+Enter on the cell opens it; on the phone the State chip names it and the sheet shows it.
 *
 * The redesign (2026-10-26, BRIEF D6, D12, D13): two-line rows; the State is ONE chip with a word (wasteModel.ts
 * stateChip) and a smaller line under it for a clash or a skip; Who / Kept by is a pill, nobody a plain "—"; one
 * secondary verb per row (a waiting row: Approve · Reject, each through its review) and the ⋯ (Skip 7 d · 30 d · Open
 * record; a Stopped row: the record footer's other verbs · Open record).
 *
 * Money is in the row's own currency; a money key the server left out (no ad-spend permission) reads as a dash. The
 * columns are built once per phone flag (useMemo), their handlers read through AG's `context` ref.
 */
import { memo } from 'react'
import { EntityPath, Sparkline, entityPathText, type MenuItemDef } from '@/design-system/components'
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
import { KindMark, MatchChip, StateChip, StateSub } from './marks'
import { ownerKeys, placeKeys, sinceKeys, verbKeys } from './cellKeys'
import { ProtectionChip } from './protection'
import { followUpSentence, keptProtectedWords, termKeys } from './protectionModel'
import {
  acosText, chipOwner, decideAria, moneyOr, pathOf, plural, productWords, SAVED_WORDS, savedView, sinceView, SPEND_BEFORE_WORDS, stateChip, stateSub,
  stoppedRowMenu, stoppedVerb, wasteRowMenu, wasteVerb, xCpaText, type RowMenuEntry, type RowMenuVerb, type RowVerbView,
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
  /** Why every verb is held for this person (wasteModel.ts writeHeld), or null. */
  noWrite: string | null
  /** D12 — a waiting row's Approve / Reject: the ask's own review (useWasteReview `decide`). */
  decide?(rowId: string, decide: 'approve' | 'reject'): void
  /** A ⋯ entry (wasteModel.ts wasteRowMenu / stoppedRowMenu). */
  menu?(rowId: string, entry: RowMenuVerb): void
  /** Open the row's record (the protected-term panel's Open record). */
  open?(rowId: string): void
}
export interface CellContext { readonly current: CellHandlers }
type Cell<R> = ICellRendererParams<R> & { context?: CellContext }

/** The term: our keyword (Crosshair) or a shopper's search term (TextSearch), its words, its match chip; on a phone
 *  its path is line 2 (cut from the front, the ad group stays readable). */
function TermView({ row, phone, cell, onOpen }: { row: WasteGridRow | StoppedGridRow; phone?: boolean; cell?: HTMLElement | null; onOpen?: () => void }) {
  const protection = !phone && 'protection' in row && row.state === 'PROTECTED' ? row.protection : undefined
  return (
    <span className={styles.term}>
      <span className={styles.termLine}>
        <KindMark kind={row.kind} match={row.match} />
        {/* Phone: the term wraps to two lines in its 150 px (never "trail boot…" on every row); the Where column follows. */}
        <span className={phone ? styles.termWrap : styles.termText} title={row.text}>{row.text}</span>
        {row.kind !== 'TERM' || row.id.startsWith('neg:') ? <MatchChip match={row.match} /> : null}
      </span>
      {/* Step 4 — which protected term keeps it safe; its panel says the match, the scope and why, and opens the record. */}
      {protection && protection.terms.length > 0 && (
        <span className={styles.termLine} onClickCapture={keepFromGrid}>
          <ProtectionChip protection={protection} returnFocus={() => cell?.focus()} onOpenRecord={onOpen} recordLabel={`Open the record of ${row.text}`} />
        </span>
      )}
    </span>
  )
}
const TermCell = memo(function TermCell({ data, eGridCell, context }: Cell<WasteGridRow | StoppedGridRow>) {
  if (!data) return null
  const open = context?.current.open
  return <TermView row={data} cell={eGridCell} onOpen={open ? () => open(data.id) : undefined} />
})
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
  // D6 — nobody is a plain dash, never an empty pill; who it is (or "Nobody") on hover.
  if (o.kind === 'NONE') return <span className="nds-cell-muted" title={o.hint}>—</span>
  return (
    <span className={styles.cellFill} onClickCapture={keepFromGrid}>
      <OwnerChip kind={o.kind} label={o.label} hint={o.hint} locked={o.locked} href={o.ruleId ? context?.current.ruleHref(o.ruleId) : null} />
    </span>
  )
})

/** D6 — the state as one chip (a word in a tone, its mark), and under it a clash, a follow-up or a skip. */
const WasteStateCell = memo(function WasteStateCell({ data }: Cell<WasteGridRow>) {
  if (!data) return null
  const sub = stateSub(data, { followUp: data.followUp ? followUpSentence(data.followUp) : null, keptProtected: keptProtectedWords(data) })
  return (
    <span className={styles.stateCell}>
      <StateChip chip={stateChip(data)} />
      {sub && <StateSub sub={sub} />}
    </span>
  )
})

const StoppedStateCell = memo(function StoppedStateCell({ data }: Cell<StoppedGridRow>) {
  if (!data) return null
  return <span className={styles.stateCell}><StateChip chip={stateChip(data)} /></span>
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
  return <span title={SPEND_BEFORE_WORDS}>{moneyOr(data.spendBeforeCents, data.currency)}</span>
})

/** Step 4 — "Did it work?": the money saved since the stop (green; amber while its words still spend elsewhere), "Too
 *  early" for the first 14 days, "—" when not known; why, on hover and in the cell's words for a screen reader (D13). */
const SavedCell = memo(function SavedCell({ data }: Cell<StoppedGridRow>) {
  if (!data) return null
  const v = savedView(data)
  return <span className={`${styles[`tone_${v.tone}`]} ${v.tone === 'muted' ? '' : styles.strong}`} title={v.hint}>{v.text}<span className="nds-vh">. {v.hint}</span></span>
})

const TrendCell = memo(function TrendCell({ data }: Cell<WasteGridRow>) {
  if (!data) return null
  return (
    <span className="nds-cell-spark">
      <Sparkline values={data.spark ?? []} label="Spend per week, 8 weeks" format={(n) => money(n, data.currency)} width={72} />
    </span>
  )
})

/** The row's one verb as the DS row button (held with the server's reason when it may not run). D6: every row button is
 *  secondary — the one blue button of a flow is in its review (`primary` stays the model's word for a row that wastes). */
const verbOf = (v: RowVerbView | null): readonly [RowVerb<WasteGridRow | StoppedGridRow>] | readonly [] => (v ? [{
  id: v.action,
  label: v.short,
  tone: 'default',
  ariaLabel: () => v.sentence,
  disabled: () => v.held,
}] as const : [])

/** A row's ⋯ entries as DS menu items: a held one stays in the list and says why (its second line). */
function menuItemsOf(entries: readonly RowMenuEntry[], rowId: string, handlers: CellContext): MenuItemDef[] {
  return entries.map((e): MenuItemDef => {
    if ('heading' in e) return { id: e.id, heading: true, label: e.heading }
    if ('separator' in e) return { id: e.id, separator: true }
    return {
      id: e.id, label: e.label, ...(e.title ? { title: e.title } : {}),
      ...(e.held ? { disabled: true, description: e.held } : { onSelect: () => handlers.current.menu?.(rowId, e) }),
    }
  })
}

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
  { key: 'saved', label: 'Saved' },
  { key: 'state', label: 'State' },
  { key: 'stillServes', label: 'Still serves in', hidden: true },
]

const LABEL = (specs: ReadonlyArray<ColumnSpec>) => Object.fromEntries(specs.map((c) => [c.key, c.label])) as Record<string, string>
const hide = (specs: ReadonlyArray<ColumnSpec>, cols: ColDef[]) => {
  const hidden = new Set(specs.filter((c) => c.hidden).map((c) => c.key))
  return cols.map((c) => (hidden.has(c.colId as string) ? { ...c, hide: true } : c))
}
/** The server orders the Wasting and Stopped views: a header's sort is sent as `?sort=`; the grid never re-sorts a page. */
const serverSort = { comparator: () => 0 }

/**
 * The Wasting table (the board's widths: Term 220 · Where ≥ 186 · Product 116 · Spend 92 · Clicks 74 · Orders 78 · ×CPA
 * 72 · Who 104 · State 156 · the verb fits its buttons). Phone (D16): the same columns, Term 150 and two lines, Where
 * 200, the verb last and unpinned; the card scrolls them sideways.
 */
export function wasteColumns(phone: boolean): ColDef<WasteGridRow>[] {
  const L = LABEL(WASTE_COLUMN_SPECS)
  const cols: ColDef<WasteGridRow>[] = [
    phone
      ? { colId: 'term', headerName: L.term, valueGetter: (p) => p.data?.text ?? '', cellRenderer: PhoneTermCell, pinned: 'left', width: 150, cellClass: 'nds-ag-cell', ...serverSort }
      : { colId: 'term', headerName: L.term, valueGetter: (p) => p.data?.text ?? '', cellRenderer: TermCell, pinned: 'left', width: 220, cellClass: 'nds-ag-cell', suppressKeyboardEvent: termKeys as ColDef<WasteGridRow>['suppressKeyboardEvent'], ...serverSort, headerTooltip: 'Enter: the row · Shift+Enter: the protected term that keeps it safe' },
    { colId: 'where', headerName: L.where, valueGetter: (p) => (p.data ? entityPathText(p.data.path) : ''), cellRenderer: WhereCell, ...(phone ? { width: 200 } : { flex: 1, minWidth: 186 }), cellClass: 'nds-ag-cell nds-ag-cell-clip', suppressKeyboardEvent: placeKeys as ColDef<WasteGridRow>['suppressKeyboardEvent'], ...serverSort, headerTooltip: 'Campaign, then its ad group; the portfolio on hover. Enter: the campaign · Shift+Enter: the ad group' },
    { colId: 'product', headerName: L.product, valueGetter: (p) => (p.data ? productWords(p.data) : ''), cellRenderer: ProductRenderer, suppressKeyboardEvent: entityLinksKeys as ColDef<WasteGridRow>['suppressKeyboardEvent'], width: 116, cellClass: 'nds-ag-cell', ...serverSort },
    { colId: 'spend', headerName: L.spend, valueGetter: (p) => p.data?.d?.spendCents ?? null, valueFormatter: moneyOf, cellRenderer: SpendCell, width: 92, cellClass: num, ...numeric, ...serverSort, headerTooltip: 'Spend in the window, out-of-stock days left out' },
    { ...integerColumn<WasteGridRow>('d.clicks'), colId: 'clicks', headerName: L.clicks, width: 74, ...DESC_FIRST, ...serverSort },
    { ...integerColumn<WasteGridRow>('d.orders'), colId: 'orders', headerName: L.orders, width: 78, ...DESC_FIRST, ...serverSort, headerTooltip: 'Orders up to today: a late order can only save a row' },
    { colId: 'xCpa', headerName: L.xCpa, valueGetter: (p) => p.data?.d?.xCpa ?? null, valueFormatter: (p) => xCpaText(p.value as number | null), cellRenderer: XCpaCell, width: 72, cellClass: num, ...numeric, ...serverSort, headerTooltip: 'Spend ÷ the product\'s target cost per order' },
    { colId: 'owner', headerName: L.owner, valueGetter: (p) => (p.data ? chipOwner(p.data.owner).hint : ''), cellRenderer: OwnerCell, width: 104, cellClass: 'nds-ag-cell', suppressKeyboardEvent: ownerKeys as ColDef<WasteGridRow>['suppressKeyboardEvent'], ...serverSort },
    { colId: 'state', headerName: L.state, valueGetter: (p) => (p.data ? stateChip(p.data).word : ''), cellRenderer: WasteStateCell, width: 156, minWidth: 130, cellClass: 'nds-ag-cell', ...serverSort },
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
      // A phone keeps the verb as the last column (two pinned columns leave no room).
      pinned: !phone,
    }),
  ]
  return hide(WASTE_COLUMN_SPECS, cols.map((c) => ({ ...c, ...H })) as ColDef[]) as ColDef<WasteGridRow>[]
}

/**
 * The verbs' clicks go through the context (the column objects never change). A waiting row (D12) offers Approve and
 * Reject, each through its review; every other row its one verb. The ⋯: wasteRowMenu / stoppedRowMenu (Open record
 * always; the verbs held, with why, for a person who may not change ads).
 */
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
          const held = () => handlers.current.noWrite
          if (kind === 'waste' && (row as WasteGridRow).waiting) {
            const w = row as WasteGridRow
            const decide = (d: 'approve' | 'reject'): RowVerb<R> => ({
              id: d, label: d === 'approve' ? 'Approve' : 'Reject', tone: 'default', ariaLabel: () => decideAria(d, w), disabled: held, onClick: (x: R) => handlers.current.decide?.(x.id, d),
            })
            return [decide('approve'), decide('reject')]
          }
          const v = kind === 'waste' ? wasteVerb(row as WasteGridRow) : stoppedVerb(row as StoppedGridRow)
          if (!v) return []
          return [{ ...verbOf(v)[0]!, disabled: () => handlers.current.noWrite ?? v.held, onClick: (d: R) => handlers.current.verb(d.id, v) }]
        },
        items: (row: R) => menuItemsOf(kind === 'waste'
          ? wasteRowMenu(row as WasteGridRow, handlers.current.noWrite)
          : stoppedRowMenu(row as StoppedGridRow, handlers.current.noWrite, Date.now()), row.id, handlers),
        menuLabel: (row: R) => `More for ${row.text}`,
      },
    }
  })
}

/**
 * The Stopped table (D13, the board's widths: Term 220 · Where ≥ 180 · Product 104 · Kept by 112 · Since 84 · Spend
 * before 112 · Saved 100 · State 150 · the verb fits its buttons). Phone: the same columns, Term 150, the verb last.
 */
export function stoppedColumns(phone: boolean): ColDef<StoppedGridRow>[] {
  const L = LABEL(STOPPED_COLUMN_SPECS)
  const cols: ColDef<StoppedGridRow>[] = [
    { colId: 'term', headerName: L.term, valueGetter: (p) => p.data?.text ?? '', cellRenderer: phone ? PhoneTermCell : TermCell, pinned: 'left', width: phone ? 150 : 220, cellClass: 'nds-ag-cell' },
    { colId: 'where', headerName: L.where, valueGetter: (p) => (p.data ? entityPathText(p.data.path) : ''), cellRenderer: WhereCell, ...(phone ? { width: 200 } : { flex: 1, minWidth: 180 }), cellClass: 'nds-ag-cell nds-ag-cell-clip', suppressKeyboardEvent: placeKeys as ColDef<StoppedGridRow>['suppressKeyboardEvent'], headerTooltip: 'Campaign, then its ad group (or the whole campaign); the portfolio on hover. Enter: the campaign · Shift+Enter: the ad group' },
    { colId: 'product', headerName: L.product, valueGetter: (p) => (p.data ? productWords(p.data) : ''), cellRenderer: ProductRenderer, suppressKeyboardEvent: entityLinksKeys as ColDef<StoppedGridRow>['suppressKeyboardEvent'], width: 104, cellClass: 'nds-ag-cell' },
    { colId: 'owner', headerName: L.owner, valueGetter: (p) => (p.data ? chipOwner(p.data.owner).hint : ''), cellRenderer: OwnerCell, width: 112, cellClass: 'nds-ag-cell', suppressKeyboardEvent: ownerKeys as ColDef<StoppedGridRow>['suppressKeyboardEvent'] },
    { colId: 'since', headerName: L.since, valueGetter: (p) => p.data?.since ?? null, cellRenderer: SinceCell, width: 84, cellClass: 'nds-ag-cell', valueFormatter: (p) => dayWords(p.value as string | null), suppressKeyboardEvent: sinceKeys as ColDef<StoppedGridRow>['suppressKeyboardEvent'], ...DESC_FIRST, headerTooltip: 'When it was added or paused, from the record that says so. Enter: how it is known' },
    { colId: 'spendBefore', headerName: L.spendBefore, valueGetter: (p) => p.data?.spendBeforeCents ?? null, valueFormatter: moneyOf, cellRenderer: SpendBeforeCell, width: 112, cellClass: num, ...numeric, headerTooltip: SPEND_BEFORE_WORDS },
    { colId: 'saved', headerName: L.saved, valueGetter: (p) => (p.data ? savedView(p.data).cents : null), valueFormatter: (p) => (p.data ? savedView(p.data).text : ''), cellRenderer: SavedCell, width: 100, cellClass: num, ...numeric, headerTooltip: SAVED_WORDS },
    { colId: 'state', headerName: L.state, valueGetter: (p) => (p.data ? stateChip(p.data).word : ''), cellRenderer: StoppedStateCell, width: 150, minWidth: 130, cellClass: 'nds-ag-cell' },
    { ...integerColumn<StoppedGridRow>('stillServesIn'), colId: 'stillServes', headerName: L.stillServes, width: 128, headerTooltip: 'Other ad groups where these words still spend' },
    actionsColumn<StoppedGridRow>({ primary: (row) => verbOf(stoppedVerb(row)) as never, prefsLabel: 'Action', pinned: !phone }),
  ]
  // Every column but the verbs is ordered by the server (`?sort=`), as on the Wasting view.
  return hide(STOPPED_COLUMN_SPECS, cols.map((c) => ({ ...c, ...H, ...(c.colId === 'actions' ? {} : serverSort) })) as ColDef[]) as ColDef<StoppedGridRow>[]
}
