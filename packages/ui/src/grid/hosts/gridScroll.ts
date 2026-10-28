/**
 * GDS — scrolling the grid horizontally to a POSITION.
 *
 * ## Why this exists at all
 *
 * 🔴 **AG 36.1 has no horizontal-scroll setter.** Its scroll surface is
 * `getHorizontalPixelRange()` — a *reader* — plus `ensureColumnVisible` and `ensureIndexVisible`
 * (`gridApi.d.ts`, grepped for `horizontalScroll|scrollLeft|setHorizontal`: nothing). So a caller
 * that needs "scroll by N pixels" has no supported call, and two separate rulings assumed one
 * existed before anyone read the declaration.
 *
 * `ensureColumnVisible(col, 'start')` is not a substitute, and the reason is worth keeping:
 * measured by UX.1 across 25 positions, its target is derived from the COLUMN and is independent of
 * the viewport — `status` lands at 380 and `brand` at 490 whatever the window width. For the
 * leftmost scrollable column the target is 0, which is where the grid already is, so it **no-ops
 * however badly something is covering that column**. A column-derived target cannot express "clear
 * of an overlay AG cannot see".
 *
 * ## Why it lives in the engine
 *
 * Setting `scrollLeft` on `.ag-grid-viewport.ag-layout-normal` is reaching into AG's own DOM.
 * `design-system/grid/` is the one folder permitted to know AG's internals — that is precisely what
 * `scripts/check-ag-grid-import-boundary.mjs` enforces — so the knowledge is held here and both
 * sheets call a function instead of each growing a private selector.
 *
 * 🔴 The selector is AG-36-specific and was renamed from earlier versions: rows are no longer in
 * `.ag-body-viewport`, and a listener bound to the old name binds to nothing and "never fires"
 * (`reference_ag_grid_probe_traps`). If an AG upgrade moves it again, `gridScrollViewport` returning
 * `null` is the single place that has to change — and every caller already handles `null`, because
 * "there is no viewport" and "the grid will not scroll" are the same answer.
 *
 * The arithmetic is pure and tested; only `scrollGridTo` touches the DOM.
 */

/** AG 36's horizontal scroll source inside a `NexusGrid`. */
export const GRID_SCROLL_VIEWPORT = '.ag-grid-viewport.ag-layout-normal'

/** What the grid can currently give horizontally. */
export interface GridScrollState {
  scrollLeft: number
  /** The largest `scrollLeft` this grid accepts. `0` when nothing is scrollable. */
  maxScroll: number
}

/** The subset of an element this module reads — so the arithmetic is testable without a DOM. */
export interface ScrollMetrics {
  scrollLeft: number
  scrollWidth: number
  clientWidth: number
}

/** Find the scroll source within a grid root (`.ag-root-wrapper`), or `null`. */
export function gridScrollViewport(root: Element | null | undefined): HTMLElement | null {
  return root?.querySelector<HTMLElement>(GRID_SCROLL_VIEWPORT) ?? null
}

/**
 * Read the scrollable range.
 *
 * `maxScroll` is floored at 0: a grid narrower than its viewport reports `scrollWidth < clientWidth`
 * on some zoom levels, and a negative maximum would let a caller scroll to a negative position.
 */
export function gridScrollState(el: ScrollMetrics | null | undefined): GridScrollState | null {
  if (!el) return null
  return { scrollLeft: el.scrollLeft, maxScroll: Math.max(0, el.scrollWidth - el.clientWidth) }
}

/**
 * The position a grid will actually take, given one it was asked for. Pure.
 *
 * Rounded because `scrollLeft` is coerced to an integer by the browser anyway, and an un-rounded
 * target makes a caller's "did it move?" check compare against a value the DOM never held.
 */
export function clampScrollLeft(wanted: number, state: GridScrollState): number {
  if (!Number.isFinite(wanted)) return state.scrollLeft
  return Math.min(Math.max(0, Math.round(wanted)), state.maxScroll)
}

/**
 * Scroll the grid horizontally to `scrollLeft`. Returns the position actually taken, or `null` when
 * there is no viewport to scroll.
 *
 * AG's own scroll listener rides this element, so the grid follows: header, pinned blocks and cell
 * virtualisation all update as they would from a wheel or a drag.
 */
