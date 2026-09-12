/**
 * #730 — the reference colour cycle. Each test names what an operator misreads if it is wrong.
 */
import { describe, expect, it } from 'vitest'

import { assignRefColours, colourFor, CYCLE_MEASURED_CONTRAST, REF_CYCLE, refColoursWrap } from './formulaPalette'
import { tagSwatches } from '../../tokens/colors'

describe('REF_CYCLE — only hues the DS states pass on BOTH grounds', () => {
  it('has seven, all resolved from the DS palette by name', () => {
    expect(REF_CYCLE).toHaveLength(7)
    for (const c of REF_CYCLE) {
      expect(tagSwatches.find((s) => s.name === c.name)?.hex).toBe(c.hex)
    }
  })

  it('🔴 excludes every swatch colors.ts records as FAILING 3:1 on dark', () => {
    // Purple 1.79, Teal 2.84, Pink 2.52, Grey 2.58 — a known, documented defect kept in the tag
    // palette only because a tag's colour is persisted data. A reference's colour is not persisted.
    for (const bad of ['Purple', 'Teal', 'Pink', 'Grey']) {
      expect(REF_CYCLE.map((c) => c.name)).not.toContain(bad)
    }
  })

  it('🔴 excludes Lime, Green and Amber — they FAIL against the grid\'s striped ROW ground', () => {
    // Measured on the sheet: the odd row is rgb(238,241,245), a ground colors.ts never checked.
    // Lime 2.73, Green 2.91, Amber 2.81 — all below the 3:1 an outline owes. Lime passes the DS's
    // own page-ground check at 3.09, which is exactly why inheriting that list would have been wrong.
    for (const bad of ['Lime', 'Green', 'Amber']) {
      expect(REF_CYCLE.map((c) => c.name)).not.toContain(bad)
    }
  })

  it('🔴 excludes Red and Blue although BOTH pass — they mean something else here', () => {
    // Red is the unknown-reference colour; Blue is selection and focus. A valid reference must not
    // wear either.
    expect(REF_CYCLE.map((c) => c.name)).not.toContain('Red')
    expect(REF_CYCLE.map((c) => c.name)).not.toContain('Blue')
  })

  it('🔴 every hue clears 3:1 against the WORST row ground, by measurement on the sheet', () => {
    for (const c of REF_CYCLE) {
      expect(CYCLE_MEASURED_CONTRAST[c.name]).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('assignRefColours', () => {
  it('assigns in first-appearance order', () => {
    const m = assignRefColours(['brand', 'sku'])
    expect(m.get('brand')).toEqual(REF_CYCLE[0])
    expect(m.get('sku')).toEqual(REF_CYCLE[1])
  })

  it('🔴 the SAME reference twice is ONE colour — it is one source cell', () => {
    // `$brand + " " + $brand` outlines one cell; two hues could only match half its mentions.
    const m = assignRefColours(['brand', 'brand'])
    expect(m.size).toBe(1)
  })

  it('is case-insensitive — $BRAND and $brand are the same attribute', () => {
    const m = assignRefColours(['brand', 'BRAND'])
    expect(m.size).toBe(1)
    expect(colourFor('BrAnD', m)).toEqual(REF_CYCLE[0])
  })

  it('skips the empty name a bare `$` produces', () => {
    expect(assignRefColours(['', 'brand']).size).toBe(1)
  })

  it('wraps rather than running out, and says when it wrapped', () => {
    const eight = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    expect(assignRefColours(eight).size).toBe(8)
    expect(colourFor('h', assignRefColours(eight))).toEqual(REF_CYCLE[0])
    expect(refColoursWrap(eight)).toBe(true)
    expect(refColoursWrap(['a', 'b'])).toBe(false)
  })

  it('an unassigned reference has NO colour — an unknown ref is red, not a hue', () => {
    expect(colourFor('nope', assignRefColours(['brand']))).toBeNull()
  })
})
