import { describe, expect, it } from 'vitest'

import {
  QTY_MAX_DIGITS,
  clampQty,
  qtyCanStep,
  qtyDisplayText,
  qtyEntry,
  qtyFromText,
  qtyHeldReason,
  qtyInRange,
  qtyKeyFromKeyboard,
  qtyNumberText,
  qtyPadRows,
  qtyPress,
  qtyStep,
  roundQty,
  textFromQty,
  type QtyBounds,
  type QtyEntry,
  type QtyKey,
} from './quantityPadModel'

/** Presses keys one after another from `start`, returning the last result. */
function type(start: QtyEntry, keys: string, bounds: QtyBounds = {}) {
  let entry = start
  let last = { entry, value: qtyFromText(entry.text), refused: null as string | null }
  for (const k of keys) {
    const key = (k === '.' ? 'sep' : k === '<' ? 'back' : k === 'C' ? 'clear' : k) as QtyKey
    last = qtyPress(entry, key, bounds)
    entry = last.entry
  }
  return last
}

const empty: QtyEntry = { text: '', fresh: false }

describe('rounding (G6)', () => {
  it('rounds half away from zero on the decimal digits a person reads, not on the binary value', () => {
    expect(roundQty(2.675, 2)).toBe(2.68) // toFixed gives 2.67
    expect(roundQty(1.005, 2)).toBe(1.01)
    expect(roundQty(0.1 + 0.2, 1)).toBe(0.3)
    expect(roundQty(2.5, 0)).toBe(3)
    expect(roundQty(-2.5, 0)).toBe(-3)
    expect(roundQty(24.4999, 0)).toBe(24)
    expect(roundQty(-0.0001, 2)).toBe(0)
    expect(Object.is(roundQty(-0.0001, 2), -0)).toBe(false)
  })

  it('shows a number the person did not type at the pad precision', () => {
    expect(textFromQty(5.5, 2)).toBe('5.50')
    expect(textFromQty(24, 0)).toBe('24')
    expect(textFromQty(2.675, 2)).toBe('2.68')
    expect(textFromQty(null, 2)).toBe('')
    expect(qtyNumberText(5.5, 2, ',')).toBe('5,50')
    expect(qtyDisplayText('12.', ',')).toBe('12,')
  })

  it('reads typed text as a number; a trailing separator is still a number', () => {
    expect(qtyFromText('')).toBeNull()
    expect(qtyFromText('5.')).toBe(5)
    expect(qtyFromText('0.25')).toBe(0.25)
    expect(qtyFromText('007')).toBe(7)
  })
})

describe('bounds (G6)', () => {
  it('clamps and checks the range; nothing typed is never in range', () => {
    expect(clampQty(30, { min: 0, max: 24 })).toBe(24)
    expect(clampQty(-1, { min: 0, max: 24 })).toBe(0)
    expect(qtyInRange(24, { min: 0, max: 24 })).toBe(true)
    expect(qtyInRange(25, { min: 0, max: 24 })).toBe(false)
    expect(qtyInRange(null, {})).toBe(false)
  })

  it('steps by the step, lands on the precision and never leaves the range', () => {
    expect(qtyStep(0.2, 1, { step: 0.1, decimals: 1 })).toBe(0.3)
    expect(qtyStep(23, 1, { max: 24 })).toBe(24)
    expect(qtyStep(24, 1, { max: 24 })).toBe(24)
    expect(qtyStep(0, -1, { min: 0 })).toBe(0)
    expect(qtyStep(20, 1, { max: 24 }, 10)).toBe(24)
    // Nothing shown counts as 0; a min above it is the floor.
    expect(qtyStep(null, 1, {})).toBe(1)
    expect(qtyStep(null, 1, { min: 5 })).toBe(5)
    // A step of 0 or less is a step of 1.
    expect(qtyStep(3, 1, { step: 0 })).toBe(4)
  })

  it('holds a stepper at its bound', () => {
    expect(qtyCanStep(24, 1, { max: 24 })).toBe(false)
    expect(qtyCanStep(24, -1, { max: 24 })).toBe(true)
    expect(qtyCanStep(0, -1, { min: 0 })).toBe(false)
    expect(qtyCanStep(null, -1, { min: 0 })).toBe(true)
  })

  it('says why a confirm is held: nothing typed, or out of range', () => {
    const words = { emptyLabel: 'Scrivi una quantità', rangeLabel: (min?: number, max?: number) => `Da ${min} a ${max}` }
    expect(qtyHeldReason(null, { min: 0, max: 24 }, words)).toBe('Scrivi una quantità')
    expect(qtyHeldReason(3, { min: 10, max: 24 }, words)).toBe('Da 10 a 24')
    expect(qtyHeldReason(12, { min: 10, max: 24 }, words)).toBeNull()
  })
})

