'use client'

/**
 * Keyword Harvest page, Rules view — the one table (2026-10-11, lane HRULES), the Bid Rules table's look with a harvest's
 * words: Rule (name + its one line) · Mode · Portfolios · Campaigns · Ad groups · Last 7 d · Effect, and the ⋯ menu.
 * The brain is the first row, pinned on top, read only here (its harvest is set per product).
 *
 * Portfolios · Campaigns · Ad groups: the top line is what the rule harvests FROM (its reach), the line under the arrow
 * where it harvested INTO in 7 days — one item is a link, a count opens a small list of links with the true total (the
 * Bid table's `RefLinks`, imported). Effect: its harvests judged after the attribution window + 72 h (Better · Worse ·
 * Too early), from the harvest history.
 *
 * Stable grid options (GDS decision 12): the columns are module constants; the cells read the view's handlers from AG's
 * `context`, a ref that never changes identity. Nothing here writes: a mode pick goes to the view's draft.
 */
import { memo } from 'react'
import { ArrowRight, Brain, ShieldAlert } from 'lucide-react'
import { Button, Tag, Tooltip } from '@/design-system/primitives'
import type { MenuItemDef } from '@/design-system/components'
import {
  CELL_DETAIL_TRIGGER, GridNoRowsOverlay, ModeCell, NexusGrid, actionsColumn, entityLinksColumn, gridSelection, keepFromGrid, modeColumn,
  type ColDef, type ICellRendererParams, type ModeCellParams, type NexusGridProps,
} from '@/design-system/grid'
import Link from '@/lib/workspaces/Link'
import type { EntityLinkComponent } from '@/design-system/components'
import { relWords } from '../../bid/_shared/format'
import { LAST_WEEK, MODE_WORD, REF_HEADER, REF_NOUN, holdReason, holdWord, isBrain, modeLock, type BidRuleMode, type BidRuleRow, type RefKind } from '../../bid/rules/bidRulesModel'
import { RefLinks } from '../../bid/rules/RulesTable'
import {
  BRAIN_HARVEST_LOCK, effectParts, effectScore, effectText, harvestHeldStep, harvestLast7Parts, harvestLast7Tab, harvestLast7Text, harvestSteps, keywords7d, plainHold, ruleLine, shieldHolds,
  type RuleEffect,
} from './harvestRulesModel'
import styles from '../../bid/bid.module.css'

export type HarvestPanelTab = 'overview' | 'waiting' | 'preview' | 'history'

/** What the view hands the grid (a ref: the columns never change with the draft). */
export interface HarvestRulesHandlers {
  /** Absent without the permission: the Mode cell only shows. */
  onMode?: (row: HarvestGridRow, next: string) => void
  open(id: string, tab?: HarvestPanelTab): void
  edit(row: BidRuleRow): void
  archive(row: BidRuleRow): void
  restore(row: BidRuleRow): void
  /** Why archive / restore / edit cannot be used (no permission), or null. */
  archiveHeld: string | null
  market: string
  /** The harvest history's days the Effect column counts. */
  effectDays: number
}
export interface HarvestHandlersRef { readonly current: HarvestRulesHandlers }

/** A grid row: the rule as read, the mode it shows (the draft's pick while one is pending), its effect, the handlers. */
export interface HarvestGridRow {
  id: string
  row: BidRuleRow
  mode: BidRuleMode
  pending: boolean
  effect: RuleEffect | null
  h: HarvestHandlersRef
}

type Cell = ICellRendererParams<HarvestGridRow> & { context: HarvestHandlersRef }
type KeyParams = { event: KeyboardEvent; editing: boolean; data?: HarvestGridRow; context?: HarvestHandlersRef }
const WorkspaceLink = Link as unknown as EntityLinkComponent

// ── cells ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const RuleCell = memo(function RuleCell({ data, context }: Cell) {
  if (!data) return null
  const r = data.row
  const brain = isBrain(r)
  return (
    <span className={styles.two} title={ruleLine(r.sentence)}>
      <span className={styles.main}>
        {brain && <Brain size={14} aria-hidden className={styles.brainIcon} />}
        <span className={styles.ellipsis}>{r.name}</span>
        {r.archived && <Tag>Archived</Tag>}
        {!brain && !r.market && context.current.market !== 'all' && <Tag>All markets</Tag>}
      </span>
      <span className={styles.sub}>{ruleLine(r.sentence)}</span>
    </span>
  )
})

