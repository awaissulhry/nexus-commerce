'use client'

/**
 * Bid page, Rules view — the one table (2026-10-10). Rule (name + its one line) · Mode · Portfolios · Campaigns · Ad groups
 * · Last 7 d · Effect, and the ⋯ menu. The brain is the first row, pinned on top (it stays first whatever the sort) and
 * read only here. It never writes: a mode pick goes to the page's draft (`context.current.onMode`), every other verb asks
 * the page, which reviews it in the DS `ReviewChangesModal`.
 *
 * Stable grid options (GDS decision 12): the columns are module constants (one set for a desktop, one for a phone); the
 * cells read the page's handlers from AG's `context`, a ref that never changes identity.
 *
 * Portfolios · Campaigns · Ad groups: the top line is what the rule works on, the line under the pencil what it changed in
 * the last 7 days — one item is a direct link, a count opens a small list of links (the count is the true total, the list
 * says how many it leaves out). Enter on the cell follows (or opens) the top line, Shift+Enter the changed line; every item
 * is also in the side panel's Overview.
 *
 * Keyboard: Enter on a row's Rule or Effect cell opens its panel; on Last 7 d it opens the panel where its chips point (the
 * asks while some wait); on the ⋯ cell it opens the menu. A click on a Last 7 d chip that is a button opens its tab; a
 * click anywhere else in that cell opens the rule, like every other cell (use audit A9).
 *
 * Last run shows by default; Market only while the page is on All markets (on one market every row is in it); Next run
 * waits in Customise. A row in a market Nexus only reads holds its mode and its archive, with the reason (A1).
 */
import { memo } from 'react'
import { Brain, PenLine, ShieldAlert } from 'lucide-react'
import { Button, Tag, Tooltip } from '@/design-system/primitives'
import { EntityLinks, type EntityLinkComponent } from '@/design-system/components'
import type { MenuItemDef } from '@/design-system/components'
import {
  CELL_DETAIL_TRIGGER, GridLoadingOverlay, GridNoRowsOverlay, ModeCell, NexusGrid, actionsColumn, entityLinksColumn, gridSelection, keepFromGrid, modeColumn,
  type ColDef, type ICellRendererParams, type ModeCellParams, type NexusGridProps,
} from '@/design-system/grid'
import Link from '@/lib/workspaces/Link'
import { relWords, whenWords } from '../_shared/format'
import { FullName } from '../_shared/FullName'
import {
  LAST7_ROOM, LAST7_ROOM_ONE_MARKET, LAST_WEEK, MODES, MODE_MEANS, MODE_WORD, REF_HEADER, REF_NOUN, allAdGroups, effectView, heldStep, holdReason, holdWord, isBrain,
  last7Fit, last7Tab, last7Text, modeLock, noEffectWords, partHolds, worksOn,
  type BidRuleMode, type BidRuleRow, type RefKind,
} from './bidRulesModel'
import styles from '../bid.module.css'

export type PanelTab = 'overview' | 'waiting' | 'preview' | 'history' | 'effect' | 'settings'

/** What the page hands the grid (a ref: the columns never change with the draft). */
export interface RulesHandlers {
  /** Absent without the permission: the Mode cell only shows. */
  onMode?: (row: GridRow, next: string) => void
  open(id: string, tab?: PanelTab): void
  archive(row: BidRuleRow): void
  restore(row: BidRuleRow): void
  /** Why archive / restore cannot be used (no permission), or null. */
  archiveHeld: string | null
  /** The page's market ('all' = every market): a rule for every market says so when one market is shown. */
  market: string
}
export interface HandlersRef { readonly current: RulesHandlers }

/** A grid row: the rule as read, the mode it shows (the draft's pick while one is pending), and the page's handlers. */
export interface GridRow {
  id: string
  row: BidRuleRow
  mode: BidRuleMode
  pending: boolean
  h: HandlersRef
  /** Why no write may touch this rule: the market it (or the page) is in is one Nexus only reads; null = writes may go. */
  block: string | null
}

type Cell = ICellRendererParams<GridRow> & { context: HandlersRef }
const WorkspaceLink = Link as unknown as EntityLinkComponent
type KeyParams = { event: KeyboardEvent; editing: boolean; data?: GridRow; context?: HandlersRef }

