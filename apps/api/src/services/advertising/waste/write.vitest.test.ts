/**
 * Negative Targeting page (2026-10-11, lane NWRITE) — the page's row → tool mapping, pure (waste/write.ts): row ids, the
 * verb each row takes, the MCP tool request it becomes, its from → to, the planHash. Made-up ids and terms.
 */
import { describe, expect, it } from 'vitest'
import { actionRefusal, countsWords, fromTo, parseRowId, planHashOf, requestFor, type TargetFacts, type WasteItem } from './write.js'
import { NO_HOLD } from './hold.js'

const kept = { keptPausedAt: new Date('2026-10-10T08:00:00Z'), keptPausedBy: 'user:u-1', keptPausedUntil: null, keptPausedReason: null }
const kw = (extra: Partial<TargetFacts> = {}): TargetFacts => ({ id: 't-1', text: 'made up jacket', status: 'ENABLED', isNegative: false, hold: NO_HOLD, ...extra })
const item = (action: WasteItem['action'], rowId = 'kw:t-1', extra: Partial<WasteItem> = {}): WasteItem => ({ rowId, action, ...extra })
const WHY = 'Negative Targeting page — test'

describe('parseRowId', () => {
  it('reads keyword, negative and search-term rows', () => {
    expect(parseRowId('kw:t-1')).toEqual({ kind: 'kw', targetId: 't-1' })
    expect(parseRowId('neg:n-1')).toEqual({ kind: 'neg', targetId: 'n-1' })
    expect(parseRowId('term:it|EXT-g-1|cheap%20jacket')).toEqual({ kind: 'term', market: 'IT', extAdGroupId: 'EXT-g-1', termKey: 'cheap%20jacket', text: 'cheap jacket' })
    expect(parseRowId('term:IT|EXT-g-1|a | b')).toMatchObject({ text: 'a | b' })
  })
  it('refuses what is not a row', () => {
    for (const bad of ['', 'kw:', 'x:1', 'term:IT|EXT', 'term:IT||x', 'kw:a b']) expect(parseRowId(bad)).toBeNull()
  })
})

describe('the verb a row takes', () => {
  it('our keyword is paused, never negated in its own ad group', () => {
    expect(actionRefusal(parseRowId('kw:t-1')!, item('NEGATE_EXACT'))).toMatchObject({ code: 'keyword_is_paused_not_negated' })
    expect(actionRefusal(parseRowId('kw:t-1')!, item('PAUSE'))).toBeNull()
  })
  it('a negative is only removed; a term only negated', () => {
    expect(actionRefusal(parseRowId('neg:n-1')!, item('PAUSE'))).toMatchObject({ code: 'wrong_verb' })
    expect(actionRefusal(parseRowId('term:IT|g|x')!, item('PAUSE'))).toMatchObject({ code: 'wrong_verb' })
  })
  it('an ASIN term is negated as a product, in its ad group only', () => {
    const asin = parseRowId('term:IT|g|b0abcdefgh')!
    expect(actionRefusal(asin, item('NEGATE_EXACT'))).toMatchObject({ code: 'asin_term' })
    expect(actionRefusal(asin, item('NEGATE_ASIN', 'x', { where: 'campaign' }))).toMatchObject({ code: 'asin_campaign_level' })
    expect(actionRefusal(asin, item('NEGATE_ASIN'))).toBeNull()
    expect(actionRefusal(parseRowId('term:IT|g|jacket')!, item('NEGATE_ASIN'))).toMatchObject({ code: 'not_an_asin' })
  })
})

