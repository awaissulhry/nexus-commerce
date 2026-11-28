import { describe, expect, it } from 'vitest'
import {
  FIXED_COLUMN_NAMES,
  holdsValue,
  isDay,
  isUseOn,
  newColumnProblem,
  ownValueFields,
  ownValueOf,
  OWN_COLUMN_LIMITS,
  OWN_COLUMN_WORDS,
  trimDecimal,
  useProblem,
  USE_OFF_FROM,
  type UseFacts,
} from './rules'

/** owb- po1.4: the customer's own columns — every rule of the domain (design § 5zi C, R62 a; G8 holds the shapes too). */
describe('a new own column', () => {
  it('a name of 1 to 40 (a 400), never a fixed column’s name in English or Italian, never twice among the open ones (any case)', () => {
    expect(newColumnProblem({ name: '   ', kind: 'TEXT' }, [])?.key).toBe('NAME')
    expect(newColumnProblem({ name: 'x'.repeat(41), kind: 'TEXT' }, [])?.key).toBe('NAME')
    expect(newColumnProblem({ name: 'Rider number', kind: 'TEXT' }, [])).toBeNull()
    for (const fixed of ['Model', 'material', 'SIZES', 'Pieces', 'Your price', 'Line', 'Picture', 'Taglie', 'il vostro prezzo']) expect(newColumnProblem({ name: fixed, kind: 'TEXT' }, [])?.key, fixed).toBe('FIXED')
    expect(FIXED_COLUMN_NAMES).toEqual(expect.arrayContaining(['Model', 'Material', 'Sizes', 'Pieces', 'Your price', 'Line', 'Picture']))
    expect(newColumnProblem({ name: ' rider NUMBER ', kind: 'TEXT' }, ['Rider number'])).toEqual({ key: 'DUPLICATE', words: OWN_COLUMN_WORDS.DUPLICATE('rider NUMBER') })
  })

  it('a choice column needs at least 2 distinct choices; any other kind has none', () => {
    expect(newColumnProblem({ name: 'Logo', kind: 'CHOICE', choices: ['Front'] }, [])?.key).toBe('CHOICES')
    expect(newColumnProblem({ name: 'Logo', kind: 'CHOICE', choices: ['Front', 'Front'] }, [])?.key).toBe('CHOICES')
    expect(newColumnProblem({ name: 'Logo', kind: 'CHOICE', choices: ['Front', 'Back'] }, [])).toBeNull()
    expect(newColumnProblem({ name: 'Logo ready?', kind: 'YES_NO', choices: ['Yes', 'No'] }, [])?.key).toBe('NO_CHOICES')
    expect(newColumnProblem({ name: 'Needed by', kind: 'DATE', choices: null }, [])).toBeNull()
  })
})

describe('the columns on one record', () => {
  const columns = new Map([
    ['a', { name: 'Rider number', closed: false }],
    ['b', { name: 'Logo ready?', closed: false }],
    ['c', { name: 'Old note', closed: true }],
  ])
  const facts = (over: Partial<UseFacts>): UseFacts => ({ asked: [], columns, onNow: [], withValues: new Set(), dropValues: false, ...over })

  it('at most 8, each once, the customer’s own (else UNKNOWN: a 404), a closed one not switched on again', () => {
    expect(useProblem(facts({ asked: ['a', 'b'] }))).toBeNull()
    expect(useProblem(facts({ asked: ['a', 'a'] }))?.key).toBe('TWICE')
    expect(useProblem(facts({ asked: Array.from({ length: OWN_COLUMN_LIMITS.perRecord + 1 }, (_, index) => `x${index}`) }))?.key).toBe('TOO_MANY')
    expect(useProblem(facts({ asked: ['zz'] }))).toEqual({ key: 'UNKNOWN', columnId: 'zz' })
    expect(useProblem(facts({ asked: ['c'] }))?.key).toBe('CLOSED')
    // A closed column already on the record stays (kept with its values).
    expect(useProblem(facts({ asked: ['c'], onNow: ['c'] }))).toBeNull()
  })

  it('a column holding a value is not switched off by mistake: only with dropValues', () => {
    expect(useProblem(facts({ asked: ['a'], onNow: ['a', 'b'], withValues: new Set(['b']) }))).toEqual({ key: 'HAS_VALUES', words: OWN_COLUMN_WORDS.HAS_VALUES('Logo ready?'), columnId: 'b' })
    expect(useProblem(facts({ asked: ['a'], onNow: ['a', 'b'], withValues: new Set(['b']), dropValues: true }))).toBeNull()
    expect(useProblem(facts({ asked: ['a'], onNow: ['a', 'b'], withValues: new Set() }))).toBeNull()
  })

  it('a use switched off keeps its row, from USE_OFF_FROM on (no delete grant)', () => {
    expect(isUseOn(1)).toBe(true)
    expect(isUseOn(8)).toBe(true)
    expect(isUseOn(USE_OFF_FROM)).toBe(false)
  })
})