// ── what it works on / changed: the links, with the true count ──────────────────────────────────────────────────────

/**
 * One kind of what a rule works on (`scope`) or changed in 7 d (`changed`): none → a dash, one → its link, several → a count
 * chip that opens the list — the DS `EntityLinks` with the TRUE `total` (the API lists up to 100 and counts them all in
 * `scope.counts` / `changed7d.counts`): the chip says "153 campaigns" and the list ends "53 more not listed" (audit M5,
 * S9). Ad groups of a rule bound to none read "All" — in the table and the panel alike (S7).
 */
export function RefLinks({ row, kind, set, listLabel, returnFocus }: {
  row: BidRuleRow
  kind: RefKind
  set: 'scope' | 'changed'
  listLabel: string
  returnFocus?: () => void
}) {
  if (set === 'scope' && kind === 'adGroups' && allAdGroups(row)) {
    return <Tooltip label="Every ad group of its campaigns" portal><span tabIndex={-1}><Tag>All</Tag></span></Tooltip>
  }
  const { items, total } = worksOn(row, kind, set)
  const label = set === 'scope' && kind === 'campaigns' && row.scope.all && !isBrain(row) ? `Whole market: ${listLabel}` : listLabel
  return <EntityLinks items={items} total={total} noun={REF_NOUN[kind]} linkAs={WorkspaceLink} listLabel={label} returnFocus={returnFocus} />
}

// ── cells ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The rule's name, and its one line under it (audit R12: room for the whole line at 1440; a longer one shows whole on hover
 *  and on keyboard focus). */
const RuleCell = memo(function RuleCell({ data, context, eGridCell }: Cell) {
  if (!data) return null
  const r = data.row
  const brain = isBrain(r)
  return (
    <span className={styles.two}>
      <span className={styles.main}>
        {brain && <Brain size={14} aria-hidden className={styles.brainIcon} />}
        <span className={styles.ellipsis} title={r.name}>{r.name}</span>
        {r.archived && <Tag>Archived</Tag>}
        {!brain && !r.market && context.current.market !== 'all' && <Tag>All markets</Tag>}
      </span>
      <FullName full={r.sentence} cell={eGridCell} className={styles.sentence} />
    </span>
  )
})

/** Enter (or Space) on the cell: the top line; Shift+Enter: the changed line. A focused link or count keeps its own keys. */
function worksOnKeys(p: KeyParams): boolean {
  const { event, editing } = p
  const target = event.target as HTMLElement | null
  if (!target || typeof target.closest !== 'function') return false
  if (target.closest(`a[href], ${CELL_DETAIL_TRIGGER}`)) return true
  if (editing || (event.key !== 'Enter' && event.key !== ' ')) return false
  const part = target.querySelector<HTMLElement>(`[data-part="${event.shiftKey ? 'changed' : 'scope'}"]`)
  const control = part?.querySelector<HTMLElement>(`${CELL_DETAIL_TRIGGER}, a[href]`)
  if (!control) return false
  if (event.type && event.type !== 'keydown') return true
  event.preventDefault()
  control.click()
  return true
}

const WorksOnCell = memo(function WorksOnCell({ data, kind, eGridCell }: Cell & { kind: RefKind }) {
  if (!data) return null
  const r = data.row
  const changed = r.changed7d[kind]
  const back = eGridCell ? () => eGridCell.focus() : undefined
  return (
    <span className={styles.two} onClickCapture={keepFromGrid}>
      <span className={styles.line} data-part="scope">
        <RefLinks row={r} kind={kind} set="scope" listLabel={`${REF_HEADER[kind]} ${r.name} works on`} returnFocus={back} />
      </span>
      {changed.length > 0 && (
        <span className={styles.subline} data-part="changed">
          <Tooltip label={`Changed · ${LAST_WEEK.toLowerCase()}`} portal>
            <span className={styles.mark} role="img" aria-label={`Changed · ${LAST_WEEK.toLowerCase()}`}><PenLine size={11} aria-hidden /></span>
          </Tooltip>
          <RefLinks row={r} kind={kind} set="changed" listLabel={`${REF_HEADER[kind]} ${r.name} changed · ${LAST_WEEK.toLowerCase()}`} returnFocus={back} />
        </span>
      )}
    </span>
  )
})

