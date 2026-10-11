'use client'

/**
 * Negative Targeting page, Rules view — the one table (2026-10-11). Rule (its icon, name and one sentence) · Scope (the
 * DS `EntityPath`: market › portfolio › campaign › ad group, and how many campaigns it spans) · Mode (the DS mode
 * column: Off · Watch · Ask me · Auto, the held mark with its reason) · Last 7 d · Waiting, and the ⋯ menu. The Brain
 * and Harvest rows are pinned on top, read only: their Mode cell is locked and says who owns them.
 *
 * Built like the Bid page's rules table (`bid/rules/RulesTable.tsx`): columns are module constants, the cells read the
 * view's handlers from AG's `context` (a ref that never changes identity); a mode pick goes to the view's draft; every
 * other verb asks the view, which reviews it in the DS `ReviewChangesModal`.
 *
 * Keyboard: Enter on a row's Rule cell opens its detail; on Scope it follows the path's last link (← / → walk the links)
 * or opens the campaign list; on Last 7 d it opens the detail where its chips point; on Waiting the asks; on ⋯ the menu.
 */
import { memo } from 'react'
import { ArrowUpRight, Brain, Crosshair, ShieldAlert, ShieldCheck, Sprout, TextSearch } from 'lucide-react'
import { Button, Tag, Tooltip } from '@/design-system/primitives'
import { EntityLinks, EntityPath, type EntityLinkComponent, type MenuItemDef } from '@/design-system/components'
import {
  CELL_DETAIL_TRIGGER, GridNoRowsOverlay, ModeCell, NexusGrid, actionsColumn, entityPathColumn, entityPathKeys, gridSelection, keepFromGrid, modeColumn,
  type ColDef, type ICellRendererParams, type ModeCellParams, type NexusGridProps,
} from '@/design-system/grid'
import Link from '@/lib/workspaces/Link'
import { relWords } from '../../bid/_shared/format'
import { MODES, MODE_WORD, holdReason, holdWord, type BidRuleMode } from '../../bid/rules/bidRulesModel'
import {
  KIND_WORD, LAST_WEEK, WASTE_MODE_MEANS, decidedElsewhere, harvestWaitingHref, heldStep, isInfoHold, isPseudo, last7Parts, last7Tab, last7Text, modeLock, ownerOf, partHolds, scopeCount,
  scopePath, scopeText,
  type WasteKind, type WasteRuleRow,
} from './wasteRulesModel'
import styles from './rules.module.css'

export type PanelTab = 'overview' | 'preview' | 'history' | 'waiting' | 'settings'

/** What the view hands the grid (a ref: the columns never change with the draft). */
export interface RulesHandlers {
  /** Absent without the permission: the Mode cell only shows. */
  onMode?: (row: GridRow, next: string) => void
  open(id: string, tab?: PanelTab): void
  archive(row: WasteRuleRow): void
  unarchive(row: WasteRuleRow): void
  /** Why archive / unarchive cannot be used (no permission), or null. */
  archiveHeld: string | null
  /** Why the mode cannot be changed (no permission), or null. */
  modeHeld: string | null
  /** The view's market ('all' = every market): a rule for every market says so when one market is shown. */
  market: string
}
export interface HandlersRef { readonly current: RulesHandlers }

/** A grid row: the rule as read, the mode it shows (the draft's pick while one is pending), and the view's handlers. */
export interface GridRow {
  id: string
  row: WasteRuleRow
  mode: BidRuleMode
  pending: boolean
  h: HandlersRef
}

type Cell = ICellRendererParams<GridRow> & { context: HandlersRef }
type KeyParams = { event: KeyboardEvent; editing: boolean; data?: GridRow; context?: HandlersRef }
const WorkspaceLink = Link as unknown as EntityLinkComponent
const CAMPAIGNS = { one: 'campaign', many: 'campaigns' }

// ── the icons: who owns it, what it stops ─────────────────────────────────────────────────────────────────────────

const KIND_ICON: Readonly<Record<WasteKind, typeof Crosshair>> = { PAUSE_KEYWORD: Crosshair, NEGATE_TERM: TextSearch }

