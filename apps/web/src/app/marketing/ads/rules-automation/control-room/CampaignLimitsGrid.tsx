'use client'

/**
 * CR rebuild 5 — the Campaigns grid: one row per campaign, what automation may touch on it. Reads the stored values
 * and the person's unsaved draft; it never writes. The toggle in "May change it" changes the DRAFT only (the Review
 * step saves it), and a row click opens the campaign's own side panel.
 *
 * Stable grid options (GDS decision 12): the columns are module constants (one set for a desktop, one for a phone);
 * the cells read what they need from the row (`GridRow`) and the page's handlers from AG's `context`, a ref that never
 * changes identity. The campaign name is pinned left, so on a phone the name and its switch stay in view (CR review).
 * Without the ads campaigns permission the grid is read-only: no switch, no row boxes (the server refuses the writes).
 */
import { memo } from 'react'
import { Tag, Toggle } from '@/design-system/primitives'
import {
  GridLoadingOverlay, GridNoRowsOverlay, NexusGrid, gridSelection, keepFromGrid,
  type ColDef, type ICellRendererParams, type NexusGridProps,
} from '@/design-system/grid'
import {
  CEILING_WORD, currencyOf, lockedWords, moneyWords, suppressedWords,
  type CampaignEdit, type CampaignRow, type CampaignValues,
} from './campaignDraft'
import styles from './campaigns.module.css'

/** A grid row: the stored campaign, the person's edit (if any) and the values after it. */
export interface GridRow {
  id: string
  row: CampaignRow
  edit: CampaignEdit | undefined
  values: CampaignValues
}

export interface GridHandlers {
  /** False without the ads campaigns permission: the cells only show the values. */
  canEdit: boolean
  setAllowed(row: CampaignRow, allowed: boolean): void
}
export interface HandlersRef { readonly current: GridHandlers }

type Cell = ICellRendererParams<GridRow> & { context: HandlersRef }

/** "€0.20 → €0.30" when the draft changes it, else the stored value. */
function Changed({ before, after, changed }: { before: string; after: string; changed: boolean }) {
  if (!changed) return <>{before}</>
  return (
    <span className={styles.changed} title={`Not saved yet: ${before} → ${after}`}>
      <span className={styles.before}>{before}</span> → <strong>{after}</strong>
    </span>
  )
}

const NameCell = memo(function NameCell({ data }: Cell) {
  if (!data) return null
  const r = data.row
  const sub = [r.marketplace ?? 'No market', r.portfolioName, r.status !== 'ENABLED' ? r.status.toLowerCase() : null].filter(Boolean).join(' · ')
  return (
    <span className={styles.cell}>
      <span className={styles.cellMain} title={r.name}>{r.name}</span>
      <span className={styles.cellSub}>{sub}</span>
    </span>
  )
})

const AllowedCell = memo(function AllowedCell({ data, context }: Cell) {
  if (!data) return null
  const on = data.values.allowed
  if (!context.current.canEdit) return <span>{on ? 'Yes' : 'No'}</span>
  return (
    <span className={styles.inline} onClickCapture={keepFromGrid}>
      <Toggle
        size="xs"
        checked={on}
        aria-label={`Automation may change ${data.row.name}`}
        title={on ? 'Automation may change this campaign.' : 'Every automated change to this campaign is refused.'}
        onChange={(next) => context.current.setAllowed(data.row, next)}
      />
      <span>{on ? 'Yes' : 'No'}</span>
      {data.edit?.allowed !== undefined && <Tag tone="info">Not saved</Tag>}
    </span>
  )
})

const moneyCell = (key: 'minBidCents' | 'maxBidCents') => memo(function MoneyCell({ data }: Cell) {
  if (!data) return null
  const cur = currencyOf(data.row.marketplace)
  return (
    <Changed
      before={moneyWords(data.row[key], cur)}
      after={moneyWords(data.values[key], cur)}
      changed={data.edit?.[key] !== undefined}
    />
  )
})
const MinCell = moneyCell('minBidCents')
const MaxCell = moneyCell('maxBidCents')

const multipleWords = (m: number | null) => (m == null ? '—' : `${m} ×`)
const CeilingCell = memo(function CeilingCell({ data }: Cell) {
  if (!data) return null
  const before = data.row.cpcCeiling?.enabled ? data.row.cpcCeiling.multiple : null
  return <Changed before={multipleWords(before)} after={multipleWords(data.values.cpcMultiple)} changed={data.edit?.cpcMultiple !== undefined} />
})

const LockedCell = memo(function LockedCell({ data }: Cell) {
  if (!data) return null
  return <Changed before={lockedWords(data.row.pins)} after={lockedWords(data.values.pins)} changed={!!data.edit?.pins} />
})

const RulesCell = memo(function RulesCell({ data }: Cell) {
  if (!data) return null
  const rules = data.row.boundRules
  if (!rules.length) return <span className={styles.muted}>—</span>
  return <span title={rules.map((r) => r.name).join('\n')}>{rules.length}</span>
})

