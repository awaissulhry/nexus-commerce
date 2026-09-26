/**
 * The sheet's PROGRESS COLUMNS (2026-09-26) — ONE builder for master and every channel scope.
 *
 * 🔴 One builder, because two drift (reference_two_column_builders_drift): every rule master had and the channel did
 * not was a silent gap. Both adapters call `progressColumn()` and read their values through the pure functions below.
 *
 * What the Owner asked for, and approved on the preview (`/design/grid-lab/progress`):
 *  - The bar leaves the Product cell and becomes a COLUMN per scope: the shared product, then each channel · market
 *    (master), or the scope's own (a channel tab). These replace the "Readiness · <label>" columns.
 *  - Colour rule A: red = a required field is empty, yellow = only optional fields are empty, green = nothing is
 *    empty (`progressTone`, DS). Hover or click lists what is empty; choosing one puts the cursor in that cell.
 *  - A market column links to the listings readiness page for that market.
 *
 * Every value is MEASURED by the server: a sheet row's own `completeness` (the same `completenessFor` that writes
 * the index), or the readiness index for a coordinate. Nothing here computes a percentage from what the grid happens
 * to show, and an unmeasured side is `null`, never zero.
 */
import { browserWorkspaceId, workspaceHref } from '@/lib/workspaces/paths'
import { ProgressCell, cellDetailKeys, progressText, combinedPercent, type ColDef, type ICellRendererParams, type ProgressAction, type ProgressCellParams, type ProgressField, type ProgressValue } from '@/design-system/grid'

export const PROGRESS_COLUMN_PREFIX = 'progress:'
/** The scope's OWN progress column — the shared product on master, the channel · market on a channel tab. */
export const SCOPE_PROGRESS_COLUMN = 'progress:scope'
export const isProgressColumn = (colId: string): boolean => colId.startsWith(PROGRESS_COLUMN_PREFIX)
/** Wide enough for a 56px bar and "100%" beside it, with the cell's padding. */
export const PROGRESS_COLUMN_WIDTH = 132

/* ── values ───────────────────────────────────────────────────────────────────────────────── */

interface RowCompleteness {
  overall?: { filled: number; total: number; pct: number }
  required?: { filled: number; total: number; missing: Array<{ key: string; label: string }> }
  optional?: { filled: number; total: number; missing: Array<{ key: string; label: string }> }
}
interface RowIssue { key: string; label: string; message: string }

/**
 * A sheet row's progress in its OWN scope, from the row the sheet already read.
 *
 * `unscorable` is the caller's sentence when this scope cannot be scored (a channel whose requirements are not
 * loaded): the percentage is then withheld — structural fields alone would fill a bar with a number that means
 * nothing — and the sentence is shown instead.
 */
export function rowProgressValue(row: { completeness?: RowCompleteness; readiness?: { issues?: RowIssue[] } } | null | undefined, unscorable?: string | null): ProgressValue | null {
  const c = row?.completeness
  if (!c) return null
  const requiredEmpty: ProgressField[] = (c.required?.missing ?? []).map(m => ({ field: m.key, label: m.label }))
  const emptyKeys = new Set(requiredEmpty.map(f => f.field))
  // An issue ON an empty required field is that field's reason, not a second entry (one field, one row — LX.F P1-4).
  const issues = row?.readiness?.issues ?? []
  for (const f of requiredEmpty) {
    const why = issues.find(i => i.key === f.field)
    if (why) f.reason = why.message
  }
  const otherIssues: ProgressField[] = issues.filter(i => !emptyKeys.has(i.key)).map(i => ({ field: i.key, label: i.label, reason: i.message }))
  if (unscorable) {
    return { pct: null, required: null, optional: null, requiredEmpty: [], optionalEmpty: null, otherIssues, note: unscorable }
  }
  return {
    pct: c.overall?.pct ?? null,
    required: c.required ? { filled: c.required.filled, total: c.required.total } : null,
    optional: c.optional ? { filled: c.optional.filled, total: c.optional.total } : null,
    requiredEmpty,
    optionalEmpty: c.optional ? c.optional.missing.map(m => ({ field: m.key, label: m.label })) : null,
    otherIssues,
  }
}

/** One product's reading at one coordinate, from the readiness matrix. */
export interface CoordinateReading {
  state: string
  pct: number | null
  note?: string
  required?: { filled: number; total: number }
  optional?: { filled: number; total: number } | null
  computedAt?: string | null
}
export interface CoordinateEntry { field: string; label: string; reason: string; requiredEmpty?: true }

const GENERIC_REQUIRED_REASON = 'Required and empty'

/**
 * A product's progress at a channel coordinate, from the index. `null` reading = no index row = NOT COMPUTED (the
 * cell is grey and says so), never 0%. `reading.pct === null` = the coordinate cannot be scored (the server's note).
 */