/** Enter (or Space) on the cell: the top line; Shift+Enter: the "harvested into" line. A focused link keeps its keys. */
function worksOnKeys(p: KeyParams): boolean {
  const target = p.event.target as HTMLElement | null
  if (!target || typeof target.closest !== 'function') return false
  if (target.closest(`a[href], ${CELL_DETAIL_TRIGGER}`)) return true
  if (p.editing || (p.event.key !== 'Enter' && p.event.key !== ' ')) return false
  const part = target.querySelector<HTMLElement>(`[data-part="${p.event.shiftKey ? 'changed' : 'scope'}"]`)
  const control = part?.querySelector<HTMLElement>(`${CELL_DETAIL_TRIGGER}, a[href]`)
  if (!control) return false
  if (p.event.type && p.event.type !== 'keydown') return true
  p.event.preventDefault()
  control.click()
  return true
}

const INTO = `Harvested into · ${LAST_WEEK.toLowerCase()}`

const WorksOnCell = memo(function WorksOnCell({ data, kind, eGridCell }: Cell & { kind: RefKind }) {
  if (!data) return null
  const r = data.row
  const into = r.changed7d[kind]
  const back = eGridCell ? () => eGridCell.focus() : undefined
  // A rule over its whole market (`scope.all`) says so — never a count of every campaign.
  const whole = r.scope.all && !isBrain(r)
  return (
    <span className={styles.two} onClickCapture={keepFromGrid}>
      <span className={styles.line} data-part="scope">
        {/* One "Whole market" for the scope, a dash in the other columns (re-audit N-S9). */}
        {whole
          ? (kind === 'campaigns' ? <Tag>Whole market</Tag> : <span className={styles.muted}>—</span>)
          : kind === 'adGroups' && !r.scope.adGroups.length
            ? <span className={styles.muted}>—</span>
            : <RefLinks row={r} kind={kind} set="scope" listLabel={`${REF_HEADER[kind]} ${r.name} harvests from`} returnFocus={back} />}
      </span>
      {into.length > 0 && (
        <span className={styles.subline} data-part="changed">
          <Tooltip label={INTO} portal>
            <span className={styles.mark} role="img" aria-label={INTO}><ArrowRight size={11} aria-hidden /></span>
          </Tooltip>
          <RefLinks row={r} kind={kind} set="changed" listLabel={`${REF_HEADER[kind]} ${r.name} ${INTO.toLowerCase()}`} returnFocus={back} />
        </span>
      )}
    </span>
  )
})

/**
 * The Mode cell: the DS picker, and a shield when a hold stands while it acts as set (part of its reach) or HIGHER than
 * set (a builder rule whose belt asks) — the table as honest as the detail (S19).
 */
function ModeWithHolds(p: Cell & ModeCellParams<HarvestGridRow>) {
  const m = p.data?.mode
  const holds = m ? shieldHolds(m).map(plainHold) : []
  const acts = m && m.acts !== m.set ? `Acts as ${MODE_WORD[m.acts]} · ` : ''
  const words = acts + holds.map((h) => `${holdWord(h.label)}: ${holdReason(h)}`).join(' · ')
  return (
    <span className={styles.modeCell}>
      <ModeCell {...p} />
      {holds.length > 0 && (
        <Tooltip label={words} portal>
          <span className={styles.partHold} role="img" aria-label={words}><ShieldAlert size={12} aria-hidden /></span>
        </Tooltip>
      )}
    </span>
  )
}

