// Module-level imperative refs that the cell renderers and TableRow
// reach into without taking everything as React props. The parent
// component's effects mutate `.current` on each render so the refs
// always carry the latest state. Memoised inner components stay
// stable because the refs themselves never change identity.

import type { DisplayMode } from './hierarchy'

export interface EditCtx {
  onCommit: (rowId: string, columnId: string, value: unknown) => void
  cellErrors: Map<string, string>
  /** cellKey → bumped each time parent wants to force-revert that cell */
  resetKeys: Map<string, number>
  /** cellKey → true if its pending change is a cascade (orange tint) */
  cascadeKeys: Set<string>
  /** Step 3.5: Enter / Tab inside the input commits then moves the
   *  selection by this delta (Excel semantics). */
  onCommitNavigate: (dRow: number, dCol: number) => void
}

export const editCtxRef: { current: EditCtx } = {
  current: {
    onCommit: () => {},
    cellErrors: new Map(),
    resetKeys: new Map(),
    cascadeKeys: new Set(),
    onCommitNavigate: () => {},
  },
}

export interface HierarchyCtx {
  mode: DisplayMode
  onToggle: (parentId: string) => void
}

export const hierarchyCtxRef: { current: HierarchyCtx } = {
  current: {
    mode: 'flat',
    onToggle: () => {},
  },
}

export interface SelectCtx {
  select: (rowIdx: number, colIdx: number, shift: boolean) => void
  /** Step 2: arm the document-level mousemove/mouseup listeners for
   *  click+drag rectangle selection. Called on plain mousedown. */
  beginDrag: (rowIdx: number, colIdx: number) => void
  /** Step 5: drag-fill (Excel autofill). Called from the small handle
   *  on the bottom-right of the selection rectangle. */
  beginFill: () => void
}

export const selectCtxRef: { current: SelectCtx } = {
  current: { select: () => {}, beginDrag: () => {}, beginFill: () => {} },
}

/** Bumped from the parent so cell renderers can check marketplace-
 *  context presence without re-mounting on every selector change. */
export const hasMarketplaceContextRef: { current: boolean } = {
  current: false,
}
