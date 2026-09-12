/**
 * AGD — the legacy DataGrid's column preferences: the SAME storage key, the SAME shape.
 *
 * `components/DataGrid.tsx:318-433` stores `PreferencesValue + knownColumns` under `storageKey`
 * (`{ visibleColumns, lockedColumns, stickyFirstColumn, stickyLastColumn, pageSize: 100, sortBy,
 * sortDir, knownColumns }`) — NOT the WorkspaceGrid's `GridPrefs`. The reader below is that file's
 * loader lifted line for line (the reconciliation of `visibleColumns` against the live roster, the
 * `knownColumns` distinction between "hidden on purpose" and "shipped since", the canonical-index
 * insertion, the locks, the sticky toggles, the guarded sort restore), so an operator's saved view
 * comes back exactly as the legacy grid would have shown it. ONE additive field: `widths`, written
 * only when a header was resized, so a view that was never resized keeps the exact bytes the legacy
 * wrote. Pure — nothing here touches React or AG — so every rule is tested rather than trusted.
 */
import type { ColumnState } from 'ag-grid-community'

import type { PreferencesValue } from '../../patterns/PreferencesModal'
import { readColumnLayout } from '../preferencesLayout'

export interface DataGridPrefs extends PreferencesValue {
  /** AG-era addition: persisted header resizes, by column key. Absent until a header is dragged. */
  widths?: Record<string, number>
}

/** What the storage holds: the preferences plus the roster they were written against. */
export interface StoredDataGridPrefs extends Partial<DataGridPrefs> {
  knownColumns?: string[]
}

export type SortSpec = { key: string; dir: 'asc' | 'desc' }

/** DataGrid.tsx:318-329 — the state before anything is loaded. */
export function defaultPrefs(togglableKeys: readonly string[], defaultLockedKeys: readonly string[]): DataGridPrefs {
  return {
    visibleColumns: [...togglableKeys],
    lockedColumns: [...defaultLockedKeys],
    stickyFirstColumn: true,
    stickyLastColumn: true,
    // This grid paginates nothing and sorts from its own headers, so these three are carried
    // untouched and their dialog sections stay hidden — a Page-size control that changed nothing
    // would be a lie.
    pageSize: 100,
    sortBy: '',
    sortDir: 'desc',
  }
}

/** DataGrid.tsx:347-353 — `JSON.parse` under a try; anything unusable reads as nothing stored. */
export function parseStoredPrefs(raw: string | null | undefined): StoredDataGridPrefs | null {
  if (!raw) return null
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  if (parsed == null || parsed === false) return null
  // The legacy read fields off whatever parsed; a primitive has none, which reads as an empty record.
  return typeof parsed === 'object' ? (parsed as StoredDataGridPrefs) : {}
}

export interface ReconcileInput {
  togglableKeys: readonly string[]
  defaultLockedKeys: readonly string[]
  prefsSortFields?: ReadonlyArray<{ value: string; label: string }>
}

export interface Reconciled {
  /** Merged over the current state (`setPrefs((prev) => ({ ...prev, ...patch }))`). */
  patch: Partial<DataGridPrefs>
  /** A saved sort the caller offered through `prefsSortFields`; the rows must move too. */
  restoredSort: SortSpec | null
}

