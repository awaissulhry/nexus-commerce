import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
/**
 * PES.4 §5.4 — the covered-cell rule, tested as arithmetic rather than against a rendered grid.
 *
 * The failure this guards is silent by construction: if the rule is wrong, the panel opens over the
 * cell the operator was looking at and NOTHING on screen says so. There is no error, no empty
 * state, no console line — just a column that is no longer where it was.
 */
import { describe, expect, it } from 'vitest'

import { isCellCovered, isRevealAnchor, panelReadiness, revealDistance, revealScroll, revealStash, REVEAL_MARGIN, restingPanel, PANEL_FULL_BLEED_MAX} from './revealCell'

const at = (cellRight: number, panelOverlap = 520) => ({ cellRight, viewportRight: 1728, panelOverlap })

describe('isCellCovered', () => {
  it('a cell well left of the panel is not covered', () => {
    expect(isCellCovered(at(600))).toBe(false)
  })

  it('a cell under the panel is covered', () => {
    // Panel occupies 1208..1728. A cell ending at 1400 is beneath it.
    expect(isCellCovered(at(1400))).toBe(true)
  })

  it('🔴 a cell TOUCHING the panel edge counts as covered — the margin is the point', () => {
    // Exactly on the edge: visible by a strict reading, and unreadable in practice.
    expect(isCellCovered(at(1728 - 520))).toBe(true)
    // One margin clear: fine.
    expect(isCellCovered(at(1728 - 520 - REVEAL_MARGIN))).toBe(false)
  })

  it('reads the panel WIDTH rather than assuming 520 — it is resizable 380–720', () => {
    // A cell at 1300 is clear of a 380px panel and under a 720px one. Hard-coding 520 would get
    // one of these two wrong on every drag of the grip.
    expect(isCellCovered(at(1300, 380))).toBe(false)
    expect(isCellCovered(at(1300, 720))).toBe(true)
  })
})

describe('revealDistance', () => {
  it('is 0 when nothing need move', () => {
    expect(revealDistance(at(600), 'uncover')).toBe(0)
  })

  it('is exactly enough to clear the panel plus the margin', () => {
    // cell 1400, panel left edge 1208, target right edge 1192 → move 208.
    expect(revealDistance(at(1400), 'uncover')).toBe(1400 - (1728 - 520 - REVEAL_MARGIN))
  })

  it('🔴 never negative — this uncovers a cell, it does not re-centre a visible one', () => {
    // A cell far left would produce a negative "distance" under naive arithmetic, and scrolling by
    // it would drag the grid sideways for a cell that was already fine.
    expect(revealDistance(at(100), 'uncover')).toBe(0)
    expect(revealDistance(at(0), 'uncover')).toBe(0)
  })
})

describe('isRevealAnchor', () => {
  it('🔴 rejects the chrome columns focus lands on when a verb is CLICKED', () => {
    // The measured failure: clicking `⋯` moves AG focus to the actions cell, which is pinned and
    // always visible — so the reveal computed "not covered" and never scrolled. The feature ran,
    // measured fine, and left the operator's cell hidden.
    expect(isRevealAnchor('actions')).toBe(false)
    expect(isRevealAnchor('__identity')).toBe(false)
    expect(isRevealAnchor('ag-Grid-AutoColumn')).toBe(false)
    expect(isRevealAnchor('alias')).toBe(false)
  })

  it('accepts a real data column', () => {
    expect(isRevealAnchor('item_name')).toBe(true)
    expect(isRevealAnchor('country_of_origin')).toBe(true)
  })

  it('treats absent focus as no anchor rather than a truthy default', () => {
    expect(isRevealAnchor(undefined)).toBe(false)
    expect(isRevealAnchor(null)).toBe(false)
    expect(isRevealAnchor('')).toBe(false)
  })
})

