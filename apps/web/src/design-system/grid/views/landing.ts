/**
 * GDS — where a sheet LANDS, and what of the operator's arrangement comes back with it.
 *
 * ONE function for every scope (design V.8). Master and the channel scopes each used to decide
 * their own landing — master through `landingPreset` + `hasPersistedArrangement` + a per-mount ref,
 * the channel through a one-shot `setColumnsVisible(hide, false)` — and the two answered the same
 * question two ways, which is how "Customise does not survive a reload" took three days and four
 * rulings to run down (#772–#774, #786). A sheet whose ground state is EVERY column has no hidden
 * column to lose, and a landing that is a pure function of (contract, default view) has nothing
 * to race.
 *
 * The rule, Owner-approved 2026-09-04:
 *   1. the sheet lands on ALL its columns, in the sheet's ruled order (§9.2) — on every scope, on
 *      every reload;
 *   2. the one exception is EXPLICIT: a saved view the operator marked as the default for this
 *      scope, which is named on the trigger so the narrowing is never a mystery;
 *   3. visibility and order are never restored implicitly. Widths, pins and sort are (they are
 *      visible on screen and cannot hide a column) — `arrangementColumnState` below.
 *
 * Pure — no AG, no React, no storage. Tested in `landing.vitest.test.ts`.
 */
import type { ColumnState } from 'ag-grid-community'

import { resolvePreset } from './presets'
import { isColumnsViewPayload } from './viewPayload'

export interface LandingDefaultView {
  id: string
  name: string
  /** Whatever the server stored — checked here, never trusted. */
  payload: unknown
}

export interface LandingInput {
  /** Every togglable column the grid has, in the sheet's ruled order. */
  orderedKeys: readonly string[]
  /** Identity — never dropped, always first. */
  always: readonly string[]
  /** The operator's explicit default view for this scope, if they set one. */
  defaultView?: LandingDefaultView | null
}

export type LandingSource =
  | {
      kind: 'all'
      /**
       * A default view existed but could not apply here — none of its columns exist on this
       * product type. Reported so the sheet can SAY so; a default that silently did nothing would
       * read as "the default is all columns", which is not what the operator chose.
       */
      ignoredDefault?: { id: string; name: string; missing: string[] }
    }
  | { kind: 'saved'; id: string; name: string; missing: string[] }

export interface Landing {
  /** The columns to show, in order — identity first. */
  columns: string[]
  source: LandingSource
}

/** Identity first, then every column, each once. The ground state of every sheet. */
export function allColumns(orderedKeys: readonly string[], always: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const key of [...always, ...orderedKeys]) {
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

export function resolveLanding(input: LandingInput): Landing {
  const all = allColumns(input.orderedKeys, input.always)
  const dv = input.defaultView
  if (!dv || !isColumnsViewPayload(dv.payload)) return { columns: all, source: { kind: 'all' } }
  const resolved = resolvePreset({ columns: dv.payload.columns }, all, input.always)
  // A view whose every column is missing here resolves to identity alone — that is not a view of
  // anything, so the sheet lands full and reports the default it could not honour.
  if (resolved.columns.length <= input.always.filter((k) => all.includes(k)).length) {
    return { columns: all, source: { kind: 'all', ignoredDefault: { id: dv.id, name: dv.name, missing: resolved.missing } } }
  }
  return { columns: resolved.columns, source: { kind: 'saved', id: dv.id, name: dv.name, missing: resolved.missing } }
}

/**
 * The persisted slices this re-applies. `columnVisibility` and `columnOrder` are deliberately NOT
 * here — membership and order come from the view (rule 3 above).
 */
export interface PersistedArrangement {
  columnSizing?: { columnSizingModel?: ReadonlyArray<{ colId?: string; width?: number; flex?: number }> } | null
  columnPinning?: { leftColIds?: readonly string[]; rightColIds?: readonly string[] } | null
  sort?: { sortModel?: ReadonlyArray<{ colId?: string; sort?: 'asc' | 'desc' | null }> } | null
}

/**
 * The operator's widths, pins and sort as `ColumnState` entries — for columns that EXIST NOW.
 *
 * 🔴 Why this is applied after the columns arrive rather than through `initialState`: AG honours
 * `initialState` at grid CREATION, and a sheet that renders its grid before the contract loads
 * (master does) hands AG state naming columns it does not have yet; AG drops them, and each column
 * later takes its colDef default (#773, measured). So the sheet applies this once its column ids
 * are real. A column in the persisted state that no longer exists is skipped — a market switch or a
 * schema refresh removes columns legitimately, and naming one to AG is a refusal it cannot report.
 *
 * Only properties the persisted state NAMES are stated. An entry with no width, no pin and no sort
 * is not emitted at all — `applyColumnState` changes only what an entry states, and stating
 * `pinned: null` for every column would silently un-pin what the colDefs pinned (AG.1-c).
 */
export function arrangementColumnState(
  persisted: PersistedArrangement | null | undefined,
  currentColIds: readonly string[],
): ColumnState[] {
  if (!persisted) return []
  const present = new Set(currentColIds)
  const widths = new Map<string, { width?: number; flex?: number }>()
  for (const e of persisted.columnSizing?.columnSizingModel ?? []) {
    if (!e?.colId || !present.has(e.colId)) continue
    if (typeof e.width === 'number' || typeof e.flex === 'number') widths.set(e.colId, { width: e.width, flex: e.flex })
  }
  const left = new Set((persisted.columnPinning?.leftColIds ?? []).filter((id) => present.has(id)))
  const right = new Set((persisted.columnPinning?.rightColIds ?? []).filter((id) => present.has(id)))
  const sorted = new Map<string, { sort: 'asc' | 'desc'; index: number }>()
  ;(persisted.sort?.sortModel ?? []).forEach((s, i) => {
    if (s?.colId && present.has(s.colId) && (s.sort === 'asc' || s.sort === 'desc')) sorted.set(s.colId, { sort: s.sort, index: i })
  })

  const out: ColumnState[] = []
  for (const colId of currentColIds) {
    const size = widths.get(colId)
    const pin = left.has(colId) ? 'left' : right.has(colId) ? 'right' : undefined
    const sort = sorted.get(colId)
    if (!size && !pin && !sort) continue
    out.push({
      colId,
      ...(size?.width !== undefined ? { width: size.width } : {}),
      ...(size?.flex !== undefined ? { flex: size.flex } : {}),
      ...(pin ? { pinned: pin } : {}),
      ...(sort ? { sort: sort.sort, sortIndex: sort.index } : {}),
    })
  }
  return out
}
