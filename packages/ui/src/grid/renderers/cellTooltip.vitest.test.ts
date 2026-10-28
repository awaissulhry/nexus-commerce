import { describe, expect, it } from 'vitest'

import { composeCellTooltip, longTextTooltipLine } from './cellTooltip'

/**
 * 🔴 The cell had TWO tooltips and one of them won by accident (#662).
 *
 * The column's getter returned a save reason INSTEAD of everything else — an early return — and the
 * length figures reached the operator only through a rival `title` the long-text renderer set on
 * its own span. Whichever the pointer rested on decided what they were told, and a refused cell
 * could show its character count and nothing about the refusal.
 */
describe('composeCellTooltip', () => {
  it('🔴 puts the reason FIRST and keeps the rest — the early return is the bug', () => {
    const t = composeCellTooltip('Connection lost — checking whether this saved…', 'Inherited from GALE-JACKET', '19 of 700 characters (Amazon · IT)')
    expect(t.split('\n\n')[0]).toBe('Connection lost — checking whether this saved…')
    // What the early return threw away: everything after the reason.
    expect(t).toContain('19 of 700 characters (Amazon · IT)')
    expect(t).toContain('Inherited from GALE-JACKET')
  })

  it('separates paragraphs with a blank line, so they do not read as one sentence', () => {
    expect(composeCellTooltip('A', 'B')).toBe('A\n\nB')
  })

  it('drops empties rather than rendering them as gaps', () => {
    // Every source here is optional — a cell with no reason, no validation message and no cap is
    // the common case, and it must produce a tooltip AG will not show at all.
    expect(composeCellTooltip(undefined, '', null, '  ')).toBe('')
    expect(composeCellTooltip(undefined, 'only this', null)).toBe('only this')
  })

  it('🔴 does not say the same thing twice', () => {
    // The reason and the column's own line genuinely coincide (a validation refusal echoed by the
    // server). Twice reads as two separate problems.
    expect(composeCellTooltip('Too long', 'Too long')).toBe('Too long')
    expect(composeCellTooltip('Too long', ' Too long ')).toBe('Too long')
  })

  it('trims each part, so a stray newline does not open a blank paragraph', () => {
    expect(composeCellTooltip('  A\n', '\nB  ')).toBe('A\n\nB')
  })
})

describe('longTextTooltipLine', () => {
  it('gives the figures for a value under its cap', () => {
    const line = longTextTooltipLine('Polyester', { maxLength: 700, capFrom: 'Amazon · IT' })
    expect(line).toContain('700')
    expect(line).toContain('Amazon · IT')
  })

  it('🔴 undefined for an empty cell — there are no figures to give about nothing', () => {
    // The cell already says "empty" or "⚠ required" in its own glyph; a tooltip repeating the
    // character count of nothing is noise on every blank cell in the sheet.
    expect(longTextTooltipLine('', { maxLength: 700 })).toBeUndefined()
    expect(longTextTooltipLine(null, { maxLength: 700 })).toBeUndefined()
    expect(longTextTooltipLine(undefined, {})).toBeUndefined()
  })

  it('says so when no cap was supplied, rather than showing a reassuring nothing', () => {
    const line = longTextTooltipLine('Polyester', {})
    expect(line).toMatch(/no length cap was supplied/i)
  })

  it('counts the byte cap when that is the one the column carries', () => {
    // `product_description` arrives as `{ maxBytes: 20000 }` with no `maxLength` key at all.
    const line = longTextTooltipLine('Polyester', { maxBytes: 20000, capFrom: 'Amazon · IT' })
    // Measured, not assumed: the phrasing is "9 of 20000 bytes (Amazon · IT)". My first assertion
    // guessed a thousands separator and failed — the digits are unseparated here, unlike the
    // footer note's counts, which do use `toLocaleString`. Flagged rather than changed: the
    // wording belongs to `longTextState` and its own ruling.
    expect(line).toBe('9 of 20000 bytes (Amazon · IT)')
  })
})