const NAME: ColDef<GridRow> = { colId: 'name', headerName: 'Campaign', valueGetter: (p) => p.data?.row.name ?? '', pinned: 'left', width: 260, cellRenderer: NameCell }
const ALLOWED: ColDef<GridRow> = { colId: 'allowed', headerName: 'Automation may change it', valueGetter: (p) => (p.data?.values.allowed ? 1 : 0), width: 210, cellRenderer: AllowedCell }
const REST: ColDef<GridRow>[] = [
  { colId: 'min', headerName: 'Lowest bid', valueGetter: (p) => p.data?.values.minBidCents ?? null, width: 130, cellRenderer: MinCell, headerTooltip: 'Every engine and rule keeps bids at or above it. Checked on every change sent to Amazon.' },
  { colId: 'max', headerName: 'Highest bid', valueGetter: (p) => p.data?.values.maxBidCents ?? null, width: 130, cellRenderer: MaxCell, headerTooltip: 'Every engine and rule keeps bids at or below it. Placement adjustments can still raise the cost per click above it.' },
  { colId: 'ceiling', headerName: CEILING_WORD, valueGetter: (p) => p.data?.values.cpcMultiple ?? null, width: 250, cellRenderer: CeilingCell, headerTooltip: 'A multiple of the usual click cost. It limits your own bid edits and Claude’s tools only — not the engines. It does nothing for a keyword with no history.' },
  { colId: 'locked', headerName: 'Locked', valueGetter: (p) => (p.data ? lockedWords(p.data.values.pins) : ''), width: 150, cellRenderer: LockedCell, headerTooltip: 'Automation may not change a locked part: placement adjustments, bids or the daily budget. Lowering bids to stop a campaign is still allowed.' },
  { colId: 'acos', headerName: 'Target ACoS', valueGetter: (p) => p.data?.row.targetAcosPct ?? null, width: 140, valueFormatter: (p) => (p.value == null ? 'None of its own' : `${p.value} %`), headerTooltip: 'The campaign’s own target. With none of its own, the strategy’s target (or the account’s) applies.' },
  { colId: 'budget', headerName: 'Budget a day', valueGetter: (p) => p.data?.row.dailyBudgetCents ?? null, width: 130, valueFormatter: (p) => moneyWords((p.value as number | null) ?? null, currencyOf(p.data?.row.marketplace ?? null)) },
  { colId: 'suppressed', headerName: 'Bids held low', valueGetter: (p) => (p.data ? suppressedWords(p.data.row) : ''), flex: 1, minWidth: 160 },
  { colId: 'rules', headerName: 'Its own rules', valueGetter: (p) => p.data?.row.boundRules.length ?? 0, width: 130, cellRenderer: RulesCell, headerTooltip: 'Rules limited to this campaign only.' },
]
const COLUMNS: ColDef<GridRow>[] = [NAME, ALLOWED, ...REST]
/** A phone: a narrower pinned name and a short header for the switch, so both fit beside each other. */
const PHONE_COLUMNS: ColDef<GridRow>[] = [
  { ...NAME, width: 150 },
  { ...ALLOWED, headerName: 'May change it', headerTooltip: 'Automation may change it', width: 130 },
  ...REST,
]

const ROW_ID: NonNullable<NexusGridProps<GridRow>['getRowId']> = (p) => p.data.id
const SELECTION = gridSelection<GridRow>({ selectAll: 'filtered' }) as NexusGridProps<GridRow>['rowSelection']
const LOADING_PARAMS = { rows: 8 }

export function CampaignLimitsGrid({ rows, loading, context, canEdit, phone, noRowsParams, onRowClicked, onCellKeyDown, onSelectionChanged }: {
  rows: GridRow[]
  /** Without the ads campaigns permission: no row boxes (and the cells show values only, through `context`). */
  canEdit: boolean
  phone: boolean
  loading: boolean
  context: HandlersRef
  noRowsParams: NexusGridProps<GridRow>['noRowsOverlayComponentParams']
  onRowClicked: NonNullable<NexusGridProps<GridRow>['onRowClicked']>
  onCellKeyDown: NonNullable<NexusGridProps<GridRow>['onCellKeyDown']>
  onSelectionChanged: NonNullable<NexusGridProps<GridRow>['onSelectionChanged']>
}) {
  return (
    <NexusGrid<GridRow>
      domLayout="autoHeight"
      suppressCellFocus={false}
      rowData={rows}
      getRowId={ROW_ID}
      columnDefs={phone ? PHONE_COLUMNS : COLUMNS}
      rowSelection={canEdit ? SELECTION : undefined}
      context={context}
      loading={loading}
      loadingOverlayComponent={GridLoadingOverlay}
      loadingOverlayComponentParams={LOADING_PARAMS}
      noRowsOverlayComponent={GridNoRowsOverlay}
      noRowsOverlayComponentParams={noRowsParams}
      onRowClicked={onRowClicked}
      onCellKeyDown={onCellKeyDown}
      onSelectionChanged={onSelectionChanged}
    />
  )
}