describe('revealScroll', () => {
  it('adds the distance to where the grid currently is', () => {
    // A POSITION, not a column. `ensureColumnVisible(col, "start")` targets the column's own left
    // edge, which is viewport-independent — so for the leftmost scrollable column it targets 0, the
    // grid is already there, and it no-ops however covered the cell is (UX.1, 25 positions).
    expect(revealScroll(75, 0, 1409)).toEqual({ scrollLeft: 75, unreachableBy: 0 })
    expect(revealScroll(92, 300, 1409)).toEqual({ scrollLeft: 392, unreachableBy: 0 })
  })

  it('moves nothing for a zero distance', () => {
    expect(revealScroll(0, 250, 1409)).toEqual({ scrollLeft: 250, unreachableBy: 0 })
  })

  it('🔴 scrolls LEFT for a negative distance — this assertion was inverted before #412', () => {
    // It read `revealScroll(-40, 250, 1409) → 250` ("nothing to do"), which was correct while
    // `revealDistance` could never return a negative. #412 made it able to, for the URL path, and
    // leaving the no-op here would have made the ruled intent unimplementable one layer below
    // where anyone was looking — a test protecting the old contract against the new one.
    expect(revealScroll(-40, 250, 1409)).toEqual({ scrollLeft: 210, unreachableBy: 0 })
  })

  it('clamps a leftward scroll at 0 and reports what it could not give', () => {
    expect(revealScroll(-300, 100, 1409)).toEqual({ scrollLeft: 0, unreachableBy: 200 })
  })

  it('🔴 clamps to the scrollable range and REPORTS what it could not give', () => {
    // The trailing-column case: a cell within a panel-width of the end cannot be cleared, because
    // the scroll does not exist. Silently clamping would look like it worked.
    expect(revealScroll(200, 1300, 1409)).toEqual({ scrollLeft: 1409, unreachableBy: 91 })
    expect(revealScroll(500, 1409, 1409)).toEqual({ scrollLeft: 1409, unreachableBy: 500 })
  })

  it('never returns a negative scrollLeft on a grid with nothing to scroll', () => {
    expect(revealScroll(120, 0, 0)).toEqual({ scrollLeft: 0, unreachableBy: 120 })
  })
})


/* ── #412: the intent decides the direction ────────────────────────────────────────────────── */

describe('revealDistance — caller-supplied intent (#412)', () => {
  /**
   * A cell off the LEFT edge. Reachable in practice because `useGridState` persists AG's `scroll`
   * state to localStorage and restores it on a cold load, so a `?cell=` link can arrive with its
   * target already scrolled past.
   */
  const offLeft = {
    cellRight: 120,
    cellLeft: 40,
    viewportLeft: 200,
    viewportRight: 1728,
    panelOverlap: 520,
  }

  it('URL path: a cell off the left edge scrolls LEFT to reveal it', () => {
    const d = revealDistance(offLeft, 'reveal')
    expect(d).toBeLessThan(0)
    // Clear of the left edge by the margin: 40 → 200 + 16.
    expect(d).toBe(-(200 + REVEAL_MARGIN - 40))
    expect(revealScroll(d, 500, 1409).scrollLeft).toBe(500 + d)
  })

  it('verb path: the SAME cell stays put — never-negative is unchanged there', () => {
    expect(revealDistance(offLeft, 'uncover')).toBe(0)
  })

  it('the right-hand uncover rule is identical under both intents', () => {
    const covered = { cellRight: 1400, cellLeft: 1300, viewportLeft: 0, viewportRight: 1728, panelOverlap: 520 }
    expect(revealDistance(covered, 'reveal')).toBe(revealDistance(covered, 'uncover'))
    expect(revealDistance(covered, 'uncover')).toBeGreaterThan(0)
  })

  it('🔴 reveal WITHOUT the left edges no longer compiles — the type refuses it (#424)', () => {
    // This used to assert a runtime 0: "unanswerable, so do not guess". The required-geometry
    // overload turns that into a COMPILE error, which is strictly better — a caller cannot reach
    // the runtime branch to be protected by it. The assertion is now the `@ts-expect-error`; if the
    // overload ever loosens, this line stops erroring and the test fails.
    // @ts-expect-error — 'reveal' requires cellLeft/viewportLeft
    expect(() => revealDistance({ cellRight: 120, viewportRight: 1728, panelOverlap: 520 }, 'reveal')).toBeDefined()
  })

  it('a cell already clear of the left edge is left alone under reveal', () => {
    const fine = { cellRight: 700, cellLeft: 600, viewportLeft: 200, viewportRight: 1728, panelOverlap: 520 }
    expect(revealDistance(fine, 'reveal')).toBe(0)
  })
})