/** The row's mark: the Brain or Harvest (who owns it), else what it stops (our keyword, a shopper's search term). */
export function RuleMark({ row, size = 14 }: { row: Pick<WasteRuleRow, 'source' | 'readOnly' | 'kind'>; size?: number }) {
  const owner = ownerOf(row)
  if (owner) {
    const Icon = row.source === 'brain' ? Brain : Sprout
    return <Tooltip label={owner.lock} portal><span className={styles.ownerIcon} role="img" aria-label={owner.word}><Icon size={size} aria-hidden /></span></Tooltip>
  }
  const Icon = KIND_ICON[row.kind]
  return <Tooltip label={KIND_WORD[row.kind]} portal><span className={styles.icon} role="img" aria-label={KIND_WORD[row.kind]}><Icon size={size} aria-hidden /></span></Tooltip>
}

// ── cells ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const RuleCell = memo(function RuleCell({ data, context }: Cell) {
  if (!data) return null
  const r = data.row
  return (
    <span className={styles.two} title={r.sentence}>
      <span className={styles.main}>
        <RuleMark row={r} />
        <span className={styles.ellipsis}>{r.name}</span>
        {r.archived && <Tag>Archived</Tag>}
        {!isPseudo(r) && !r.market && context.current.market !== 'all' && <Tag>All markets</Tag>}
      </span>
      <span className={styles.sub}>{r.sentence}</span>
    </span>
  )
})

/** The phone's one cell: the rule (and how many asks wait), and where it acts as its second line. */
const PhoneRuleCell = memo(function PhoneRuleCell({ data }: Cell) {
  if (!data) return null
  const r = data.row
  return (
    <span className={styles.two} title={`${r.name} · ${scopeText(r)}`}>
      <span className={styles.main}>
        <RuleMark row={r} />
        <span className={styles.ellipsis}>{r.name}</span>
        {r.waiting > 0 && <span className={styles.phoneWaiting} role="img" aria-label={`${r.waiting} waiting`}><Tag tone="warning">{r.waiting}</Tag></span>}
      </span>
      <span className={styles.sub}>{scopeText(r)}</span>
    </span>
  )
})

const ScopeCell = memo(function ScopeCell({ data, eGridCell }: Cell) {
  if (!data) return null
  const r = data.row
  const count = scopeCount(r)
  const back = eGridCell ? () => eGridCell.focus() : undefined
  return (
    <span className={styles.scopeCell} onClickCapture={keepFromGrid}>
      <EntityPath items={scopePath(r)} linkAs={WorkspaceLink} label={`Where ${r.name} acts`} className={styles.scopePath} />
      {count > 1 && (
        <span className={styles.scopeCount}>
          <EntityLinks items={r.scope.campaigns} total={count} noun={CAMPAIGNS} linkAs={WorkspaceLink} listLabel={`Campaigns ${r.name} acts on`} returnFocus={back} />
        </span>
      )}
      {r.scope.all && !r.scope.product && count <= 1 && <Tag>Whole market</Tag>}
    </span>
  )
})

/** The Scope cell's keys: the path's own (`entityPathKeys`), and Enter on a path without links opens the campaign list. */
function scopeKeys(p: KeyParams): boolean {
  const target = p.event.target as HTMLElement | null
  if (!target || typeof target.closest !== 'function') return false
  if (target.closest(CELL_DETAIL_TRIGGER) || target.closest('[role="dialog"]')) return true
  if (target.querySelector?.('a[href]')) return entityPathKeys({ event: p.event, editing: p.editing } as Parameters<typeof entityPathKeys>[0])
  if (target.closest('a[href]')) return entityPathKeys({ event: p.event, editing: p.editing } as Parameters<typeof entityPathKeys>[0])
  if (p.editing || p.event.key !== 'Enter') return false
  const trigger = target.querySelector<HTMLElement>(CELL_DETAIL_TRIGGER)
  if (!trigger) return false
  if (p.event.type && p.event.type !== 'keydown') return true
  p.event.preventDefault()
  trigger.click()
  return true
}

/**
 * The Mode cell: the DS mode picker, and — when part of its campaigns are held while it still acts as set — a shield that
 * names them on hover and focus; a quiet shield when it only informs (Auto inside its caps).
 */
