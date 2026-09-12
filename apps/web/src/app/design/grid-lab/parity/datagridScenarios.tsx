'use client'

/**
 * AGL — every prop of `DataGridProps`, as scenarios. Same discipline as the workspace file: one props
 * set per scenario, built by one hook, rendered by both engines; per-side state lives in the hook.
 */
import { useCallback, useMemo, useState, type HTMLAttributes, type ReactNode } from 'react'
import { Button, Input } from '@/design-system/primitives'
import { EmptyState } from '@/design-system/components'
import type { Column, DataGridProps } from '@/design-system/components'

import type { DataGridEngine, ParityEngines, Side } from './engines'
import { Pair } from './Pair'
import {
  DG_COLUMNS, DG_EXPANDED_INITIAL, DG_PREFS_SORT_FIELDS, DG_SELECTED_INITIAL, GET_SUB_ROWS, NO_ROWS, ROWS_12, ROWS_24, ROWS_36, ROW_ID,
  renderExpandedPanel, type ParityRow,
} from './fixture'

type DgProps = DataGridProps<ParityRow>
interface SideBuild { props: DgProps; above?: ReactNode }
type UseSide = (side: Side) => SideBuild

const BASE = { columns: DG_COLUMNS, rowKey: ROW_ID, ariaLabel: 'Advertising comparison grid' } as const
const EMPTY_SET = new Set<string>()
const noop = () => {}

function DgSide({ Engine, side, useSide }: { Engine: DataGridEngine; side: Side; useSide: UseSide }) {
  const { props, above } = useSide(side)
  return <>{above}<Engine {...props} /></>
}

function DgPair({ id, title, note, engines, useSide, exempt }: { id: string; title: string; note?: ReactNode; engines: ParityEngines; useSide: UseSide; exempt?: string[] }) {
  return (
    <Pair
      id={id}
      kind="datagrid"
      title={title}
      note={note}
      exempt={exempt}
      legacy={engines.legacyDataGrid ? <DgSide Engine={engines.legacyDataGrid} side="legacy" useSide={useSide} /> : null}
      ag={engines.agDataGrid ? <DgSide Engine={engines.agDataGrid} side="ag" useSide={useSide} /> : null}
    />
  )
}

function useSelection(initial: Set<string> = EMPTY_SET) {
  const [selected, setSelected] = useState<Set<string>>(initial)
  return { selected, setSelected }
}
function useExpanded(initial: Set<string> = EMPTY_SET) {
  const [expanded, setExpanded] = useState<Set<string>>(initial)
  // Row click toggles: the caret is the CALLER's, and here the whole row is the caret (rowProps).
  const rowProps = useCallback((r: ParityRow): HTMLAttributes<HTMLTableRowElement> => (r.parentId ? {} : {
    onClick: () => setExpanded((s) => { const n = new Set(s); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n }),
    title: 'Click to expand',
    style: { cursor: 'pointer' },
  }), [])
  return { expanded, rowProps }
}

/* ── the scenarios ───────────────────────────────────────────────────────────────────────────── */

const SORT_SPEND_DESC = { key: 'spend', dir: 'desc' } as const

/** D1 — the base: sticky identity, numeric figures, totals, a right-pinned actions column, a wrapper class. */
function useBase(): SideBuild {
  const props = useMemo<DgProps>(() => ({ ...BASE, rows: ROWS_36, initialSort: SORT_SPEND_DESC, showTotals: true, className: 'lab-dg' }), [])
  return { props }
}

/** D2 — selection: two pre-selected, archived rows not selectable, hints on every checkbox. */
const rowSelectable = (r: ParityRow) => r.status !== 'ARCHIVED'
function useSelectable(): SideBuild {
  const { selected, setSelected } = useSelection(DG_SELECTED_INITIAL)
  const props = useMemo<DgProps>(() => ({
    ...BASE, rows: ROWS_24, selectable: true, selected, onSelectedChange: setSelected, rowSelectable,
    rowSelectableHint: 'Archived campaigns cannot be selected', selectAllHint: 'Select every selectable campaign', selectRowHint: 'Select this campaign',
  }), [selected, setSelected])
  return { props }
}

/** D3 — renderExpanded + expanded (controlled): a full-width panel beneath two rows. */
function useExpandedPanel(): SideBuild {
  const { expanded, rowProps } = useExpanded(DG_EXPANDED_INITIAL)
  const props = useMemo<DgProps>(() => ({ ...BASE, rows: ROWS_12, renderExpanded: renderExpandedPanel, expanded, rowProps }), [expanded, rowProps])
  return { props }
}

