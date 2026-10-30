import { readFileSync } from 'node:fs'
import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { ReasonGrid } from './ReasonGrid'
import {
  REASON_GRID_WORDS as W,
  countPress,
  countTotal,
  pageCount,
  pageOf,
  pageOfReason,
  reasonKeyTarget,
  reasonPress,
  reasonTabStop,
  type ReasonTile,
} from './reasonGridModel'

const reasons: ReasonTile[] = Array.from({ length: 11 }, (_, n) => ({ id: `r${n + 1}`, label: `Reason ${n + 1}`, tone: n % 2 ? 'danger' : 'warning' }))
reasons[2] = { ...reasons[2]!, heldReason: 'Not at this station' }
reasons[10] = { ...reasons[10]!, label: 'Other', photoNeeded: true }

describe('reason grid rules (D20)', () => {
  it('pages of nine; a page out of range is clamped; a picked reason opens its page', () => {
    expect(pageCount(0)).toBe(1)
    expect(pageCount(9)).toBe(1)
    expect(pageCount(10)).toBe(2)
    expect(pageOf(reasons, 0).items.map((item) => item.id)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9'])
    expect(pageOf(reasons, 1).items.map((item) => item.id)).toEqual(['r10', 'r11'])
    expect(pageOf(reasons, 7).page).toBe(1)
    expect(pageOf(reasons, -2).page).toBe(0)
    expect(pageOfReason(reasons, 'r11')).toBe(1)
    expect(pageOfReason(reasons, 'r4')).toBe(0)
    expect(pageOfReason(reasons, null)).toBe(0)
    expect(pageOf(reasons, 0, 4).pages).toBe(3)
  })

  it('pick: a held reason is never picked; the tab stop is the picked reason, else the first that can be picked', () => {
    expect(reasonPress(reasons, 'r1', 'r3')).toBe('r1')
    expect(reasonPress(reasons, null, 'r4')).toBe('r4')
    const page = pageOf(reasons, 0).items
    expect(reasonTabStop(page, 'r5')).toBe('r5')
    expect(reasonTabStop(page, 'r10')).toBe('r1')
    expect(reasonTabStop([reasons[2]!, reasons[3]!], null)).toBe('r4')
  })

  it('arrows wrap by tile and by row (three a row), Home / End, mirrored right to left', () => {
    const page = pageOf(reasons, 0).items
    expect(reasonKeyTarget(page, 'r1', 'ArrowRight', 3)).toBe('r2')
    expect(reasonKeyTarget(page, 'r9', 'ArrowRight', 3)).toBe('r1')
    expect(reasonKeyTarget(page, 'r1', 'ArrowLeft', 3)).toBe('r9')
    expect(reasonKeyTarget(page, 'r2', 'ArrowDown', 3)).toBe('r5')
    expect(reasonKeyTarget(page, 'r8', 'ArrowDown', 3)).toBe('r2')
    expect(reasonKeyTarget(page, 'r2', 'ArrowUp', 3)).toBe('r8')
    expect(reasonKeyTarget(page, 'r5', 'Home', 3)).toBe('r1')
    expect(reasonKeyTarget(page, 'r5', 'End', 3)).toBe('r9')
    expect(reasonKeyTarget(page, 'r2', 'ArrowRight', 3, 'rtl')).toBe('r1')
    // A short last row: down from the middle column goes to its last tile; up from it comes back.
    const two = pageOf(reasons, 1).items
    expect(reasonKeyTarget([...page.slice(0, 4)], 'r2', 'ArrowDown', 3)).toBe('r4')
    expect(reasonKeyTarget(two, 'r10', 'ArrowDown', 3)).toBe('r10')
    expect(reasonKeyTarget([], null, 'ArrowDown', 3)).toBeNull()
  })

  it('count: +1 and −1, never under 0 nor over max; a held reason does not count; a count back at 0 is taken out', () => {
    const one = countPress(reasons, {}, 'r1', 1)
    expect(one).toEqual({ counts: { r1: 1 }, id: 'r1', delta: 1, refused: null })
    const two = countPress(reasons, one.counts, 'r1', 1)
    expect(two.counts).toEqual({ r1: 2 })
    expect(countPress(reasons, two.counts, 'r1', -1).counts).toEqual({ r1: 1 })
    expect(countPress(reasons, { r1: 1 }, 'r1', -1).counts).toEqual({})
    expect(countPress(reasons, {}, 'r1', -1).refused).toBe('zero')
    expect(countPress(reasons, { r1: 3 }, 'r1', 1, 3).refused).toBe('max')
    expect(countPress(reasons, {}, 'r3', 1).refused).toBe('held')
    expect(countPress(reasons, {}, 'nope', 1).refused).toBe('held')
    expect(countTotal({ r1: 2, r4: 3, bad: Number.NaN })).toBe(5)
  })
})

describe('reason grid markup (D20)', () => {
  it('pick: a radio group of the first nine with one Tab stop, the picked tile ticked, More reasons and the page', () => {
    const out = render(h(ReasonGrid, { label: 'Why?', reasons, value: 'r2', onChange: vi.fn() }))
    expect(out).toMatch(/role="radiogroup"/)
    expect(out.match(/role="radio"/g)).toHaveLength(9)
    expect(out.match(/tabindex="0"/g)).toHaveLength(1)
    expect(out).toMatch(/data-reason-id="r2"[^>]*aria-checked="true"[^>]*tabindex="0"/)
    expect(out).toContain('nds-floor-reason-tick')
    expect(out).toContain('More reasons')
    expect(out).toContain('Page 1 of 2')
    expect(out).not.toContain('>Back<')
    expect(out).toMatch(/role="status"/)
  })

  it('a held reason is focusable, says why on the tile and to a screen reader; never the disabled attribute', () => {
    const out = render(h(ReasonGrid, { label: 'Why?', reasons, value: null, onChange: vi.fn() }))
    expect(out).toMatch(/data-reason-id="r3"[^>]*aria-disabled="true"[^>]*aria-description="Not at this station"/)
    expect(out).toContain('nds-floor-reason-held')
    expect(out).not.toMatch(/\sdisabled=""/)
  })

  it('opens the page of the picked reason: Back, the camera mark of "Other"', () => {
    const out = render(h(ReasonGrid, { label: 'Why?', reasons, value: 'r11', onChange: vi.fn() }))
    expect(out.match(/role="radio"/g)).toHaveLength(2)
    expect(out).toContain('Page 2 of 2')
    expect(out).toContain('Back')
    expect(out).toContain(W.photoNeeded)
  })

  it('count: each tile adds one, the count is big on the tile and in its name, − takes one off, the total is written', () => {
    const out = render(h(ReasonGrid, { mode: 'count', label: 'Defects', reasons, counts: { r1: 3, r2: 1 }, onCountChange: vi.fn(), words: { removeOne: 'Togli uno da {reason}' } }))
    expect(out).toMatch(/role="group"/)
    expect(out).not.toMatch(/role="radio"/)
    expect(out).toMatch(/aria-label="Reason 1, 3"[^>]*aria-description="Tap to add one"/)
    expect(out).toMatch(/class="nds-floor-reason-count"[^>]*>3</)
    expect(out.match(/aria-label="Togli uno da Reason \d"/g)).toHaveLength(2)
    expect(out).toContain('Counted in all: 4')
  })

  it('draws an example photo (decorative: the word names the tile) and the app\'s words for an empty station', () => {
    const photo = render(h(ReasonGrid, { label: 'Why?', reasons: [{ id: 'p', label: 'Scratch', photo: 'data:image/svg+xml,%3Csvg%2F%3E' }], value: null, onChange: vi.fn() }))
    expect(photo).toMatch(/<img[^>]*class="nds-floor-reason-photo"[^>]*alt=""/)
    const empty = render(h(ReasonGrid, { label: 'Why?', reasons: [], value: null, onChange: vi.fn(), words: { empty: 'Nessun motivo per questa postazione.' } }))
    expect(empty).toContain('Nessun motivo per questa postazione.')
    expect(empty).not.toContain('nds-floor-reasons-grid')
  })
})

describe('reason grid packaging (D20)', () => {
  const css = readFileSync(new URL('./reasonGrid.css', import.meta.url), 'utf8')

  it('density sizes and semantic tokens only: no raw colour, no numbered ramp, no fixed px target', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(css).not.toMatch(/var\(--nds-(grey|gray|blue|green|red|amber|purple|cyan)-\d+\)/)
    expect(css).not.toMatch(/rgba?\(/)
    expect(css).toMatch(/min-height: calc\(var\(--nds-density-control-h-primary\) \* 2\)/)
    expect(css).toMatch(/gap: var\(--nds-density-target-gap\)/)
  })

  it('the floor barrel does not re-export this folder; no shared stylesheet carries its rules', () => {
    const barrel = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const code = barrel.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code).not.toMatch(/ReasonGrid/)
    for (const sheet of ['primitives.css', 'components.css', 'patterns.css', 'a11y.css']) {
      const text = readFileSync(new URL(`../../styles/${sheet}`, import.meta.url), 'utf8')
      expect(text, sheet).not.toMatch(/nds-floor-reason/)
    }
    expect(readFileSync(new URL('../floor.css', import.meta.url), 'utf8')).not.toMatch(/nds-floor-reason/)
  })
})