describe('the MCP tool request each row becomes', () => {
  it('PAUSE: pause-ads, kept paused (always, or until a date)', () => {
    expect(requestFor(item('PAUSE'), parseRowId('kw:t-1')!, { target: kw() }, WHY)).toEqual({ tool: 'pause-ads', args: { targetIds: ['t-1'], keepPaused: true, why: WHY } })
    expect(requestFor(item('PAUSE', 'kw:t-1', { keepUntil: '2099-01-31' }), parseRowId('kw:t-1')!, { target: kw() }, WHY))
      .toEqual({ tool: 'pause-ads', args: { targetIds: ['t-1'], keepPaused: true, keepUntil: '2099-01-31T00:00:00.000Z', why: WHY } })
    expect(requestFor(item('PAUSE', 'kw:t-1', { keepUntil: '2001-01-01' }), parseRowId('kw:t-1')!, { target: kw() }, WHY)).toMatchObject({ refusal: { code: 'keep_until' } })
  })
  it('TURN_ON: enable-ads, releasing a hold only when one holds', () => {
    expect(requestFor(item('TURN_ON'), parseRowId('kw:t-1')!, { target: kw({ status: 'PAUSED' }) }, WHY))
      .toEqual({ tool: 'enable-ads', args: { targetIds: ['t-1'], includePeoplesPauses: true, why: WHY } })
    expect(requestFor(item('TURN_ON'), parseRowId('kw:t-1')!, { target: kw({ status: 'PAUSED', hold: kept }) }, WHY))
      .toEqual({ tool: 'enable-ads', args: { targetIds: ['t-1'], includePeoplesPauses: true, releaseKeepPaused: true, why: WHY } })
  })
  it('RELEASE: the hold ends — paused stays paused (pause-ads keepPaused false), on at Amazon runs as it is (enable-ads)', () => {
    expect(requestFor(item('RELEASE'), parseRowId('kw:t-1')!, { target: kw({ status: 'PAUSED', hold: kept }) }, WHY))
      .toEqual({ tool: 'pause-ads', args: { targetIds: ['t-1'], keepPaused: false, why: WHY } })
    expect(requestFor(item('RELEASE'), parseRowId('kw:t-1')!, { target: kw({ status: 'ENABLED', hold: kept }) }, WHY))
      .toEqual({ tool: 'enable-ads', args: { targetIds: ['t-1'], releaseKeepPaused: true, why: WHY } })
    expect(requestFor(item('RELEASE'), parseRowId('kw:t-1')!, { target: kw({ status: 'PAUSED' }) }, WHY)).toMatchObject({ refusal: { code: 'not_kept_paused' } })
  })
  it('REMOVE_NEGATIVE: retire-negatives', () => {
    expect(requestFor(item('REMOVE_NEGATIVE', 'neg:n-1'), parseRowId('neg:n-1')!, { target: kw({ id: 'n-1', isNegative: true }) }, WHY))
      .toEqual({ tool: 'retire-negatives', args: { negativeIds: ['n-1'], why: WHY } })
  })
  it('NEGATE: add-negative-targets in the ad group (default) or the campaign; an ASIN as a product target', () => {
    const term = parseRowId('term:IT|EXT-g-1|cheap jacket')!
    expect(requestFor(item('NEGATE_EXACT', 'x'), term, { adGroupId: 'g-1', campaignId: 'c-1' }, WHY))
      .toEqual({ tool: 'add-negative-targets', args: { negatives: [{ adGroupId: 'g-1', text: 'cheap jacket', matchType: 'NEGATIVE_EXACT' }], why: WHY } })
    expect(requestFor(item('NEGATE_PHRASE', 'x', { where: 'campaign' }), term, { adGroupId: 'g-1', campaignId: 'c-1' }, WHY))
      .toEqual({ tool: 'add-negative-targets', args: { negatives: [{ campaignId: 'c-1', text: 'cheap jacket', matchType: 'NEGATIVE_PHRASE' }], why: WHY } })
    expect(requestFor(item('NEGATE_ASIN', 'x'), parseRowId('term:IT|EXT-g-1|b0abcdefgh')!, { adGroupId: 'g-1', campaignId: 'c-1' }, WHY))
      .toEqual({ tool: 'add-negative-targets', args: { negatives: [{ adGroupId: 'g-1', asin: 'B0ABCDEFGH' }], why: WHY } })
    expect(requestFor(item('NEGATE_EXACT', 'x'), term, {}, WHY)).toMatchObject({ refusal: { code: 'place_not_found' } })
  })
})

