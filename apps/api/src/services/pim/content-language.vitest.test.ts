import { describe, expect, it } from 'vitest'
import { normalizeLanguage } from './content-language.js'

describe('language-only content addresses', () => {
  it.each([['de-DE', 'de'], ['DE_de', 'de'], ['nl_BE', 'nl'], ['FR-be', 'fr'], ['EN', 'en'], ['fil-PH', 'fil'], ['it', 'it']])('%s becomes %s', (tag, language) => {
    expect(normalizeLanguage(tag)).toBe(language)
    expect(normalizeLanguage(normalizeLanguage(tag))).toBe(language)
  })
  it.each(['', 'd', 'default', ' de', 'de ', '12', '-de', 'it.IT', null, undefined, 3])('rejects invalid language %s', tag => {
    expect(() => normalizeLanguage(tag as string)).toThrow()
  })
})