function ModeWithHolds(p: Cell & ModeCellParams<GridRow>) {
  const holds = p.data ? partHolds(p.data.mode) : []
  const words = holds.map((h) => `${holdWord(h.label)}: ${holdReason(h)}`).join(' · ')
  const info = holds.length > 0 && holds.every(isInfoHold)
  return (
    <span className={styles.modeCell}>
      <span className={styles.modeMain}><ModeCell {...p} /></span>
      {holds.length > 0 && (
        <Tooltip label={words} portal>
          <span className={info ? styles.partInfo : styles.partHold} role="img" aria-label={words}>
            {info ? <ShieldCheck size={12} aria-hidden /> : <ShieldAlert size={12} aria-hidden />}
          </span>
        </Tooltip>
      )}
    </span>
  )
}

/** The chips of what it did; a chip with a tab is a small button that opens the detail there. */
const Last7Cell = memo(function Last7Cell({ data, context }: Cell) {
  if (!data) return null
  const r = data.row
  const parts = last7Parts(r)
  const open = (tab: PanelTab) => () => context.current.open(r.id, tab)
  return (
    <span className={styles.chipsLine} title={last7Text(r)} onClickCapture={keepFromGrid}>
      {parts.map((x) => (x.tab
        ? <Button key={x.key} size="xs" variant="tonal" onClick={open(x.tab)} aria-label={`${x.text}: open ${x.tab === 'waiting' ? 'Waiting' : 'History'}`}>{x.text}</Button>
        : <Tag key={x.key} tone={x.tone ?? 'neutral'}>{x.text}</Tag>))}
      {!parts.length && <span className={styles.muted}>—</span>}
    </span>
  )
})

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

/** Waiting: how many asks wait for a person — a button that opens them in the detail; a dash when none. Harvest's are
 *  decided on the Keyword Harvest page: a link there with the count (NFIX). */
const WaitingCell = memo(function WaitingCell({ data, context }: Cell) {
  if (!data) return null
  const r = data.row
  if (!r.waiting) return <span className={styles.muted} aria-label="Nothing waiting">—</span>
  if (decidedElsewhere(r)) {
    return (
      <span onClickCapture={keepFromGrid}>
        <Link href={harvestWaitingHref(r.market ?? context.current.market)} className="nds-entitylink" title="Decided on the Keyword Harvest page"
          aria-label={`${r.waiting} waiting: decide them on the Keyword Harvest page`}>{r.waiting}<ArrowUpRight size={12} aria-hidden /></Link>
      </span>
    )
  }
  return (
    <span onClickCapture={keepFromGrid}>
      <Button size="xs" variant="warning" onClick={() => context.current.open(r.id, 'waiting')} aria-label={`${r.waiting} waiting: open them`}>{r.waiting}</Button>
    </span>
  )
})

function waitingKeys(p: KeyParams): boolean {
  const target = p.event.target as HTMLElement | null
  if (!target || typeof target.closest !== 'function') return false
  if (target.closest('button, a[href]')) return true
  if (p.editing || p.event.key !== 'Enter' || !p.data || !p.context) return false
  if (p.event.type && p.event.type !== 'keydown') return true
  p.event.preventDefault()
  p.context.current.open(p.data.id, p.data.row.waiting > 0 && !decidedElsewhere(p.data.row) ? 'waiting' : 'overview')
  return true
}

// ── the ⋯ menu ──────────────────────────────────────────────────────────────────────────────────────────────────────