describe('polish: KEEP_UNTIL, the negative over a keyword, a named ad group', () => {
  it('KEEP_UNTIL: pause-ads keepPaused with the new end (none = Always) on a paused keyword; from → to are the ends', () => {
    expect(actionRefusal(parseRowId('kw:t-1')!, item('KEEP_UNTIL'))).toBeNull()
    expect(requestFor(item('KEEP_UNTIL', 'kw:t-1', { keepUntil: '2099-01-31' }), parseRowId('kw:t-1')!, { target: kw({ status: 'PAUSED', hold: kept }) }, WHY))
      .toEqual({ tool: 'pause-ads', args: { targetIds: ['t-1'], keepPaused: true, keepUntil: '2099-01-31T00:00:00.000Z', why: WHY } })
    expect(requestFor(item('KEEP_UNTIL', 'kw:t-1', { keepUntil: null }), parseRowId('kw:t-1')!, { target: kw({ status: 'PAUSED', hold: kept }) }, WHY))
      .toEqual({ tool: 'pause-ads', args: { targetIds: ['t-1'], keepPaused: true, why: WHY } })
    expect(requestFor(item('KEEP_UNTIL'), parseRowId('kw:t-1')!, { target: kw() }, WHY)).toMatchObject({ refusal: { code: 'not_paused' } })
    expect(fromTo(item('KEEP_UNTIL', 'kw:t-1', { keepUntil: '2099-01-31' }), kw({ status: 'PAUSED', hold: kept }))).toEqual({ from: 'ALWAYS', to: '2099-01-31T00:00:00.000Z' })
    expect(fromTo(item('KEEP_UNTIL', 'kw:t-1', { keepUntil: null }), kw({ status: 'PAUSED' }))).toEqual({ from: null, to: 'ALWAYS' })
  })
  it('REMOVE_NEGATIVE from our keyword\'s row needs the negative over it', () => {
    expect(actionRefusal(parseRowId('kw:t-1')!, item('REMOVE_NEGATIVE'))).toMatchObject({ code: 'wrong_verb' })
    expect(actionRefusal(parseRowId('kw:t-1')!, item('REMOVE_NEGATIVE', 'kw:t-1', { targetRowId: 'neg:n-1' }))).toBeNull()
    expect(requestFor(item('REMOVE_NEGATIVE', 'kw:t-1', { targetRowId: 'neg:n-1' }), parseRowId('kw:t-1')!, { target: kw(), negative: kw({ id: 'n-1', isNegative: true }) }, WHY))
      .toEqual({ tool: 'retire-negatives', args: { negativeIds: ['n-1'], why: WHY } })
  })
  it('NEGATE_* in a named ad group: the term, or our keyword\'s text', () => {
    expect(actionRefusal(parseRowId('kw:t-1')!, item('NEGATE_EXACT', 'kw:t-1', { adGroupId: 'g-2' }))).toBeNull()
    expect(requestFor(item('NEGATE_EXACT', 'kw:t-1', { adGroupId: 'g-2' }), parseRowId('kw:t-1')!, { target: kw(), adGroupId: 'g-2' }, WHY))
      .toEqual({ tool: 'add-negative-targets', args: { negatives: [{ adGroupId: 'g-2', text: 'made up jacket', matchType: 'NEGATIVE_EXACT' }], why: WHY } })
    expect(actionRefusal(parseRowId('term:IT|g|b0abcdefgh')!, item('NEGATE_ASIN', 'x', { adGroupId: 'g-2' }))).toMatchObject({ code: 'wrong_verb' })
  })
})

describe('from → to, the plan hash, the title', () => {
  it('from → to per verb', () => {
    expect(fromTo(item('PAUSE'), kw())).toEqual({ from: 'RUNNING', to: 'KEPT_PAUSED' })
    expect(fromTo(item('TURN_ON'), kw({ status: 'PAUSED', hold: kept }))).toEqual({ from: 'KEPT_PAUSED', to: 'RUNNING' })
    expect(fromTo(item('RELEASE'), kw({ status: 'ENABLED', hold: kept }))).toEqual({ from: 'TURNED_ON_ELSEWHERE', to: 'RUNNING' })
    expect(fromTo(item('RELEASE'), kw({ status: 'PAUSED', hold: kept }))).toEqual({ from: 'KEPT_PAUSED', to: 'PAUSED' })
    expect(fromTo(item('NEGATE_EXACT', 'x'), undefined)).toEqual({ from: 'RUNNING', to: 'NEGATED' })
    expect(fromTo(item('REMOVE_NEGATIVE', 'neg:n'), kw({ isNegative: true }))).toEqual({ from: 'NEGATED', to: 'REMOVED' })
  })
  it('the plan hash moves with a row, a request, a basis or a refusal — never with key order', () => {
    const items = [item('PAUSE')]
    const steps = [{ request: { tool: 'pause-ads', args: { targetIds: ['t-1'], keepPaused: true } }, basis: 'b1', refusal: null }]
    const h = planHashOf(items, steps)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(planHashOf(items, [{ ...steps[0], request: { tool: 'pause-ads', args: { keepPaused: true, targetIds: ['t-1'] } } }])).toBe(h)
    expect(planHashOf(items, [{ ...steps[0], basis: 'b2' }])).not.toBe(h)
    expect(planHashOf([item('PAUSE', 'kw:t-1', { keepUntil: '2099-01-01' })], steps)).not.toBe(h)
    expect(planHashOf(items, [{ request: null, basis: null, refusal: { code: 'refused' } }])).not.toBe(h)
  })
  it('the plan title counts the verbs', () => {
    expect(countsWords(['PAUSE', 'PAUSE', 'NEGATE_EXACT'])).toBe('pause 2, negative exact 1')
  })
})
