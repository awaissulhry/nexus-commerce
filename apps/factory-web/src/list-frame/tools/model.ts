import type { ColDef } from '@nexus/ui/grid'
import type { PreferencesColumnSpec, PreferencesValue } from '@nexus/ui/patterns'
import type { ExportStatus } from '@nexus/factory-domain/views/exports'
import { normaliseState, sameState, type ColumnLayout, type Density, type ViewState } from '@nexus/factory-domain/views/state'
import type { ExportColumn, ExportJob, SavedView, WorkingLayout } from './transport'

/**
 * The list tools' rules (B-W2a-23; PLT-163, PLT-179), pure: which columns a person may arrange, a layout applied to the
 * frame's columns, the Customise dialog's value both ways, what a view keeps of the screen, whether the screen still
 * shows the view it opened, the columns an export writes, and the words of a job. Every list uses them through the ONE
 * frame, so a list built later gets them without work of its own.
 */

/** AG's own selection column: never arranged, never exported. */
export const SELECTION_COLUMN = 'ag-Grid-SelectionColumn'

/** A column the tools know: its id, its heading, and whether it may be hidden or moved. */
export interface ToolColumn {
  readonly id: string
  readonly label: string
  /** `first`: the row's name, always shown (it may move); `end`: a trailing ⋯ column pinned right, never moved or exported. */
  readonly fixed: 'first' | 'end' | null
  /**
   * B-TH-241 (SHEET-G04): a column hidden until a layout shows it (a custom field's `cf:` column, ColDef `context.optIn`): it is
   * shown only while the layout names it in its order and does not hide it, so a list as built and every view saved before it
   * existed keep their columns.
   */
  readonly optIn?: boolean
}

// ── B-TH-241: a column's tools facts from its ColDef context (opt-in, and its name in Customise) ──
const contextOf = (column: ColDef<unknown>): { optIn?: unknown; toolLabel?: unknown } => (column.context as { optIn?: unknown; toolLabel?: unknown } | undefined) ?? {}
/** An opt-in column (hidden until a layout shows it). */
export const isOptIn = (column: ColDef<unknown>): boolean => contextOf(column).optIn === true
// ── end B-TH-241 ──

/** A column's id as AG reads it: its colId, else its field. Null: the tools leave it alone. */
export function columnIdOf(column: ColDef<unknown>): string | null {
  if (typeof column.colId === 'string' && column.colId !== '') return column.colId
  return typeof column.field === 'string' && column.field !== '' ? column.field : null
}

/** The columns the tools know, in the frame's order. */
export function toolColumnsOf(columns: readonly ColDef<unknown>[]): ToolColumn[] {
  const known = columns.filter((column) => {
    const id = columnIdOf(column)
    return id !== null && id !== SELECTION_COLUMN
  })
  return known.map((column, index) => {
    const id = columnIdOf(column)!
    // B-TH-241: a column may name itself apart in Customise ("Heat number (custom field)").
    const toolLabel = contextOf(column).toolLabel
    const label = typeof toolLabel === 'string' && toolLabel.trim() !== '' ? toolLabel : typeof column.headerName === 'string' && column.headerName.trim() !== '' ? column.headerName : id
    const fixed = column.pinned === 'right' && index === known.length - 1 ? 'end' : index === 0 ? 'first' : null
    return { id, label, fixed, ...(isOptIn(column) && fixed === null ? { optIn: true } : {}) }
  })
}

/** A layout as the frame applies it: only the ids the list still has; the row's name and the ⋯ column never hidden. */
export function cleanLayout(layout: ColumnLayout | undefined, tools: readonly ToolColumn[]): ColumnLayout | undefined {
  if (!layout) return undefined
  const ids = new Set(tools.map((column) => column.id))
  const keepable = new Set(tools.filter((column) => column.fixed === null).map((column) => column.id))
  const movable = new Set(tools.filter((column) => column.fixed !== 'end').map((column) => column.id))
  const order = layout.order.filter((id) => movable.has(id))
  const hidden = layout.hidden.filter((id) => keepable.has(id))
  const pinned = layout.pinned.filter((id) => movable.has(id) && ids.has(id) && !hidden.includes(id))
  return order.length + hidden.length + pinned.length > 0 ? { order, hidden, pinned } : undefined
}

