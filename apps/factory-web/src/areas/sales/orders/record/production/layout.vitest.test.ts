import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { COUNTS_AS_OF, FULL_ROW, headButtonsOf, pairsAt, partFaceOf, PAIR_FROM, ROOM_L, ROOM_M, roomOf, SECTIONS } from './layout'

// F-PT-101 (order PRODUCTION tab, W1): the kit — the room the tab has (never the screen), the pair rule, one face per part state.

describe('F-PT-101: the room → S / M / L at the widths the tab really gets', () => {
  it('343 (375 phone) S · 865 (1440 dock open) M · 1067 (1920 dock open) M · 1314 (1440 dock closed) L · 1794 (1920 dock closed) L', () => {
    expect(roomOf(343)).toBe('S')
    expect(roomOf(865)).toBe('M')
    expect(roomOf(1067)).toBe('M')
    expect(roomOf(1314)).toBe('L')
    expect(roomOf(1794)).toBe('L')
  })

  it('the edges: 719 S, 720 M, 1279 M, 1280 L', () => {
    expect(roomOf(719)).toBe('S')
    expect(roomOf(ROOM_M)).toBe('M')
    expect(roomOf(ROOM_L - 1)).toBe('M')
    expect(roomOf(ROOM_L)).toBe('L')
  })

  it('two short sections pair from 900 (865 stacks, 1067 pairs); the full-row ones never pair (L10)', () => {
    expect(pairsAt(865)).toBe(false)
    expect(pairsAt(PAIR_FROM)).toBe(true)
    expect(pairsAt(1067)).toBe(true)
    expect(FULL_ROW).toEqual(['now', 'work-orders', 'dates', 'materials'])
  })

  it('the stylesheet holds the same numbers: the tab root is the size container, queries on it (never @media)', () => {
    // owb-b5 (w5.1): the tab draws with two sheets — its own and the section kit's (the root container and the pairs moved with the kit).
    const css = readFileSync(new URL('../view/production/production.css', import.meta.url), 'utf8') + readFileSync(new URL('../../../../../lib/record-sections/record-sections.css', import.meta.url), 'utf8')
    expect(css).toMatch(/container: pt \/ inline-size/)
    expect(css).toContain(`@container pt (min-width: ${ROOM_M}px)`)
    expect(css).toContain(`@container pt (min-width: ${ROOM_L}px)`)
    expect(css).toContain(`@container pt (min-width: ${PAIR_FROM}px)`)
    expect(css).not.toMatch(/@media[^{]*width/)
    // Tokens only (no raw colour): every colour is a DS variable.
    expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/)
  })
})

describe('F-PT-101: the sections, their addresses and the "Counts as of" line', () => {
  it('six sections top to bottom, each its anchor; "Counts as of" only on Production now and Work orders (L2)', () => {
    expect(SECTIONS).toEqual(['now', 'work-orders', 'dates', 'holds', 'specs', 'materials'])
    expect(COUNTS_AS_OF).toEqual(['now', 'work-orders'])
  })

  it('a head shows at most three buttons; the rest go into its ⋯', () => {
    expect(headButtonsOf(['a', 'b'])).toEqual({ shown: ['a', 'b'], more: [] })
    expect(headButtonsOf(['a', 'b', 'c', 'd', 'e'])).toEqual({ shown: ['a', 'b', 'c'], more: ['d', 'e'] })
  })

  it('one face per part state: failed beats everything, withheld is one line, a read with nothing is empty, never "reading" for ever', () => {
    expect(partFaceOf({ loading: false, problem: 'problem.read.unavailable', withheld: false, count: null })).toBe('failed')
    expect(partFaceOf({ loading: false, problem: null, withheld: true, count: null })).toBe('withheld')
    expect(partFaceOf({ loading: true, problem: null, withheld: false, count: null })).toBe('reading')
    expect(partFaceOf({ loading: false, problem: null, withheld: false, count: 0 })).toBe('empty')
    expect(partFaceOf({ loading: false, problem: null, withheld: false, count: 3 })).toBe('shown')
  })
})
