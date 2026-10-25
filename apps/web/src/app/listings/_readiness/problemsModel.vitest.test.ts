/** Listings — the Problems view's words (live layer step 7): tags, the chip, the count, the cap, the request. */
import { describe, expect, it } from 'vitest'
import type { ReadinessProblemRow } from '@nexus/shared/listing-readiness'
import {
  NO_PROBLEMS, cappedWords, excerpt, listingsUnit, problemChipText, problemFallbackText, problemTag, problemsCountWords, problemsParams, showProductsLabel,
} from './problemsModel'
import { EMPTY_READINESS_QUERY } from './readinessQuery'

const DE = { key: '["AMAZON","DE","a1",null]', channel: 'AMAZON', marketplace: 'DE', accountId: 'a1', aliasKey: '', label: 'Amazon DE' }
const row = (extra: Partial<ReadinessProblemRow>): ReadinessProblemRow => ({ id: `r:${DE.key}:size_chart`, source: 'readiness', label: 'Size chart', state: 'blocked',
  kind: 'required', field: 'size_chart', code: null, severity: null, message: 'Required and empty', destination: DE, products: 34, listings: 120, ...extra })

describe('the Problems view’s words', () => {
  it('a tag says the kind in the tone of what it stops; a channel message its severity; Ready-not-listed "Not listed"', () => {
    expect(problemTag(row({}))).toEqual({ text: 'Required', tone: 'danger' })
    expect(problemTag(row({ state: 'warn', kind: 'translation' }))).toEqual({ text: 'Translation', tone: 'warning' })
    expect(problemTag(row({ source: 'channel', state: null, kind: null, severity: 'error' }))).toEqual({ text: 'Error', tone: 'danger' })
    expect(problemTag(row({ source: 'channel', state: null, kind: null, severity: 'warning' }))).toEqual({ text: 'Warning', tone: 'warning' })
    expect(problemTag(row({ source: 'notListed', state: null, kind: null }))).toEqual({ text: 'Not listed', tone: 'info' })
  })

  it('the chip after Show products names the problem and where', () => {
    expect(problemChipText(row({}))).toBe('Size chart · Amazon DE')
    expect(problemChipText(row({ source: 'channel', code: '90220', message: "The value for 'size_name' is not allowed for this product type at all." })))
      .toBe('90220 “The value for \'size_name\' is not allowed for th…” · Amazon DE')
    expect(problemChipText(row({ source: 'notListed', label: 'Ready, not listed' }))).toBe('Ready, not listed · Amazon DE')
    expect(excerpt('  short\n text ')).toBe('short text')
  })

  it('a link’s problem before the list names it: what the id says', () => {
    expect(problemFallbackText(`r:${DE.key}:size_chart`)).toBe('size_chart · Amazon DE')
    expect(problemFallbackText(`c:${DE.key}:0123456789abcdef0123456789abcdef:90220`)).toBe('A message from Amazon · Amazon DE')
    expect(problemFallbackText('n:["EBAY","IT","e1",null]')).toBe('Ready, not listed · eBay IT')
    expect(problemFallbackText('x:[]')).toBeNull()
    expect(problemFallbackText('r:nonsense')).toBeNull()
  })

  it('counts, the cap, the empty words', () => {
    expect(problemsCountWords(null)).toEqual({ shown: '—', unit: 'problems' })
    expect(problemsCountWords({ rows: [row({})], total: 1 })).toEqual({ shown: '1', unit: 'problem' })
    const many = { rows: Array.from({ length: 500 }, () => row({})), total: 812 }
    expect(problemsCountWords(many)).toEqual({ shown: '500 of 812', unit: 'problems' })
    expect(cappedWords(many)).toBe('Showing the first 500 of 812 problems. Narrow the filters to see the rest.')
    expect(cappedWords({ rows: [row({})], total: 1 })).toBeNull()
    expect(NO_PROBLEMS).toBe('No problems in this view.')
  })

  it('the request takes the page’s filters, never its problem chip', () => {
    const q = { ...EMPTY_READINESS_QUERY, channel: 'AMAZON', state: 'blocked' as const, problem: `n:${DE.key}`, live: ['active' as const] }
    expect(Object.fromEntries(problemsParams(q))).toEqual({ channel: 'AMAZON', state: 'blocked', live: 'active' })
  })

  it('Show products and Listings say what they count', () => {
    expect(showProductsLabel(row({}))).toBe('Show the 34 products with Size chart · Amazon DE')
    expect(listingsUnit(row({ source: 'channel' }))).toBe('listings on the channel with this message')
  })
})