/** DataGrid.tsx:354-418, verbatim. */
export function reconcileStoredPrefs(saved: StoredDataGridPrefs, input: ReconcileInput): Reconciled {
  const { togglableKeys, defaultLockedKeys, prefsSortFields } = input
  const known = new Set(togglableKeys)
  const kept = (Array.isArray(saved.visibleColumns) ? saved.visibleColumns : []).filter((k) => known.has(k))
  // A column shipped after this operator last opened the dialog must appear — dropping it would
  // hide every new column, permanently, from everyone who ever opened this grid.
  //
  // 🔴 But "new" cannot be inferred from `visibleColumns` alone: that list records what is
  // VISIBLE, so a column the operator deliberately HID and a column that did not exist yet are
  // both simply absent from it. `knownColumns` is the roster the grid held when these prefs were
  // written, so the two cases are distinguishable: in the roster but not visible ⇒ hidden on
  // purpose; not in the roster at all ⇒ genuinely new. Absent entirely (prefs written before that
  // field) ⇒ fall back to append-everything.
  const savedKnown = Array.isArray(saved.knownColumns) ? new Set(saved.knownColumns) : null
  const seen = new Set(kept)
  const appended = togglableKeys.filter((k) => !seen.has(k) && (savedKnown ? !savedKnown.has(k) : true))
  // Placed at its CANONICAL index, not at the end.
  const merged = [...kept]
  for (const k of appended) {
    const canon = togglableKeys.indexOf(k)
    let at = merged.length
    for (let i = 0; i < merged.length; i++) {
      if (togglableKeys.indexOf(merged[i]) > canon) { at = i; break }
    }
    merged.splice(at, 0, k)
  }
  const savedLocks = saved.lockedColumns
  // The saved sort is restored only when the caller offers that field through `prefsSortFields`:
  // a caller that never passed it showed no sort section, so its stored `sortBy` is the inert ''
  // carried through untouched — and a key that is no longer offered must not sort by nothing.
  const savedSortBy = typeof saved.sortBy === 'string' ? saved.sortBy : ''
  const restoredSort: SortSpec | null = prefsSortFields?.some((f) => f.value === savedSortBy)
    ? { key: savedSortBy, dir: saved.sortDir === 'asc' ? 'asc' : 'desc' }
    : null
  const patch: Partial<DataGridPrefs> = {
    ...readColumnLayout(saved, known),
    visibleColumns: merged,
    // Absent ⇒ prefs written before the lock existed ⇒ the grid's own defaults.
    lockedColumns: Array.isArray(savedLocks) ? savedLocks.filter((k) => known.has(k)) : [...defaultLockedKeys],
    stickyFirstColumn: saved.stickyFirstColumn !== false,
    stickyLastColumn: saved.stickyLastColumn !== false,
    ...(restoredSort ? { sortBy: restoredSort.key, sortDir: restoredSort.dir } : null),
  }
  // The AG-era widths: kept only for known columns and finite positive numbers; absent when empty.
  if (saved.widths && typeof saved.widths === 'object') {
    const widths: Record<string, number> = {}
    for (const [k, v] of Object.entries(saved.widths)) {
      if (known.has(k) && typeof v === 'number' && Number.isFinite(v) && v > 0) widths[k] = v
    }
    if (Object.keys(widths).length) patch.widths = widths
  }
  return { patch, restoredSort }
}

/**
 * DataGrid.tsx:429 — `JSON.stringify({ ...prefs, knownColumns })`. `widths` travels only when it
 * holds something, so a never-resized view serialises to exactly the legacy's bytes.
 */
export function serializePrefs(prefs: DataGridPrefs, togglableKeys: readonly string[]): string {
  const { widths, ...rest } = prefs
  const out: StoredDataGridPrefs = { ...rest, knownColumns: [...togglableKeys] }
  if (widths && Object.keys(widths).length) out.widths = widths
  return JSON.stringify(out)
}

export function readStoredRaw(storageKey: string): string | null {
  try { return typeof window === 'undefined' ? null : window.localStorage.getItem(storageKey) } catch { return null }
}

export function writeStoredPrefs(storageKey: string, prefs: DataGridPrefs, togglableKeys: readonly string[]): void {
  try {
    window.localStorage.setItem(storageKey, serializePrefs(prefs, togglableKeys))
  } catch {
    /* private mode / quota — the grid still works, the order just won't survive */
  }
}

/**
 * The order the operator made by DRAGGING headers, read back from AG's column state: the
 * togglable, shown columns in AG's display order (pinned columns are locked at the edges and are
 * not in `visibleColumns`; the checkbox column is the adapter's).
 */
export function visibleOrderFromColumnState(state: readonly ColumnState[], togglableKeys: ReadonlySet<string>): string[] {
  return state.filter((s) => !s.hide && togglableKeys.has(s.colId)).map((s) => s.colId)
}

/** A header resize folded into the preferences; a width AG could not measure leaves the record untouched. */
export function withWidth(prefs: DataGridPrefs, colId: string, width: number | null | undefined): DataGridPrefs {
  if (width == null || !Number.isFinite(width) || width <= 0) return prefs
  const rounded = Math.round(width)
  if (prefs.widths?.[colId] === rounded) return prefs
  return { ...prefs, widths: { ...prefs.widths, [colId]: rounded } }
}