export function coordinateProgressValue(reading: CoordinateReading | null | undefined, entries: readonly CoordinateEntry[], optionalEmpty: readonly ProgressField[]): ProgressValue | null {
  if (!reading) return null
  const required = reading.required ?? null
  const optional = reading.optional ?? null
  const requiredEmpty = entries.filter(e => e.requiredEmpty === true).map(e => ({ field: e.field, label: e.label, reason: e.reason === GENERIC_REQUIRED_REASON ? null : e.reason }))
  const otherIssues = entries.filter(e => e.requiredEmpty !== true).map(e => ({ field: e.field, label: e.label, reason: e.reason }))
  if (reading.pct === null) {
    return { pct: null, required, optional: null, requiredEmpty, optionalEmpty: null, otherIssues, note: reading.note ?? null, computedAt: reading.computedAt ?? null }
  }
  return {
    pct: combinedPercent(required, optional),
    required,
    optional,
    requiredEmpty,
    optionalEmpty: optional ? [...optionalEmpty] : null,
    otherIssues,
    computedAt: reading.computedAt ?? null,
  }
}

/* ── links ────────────────────────────────────────────────────────────────────────────────── */

/**
 * The studio at one field of one row: `?rec=<rowId>&cell=<field>` — the studio's existing record link, which opens the
 * record and reveals the cell (`useStudioRecord`). Patches only the keys it names (contracts.tsx `patchSearch` rule).
 */
export function studioFieldHref(base: { pathname: string; search: string }, target: {
  scope: string; market?: string | null; locale?: string | null; accountId?: string | null; aliasId?: string | null; rowId: string; field: string
}): string {
  const params = new URLSearchParams(base.search)
  params.set('scope', target.scope)
  if (target.market) params.set('market', target.market)
  if (target.locale) params.set('locale', target.locale)
  if (target.accountId) params.set('account', target.accountId); else params.delete('account')
  if (target.aliasId) params.set('alias', target.aliasId); else params.delete('alias')
  params.delete('tab')
  params.set('rec', target.rowId)
  params.set('cell', target.field)
  return `${base.pathname}?${params}`
}

/**
 * The listings readiness page, narrowed to one channel · market · language — inside the CURRENT business profile
 * (`/w/<id>/…`): a bare `/products/…` link lands on the profile chooser when profiles are on (measured 2026-09-26).
 */
export function listingsHref(target: { channel: string | null; market?: string | null; language?: string | null }, workspaceId: string | null = browserWorkspaceId()): string {
  const params = new URLSearchParams()
  params.set('channel', target.channel ?? 'SHARED')
  if (target.market) params.set('marketplace', target.market)
  if (target.language) params.set('language', target.language)
  return workspaceHref(workspaceId, `/products/listing-readiness?${params}`)
}

/* ── the column ───────────────────────────────────────────────────────────────────────────── */

/**
 * A progress column as a member of the SHEET'S COLUMN MODEL — the media column's pattern: listed in Customise (group
 * "Progress"), in saved views, lockable (a lock pins it left) and hideable; never a server column and never a write
 * field. `managedBy: 'progress'` makes it STRUCTURAL (`views.ts`), so a view saved before it existed cannot drop it.
 */
export function progressSheetColumn<T>(key: string, label: string, helpText: string): T {
  return {
    key, writeField: '', label, group: 'Progress', groupKey: 'progress', kind: 'text', storage: 'column', scope: 'global',
    requiredBy: [], editable: false, formulaWritable: false, width: PROGRESS_COLUMN_WIDTH, defaultVisible: true,
    managedBy: 'progress', helpText,
  } as unknown as T
}

/** The columns a builder must NOT build itself — progress columns are built by `progressColumn()`. */
export const withoutProgressColumns = <T extends { managedBy?: string }>(columns: readonly T[]): T[] => columns.filter(c => c.managedBy !== 'progress')

export type ColumnPresence = 'visible' | 'hidden' | 'absent'

/** The card's action for a field of THIS sheet: go to it (showing it first when hidden), or say it is not here. */
export function sheetFieldAction(presence: ColumnPresence, label: string, elsewhere: string): ProgressAction {
  if (presence === 'visible') return { kind: 'goto', label: 'Go to' }
  if (presence === 'hidden') return { kind: 'goto', label: 'Show and go to' }
  return { kind: 'none', text: elsewhere.replace('{label}', label) }
}

export function progressColumn<Row>(input: {
  colId: string
  headerName: string
  headerTooltip: string
  value: (row: Row) => ProgressValue | null
  cell: ProgressCellParams
}): ColDef<Row> {
  return {
    colId: input.colId,
    headerName: input.headerName,
    headerTooltip: input.headerTooltip,
    width: PROGRESS_COLUMN_WIDTH,
    minWidth: 104,
    /* NOT pinned and NOT locked (Owner, 2026-09-26: "they must not all be locked … I'll manually pin them if I need
       anything like that"). They open right after Product and scroll with the sheet; the header menu pins, moves,
       resizes or hides any of them like any other column. */
    sortable: false,
    editable: false,
    cellClass: 'nds-ag-cell nds-cell-is-locked nds-progress-col',
    valueGetter: p => (p.data ? input.value(p.data) : null),
    valueFormatter: p => (p.data ? progressText(p.value as ProgressValue | null) : ''),
    // Enter / Space on the locked cell opens the card; Esc in the card returns here.
    suppressKeyboardEvent: cellDetailKeys,
    cellRenderer: ProgressCell,
    cellRendererParams: input.cell,
  }
}

export type { ICellRendererParams }