describe('a value', () => {
  it('fills only the field of its kind, or is refused in words; null and blank words clear it', () => {
    expect(ownValueFields('TEXT', [], ' 12 ')).toEqual({ ok: true, fields: { valueText: '12', valueNumber: null, valueDate: null, valueBool: null } })
    expect(ownValueFields('TEXT', [], '   ')).toEqual({ ok: true, fields: { valueText: null, valueNumber: null, valueDate: null, valueBool: null } })
    expect(ownValueFields('TEXT', [], 'x'.repeat(OWN_COLUMN_LIMITS.text + 1)).ok).toBe(false)
    expect(ownValueFields('YES_NO', [], true)).toMatchObject({ ok: true, fields: { valueBool: true } })
    expect(ownValueFields('YES_NO', [], 'yes')).toEqual({ ok: false, words: OWN_COLUMN_WORDS.VALUE.YES_NO })
    expect(ownValueFields('CHOICE', ['Front', 'Back'], 'Back')).toMatchObject({ ok: true, fields: { valueText: 'Back' } })
    expect(ownValueFields('CHOICE', ['Front', 'Back'], 'Side').ok).toBe(false)
    expect(ownValueFields('NUMBER', [], 12.5)).toMatchObject({ ok: true, fields: { valueNumber: '12.5' } })
    expect(ownValueFields('NUMBER', [], '-3.1234')).toMatchObject({ ok: true, fields: { valueNumber: '-3.1234' } })
    expect(ownValueFields('NUMBER', [], '1.23456').ok).toBe(false)
    expect(ownValueFields('NUMBER', [], 1e21).ok).toBe(false)
    expect(ownValueFields('DATE', [], '2026-12-18')).toMatchObject({ ok: true, fields: { valueDate: '2026-12-18' } })
    expect(ownValueFields('DATE', [], '2026-02-30').ok).toBe(false)
    expect(ownValueFields('DATE', [], null)).toMatchObject({ ok: true })
  })

  it('reads back as the answer shows it (a decimal as text without trailing zeros)', () => {
    expect(ownValueOf('NUMBER', { valueText: null, valueNumber: '12.5000', valueDate: null, valueBool: null })).toBe('12.5')
    expect(ownValueOf('YES_NO', { valueText: null, valueNumber: null, valueDate: null, valueBool: false })).toBe(false)
    expect(ownValueOf('DATE', { valueText: null, valueNumber: null, valueDate: '2026-12-18', valueBool: null })).toBe('2026-12-18')
    expect(trimDecimal('3.0000')).toBe('3')
    expect(trimDecimal('-0.0000')).toBe('0')
    expect(isDay('2026-1-01')).toBe(false)
    expect(holdsValue({ valueText: null, valueNumber: null, valueDate: null, valueBool: false })).toBe(true)
    expect(holdsValue({ valueText: null, valueNumber: null, valueDate: null, valueBool: null })).toBe(false)
  })

  it('every refusal in English and Italian ("voi")', () => {
    for (const words of [OWN_COLUMN_WORDS.NAME, OWN_COLUMN_WORDS.CHOICES, OWN_COLUMN_WORDS.TOO_MANY, OWN_COLUMN_WORDS.CLOSED, OWN_COLUMN_WORDS.NOT_USED, ...Object.values(OWN_COLUMN_WORDS.VALUE)]) {
      expect(words.en.length).toBeGreaterThan(5)
      expect(words.it.length).toBeGreaterThan(5)
    }
    expect(OWN_COLUMN_WORDS.FIXED('Model').it).toContain('scegliete')
  })
})
