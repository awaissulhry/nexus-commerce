import type { PreferencesColumnSpec, PreferencesValue } from '../../patterns/PreferencesModal'
import { resolveAttributeGroups } from '../../patterns/preferencesLogic'
import { sheetLayoutPayload, type ColumnsViewPayload, type SheetLayoutPayload } from './viewPayload'

const defaults = { stickyFirstColumn: true, stickyLastColumn: false, pageSize: 0, sortBy: '', sortDir: 'asc' as const }

/** Keep hidden/unavailable slots while incorporating the order last arranged on the live grid. */
export function mergeVisibleColumnOrder(savedOrder: readonly string[], liveVisibleOrder: readonly string[]): string[] {
  const live = [...new Set(liveVisibleOrder)]
  const visible = new Set(live)
  let index = 0
  const merged = [...new Set(savedOrder)].map((key) => visible.has(key) ? live[index++] : key)
  return [...merged, ...live.slice(index)]
}

/** Hidden and temporarily unavailable field IDs remain in the saved arrangement. */
export function preferencesFromLayout(payload: ColumnsViewPayload | null, columns: readonly PreferencesColumnSpec[]): PreferencesValue {
  const keys = columns.filter((c) => !c.locked).map((c) => c.key)
  return {
    ...defaults,
    visibleColumns: payload ? [...payload.columns] : keys,
    columnOrder: [...new Set([...(payload?.v === 3 ? payload.columnOrder : payload?.columns ?? []), ...keys])],
    lockedColumns: payload?.v === 3 ? [...payload.lockedColumns] : [],
    groupOrder: payload?.v === 3 ? [...payload.groupOrder] : [],
    groupOverrides: payload?.v === 3 ? { ...payload.groupOverrides } : {},
  }
}

/** Exact same group resolution as the modal; it only changes column presentation. */
export function layoutFromPreferences(columns: readonly PreferencesColumnSpec[], value: PreferencesValue, identity: readonly string[] = []): SheetLayoutPayload {
  const structural = new Set([...identity, ...columns.filter((c) => c.locked).map((c) => c.key)])
  const keys = columns.filter((c) => !structural.has(c.key)).map((c) => c.key)
  const present = new Set(keys)
  const visible = new Set([...value.visibleColumns, ...(value.lockedColumns ?? [])])
  const groups = resolveAttributeGroups(columns, value)
  const ordered = groups.flatMap((g) => g.columns.map((c) => c.key)).filter((k) => !structural.has(k))
  return sheetLayoutPayload({
    columns: [
      ...ordered.filter((k) => visible.has(k)),
      ...[...visible].filter((k) => !present.has(k) && !structural.has(k)),
    ],
    columnOrder: [...(value.columnOrder ?? []), ...value.visibleColumns, ...(value.lockedColumns ?? []), ...keys].filter((k) => !structural.has(k)),
    lockedColumns: (value.lockedColumns ?? []).filter((k) => !structural.has(k)),
    groupOrder: [...(value.groupOrder ?? []), ...groups.map((g) => g.key)],
    groupOverrides: Object.fromEntries(Object.entries(value.groupOverrides ?? {}).filter(([k]) => !structural.has(k))),
  })
}

/** Resolve stored membership against this column registry without deleting unavailable IDs. */
export function visibleLayoutKeys(payload: ColumnsViewPayload, columns: readonly PreferencesColumnSpec[]): string[] {
  const present = new Set(columns.map((c) => c.key))
  if (payload.v === 2) return payload.columns.filter((k) => present.has(k))
  return layoutFromPreferences(columns, preferencesFromLayout(payload, columns)).columns.filter((k) => present.has(k))
}
