/**
 * A restored grid state keeps the columns' pins (Bid page design audit M14, 2026-10-11).
 *
 * AG applies an `initialState` (and `api.setState`) as a WHOLE: every column slice the state leaves out is reset, and a
 * missing `columnPinning` resets every pin to none. A surface that remembers its widths, order, visibility and sort but
 * not its pins (the Bid rules: the phone and desktop columns pin differently, so the definitions decide) therefore lost
 * the left-pinned Rule column and the right-pinned ⋯ column on every reload — measured at 1280: ⋯ drawn at x 1352–1408
 * in a card that ends at 1250, unreachable until a horizontal scroll, while a first visit (no saved state) was fine.
 *
 * The rule: a state with no `columnPinning` gets one — the pins the column definitions declare (on mount), or the pins
 * the grid has now (applying a saved view). A state that names its pins is left exactly as it is. *
 * The same file says which WIDTHS a restored state may not set (2026-10-23): a column that fits its content on screen
 * (the actions column, `renderers/actionsFit.ts`) has no width a person chose, so a stored one is only an old number.
 */
import type { ColDef, ColGroupDef, GridState } from 'ag-grid-community'

export interface ColumnPinning {
  leftColIds: string[]
  rightColIds: string[]
}

type AnyColDef = ColDef<never> | ColGroupDef<never>

/** The leaf column definitions and their ids (`colId`, else a string `field`), groups flattened. */
function leafColumns(columnDefs: readonly unknown[] | null | undefined): Array<{ id: string; col: ColDef<never> }> {
  const out: Array<{ id: string; col: ColDef<never> }> = []
  const walk = (defs: readonly unknown[]) => {
    for (const raw of defs) {
      if (!raw || typeof raw !== 'object') continue
      const def = raw as AnyColDef
      if ('children' in def && Array.isArray(def.children)) { walk(def.children); continue }
      const col = def as ColDef<never>
      const id = col.colId ?? (typeof col.field === 'string' ? col.field : undefined)
      if (id) out.push({ id, col })
    }
  }
  walk(columnDefs ?? [])
  return out
}

/** The pins the definitions declare (`pinned`, else `initialPinned`; `true` is left), groups flattened. */
export function declaredPinning(columnDefs: readonly unknown[] | null | undefined): ColumnPinning {
  const out: ColumnPinning = { leftColIds: [], rightColIds: [] }
  for (const { id, col } of leafColumns(columnDefs)) {
    const pin = col.pinned !== undefined ? col.pinned : col.initialPinned
    if (pin === 'right') out.rightColIds.push(id)
    else if (pin === 'left' || pin === true) out.leftColIds.push(id)
  }
  return out
}

/** The ids of the column definitions `test` picks, groups flattened. */
export function colIdsWhere(columnDefs: readonly unknown[] | null | undefined, test: (col: ColDef<never>) => boolean): string[] {
  return leafColumns(columnDefs).filter(({ col }) => test(col)).map(({ id }) => id)
}

/** `state` without the stored widths of `colIds`; the same object when it stores none of them. */
export function withoutColumnSizing<S extends GridState | undefined>(state: S, colIds: readonly string[]): S {
  const model = state?.columnSizing?.columnSizingModel
  if (!state || !model || !colIds.length || !model.some(entry => colIds.includes(entry.colId))) return state
  return { ...state, columnSizing: { ...state.columnSizing, columnSizingModel: model.filter(entry => !colIds.includes(entry.colId)) } }
}

/** `state` with `pinning` filled in when it names none; the same object when it does, or when there is nothing to add. */
export function withPinning<S extends GridState | undefined>(state: S, pinning: ColumnPinning | undefined): S {
  if (!state || state.columnPinning || !pinning) return state
  if (!pinning.leftColIds.length && !pinning.rightColIds.length) return state
  return { ...state, columnPinning: { leftColIds: [...pinning.leftColIds], rightColIds: [...pinning.rightColIds] } }
}
