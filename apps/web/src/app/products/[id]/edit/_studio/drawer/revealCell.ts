/**
 * PES.4 §5.4 — is the cell you opened the record FROM now hidden behind the record?
 *
 * A slide-over overlays the right 520px of the sheet. If the operator opened a record from a column
 * in that band, the panel lands on top of the very cell that prompted it — and the panel's own
 * content gives no clue that anything is covered. §5.4: "if the focused cell falls under the drawer,
 * scroll the grid horizontally so that cell sits at least 16px left of the drawer's left edge."
 *
 * ## Why this is a pure function and not a grid call
 *
 * The panel is portalled and holds no `GridApi`; the sheet holds it. So the RULE lives here, where
 * it can be tested against numbers instead of a rendered grid, and the sheet performs the scroll
 * through the capability it already owns. One rule, one place — the same split as `readinessMeta`
 * (design system owns the vocabulary, the lane owns the data), and the same seam shape as
 * `onWrite` and `resolveRow`.
 *
 * ⚠️ `ensureColumnVisible` needs `ScrollApiModule`, registered in `grid/modules.ts` by AG.1 (#184).
 * Before that it threw AG #200. Nothing here calls it; the host does.
 */

/** §5.4 — how much clear air the cell needs to the left of the panel. */
export const REVEAL_MARGIN = 16

export interface RevealGeometry {
  /** Viewport-relative right edge of the cell the record was opened from. */
  cellRight: number
  /** Viewport-relative right edge of the grid's scrollable viewport. */
  viewportRight: number
  /**
   * How much of the grid the panel actually COVERS, in px — not the panel's width (#443).
   *
   * 🔴 They were the same number under an overlay and the name recorded the coincidence rather
   * than the meaning. Under the staged §5.4 inset the panel sits BESIDE the grid and covers
   * nothing, yet a rule fed the panel's width still subtracts 520 and reports cells as hidden that
   * are in plain view. The failure is wrong everywhere at once with nothing locally incorrect to
   * find, which is why the field is named for its role: you cannot pass a width into `panelOverlap`
   * without noticing you are answering a different question.
   *
   * `0` is a legitimate value and means the panel covers no part of the grid.
   */
  panelOverlap: number
  /** Defaults to `REVEAL_MARGIN`. */
  margin?: number
}

/**
 * The geometry a `'reveal'` needs. Separate, and REQUIRED by the reveal overloads (#424).
 *
 * 🔴 These were optional on `RevealGeometry`, and `reveal` with them absent returned 0 — the same
 * shape as the defaulted `intent` beside it: a host could opt in, supply nothing, and get silence
 * with no error, which is exactly what `gridColumnGeometry` did. A capability the caller opts into
 * is required at the TYPE, never an optional field falling back to the old behaviour.
 */
export interface RevealGeometryWithLeft extends RevealGeometry {
  /** Viewport-relative left edge of the cell. */
  cellLeft: number
  /**
   * Left edge of the SCROLLABLE region — after any pinned-left columns, not the host box's edge.
   * A cell tucked behind the pinned block is just as invisible as one off the viewport.
   */
  viewportLeft: number
}

/**
 * Which question is being asked (#412). NOT a heuristic — the caller knows, and guessing is what
 * would put the two paths back in one rule.
 *
 * `uncover` — the VERB path. "Is this cell under the panel?" Never scrolls left, because moving a
 *   grid the operator can already read is the defect the rule was written to avoid.
 * `reveal` — the URL path. A `?cell=` deep link is a request to SEE the cell, which is a different
 *   question. AG's `scroll` state is persisted to localStorage by `useGridState` and restored on a
 *   cold load, so a deep link can arrive with its target already off-screen to the LEFT; `uncover`
 *   correctly answers 0 there and the link lands nowhere, silently (AG.1, #412).
 */
export type RevealIntent = 'uncover' | 'reveal'

/**
 * Does the panel cover this cell?
 *
 * The check is the spec's — `cellRight > viewportRight − panelOverlap` — with the margin folded in,
 * because a cell whose right edge sits exactly ON the panel's left edge is touching it, and a cell
 * one pixel clear reads as covered to anyone glancing. `panelOverlap` is read rather than assumed:
 * the panel is resizable between 380 and 720, so a hard 520 would under-scroll a widened panel and
 * over-scroll a narrowed one.
 */
export function isCellCovered({ cellRight, viewportRight, panelOverlap, margin = REVEAL_MARGIN }: RevealGeometry): boolean {
  return cellRight > viewportRight - panelOverlap - margin
}