/* ── #443: the inset layout, where the panel covers nothing ────────────────────────────────── */

/**
 * 🔴 Every fixture above encodes OVERLAY geometry — `panelOverlap: 520`, a panel lying on top of
 * the grid. A rule proven only against one layout is proven for one layout, and the §5.4 inset is
 * the other: the panel sits BESIDE the grid, so the overlap is 0 and nothing is covered however
 * wide the panel is. That distinction is invisible while the two numbers coincide, which is exactly
 * how a width came to be passed as an overlap in the first place.
 */
describe('inset layout — panelOverlap 0', () => {
  const inset = (cellRight: number, cellLeft = cellRight - 100) => ({
    cellRight,
    cellLeft,
    viewportLeft: 200,
    viewportRight: 1728,
    panelOverlap: 0,
  })

  it('covers nothing, however close to the right edge the cell sits', () => {
    expect(isCellCovered(inset(1700))).toBe(false)
    // The same cell IS covered once a panel actually overlaps the grid — the fixtures differ in
    // one number, which is the whole point.
    expect(isCellCovered({ ...inset(1700), panelOverlap: 520 })).toBe(true)
  })

  it("`uncover` returns 0 — there is nothing to uncover", () => {
    expect(revealDistance(inset(1700), 'uncover')).toBe(0)
    expect(revealDistance(inset(600), 'uncover')).toBe(0)
  })

  it('🔴 `reveal` STILL scrolls left for an off-left cell — the left edge is unrelated to the panel', () => {
    // The panel overlays the right; the pinned block occupies the left. An inset panel changes the
    // first and not the second, so the deep-link case must survive a layout that covers nothing.
    const offLeft = { ...inset(120, 40) }
    const d = revealDistance(offLeft, 'reveal')
    expect(d).toBe(-(200 + REVEAL_MARGIN - 40))
    expect(revealScroll(d, 500, 1409).scrollLeft).toBe(500 + d)
  })

  it('a cell clear of the left edge is left alone under either intent', () => {
    expect(revealDistance(inset(900, 800), 'reveal')).toBe(0)
    expect(revealDistance(inset(900, 800), 'uncover')).toBe(0)
  })
})

/* ── #651: resting geometry, computed rather than measured ─────────────────────────────────── */

describe('restingPanel — the four cases the ruling names', () => {
  it('1440 viewport / 520 panel → 920', () => {
    expect(restingPanel(1440, 520)).toEqual({ left: 920, coversSheet: false })
  })

  it('🔴 700 viewport / 520 panel → 0 and ABSTAINS — the panel is full-bleed under 720px', () => {
    // Using the persisted 520 here would publish 180 and claim 520px covered while it covers 700.
    expect(restingPanel(700, 520)).toEqual({ left: 0, coversSheet: true })
  })

  it('🔴 600 viewport / 720 persisted → 0 and ABSTAINS — max-width clamps before the media query', () => {
    // The grip allows up to 720, so a resized panel is clamped on any narrower viewport with no
    // media query involved. The clamp case and the full-bleed case must answer alike.
    expect(restingPanel(600, 720)).toEqual({ left: 0, coversSheet: true })
  })

  it('the resize case: 1440 → 700 moves the value, it does not stick', () => {
    expect(restingPanel(1440, 520).left).toBe(920)
    expect(restingPanel(700, 520).left).toBe(0)
  })

  it('🔴 the boundary is the STYLESHEET\'s 719/720, not the panel width', () => {
    // This assertion was wrong first time: I expected 521/520 → left 1, reasoning only about the
    // clamp. At any viewport ≤ 719 the media query has already made the panel full-bleed, so the
    // panel's own width is irrelevant there. The code was right and the test was wrong.
    expect(restingPanel(719, 520)).toEqual({ left: 0, coversSheet: true })
    expect(restingPanel(720, 520)).toEqual({ left: 200, coversSheet: false })
    expect(restingPanel(521, 520)).toEqual({ left: 0, coversSheet: true })
  })

  it('never negative', () => {
    expect(restingPanel(0, 520)).toEqual({ left: 0, coversSheet: true })
    expect(restingPanel(1440, 0)).toEqual({ left: 1440, coversSheet: false })
  })
})


