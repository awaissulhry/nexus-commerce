import { describe, expect, it } from 'vitest'
import { matchScore, normalizeForSearch, searchOptions, searchTokens } from './option-search'

// Real names taken from the live account — separator-heavy on purpose, since that is exactly what
// broke the previous `label.toLowerCase().includes(q)` matcher.
const NAMES = [
  'IT-AIREON-SP-Category-Broad',
  'IT-AIREON-SP-Category-Exact',
  'IT-AIREON-SP-Brand-Exact',
  'IT-AIREON-SP-Auto',
  'GALE | IT | Phrase | Category',
  'GALE | IT | Broad | Brand',
  'GALE | IT | Auto',
  'DE_Exact_3_Keywords',
  'DE_Phrase_3_Keywords',
  'Auto_Close_Moss',
  'XAVIA GALE Giacca Da Moto Da Uomo - Giubbotto Moto Impermeabile E Ventilata (IT)',
  'IT AIRMESH',
]
const find = (q: string) => searchOptions(q, NAMES, (n) => n)

describe('normalizeForSearch', () => {
  it('collapses the separators that hid word boundaries', () => {
    expect(normalizeForSearch('GALE | IT | Broad | Brand')).toBe('gale it broad brand')
    expect(normalizeForSearch('IT-AIREON-SP-Category-Broad')).toBe('it aireon sp category broad')
    expect(normalizeForSearch('DE_Exact_3_Keywords')).toBe('de exact 3 keywords')
  })
  it('strips accents so Italian names match either way', () => {
    expect(normalizeForSearch('Protezione')).toBe('protezione')
    expect(normalizeForSearch('perché')).toBe('perche')
  })
  it('survives punctuation-only and empty input', () => {
    expect(normalizeForSearch('|||')).toBe('')
    expect(normalizeForSearch('')).toBe('')
  })
})

describe('the queries that used to return nothing', () => {
  // Each of these produced 0 matches under the old substring matcher.
  it('finds multi-word queries across separators', () => {
    expect(find('gale broad')).toEqual(['GALE | IT | Broad | Brand'])
    expect(find('aireon broad')).toEqual(['IT-AIREON-SP-Category-Broad'])
    expect(find('de exact')).toEqual(['DE_Exact_3_Keywords'])
  })
  it('finds "gale it", whose label literally contains "GALE | IT"', () => {
    expect(find('gale it').length).toBe(4)
    expect(find('gale it')[0]).toBe('GALE | IT | Auto') // shortest of the equal-scoring GALE rows
  })
  it('matches a word prefix ("cat" → Category), still requiring the other token', () => {
    expect(find('cat exact')).toEqual(['IT-AIREON-SP-Category-Exact'])
  })
  it('matches mid-word substrings', () => {
    expect(find('mesh')).toEqual(['IT AIRMESH'])
  })
  it('is order-independent', () => {
    expect(find('broad gale')).toEqual(find('gale broad'))
  })
})

describe('precision — it must not invent matches', () => {
  it('requires every token', () => {
    expect(find('gale nonexistent')).toEqual([])
  })
  it('does not tolerate typos', () => {
    expect(find('airon')).toEqual([])
    expect(find('giubotto')).toEqual([])
  })
  it('excludes near-misses that lack a token', () => {
    expect(find('gale broad')).not.toContain('GALE | IT | Auto')
  })
})

describe('ranking', () => {
  it('puts an exact whole-label match first', () => {
    expect(searchOptions('it airmesh', NAMES, (n) => n)[0]).toBe('IT AIRMESH')
  })
  it('prefers an adjacent phrase over scattered tokens', () => {
    const ranked = searchOptions('moto uomo', NAMES, (n) => n)
    expect(ranked[0]).toContain('Giacca Da Moto Da Uomo')
  })
  it('is deterministic for equal scores (shorter label wins, then alphabetical)', () => {
    const a = find('gale')
    const b = find('gale')
    expect(a).toEqual(b)
    expect(a[0]!.length).toBeLessThanOrEqual(a[1]!.length)
  })
})

describe('edge cases', () => {
  it('an empty query returns the input order untouched', () => {
    expect(find('')).toEqual(NAMES)
    expect(find('   ')).toEqual(NAMES)
  })
  it('a punctuation-only query is treated as empty rather than matching nothing', () => {
    expect(find('|')).toEqual(NAMES)
  })
  it('ignores extra whitespace between tokens', () => {
    expect(find('  gale   broad ')).toEqual(['GALE | IT | Broad | Brand'])
  })
  it('matchScore returns null for a miss and a number for a hit', () => {
    expect(matchScore('GALE | IT | Auto', searchTokens('zzz'))).toBeNull()
    expect(matchScore('GALE | IT | Auto', searchTokens('gale'))).toBeGreaterThan(0)
  })
  it('handles a label that normalises to nothing', () => {
    expect(searchOptions('x', ['|||'], (n) => n)).toEqual([])
  })
})
