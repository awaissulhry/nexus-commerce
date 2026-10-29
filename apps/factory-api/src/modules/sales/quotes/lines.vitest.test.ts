import { describe, expect, it } from 'vitest'
import { defaultLineDescription } from './lines'

/**
 * The default description of a quote line travels to the order and the invoice; FatturaPA takes Latin-1 only (ISO
 * 8859-1), so the text the module itself writes has nothing outside it (#897: an em dash was refused).
 */
const LATIN_1 = /^[ -~ -ÿ]*$/

describe('a quote line\'s default description', () => {
  it('is the style code and name, then the colourway, in Latin-1 only', () => {
    const text = defaultLineDescription({ code: 'SEED-JKT-01', name: 'Seed leather jacket' }, { name: 'Black' })
    expect(text).toBe('SEED-JKT-01 Seed leather jacket - Black')
    expect(LATIN_1.test(text)).toBe(true)
    // Italian names with accents are Latin-1 too.
    expect(LATIN_1.test(defaultLineDescription({ code: 'GIA-01', name: 'Giacca più leggera' }, { name: 'Blu notte' }))).toBe(true)
  })
})
