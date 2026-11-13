import { describe, expect, it } from 'vitest'
import { changeSizes, movesWords, parsePastedSheet, pastedPriceProblem, piecesOfCell, sizeChangeProblems } from './rules'

const OFFERED = ['50', '52', '54', '56']
const grid = [
  { size: '50', quantity: 2 },
  { size: '52', quantity: 5 },
]

describe('paste lines from a sheet (SAL-160)', () => {
  it('reads the columns of the first row and each row of cells (tab or ;)', () => {
    const sheet = parsePastedSheet('Style\tColourway\t50\t52\t54\tPrice\nSEED-JKT-01\tBLK\t2\t4\t\t395,50\nSEED-JKT-01\tRed\t1\t\t2\t\n')
    expect(sheet.problems).toEqual([])
    expect(sheet.sizes).toEqual(['50', '52', '54'])
    expect(sheet.rows).toEqual([
      { row: 2, style: 'SEED-JKT-01', colourway: 'BLK', cells: { '50': '2', '52': '4' }, unitPrice: '395.50' },
      { row: 3, style: 'SEED-JKT-01', colourway: 'Red', cells: { '50': '1', '54': '2' }, unitPrice: null },
    ])
    expect(parsePastedSheet('Stile;Colore;50\r\nX;Y;3').rows[0]).toMatchObject({ style: 'X', colourway: 'Y', cells: { '50': '3' } })
  })

  it('refuses a sheet without its columns, in words', () => {
    expect(parsePastedSheet('SEED-JKT-01\tBLK\t2').problems[0]?.message).toContain('at least one row')
    expect(parsePastedSheet('Code\tSize\t50\nA\tB\t1').problems[0]?.message).toContain('"Colourway" column')
    expect(parsePastedSheet('Style\tColourway\t50\t50\nA\tB\t1\t2').problems[0]?.message).toBe('Size 50 is a column twice.')
    expect(parsePastedSheet('Style\tColourway\nA\tB').problems[0]?.message).toContain('size codes')
  })

  it('reads a cell as whole pieces and a price as 0 or more', () => {
    expect([piecesOfCell('4'), piecesOfCell(' 0 '), piecesOfCell('2.5'), piecesOfCell('-1'), piecesOfCell('100000')]).toEqual([4, 0, null, null, null])
    expect([pastedPriceProblem(null), pastedPriceProblem('395.5'), pastedPriceProblem('abc')]).toEqual([null, null, 'A unit price of 0 or more with at most 6 decimals.'])
  })
})

describe('a size run changed in bulk (SAL-160)', () => {
  it('changes by a percent (whole pieces, half up), a fixed number, a set number, or fills the empty sizes', () => {
    expect(changeSizes(grid, OFFERED, { kind: 'PERCENT', pct: '10' }, null).after).toEqual([
      { size: '50', quantity: 2 },
      { size: '52', quantity: 6 },
    ])
    expect(changeSizes(grid, OFFERED, { kind: 'DELTA', pieces: -3 }, null).after).toEqual([{ size: '52', quantity: 2 }])
    expect(changeSizes(grid, OFFERED, { kind: 'DELTA', pieces: 1 }, ['54']).after).toEqual([...grid, { size: '54', quantity: 1 }])
    expect(changeSizes(grid, OFFERED, { kind: 'SET', pieces: 3 }, ['52', '56']).after).toEqual([
      { size: '50', quantity: 2 },
      { size: '52', quantity: 3 },
      { size: '56', quantity: 3 },
    ])
    const filled = changeSizes(grid, OFFERED, { kind: 'FILL_EMPTY', pieces: 1 }, null)
    expect(filled.after.map((row) => [row.size, row.quantity])).toEqual([
      ['50', 2],
      ['52', 5],
      ['54', 1],
      ['56', 1],
    ])
    expect(movesWords(filled.moves)).toBe('54 — → 1 · 56 — → 1')
    expect(changeSizes(grid, OFFERED, { kind: 'SET', pieces: 0 }, null).problem).toContain('without a piece')
  })

  it('takes a change with its own figure in range', () => {
    expect(sizeChangeProblems({ kind: 'PERCENT', pct: '-100' })[0]?.path).toBe('body/change/pct')
    expect(sizeChangeProblems({ kind: 'PERCENT', pct: '12.5' })).toEqual([])
    expect(sizeChangeProblems({ kind: 'DELTA', pieces: 0 })[0]?.path).toBe('body/change/pieces')
    expect(sizeChangeProblems({ kind: 'FILL_EMPTY', pieces: 0 })).toHaveLength(1)
    expect(sizeChangeProblems({ kind: 'SET', pieces: 0 })).toEqual([])
  })
})