/**
 * The Mode cell: the DS mode picker, and — when part of its campaigns are held while it still acts as set (no arrow) — a
 * small shield that names them on hover and focus (audit S19: the table is as honest as the panel). Every row keeps the
 * shield's slot, so the picker's chevron stands in one place down the column (design audit M8: it moved 16 px).
 */
function ModeWithHolds(p: Cell & ModeCellParams<GridRow>) {
  const holds = p.data ? partHolds(p.data.mode) : []
  const words = holds.map((h) => `${holdWord(h.label)}: ${holdReason(h)}`).join(' · ')
  return (
    <span className={styles.modeCell}>
      <ModeCell {...p} />
      {holds.length > 0 ? (
        <Tooltip label={words} portal>
          <span className={styles.partHold} role="img" aria-label={words}><ShieldAlert size={12} aria-hidden /></span>
        </Tooltip>
      ) : <span className={styles.partHold} aria-hidden />}
    </span>
  )
}

/**
 * A chip that opens a panel tab: a small tonal button (its words say where it goes); other chips stay tags. One line
 * (design audit M7): the asks that wait first, then what fits; the rest is one "+n" that names them on hover (Enter on the
 * cell, and the panel, reach every one).
 */
const Last7Cell = memo(function Last7Cell({ data, context }: Cell) {
  if (!data) return null
  const r = data.row
  const { shown, hidden } = last7Fit(r, context.current.market === 'all' ? LAST7_ROOM : LAST7_ROOM_ONE_MARKET)
  const open = (tab: PanelTab) => () => context.current.open(r.id, tab)
  const more = hidden.map((h) => h.text).join(' · ')
  return (
    <span className={styles.chipLine} title={last7Text(r)}>
      {shown.map(({ key, text, waiting, part }) => (waiting
        ? <Button key={key} size="xs" variant="warning" onClickCapture={keepFromGrid} onClick={open('waiting')} aria-label={`${text}: open them`}>{text}</Button>
        : part?.tab
          ? <Button key={key} size="xs" variant="tonal" onClickCapture={keepFromGrid} onClick={open(part.tab)} aria-label={`${text}: open ${part.tab === 'waiting' ? 'the asks' : 'History'}`}>{text}</Button>
          : <Tag key={key} tone={part?.tone ?? 'neutral'}>{text}</Tag>))}
      {hidden.length > 0 && (
        <Tooltip label={more} portal>
          <span className={styles.more} tabIndex={-1} aria-label={`${hidden.length} more: ${more}`}><Tag>{`+${hidden.length}`}</Tag></span>
        </Tooltip>
      )}
      {!shown.length && <span className={styles.muted}>—</span>}
    </span>
  )
})

/** Enter on the Last 7 d cell opens the panel where its chips point; a focused chip keeps its own keys. */
function last7Keys(p: KeyParams): boolean {
  const target = p.event.target as HTMLElement | null
  if (!target || typeof target.closest !== 'function') return false
  if (target.closest('button, a[href]')) return true
  if (p.editing || p.event.key !== 'Enter' || !p.data || !p.context) return false
  if (p.event.type && p.event.type !== 'keydown') return true
  p.event.preventDefault()
  p.context.current.open(p.data.id, last7Tab(p.data.row))
  return true
}

const EffectCell = memo(function EffectCell({ data }: Cell) {
  if (!data) return null
  const v = effectView(data.row.effect)
  if (!v) return <span className={styles.muted} title={noEffectWords(data.row)}>—</span>
  return <span title={v.title}><Tag tone={v.tone}>{v.text}</Tag></span>
})

// ── the ⋯ menu ──────────────────────────────────────────────────────────────────────────────────────────────────────

