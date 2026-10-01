/**
 * 2026-10-01 — the operator's widths survive the sheet rebuilding its column list.
 *
 * Measured on :3650: a width the saved layout applied on landing (Product role 140) was back to the column's default
 * (135) a moment later. The sheet rebuilds its column defs after landing (progress, readiness, header classes), and AG
 * applies a def's `width` again on every rebuild. A def's width is its DEFAULT, so it is handed to AG as `initialWidth`:
 * used when the column is created, never again — the operator's width (and the saved layout's) then stays.
 */
import type { ColDef, ColGroupDef } from '@/design-system/grid'

export function widthsAsDefaults<T>(defs: ReadonlyArray<ColDef<T> | ColGroupDef<T>>): Array<ColDef<T> | ColGroupDef<T>> {
  return defs.map((def) => {
    if ('children' in def) return { ...def, children: widthsAsDefaults(def.children) }
    if (def.width === undefined) return def
    const { width, ...rest } = def
    return { ...rest, initialWidth: def.initialWidth ?? width }
  })
}
