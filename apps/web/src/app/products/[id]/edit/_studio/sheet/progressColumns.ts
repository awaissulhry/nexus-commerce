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
/** The "Shared product" column's header tip — one sentence for the sheet, the Variants tab and the Matrix. */
export const SHARED_PROGRESS_TIP = 'Progress of the shared product: filled ÷ every field that applies here, required and optional. Red — a required field is empty. Yellow — only optional fields are empty. Green — nothing is empty. Hover or click a bar to see what is missing. Completeness, not publish readiness.'
/** Wide enough for a 56px bar and "100%" beside it, with the cell's padding. */
export const PROGRESS_COLUMN_WIDTH = 132

/* ── values ───────────────────────────────────────────────────────────────────────────────── */

export interface RowCompleteness {
  overall?: { filled: number; total: number; pct: number }
  required?: { filled: number; total: number; missing: Array<{ key: string; label: string }> }
  optional?: { filled: number; total: number; missing: Array<{ key: string; label: string }> }
}
export interface RowIssue { key: string; label: string; message: string }

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
export interface CoordinateEntry { field: string; label: string; reason: string; kind?: string; requiredEmpty?: true }

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

/* ── the per-coordinate column set (moved here from the master adapter, 2026-09-27: the Variants tab's channel view reads it too) ── */

/**
 * LX.FIN (R-LX-22) — the master sheet's per-coordinate readiness COLUMN SET, derived from the
 * readiness index and nothing else. Pure, exported and tested node-only (apps/web vitest has no DOM).
 *
 * 🔴 What this replaces, and why the replacement is not a refactor. Until now the per-coordinate
 * columns were built from `sheet.coordinates` + `row.readinessByCoordinate`, in the ROW vocabulary,
 * and measured on 2026-09-13 the live studio payload carries NEITHER key: the branch only ever ran on
 * the retired `adaptLegacySheet` 404 fallback. LX.15 says these columns are "either fed from
 * `ReadinessIndex` or deleted — not left dead"; R-LX-22 rules that they are fed, in the SCOPE
 * vocabulary (`readinessMeta(state, 'scope')`), because a coordinate's readiness is a scope fact.
 * No converter between the two vocabularies exists or is needed (PES.0 hub ruling #3): the index is
 * keyed `(productId, coordinateKey, language)`, so a per-row cell is a LOOKUP, not a mapping.
 *
 * One column per CHANNEL coordinate the index has rows for **in the pressed language** — the shared
 * coordinate is excluded because the sheet's own "Shared product" progress column answers for it, live. A product with no row for a coordinate is absent from `byProduct` and its cell says
 * `Not computed`, never a score (R-LX-9).
 */
export interface CoordinateReadinessColumn {
  colId: string
  label: string
  language: string
  computedAt: string | null
  byProduct: Readonly<Record<string, { state: string; pct: number | null; note?: string; required?: { filled: number; total: number }; optional?: { filled: number; total: number } | null; computedAt?: string | null }>>
  /** A-45 — each product's OWN entries (issues + flagged required-empty fields), for its completeness card. */
  missingByProduct: Readonly<Record<string, CoordinateEntry[]>>
  /** Progress columns (2026-09-26) — each product's EMPTY optional fields, when its optional side is recorded. */
  optionalByProduct: Readonly<Record<string, Array<{ field: string; label: string }>>>
  channel: string | null
  market: string | null
  accountId: string | null
  aliasId: string | null
}

export function coordinateReadinessColumns(
  matrix: ReadonlyArray<{ channel: string | null; market: string | null; accountId: string | null; aliasId: string | null; coordinateKey: string; language: string; label: string; computedAt: string | null; byProduct?: Record<string, { state: string; pct: number | null; note?: string; required?: { filled: number; total: number }; optional?: { filled: number; total: number } | null; computedAt?: string | null }>; missing?: ReadonlyArray<{ productId: string; field: string; label: string; reason: string; kind?: string; requiredEmpty?: true }>; optionalMissing?: ReadonlyArray<{ productId: string; field: string; label: string }> }> | undefined,
  language: string | null | undefined,
): CoordinateReadinessColumn[] {
  if (!matrix?.length || !language) return []
  const wanted = language.toLowerCase()
  return matrix
    .filter(entry => !!entry.channel && entry.language?.toLowerCase() === wanted)
    .map(entry => ({
      colId: `ready:${[entry.channel, entry.market, entry.accountId, entry.aliasId].filter(Boolean).join(':')}:${entry.language}`,
      label: entry.label,
      language: entry.language,
      computedAt: entry.computedAt,
      byProduct: entry.byProduct ?? {},
      missingByProduct: groupMissingByProduct(entry.missing),
      optionalByProduct: groupOptionalByProduct(entry.optionalMissing),
      channel: entry.channel,
      market: entry.market,
      accountId: entry.accountId,
      aliasId: entry.aliasId,
    }))
}

/** Progress columns — a coordinate's empty optional fields split by product, like `missing[]` below. */
function groupOptionalByProduct(missing: ReadonlyArray<{ productId: string; field: string; label: string }> | undefined): Record<string, Array<{ field: string; label: string }>> {
  const out: Record<string, Array<{ field: string; label: string }>> = {}
  for (const m of missing ?? []) (out[m.productId] ??= []).push({ field: m.field, label: m.label })
  return out
}

