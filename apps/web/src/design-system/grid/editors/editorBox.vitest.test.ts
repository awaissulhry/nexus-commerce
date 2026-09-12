/**
 * The one sizing function. These hold the ARITHMETIC; the browser gate
 * (`scripts/check-editor-open.mjs`) holds the consequence — that a real editor lands flush with its
 * cell at 1728, 1440 and 1280 on the rightmost visible column. Neither replaces the other: a correct
 * number applied through the wrong CSS is still a displaced editor, and a flush editor at one width
 * says nothing about the arithmetic at another.
 */
import { describe, expect, it } from 'vitest'

import { EDITOR_CAPS, MIN_EDITOR_WIDTH, editorBox, roomToRightOf } from './editorBox'

const box = (over: Partial<Parameters<typeof editorBox>[0]> = {}) =>
  editorBox({ cellWidth: 110, cellHeight: 35, roomToRight: 900, kind: 'longtext', ...over })

describe('editorBox — width', () => {
  it('never goes below the cell: a narrow ask still fills the cell it came from', () => {
    expect(box({ cellWidth: 220, contentWidth: 40 }).width).toBe(220)
  })

  it('grows to the content while there is room — the Excel/Sheets behaviour the Owner amended in', () => {
    expect(box({ cellWidth: 110, contentWidth: 420, roomToRight: 900 }).width).toBe(420)
  })

  it('stops at the cap even with room to spare, so one column cannot open a 900px editor', () => {
    expect(box({ contentWidth: 5000, roomToRight: 1400 }).width).toBe(EDITOR_CAPS.longtext.width)
  })

  /* 🔴 THE LOAD-BEARING ARM — this is the defect. `product_description` sat at x=1314 in a 1600px
     viewport (room 286) and the old fixed 488 put the editor 202px to the LEFT of its own cell. */
  it('stops at the ROOM when the room is the tighter of the two — the −202px case', () => {
    const b = box({ cellWidth: 110, contentWidth: 5000, roomToRight: 286 })
    expect(b.width).toBe(286)
    expect(b.usable).toBe(true)
  })

  /* Both terms, every time. Capping at the cap alone reproduces the defect at the right edge;
     capping at the room alone lets a wide column open an editor far past its cap. */
  it('applies BOTH ceilings, whichever binds', () => {
    expect(box({ contentWidth: 5000, roomToRight: 200 }).width).toBe(200)     // room binds
    expect(box({ contentWidth: 5000, roomToRight: 900 }).width).toBe(560)     // cap binds
  })

  /* 🔴 Regression guard, and it was found ON SCREEN after the geometry already read Δ=0. Without a
     measured content width the editor must ask for its kind's comfortable size — not the cell's.
     The first wiring defaulted to the cell and every editor opened at 110px: perfectly anchored,
     perfectly unusable, and exactly the over-correction the Owner amended against. */
  it('with no measured content, asks for the kind PREFERRED width, not the cell width', () => {
    expect(box({ cellWidth: 110, roomToRight: 900 }).width).toBe(EDITOR_CAPS.longtext.preferred)
    expect(box({ cellWidth: 110, roomToRight: 900, kind: 'formula' }).width).toBe(EDITOR_CAPS.formula.preferred)
    expect(box({ cellWidth: 110, roomToRight: 900, kind: 'select' }).width).toBe(EDITOR_CAPS.select.preferred)
  })

  it('a cell wider than the preferred size still wins — the editor is never narrower than its cell', () => {
    expect(box({ cellWidth: 700, roomToRight: 1400 }).width).toBe(560)
    expect(box({ cellWidth: 480, roomToRight: 1400 }).width).toBe(EDITOR_CAPS.longtext.width)
  })

  /* A column scrolled half out of view leaves a few pixels of room. `min(cap, room)` alone would
     size the editor to nothing — an editor too narrow to type in, which is the "opens but is
     useless" cousin of the defect this programme just closed. */
  /* 🔴 The box ALWAYS fits — it is never floored above the room, because a floor that overflows is
     the displacement coming back through the fix. What it reports instead is whether the fitting box
     is big enough to type in. */
  it('obeys the room even when the result is too small to use, and SAYS it is unusable', () => {
    const b = box({ cellWidth: 110, roomToRight: 12 })
    expect(b.width).toBe(12)
    expect(b.usable).toBe(false)
  })

  it('reports usable truthfully at the threshold, both sides', () => {
    expect(box({ cellWidth: 110, roomToRight: 110 }).width).toBe(110)
    expect(box({ cellWidth: 110, roomToRight: 110 }).usable).toBe(false)
    expect(box({ cellWidth: 130, roomToRight: 130 }).usable).toBe(true)
  })

  /* The invariant, asserted directly over a sweep rather than at one point: nothing this function
     returns can be wider than the room it was given. If this can be broken, AG clamps and the
     editor detaches from its cell. */
  it('NEVER returns a width greater than the room, across the whole range', () => {
    for (const room of [0, 5, 12, 60, 110, 250, 286, 400, 559, 560, 900, 2000]) {
      for (const cellWidth of [40, 110, 220, 400, 800]) {
        for (const contentWidth of [undefined, 0, 90, 420, 5000]) {
          const b = editorBox({ cellWidth, cellHeight: 35, contentWidth, roomToRight: room, kind: 'longtext' })
          expect(b.width).toBeLessThanOrEqual(room)
          expect(b.width).toBeGreaterThanOrEqual(0)
          expect(b.width).toBeLessThanOrEqual(EDITOR_CAPS.longtext.width)
        }
      }
    }
  })

  /* An inverted clamp (ceiling below the cell's own width) must not produce a negative or flipped
     box — the arithmetic that would silently make an editor 0px wide. */
  /* 🔴 "Never narrower than the cell" is a PREFERENCE; "never wider than the room" is the INVARIANT.
     My first version applied the cell floor after the ceiling and gave a 400px cell with 250px of
     room a 400px editor — 150px past the window, i.e. the exact displacement this replaces. */
  it('lets the room beat the cell width when they conflict', () => {
    const b = box({ cellWidth: 400, contentWidth: 800, roomToRight: 250 })
    expect(b.width).toBe(250)
  })
})

