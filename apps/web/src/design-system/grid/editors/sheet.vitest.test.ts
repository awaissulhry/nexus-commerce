import { describe, expect, it } from 'vitest'

import { offListMessage } from '@nexus/shared/off-list-message'

import { lengthValidation, longTextEditor, matchPasteToHeaders, NO_TEXT_LIMIT, offListSentence, selectValidation, textLimitFor } from './sheet'

const COLS = [
  { colId: 'sku', headerName: 'SKU' },
  { colId: 'title', headerName: 'Title' },
  { colId: 'color', headerName: 'Colour' },
  { colId: 'size', headerName: 'Size' },
]

describe('matchPasteToHeaders — smart paste', () => {
  /**
   * 🔴 A column the block does not name comes back `null` — "leave this cell alone" — NOT `''`.
   *
   * This test used to assert the empty strings, which meant it described the implementation instead
   * of protecting the operator: AG pastes what it is given, so a two-column block from Excel blanked
   * every other visible column to its right on every pasted row. `title` is the column at risk here.
   */
  it('re-orders a block by header NAME and leaves unnamed columns UNTOUCHED', () => {
    const data = [['Size', 'SKU', 'Colour'], ['M', 'A-1', 'Black'], ['L', 'A-2', 'Red']]
    const out = matchPasteToHeaders(data, COLS, ['sku', 'title', 'color', 'size'])
    expect(out).toEqual([['A-1', null, 'Black', 'M'], ['A-2', null, 'Red', 'L']])
  })
  it('matches ids as well as labels, case-insensitively', () => {
    const data = [['sku', 'COLOUR'], ['A-1', 'Black']]
    expect(matchPasteToHeaders(data, COLS, ['sku', 'title', 'color'])).toEqual([['A-1', null, 'Black']])
  })
  it('a narrow block never reaches the columns beyond it', () => {
    // Two named columns, four targets: the two the operator meant, and two left alone.
    const data = [['SKU', 'Colour'], ['A-1', 'Black']]
    const out = matchPasteToHeaders(data, COLS, ['sku', 'title', 'color', 'size'])
    expect(out[0].filter((v) => v === null)).toHaveLength(2)
    expect(out[0]).toEqual(['A-1', null, 'Black', null])
  })
  it('pastes as-is when fewer than two headers match (a plain block of values)', () => {
    const data = [['M', 'Black'], ['L', 'Red']]
    expect(matchPasteToHeaders(data, COLS, ['size', 'color'])).toBe(data)
    const one = [['Size', 'x'], ['M', 'y']]
    expect(matchPasteToHeaders(one, COLS, ['size', 'color'])).toBe(one)
  })
  it('a single-row paste is never a header', () => {
    const data = [['SKU', 'Title']]
    expect(matchPasteToHeaders(data, COLS, ['sku', 'title'])).toBe(data)
  })
})

describe('validations — warn, never block, on an off-list value', () => {
  const strict = selectValidation(['Black', 'Red'], 'strict', true)
  it('strict select: listed = fine (case-insensitive), off-list = WARN, empty required = error', () => {
    expect(strict.validate('black', {}, 'c').level).toBeNull()
    expect(strict.validate('Blue', {}, 'c').level).toBe('warn')
    expect(strict.validate('', {}, 'c').level).toBe('error')
  })
  it('open select never warns', () => {
    expect(selectValidation(['Black'], 'open').validate('Anything', {}, 'c').level).toBeNull()
  })
  it('E3 — the warning is the one off-list sentence: the column, the value, whose list, the allowed words', () => {
    expect(strict.validate('Blue', {}, 'c').message).toBe('"Blue" is not one of this column\'s options. Allowed: Black, Red')
    const words = { field: 'Colour', channel: 'eBay', optionLabels: { Black: 'Nero', Red: 'Rosso' } }
    expect(selectValidation(['Black', 'Red'], 'strict', false, words).validate(' Blue ', {}, 'c').message)
      .toBe('Colour: "Blue" is not on eBay\'s list. eBay may refuse it. Allowed: Nero, Rosso')
  })
  it('length: over the cap is an error; bytes when the cap is IN bytes', () => {
    const chars = (cap: number) => ({ characters: cap, bytes: null })
    const bytes = (cap: number) => ({ characters: null, bytes: cap })
    expect(lengthValidation(chars(5)).validate('12345', {}, 'c').level).toBeNull()
    expect(lengthValidation(chars(5)).validate('123456', {}, 'c').level).toBe('error')
    expect(lengthValidation(bytes(4)).validate('éé', {}, 'c').level).toBeNull() // 4 bytes
    expect(lengthValidation(bytes(3)).validate('éé', {}, 'c').level).toBe('error')
  })
})

describe('the long-text editor never cuts text (P1, 2026-09-30)', () => {
  // AG's agLargeTextCellEditor sets `maxLength || 200`: with no limit given, every long-text cell stopped typing at 200.
  const limitOf = (cap?: number) => (longTextEditor(cap ? { maxLength: cap } : {}).cellEditorParams as (p: object) => { maxLength?: number })({}).maxLength
  it('passes a limit far above any channel cap, with or without a cap', () => {
    expect(limitOf()).toBeGreaterThanOrEqual(NO_TEXT_LIMIT)
    expect(limitOf(80)).toBeGreaterThanOrEqual(NO_TEXT_LIMIT)
    expect(textLimitFor(2_000_000)).toBe(2_000_000)
  })
})

/* E3 (2026-10-05) — the DS keeps a copy of the off-list sentence because the factory cannot import packages. This pins it
   to the server's (`@nexus/shared/off-list-message`) word for word; the only difference is the DS rule that no sentence
   ends with a full stop. */
describe('offListSentence — the same words as the server', () => {
  const SEASONS = ['Estate', 'Inverno', 'Primavera', 'Autunno', 'Tutte le stagioni', 'Primavera/Estate', 'Autunno/Inverno', 'Mezza stagione', 'Pioggia', 'Neve', 'Caldo', 'Freddo']
  const cases: Array<{ value: string; options: string[]; field?: string; channel?: string; optionLabels?: Record<string, string> }> = [
    { value: 'Tutte le stagioni!', options: SEASONS, field: 'Season', channel: 'eBay' },
    { value: 'X', options: SEASONS, field: 'Season' },
    { value: 'X', options: ['a', 'b', 'a'], field: 'Colour', channel: 'Amazon', optionLabels: { a: 'Nero', b: 'Rosso' } },
    { value: 'X', options: ['A'] },
    { value: 'Say "hi".', options: ['A', 'B'], channel: 'Shopify' },
    { value: 'X', options: [], field: 'Fits', channel: 'Etsy' },
  ]
  it('matches offListMessage on every case, minus the final full stop', () => {
    for (const c of cases) {
      const server = offListMessage({ field: c.field, values: [c.value], channel: c.channel, allowed: c.options.map((o) => c.optionLabels?.[o] ?? o) })
      expect(offListSentence(c.value, c.options, { field: c.field, channel: c.channel, optionLabels: c.optionLabels })).toBe(server.replace(/\.$/, ''))
    }
  })
  it('names the first eight allowed values and how many in all', () => {
    expect(offListSentence('X', SEASONS, { field: 'Season', channel: 'eBay' }))
      .toBe('Season: "X" is not on eBay\'s list. eBay may refuse it. Allowed: Estate, Inverno, Primavera, Autunno, Tutte le stagioni, Primavera/Estate, Autunno/Inverno, Mezza stagione, … (12 in all)')
  })
})