/**
 * The frame's columns with a layout: the ordered ones first (in its order), the others after them as the list placed
 * them; hidden ones `hide`; the frozen ones pinned left (the list's own left pins give way to the layout's); a ⋯ column
 * pinned right stays where it is.
 */
export function applyLayout<T>(columns: readonly ColDef<T>[], layout: ColumnLayout | undefined): ColDef<T>[] {
  const tools = toolColumnsOf(columns as readonly ColDef<unknown>[])
  const clean = cleanLayout(layout, tools)
  if (!clean) return [...columns]
  const position = new Map(clean.order.map((id, index) => [id, index]))
  const hidden = new Set(clean.hidden)
  const pinned = new Set(clean.pinned)
  const indexed = columns.map((column, index) => ({ column, index, id: columnIdOf(column as ColDef<unknown>) }))
  const ordered = [...indexed].sort((a, b) => {
    const pa = a.id !== null && position.has(a.id) ? position.get(a.id)! : clean.order.length + a.index
    const pb = b.id !== null && position.has(b.id) ? position.get(b.id)! : clean.order.length + b.index
    return pa - pb
  })
  // B-TH-241: an opt-in column shows only while the layout orders it and does not hide it.
  const inOrder = new Set(clean.order)
  return ordered.map(({ column, id }) => {
    if (id === null || column.pinned === 'right') return column
    const next: ColDef<T> = { ...column }
    if (isOptIn(column as ColDef<unknown>)) next.hide = !inOrder.has(id) || hidden.has(id)
    else if (hidden.has(id)) next.hide = true
    if (pinned.has(id)) next.pinned = 'left'
    else if (column.pinned === 'left' && clean.pinned.length > 0) next.pinned = null
    return next
  })
}

/** The Customise dialog's columns: the row's name always shown, the ⋯ column locked at the right edge. */
export function preferenceColumnsOf(tools: readonly ToolColumn[]): PreferencesColumnSpec[] {
  return tools.map((column) => ({
    key: column.id,
    label: column.label,
    ...(column.fixed === 'first' ? { alwaysShown: true } : {}),
    ...(column.fixed === 'end' ? { locked: true, lockSide: 'right' as const } : {}),
  }))
}

/** The dialog's value of a layout. */
export function preferencesOf(tools: readonly ToolColumn[], layout: ColumnLayout | undefined): PreferencesValue {
  const clean = cleanLayout(layout, tools)
  const order = clean ? [...clean.order, ...tools.map((column) => column.id).filter((id) => !clean.order.includes(id))] : tools.map((column) => column.id)
  const hidden = new Set(clean?.hidden ?? [])
  // B-TH-241: an opt-in column is in view only while the layout orders it.
  const ordered = new Set(clean?.order ?? [])
  for (const column of tools) if (column.optIn && !ordered.has(column.id)) hidden.add(column.id)
  return {
    visibleColumns: order.filter((id) => !hidden.has(id)),
    lockedColumns: [...(clean?.pinned ?? [])],
    columnOrder: order,
    stickyFirstColumn: false,
    stickyLastColumn: false,
    pageSize: 50,
    sortBy: '',
    sortDir: 'asc',
  }
}

/** The layout the dialog chose (only what differs from the list as built is kept). */
export function layoutOfPreferences(tools: readonly ToolColumn[], value: PreferencesValue): ColumnLayout | undefined {
  const all = tools.map((column) => column.id)
  const visible = new Set(value.visibleColumns)
  const order = (value.columnOrder ?? value.visibleColumns).filter((id) => all.includes(id))
  const fullOrder = [...order, ...all.filter((id) => !order.includes(id))]
  // B-TH-241: an opt-in column in view is kept by naming it in the order (one not in view is simply left out of it).
  const optIn = new Set(tools.filter((column) => column.optIn).map((column) => column.id))
  const optInShown = [...optIn].some((id) => visible.has(id))
  const sameOrder = !optInShown && fullOrder.filter((id) => !optIn.has(id)).every((id, index) => id === all.filter((entry) => !optIn.has(entry))[index])
  const layout: ColumnLayout = {
    order: sameOrder ? [] : fullOrder.filter((id) => tools.find((column) => column.id === id)?.fixed !== 'end' && (!optIn.has(id) || visible.has(id))),
    hidden: tools.filter((column) => column.fixed === null && !column.optIn && !visible.has(column.id)).map((column) => column.id),
    pinned: (value.lockedColumns ?? []).filter((id) => all.includes(id) && visible.has(id)),
  }
  return cleanLayout(layout, tools)
}