export function scrollGridTo(viewport: HTMLElement | null | undefined, scrollLeft: number): number | null {
  const state = gridScrollState(viewport)
  if (!viewport || !state) return null
  const next = clampScrollLeft(scrollLeft, state)
  /**
   * 🔴 A position it already holds is NOT a scroll — do not touch the DOM (#516).
   *
   * `revealColumn` already refuses a distance of exactly 0, but that is not the only way to end up
   * asking for the position you are on: a NEGATIVE distance under `intent: 'reveal'` clamps to 0
   * when the grid is already at 0. Measured by UX.1 on `brand @1440` — a `scrollLeft` write of the
   * value it already had. Harmless to the operator, and wrong for two reasons worth the three lines:
   *
   *  - AG's scroll listener rides this element, so a redundant assignment is a real event for
   *    something that did not move;
   *  - it makes "the reveal wrote" and "the grid moved" different facts, and the write COUNT is what
   *    the §5.4 checks now assert (#482) — a rule that scrolls when it should not is invisible to a
   *    clearance assertion and visible only in that count. A no-op write spends the one signal that
   *    can catch it.
   *
   * The return value is unchanged — callers still learn the position they ended at, which is the
   * question they asked.
   */
  if (next === state.scrollLeft) return next
  viewport.scrollLeft = next
  return next
}

/**
 * Where a column's RIGHT edge sits in the viewport — computed, not measured.
 *
 * 🔴 Why arithmetic rather than `getBoundingClientRect()`: AG virtualises columns, so the cell you
 * need to measure is frequently not in the DOM at all — which is exactly the case a deep link into
 * a far-right column produces. Measuring what is rendered and falling back to
 * `ensureColumnVisible` for what is not was worse than either: that call is a DESTINATION
 * ("put the column at the left edge"), so the fallback overshot to `maxScroll` and the follow-up
 * measurement then correctly declined to move, leaving the column parked far left of where it
 * belonged. Measured: a cold deep link landed at 1089/1089 with the target 450px clear of the panel
 * on the wrong side.
 *
 * This works whether or not the cell is rendered, and was validated against the DOM on every
 * rendered centre column — delta **0px** on all seven.
 *
 * 🔴 PINNED columns do not follow this: they sit outside the scrolling area, so `columnLeft` is not
 * a centre offset and the arithmetic is meaningless (measured delta −224px). A pinned column also
 * cannot be revealed BY scrolling — it is always on screen — so a caller should treat it as nothing
 * to do rather than feed it through here.
 */
/**
 * How much of the grid the panel actually COVERS, in px. `0` when it covers nothing.
 *
 * 🔴 This is the number the reveal rule has always needed, and `panelWidth` was only ever a
 * coincidence that happened to equal it. While the panel OVERLAID the sheet, "the panel is 520 wide"
 * and "the panel hides 520px of grid" were the same figure, so every consumer read the source
 * instead of the role. When the sheet was INSET beside the panel instead (measured 2026-09-02:
 * grid `67..759`, panel `760..1280`, overlap **0**), the two came apart and
 * `viewportRight − panelWidth − margin` put the "covered" threshold at 223px inside a grid spanning
 * 67..759 — so nearly every cell read as covered while the panel covered nothing, and the reveal
 * scrolled hard enough to push its own target off screen.
 *
 * Nothing failed: the arithmetic was right, tsc was clean and every unit test passed. **A parameter
 * named for its source rather than its role is correct until someone changes the source, and then it
 * is wrong everywhere at once with nothing locally incorrect to find** (PES.2's wording, #408).
 *
 * This form is right under an overlay (it returns the panel's width), under an inset (it returns 0)
 * and under any future layout, because it measures the two edges rather than assuming a relationship
 * between them. `panelLeft` of `null` means no panel is open.
 */
export function panelOverlap(gridRight: number, panelLeft: number | null | undefined): number {
  if (panelLeft == null || !Number.isFinite(panelLeft)) return 0
  return Math.max(0, gridRight - panelLeft)
}

export function gridColumnLeft(geo: {
  /** Viewport-relative left edge of the grid root. */
  hostLeft: number
  /** Total width of the left-pinned block. */
  pinnedLeftWidth: number
  /** `column.getLeft()` — the column's offset inside the scrollable centre area. */
  columnLeft: number
  /** The centre area's current horizontal scroll. */
  scrollLeft: number
}): number {
  return geo.hostLeft + geo.pinnedLeftWidth + (geo.columnLeft - geo.scrollLeft)
}

export function gridColumnRight(geo: {
  /** Viewport-relative left edge of the grid root. */
  hostLeft: number
  /** Total width of the left-pinned block. */
  pinnedLeftWidth: number
  /** `column.getLeft()` — the column's offset inside the scrollable centre area. */
  columnLeft: number
  /** `column.getActualWidth()`. */
  columnWidth: number
  /** The centre area's current horizontal scroll. */
  scrollLeft: number
}): number {
  return geo.hostLeft + geo.pinnedLeftWidth + (geo.columnLeft - geo.scrollLeft) + geo.columnWidth
}

