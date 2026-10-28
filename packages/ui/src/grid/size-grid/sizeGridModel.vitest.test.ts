import { describe, expect, it } from 'vitest'

import {
  SIZE_GRID_COPY,
  SIZE_GRID_MAX_QUANTITY,
  clampSizeGridQuantity,
  curveFillSizeGrid,
  curveShareText,
  distributeBySizeCurve,
  formatSizeGridQuantity,
  normaliseSizeGrid,
  parseSizeGridPaste,
  parseSizeGridQuantity,
  pasteIntoSizeGrid,
  setSizeGridCell,
  sizeGridIssueTone,
  sizeGridIssuesFor,
  sizeGridOffered,
  sizeGridStep,
  sizeGridTotals,
  type SizeGridColour,
  type SizeGridCurve,
  type SizeGridSize,
} from './sizeGridModel'

const SIZES: SizeGridSize[] = ['S', 'M', 'L', 'XL'].map((k) => ({ key: k, label: k }))
const COLOURS: SizeGridColour[] = [
  { key: 'blk', label: 'Black' },
  { key: 'nvy', label: 'Navy', offered: ['S', 'M', 'L'] },
  { key: 'tan', label: 'Tan' },
]
const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0)

describe('parseSizeGridQuantity', () => {
  it('reads whole numbers, a sign and the .0 a spreadsheet adds; blank is 0', () => {
    expect(parseSizeGridQuantity('12')).toBe(12)
    expect(parseSizeGridQuantity(' 7 ')).toBe(7)
    expect(parseSizeGridQuantity('007')).toBe(7)
    expect(parseSizeGridQuantity('+5')).toBe(5)
    expect(parseSizeGridQuantity('-3')).toBe(-3)
    expect(parseSizeGridQuantity('12.0')).toBe(12)
    expect(parseSizeGridQuantity('12,00')).toBe(12)
    expect(parseSizeGridQuantity('')).toBe(0)
    expect(parseSizeGridQuantity('   ')).toBe(0)
  })
  it('refuses what would be a guess: a fraction, a separator, words', () => {
    for (const t of ['12.5', '1,200', '1 200', '1.200', 'abc', '5 pcs', '--1', '.5', '1e3']) expect(parseSizeGridQuantity(t)).toBeNull()
  })
  it('a number too long to be exact reads as Infinity, so the clamp cuts it to the max', () => {
    expect(parseSizeGridQuantity('99999999999999999999')).toBe(Infinity)
    expect(parseSizeGridQuantity('-99999999999999999999')).toBe(-Infinity)
    expect(clampSizeGridQuantity(parseSizeGridQuantity('99999999999999999999')!)).toBe(SIZE_GRID_MAX_QUANTITY)
  })
})

describe('clampSizeGridQuantity', () => {
  it('keeps a whole number from 0 to max', () => {
    expect(clampSizeGridQuantity(0)).toBe(0)
    expect(clampSizeGridQuantity(42)).toBe(42)
    expect(clampSizeGridQuantity(SIZE_GRID_MAX_QUANTITY)).toBe(SIZE_GRID_MAX_QUANTITY)
  })
  it('negative, NaN and -Infinity → 0; above max and Infinity → max; a fraction → the whole pieces under it', () => {
    expect(clampSizeGridQuantity(-4)).toBe(0)
    expect(clampSizeGridQuantity(Number.NaN)).toBe(0)
    expect(clampSizeGridQuantity(-Infinity)).toBe(0)
    expect(clampSizeGridQuantity(100_000)).toBe(99_999)
    expect(clampSizeGridQuantity(Infinity)).toBe(99_999)
    expect(clampSizeGridQuantity(2.9)).toBe(2)
    expect(clampSizeGridQuantity(30, 24)).toBe(24)
  })
})