function menuItems(g: GridRow): MenuItemDef[] {
  const h = g.h.current
  const r = g.row
  const open = (tab: PanelTab) => () => h.open(r.id, tab)
  if (isPseudo(r)) {
    const waiting: MenuItemDef[] = r.waiting <= 0 ? []
      : decidedElsewhere(r) ? [{ id: 'waiting', label: `Waiting · ${r.waiting} · Keyword Harvest`, href: harvestWaitingHref(r.market ?? h.market), description: 'Decided on the Keyword Harvest page' }]
        : [{ id: 'waiting', label: `Waiting · ${r.waiting}`, onSelect: open('waiting') }]
    return [
      { id: 'open', label: 'Open', onSelect: open('overview') },
      ...waiting,
      { id: 'history', label: 'History', onSelect: open('history') },
    ]
  }
  const held = h.archiveHeld
  return [
    { id: 'open', label: 'Open', onSelect: open('overview') },
    ...(r.waiting > 0 ? [{ id: 'waiting', label: `Waiting · ${r.waiting}`, onSelect: open('waiting') }] : []),
    { id: 'preview', label: 'Preview', onSelect: open('preview') },
    { id: 'history', label: 'History', onSelect: open('history') },
    { id: 'settings', label: 'Settings', onSelect: open('settings') },
    r.archived
      ? { id: 'unarchive', label: 'Unarchive…', disabled: !!held, description: held ?? undefined, onSelect: () => h.unarchive(r) }
      : { id: 'archive', label: 'Archive…', tone: 'danger', disabled: !!held, description: held ?? undefined, onSelect: () => h.archive(r) },
  ]
}

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

const STEPS = MODES.map((m) => ({ value: m, label: MODE_WORD[m], note: WASTE_MODE_MEANS[m] }))

// Widths at 1440 (card 1312 px): tick 44 + rule 300 + scope (flex, ≥ 240) + mode 172 + last 7 d 220 + waiting 100 + ⋯ 56.
const RULE: ColDef<GridRow> = {
  colId: 'rule', headerName: 'Rule', pinned: 'left', width: 300, minWidth: 200,
  valueGetter: (p) => p.data?.row.name ?? '',
  getQuickFilterText: (p) => (p.data ? `${p.data.row.name} ${p.data.row.sentence}` : ''),
  cellRenderer: RuleCell,
}

const SCOPE_BASE = entityPathColumn<GridRow>('scope', { header: 'Scope', linkAs: WorkspaceLink, label: (g) => `Where ${g.row.name} acts` })
const SCOPE: ColDef<GridRow> = {
  ...SCOPE_BASE,
  field: undefined,
  colId: 'scope',
  flex: 1,
  minWidth: 240,
  valueGetter: (p) => (p.data ? scopePath(p.data.row) : []),
  valueFormatter: (p) => (p.data ? scopeText(p.data.row) : ''),
  getQuickFilterText: (p) => (p.data ? scopeText(p.data.row) : ''),
  cellRenderer: ScopeCell,
  suppressKeyboardEvent: scopeKeys as ColDef<GridRow>['suppressKeyboardEvent'],
  headerTooltip: 'Where it acts: market › portfolio › campaign › ad group. A count: the campaigns it spans.',
}

const MODE_BASE = modeColumn<GridRow>('mode', {
  header: 'Mode',
  steps: STEPS,
  value: (g) => (g.mode.heldBy ? { ...g.mode, heldBy: { ...g.mode.heldBy, label: holdWord(g.mode.heldBy.label) } } : g.mode),
  heldOption: (g, step) => heldStep(g.row, step),
  lockReason: (g) => modeLock(g.row, g.h.current.modeHeld),
  pending: (g) => g.pending,
})
const MODE: ColDef<GridRow> = {
  ...MODE_BASE,
  cellRenderer: ModeWithHolds,
  width: 172,
  headerTooltip: 'Off · Watch · Ask me · Auto. An arrow: it acts lower now. A shield: part of it is held. Hover for why.',
}

const LAST7: ColDef<GridRow> = {
  colId: 'last7', headerName: LAST_WEEK, width: 220, minWidth: 140,
  valueGetter: (p) => (p.data ? p.data.row.changed7d.paused + p.data.row.changed7d.negated + p.data.row.last7d.asks : 0),
  valueFormatter: (p) => (p.data ? last7Text(p.data.row) : ''),
  getQuickFilterText: (p) => (p.data ? last7Text(p.data.row) : ''),
  cellRenderer: Last7Cell,
  suppressKeyboardEvent: last7Keys as ColDef<GridRow>['suppressKeyboardEvent'],
  headerTooltip: 'Keywords it paused, negatives it added, asks it made, refusals. A blue chip opens its History or asks.',
}

