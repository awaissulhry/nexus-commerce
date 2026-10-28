import { describe, expect, it } from 'vitest'

import { acceptNumberEdit, isNumberDraft, NUMBER_ONLY_MESSAGE, numberCommitText, numberStart } from './numberEntry'

/* R-47 (2026-09-23) — a number cell never loses its value to a stray letter. The rule is pure; the editor wires it. */
describe('numberStart — how a number editor opens', () => {
  it('a digit, a sign or a decimal separator starts a new number (typing replaces)', () => {
    for (const key of ['7', '-', '+', '.', ',']) {
      expect(numberStart({ eventKey: key, stored: '105', allowFormula: true })).toEqual({ text: key, touched: true, refused: false })
    }
  })

  it('a LETTER is refused and the stored value is kept, untouched (an untouched open never writes)', () => {
    expect(numberStart({ eventKey: 'Q', stored: '105', allowFormula: true })).toEqual({ text: '105', touched: false, refused: true })
    expect(numberStart({ eventKey: 'a', stored: '0', allowFormula: false })).toEqual({ text: '0', touched: false, refused: true })
  })

  it('e and a space are refused too — the letter that looks like part of a number, and the key that would open empty', () => {
    expect(numberStart({ eventKey: 'e', stored: '12', allowFormula: true }).refused).toBe(true)
    expect(numberStart({ eventKey: ' ', stored: '12', allowFormula: true }))
      .toEqual({ text: '12', touched: false, refused: true })
  })

  it('= is the formula switch where formulas are available (#775), and refused where they are not', () => {
    expect(numberStart({ eventKey: '=', stored: '105', allowFormula: true })).toEqual({ text: '=', touched: true, refused: false })
    expect(numberStart({ eventKey: '=', stored: '105', allowFormula: false })).toEqual({ text: '105', touched: false, refused: true })
  })

  it('F2 / Enter / double-click (no key) open on the stored value, untouched', () => {
    expect(numberStart({ eventKey: null, stored: '105', allowFormula: true })).toEqual({ text: '105', touched: false, refused: false })
    expect(numberStart({ eventKey: 'F2', stored: '105', allowFormula: true })).toEqual({ text: '105', touched: false, refused: false })
    expect(numberStart({ eventKey: undefined, stored: '=a+b', allowFormula: true }).text).toBe('=a+b')
  })
})

describe('acceptNumberEdit — every later edit judged whole', () => {
  it('keeps a number, or the beginning of one', () => {
    for (const next of ['', '1', '-', '.', '1.', '12,5', '-0.5', '1e', '1e-', '1e-7', ' 7.5 ']) {
      expect(acceptNumberEdit('1', next, false)).toEqual({ text: next, refused: false })
    }
  })

  it('refuses a letter, a second decimal separator, thousands separators, and a pasted word — the text stays', () => {
    for (const next of ['1a', 'Q', 'e', '1.2.3', '1,234.5', 'abc', '1 0', '--1']) {
      expect(acceptNumberEdit('1', next, true)).toEqual({ text: '1', refused: true })
    }
  })

  it('a formula draft passes only where formulas are available', () => {
    expect(acceptNumberEdit('105', '=105', true)).toEqual({ text: '=105', refused: false })
    expect(acceptNumberEdit('105', '=105', false)).toEqual({ text: '105', refused: true })
  })
})

describe('isNumberDraft', () => {
  it('an exponent needs a mantissa digit', () => {
    expect(isNumberDraft('e5')).toBe(false)
    expect(isNumberDraft('.e5')).toBe(false)
    expect(isNumberDraft('2e5')).toBe(true)
    expect(isNumberDraft('.5e3')).toBe(true)
  })
})

describe('numberCommitText', () => {
  it('writes a decimal comma as a point, trims, and leaves a formula untouched', () => {
    expect(numberCommitText('12,5')).toBe('12.5')
    expect(numberCommitText(' 7 ')).toBe('7')
    expect(numberCommitText('=SUM(a, b)')).toBe('=SUM(a, b)')
  })
})

it('the refusal is stated in one sentence', () => {
  expect(NUMBER_ONLY_MESSAGE).toBe('Numbers only — the value was kept.')
})