describe('normalise, set and totals', () => {
  const value = { blk: { S: 2, M: 5, XL: 1 }, nvy: { M: 4, XL: 9 }, ghost: { S: 99 }, tan: { L: -3, M: 1.5 } }

  it('normalise → the full matrix: every colour × every size, not offered at 0, unknown keys dropped, clamped', () => {
    expect(normaliseSizeGrid(value, COLOURS, SIZES)).toEqual({
      blk: { S: 2, M: 5, L: 0, XL: 1 },
      nvy: { S: 0, M: 4, L: 0, XL: 0 },
      tan: { S: 0, M: 1, L: 0, XL: 0 },
    })
  })

  it('totals count offered cells only', () => {
    const t = sizeGridTotals(value, COLOURS, SIZES)
    expect(t.rows).toEqual({ blk: 8, nvy: 4, tan: 1 })
    expect(t.columns).toEqual({ S: 2, M: 10, L: 0, XL: 1 })
    expect(t.grand).toBe(13)
    expect(sum(t.rows)).toBe(t.grand)
    expect(sum(t.columns)).toBe(t.grand)
  })

  it('set changes one offered cell and returns the full matrix; a not-offered or unknown cell is left alone', () => {
    const next = setSizeGridCell(value, COLOURS, SIZES, 'blk', 'L', 6)
    expect(next.blk).toEqual({ S: 2, M: 5, L: 6, XL: 1 })
    expect(setSizeGridCell(value, COLOURS, SIZES, 'nvy', 'XL', 6).nvy.XL).toBe(0)
    expect(setSizeGridCell(value, COLOURS, SIZES, 'blk', '3XL', 6).blk).not.toHaveProperty('3XL')
    expect(setSizeGridCell(value, COLOURS, SIZES, 'blk', 'S', 250_000).blk.S).toBe(SIZE_GRID_MAX_QUANTITY)
    expect(setSizeGridCell(value, COLOURS, SIZES, 'blk', 'S', -1).blk.S).toBe(0)
  })

  it('does not mutate what it was given', () => {
    const before = JSON.stringify(value)
    setSizeGridCell(value, COLOURS, SIZES, 'blk', 'L', 6)
    normaliseSizeGrid(value, COLOURS, SIZES)
    expect(JSON.stringify(value)).toBe(before)
  })
})

