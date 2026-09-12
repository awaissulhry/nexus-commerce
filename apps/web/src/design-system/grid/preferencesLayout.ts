import type { PreferencesValue } from '../patterns/PreferencesModal'
import { mergeVisibleColumnOrder } from './views/columnLayout'

/** Additive fields shared by the advertising stores; older saved views need none of them. */
export type ColumnLayoutPreferences = Pick<PreferencesValue, 'columnOrder' | 'groupOrder' | 'groupOverrides' | 'lockedColumns'>

export function readColumnLayout(value: ColumnLayoutPreferences, known: ReadonlySet<string>): ColumnLayoutPreferences {
  const result: ColumnLayoutPreferences = {}
  for (const field of ['columnOrder', 'groupOrder', 'lockedColumns'] as const) {
    const input = value[field]
    if (Array.isArray(input)) result[field] = [...new Set(input.filter((key): key is string => typeof key === 'string' && (field === 'groupOrder' || known.has(key))))]
  }
  if (value.groupOverrides && typeof value.groupOverrides === 'object' && !Array.isArray(value.groupOverrides)) {
    result.groupOverrides = Object.fromEntries(Object.entries(value.groupOverrides).filter(([key, group]) => known.has(key) && typeof group === 'string'))
  }
  return result
}

export function sameColumnLayout(a: ColumnLayoutPreferences, b: ColumnLayoutPreferences): boolean {
  return (['columnOrder', 'groupOrder', 'lockedColumns'] as const).every((key) =>
    a[key] === b[key] || (a[key]?.length === b[key]?.length && a[key]?.every((item, index) => item === b[key]?.[index])))
    && JSON.stringify(Object.entries(a.groupOverrides ?? {}).sort()) === JSON.stringify(Object.entries(b.groupOverrides ?? {}).sort())
}

/** Header moves update visible slots without losing the position of hidden columns. */
export function withVisibleColumnOrder<T extends ColumnLayoutPreferences>(value: T, visible: readonly string[]): T {
  return { ...value, columnOrder: mergeVisibleColumnOrder(value.columnOrder ?? [], visible.filter((key) => !value.lockedColumns?.includes(key))) }
}