/** A-45 — a coordinate's `missing[]` split by product, so a row's card never shows a sibling's fields. */
function groupMissingByProduct(missing: ReadonlyArray<{ productId: string; field: string; label: string; reason: string; kind?: string; requiredEmpty?: true }> | undefined): Record<string, CoordinateEntry[]> {
  const out: Record<string, CoordinateEntry[]> = {}
  for (const m of missing ?? []) {
    ;(out[m.productId] ??= []).push({ field: m.field, label: m.label, reason: m.reason, ...(m.kind ? { kind: m.kind } : {}), ...(m.requiredEmpty ? { requiredEmpty: true as const } : {}) })
  }
  return out
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

/**
 * The card's action on a surface where a field is NOT a column (the Variants and Matrix tabs, 2026-09-27): open the
 * Information sheet in that scope, at that row and field — the studio's own record link, so it lands on the exact cell.
 */
export function openInSheetAction(label: string, target: Parameters<typeof studioFieldHref>[1]): ProgressAction {
  return { kind: 'link', label, href: studioFieldHref(window.location, target) }
}

/** The card's action for a field of THIS sheet: go to it (showing it first when hidden), or say it is not here. */
export function sheetFieldAction(presence: ColumnPresence, label: string, elsewhere: string): ProgressAction {
  if (presence === 'visible') return { kind: 'goto', label: 'Go to' }
  if (presence === 'hidden') return { kind: 'goto', label: 'Show and go to' }
  return { kind: 'none', text: elsewhere.replace('{label}', label) }
}

/** A verb of the progress column's own header menu (2026-09-27): "Refresh progress · read 12:04". */
export interface ProgressMenuItem { name: string; action: () => void; disabled?: boolean; tooltip?: string }

/** "Refresh progress", with when the bars were last read — the ⋯ menu and every progress column's header menu say it. */
export function refreshProgressItem(refresh: () => void, readAt: number | null | undefined, failed?: string | null): ProgressMenuItem {
  const at = readAt ? new Date(readAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null
  return { name: at ? `Refresh progress · read ${at}` : 'Refresh progress', action: refresh, ...(failed ? { tooltip: `The last refresh failed: ${failed}` } : {}) }
}

/** Two progress cell values that draw the same cell. Built by the same functions, so the key order is stable. */
export function sameProgressReading(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

export function progressColumn<Row>(input: {
  colId: string
  headerName: string
  headerTooltip: string
  value: (row: Row) => ProgressValue | null
  cell: ProgressCellParams
  /** The column's own header-menu verbs, read when the menu opens (`NexusGrid` adds them above Customise). */
  menu?: () => ProgressMenuItem[]
}): ColDef<Row> {
  return {
    ...(input.menu ? { context: { menuItems: input.menu } } : {}),
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
    /* 2026-10-01 (P2 scroll/edit budgets) — the value carries the row the card names, and `equals` compares what the
       cell draws: a reading rebuilt from unchanged facts does not repaint (it repainted three times per edit), while a
       changed number, empty field, reason, note, reading time or SKU still does. */
    valueGetter: p => {
      if (!p.data) return null
      const value = input.value(p.data)
      return value && input.cell.subjectOf ? { ...value, subject: input.cell.subjectOf(p as unknown as ICellRendererParams) } : value
    },
    equals: sameProgressReading,
    valueFormatter: p => (p.data ? progressText(p.value as ProgressValue | null) : ''),
    // Enter / Space on the locked cell opens the card; Esc in the card returns here.
    suppressKeyboardEvent: cellDetailKeys,
    cellRenderer: ProgressCell,
    cellRendererParams: input.cell,
  }
}

/**
 * The "Shared product" progress column for a surface whose fields are NOT columns — the Variants tab's family view and
 * the Matrix (2026-09-27). Same value, colour and card as the sheet's; each field opens the Information sheet at that
 * row and field, and the footer links to the listings page.
 */
export function sharedProgressColumn<Row extends StudioRowLike>(input: { market: string | null | undefined; locale: string | null | undefined }): ColDef<Row> {
  return {
    ...progressColumn<Row>({
      colId: SCOPE_PROGRESS_COLUMN,
      headerName: 'Shared product',
      headerTooltip: SHARED_PROGRESS_TIP,
      value: (row) => rowProgressValue(row),
      cell: {
        scopeLabel: 'Shared product',
        subjectOf: (p) => (p.data as Row | undefined)?.sku ?? null,
        actionFor: (field, _label, p) => {
          const row = p.data as Row | undefined
          return row
            ? openInSheetAction('Open in the sheet', { scope: 'master', market: input.market, locale: input.locale, rowId: row.id, field })
            : { kind: 'none', text: 'Edit it on the Information sheet.' }
        },
        onGoTo: () => undefined,
        footerLink: () => ({ label: 'All products for the shared product', href: listingsHref({ channel: null, language: input.locale }) }),
      },
    }),
    // These grids fix their columns in place (`suppressMovable` everywhere); the header menu still pins it and Customise hides it.
    suppressMovable: true,
  }
}

/** The row shape `sharedProgressColumn` reads — a studio row's identity and its completeness. */
export interface StudioRowLike {
  id: string
  sku: string
  completeness?: RowCompleteness
  readiness?: { issues?: RowIssue[] }
}

export type { ICellRendererParams }
