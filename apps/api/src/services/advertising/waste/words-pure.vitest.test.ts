/**
 * Negative Targeting page, Words view (step 4) — the pure part (waste/words-pure.ts): which words a search term holds
 * (contiguous, never paired across a stop word), the word's id, its state from its places, the row's held verb, the
 * order, the filters and the totals. Made-up words.
 */
import { describe, expect, it } from 'vitest'
import {
  compareWords, coveredByOf, oneProduct, parseWordId, sumNumbers, termHoldsWord, wordHeld, wordRowId, wordShowMatches, wordsOfTerm,
  wordStateOf, wordTotalsOf, type WordListRow,
} from './words-pure.js'

describe('wordsOfTerm — 1 or 2 words next to each other', () => {
  it('pairs only neighbours: "jacket for rain" never yields "jacket rain" (the n-gram service\'s over-count)', () => {
    expect(wordsOfTerm('Cheap  Jacket for Rain').sort()).toEqual(['cheap', 'cheap jacket', 'jacket', 'rain'].sort())
    expect(wordsOfTerm('jacket for rain')).not.toContain('jacket rain')
    // The stop word is never a word alone nor at an edge of one.
    expect(wordsOfTerm('jacket for rain')).not.toContain('for')
    expect(wordsOfTerm('jacket for rain')).not.toContain('jacket for')
  })
  it('no number, size, ASIN or 1-letter piece; every piece once', () => {
    expect(wordsOfTerm('jacket xxl 2024 b0abcdefgh')).toEqual(['jacket'])
    expect(wordsOfTerm('jacket jacket')).toEqual(['jacket', 'jacket jacket'])
    expect(wordsOfTerm('')).toEqual([])
  })
  it('a term holds a word as a run of whole words, in order', () => {
    expect(termHoldsWord('cheap rain jacket', 'rain jacket')).toBe(true)
    expect(termHoldsWord('rain cheap jacket', 'rain jacket')).toBe(false)
    expect(termHoldsWord('cheaper jacket', 'cheap')).toBe(false)
  })
})

describe('word ids', () => {
  it('word:<market>|<word>, normalised; back to its parts', () => {
    expect(wordRowId('IT', ' Cheap  Jacket ')).toBe('word:IT|cheap jacket')
    expect(parseWordId('word:it|cheap jacket')).toEqual({ market: 'IT', word: 'cheap jacket' })
    expect(parseWordId('word:IT|cheap%20jacket')).toEqual({ market: 'IT', word: 'cheap jacket' })
    for (const bad of ['', 'word:', 'word:IT|', 'word:|x', 'term:IT|g|x']) expect(parseWordId(bad)).toBeNull()
  })
})

const place = (state: 'OPEN' | 'BLOCKED' | 'HELD' | 'NOT_WASTING', label?: string) => ({ state, held: label ? { label, reason: `${label} — why` } : null })

describe('the word\'s state from its places', () => {
  it('blocked everywhere · partly · wasting · held · protected · not wasting', () => {
    expect(wordStateOf([place('BLOCKED'), place('BLOCKED')], true)).toBe('BLOCKED')
    expect(wordStateOf([place('BLOCKED'), place('OPEN')], true)).toBe('PARTLY_BLOCKED')
    expect(wordStateOf([place('OPEN'), place('HELD', 'Our keyword')], true)).toBe('WASTING')
    expect(wordStateOf([place('HELD', 'Our keyword'), place('HELD', 'New place')], true)).toBe('HELD')
    expect(wordStateOf([place('HELD', 'Protected'), place('BLOCKED')], true)).toBe('PROTECTED')
    expect(wordStateOf([place('NOT_WASTING', 'Not wasting')], false)).toBe('NOT_WASTING')
    expect(wordStateOf([place('BLOCKED'), place('HELD', 'Sold here')], true)).toBe('PARTLY_BLOCKED')
    expect(wordStateOf([], true)).toBe('HELD')
  })
  it('the row\'s verb is held only when no place is open, with the first reason that applies', () => {
    const test = { met: true, sentence: 'Wastes: …' }
    expect(wordHeld([place('OPEN'), place('HELD', 'Our keyword')], test)).toBeNull()
    expect(wordHeld([place('BLOCKED')], test)).toMatchObject({ label: 'Blocked' })
    expect(wordHeld([place('BLOCKED'), place('HELD', 'Sold here')], test)).toMatchObject({ label: 'Sold here' })
    expect(wordHeld([place('NOT_WASTING', 'Not wasting')], { met: false, sentence: 'Not wasting: 3 clicks of 20' })).toEqual({ label: 'Not wasting', reason: 'Not wasting: 3 clicks of 20' })
  })
})