/** What a view keeps of the screen: the address terms, the working layout, the density. */
export function screenState(query: string, layout: WorkingLayout): ViewState {
  return normaliseState({ query, ...(layout.columns ? { columns: layout.columns } : {}), ...(layout.density ? { density: layout.density } : {}) })
}

/** The screen still shows the view it opened (Update is offered only when it does not). */
export function showsView(view: SavedView, query: string, layout: WorkingLayout): boolean {
  return sameState(view.state, screenState(query, layout))
}

/** The address terms of a view in words: how many filters it keeps (0: the list as it is). */
export function termCount(state: ViewState): number {
  return state.query === '' ? 0 : new URLSearchParams(state.query).size
}

/**
 * The columns an export writes: the visible ones, left to right, as the screen names them (no ⋯, no checkbox). B-TH-225: a
 * cell that shows two facts (an order's number and its customer PO under it) names its second one in
 * `context.exportWith` ([{ key, label }]): the file writes it right after the column, so the file holds what the cell shows.
 */
export function exportColumnsOf(columns: readonly ColDef<unknown>[]): ExportColumn[] {
  const tools = toolColumnsOf(columns)
  const end = new Set(tools.filter((column) => column.fixed === 'end').map((column) => column.id))
  return columns.flatMap((column) => {
    const id = columnIdOf(column)
    if (id === null || id === SELECTION_COLUMN || column.hide || end.has(id)) return []
    const label = typeof column.headerName === 'string' && column.headerName.trim() !== '' ? column.headerName : id
    return [{ key: id, label }, ...exportWithOf(column)]
  })
}

// B-TH-225: the second facts a cell shows (ColDef.context.exportWith).
function exportWithOf(column: ColDef<unknown>): ExportColumn[] {
  const extra = (column.context as { exportWith?: unknown } | undefined)?.exportWith
  if (!Array.isArray(extra)) return []
  return extra.filter((entry): entry is ExportColumn => typeof entry?.key === 'string' && typeof entry?.label === 'string' && entry.key !== '' && entry.label.trim() !== '')
}

/** The grid's density name (the DS's), from a view's. */
export const gridDensityOf = (density: Density | undefined): 'compact' | 'cozy' | 'spacious' | undefined => density

export const isActiveJob = (status: ExportStatus): boolean => status === 'QUEUED' || status === 'RUNNING'

/**
 * The words of a failed job: the API states its reason in its own words; the screen says its own (`tools.job.why.*`),
 * read from the reasons the export can give. Anything else: the general words.
 */
export function failureKey(reason: string | null): string {
  const text = reason ?? ''
  if (/rights changed/i.test(text)) return 'tools.job.why.rightsChanged'
  if (/no longer have the right/i.test(text)) return 'tools.job.why.noRight'
  if (/more than [\d,.]+ rows/i.test(text)) return 'tools.job.why.tooMany'
  if (/larger than/i.test(text)) return 'tools.job.why.tooLarge'
  if (/stopped/i.test(text)) return 'tools.job.why.stopped'
  if (/selected rows/i.test(text)) return 'tools.job.why.selected'
  return 'tools.job.why.other'
}

/** A file's size in words (`84 KB`, `2.4 MB`). */
export function sizeText(bytes: number, locale: 'it' | 'en'): string {
  const format = (value: number, digits: number) => value.toLocaleString(locale === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: digits })
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1_048_576) return `${format(Math.round(bytes / 1024), 0)} KB`
  return `${format(bytes / 1_048_576, 1)} MB`
}

/** The person's latest exports of this list, the running ones first. */
export function recentJobs(jobs: readonly ExportJob[], max = 3): ExportJob[] {
  return [...jobs].sort((a, b) => Number(isActiveJob(b.status)) - Number(isActiveJob(a.status)) || b.createdAt.localeCompare(a.createdAt)).slice(0, max)
}