function menuItems(g: GridRow): MenuItemDef[] {
  const h = g.h.current
  const r = g.row
  if (isBrain(r)) {
    return [
      { id: 'open', label: 'Open', onSelect: () => h.open(r.id, 'overview') },
      { id: 'history', label: 'History', onSelect: () => h.open(r.id, 'history') },
      { id: 'effect', label: 'Effect', onSelect: () => h.open(r.id, 'effect') },
    ]
  }
  const held = h.archiveHeld ?? g.block
  return [
    { id: 'open', label: 'Open', onSelect: () => h.open(r.id, 'overview') },
    ...(r.waiting > 0 ? [{ id: 'waiting', label: `Waiting · ${r.waiting}`, onSelect: () => h.open(r.id, 'waiting') }] : []),
    { id: 'preview', label: 'Preview', onSelect: () => h.open(r.id, 'preview') },
    { id: 'history', label: 'History', onSelect: () => h.open(r.id, 'history') },
    { id: 'settings', label: 'Settings', onSelect: () => h.open(r.id, 'settings') },
    r.archived
      ? { id: 'restore', label: 'Restore…', disabled: !!held, description: held ?? undefined, onSelect: () => h.restore(r) }
      : { id: 'archive', label: 'Archive…', tone: 'danger', disabled: !!held, description: held ?? undefined, onSelect: () => h.archive(r) },
  ]
}

/** Enter or Space on the ⋯ cell opens its menu (audit S9: Archive was reachable only through the panel). */
function actionsKeys(p: KeyParams): boolean {
  const target = p.event.target as HTMLElement | null
  if (!target || typeof target.closest !== 'function') return false
  if (target.closest('button, a[href], [role="menu"], [role="menuitem"]')) return true
  if (p.editing || (p.event.key !== 'Enter' && p.event.key !== ' ')) return false
  const trigger = target.querySelector<HTMLElement>('button')
  if (!trigger) return false
  if (p.event.type && p.event.type !== 'keydown') return true
  p.event.preventDefault()
  trigger.click()
  return true
}

// ── columns ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The four steps with what each does under it, as the panel's list shows them (S7: one list in both places). */
const STEPS = MODES.map((m) => ({ value: m, label: MODE_WORD[m], note: MODE_MEANS[m] }))

// Widths at 1440: the card holds 1312 px; checkbox 43 + Rule 250 + Mode 132 + Portfolios 112 + Campaigns 132 + Ad groups
// 116 + Last 7 d (≥ 170) + Effect 108 + Last run 100 + Market 92 (All markets only) + ⋯ 56 = 1311 — every header whole
// with its ⋮ menu — so nothing scrolls
// sideways and focusing a cell never shows a scroll band over the last row (audit S20). A longer name or line ends in "…"
// and shows whole on hover and on keyboard focus.
const RULE: ColDef<GridRow> = {
  colId: 'rule', headerName: 'Rule', pinned: 'left', width: 250, minWidth: 200,
  valueGetter: (p) => p.data?.row.name ?? '',
  getQuickFilterText: (p) => (p.data ? `${p.data.row.name} ${p.data.row.sentence}` : ''),
  cellRenderer: RuleCell,
}

const MODE_BASE = modeColumn<GridRow>('mode', {
  header: 'Mode',
  steps: STEPS,
  value: (g) => (g.mode.heldBy ? { ...g.mode, heldBy: { ...g.mode.heldBy, label: holdWord(g.mode.heldBy.label) } } : g.mode),
  heldOption: (g, step) => heldStep(g.row, step),
  lockReason: (g) => modeLock(g.row) ?? g.block,
  pending: (g) => g.pending,
})
const MODE: ColDef<GridRow> = {
  ...MODE_BASE,
  cellRenderer: ModeWithHolds,
  width: 132,
  headerTooltip: 'Off · Watch · Ask me · Auto. An arrow: it acts lower now. A shield: some of its campaigns are held. Hover for why.',
}

const refColumn = (kind: RefKind, width: number): ColDef<GridRow> => {
  const base = entityLinksColumn<GridRow>(kind, { header: REF_HEADER[kind], noun: REF_NOUN[kind], linkAs: WorkspaceLink, total: (g) => worksOn(g.row, kind).total })
  return {
    ...base,
    field: undefined,
    colId: kind,
    valueGetter: (p) => p.data?.row.scope[kind] ?? [],
    cellRenderer: WorksOnCell,
    cellRendererParams: { kind },
    suppressKeyboardEvent: worksOnKeys as ColDef<GridRow>['suppressKeyboardEvent'],
    width,
    headerTooltip: `Top: the ${REF_NOUN[kind].many} it works on. Under the pencil: the ones it changed · ${LAST_WEEK.toLowerCase()}.`,
  }
}
const PORTFOLIOS = refColumn('portfolios', 112)
const CAMPAIGNS = refColumn('campaigns', 132)
const AD_GROUPS = refColumn('adGroups', 116)