const Last7Cell = memo(function Last7Cell({ data, context }: Cell) {
  if (!data) return null
  const r = data.row
  const parts = harvestLast7Parts(r)
  const open = (tab: HarvestPanelTab) => () => context.current.open(r.id, tab)
  return (
    <span className={styles.chips} title={harvestLast7Text(r)} onClickCapture={keepFromGrid}>
      {parts.map((p) => (p.tab
        ? <Button key={p.key} size="xs" variant="tonal" onClick={open(p.tab)} aria-label={`${p.text}: open ${p.tab === 'waiting' ? 'the asks' : 'History'}`}>{p.text}</Button>
        : <Tag key={p.key} tone={p.tone ?? 'neutral'}>{p.text}</Tag>))}
      {r.waiting > 0 && (
        <Button size="xs" variant="warning" onClick={open('waiting')} aria-label={`${r.waiting} waiting: open them`}>{r.waiting} waiting</Button>
      )}
      {!parts.length && !r.waiting && <span className={styles.muted}>—</span>}
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
  p.context.current.open(p.data.id, harvestLast7Tab(p.data.row))
  return true
}

const EffectCell = memo(function EffectCell({ data, context }: Cell) {
  if (!data) return null
  const parts = effectParts(data.effect)
  const words = effectText(data.effect, context.current.effectDays)
  if (!parts.length) return <span className={styles.muted} title={words}>—</span>
  return (
    <span className={styles.chips} title={words}>
      {parts.map((p) => <Tag key={p.key} tone={p.tone}>{p.text}</Tag>)}
    </span>
  )
})

// ── the ⋯ menu ──────────────────────────────────────────────────────────────────────────────────────────────────────

function menuItems(g: HarvestGridRow): MenuItemDef[] {
  const h = g.h.current
  const r = g.row
  const waiting = r.waiting > 0 ? [{ id: 'waiting', label: `Waiting · ${r.waiting}`, onSelect: () => h.open(r.id, 'waiting') }] : []
  if (isBrain(r)) {
    return [
      { id: 'open', label: 'Open', onSelect: () => h.open(r.id, 'overview') },
      ...waiting,
      { id: 'history', label: 'History', onSelect: () => h.open(r.id, 'history') },
    ]
  }
  const held = h.archiveHeld
  return [
    { id: 'open', label: 'Open', onSelect: () => h.open(r.id, 'overview') },
    ...waiting,
    { id: 'preview', label: 'Preview', onSelect: () => h.open(r.id, 'preview') },
    { id: 'history', label: 'History', onSelect: () => h.open(r.id, 'history') },
    { id: 'edit', label: 'Edit…', disabled: !!held || r.archived, description: held ?? (r.archived ? 'Archived: restore it first' : undefined), onSelect: () => h.edit(r) },
    r.archived
      ? { id: 'restore', label: 'Restore…', disabled: !!held, description: held ?? undefined, onSelect: () => h.restore(r) }
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

// Widths at 1440 (card 1312 px): checkbox 44 + 352 + 150 + 120 + 150 + 120 + Last 7 d (≥ 150) + 160 + 56 ≈ 1310 — the rule's
// line is not cut while the card has room (re-audit S14).
const RULE: ColDef<HarvestGridRow> = {
  colId: 'rule', headerName: 'Rule', pinned: 'left', width: 352, minWidth: 200,
  valueGetter: (p) => p.data?.row.name ?? '',
  getQuickFilterText: (p) => (p.data ? `${p.data.row.name} ${ruleLine(p.data.row.sentence)}` : ''),
  cellRenderer: RuleCell,
}

/** The four steps; Auto's line names the Owner's D2 caps (the exact number is in the rule's Overview). */
const MODE_BASE = modeColumn<HarvestGridRow>('mode', {
  header: 'Mode',
  steps: harvestSteps(null),
  value: (g) => (g.mode.heldBy ? { ...g.mode, heldBy: plainHold(g.mode.heldBy) } : g.mode),
  heldOption: (g, step) => harvestHeldStep(g.row, step),
  lockReason: (g) => (isBrain(g.row) ? BRAIN_HARVEST_LOCK : modeLock(g.row)),
  pending: (g) => g.pending,
})
const MODE: ColDef<HarvestGridRow> = {
  ...MODE_BASE,
  cellRenderer: ModeWithHolds,
  width: 150,
  headerTooltip: 'Off · Watch · Ask me · Auto (it harvests by itself, inside its caps). Arrow or shield: held back — hover for why.',
}

const refColumn = (kind: RefKind, width: number): ColDef<HarvestGridRow> => {
  const base = entityLinksColumn<HarvestGridRow>(kind, { header: REF_HEADER[kind], noun: REF_NOUN[kind], linkAs: WorkspaceLink })
  return {
    ...base,
    field: undefined,
    colId: kind,
    valueGetter: (p) => p.data?.row.scope[kind] ?? [],
    cellRenderer: WorksOnCell,
    cellRendererParams: { kind },
    suppressKeyboardEvent: worksOnKeys as ColDef<HarvestGridRow>['suppressKeyboardEvent'],
    width,
    headerTooltip: `Top: the ${REF_NOUN[kind].many} it harvests from. Under the arrow: where it harvested into · ${LAST_WEEK.toLowerCase()}.`,
  }
}
const PORTFOLIOS = refColumn('portfolios', 120)
const CAMPAIGNS = refColumn('campaigns', 150)
const AD_GROUPS = refColumn('adGroups', 120)

const LAST7: ColDef<HarvestGridRow> = {
  colId: 'last7', headerName: LAST_WEEK, flex: 1, minWidth: 150,
  valueGetter: (p) => (p.data ? keywords7d(p.data.row) + p.data.row.last7d.asks : 0),
  valueFormatter: (p) => (p.data ? harvestLast7Text(p.data.row) : ''),
  getQuickFilterText: (p) => (p.data ? harvestLast7Text(p.data.row) : ''),
  cellRenderer: Last7Cell,
  suppressKeyboardEvent: last7Keys as ColDef<HarvestGridRow>['suppressKeyboardEvent'],
  headerTooltip: 'Keywords it harvested, asks it made and those applied, refusals. A blue chip opens its History or asks.',
}

const EFFECT: ColDef<HarvestGridRow> = {
  colId: 'effect', headerName: 'Effect', width: 160,
  valueGetter: (p) => effectScore(p.data?.effect),
  valueFormatter: (p) => (p.data ? effectText(p.data.effect, p.context?.current?.effectDays ?? 30) : ''),
  cellRenderer: EffectCell,
  headerTooltip: 'Its harvests, judged after the attribution window + 72 h: Better · Worse · Too early.',
}

const LAST_RUN: ColDef<HarvestGridRow> = {
  colId: 'lastRun', headerName: 'Last run', width: 120, hide: true,
  valueGetter: (p) => p.data?.row.lastRunAt ?? null,
  valueFormatter: (p) => relWords(p.value as string | null),
}
const NEXT_RUN: ColDef<HarvestGridRow> = {
  colId: 'nextRun', headerName: 'Next run', width: 120, hide: true,
  valueGetter: (p) => p.data?.row.nextRunAt ?? null,
  valueFormatter: (p) => relWords(p.value as string | null),
}
const MARKET: ColDef<HarvestGridRow> = {
  colId: 'market', headerName: 'Market', width: 110, hide: true,
  valueGetter: (p) => p.data?.row.market ?? 'All',
}

const ACTIONS: ColDef<HarvestGridRow> = {
  ...actionsColumn<HarvestGridRow>({ items: menuItems, menuLabel: (g) => `Actions for ${g.row.name}` }),
  suppressKeyboardEvent: actionsKeys as ColDef<HarvestGridRow>['suppressKeyboardEvent'],
}
/** A phone has no room for a second pinned column (`pinned: null`, not just absent: AG keeps a column's pinned state). */
const PHONE_ACTIONS: ColDef<HarvestGridRow> = { ...ACTIONS, pinned: null, lockPinned: false }

export const HARVEST_RULE_COLUMNS: ColDef<HarvestGridRow>[] = [RULE, MODE, PORTFOLIOS, CAMPAIGNS, AD_GROUPS, LAST7, EFFECT, LAST_RUN, NEXT_RUN, MARKET, ACTIONS]
export const HARVEST_RULE_PHONE_COLUMNS: ColDef<HarvestGridRow>[] = [
  { ...RULE, width: 132, minWidth: 120 }, { ...MODE, width: 132 }, { ...LAST7, flex: undefined, width: 170 }, EFFECT, CAMPAIGNS, PORTFOLIOS, AD_GROUPS, LAST_RUN, NEXT_RUN, MARKET, PHONE_ACTIONS,
]

/** The columns Customise lists (the ⋯ column is not one of them). */
export const HARVEST_RULE_PREFERENCE_COLUMNS: ReadonlyArray<{ key: string; label: string; locked?: boolean; hidden?: boolean }> = [
  { key: 'rule', label: 'Rule', locked: true },
  { key: 'mode', label: 'Mode', locked: true },
  { key: 'portfolios', label: 'Portfolios' },
  { key: 'campaigns', label: 'Campaigns' },
  { key: 'adGroups', label: 'Ad groups' },
  { key: 'last7', label: LAST_WEEK },
  { key: 'effect', label: 'Effect' },
  { key: 'lastRun', label: 'Last run', hidden: true },
  { key: 'nextRun', label: 'Next run', hidden: true },
  { key: 'market', label: 'Market', hidden: true },
]

const ROW_ID: NonNullable<NexusGridProps<HarvestGridRow>['getRowId']> = (p) => p.data.id
const SELECTION = gridSelection<HarvestGridRow>({ selectAll: 'filtered', isRowSelectable: (n) => !n.rowPinned && !!n.data && !isBrain(n.data.row) }) as NexusGridProps<HarvestGridRow>['rowSelection']

export function HarvestRulesTable(p: {
  rows: HarvestGridRow[]
  brain: HarvestGridRow | null
  context: HarvestHandlersRef
  phone: boolean
  selectable: boolean
  noRowsParams: NexusGridProps<HarvestGridRow>['noRowsOverlayComponentParams']
  initialState: NexusGridProps<HarvestGridRow>['initialState']
  columnDialog: NexusGridProps<HarvestGridRow>['columnDialog']
  onGridReady: NonNullable<NexusGridProps<HarvestGridRow>['onGridReady']>
  onRowClicked: NonNullable<NexusGridProps<HarvestGridRow>['onRowClicked']>
  onCellKeyDown: NonNullable<NexusGridProps<HarvestGridRow>['onCellKeyDown']>
  onSelectionChanged: NonNullable<NexusGridProps<HarvestGridRow>['onSelectionChanged']>
}) {
  return (
    <NexusGrid<HarvestGridRow>
      domLayout="autoHeight"
      rowClass={styles.clickRow}
      suppressCellFocus={false}
      rowData={p.rows}
      pinnedTopRowData={p.brain ? [p.brain] : undefined}
      getRowId={ROW_ID}
      columnDefs={p.phone ? HARVEST_RULE_PHONE_COLUMNS : HARVEST_RULE_COLUMNS}
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
