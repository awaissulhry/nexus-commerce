/**
 * AGW — column preferences: the STORAGE (same keys, same shapes the hand-rolled grid wrote) and
 * the bridge to AG's column state (order · visibility · pinning · widths).
 *
 * Pure. Nothing in here touches AG or React, so every rule is tested rather than trusted — the
 * rule that matters most being the first one: an operator's saved view under any of the 43
 * `storageKey`s in the console must come back EXACTLY as it was. The reader accepts every shape the
 * legacy grid ever wrote (a bare `string[]` of visible keys from before SGX3, and the SGX3 object),
 * drops keys the column set no longer has, and adopts sticky-on where the record predates the flag.
 */
import type { ColumnState } from 'ag-grid-community'

import type { GridColumn, GridPrefs } from './types'
import type { PreferencesValue } from '../../patterns/PreferencesModal'
import { readColumnLayout, sameColumnLayout } from '../preferencesLayout'

/** The identity column's id in AG. Not a `GridColumn`; it cannot be hidden or moved. */
export const FIRST_COL = '__first'
/** The hidden column AG groups on when `groupBy` is set. Never persisted, never shown. */
export const GROUP_COL = '__group'
/** AG's own selection column id. */
export const SELECTION_COL = 'ag-Grid-SelectionColumn'

export const defaultVisibleKeys = <T>(columns: readonly GridColumn<T>[]): string[] =>
  columns.filter((c) => !c.defaultHidden).map((c) => c.key)

export const defaultPrefs = <T>(columns: readonly GridColumn<T>[]): GridPrefs => ({
  visible: defaultVisibleKeys(columns),
  stickyFirst: true,
  stickyLast: true,
})

/**
 * Parse what a `storageKey` holds. `null` means "nothing usable stored" — the caller falls back to
 * this column set's own defaults, exactly as the legacy effect did. Keys unknown to `columns` are
 * dropped rather than trusted; widths are kept only for known keys and only when they are numbers.
 */
export function parseStoredPrefs<T>(raw: string | null | undefined, columns: readonly GridColumn<T>[]): GridPrefs | null {
  if (!raw) return null
  const known = new Set(columns.map((c) => c.key))
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  if (Array.isArray(parsed)) {
    return { visible: (parsed as unknown[]).filter((k): k is string => typeof k === 'string' && known.has(k)), stickyFirst: true, stickyLast: true }
  }
  const o = parsed as Partial<GridPrefs> | null
  if (!o || !Array.isArray(o.visible)) return null
  const out: GridPrefs = {
    ...readColumnLayout(o, known),
    visible: (o.visible as unknown[]).filter((k): k is string => typeof k === 'string' && known.has(k)),
    stickyFirst: o.stickyFirst !== false,
    stickyLast: o.stickyLast !== false,
  }
  if (o.widths && typeof o.widths === 'object') {
    const widths: Record<string, number> = {}
    for (const [k, v] of Object.entries(o.widths)) {
      if ((known.has(k) || k === FIRST_COL) && typeof v === 'number' && Number.isFinite(v) && v > 0) widths[k] = v
    }
    if (Object.keys(widths).length) out.widths = widths
  }
  return out
}

export function readStoredPrefs<T>(storageKey: string, columns: readonly GridColumn<T>[]): GridPrefs | null {
  try { return parseStoredPrefs(typeof localStorage === 'undefined' ? null : localStorage.getItem(storageKey), columns) } catch { return null }
}

/** True when the key holds SOMETHING (the legacy re-seed effect asked exactly this, not whether it parses). */
export function hasStoredPrefs(storageKey: string): boolean {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(storageKey) != null } catch { return false }
}

export function writeStoredPrefs(storageKey: string, prefs: GridPrefs): void {
  try {
    // `widths` is written only when it holds something, so a view that was never resized keeps the
    // exact bytes the legacy grid wrote — a reader diffing storage sees no change it did not make.
    const { widths: _widths, ...rest } = prefs
    const out: GridPrefs = rest
    if (prefs.widths && Object.keys(prefs.widths).length) out.widths = prefs.widths
    localStorage.setItem(storageKey, JSON.stringify(out))
  } catch { /* ignore — a full or disabled store is not a reason to break the grid */ }
}

