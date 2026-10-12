/**
 * Column widths — the engine's one policy (grid audit B1–B12, 2026-10-13; docs/GRID.md §5). Pure, so it is tested.
 *
 * 1. A column's `width` / `flex` is where it STARTS. AG re-applies a definition's `width` and `flex` every time the
 *    definitions change identity — a 30-second refresh, a filter list arriving, a scope switch — and so threw away a
 *    width a person had dragged (on /products every 30 seconds). Handed to AG as `initialWidth` / `initialFlex`, they
 *    are used when the column is created and never again.
 *    A FIXED column keeps `width`: one a person cannot resize (`resizable: false`) or whose min and max are the same.
 *    Its width is the page's to move (the Matrix's product column follows the room it has).
 * 2. Fitting the columns to the grid's width touches only columns the person never sized: a sized one is held at its
 *    width (`heldLimits`), and a fit runs only when the grid's WIDTH changed, never during a drag.
 */
import type { ColDef, ColGroupDef } from 'ag-grid-community'

type Def<T> = ColDef<T> | ColGroupDef<T>

/** Fixed: the person cannot resize it, or its min and max pin it to one width. */
export function isFixedWidth(def: Pick<ColDef, 'resizable' | 'minWidth' | 'maxWidth'>): boolean {
  return def.resizable === false || (def.minWidth != null && def.minWidth === def.maxWidth)
}

export function widthsAsDefaults<T>(defs: ReadonlyArray<Def<T>>): Array<Def<T>> {
  return defs.map((def) => {
    if ('children' in def) return { ...def, children: widthsAsDefaults(def.children) }
    if ((def.width === undefined && def.flex === undefined) || isFixedWidth(def)) return def
    const { width, flex, ...rest } = def
    return {
      ...rest,
      ...(width !== undefined ? { initialWidth: def.initialWidth ?? width } : {}),
      ...(flex !== undefined && flex !== null ? { initialFlex: def.initialFlex ?? flex } : {}),
    }
  })
}

/** A fit holds every column the person sized at its current width; the rest share the room. */
export function heldLimits(columns: ReadonlyArray<{ getColId(): string; getActualWidth(): number }>, sized: ReadonlySet<string>): Array<{ key: string; minWidth: number; maxWidth: number }> {
  return columns.filter((c) => sized.has(c.getColId())).map((c) => ({ key: c.getColId(), minWidth: c.getActualWidth(), maxWidth: c.getActualWidth() }))
}

/** A size event re-fits only when the grid's width moved (a height change — rows, a scrollbar — is not a reason). */
export function widthMoved(previous: number | null, next: number): boolean {
  return next > 0 && (previous == null || Math.abs(previous - next) >= 1)
}