const LAST7: ColDef<GridRow> = {
  colId: 'last7', headerName: LAST_WEEK, flex: 1, minWidth: 170,
  valueGetter: (p) => (p.data ? Math.max(p.data.row.changed7d.bids, p.data.row.last7d.written) + p.data.row.last7d.asks : 0),
  valueFormatter: (p) => (p.data ? last7Text(p.data.row) : ''),
  getQuickFilterText: (p) => (p.data ? last7Text(p.data.row) : ''),
  cellRenderer: Last7Cell,
  suppressKeyboardEvent: last7Keys as ColDef<GridRow>['suppressKeyboardEvent'],
  headerTooltip: 'Bids it changed, asks it made and applied, inputs to the Brain, refusals. A blue chip opens its History or asks.',
}

const EFFECT: ColDef<GridRow> = {
  colId: 'effect', headerName: 'Effect', width: 108,
  valueGetter: (p) => p.data?.row.effect?.after.acosPct ?? null,
  valueFormatter: (p) => (p.data ? effectView(p.data.row.effect)?.text ?? '' : ''),
  cellRenderer: EffectCell,
  headerTooltip: 'ACoS of the keywords it changed: before → after, equal days each side. A dash when nothing changed yet.',
}

const LAST_RUN: ColDef<GridRow> = {
  colId: 'lastRun', headerName: 'Last run', width: 100,
  valueGetter: (p) => p.data?.row.lastRunAt ?? null,
  valueFormatter: (p) => relWords(p.value as string | null),
  tooltipValueGetter: (p) => (p.data?.row.lastRunAt ? whenWords(p.data.row.lastRunAt) : 'Not run yet'),
}
// `initialHide`, never `hide`: new definitions (a phone, another market) must not put the person's pick back (A3).
const NEXT_RUN: ColDef<GridRow> = {
  colId: 'nextRun', headerName: 'Next run', width: 100, initialHide: true,
  valueGetter: (p) => p.data?.row.nextRunAt ?? null,
  valueFormatter: (p) => relWords(p.value as string | null),
}
const MARKET: ColDef<GridRow> = {
  colId: 'market', headerName: 'Market', width: 92,
  valueGetter: (p) => p.data?.row.market ?? 'All',
}

const ACTIONS: ColDef<GridRow> = {
  ...actionsColumn<GridRow>({ items: menuItems, menuLabel: (g) => `Actions for ${g.row.name}` }),
  suppressKeyboardEvent: actionsKeys as ColDef<GridRow>['suppressKeyboardEvent'],
}
/**
 * A phone has no room for a second pinned column: the ⋯ scrolls with the rest (a row tap opens the panel anyway).
 * `pinned: null`, not just absent: AG keeps a column's pinned state when new definitions leave `pinned` out, and the page
 * mounts the desktop columns first (audit M8: the ⋯ stayed pinned and ate the Mode column).
 */
const PHONE_ACTIONS: ColDef<GridRow> = { ...ACTIONS, pinned: null, lockPinned: false }

const DESKTOP: ColDef<GridRow>[] = [RULE, MODE, PORTFOLIOS, CAMPAIGNS, AD_GROUPS, LAST7, EFFECT, LAST_RUN, NEXT_RUN, MARKET, ACTIONS]
/** A phone: a narrower pinned rule, its mode beside it, then what it did; the rest scrolls. */
const PHONE: ColDef<GridRow>[] = [
  { ...RULE, width: 132, minWidth: 120 }, { ...MODE, width: 132 }, { ...LAST7, flex: undefined, width: 170 }, EFFECT, CAMPAIGNS, PORTFOLIOS, AD_GROUPS, LAST_RUN, NEXT_RUN, MARKET, PHONE_ACTIONS,
]
/** One market: no Market column, and Last 7 d takes its room (its chips are fitted to that room). */
const LAST7_ONE_MARKET: ColDef<GridRow> = { ...LAST7, minWidth: 254 }
const withoutMarket = (cols: ColDef<GridRow>[]) => cols.filter((c) => c.colId !== 'market').map((c) => (c.colId === 'last7' && c.flex ? LAST7_ONE_MARKET : c))
/** The columns, once per layout: Market only on All markets. Module constants, so the grid sees a stable array. */
const COLUMNS = {
  desktop: { all: DESKTOP, one: withoutMarket(DESKTOP) },
  phone: { all: PHONE, one: withoutMarket(PHONE) },
} as const
export const ruleColumns = (phone: boolean, allMarkets: boolean): ColDef<GridRow>[] => COLUMNS[phone ? 'phone' : 'desktop'][allMarkets ? 'all' : 'one']