export const samePrefs = (a: GridPrefs, b: GridPrefs): boolean =>
  a.stickyFirst === b.stickyFirst && a.stickyLast === b.stickyLast
  && a.visible.length === b.visible.length && a.visible.every((k, i) => k === b.visible[i])
  && sameWidths(a.widths, b.widths)
  && sameColumnLayout(a, b)

/** Preserve the original right-pinned defaults until a user saves explicit column locks. */
export function prefsToModal<T>(prefs: GridPrefs, columns: readonly GridColumn<T>[], pageSize: number): PreferencesValue {
  const { visible, stickyFirst, stickyLast, widths: _widths, ...layout } = prefs
  return {
    ...layout, visibleColumns: visible, stickyFirstColumn: stickyFirst, stickyLastColumn: stickyLast,
    lockedColumns: prefs.lockedColumns ?? columns.filter((c) => stickyLast && c.freezeRight && c.width != null).map((c) => c.key),
    pageSize, sortBy: '', sortDir: 'desc',
  }
}

export function prefsFromModal<T>(previous: GridPrefs, next: PreferencesValue, columns: readonly GridColumn<T>[]): GridPrefs {
  const known = new Set(columns.map((c) => c.key))
  const right = columns.filter((c) => c.freezeRight && c.width != null).map((c) => c.key)
  const locks = new Set((next.lockedColumns ?? []).filter((key) => known.has(key)))
  // The existing sticky-last toggle is a bulk control for the right-hand pins.
  if (next.stickyLastColumn !== previous.stickyLast) for (const key of right) {
    if (next.stickyLastColumn) locks.add(key); else locks.delete(key)
  }
  return {
    ...previous, ...readColumnLayout(next, known), lockedColumns: [...locks],
    visible: next.visibleColumns.filter((key) => known.has(key)),
    stickyFirst: next.stickyFirstColumn,
    stickyLast: right.length ? right.some((key) => locks.has(key)) : next.stickyLastColumn,
  }
}

const sameWidths = (a?: Record<string, number>, b?: Record<string, number>): boolean => {
  const ka = Object.keys(a ?? {}), kb = Object.keys(b ?? {})
  if (ka.length !== kb.length) return false
  return ka.every((k) => a![k] === b?.[k])
}

/**
 * The order the operator made by DRAGGING headers, read back from AG's column state.
 *
 * AG lists every column in display order: selection column, pinned-left, centre, pinned-right. The
 * preferences store the visible columns in that same order (pinned-right columns sit wherever they
 * sit; their pin is `freezeRight`'s, not the order's), so the transcription is: keep the known,
 * shown columns, in AG's order. Hidden ones are not in `visible` by definition.
 */
export function visibleOrderFromColumnState(state: readonly ColumnState[], known: ReadonlySet<string>): string[] {
  return state.filter((s) => !s.hide && known.has(s.colId)).map((s) => s.colId)
}

/**
 * A header resize, folded into the preferences. `null` width (AG reports one for a column it could
 * not size) leaves the record untouched. The identity column is resizable within its own bounds and
 * persists like any other.
 */
export function withWidth(prefs: GridPrefs, colId: string, width: number | null | undefined): GridPrefs {
  if (width == null || !Number.isFinite(width) || width <= 0) return prefs
  const rounded = Math.round(width)
  if (prefs.widths?.[colId] === rounded) return prefs
  return { ...prefs, widths: { ...prefs.widths, [colId]: rounded } }
}

/** The persisted widths as an `applyColumnState` payload — nothing else is stated, so a column
 *  without a saved width keeps whatever the auto-size gave it. */
export function widthsToColumnState(prefs: GridPrefs): ColumnState[] {
  return Object.entries(prefs.widths ?? {}).map(([colId, width]) => ({ colId, width }))
}
