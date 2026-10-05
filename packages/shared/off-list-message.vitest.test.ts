import { describe, expect, it } from 'vitest'
import { allowedValuesText, isOffListMessage, offListMessage } from './off-list-message'

const SEASONS = ['Estate', 'Inverno', 'Primavera', 'Autunno', 'Tutte le stagioni', 'Primavera/Estate', 'Autunno/Inverno', 'Mezza stagione', 'Pioggia', 'Neve', 'Caldo', 'Freddo']

describe('offListMessage — one sentence on every surface', () => {
  it('channel wording: names the value, the channel, what it may do, and the list', () => {
    expect(offListMessage({ field: 'Season', values: ['Tutte le stagioni!'], channel: 'EBAY', allowed: SEASONS }))
      .toBe('Season: "Tutte le stagioni!" is not on eBay\'s list. eBay may refuse it. Allowed: Estate, Inverno, Primavera, Autunno, Tutte le stagioni, Primavera/Estate, Autunno/Inverno, Mezza stagione, … (12 in all).')
    expect(offListMessage({ field: 'Colour', values: ['Teal'], channel: 'Amazon', allowed: ['Black', 'Red'] }))
      .toBe('Colour: "Teal" is not on Amazon\'s list. Amazon may refuse it. Allowed: Black, Red.')
  })
  it('Shared wording: the column\'s own options, no channel named', () => {
    expect(offListMessage({ field: 'Season', values: ['X'] })).toBe('Season: "X" is not one of this column\'s options.')
    expect(offListMessage({ field: 'Season', values: ['X'], allowed: ['Estate'] })).toBe('Season: "X" is not one of this column\'s options. Allowed: Estate.')
  })
  it('a formula result adds "Saved as it is." — and an open list drops the refusal', () => {
    expect(offListMessage({ field: 'Season', values: ['X'], channel: 'EBAY', saved: true, allowed: ['Estate'] }))
      .toBe('Season: "X" is not on eBay\'s list. Saved as it is. eBay may refuse it. Allowed: Estate.')
    expect(offListMessage({ field: 'Brand', values: ['Xavia Racing'], channel: 'EBAY', saved: true, mayRefuse: false }))
      .toBe('Brand: "Xavia Racing" is not on eBay\'s list. Saved as it is.')
    expect(offListMessage({ field: 'Season', values: ['X'], saved: true })).toBe('Season: "X" is not one of this column\'s options. Saved as it is.')
  })
  it('several values read in the plural; no field or no value still reads as a sentence', () => {
    expect(offListMessage({ field: 'Fits', values: ['A', 'B'], channel: 'EBAY' })).toBe('Fits: "A", "B" are not on eBay\'s list. eBay may refuse them.')
    expect(offListMessage({ field: 'Fits', values: ['A', 'B'] })).toBe('Fits: "A", "B" are not among this column\'s options.')
    expect(offListMessage({ values: ['A'] })).toBe('"A" is not one of this column\'s options.')
    expect(offListMessage({ field: 'Fits', values: [], channel: 'EBAY' })).toBe('Fits: the value is not on eBay\'s list. eBay may refuse it.')
  })
  it('the allowed list is bounded and never pretends to be whole', () => {
    expect(allowedValuesText(['A', 'A', 'B'])).toBe('A, B')
    expect(allowedValuesText(Array.from({ length: 100 }, (_, i) => `H${i}`))).toMatch(/, … \(100 in all\)$/)
    expect(allowedValuesText(null)).toBe('')
  })
})

describe('isOffListMessage — a flag, never a refusal', () => {
  it('recognises every new wording', () => {
    for (const message of [
      offListMessage({ field: 'Season', values: ['X'], channel: 'EBAY', allowed: SEASONS }),
      offListMessage({ field: 'Season', values: ['X', 'Y'], channel: 'SHOPIFY' }),
      offListMessage({ field: 'Season', values: ['X'] }),
      offListMessage({ field: 'Season', values: ['X', 'Y'] }),
      offListMessage({ field: 'Season', values: ['X'], channel: 'AMAZON', saved: true, mayRefuse: false }),
      `item 2: ${offListMessage({ field: 'Material', values: ['Cordura'], channel: 'Amazon' })}`,
    ]) expect(isOffListMessage(message), message).toBe(true)
  })
  it('still recognises the wordings stored before E3', () => {
    for (const message of [
      'Season contains an unaccepted value. Allowed values: Estate · Inverno.',
      'Voltage: must be equal to one of the allowed values (A, B).',
      '/season/0/value must be equal to one of the allowed values',
      'Choose one of these values: Rouge, Bleu.',
    ]) expect(isOffListMessage(message), message).toBe(true)
  })
  it('does not excuse any other finding', () => {
    for (const message of ['Brand is required by Amazon · IT', 'Colour exceeds 5 characters (7).', 'must be number', 'must NOT have more than 1 items',
      'Season: "X" is deprecated by the channel.', 'This listing is not one of the product\'s photo destinations yet.']) {
      expect(isOffListMessage(message), message).toBe(false)
    }
  })
})

describe('withFieldName', () => {
  it('adds the field name once', async () => {
    const { withFieldName } = await import('./off-list-message')
    expect(withFieldName('Season', '"X" is not on eBay\'s list.')).toBe('Season: "X" is not on eBay\'s list.')
    expect(withFieldName('Season', 'Season: "X" is not on eBay\'s list.')).toBe('Season: "X" is not on eBay\'s list.')
  })
})