/** Everything §5.4's rule needs about one column, read from AG in one place. */
export interface GridColumnGeometry {
  /** Viewport-relative right edge of the column, computed — correct whether or not it is rendered. */
  cellRight: number
  /** Viewport-relative right edge of the grid itself. */
  viewportRight: number
  /**
   * Viewport-relative LEFT edge of the column, and of the scrollable centre area.
   *
   * 🔴 Needed by `revealDistance(geo, 'reveal')`, which returns 0 without them — so a `?cell=` deep
   * link whose target is off-screen to the LEFT lands nowhere (#412/#416). The uncover rule never
   * asks for these, because the panel can only ever cover the right.
   *
   * 🔴 The asymmetry with `viewportRight` is deliberate. `viewportRight` is the grid's own right
   * edge, because the panel OVERLAYS it. `viewportLeft` adds the pinned block, because the pinned
   * block genuinely OCCUPIES that space: a centre column scrolled under it is hidden, not visible.
   * Using the host's left edge for both would make a column behind the pinned block read as on
   * screen, and `'reveal'` would answer "nothing to do" for precisely the case it exists to fix.
   */
  cellLeft: number
  viewportLeft: number
  scrollLeft: number
  maxScroll: number
  /**
   * How much of the grid the panel covers — NOT the panel's width. See `panelOverlap`: the two are
   * equal only while the panel overlays the sheet, and `0` once it is inset beside it.
   */
  panelOverlap: number
  /** Pinned columns cannot be revealed by scrolling; a caller should treat this as nothing to do. */
  pinned: boolean
}

/**
 * The AG half of a reveal, in ONE place.
 *
 * Both studio sheets need the same three things — where the column's right edge is, where the
 * grid's right edge is, and how far it can scroll — and all three require AG's column model, which
 * only this folder may import. The RULE (`isCellCovered` / `revealDistance` / `revealScroll`) is
 * PES.4's and lives in the drawer; the composition is each host's few lines. That split is why the
 * two sheets cannot drift on the arithmetic while still owning their own behaviour.
 *
 * Returns `null` when the grid or column is not ready to be measured — a caller should stash and
 * retry rather than treat it as "nothing to do", because on a cold deep link this is exactly the
 * state the reveal arrives in.
 */
export function gridColumnGeometry(
  api: { getColumn: (k: string) => unknown; getDisplayedLeftColumns: () => unknown[] } | null | undefined,
  root: HTMLElement | null | undefined,
  colKey: string,
  /**
   * 🔴 REQUIRED, and deliberately so. Viewport-relative left edge of the open panel, or `null` when
   * none is open. An optional parameter defaulting to "no panel" would compile at every existing
   * call site and silently preserve the overlay-era reading — the exact failure this change exists
   * to remove. A caller must state which layout it is in; it is the only one that knows.
   */
  panelLeft: number | null,
): GridColumnGeometry | null {
  if (!api || !root) return null
  const col = api.getColumn(colKey) as
    | { getLeft: () => number | null; getActualWidth: () => number; getPinned: () => string | null }
    | null
    | undefined
  if (!col) return null
  const viewport = gridScrollViewport(root)
  const state = gridScrollState(viewport)
  if (!state) return null
  const box0 = root.getBoundingClientRect()
  if (col.getPinned())
    return { cellRight: 0, viewportRight: 0, cellLeft: 0, viewportLeft: 0, panelOverlap: panelOverlap(box0.right, panelLeft), ...state, pinned: true }
  const columnLeft = col.getLeft()
  if (columnLeft == null) return null
  const pinnedLeftWidth = (api.getDisplayedLeftColumns() as { getActualWidth: () => number }[]).reduce(
    (n, c) => n + c.getActualWidth(),
    0,
  )
  const box = root.getBoundingClientRect()
  const edge = { hostLeft: box.left, pinnedLeftWidth, columnLeft, scrollLeft: state.scrollLeft }
  return {
    cellRight: gridColumnRight({ ...edge, columnWidth: col.getActualWidth() }),
    viewportRight: box.right,
    cellLeft: gridColumnLeft(edge),
    viewportLeft: box.left + pinnedLeftWidth,
    panelOverlap: panelOverlap(box.right, panelLeft),
    ...state,
    pinned: false,
  }
}
