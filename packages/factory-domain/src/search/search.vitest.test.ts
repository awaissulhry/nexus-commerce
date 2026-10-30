import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../auth/permissions/catalogue'
import { templateOf } from '../auth/roles/templates'
import { EVENT_CATALOGUE } from '../events/catalogue'
import { searchAnswer, searchQuery } from './contracts'
import { hasExactHit, matchedParts } from './highlight'
import { foldSearchText, looksLikeNumber, queryWords, SEARCH_LIMITS, searchTextOf, SearchTextError } from './text'

describe('search text (B-W2a-32)', () => {
  it('folds case, accents and punctuation; keeps the joiners inside numbers and codes', () => {
    expect(foldSearchText('Società  Pista Racing, S.r.l.')).toBe('societa pista racing s.r.l')
    expect(foldSearchText('ORD-2026-00042')).toBe('ord-2026-00042')
    expect(foldSearchText('  «Nappa» — nera / 1.2 mm ')).toBe('nappa nera 1.2 mm')
    expect(foldSearchText('Ærø Größe')).toBe('ærø große')
  })

  it("builds an entry's text from number, title, subtitle and words, each word once, in that order", () => {
    expect(searchTextOf({ number: 'ORD-2026-00042', title: 'Pista Racing S.r.l.', subtitle: 'Rif. PR-77', words: ['SEED-C1', null, 'Pista'] })).toBe('ord-2026-00042 pista racing s.r.l rif pr-77 seed-c1')
    expect(searchTextOf({ title: 'Giacca' })).toBe('giacca')
  })

  it('never holds an amount with its currency', () => {
    expect(() => searchTextOf({ title: 'Order', words: ['€ 1.200,00'] })).toThrow(SearchTextError)
    expect(() => searchTextOf({ title: 'Order', subtitle: '1200 EUR' })).toThrow(SearchTextError)
    // A number on its own is a code, not money.
    expect(searchTextOf({ title: 'Order', words: ['1200'] })).toBe('order 1200')
  })

  it('cuts a long text at a word', () => {
    const text = searchTextOf({ title: 'x', words: Array.from({ length: 600 }, (_, i) => `word${i}`) })
    expect(text.length).toBeLessThanOrEqual(SEARCH_LIMITS.maxText)
    expect(text.endsWith(' ')).toBe(false)
  })

  it('reads a query: folded words, each once, too short under two characters', () => {
    expect(queryWords('  Pista  RACING pista ')).toMatchObject({ text: 'pista racing', words: ['pista', 'racing'], tooShort: false, whole: 'Pista  RACING pista' })
    expect(queryWords('a')).toMatchObject({ text: '', words: [], tooShort: true })
    expect(queryWords('ab').tooShort).toBe(false)
    expect(queryWords('a b c d e f g h').words).toHaveLength(SEARCH_LIMITS.maxWords)
    expect(looksLikeNumber('FT-2026-00042')).toBe(true)
    expect(looksLikeNumber('pista')).toBe(false)
  })
})

describe('why it matched', () => {
  it('marks the words found inside the shown text, accents and case aside', () => {
    expect(matchedParts('Società Pista Racing', ['pista'])).toEqual([
      { text: 'Società ', hit: false },
      { text: 'Pista', hit: true },
      { text: ' Racing', hit: false },
    ])
    expect(matchedParts('Società', ['societa'])).toEqual([{ text: 'Società', hit: true }])
    expect(matchedParts('ORD-2026-00042', ['ord-2026', '42'])).toEqual([
      { text: 'ORD-2026', hit: true },
      { text: '-000', hit: false },
      { text: '42', hit: true },
    ])
    expect(matchedParts('', ['x'])).toEqual([])
  })

  it('tells a match by similarity (a typo) from one found as typed', () => {
    expect(hasExactHit(['Pista Racing', null], ['pista'])).toBe(true)
    expect(hasExactHit(['Pista Racing'], ['pisra'])).toBe(false)
  })
})

describe('the search catalogue entries', () => {
  it('declares search.rebuild (a write) for the owner and the administrator only among the templates', () => {
    expect(FACTORY_PERMISSIONS.get('search.rebuild')?.risk).toBe('write')
    expect(templateOf('owner')?.permissions).toContain('search.rebuild')
    expect(templateOf('admin')?.permissions).toContain('search.rebuild')
    for (const key of ['finance', 'sales', 'planner', 'buyer', 'warehouse', 'read_only']) expect(templateOf(key)?.permissions, key).not.toContain('search.rebuild')
  })

  it('declares search.rebuild_requested with record type names only', () => {
    expect(EVENT_CATALOGUE.parse('search.rebuild_requested', 1, { recordTypes: ['SalesOrder'], requestedById: null })).toEqual({ recordTypes: ['SalesOrder'], requestedById: null })
    expect(() => EVENT_CATALOGUE.parse('search.rebuild_requested', 1, { recordTypes: ['sales order'], requestedById: null })).toThrow()
  })

  it('reads the route query with its defaults and checks an answer', () => {
    expect(searchQuery.parse({ q: 'pista' })).toEqual({ q: 'pista', limit: SEARCH_LIMITS.page, offset: 0 })
    expect(searchQuery.safeParse({ q: 'x', limit: '500' }).success).toBe(false)
    expect(searchAnswer.safeParse({ query: '', words: [], tooShort: true, results: [], counts: [], total: 0, nextOffset: null, asOf: null }).success).toBe(true)
  })
})
