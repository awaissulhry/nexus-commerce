/**
 * Listing readiness — how wide the Markets column is.
 *
 * Markets takes the grid's free width (`flex: 1`) when there is free width. On a phone the two pinned columns (the
 * product, 360px, and the actions) fill the whole grid: AG then has no centre width to share out, hides its flex
 * columns while it waits for one (`ag-delay-render`) and never shows them again — an empty grid. Below
 * `READINESS_FILL_MIN_WIDTH` Markets therefore has a fixed width, and a saved column layout (which remembers the
 * `flex`) is read without it. Products has no flex column, so it never meets this. Pure.
 */
/** The part of a saved grid layout this reads (AG's `GridState`, structurally — AG types stay inside the DS). */
interface SizingState { columnSizing?: { columnSizingModel: Array<{ colId: string; width?: number; flex?: number | null }> } }

export const READINESS_FILL_MIN_WIDTH = 640
/** Markets' width when it does not take the free width. */
export const MARKETS_FIXED_WIDTH = 340

/** Whether Markets may take the free width in a grid this wide. */
export const marketsFill = (width: number): boolean => width >= READINESS_FILL_MIN_WIDTH

/** Before the grid has a width: the window's, less the app rail and the page's gutters (about 200px). */
export const marketsFillForWindow = (): boolean => typeof window === 'undefined' || marketsFill(window.innerWidth - 200)

/** The column state that switches Markets between filling and its fixed width. */
export const marketsColumnState = (fill: boolean) =>
  [{ colId: 'markets', ...(fill ? { flex: 1 } : { flex: null, width: MARKETS_FIXED_WIDTH }) }]

/** A saved layout, without Markets' `flex` when the grid has no free width to give it. */
export function sizingForWidth<S extends SizingState>(state: S | undefined, fill: boolean): S | undefined {
  const model = state?.columnSizing?.columnSizingModel
  if (fill || !state || !model) return state
  return {
    ...state,
    columnSizing: { ...state.columnSizing, columnSizingModel: model.map((c) => (c.colId === 'markets' ? { colId: c.colId, width: MARKETS_FIXED_WIDTH } : c)) },
  }
}