/**
 * How far the grid must scroll, in px. Positive = right, negative = left, 0 = nothing need move.
 *
 * Returned rather than applied so the caller can choose the mechanism — `ensureColumnVisible` moves
 * by column, which is coarser but supported; a future horizontal scroll API could use this exactly.
 *
 * 🔴 The sign depends on the INTENT, and that is the whole of #412. Under `uncover` this is never
 * negative: it only ever uncovers, because scrolling the other way to "centre" a cell would move a
 * grid the operator was already reading. Under `reveal` it also scrolls LEFT, because a `?cell=`
 * deep link asks to SEE the cell rather than asking whether the panel covers it — and with AG's
 * scroll position restored from localStorage the target can already be off the left edge, where the
 * never-negative rule answers 0 and the deep link lands nowhere without saying so.
 *
 * The left branch needs `cellLeft`/`viewportLeft`; without them the question cannot be answered, so
 * it returns 0 rather than guessing from the right edge.
 */
export function revealDistance(geo: RevealGeometry, intent: 'uncover'): number
export function revealDistance(geo: RevealGeometryWithLeft, intent: 'reveal'): number
/**
 * 🔴 The third overload is NOT redundant — omitting it broke every real call site.
 *
 * Both hosts forward `intent` as a VARIABLE of type `RevealIntent`, and a union matches neither
 * literal-keyed overload. The first run of this change compiled in isolation and produced
 * `TS2769: No overload matches this call` at `ChannelSheet:422` and `MasterSheet:209`. The proof
 * had only ever passed LITERALS: it tested the shape I imagined, not the shape the callers use.
 *
 * A caller whose intent is dynamic must supply the left edges, because it might turn out to be a
 * reveal. The guarantee is unchanged — opt in and you cannot forget the geometry.
 */
export function revealDistance(geo: RevealGeometryWithLeft, intent: RevealIntent): number
export function revealDistance(
  geo: RevealGeometry & Partial<RevealGeometryWithLeft>,
  intent: RevealIntent,
): number {
  const margin = geo.margin ?? REVEAL_MARGIN
  if (isCellCovered(geo)) {
    return Math.ceil(geo.cellRight - (geo.viewportRight - geo.panelOverlap - margin))
  }
  if (intent !== 'reveal') return 0
  if (geo.cellLeft == null || geo.viewportLeft == null) return 0
  const floor = geo.viewportLeft + margin
  if (geo.cellLeft >= floor) return 0
  // Negative: the grid must scroll LEFT by this much to bring the cell clear of the left edge.
  return -Math.ceil(floor - geo.cellLeft)
}

/**
 * Is the panel's position KNOWN yet?
 *
 * 🔴 Three states, not two, and collapsing either of the first two into "nothing to do" is the
 * defect this exists to prevent (#747/#750). A cold deep link (`?rec=…&cell=…`) is served while the
 * drawer is still arriving, and it passes through BOTH of them: for the first commits the panel
 * element does not exist at all, and once it does it has not yet published `data-resting-left`.
 * Either one read as "no panel" becomes `panelOverlap: 0` → `isCellCovered: false` →
 * `revealDistance: 0` → the host returns `true`, the caller reads success, and the pending reveal is
 * never stashed or replayed. The cell stays under the panel and nothing anywhere reports a failure.
 *
 * 🔴 `recordOpen` is why the element's absence is not self-describing, and it is the whole of #750.
 * "No panel in the DOM" and "no panel YET" are the same query and opposite answers, and only the
 * app knows which: the URL cursor says a record IS open long before the drawer portals into a track
 * that is itself set by an effect. Fixing only the published-position case left the earlier window
 * wide open, and the measurement that proves it is a PAIR taken on one cold load (UX.1, witnessed
 * interceptor, 1280): `bullet_point` — inside the viewport, covered by the panel by 24px — wrote
 * nothing, while `supplier_declared_dg_hz_regulation` — off the viewport's right edge — wrote 300 on
 * the same host in the same run. **Only `panelOverlap: 0` produces both**: an off-screen column
 * clears the threshold on the viewport edge alone, an under-the-panel column needs the overlap that
 * was never measured. A single reading could not have told those apart.
 *
 * So the caller states whether a panel is EXPECTED, and it is a required argument rather than a
 * defaulted one: every host must answer, and none can keep the old reading by saying nothing (the
 * same rule as `RevealGeometryWithLeft` at #424, for the same reason).
 *
 * This was the third instance in one day of a measurement that COULD NOT BE TAKEN being reported as
 * a measurement that came back empty — after `if (!band) return` at the band width, and the 0-width
 * `[data-studio-dock]` at #437 — and UX.1 has since found two more in the INSTRUMENTS rather than
 * the product. `'pending'` is what makes the difference sayable.
 */
export type PanelReadiness = { kind: 'none' } | { kind: 'pending' } | { kind: 'at'; left: number }

