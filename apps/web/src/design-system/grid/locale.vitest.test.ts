import { describe, expect, it } from 'vitest'

import { GRID_LOCALE_TEXT } from './locale'

describe('AG\'s words in the DS\'s voice', () => {
  it('every menu word is sentence case: one capital, then lower case (CSV stays an acronym)', () => {
    for (const [key, text] of Object.entries(GRID_LOCALE_TEXT)) {
      const t = text.replace(/\bCSV\b/g, 'Csv')
      expect(t[0], key).toBe(t[0]!.toUpperCase())
      expect(t.slice(1), key).toBe(t.slice(1).toLowerCase())
    }
  })
  it('the empty state says what the engine\'s overlay says', () => {
    expect(GRID_LOCALE_TEXT.noRowsToShow).toBe('Nothing here')
  })
})