describe('distributeBySizeCurve — largest remainder, exact total', () => {
  const keys = ['XS', 'S', 'M', 'L', 'XL', 'XXL']
  const core = { XS: 1, S: 2, M: 3, L: 3, XL: 2, XXL: 1 }

  it('an exact multiple shares without remainders', () => {
    expect(distributeBySizeCurve(24, keys, core)).toEqual({ ok: true, quantities: { XS: 2, S: 4, M: 6, L: 6, XL: 4, XXL: 2 } })
  })

  it('every total from 0 to 500 adds up exactly, and no size is more than one piece from its quota', () => {
    for (let total = 0; total <= 500; total++) {
      const r = distributeBySizeCurve(total, keys, core)
      if (!r.ok) throw new Error(`refused ${total}`)
      expect(sum(r.quantities)).toBe(total)
      for (const k of keys) {
        const quota = (total * core[k as keyof typeof core]) / 12
        expect(Math.abs(r.quantities[k] - quota)).toBeLessThan(1)
        expect(r.quantities[k]).toBeGreaterThanOrEqual(Math.floor(quota))
      }
    }
  })

  it('leftovers go to the largest remainders, then the larger share, then the earlier size', () => {
    // 10 × (1,2,3,3,2,1)/12: quotas .83 1.67 2.5 2.5 1.67 .83 → floors 0 1 2 2 1 0 = 6, 4 left.
    // Largest remainders: XS and XXL (.83), then S and XL (.67); M and L (.5) get none.
    expect(distributeBySizeCurve(10, keys, core)).toEqual({ ok: true, quantities: { XS: 1, S: 2, M: 2, L: 2, XL: 2, XXL: 1 } })
    // 1 piece over an even curve: all remainders tie, all shares tie → the first size in the scale.
    expect(distributeBySizeCurve(1, ['S', 'M', 'L'], { S: 1, M: 1, L: 1 })).toEqual({ ok: true, quantities: { S: 1, M: 0, L: 0 } })
    // 2 × (1,3)/4: quotas .5 and 1.5, both remainders .5 → the tie goes to the larger share, not the earlier size.
    expect(distributeBySizeCurve(2, ['S', 'M'], { S: 1, M: 3 })).toEqual({ ok: true, quantities: { S: 0, M: 2 } })
  })

  it('decimal strings are exact (percentages that do not divide evenly)', () => {
    const pct = { S: '12.5', M: '37.5', L: '33.3', XL: '16.7' }
    const r = distributeBySizeCurve(1000, ['S', 'M', 'L', 'XL'], pct)
    expect(r).toEqual({ ok: true, quantities: { S: 125, M: 375, L: 333, XL: 167 } })
    const r7 = distributeBySizeCurve(7, ['S', 'M', 'L', 'XL'], pct)
    expect(r7.ok && sum(r7.quantities)).toBe(7)
  })

  it('a size with no share gets nothing; a share of 0 is no share', () => {
    const r = distributeBySizeCurve(9, ['S', 'M', 'L', 'XL'], { M: 1, L: 2, XL: 0 })
    expect(r).toEqual({ ok: true, quantities: { S: 0, M: 3, L: 6, XL: 0 } })
  })

  it('refuses a bad total, a bad share and a curve with no share on these sizes', () => {
    expect(distributeBySizeCurve(-1, keys, core)).toEqual({ ok: false, reason: 'bad-total' })
    expect(distributeBySizeCurve(2.5, keys, core)).toEqual({ ok: false, reason: 'bad-total' })
    expect(distributeBySizeCurve(5, ['S'], { S: -1 })).toEqual({ ok: false, reason: 'bad-ratio' })
    expect(distributeBySizeCurve(5, ['S'], { S: 'ten' })).toEqual({ ok: false, reason: 'bad-ratio' })
    expect(distributeBySizeCurve(5, ['S', 'M'], { L: 4 })).toEqual({ ok: false, reason: 'no-weight' })
    // Nothing to share: zeros, whatever the curve.
    expect(distributeBySizeCurve(0, ['S', 'M'], { L: 4 })).toEqual({ ok: true, quantities: { S: 0, M: 0 } })
  })

  it('large totals stay exact', () => {
    const r = distributeBySizeCurve(9_999_999, ['A', 'B', 'C'], { A: '0.000001', B: '1000000', C: 3 })
    expect(r.ok && sum(r.quantities)).toBe(9_999_999)
  })
})

describe('curveFillSizeGrid', () => {
  const curve: SizeGridCurve = { key: 'core', label: 'Core', ratios: { S: 1, M: 2, L: 2, XL: 1 } }

  it('fills the sizes each colour is made in; a size it lacks is skipped and the total still holds', () => {
    const r = curveFillSizeGrid({ blk: { S: 9 } }, COLOURS, SIZES, { colourKeys: ['blk', 'nvy'], total: 30, curve })
    if (!r.ok) throw new Error(r.reason)
    expect(r.value.blk).toEqual({ S: 5, M: 10, L: 10, XL: 5 })
    // Navy has no XL: 30 over 1:2:2 → 6, 12, 12.
    expect(r.value.nvy).toEqual({ S: 6, M: 12, L: 12, XL: 0 })
    expect(r.value.tan).toEqual({ S: 0, M: 0, L: 0, XL: 0 })
    expect(r.filled).toEqual(['blk', 'nvy'])
  })

  it('replaces the row: an offered size the curve gives no share becomes 0', () => {
    const r = curveFillSizeGrid({ tan: { S: 4, XL: 7 } }, COLOURS, SIZES, { colourKeys: ['tan'], total: 4, curve: { key: 'mid', label: 'Mid', ratios: { M: 1, L: 1 } } })
    expect(r.ok && r.value.tan).toEqual({ S: 0, M: 2, L: 2, XL: 0 })
  })

  it('refuses as a whole — nothing changed — when one colour cannot be filled', () => {
    const xlOnly: SizeGridCurve = { key: 'xl', label: 'XL only', ratios: { XL: 1 } }
    expect(curveFillSizeGrid({}, COLOURS, SIZES, { colourKeys: ['blk', 'nvy'], total: 10, curve: xlOnly })).toEqual({ ok: false, reason: 'no-weight', colour: 'nvy' })
    expect(curveFillSizeGrid({}, COLOURS, SIZES, { colourKeys: ['blk'], total: 10, curve }, 2)).toEqual({ ok: false, reason: 'over-max', colour: 'blk' })
    expect(curveFillSizeGrid({}, COLOURS, SIZES, { colourKeys: ['nope'], total: 10, curve })).toEqual({ ok: false, reason: 'no-colour' })
    expect(curveFillSizeGrid({}, COLOURS, SIZES, { colourKeys: ['blk'], total: -2, curve })).toEqual({ ok: false, reason: 'bad-total', colour: 'blk' })
  })

  it('the share text lists the sizes with a share, in scale order', () => {
    expect(curveShareText({ key: 'c', label: 'C', ratios: { XL: 1, S: '1.5', M: 0, L: '0.0' } }, SIZES)).toBe('S 1.5 · XL 1')
  })
})

