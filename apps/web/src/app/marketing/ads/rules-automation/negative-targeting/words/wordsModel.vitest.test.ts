/**
 * Negative Targeting page, Words view (step 4) — the view's pure rules (words/wordsModel.ts): the address, the order, the
 * state words, Block word (held with the server's reason, the filter bar's lists sent with it), the bulk plan and its
 * left-outs, the Show choices, the empty table and the CSV. Made-up words.
 */
import { describe, expect, it } from 'vitest'
import { viewOf, VIEWS } from '../waste/wasteModel'
import {
  groupTerms, placesWords, placeWhy, productsWords, wordCsvRow, wordOfId, wordsBulkCounts, wordsBulkPlan, wordSearch, wordsEmpty, wordShowChips, wordShowOf,
  wordSortOf, wordSortParam, wordsSearch, wordStateSentence, wordStateWord, wordTabOf, wordVerb, WORD_CSV_HEADERS,
} from './wordsModel'
import type { WordRow } from './wordsTypes'

const row = (word: string, extra: Partial<WordRow> = {}): WordRow => ({
  id: `word:IT|${word}`, word, words: word.includes(' ') ? 2 : 1, market: 'IT', currency: 'EUR', terms: 6, sold: 0,
  d: { impressions: 1800, clicks: 90, orders: 0, spendCents: 3700, salesCents: 0, acosPct: null, cpcCents: 41, xCpa: null },
  places: { adGroups: 4, campaigns: 3, open: 1, blocked: 1 }, products: 2, product: null, state: 'PARTLY_BLOCKED',
  stateWhy: 'Wastes for TST-COAT: 4 terms in 3 ad groups, 0 orders; its other product does not waste (7 orders); a negative phrase blocks it in 1 of 4 ad groups.',
  wastesFor: { product: { id: 'p-1', name: 'TST-COAT' }, terms: 4, adGroups: 3, orders: 0, products: 1 },
  verb: { action: 'NEGATE_PHRASE', where: 'adGroup', held: null, places: 1 },
  test: { met: true, by: null, sentence: 'Wastes: 0 orders', windowDays: 60, clicksNeeded: 38, spendBarCents: 2400, xCpaBar: 1.5 },
  coveredBy: null, stockOutDays: 0, ...extra,
})

describe('the address', () => {
  it('?view=words is a view of the page; show and tab fall back to their defaults', () => {
    expect(VIEWS).toEqual(['wasting', 'stopped', 'words', 'rules'])
    expect(viewOf('words')).toBe('words')
    expect(wordShowOf('blocked')).toBe('blocked')
    expect(wordShowOf('kept')).toBe('wasting')
    expect(wordTabOf('where')).toBe('where')
    expect(wordTabOf('nope')).toBe('overview')
  })
  it('the reads\' query: market, the filter bar\'s lists, show, q, sort, page; one word\'s read takes the lists only', () => {
    expect(wordsSearch({ market: 'it', lists: { campaignIds: 'c-1,c-2' }, show: 'all', q: ' cheap ', sort: '-terms', page: 2, pageSize: 100 }))
      .toBe('?market=IT&campaignIds=c-1%2Cc-2&show=all&q=cheap&sort=-terms&page=2&pageSize=100')
    expect(wordsSearch({ market: 'all', show: 'wasting', q: '' })).toBe('')
    expect(wordSearch({ adGroupIds: 'g-1' })).toBe('?adGroupIds=g-1')
    expect(wordSearch(null)).toBe('')
    expect(wordOfId('word:IT|cheap coat')).toBe('cheap coat')
  })
  it('a header\'s sort is the server\'s key, and back', () => {
    expect(wordSortParam({ colId: 'terms', dir: 'desc' })).toBe('-terms')
    expect(wordSortParam({ colId: 'places', dir: 'asc' })).toBe('places')
    expect(wordSortParam({ colId: 'acos', dir: 'asc' })).toBeNull()
    expect(wordSortOf('-spend')).toEqual({ colId: 'spend', dir: 'desc' })
    expect(wordSortOf('xCpa')).toBeNull()
  })
})

describe('words on screen', () => {
  it('states and their sentences; places and products in words', () => {
    expect(wordStateWord('PARTLY_BLOCKED')).toBe('Partly blocked')
    // The mark says the server's one sentence: a word whose other product sold never reads "with no order".
    expect(wordStateSentence(row('cheap'))).toMatch(/^Wastes for TST-COAT: .*its other product does not waste \(7 orders\)/)
    expect(placesWords(row('cheap'))).toBe('4 ad groups · 3 campaigns')
    expect(placesWords(row('cheap', { places: { adGroups: 1, campaigns: 1, open: 1, blocked: 0 } }))).toBe('1 ad group')
    expect(productsWords(row('cheap'))).toBe('2 products')
    expect(productsWords(row('cheap', { product: { id: 'p', name: 'TST-COAT' }, products: 1 }))).toBe('TST-COAT')
  })
  it('a place says why: the negative that blocks it, or its held reason', () => {
    expect(placeWhy({ state: 'BLOCKED', held: null, blockedBy: { rowId: 'neg:n', text: 'cheap', level: 'CAMPAIGN' } })).toBe('The negative phrase "cheap" blocks it in the whole campaign')
    expect(placeWhy({ state: 'HELD', held: { label: 'New place', reason: 'The ad group is 5 days old' }, blockedBy: null })).toBe('The ad group is 5 days old')
    expect(placeWhy({ state: 'OPEN', held: null, blockedBy: null })).toBeNull()
  })
})