/** D4 — getSubRows + subRowSelectable: children as REAL rows under the same columns, with their own checkboxes. */
function useSubRows(): SideBuild {
  const { expanded, rowProps } = useExpanded(DG_EXPANDED_INITIAL)
  const { selected, setSelected } = useSelection()
  const props = useMemo<DgProps>(() => ({
    ...BASE, rows: ROWS_12, getSubRows: GET_SUB_ROWS, expanded, rowProps, selectable: true, selected, onSelectedChange: setSelected, subRowSelectable: true,
  }), [expanded, rowProps, selected, setSelected])
  return { props }
}

/** D5 — rowProps / cellProps / headerProps with data-* and titles; rowClassName on archived rows. */
const rowPropsData = (r: ParityRow): HTMLAttributes<HTMLTableRowElement> => ({ 'data-item': r.id, title: r.name } as HTMLAttributes<HTMLTableRowElement>)
const cellPropsData = (r: ParityRow, c: Column<ParityRow>, i: number): HTMLAttributes<HTMLTableCellElement> => ({ 'data-item': r.id, 'data-col': c.key, 'data-index': String(i) } as HTMLAttributes<HTMLTableCellElement>)
const headerPropsData = (c: Column<ParityRow>, i: number): HTMLAttributes<HTMLTableCellElement> => ({ 'data-col': c.key, 'data-index': String(i), title: `Column ${c.key}` } as HTMLAttributes<HTMLTableCellElement>)
const rowClassName = (r: ParityRow) => (r.status === 'ARCHIVED' ? 'lab-archived' : undefined)
function useRowProps(): SideBuild {
  const props = useMemo<DgProps>(() => ({ ...BASE, rows: ROWS_24, rowProps: rowPropsData, cellProps: cellPropsData, headerProps: headerPropsData, rowClassName }), [])
  return { props }
}

/** D6–D9 — the density tiers around the default. */
const useSize = (size: DgProps['size']) => (): SideBuild => {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const props = useMemo<DgProps>(() => ({ ...BASE, rows: ROWS_12, size, showTotals: true }), [])
  return { props }
}
const useSizeSm = useSize('sm')
const useSizeLg = useSize('lg')
const useSizeXs = useSize('xs')
const useSizeXl = useSize('xl')

/** D10 — maxHeight: a bounded, scrolling grid whose header and totals stay pinned. */
function useMaxHeight(): SideBuild {
  const { selected, setSelected } = useSelection()
  const props = useMemo<DgProps>(() => ({ ...BASE, rows: ROWS_36, maxHeight: 280, showTotals: true, selectable: true, selected, onSelectedChange: setSelected }), [selected, setSelected])
  return { props }
}

/** D11 — empty with the consumer's node. */
const emptyState = <EmptyState title="No rows" description="Nothing to show for this scope." action={<Button size="sm" onClick={noop}>Reset filters</Button>} />
function useEmpty(): SideBuild {
  const props = useMemo<DgProps>(() => ({ ...BASE, rows: NO_ROWS, emptyState, showTotals: true }), [])
  return { props }
}

/** D12 — customizable + storageKey + customizeTitle + prefsSortFields; groups, prefsLabel and prefsLocked come from the columns. */
function useCustomizable(side: Side): SideBuild {
  const props = useMemo<DgProps>(() => ({ ...BASE, rows: ROWS_24, customizable: true, storageKey: `lab:parity:dg:custom:${side}`, customizeTitle: 'Customise columns', prefsSortFields: DG_PREFS_SORT_FIELDS }), [side])
  return { props }
}

/** D13 — controlled sort + controlled Customise dialog: the page owns both and hosts its own trigger. */
function useControlled(): SideBuild {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>({ key: 'sales', dir: 'asc' })
  const [open, setOpen] = useState(false)
  const onSortChange = useCallback((next: { key: string; dir: 'asc' | 'desc' }) => setSort(next), [])
  const props = useMemo<DgProps>(() => ({
    ...BASE, rows: ROWS_24, sort, onSortChange, customizable: true, storageKey: 'lab:parity:dg:controlled', customizeOpen: open, onCustomizeOpenChange: setOpen,
  }), [sort, onSortChange, open])
  const above = (
    <div className="nds-type-sm" style={{ display: 'flex', gap: 10, alignItems: 'center', color: 'var(--nds-text-2)' }}>
      <span>sort: <b>{sort ? `${sort.key} ${sort.dir}` : 'none'}</b></span>
      <Button size="sm" onClick={() => setSort(null)}>Clear sort</Button>
      <Button size="sm" onClick={() => setOpen(true)}>Customise…</Button>
    </div>
  )
  return { props, above }
}