/* ── the mirror guarded by reading the other side (#652) ───────────────────────────────────── */

/**
 * `PANEL_FULL_BLEED_MAX` mirrors a number that lives in CSS, and a CSS media query cannot read a
 * custom property — so a shared token would be a second mirror, not one fewer. The mirror stays
 * local and is made unable to drift SILENTLY instead: this reads the stylesheet, finds the
 * `.nds-drawer-dock` full-bleed rule by SELECTOR (never by line number, which moves), and asserts
 * the two agree. If either side changes alone the suite goes red naming both.
 *
 * Every failure path RETURNS a reason rather than throwing: a throw at module scope collects as
 * "no tests" and reads as a skip, which is how a guard of mine went quiet for hours tonight.
 */
function fullBleedBreakpointFromCss(): { px: number | null; problem: string | null } {
  let dir = dirname(fileURLToPath(import.meta.url))
  let cssPath: string | null = null
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, 'design-system', 'styles', 'components.css')
    if (existsSync(candidate)) { cssPath = candidate; break }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (!cssPath) return { px: null, problem: 'components.css not found by walking up from this test' }

  let css: string
  try { css = readFileSync(cssPath, 'utf8') } catch (e) {
    return { px: null, problem: `components.css could not be read: ${(e as Error).message}` }
  }

  // Every `@media (max-width: Npx) { … }` block, matched by brace balance, that styles the dock.
  const re = /@media\s*\(max-width:\s*(\d+)px\s*\)\s*\{/g
  for (let m = re.exec(css); m; m = re.exec(css)) {
    let depth = 1
    let i = m.index + m[0].length
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === '{') depth++
      else if (css[i] === '}') depth--
    }
    const body = css.slice(m.index + m[0].length, i)
    if (body.includes('.nds-drawer-dock') && /width:\s*100%/.test(body)) {
      return { px: Number(m[1]), problem: null }
    }
  }
  return { px: null, problem: 'no @media (max-width: …) rule sets .nds-drawer-dock to width: 100%' }
}

describe('PANEL_FULL_BLEED_MAX matches the stylesheet it mirrors', () => {
  const { px, problem } = fullBleedBreakpointFromCss()

  it('the extractor actually found the rule', () => {
    expect(problem).toBeNull()
    expect(px).toBeGreaterThan(0)
  })

  it('🔴 the mirrored constant equals the CSS breakpoint', () => {
    expect(px).toBe(PANEL_FULL_BLEED_MAX)
  })

  it('and the constant is the one restingPanel actually uses', () => {
    // Guards the pair rather than the constant: a correct number wired to nothing proves nothing.
    expect(restingPanel(PANEL_FULL_BLEED_MAX, 520).coversSheet).toBe(true)
    expect(restingPanel(PANEL_FULL_BLEED_MAX + 1, 520).coversSheet).toBe(false)
  })
})


/* ── #747: the 24px-covered deep link, and the three-state panel ──────────────────────────────
 *
 * PES.3's reproduction, Amazon·IT at 1280, `?rec=…&cell=bullet_point`: cell `674..784`, panel
 * resting left `760`, host `67..1279`, `scrollLeft 0`, `maxScroll 1435` — covered by 24px with room
 * to scroll, and NO scroll written. The rule was never wrong; it was never reached with those
 * inputs.
 */