describe('the Terms tab', () => {
  const term = (text: string, adGroup: string, spendCents: number | undefined, extra: Record<string, unknown> = {}) => ({
    rowId: `term:IT|EXT-${adGroup}|${text}`, text, portfolio: null, campaign: { id: 'c', name: 'C' }, adGroup: { id: adGroup, name: adGroup },
    product: { id: 'p-1', name: 'TST-COAT' }, productCount: 1, d: { impressions: 0, clicks: 10, orders: 0, ...(spendCents == null ? {} : { spendCents }) }, sold: false, state: 'RUNNING' as const, ...extra,
  })
  it('one line per search term (as many as the row counts), its places under it, numbers summed, most spend first', () => {
    const g = groupTerms([term('cheap jacket', 'g-1', 900), term('cheap coat', 'g-1', 1200), term('Cheap  Jacket', 'g-2', 700, { sold: true, product: { id: 'p-2', name: 'B' } })])
    expect(g.map((x) => [x.text, x.places.length, x.d.spendCents, x.d.clicks, x.sold, x.products])).toEqual([['cheap jacket', 2, 1600, 20, true, 2], ['cheap coat', 1, 1200, 10, false, 1]])
    expect(g[0].product).toBeNull()
    expect(g[1].product).toMatchObject({ name: 'TST-COAT' })
  })
  it('money the server left out stays out of the sum', () => {
    expect(groupTerms([term('cheap coat', 'g-1', undefined), term('cheap coat', 'g-2', undefined)])[0].d).toEqual({ clicks: 20, orders: 0 })
  })
})

describe('Block word', () => {
  const held = { label: 'Protected', reason: '"rain" is a protected term: no negative and no pause may stop it.' }
  it('the blue fill only for a word that wastes and lands somewhere; held with the server\'s reason', () => {
    expect(wordVerb(row('cheap'))).toMatchObject({ label: 'Block word', held: null, primary: true, sentence: expect.stringMatching(/in 1 ad group/) })
    expect(wordVerb(row('rain', { state: 'PROTECTED', verb: { action: 'NEGATE_PHRASE', where: 'adGroup', held, places: 0 } }))).toMatchObject({ held: held.reason, primary: false })
    expect(wordVerb(row('sale', { state: 'NOT_WASTING', test: { ...row('x').test, met: false } }))).toMatchObject({ primary: false })
    // The whole campaign is the server's to judge per campaign: a word partly blocked in its ad groups may still land in one.
    const partly = row('cheap', { verb: { action: 'NEGATE_PHRASE', where: 'adGroup', held: { label: 'Our keyword', reason: 'Our keyword holds it' }, places: 0 } })
    expect(wordVerb(partly)).toMatchObject({ held: 'Our keyword holds it' })
    expect(wordVerb(partly, 'campaign')).toMatchObject({ label: 'Block word · whole campaign', held: null })
    expect(wordVerb(row('rain', { state: 'HELD', verb: { action: 'NEGATE_PHRASE', where: 'adGroup', held, places: 0 } }), 'campaign')).toMatchObject({ held: held.reason })
  })
  it('the bulk plan: one item per word with the filter bar\'s lists; a word it may not block is left out with why', () => {
    const picked = [
      row('cheap'),
      row('rain', { state: 'PROTECTED', verb: { action: 'NEGATE_PHRASE', where: 'adGroup', held, places: 0 } }),
      { id: 'word:IT|wool' },
    ]
    expect(wordsBulkPlan(picked, 'adGroup', { campaignIds: 'c-1' })).toEqual({
      items: [
        { rowId: 'word:IT|cheap', action: 'NEGATE_PHRASE', where: 'adGroup', scope: { campaignIds: 'c-1' } },
        { rowId: 'word:IT|wool', action: 'NEGATE_PHRASE', where: 'adGroup', scope: { campaignIds: 'c-1' } },
      ],
      left: [{ id: 'word:IT|rain', text: 'rain', why: held.reason }],
    })
    expect(wordsBulkPlan([row('cheap')], 'campaign', {}).items).toEqual([{ rowId: 'word:IT|cheap', action: 'NEGATE_PHRASE', where: 'campaign' }])
    expect(wordsBulkCounts(picked)).toEqual({ adGroup: 2, campaign: 2 })
  })
})

describe('the list', () => {
  it('Show choices with the read\'s counts; the empty table\'s words', () => {
    expect(wordShowChips({ wasting: 3, blocked: 1, held: 0, protected: 1, all: 9 }).map((c) => [c.id, c.count])).toEqual([['wasting', 3], ['blocked', 1], ['all', 9]])
    expect(wordShowChips(null)[0].count).toBeNull()
    expect(wordsEmpty('wasting', false)).toEqual({ title: 'No word wastes across search terms', clear: false })
    expect(wordsEmpty('blocked', false)).toEqual({ title: 'No word is blocked', clear: true })
    expect(wordsEmpty('wasting', true)).toEqual({ title: 'Nothing matches these filters', clear: true })
  })
  it('one CSV line per word, a dash for money the server left out', () => {
    expect(wordCsvRow(row('cheap'))).toHaveLength(WORD_CSV_HEADERS.length)
    expect(wordCsvRow(row('cheap'))).toEqual(['cheap', '6', '0', '€37.00', '90', '0', '4', '3', '2 products', 'Partly blocked', 'Block word'])
    // A held verb as the Wasting CSV writes one.
    expect(wordCsvRow(row('rain', { verb: { action: 'NEGATE_PHRASE', where: 'adGroup', held: { label: 'Protected', reason: 'Protected' }, places: 0 } })).at(-1)).toBe('Block word (held)')
    expect(wordCsvRow(row('cheap', { d: { impressions: 0, clicks: 90, orders: 0 } }))[3]).toBe('—')
  })
})
