/**
 * Negative Targeting page, Words view (step 4) — the view's pure rules (words/wordsModel.ts): the address, the order, the
 * state words, Block word (held with the server's reason, the filter bar's lists sent with it), the bulk plan and its
 * left-outs, the Show choices, the empty table and the CSV. Made-up words.
 */
import { describe, expect, it } from 'vitest'
import { viewOf, VIEWS } from '../waste/wasteModel'
import {
  blockPlanView, blockWordWords, productChecks, termsCardWords, wordBanner, wordMetrics, wordPill, wordPlacePill, wordSubtitle, wordTestWords, wordWhereWords,
  groupTerms, placesWords, placeWhy, productsWords, wordCsvRow, wordOfId, wordsBulkCounts, wordsBulkPlan, wordSearch, wordsEmpty, wordShowChips, wordShowOf,
  wordSortOf, wordSortParam, wordsSearch, wordStateSentence, wordStateWord, wordTabOf, wordVerb, WORD_CSV_HEADERS,
  wordShowOptions, wordsCount, wordStateChip, wordStateSub,
} from './wordsModel'
import type { WordPlace, WordProduct, WordRow } from './wordsTypes'

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

describe('the record (RECORD-SPEC)', () => {
  const ref = (id: string, name = id) => ({ id, name })
  const product = (id: string, met: boolean, spendCents: number, orders: number, extra: Partial<WordProduct> = {}): WordProduct => ({
    product: ref(id), productCount: 1, terms: 4, places: 2, d: { impressions: 0, clicks: 40, orders, spendCents },
    test: { met, by: null, sentence: '', windowDays: 60, clicksNeeded: 41, spendBarCents: 2256, xCpaBar: 1.5 }, ...extra,
  })
  const place = (state: WordPlace['state'], extra: Partial<WordPlace> = {}): WordPlace => ({
    level: 'AD_GROUP', portfolio: null, campaign: ref('c1', 'Winter jacket'), adGroup: ref('g1', 'Broad — coats'), product: null, productCount: 1,
    campaignId: 'c1', adGroupId: 'g1', terms: 3, d: { impressions: 0, clicks: 30, orders: 0, spendCents: 1420 }, state, held: null, blockedBy: null, ...extra,
  })
  const cheap = row('cheap', {
    terms: 13, sold: 1, products: 3, places: { adGroups: 7, campaigns: 5, open: 3, blocked: 0 }, state: 'WASTING', stateWhy: 'Wastes for WJ-500-L.',
    d: { impressions: 0, clicks: 668, orders: 7, spendCents: 29590, cpcCents: 44 },
    wastesFor: { product: ref('wj', 'WJ-500-L'), terms: 8, adGroups: 4, orders: 0, products: 1 }, verb: { action: 'NEGATE_PHRASE', where: 'adGroup', held: null, places: 3 },
  })
  const products = [product('wj', true, 4350, 0, { product: ref('wj', 'WJ-500-L'), terms: 8, places: 4 }), product('tj', false, 16000, 0), product('rg', false, 9240, 7)]

  it('the header: what it is and how far it reaches; the state pill', () => {
    expect(wordSubtitle(cheap)).toBe('Word in 13 search terms · 7 ad groups · 5 campaigns')
    expect(wordPill(cheap)).toMatchObject({ word: 'Wasting', tone: 'danger', sentence: 'Wastes for WJ-500-L' })
  })

  it('the banner: for which product it wastes, and that Block word stops it only there', () => {
    expect(wordBanner(cheap, products)).toEqual({
      tone: 'danger', title: 'For WJ-500-L it spent €43.50 in 8 search terms and sold nothing',
      desc: 'That is 1 of its 3 products. The other 2 products do not waste (7 orders), so Block word stops it only for WJ-500-L.',
    })
    expect(wordBanner(row('rain', { state: 'BLOCKED', stateWhy: 'A negative phrase blocks it everywhere.', places: { adGroups: 2, campaigns: 1, open: 0, blocked: 2 } }), null))
      .toMatchObject({ tone: 'success', title: 'A negative phrase blocks it everywhere' })
  })

  it('the tiles, each product on its own, the About test', () => {
    expect(wordMetrics(cheap).map((m) => [m.label, m.value, m.hint])).toEqual([['Spend', '€295.90', 'last 60 days'], ['Clicks', '668', '€0.44 a click'], ['Orders', '7', 'up to today'], ['Search terms', '13', '1 sold']])
    const c = productChecks(cheap, products)
    expect(c.desc).toBe('1 of 3 wastes in the last 60 days, each judged by its own limit')
    expect(c.rows[0]).toMatchObject({ spend: '€43.50', terms: 8, adGroups: 4, limit: '41 clicks · €22.56', result: { tone: 'danger', word: 'Wastes' } })
    expect(c.rows[1].result.word).toBe('Not wasting')
    expect(wordTestWords(cheap.test)).toEqual({ value: 'This page\'s default', hint: 'Each product by its own limit. Spend: 1.5 × its target cost per order.' })
  })

  it('what Block word does: where it lands and what it blocks there; where it is left out and why', () => {
    const v = blockPlanView(cheap, [
      place('OPEN'), place('OPEN', { adGroupId: 'g2', terms: 2, d: { impressions: 0, clicks: 1, orders: 0, spendCents: 1280 } }),
      place('HELD', { adGroupId: 'g3', held: { label: 'Too young', reason: 'The ad group is 9 days old: nothing is stopped in a place younger than 14 days.' } }),
    ])
    expect(v.desc).toBe('It adds a negative phrase "cheap" in 2 ad groups, one change each. Together it blocks 5 search terms · €27.00 · 0 orders.')
    expect(v.rows.map((r) => [r.block, r.why])).toEqual([
      ['Negative phrase', 'Blocks 3 terms · €14.20 · 0 orders'],
      ['Negative phrase', 'Blocks 2 terms · €12.80 · 0 orders'],
      ['Left out', 'The ad group is 9 days old: nothing is stopped in a place younger than 14 days.'],
    ])
  })

  it('the footer\'s primary says what it does; the code\'s words when it is held', () => {
    expect(blockWordWords(cheap).label).toBe('Block \u201ccheap\u201d in 3 ad groups')
    expect(blockWordWords(row('rain', { verb: { action: 'NEGATE_PHRASE', where: 'adGroup', held: { label: 'Protected', reason: 'Protected' }, places: 0 } })).label).toBe('Block word')
  })

  it('the Search terms and Where it runs lines', () => {
    expect(termsCardWords(cheap)).toBe('1 sold · together €295.90 · 668 clicks · 7 orders')
    expect(wordWhereWords(cheap).spends).toBe('7 ad groups in 5 campaigns · it wastes in 3 of them')
    expect(wordPlacePill('OPEN')).toEqual({ word: 'Wasting', tone: 'danger' })
    expect(wordPlacePill('HELD')).toEqual({ word: 'Held', tone: 'neutral' })
  })
})