describe('numbers, list, order', () => {
  it('sums its terms\' numbers; ACoS and CPC from the sums', () => {
    expect(sumNumbers([{ impressions: 10, clicks: 4, orders: 0, spendCents: 200, salesCents: 0 }, null, { impressions: 5, clicks: 1, orders: 1, spendCents: 100, salesCents: 1000 }]))
      .toEqual({ impressions: 15, clicks: 5, orders: 1, spendCents: 300, salesCents: 1000, acosPct: 30, cpcCents: 60 })
  })
  const row = (word: string, extra: Partial<WordListRow> = {}): WordListRow => ({
    id: wordRowId('IT', word), word, terms: 3, state: 'WASTING', coveredBy: null, d: { clicks: 30, orders: 0, spendCents: 1000 },
    places: { adGroups: 2, campaigns: 1, blocked: extra.state === 'BLOCKED' || extra.state === 'PARTLY_BLOCKED' ? 1 : 0 }, products: 1, test: { met: true }, ...extra,
  })
  it('Wasting leaves out what is blocked everywhere, not wasting, or covered by its own word; Blocked lists the blocked; totals count each show', () => {
    const rows = [
      row('cheap'), row('cheap jacket', { coveredBy: 'cheap' }), row('rain', { state: 'BLOCKED' }), row('sun', { state: 'PARTLY_BLOCKED' }),
      row('snow', { state: 'NOT_WASTING', test: { met: false } }), row('ice', { state: 'HELD' }), row('wind', { state: 'PROTECTED' }),
      // Blocked somewhere, but not wasting: listed under Blocked.
      row('hail', { state: 'NOT_WASTING', test: { met: false }, places: { adGroups: 3, campaigns: 1, blocked: 2 } }),
    ]
    expect(rows.filter((r) => wordShowMatches(r, 'wasting')).map((r) => r.word)).toEqual(['cheap', 'sun', 'ice', 'wind'])
    expect(rows.filter((r) => wordShowMatches(r, 'blocked')).map((r) => r.word)).toEqual(['rain', 'sun', 'hail'])
    expect(wordTotalsOf(rows)).toEqual({ wasting: 4, blocked: 3, held: 1, protected: 1, all: 8 })
  })
  it('orders by spend (default), terms, places, the word, with the word breaking ties', () => {
    const rows = [row('b', { d: { clicks: 1, orders: 0, spendCents: 500 }, terms: 9 }), row('a', { d: { clicks: 1, orders: 0, spendCents: 900 }, terms: 2 }), row('c', { d: { clicks: 1, orders: 0, spendCents: 500 }, terms: 5 })]
    expect([...rows].sort(compareWords(null)).map((r) => r.word)).toEqual(['a', 'b', 'c'])
    expect([...rows].sort(compareWords('-terms')).map((r) => r.word)).toEqual(['b', 'c', 'a'])
    expect([...rows].sort(compareWords('word')).map((r) => r.word)).toEqual(['a', 'b', 'c'])
  })
  it('a 2-word piece is covered by a wasting word of its own; the one product of its places', () => {
    expect(coveredByOf('cheap jacket', new Set(['cheap']))).toBe('cheap')
    expect(coveredByOf('cheap jacket', new Set(['rain']))).toBeNull()
    expect(coveredByOf('cheap', new Set(['cheap']))).toBeNull()
    const p = { id: 'p-1', name: 'MADE-UP' }
    expect(oneProduct([p, p])).toBe(p)
    expect(oneProduct([p, null])).toBeNull()
    expect(oneProduct([p, { id: 'p-2', name: 'X' }])).toBeNull()
  })
})