/** The columns Customise lists (the ⋯ column is not one of them); Market only on All markets. */
const PREFERENCE_COLUMNS: ReadonlyArray<{ key: string; label: string; locked?: boolean; hidden?: boolean }> = [
  { key: 'rule', label: 'Rule', locked: true },
  { key: 'mode', label: 'Mode', locked: true },
  { key: 'portfolios', label: 'Portfolios' },
  { key: 'campaigns', label: 'Campaigns' },
  { key: 'adGroups', label: 'Ad groups' },
  { key: 'last7', label: LAST_WEEK },
  { key: 'effect', label: 'Effect' },
  { key: 'lastRun', label: 'Last run' },
  { key: 'nextRun', label: 'Next run', hidden: true },
  { key: 'market', label: 'Market' },
]
const PREFS_ONE_MARKET = PREFERENCE_COLUMNS.filter((c) => c.key !== 'market')
export const rulePreferenceColumns = (allMarkets: boolean) => (allMarkets ? PREFERENCE_COLUMNS : PREFS_ONE_MARKET)

const ROW_ID: NonNullable<NexusGridProps<GridRow>['getRowId']> = (p) => p.data.id
const LOADING_PARAMS = { rows: 4 }
const SELECTION = gridSelection<GridRow>({ selectAll: 'filtered', isRowSelectable: (n) => !n.rowPinned && !!n.data && !isBrain(n.data.row) }) as NexusGridProps<GridRow>['rowSelection']

export function RulesTable(p: {
  rows: GridRow[]
  brain: GridRow | null
  context: HandlersRef
  phone: boolean
  /** The page is on All markets: the Market column is drawn. */
  allMarkets: boolean
  /** The first read is on its way: the header shows with the loading lines under it (design audit S10). */
  loading: boolean
  selectable: boolean
  noRowsParams: NexusGridProps<GridRow>['noRowsOverlayComponentParams']
  initialState: NexusGridProps<GridRow>['initialState']
  columnDialog: NexusGridProps<GridRow>['columnDialog']
  onGridReady: NonNullable<NexusGridProps<GridRow>['onGridReady']>
  onRowClicked: NonNullable<NexusGridProps<GridRow>['onRowClicked']>
  onCellKeyDown: NonNullable<NexusGridProps<GridRow>['onCellKeyDown']>
  onSelectionChanged: NonNullable<NexusGridProps<GridRow>['onSelectionChanged']>
}) {
  return (
    <NexusGrid<GridRow>
      domLayout="autoHeight"
      rowClass={styles.clickRow}
      suppressCellFocus={false}
      rowData={p.rows}
      pinnedTopRowData={p.brain ? [p.brain] : undefined}
      getRowId={ROW_ID}
      columnDefs={ruleColumns(p.phone, p.allMarkets)}
      loading={p.loading}
      loadingOverlayComponent={GridLoadingOverlay}
      loadingOverlayComponentParams={LOADING_PARAMS}
      rowSelection={p.selectable ? SELECTION : undefined}
      context={p.context}
      noRowsOverlayComponent={GridNoRowsOverlay}
      noRowsOverlayComponentParams={p.noRowsParams}
      initialState={p.initialState}
      columnDialog={p.columnDialog}
      onGridReady={p.onGridReady}
      onRowClicked={p.onRowClicked}
      onCellKeyDown={p.onCellKeyDown}
      onSelectionChanged={p.onSelectionChanged}
    />
  )
}