describe('paste', () => {
  it('parses a spreadsheet block: tabs between cells, newlines between rows, the trailing newline dropped', () => {
    expect(parseSizeGridPaste('1\t2\t3\r\n4\t5\t6\r\n')).toEqual([['1', '2', '3'], ['4', '5', '6']])
    expect(parseSizeGridPaste('7\n8\n9')).toEqual([['7'], ['8'], ['9']])
    expect(parseSizeGridPaste('"1"\t"say ""hi"""')).toEqual([['1', 'say "hi"']])
    expect(parseSizeGridPaste('12')).toEqual([['12']])
    expect(parseSizeGridPaste('')).toEqual([])
    expect(parseSizeGridPaste('\n')).toEqual([])
    expect(parseSizeGridPaste('1\t\t3')).toEqual([['1', '', '3']])
  })

  it('a row lands across the sizes from the anchor', () => {
    const r = pasteIntoSizeGrid({}, COLOURS, SIZES, { colour: 'blk', size: 'M' }, '4\t5\t6')
    expect(r.value.blk).toEqual({ S: 0, M: 4, L: 5, XL: 6 })
    expect(r).toMatchObject({ applied: 3, notOffered: 0, outside: 0, invalid: 0, clamped: 0 })
  })

  it('a column lands down the colours; a block covers both', () => {
    const col = pasteIntoSizeGrid({}, COLOURS, SIZES, { colour: 'blk', size: 'S' }, '1\n2\n3\n')
    expect([col.value.blk.S, col.value.nvy.S, col.value.tan.S]).toEqual([1, 2, 3])
    const block = pasteIntoSizeGrid({}, COLOURS, SIZES, { colour: 'nvy', size: 'L' }, '1\t2\n3\t4')
    // Navy has no XL: its 2 is counted as not offered. Tan takes 3 and 4.
    expect(block.value.nvy).toEqual({ S: 0, M: 0, L: 1, XL: 0 })
    expect(block.value.tan).toEqual({ S: 0, M: 0, L: 3, XL: 4 })
    expect(block).toMatchObject({ applied: 3, notOffered: 1, outside: 0 })
  })

  it('counts every value that could not land: outside the grid, not a whole number; clamps what it sets', () => {
    const r = pasteIntoSizeGrid({ blk: { S: 3 } }, COLOURS, SIZES, { colour: 'tan', size: 'L' }, '1\t2\t3\n4\t5\t6\nx\t12.5\t-2')
    // Tan L, XL take 1, 2; the third column is past XL; the second and third rows are past the last colour.
    expect(r.value.tan).toEqual({ S: 0, M: 0, L: 1, XL: 2 })
    expect(r).toMatchObject({ applied: 2, outside: 7, invalid: 0 })
    const bad = pasteIntoSizeGrid({}, COLOURS, SIZES, { colour: 'blk', size: 'S' }, 'x\t12.5\t-2\t250000')
    expect(bad.value.blk).toEqual({ S: 0, M: 0, L: 0, XL: 99_999 })
    expect(bad).toMatchObject({ applied: 2, invalid: 2, clamped: 2 })
    expect(bad.value.blk.L).toBe(0)
  })

  it('an empty cell in the block sets 0; the rest of the grid is untouched', () => {
    const r = pasteIntoSizeGrid({ blk: { S: 5, M: 5, L: 5 }, tan: { S: 8 } }, COLOURS, SIZES, { colour: 'blk', size: 'S' }, '1\t\t3')
    expect(r.value.blk).toEqual({ S: 1, M: 0, L: 3, XL: 0 })
    expect(r.value.tan.S).toBe(8)
  })

  it('the paste sentence names what was skipped', () => {
    expect(SIZE_GRID_COPY.pasteResult({ applied: 6, notOffered: 0, outside: 0, invalid: 0, clamped: 0 })).toBe('Pasted 6 values.')
    expect(SIZE_GRID_COPY.pasteResult({ applied: 1, notOffered: 1, outside: 2, invalid: 1, clamped: 1 })).toBe(
      'Pasted 1 value. Skipped 4: 1 on a size not offered, 2 outside the grid, 1 not a whole number. 1 value was brought into range.',
    )
  })
})