/** Cells that commit on blur must keep focus when the parent rebuilds columns and row classes. */
function useInlineEdit(): SideBuild {
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [commits, setCommits] = useState(0)
  const columns: Column<ParityRow>[] = [
    { key: 'name', label: 'Campaign', render: (r) => r.name },
    { key: 'budget', label: 'Draft budget', render: (r) => <Input size="sm" aria-label={`Draft budget ${r.id}`} value={draft[r.id] ?? String(r.budget)} onChange={(e) => setDraft((d) => ({ ...d, [r.id]: e.target.value }))} onBlur={() => setCommits((n) => n + 1)} /> },
  ]
  return {
    props: { ...BASE, columns, rows: ROWS_12, rowClassName: (r) => draft[r.id] == null ? undefined : 'lab-draft' },
    above: <div>Blur commits: {commits} <Button size="sm" onClick={() => setDraft({})}>Reset draft</Button></div>,
  }
}

/* ── the list ────────────────────────────────────────────────────────────────────────────────── */

export interface DgScenarioDef { id: string; title: string; note?: ReactNode; useSide: UseSide; exempt?: string[] }

export const DG_SCENARIOS: DgScenarioDef[] = [
  { id: 'dg-inline-edit', title: 'Inline input focus through parent updates', note: 'Typing rebuilds columns and changes the row class. A blur commits only when focus leaves the input. All values are local fixtures.', useSide: useInlineEdit, exempt: ['totals'] },
  { id: 'dg-base', title: 'Base — initialSort Spend ↓ · numeric · showTotals · sticky identity (260) · stickyRight actions (112) · className', note: 'Sort ACoS in both: the legacy DataGrid does not sink blanks (−∞), so the AG one must not either — parity is with the legacy, not with the workspace grid.', useSide: useBase },
  { id: 'dg-selection', title: 'selectable + selected + rowSelectable + hints', note: 'Two rows pre-selected; archived rows show a disabled checkbox and are left out of select-all.', useSide: useSelectable },
  { id: 'dg-expanded', title: 'renderExpanded + expanded (controlled)', note: 'Click a row to toggle its panel — the caret is the caller’s; here the row is the caret.', useSide: useExpandedPanel, exempt: ['totals'] },
  { id: 'dg-sub-rows', title: 'getSubRows + subRowSelectable', note: 'Children are real rows under the same columns, tinted, with their own checkboxes counted by select-all while open.', useSide: useSubRows, exempt: ['totals'] },
  { id: 'dg-row-props', title: 'rowProps · cellProps · headerProps (data-* + title) · rowClassName', note: 'Read the attributes back off the DOM — that is what the drag code does.', useSide: useRowProps, exempt: ['totals'] },
  { id: 'dg-size-sm', title: 'size sm', useSide: useSizeSm },
  { id: 'dg-size-lg', title: 'size lg', useSide: useSizeLg },
  { id: 'dg-size-xs', title: 'size xs', useSide: useSizeXs },
  { id: 'dg-size-xl', title: 'size xl', useSide: useSizeXl },
  { id: 'dg-max-height', title: 'maxHeight 280 — bounded, header and totals pinned', useSide: useMaxHeight },
  { id: 'dg-empty', title: 'emptyState — the consumer’s node', useSide: useEmpty, exempt: ['totals'] },
  { id: 'dg-customizable', title: 'customizable + storageKey + customizeTitle + prefsSortFields · group / prefsLabel / prefsLocked', note: 'Each engine has its own lab storage key so the frozen reader cannot overwrite the new grouped layout. ACoS starts locked; the actions column is named by prefsLabel.', useSide: useCustomizable, exempt: ['totals'] },
  { id: 'dg-controlled', title: 'sort + onSortChange (controlled) · customizeOpen + onCustomizeOpenChange', note: 'Opens sorted by Sales ↑ from page state; the page hosts the Customise trigger.', useSide: useControlled, exempt: ['totals'] },
]

export function DataGridScenarios({ engines, scenario = 'all' }: { engines: ParityEngines; scenario?: string }) {
  return <>{DG_SCENARIOS.filter((s) => scenario === 'all' || s.id === scenario).map((s) => <DgPair key={s.id} id={s.id} title={s.title} note={s.note} engines={engines} useSide={s.useSide} exempt={s.exempt} />)}</>
}
