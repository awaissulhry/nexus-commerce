import { describe, expect, it } from 'vitest'

import { cellValueOf, isUnchanged, panelValueOf } from './selectPanelModel'

/**
 * The cell↔panel value boundary (AG.1-f). The cell speaks the wire's language (`null`, a code like
 * `'PK'`); the panel speaks the DOM's (`undefined`, a string). They disagree about "nothing", and
 * every bug in this file's family comes from one side guessing what the other meant.
 */
describe('panelValueOf — what the panel highlights', () => {
  it('passes a real value through as a string', () => {
    expect(panelValueOf('PK')).toBe('PK')
  })

  /**
   * 🔴 The three spellings of "nothing" collapse to ONE. A cell may hold `null` (the wire's unset),
   * `undefined` (never delivered) or `''` (cleared), and an operator cannot tell them apart. If the
   * panel treated `''` as a value it would highlight an option that does not exist and scroll to it.
   */
  it('collapses null, undefined and empty string to "nothing selected"', () => {
    for (const nothing of [null, undefined, '']) {
      expect(`${String(nothing)} -> ${panelValueOf(nothing)}`).toBe(`${String(nothing)} -> undefined`)
    }
  })

  it('does NOT collapse values that merely look empty', () => {
    // A code of '0' is a value. Anything testing truthiness rather than emptiness gets this wrong.
    expect(panelValueOf(0)).toBe('0')
    expect(panelValueOf(false)).toBe('false')
    expect(panelValueOf(' ')).toBe(' ')
  })
})

describe('cellValueOf — what the cell stores', () => {
  it('stores the chosen code', () => {
    expect(cellValueOf('IT')).toBe('IT')
  })

  /**
   * 🔴 `null`, never `''`. `writeGate` deliberately does NOT fold `''` into `null` — a cleared text
   * cell and an unset one are different intents on the wire — so returning `''` here would send an
   * empty string where every other "unset" on this sheet sends null, and only for select columns.
   */
  it('stores null for the empty row, not an empty string', () => {
    expect(cellValueOf('')).toBeNull()
    expect(cellValueOf('')).not.toBe('')
  })
})

describe('isUnchanged — why an unchanged pick is a CANCEL', () => {
  it('is true when the operator re-picks what was already there', () => {
    expect(isUnchanged('PK', 'PK')).toBe(true)
  })

  it('is false for a real change', () => {
    expect(isUnchanged('PK', 'IT')).toBe(false)
  })

  /**
   * The case the round-trip has to survive: every spelling of "nothing" in the cell must read as
   * unchanged against the empty row, or re-picking "none" on an already-empty cell would commit,
   * fire `cellValueChanged`, and paint the cell `saving` for a write `writeGate` then suppresses —
   * a lie about having saved something.
   */
  it('treats every spelling of empty as unchanged against the empty row', () => {
    for (const nothing of [null, undefined, '']) {
      expect(`${String(nothing)} -> ${isUnchanged(nothing, '')}`).toBe(`${String(nothing)} -> true`)
    }
  })

  it('sees a real value replaced by the empty row as a change', () => {
    expect(isUnchanged('PK', '')).toBe(false)
  })

  /** The invariant that keeps the two directions honest: the round trip must be lossless. */
  it('round-trips: what the cell stores reads back as what the panel highlighted', () => {
    for (const chosen of ['PK', 'IT', '0', '']) {
      expect(panelValueOf(cellValueOf(chosen))).toBe(panelValueOf(chosen))
    }
  })
})