export function panelReadiness(
  panelPresent: boolean,
  restingLeft: string | null,
  /** Does the APP say a record is open? The DOM cannot answer this while the drawer is arriving. */
  recordOpen: boolean,
): PanelReadiness {
  // Expected but not here yet — the cold-deep-link window, and `none` is the wrong answer in it.
  if (!panelPresent) return recordOpen ? { kind: 'pending' } : { kind: 'none' }
  if (restingLeft === null || restingLeft === '') return { kind: 'pending' }
  const n = Number(restingLeft)
  /* A non-numeric attribute is not a position. NOT `Number(x) || 0`: that turns "abc" into a real
     zero and the panel would be reported as sitting at the viewport's left edge. */
  return Number.isFinite(n) ? { kind: 'at', left: n } : { kind: 'pending' }
}

/* ── the stash: what happens to a reveal that could not be served ──────────────────────────── */

export interface RevealRequest {
  colKey: string
  /**
   * 🔴 The stash carries the INTENT. The `?rec=&cell=` path is both the one that needs `'reveal'`
   * and the one that always defers, so a stash without it replays as `'uncover'` and loses exactly
   * the deep-link case — silently, because the replay still reports success (PES.3).
   */
  intent: RevealIntent
}

/**
 * What either host should hold after something happens to a reveal. ONE policy, because master and
 * channel had the same line and would otherwise fix it twice and differently (PES.3's request).
 *
 * 🔴 `'replay'` KEEPING an unserved request is the correction (#750). The old policy cleared the
 * stash before attempting — "replay once, whether or not it succeeds" — on the reasoning that a
 * surviving stash would scroll the grid at some later unrelated render. That reasoning is sound and
 * the conclusion was still wrong: on a cold load the single replay fires on `gridReady`, which
 * races the drawer's arrival, so the one attempt lands in the very window `panelReadiness` now
 * reports as `pending` and the request is discarded having never once been measurable. A retry that
 * gives up before the thing it waits for can exist is not a retry.
 *
 * The stale-scroll hazard it was guarding against is real, and `'recordClosed'` is what answers it:
 * the stash is dropped when the record it belongs to goes away, so nothing can replay into a sheet
 * whose drawer has closed. That is a narrower guard than "clear it immediately" and it does not cost
 * the case the whole mechanism exists for.
 */
export type RevealStashEvent =
  /** A fresh request from the drawer. `served` is the host's return: false = could not measure. */
  | { kind: 'request'; request: RevealRequest; served: boolean }
  /** A replay attempt of whatever is stashed. */
  | { kind: 'replay'; served: boolean }
  /** The record closed — whatever is stashed is about a drawer that is no longer there. */
  | { kind: 'recordClosed' }

export function revealStash(current: RevealRequest | null, event: RevealStashEvent): RevealRequest | null {
  switch (event.kind) {
    case 'request':
      return event.served ? null : event.request
    case 'replay':
      // Kept when it could not be served: the panel may still be on its way.
      return event.served ? null : current
    case 'recordClosed':
      return null
  }
}

/* ── where the panel WILL be, before it gets there ────────────────────────────────────────── */

export interface RestingPanel {
  /** Viewport-relative left edge the panel settles at. */
  left: number
  /**
   * True when the panel covers the whole sheet, so revealing is pointless. The caller ABSTAINS with
   * a stated reason rather than returning a silent zero — a silent refusal is indistinguishable
   * from a rule that ran and found nothing, which is the shape this reveal has already been bitten
   * by twice.
   */
  coversSheet: boolean
}

/**
 * The panel's RESTING geometry, computed — never measured mid-animation (#651).
 *
 * 🔴 `.nds-drawer-dock` enters on `nds-slidein 0.18s` from `translateX(100%)`. Any host that reads
 * its live rect in the frame it mounts gets the viewport's right edge and computes an overlap of 0,
 * so nothing looks covered and nothing scrolls. The drawer knows where it is going before it moves,
 * so it publishes that instead of anyone measuring a moving element. Waiting on the animation was
 * the other option and is worse: an unbounded await trades a missing scroll for a missing reveal.
 *
 * 🔴 From the USED width, not the persisted one. The panel is `width: 520px; max-width: 100%` and
 * goes full-bleed under 720px, so below that — and whenever a resized panel is wider than the
 * viewport — the used width is the viewport and the resting left is 0. Using the persisted 520 on a
 * 700px viewport would publish 180 and claim 520px of grid is covered while the panel covers all of
 * it: wrong in the direction that matters, since cells would be reported clear while invisible.
 */
/**
 * The viewport at which the panel stops being a panel — `components.css:589`,
 * `@media (max-width: 719px) { .nds-drawer-dock { width: 100% } }`. Mirrored here because this
 * function must agree with the stylesheet, and a mismatch is silent: the value would be plausible
 * and wrong, which is the failure mode the whole resting-geometry change exists to remove.
 */