describe('the list (the redesign, 2026-10-26)', () => {
  it('Show for the page\'s filter bar carries the read\'s counts, none while unread; the toolbar counts words', () => {
    expect(wordShowOptions({ wasting: 5, blocked: 12, held: 0, protected: 2, all: 149 })).toEqual([
      { value: 'wasting', label: 'Wasting', count: 5 }, { value: 'blocked', label: 'Blocked', count: 12 }, { value: 'all', label: 'All', count: 149 },
    ])
    expect(wordShowOptions(null)).toEqual([{ value: 'wasting', label: 'Wasting' }, { value: 'blocked', label: 'Blocked' }, { value: 'all', label: 'All' }])
    expect(wordsCount(5)).toEqual([{ n: '5', words: ' words' }])
    expect(wordsCount(1)).toEqual([{ n: '1', words: ' word' }])
  })

  it('the state is one chip with a word and a tone (D6); the server\'s sentence is its hover', () => {
    expect(wordStateChip(row('cheap', { state: 'WASTING' }))).toMatchObject({ word: 'Wasting', tone: 'danger', mark: 'play' })
    expect(wordStateChip(row('jacket', { state: 'PROTECTED' }))).toMatchObject({ word: 'Protected', tone: 'success', mark: 'shield' })
    expect(wordStateChip(row('free'))).toEqual({ word: 'Partly blocked', tone: 'warning', mark: 'ban', title: row('free').stateWhy })
    expect(wordStateChip(row('x', { state: 'BLOCKED' }))).toMatchObject({ word: 'Blocked', tone: 'info', mark: 'ban' })
    expect(wordStateChip(row('x', { state: 'HELD' }))).toMatchObject({ word: 'Held', tone: 'neutral', mark: 'clock' })
    expect(wordStateChip(row('x', { state: 'NOT_WASTING' }))).toMatchObject({ word: 'Not wasting', tone: 'neutral', mark: 'play' })
  })

  it('a 2-word piece says which word covers it, under the chip', () => {
    expect(wordStateSub(row('cheap jacket', { coveredBy: 'cheap' }))).toEqual({ word: 'Covered by "cheap"', title: 'Covered by "cheap": blocking that word blocks this one' })
    expect(wordStateSub(row('cheap'))).toBeNull()
  })
})