describe('#747 — the deep link that stayed under the drawer', () => {
  /** The exact geometry, as measured. */
  const geo = { cellRight: 784, viewportRight: 1279, panelOverlap: 1279 - 760, cellLeft: 674, viewportLeft: 67 }

  it('🔴 given the REAL inputs the rule says scroll — so the rule is not the defect', () => {
    expect(isCellCovered(geo)).toBe(true)
    /* threshold = viewportRight − panelOverlap − REVEAL_MARGIN = 1279 − 519 − 16 = 744;
       cellRight 784 → 40.
       ⚠ PES.3's report derived 32 from an assumed margin of 8; `REVEAL_MARGIN` is 16, so the
       distance is 40. Their CONCLUSION is unchanged and correct — the rule says scroll — but the
       number was arithmetic from an assumed constant, and I put it straight into an assertion
       without checking it. Derived from the exported constant here so it cannot drift again. */
    expect(REVEAL_MARGIN).toBe(16)
    expect(revealDistance(geo, 'reveal')).toBe(geo.cellRight - (geo.viewportRight - geo.panelOverlap - REVEAL_MARGIN))
    expect(revealDistance(geo, 'reveal')).toBe(40)
  })

  it('and the scroll is reachable — maxScroll 1435 from scrollLeft 0', () => {
    expect(revealScroll(40, 0, 1435)).toEqual({ scrollLeft: 40, unreachableBy: 0 })
  })

  it('🔴 with the panel read as ABSENT the same cell reads as clear — the shape that hid it', () => {
    // `panelOverlap: 0` is what a missing `data-resting-left` produced. Nothing is covered, the
    // distance is 0, and the host returned `true` — success, to a caller that then never replayed.
    expect(isCellCovered({ ...geo, panelOverlap: 0 })).toBe(false)
    expect(revealDistance({ ...geo, panelOverlap: 0 }, 'reveal')).toBe(0)
  })

  it('at 1440 the same cell is genuinely clear and must NOT move', () => {
    // Panel left 920 → overlap 359 → threshold 912; cellRight 784 is well clear.
    expect(revealDistance({ ...geo, viewportRight: 1439, panelOverlap: 1439 - 920 }, 'reveal')).toBe(0)
  })
})

describe('panelReadiness — "not measurable yet" is not "nothing there"', () => {
  it('no panel and no record open is NONE — nothing is open and no overlap is the truth', () => {
    expect(panelReadiness(false, null, false)).toEqual({ kind: 'none' })
  })

  it('🔴 no panel while a record IS open is PENDING — the cold-deep-link window (#750)', () => {
    // The defect that survived #747. `record.rowId` is set from the URL before the drawer has a
    // track to portal into, so for the first commits the panel element does not exist AT ALL —
    // and read as `none` that is `panelOverlap: 0`, distance 0, and a `true` the caller believes.
    expect(panelReadiness(false, null, true)).toEqual({ kind: 'pending' })
    expect(panelReadiness(false, '', true)).toEqual({ kind: 'pending' })
  })

  it('🔴 a panel that has not published its resting left is PENDING, not none', () => {
    // The later window: the drawer is mounting, the element exists, the position does not.
    expect(panelReadiness(true, null, true)).toEqual({ kind: 'pending' })
    expect(panelReadiness(true, '', true)).toEqual({ kind: 'pending' })
    // And it does not depend on the cursor — a present element answers for itself.
    expect(panelReadiness(true, null, false)).toEqual({ kind: 'pending' })
  })

  it('a published position is AT that position, whatever the cursor says', () => {
    expect(panelReadiness(true, '760', true)).toEqual({ kind: 'at', left: 760 })
    expect(panelReadiness(true, '760', false)).toEqual({ kind: 'at', left: 760 })
    expect(panelReadiness(true, '0', true)).toEqual({ kind: 'at', left: 0 })
  })

  it('🔴 a non-numeric attribute is PENDING, never a real zero', () => {
    // `Number(x) || 0` would put the panel at the viewport's left edge and cover the whole grid.
    expect(panelReadiness(true, 'abc', true)).toEqual({ kind: 'pending' })
  })
})