export const PANEL_FULL_BLEED_MAX = 719

export function restingPanel(viewportWidth: number, persistedWidth: number): RestingPanel {
  const vw = Math.max(0, viewportWidth)
  // 🔴 THREE cases, not two. The ruled formula `vw − min(persisted, vw)` covers the clamp but not
  // the media query: at 700/520 it yields 180 — a panel 520 wide sitting 180 from the left — when
  // the stylesheet has already made it full-bleed. Its own test case says 0, and the test is right.
  const used = vw <= PANEL_FULL_BLEED_MAX ? vw : Math.min(Math.max(0, persistedWidth), vw)
  return { left: Math.max(0, vw - used), coversSheet: used >= vw }
}

/* ── which cell the record was opened FROM ─────────────────────────────────────────────────── */

/**
 * Grid chrome — never the cell an operator was working in.
 *
 * A union across both sheets on purpose: `alias` is PES.3's, `__identity` / `ag-Grid-AutoColumn`
 * are the master tree's, `actions` is the `⋯` column both carry. New chrome ids get added HERE, so
 * two surfaces cannot end up with different ideas of what counts as chrome.
 */
const CHROME_COLUMNS = new Set(['actions', '__identity', 'alias', 'ag-Grid-AutoColumn'])

/**
 * Should this focus event update "the cell the record would be opened from"?
 *
 * 🔴 Measured by PES.3, and the reason this is a function rather than `getFocusedCell()` read at the
 * moment the verb runs: clicking the `⋯` button MOVES AG's focus to the actions cell. Reading focus
 * inside `openRecord` therefore yielded `cell=actions` — a PINNED column, always visible, so
 * `isCellCovered` computed "not covered" and nothing ever scrolled. **The whole reveal was inert
 * and looked implemented**, which is the worst shape a feature can fail in: the code runs, the
 * measurement says fine, and the operator's cell is still hidden.
 *
 * Lifted here from `sheet/channel/rows.ts` at the hub's direction (#227) so master and channel
 * import ONE rule — the same reason `isCellCovered` lives here rather than in either sheet.
 */
export function isRevealAnchor(colId: string | undefined | null): boolean {
  return !!colId && !CHROME_COLUMNS.has(colId)
}

/* ── turning the distance into a scroll position ───────────────────────────────────────────── */

export interface RevealScroll {
  /** The `scrollLeft` to set. Already clamped to the scrollable range. */
  scrollLeft: number
  /**
   * How much of the needed distance the grid CANNOT give, in px. Zero when the cell can be fully
   * cleared. Non-zero only for columns near the end of the list, where there is no scroll left —
   * the trailing-column case a right-hand scroll pad would remove.
   */
  unreachableBy: number
}

/**
 * Where to scroll to, given how far the cell must move.
 *
 * 🔴 Why this exists rather than `ensureColumnVisible(col, 'start')`. Measured by UX.1 across 25
 * positions: `ensureColumnVisible` scrolls the column to the grid's LEFT EDGE, so its target is
 * derived from the COLUMN and is independent of the viewport — `status` lands at 380 and `brand` at
 * 490 whatever the window width. For the leftmost scrollable column the target is 0, which is where
 * the grid already sits, so it no-ops however badly the panel covers it: 27px overlaps scrolled,
 * `name` at 77px did not. AG has no idea the panel exists, and a column-derived target cannot
 * express "clear of an overlay".
 *
 * So the reveal is a POSITION, not a column: `revealDistance`'s px added to where the grid is now,
 * clamped to what it can actually give. Both hosts call this so neither re-derives the arithmetic
 * — the same reason `isCellCovered` lives here.
 */
export function revealScroll(distance: number, scrollLeft: number, maxScroll: number): RevealScroll {
  // 🔴 Negative distances now MOVE the grid (#412). They used to be treated as "nothing to do",
  // which was the right reading while `revealDistance` could not produce one. The never-negative
  // guarantee did not disappear — it moved to where the ruling put it, in the INTENT, so the verb
  // path still cannot generate a leftward scroll. Keeping the no-op here as well would have made
  // the intent unimplementable, silently, one layer below where anyone was looking.
  if (distance === 0) return { scrollLeft, unreachableBy: 0 }
  const wanted = scrollLeft + distance
  const clamped = Math.min(Math.max(wanted, 0), Math.max(0, maxScroll))
  // Reported rather than swallowed: a caller that scrolled as far as it could and still left the
  // cell covered should be able to say so, instead of silently appearing to have worked.
  return { scrollLeft: clamped, unreachableBy: Math.abs(wanted - clamped) }
}