describe('editorBox — height', () => {
  it('with no measured content, asks for the kind PREFERRED height — not the cell\'s one line', () => {
    expect(box({ cellHeight: 35 }).height).toBe(EDITOR_CAPS.longtext.preferredHeight)
  })

  /* 🔴 MEASURED and UNMEASURED are different answers, and the distinction is the point: a caller who
     measured 10px of content gets the cell height; a caller who measured nothing gets the kind's
     comfortable height (the test above). Collapsing the two is what opened a one-line box for a
     2,000-character field. */
  it('is at least the cell, grows with MEASURED content, and caps with internal scroll', () => {
    expect(box({ contentHeight: 10 }).height).toBe(35)
    expect(box({ contentHeight: 120 }).height).toBe(120)
    const capped = box({ contentHeight: 9000 })
    expect(capped.height).toBe(EDITOR_CAPS.longtext.height)
    expect(capped.scrolls).toBe(true)
  })

  it('does not claim to scroll when the content fits', () => {
    expect(box({ contentHeight: 100 }).scrolls).toBe(false)
  })

  it('a cell taller than the preferred height still wins', () => {
    expect(box({ cellHeight: 200 }).height).toBe(200)
  })
})

describe('EDITOR_CAPS', () => {
  /* 🔴 The SET, not a spot check: a kind with no cap entry is a kind the gate silently stops
     asserting "no editor wider than its cap" about. Select keeps the DS popover's existing 320 —
     the Owner ruled select "unchanged", and this is the number that keeps it so. */
  it('covers every popup editor kind, and keeps select at the DS popover maximum', () => {
    expect(Object.keys(EDITOR_CAPS).sort()).toEqual(['formula', 'list', 'longtext', 'measure', 'select'])
    expect(EDITOR_CAPS.select.width).toBe(320)
    for (const c of Object.values(EDITOR_CAPS)) {
      expect(c.width).toBeGreaterThan(MIN_EDITOR_WIDTH)
      expect(c.height).toBeGreaterThan(0)
      // A preferred width above its own cap would be a cap that never binds — the kind of dead
      // clause that reads as a rule and is not one.
      expect(c.preferred).toBeGreaterThan(MIN_EDITOR_WIDTH)
      expect(c.preferred).toBeLessThanOrEqual(c.width)
      expect(c.preferredHeight).toBeGreaterThan(0)
      expect(c.preferredHeight).toBeLessThanOrEqual(c.height)
    }
  })

  it('gives the formula editor the taller cap — its completions and preview sit below it', () => {
    expect(EDITOR_CAPS.formula.height).toBeGreaterThan(EDITOR_CAPS.longtext.height)
  })
})

describe('roomToRightOf', () => {
  it('measures from the cell LEFT edge, where AG pins the popup', () => {
    expect(roomToRightOf(1314, 1600)).toBe(286)
    expect(roomToRightOf(0, 1600)).toBe(1600)
  })

  /* A cell scrolled entirely past the right edge yields 0, never a negative that would flip the
     clamp and hand back a nonsense width. */
  it('never returns negative room', () => {
    expect(roomToRightOf(1700, 1600)).toBe(0)
    expect(editorBox({ cellWidth: 110, cellHeight: 35, roomToRight: 0, kind: 'select' }).usable).toBe(false)
  })
})