describe('sizeGridStep — keyboard movement', () => {
  const offered = sizeGridOffered(COLOURS, SIZES) // Navy lacks XL
  it('moves one cell in each direction', () => {
    expect(sizeGridStep(offered, { row: 0, col: 1 }, 'right')).toEqual({ row: 0, col: 2 })
    expect(sizeGridStep(offered, { row: 0, col: 1 }, 'left')).toEqual({ row: 0, col: 0 })
    expect(sizeGridStep(offered, { row: 0, col: 1 }, 'down')).toEqual({ row: 1, col: 1 })
    expect(sizeGridStep(offered, { row: 1, col: 1 }, 'up')).toEqual({ row: 0, col: 1 })
  })
  it('skips a cell that is not offered, and stops at the edge', () => {
    expect(sizeGridStep(offered, { row: 0, col: 3 }, 'down')).toEqual({ row: 2, col: 3 })
    expect(sizeGridStep(offered, { row: 1, col: 2 }, 'right')).toBeNull()
    expect(sizeGridStep(offered, { row: 0, col: 0 }, 'left')).toBeNull()
    expect(sizeGridStep(offered, { row: 0, col: 0 }, 'up')).toBeNull()
    expect(sizeGridStep(offered, { row: 2, col: 0 }, 'down')).toBeNull()
  })
})

describe('words and issues', () => {
  it('a cell is named by colour and size', () => {
    expect(SIZE_GRID_COPY.cellName('Black', 'M')).toBe('Black, size M')
  })
  it('totals are grouped by the locale', () => {
    expect(formatSizeGridQuantity(1248)).toBe('1,248')
    expect(formatSizeGridQuantity(12480, 'it-IT')).toBe('12.480')
  })
  it('issues are found per cell or per colourway, and an error outranks a warning', () => {
    const issues = [
      { colour: 'blk', size: 'M', message: 'a', tone: 'warning' as const },
      { colour: 'blk', size: 'M', message: 'b' },
      { colour: 'blk', message: 'row' },
    ]
    expect(sizeGridIssuesFor(issues, 'blk', 'M').map((i) => i.message)).toEqual(['a', 'b'])
    expect(sizeGridIssuesFor(issues, 'blk', null).map((i) => i.message)).toEqual(['row'])
    expect(sizeGridIssueTone(sizeGridIssuesFor(issues, 'blk', 'M'))).toBe('error')
    expect(sizeGridIssueTone([issues[0]])).toBe('warning')
    expect(sizeGridIssueTone([])).toBeNull()
  })
})