describe('#750 — the pair that told the two cases apart', () => {
  /**
   * One cold load at 1280, one host, interceptor witnessed (UX.1). Two columns, two outcomes:
   *   bullet_point                        674..784, covered by the panel by 24px  → writes []
   *   supplier_declared_dg_hz_regulation  off the viewport's right edge           → writes [300]
   *
   * The point of this block is that ONE of those readings could not have diagnosed anything. The
   * empty list alone reads as "the reveal is broken"; the 300 alone reads as "the reveal works".
   * Together they identify the input, because only `panelOverlap: 0` produces both.
   */
  const viewportRight = 1279

  it('🔴 with overlap 0 the off-screen column still scrolls — the machinery is NOT dead', () => {
    // Off the right edge: covered on the viewport edge alone, no panel needed. This is why the
    // cold path looked partly alive and why "nothing runs" was the wrong hypothesis.
    const far = { cellRight: viewportRight + 284, viewportRight, panelOverlap: 0, cellLeft: viewportRight + 174, viewportLeft: 300 }
    expect(revealDistance(far, 'reveal')).toBe(300)
  })

  it('🔴 with overlap 0 the under-the-panel column reads as CLEAR — same run, same host', () => {
    const covered = { cellRight: 784, viewportRight, panelOverlap: 0, cellLeft: 674, viewportLeft: 300 }
    expect(isCellCovered(covered)).toBe(false)
    expect(revealDistance(covered, 'reveal')).toBe(0)
  })

  it('and with the panel MEASURED the same cell asks for exactly the 40 the screen confirmed', () => {
    const covered = { cellRight: 784, viewportRight, panelOverlap: viewportRight - 760, cellLeft: 674, viewportLeft: 300 }
    expect(revealDistance(covered, 'reveal')).toBe(40)
  })

  it('🔴 measuring the panel also MOVES the far column — the prediction this fix must produce', () => {
    // Stated before the re-measure, so the screen can refute it: once the cold path measures the
    // panel, the off-screen column needs the overlap too, so its write must GROW from 300 by the
    // overlap (subject to `maxScroll`). A 300 unchanged after the fix would mean the panel is
    // still not being measured and the bullet_point pass came from somewhere else.
    const far = { cellRight: viewportRight + 284, viewportRight, panelOverlap: viewportRight - 760, cellLeft: viewportRight + 174, viewportLeft: 300 }
    expect(revealDistance(far, 'reveal')).toBe(300 + (viewportRight - 760))
  })
})

describe('revealStash — what happens to a reveal that could not be served (#750)', () => {
  const req = { colKey: 'bullet_point', intent: 'reveal' as const }
  const other = { colKey: 'brand', intent: 'uncover' as const }

  it('a request that WAS served leaves nothing stashed', () => {
    expect(revealStash(null, { kind: 'request', request: req, served: true })).toBeNull()
  })

  it('a request that could not be served is stashed, intent and all', () => {
    expect(revealStash(null, { kind: 'request', request: req, served: false })).toEqual(req)
  })

  it('🔴 a REPLAY that could not be served KEEPS the request — the reversal', () => {
    // The old policy cleared before attempting, so the single `gridReady` replay raced the drawer
    // and the request was discarded having never once been measurable. Measured on the #747 build:
    // `writes []`, byte-identical to pre-fix, three runs.
    expect(revealStash(req, { kind: 'replay', served: false })).toEqual(req)
  })

  it('a replay that succeeded clears it, so it cannot fire twice', () => {
    expect(revealStash(req, { kind: 'replay', served: true })).toBeNull()
  })

  it('🔴 closing the record clears it — the narrower guard the old policy was reaching for', () => {
    // The hazard the clear-before-attempt policy existed to prevent is real: a surviving stash must
    // not replay into a sheet whose drawer has gone. This answers it without costing the retry.
    expect(revealStash(req, { kind: 'recordClosed' })).toBeNull()
  })

  it('a newer request replaces an older one rather than queueing behind it', () => {
    expect(revealStash(req, { kind: 'request', request: other, served: false })).toEqual(other)
  })
})
