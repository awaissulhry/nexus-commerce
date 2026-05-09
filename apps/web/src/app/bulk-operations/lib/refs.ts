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
  /** P2 #5 — cellKey → pending value when a paste / fill targeted a
   *  virtualised-out cell. EditableCell seeds its draftValue from
   *  here on first mount so the yellow tint shows immediately when
   *  the operator scrolls back into view. */
  pendingValues: Map<string, unknown>
  /** Step 3.5: Enter / Tab inside the input commits then moves the
   *  selection by this delta (Excel semantics). */
  onCommitNavigate: (dRow: number, dCol: number) => void
  /**
   * W3.2 — Set of `${rowIdx}:${colIdx}` keys for cells that currently
   * match the Find / Replace bar's query. Empty when the bar is
   * closed. GridRow looks each cell up here to paint the highlight
   * overlay (W3.3 wires the visual side; the data flow lands here so
   * future cell renderers don't need a new prop).
   */
  findMatchKeys: Set<string>
}

export const editCtxRef: { current: EditCtx } = {
  current: {
    onCommit: () => {},
    cellErrors: new Map(),
    resetKeys: new Map(),
    cascadeKeys: new Set(),
    pendingValues: new Map(),
    onCommitNavigate: () => {},
    findMatchKeys: new Set(),
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

/** EE.2 — active marketplace context (primary tab) for cells that
 *  need to dispatch into channel-specific pickers (productType). */
export const primaryContextRef: {
  current:
    | { channel: 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'WOOCOMMERCE' | 'ETSY'; marketplace: string }
    | null
} = {
  current: null,
}

/** JJ — column-id → group tone + group-edge flag, synced each render
 *  from BulkOperationsClient. GridRow looks tones up here so the body
 *  cells share the per-product editor's tinted look without
 *  threading tone props through the memoised TableRow. */
export interface ColumnTone {
  band: string
  text: string
  cell: string
  /** Whether this column is the LAST visible column in its group.
   *  Body cells use this to render a thicker `border-r-2` so groups
   *  read as visual blocks. */
  isGroupEdge: boolean
}

export const columnTonesRef: { current: Map<string, ColumnTone> } = {
  current: new Map(),
}

/** T.4 — row-level actions (delete, future: duplicate, etc.) so the
 *  actions column renderer can stay outside dynamicColumns' deps. */
export interface ActionsCtx {
  onDelete: (id: string, sku: string, isParent: boolean) => void
}

export const actionsCtxRef: { current: ActionsCtx } = {
  current: { onDelete: () => {} },
}