describe('typing on the pad (G6)', () => {
  it('a fresh default is replaced by the first digit: 24, then 2 2, is 22 (MES-090 one-tap default)', () => {
    const r = type(qtyEntry(24), '22', { max: 99 })
    expect(r.entry.text).toBe('22')
    expect(r.value).toBe(22)
    expect(r.entry.fresh).toBe(false)
  })

  it('refuses a digit that would pass max, keeping the number', () => {
    const r = type(empty, '25', { max: 24 })
    expect(r.refused).toBe('max')
    expect(r.entry.text).toBe('2')
    expect(type(empty, '24', { max: 24 }).refused).toBeNull()
    expect(type(qtyEntry(3), '9', { max: 5 }).refused).toBe('max')
  })

  it('allows under min on the way (1 then 5 makes 15 with min 10)', () => {
    const one = type(empty, '1', { min: 10, max: 24 })
    expect(one.refused).toBeNull()
    expect(one.value).toBe(1)
    expect(type(empty, '15', { min: 10, max: 24 }).value).toBe(15)
  })

  it('drops leading zeros and keeps at most nine digits', () => {
    expect(type(empty, '007').entry.text).toBe('7')
    const nine = type(empty, '123456789')
    expect(nine.value).toBe(123456789)
    expect(type(nine.entry, '0').refused).toBe('length')
    expect(QTY_MAX_DIGITS).toBe(9)
  })

  it('decimals: one separator, at most `decimals` digits after it, and none without decimals', () => {
    expect(type(empty, '5.25', { decimals: 2 }).value).toBe(5.25)
    expect(type(empty, '5.255', { decimals: 2 }).refused).toBe('decimals')
    expect(type(empty, '5..2', { decimals: 2 }).entry.text).toBe('5.2')
    expect(type(empty, '.5', { decimals: 1 }).entry.text).toBe('0.5')
    expect(type(empty, '5.', { decimals: 0 }).entry.text).toBe('5')
    // A fresh number and the separator start "0.".
    expect(type(qtyEntry(5.5, 2), '.', { decimals: 2 }).entry.text).toBe('0.')
    // Past max with the decimals: 24.5 > 24.
    expect(type(empty, '24.5', { max: 24, decimals: 1 }).refused).toBe('max')
  })

  it('Back removes the last character (also of a fresh number); Clear empties', () => {
    expect(type(qtyEntry(24), '<').entry).toEqual({ text: '2', fresh: false })
    expect(type(qtyEntry(5.5, 2), '<').entry.text).toBe('5.5')
    const cleared = type(qtyEntry(24), 'C')
    expect(cleared.entry.text).toBe('')
    expect(cleared.value).toBeNull()
  })

  it('reads physical keys: digits, both separators with decimals, Backspace, Escape, arrows, Enter', () => {
    expect(qtyKeyFromKeyboard('7')).toBe('7')
    expect(qtyKeyFromKeyboard(',', 2)).toBe('sep')
    expect(qtyKeyFromKeyboard('.', 2)).toBe('sep')
    expect(qtyKeyFromKeyboard(',', 0)).toBeNull()
    expect(qtyKeyFromKeyboard('Backspace')).toBe('back')
    expect(qtyKeyFromKeyboard('Escape')).toBe('clear')
    expect(qtyKeyFromKeyboard('ArrowUp')).toBe('up')
    expect(qtyKeyFromKeyboard('PageDown')).toBe('down10')
    expect(qtyKeyFromKeyboard('Enter')).toBe('confirm')
    expect(qtyKeyFromKeyboard('a')).toBeNull()
  })

  it('is the PIN pad layout; with decimals the separator takes Clear\'s place', () => {
    expect(qtyPadRows(0).flat()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'])
    expect(qtyPadRows(2)[3]).toEqual(['sep', '0', 'back'])
  })
})
