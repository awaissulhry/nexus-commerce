import { describe, expect, it } from 'vitest'

import { plainFirstGuess, plainGridHeight } from './plainGrid'

describe('plainGridHeight — a plain grid is as tall as its rows', () => {
  it('one or two rows: header + rows + frame, no empty band', () => {
    expect(plainGridHeight({ header: 46, rows: 46, min: 0, max: 480 })).toBe(94)
    expect(plainGridHeight({ header: 46, rows: 2 * 46, min: 96, max: 480 })).toBe(46 + 92 + 2)
  })
  it('two-line rows, pinned rows and a horizontal scrollbar count', () => {
    expect(plainGridHeight({ header: 46, rows: 64 + 46, extra: 46 + 12, min: 96, max: 480 })).toBe(46 + 110 + 58 + 2)
  })
  it('a long table stops at the max and scrolls inside', () => {
    expect(plainGridHeight({ header: 46, rows: 40 * 46, min: 96, max: 480 })).toBe(480)
  })
  it('no rows keeps room for the overlay', () => {
    expect(plainGridHeight({ header: 46, rows: 0, min: 140, max: 480 })).toBe(140)
  })
  it('rounds a fractional row height up, never clipping a row', () => {
    expect(plainGridHeight({ header: 45.5, rows: 46.2, min: 0, max: 480 })).toBe(94)
  })
})

describe('plainFirstGuess — before AG has measured', () => {
  it('one row height per row; the overlay\'s room with none; capped', () => {
    expect(plainFirstGuess(46, 46, 1, 480)).toBe(94)
    expect(plainFirstGuess(46, 46, 0, 480)).toBe(140)
    expect(plainFirstGuess(46, 46, 50, 480)).toBe(480)
  })
})