const WAITING: ColDef<GridRow> = {
  colId: 'waiting', headerName: 'Waiting', width: 100, minWidth: 88,
  valueGetter: (p) => p.data?.row.waiting ?? 0,
  cellRenderer: WaitingCell,
  suppressKeyboardEvent: waitingKeys as ColDef<GridRow>['suppressKeyboardEvent'],
  headerTooltip: 'Asks waiting for you: approve or reject them here.',
}

const LAST_RUN: ColDef<GridRow> = {
  colId: 'lastRun', headerName: 'Last run', width: 120, hide: true,
  valueGetter: (p) => p.data?.row.lastRunAt ?? null,
  valueFormatter: (p) => relWords(p.value as string | null),
}
const NEXT_RUN: ColDef<GridRow> = {
  colId: 'nextRun', headerName: 'Next run', width: 120, hide: true,
  valueGetter: (p) => p.data?.row.nextRunAt ?? null,
  valueFormatter: (p) => relWords(p.value as string | null),
}
const MARKET: ColDef<GridRow> = {
  colId: 'market', headerName: 'Market', width: 110, hide: true,
  valueGetter: (p) => p.data?.row.market ?? 'All',
}

const ACTIONS: ColDef<GridRow> = {
  ...actionsColumn<GridRow>({ items: menuItems, menuLabel: (g) => `Actions for ${g.row.name}` }),
  suppressKeyboardEvent: actionsKeys as ColDef<GridRow>['suppressKeyboardEvent'],
}

/** No header ⋮ menu, as on the page's Wasting and Stopped views (audit S5): Customise and the sort are in the toolbar and on a header click. */
const plain = (c: ColDef<GridRow>): ColDef<GridRow> => ({ ...c, suppressHeaderMenuButton: true })
export const RULE_COLUMNS: ColDef<GridRow>[] = [RULE, SCOPE, MODE, LAST7, WAITING, LAST_RUN, NEXT_RUN, MARKET, ACTIONS].map(plain)

/**
 * A phone (264 px of card): the rule (with how many asks wait) and where it acts as line 2, then its mode. A tap opens
 * the full-screen detail; nothing is pinned (audit M8).
 */
const PHONE_RULE: ColDef<GridRow> = { ...RULE, pinned: null, lockPinned: false, width: undefined, flex: 1, minWidth: 140, cellRenderer: PhoneRuleCell }
/** The phone's Mode: the DS cell alone (the holds are in the detail, a tap away: no room for the shield). */
const PHONE_MODE: ColDef<GridRow> = { ...MODE_BASE, width: 108, headerTooltip: MODE.headerTooltip }
export const RULE_PHONE_COLUMNS: ColDef<GridRow>[] = [PHONE_RULE, PHONE_MODE].map(plain)

/** The columns Customise lists (the ⋯ column is not one of them). */
export const RULE_PREFERENCE_COLUMNS: ReadonlyArray<{ key: string; label: string; locked?: boolean; hidden?: boolean }> = [
  { key: 'rule', label: 'Rule', locked: true },
  { key: 'scope', label: 'Scope' },
  { key: 'mode', label: 'Mode', locked: true },
  { key: 'last7', label: LAST_WEEK },
  { key: 'waiting', label: 'Waiting' },
  { key: 'lastRun', label: 'Last run', hidden: true },
  { key: 'nextRun', label: 'Next run', hidden: true },
  { key: 'market', label: 'Market', hidden: true },
]

const ROW_ID: NonNullable<NexusGridProps<GridRow>['getRowId']> = (p) => p.data.id
const SELECTION = gridSelection<GridRow>({ selectAll: 'filtered', isRowSelectable: (n) => !n.rowPinned && !!n.data && !isPseudo(n.data.row) }) as NexusGridProps<GridRow>['rowSelection']

export function WasteRulesTable(p: {
  rows: GridRow[]
  pinned: GridRow[]
  context: HandlersRef
  phone: boolean
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
      pinnedTopRowData={p.pinned.length ? p.pinned : undefined}
      getRowId={ROW_ID}
      columnDefs={p.phone ? RULE_PHONE_COLUMNS : RULE_COLUMNS}
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
