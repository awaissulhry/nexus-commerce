/**
 * Negative Targeting page (NREAD) — the pure parts of the waste reads: the owner of a row (one, never contradicting the
 * last change), the verb per row (PLAN §2), the waste test (the bar, late-order safe, days out of stock left out), the
 * ids, the window and the tiles. Values are made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import { negativeKeptBy, negativeOwner, ownerOfActor, rowOwner, type OwnerNames } from './owner.js'
import {
  compareRows, dayIndex, isWasting, plainWords, romeDay, romeTime, showMatches, withAskCounts, keywordRowId, negativeBlocksTerm, outOfStockDays, parseRowId, sparkOf, targetMatch, termKeyOf,
  termRowId, totalsOf, wasteWindow, windowNumbers, type DayEvidence, type WasteRow,
} from './pure.js'
import { barFor, clicksNeededFor, wasteTest, xCpaOf } from './test.js'
import { verbFor } from './verb.js'

const NOW = new Date('2026-10-11T12:00:00Z')
const DAY = 86_400_000
const names: OwnerNames = { rules: new Map([['r-stop', 'Stop waste — terms']]), claudeChangeSets: new Set(['appr-claude']) }

describe('owner — one per row', () => {
  it('reads each writer the way the page names it', () => {
    expect(ownerOfActor('automation:ads-brain-negatives', names)).toEqual({ kind: 'BRAIN', name: 'Brain', id: 'brain' })
    expect(ownerOfActor('automation:ads-brain-harvest', names)).toEqual({ kind: 'HARVEST', name: 'Harvest', id: 'harvest' })
    expect(ownerOfActor('automation:auto-harvest', names)).toEqual({ kind: 'HARVEST', name: 'Harvest', id: 'harvest' })
    expect(ownerOfActor('automation:r-stop', names)).toEqual({ kind: 'RULE', name: 'Stop waste — terms', id: 'r-stop' })
    expect(ownerOfActor('automation:r-gone', names)).toEqual({ kind: 'NONE', name: 'Unknown', id: null })
    expect(ownerOfActor('user:u1', names)).toEqual({ kind: 'PERSON', name: 'You', id: 'u1' })
    expect(ownerOfActor('user:u1', names, 'appr-claude')).toEqual({ kind: 'CLAUDE', name: 'Claude', id: 'appr-claude' })
    expect(ownerOfActor(null, names)).toEqual({ kind: 'NONE', name: 'Unknown', id: null })
  })

  it('the hold wins, then what waits, then the writer of 7 days (Bid audit M2), the stopper, the brain, a rule, older writers', () => {
    const now = NOW.getTime()
    const person = { kind: 'PERSON' as const, name: 'You', id: 'u1' }
    const rule = { id: 'r-stop', name: 'Stop waste — terms' }
    expect(rowOwner({ hold: { by: 'user:u9' }, waitingBy: person, rule }, now, names)).toEqual({ kind: 'PERSON', name: 'You', id: 'u9' })
    expect(rowOwner({ waitingBy: { kind: 'BRAIN', name: 'Brain', id: 'brain' }, rule }, now, names).kind).toBe('BRAIN')
    // An ask is newer news than an older change; a change made after the ask is newer than the ask.
    const brain = { kind: 'BRAIN' as const, name: 'Brain', id: 'brain' }
    expect(rowOwner({ waitingBy: brain, waitingAt: now - DAY, lastWriter: { owner: person, at: now - 2 * DAY } }, now, names)).toEqual(brain)
    expect(rowOwner({ waitingBy: brain, waitingAt: now - 2 * DAY, lastWriter: { owner: person, at: now - DAY } }, now, names)).toEqual(person)
    // A person turned it on 3 days ago: the rule that would pause it is not the owner — the last writer is.
    expect(rowOwner({ lastWriter: { owner: person, at: now - 3 * DAY }, rule, brainCovers: true }, now, names)).toEqual(person)
    // 20 days ago: the rule that acts next owns it; past 30 days, nobody does.
    expect(rowOwner({ lastWriter: { owner: person, at: now - 20 * DAY }, rule }, now, names).kind).toBe('RULE')
    expect(rowOwner({ lastWriter: { owner: person, at: now - 20 * DAY } }, now, names)).toEqual(person)
    expect(rowOwner({ lastWriter: { owner: person, at: now - 40 * DAY } }, now, names)).toEqual({ kind: 'NONE', name: '—', id: null })
    expect(rowOwner({ pausedBy: person, brainCovers: true, rule }, now, names)).toEqual(person)
    expect(rowOwner({ brainCovers: true, rule }, now, names).kind).toBe('BRAIN')
  })

  it('a negative\'s author: the stored origin first, then a harvest source, the brain\'s log, the create record, else Unknown', () => {
    expect(negativeOwner({ origin: 'BRAIN_FUNNEL', harvestSource: true }, names)).toEqual({ kind: 'BRAIN', name: 'Brain funnel', id: 'brain' })
    expect(negativeOwner({ origin: 'RULE', create: { actor: 'automation:r-stop', executionId: null, evidence: null } }, names)).toEqual({ kind: 'RULE', name: 'Stop waste — terms', id: 'r-stop' })
    expect(negativeOwner({ harvestSource: true, brainReason: 'waste' }, names).kind).toBe('HARVEST')
    expect(negativeOwner({ brainReason: 'funnel' }, names).name).toBe('Brain funnel')
    expect(negativeOwner({ brainReason: 'isolation' }, names).name).toBe('Brain')
    expect(negativeOwner({ create: { actor: 'user:u1', executionId: 'x', evidence: { targetKey: 'playbook-sync:negative' } } }, names).name).toBe('Playbook')
    expect(negativeOwner({ create: { actor: 'user:u1', executionId: 'appr-claude', evidence: null } }, names).kind).toBe('CLAUDE')
    expect(negativeOwner({ create: null }, names)).toEqual({ kind: 'NONE', name: 'Unknown', id: null })
    expect(negativeKeptBy({ kind: 'HARVEST', name: 'Harvest', id: 'harvest' })).toMatch(/^Harvest keeps this negative/)
    expect(negativeKeptBy({ kind: 'BRAIN', name: 'Brain funnel', id: 'brain' })).toBe('The Brain keeps this negative.')
    expect(negativeKeptBy({ kind: 'BRAIN', name: 'Brain', id: 'brain' })).toBeNull()
  })
})

describe('verb — pause our keyword, negate a shopper\'s term (PLAN §2)', () => {
  it('our exact keyword is paused, never negated in its own place', () => {
    expect(verbFor({ kind: 'KEYWORD', match: 'EXACT', text: 'rain jacket' })).toEqual({ action: 'PAUSE', where: 'adGroup', held: null })
  })
  it('a broad keyword whose terms sell is held: its wasting terms get negatives instead', () => {
    const v = verbFor({ kind: 'KEYWORD', match: 'BROAD', text: 'rain jacket', termsSold: 2 })
    expect(v.action).toBe('PAUSE')
    expect(v.held?.label).toBe('Its terms sell')
  })
  it('a term: negative exact in its ad group; in the campaign when it served in 2+ ad groups; an ASIN: a negative product target', () => {
    expect(verbFor({ kind: 'TERM', match: 'BROAD', text: 'rain coat', adGroupsInCampaign: 1 })).toEqual({ action: 'NEGATE_EXACT', where: 'adGroup', held: null })
    expect(verbFor({ kind: 'TERM', match: 'AUTO', text: 'rain coat', adGroupsInCampaign: 2 }).where).toBe('campaign')
    expect(verbFor({ kind: 'TERM', match: 'AUTO', text: 'b0abcdefgh', isAsinTerm: true, adGroupsInCampaign: 3 })).toEqual({ action: 'NEGATE_ASIN', where: 'adGroup', held: null })
  })
  it('held, first that applies: protected, our own keyword here, harvested lately, a new place, a shared campaign', () => {
    expect(verbFor({ kind: 'TERM', match: 'BROAD', text: 'x', protectedBy: 'brand', ownKeywordHere: true }).held?.label).toBe('Protected')
    expect(verbFor({ kind: 'TERM', match: 'BROAD', text: 'x', ownKeywordHere: true, harvestedDaysAgo: 2 }).held?.label).toBe('Our keyword')
    expect(verbFor({ kind: 'TERM', match: 'BROAD', text: 'x', harvestedDaysAgo: 10, placeAgeDays: 3 }).held?.label).toBe('Harvested lately')
    expect(verbFor({ kind: 'TERM', match: 'BROAD', text: 'x', harvestedDaysAgo: 31, placeAgeDays: 3 }).held?.label).toBe('New place')
    expect(verbFor({ kind: 'KEYWORD', match: 'EXACT', text: 'x', placeAgeDays: 40, sharedCampaign: true }).held?.label).toBe('Shared campaign')
  })
})

describe('the waste test', () => {
  const facts = { cr: 0.1, targetCpaCents: 1000, targetSource: 'the account\'s default target ACoS' }
  it('the clicks: 3 ÷ CR at 95 %, never under 20', () => {
    expect(clicksNeededFor(0.1)).toBe(29)
    expect(clicksNeededFor(0.5)).toBe(20)
    expect(clicksNeededFor(null)).toBe(20)
  })
  it('a term needs 0 orders, the clicks and 1.5 target CPAs; a keyword 2 CPAs and no term under it sold', () => {
    const term = barFor('TERM', facts, 60)
    expect(term).toMatchObject({ source: 'default', by: null, clicksNeeded: 29, spendBarCents: 1500, xCpaBar: 1.5, maxOrders: 0 })
    expect(wasteTest('TERM', { clicks: 30, orders: 0, spendCents: 1500 }, term).met).toBe(true)
    expect(wasteTest('TERM', { clicks: 30, orders: 1, spendCents: 5000 }, term).met).toBe(false)
    expect(wasteTest('TERM', { clicks: 28, orders: 0, spendCents: 5000 }, term).sentence).toMatch(/1 more needed/)
    const kw = barFor('KEYWORD', facts, 60)
    expect(kw.spendBarCents).toBe(2000)
    expect(wasteTest('KEYWORD', { clicks: 40, orders: 0, spendCents: 2500 }, kw).met).toBe(true)
    expect(wasteTest('KEYWORD', { clicks: 40, orders: 0, spendCents: 2500 }, kw, { termsSold: 1 }).met).toBe(false)
  })
  it('no data is not 0 orders: never met', () => {
    const t = wasteTest('KEYWORD', null, barFor('KEYWORD', facts, 60))
    expect(t.met).toBe(false)
    expect(t.sentence).toMatch(/^No data/)
  })
  it('no target ACoS: a fixed bar, said in words; the sentence carries no money', () => {
    const bar = barFor('TERM', { cr: 0.05, targetCpaCents: null, targetSource: null }, 60)
    expect(bar.xCpaBar).toBeNull()
    expect(bar.basis).toMatch(/no target ACoS is set/)
    const t = wasteTest('TERM', { clicks: 80, orders: 0, spendCents: 9999 }, bar)
    expect(t.sentence).not.toMatch(/99/)
  })
  it('the ads strategy\'s negate group wins whole for a term; a keyword keeps the page\'s test', () => {
    const owner = { source: 'strategy' as const, by: { id: 'strategy', name: 'the ads strategy: IT' }, minClicks: 15, minSpendCents: 800, maxOrders: 0, windowDays: 30 }
    expect(barFor('TERM', facts, 60, owner)).toMatchObject({ source: 'strategy', clicksNeeded: 15, spendBarCents: 800, windowDays: 30 })
    expect(barFor('KEYWORD', facts, 60, owner).source).toBe('default')
  })
  it('spend as a multiple of the target CPA', () => {
    expect(xCpaOf(2500, 1000)).toBe(2.5)
    expect(xCpaOf(2500, null)).toBeNull()
  })
})

describe('the window — late-order safe, days out of stock left out', () => {
  const day = (daysAgo: number, e: Partial<DayEvidence>): DayEvidence => ({ day: dayIndex(NOW) - daysAgo, impressions: 0, clicks: 0, spendCents: 0, orders: 0, salesCents: 0, ...e })
  it('clicks and spend to 3 days ago, orders to today', () => {
    const w = wasteWindow(NOW, 60)
    expect(w.clicksThrough.toISOString().slice(0, 10)).toBe('2026-10-08')
    expect(w.ordersThrough.toISOString().slice(0, 10)).toBe('2026-10-11')
    expect(w.since.toISOString().slice(0, 10)).toBe('2026-08-10')
    const { n } = windowNumbers([day(10, { clicks: 20, spendCents: 900 }), day(1, { clicks: 5, spendCents: 300, orders: 1, salesCents: 4000 })], w)
    // The newest days' clicks are left out; their late order is kept: it can only save the row.
    expect(n).toMatchObject({ clicks: 20, spendCents: 900, orders: 1, salesCents: 4000 })
  })
  it('a day half the advertised products were out of stock leaves its clicks and spend out, never its orders', () => {
    const today = dayIndex(NOW)
    const oos = outOfStockDays(['p1', 'p2', 'p3'], [
      { productId: 'p1', startedAt: new Date(NOW.getTime() - 12 * DAY), endedAt: new Date(NOW.getTime() - 9 * DAY) },
      { productId: 'p2', startedAt: new Date(NOW.getTime() - 11 * DAY), endedAt: null },
    ], today - 60, today)
    expect(oos.has(today - 10)).toBe(true) // p1 and p2 out: 2 of 3
    expect(oos.has(today - 12)).toBe(false) // only p1: 1 of 3
    const w = wasteWindow(NOW, 60)
    const out = windowNumbers([day(10, { clicks: 30, spendCents: 2000, orders: 1, salesCents: 5000 }), day(20, { clicks: 5, spendCents: 100 })], w, oos)
    expect(out.n).toMatchObject({ clicks: 5, spendCents: 100, orders: 1 })
    // Two of three out on days 11, 10 and 9 ago only (p1 is back after day 9): 3 days left out.
    expect(out.stockOutDays).toBe(3)
  })
  it('spend per week, 8 weeks, oldest first', () => {
    const spark = sparkOf([day(0, { spendCents: 100 }), day(6, { spendCents: 50 }), day(7, { spendCents: 30 }), day(60, { spendCents: 999 })], NOW)
    expect(spark).toEqual([0, 0, 0, 0, 0, 0, 30, 150])
  })
})

describe('words for the Owner', () => {
  it('plainWords: no raw person or automation ids, no tool names, UTC in Rome', () => {
    expect(plainWords('Kept paused by a person (user:cmabc123) since 2026-10-04 22:42 UTC — use enable-ads with releaseKeepPaused'))
      .toBe('Kept paused by a person since 5 Oct 2026 00:42 — use Turn on with a release')
    expect(plainWords('refused for automation:r-1 at 2026-07-01T10:00:00.000Z')).toBe('refused for an automation at 1 Jul 2026 12:00')
    expect(plainWords('user:u1 skipped it')).toBe('a person skipped it')
    expect(plainWords(null)).toBeNull()
  })
  it('a day and a time in Rome', () => {
    expect(romeDay('2026-10-10T23:30:00Z')).toBe('11 Oct 2026')
    expect(romeTime('2026-01-10T23:30:00Z')).toBe('11 Jan 2026 00:30')
  })
})

describe('ids, terms, matches', () => {
  it('a term row id names the market, Amazon\'s ad group id and the words; a | in the words survives', () => {
    expect(parseRowId(termRowId('IT', 'EXT-1', 'rain | coat'))).toEqual({ kind: 'term', market: 'IT', externalAdGroupId: 'EXT-1', termKey: 'rain | coat' })
    expect(parseRowId(keywordRowId('t1'))).toEqual({ kind: 'kw', targetId: 't1' })
    expect(parseRowId('neg:n1')).toEqual({ kind: 'neg', targetId: 'n1' })
    expect(parseRowId('term:IT|only')).toBeNull()
    expect(parseRowId('x')).toBeNull()
  })
  it('six spellings of a match type are one; auto groups and product targets are targets', () => {
    expect(targetMatch('KEYWORD', '_EXACT')).toEqual({ rowKind: 'KEYWORD', match: 'EXACT' })
    expect(targetMatch('AUTO', 'SEARCH_LOOSE_MATCH')).toEqual({ rowKind: 'TARGET', match: 'AUTO' })
    expect(targetMatch('PRODUCT', 'PRODUCT_EXACT')).toEqual({ rowKind: 'TARGET', match: 'ASIN' })
    expect(targetMatch('AUDIENCE', 'UNKNOWN')).toBeNull()
  })
  it('a phrase negative blocks its words in order; an exact one the same words', () => {
    expect(negativeBlocksTerm(termKeyOf('Cheap  Rain Jacket'), { text: 'rain jacket', match: 'PHRASE' })).toBe(true)
    expect(negativeBlocksTerm('jacket rain', { text: 'rain jacket', match: 'PHRASE' })).toBe(false)
    expect(negativeBlocksTerm('rain jacket', { text: 'Rain Jacket', match: 'EXACT' })).toBe(true)
    expect(termKeyOf('B0ABCDEFGH')).toBe('b0abcdefgh')
  })
})

describe('tiles and rows come from one set (Bid audit M1)', () => {
  const row = (id: string, e: Partial<WasteRow>): WasteRow => ({
    id, kind: 'TERM', text: id, match: 'BROAD', channel: 'AMAZON', market: 'IT', currency: 'EUR', portfolio: null,
    campaign: { id: 'c', name: 'c' }, adGroup: { id: 'g', name: 'g' }, product: null, productCount: 1, via: null, state: 'RUNNING',
    owner: { kind: 'NONE', name: '—', id: null }, verb: { action: 'NEGATE_EXACT', where: 'adGroup', held: null },
    test: { met: true, by: null, sentence: '', windowDays: 60, clicksNeeded: 20, spendBarCents: 100, xCpaBar: 1.5 },
    d: { impressions: 0, clicks: 30, orders: 0, spendCents: 500, salesCents: 0, acosPct: null, cpcCents: 17, xCpa: 2 },
    d90: null, spark: [], stockOutDays: 0, waiting: null, skipped: null, stillServesIn: 0, lastChange: null, clash: null, ...e,
  })
  it('each tile counts what its own filter answers', () => {
    const rows = [
      row('a', {}), row('b', { kind: 'KEYWORD' }), row('c', { state: 'NEGATED' }), row('d', { test: { ...row('x', {}).test, met: false } }),
      row('e', { skipped: { until: 'z', by: null, at: null } }), row('f', { waiting: { approvalId: 'p', by: { id: 'brain', name: 'Brain' }, at: 'z', expiresAt: null } }),
      row('g', { state: 'KEPT_PAUSED', kind: 'KEYWORD' }), row('h', { state: 'PROTECTED' }),
      row('i', { state: 'TURNED_ON_ELSEWHERE', kind: 'KEYWORD', clash: { kind: 'TURNED_ON', label: 'Turned on outside Nexus' } }),
    ]
    const t = totalsOf(rows, 'wasting', { negated: 4 })
    expect(t).toEqual({ wasting: 4, wastingSpendCents: 2000, currency: 'EUR', wastingSpendByCurrency: { EUR: 2000 }, wastingSpendNote: null, keywords: 1, terms: 3, waiting: 1, keptPaused: 1, turnedOn: 1, negated: 4, clashes: 1, skipped: 1 })
    expect(rows.filter((r) => showMatches(r, 'clashes')).length).toBe(t.clashes)
    expect(rows.filter(isWasting).length).toBe(t.wasting)
  })
  it('money is never added across currencies: several → null, the split per currency and why', () => {
    const t = totalsOf([row('a', {}), row('b', { currency: 'GBP', d: { ...row('x', {}).d!, spendCents: 700 } })], 'wasting', { negated: 0 })
    expect(t).toMatchObject({ wasting: 2, wastingSpendCents: null, currency: null, wastingSpendByCurrency: { EUR: 500, GBP: 700 } })
    expect(t.wastingSpendNote).toMatch(/2 currencies \(EUR, GBP\)/)
  })

  it('waiting counts asks, not rows; each row says how many places its ask covers', () => {
    const ask = (id: string) => ({ approvalId: id, by: { id: 'r', name: 'Rule' }, at: 'z', expiresAt: null, rows: 1 })
    const rows = withAskCounts([row('a', { waiting: ask('card-1') }), row('b', { waiting: ask('card-1') }), row('c', { waiting: ask('appr-2') }), row('d', {})])
    expect(totalsOf(rows, 'all', { negated: 0 }).waiting).toBe(2)
    expect(rows.map((r) => r.waiting?.rows ?? null)).toEqual([2, 2, 1, null])
  })

  it('a wasting term bought by a wasting keyword is inside its spend: the money is counted once', () => {
    const kw = row('kw:k1', { kind: 'KEYWORD', d: { ...row('x', {}).d!, spendCents: 500 } })
    const term = row('t1', { via: { id: 'k1', name: 'k1' }, d: { ...row('x', {}).d!, spendCents: 300 } })
    const other = row('t2', { via: { id: 'k9', name: 'k9' }, d: { ...row('x', {}).d!, spendCents: 200 } })
    expect(totalsOf([kw, term, other], 'wasting', { negated: 0 })).toMatchObject({ wasting: 3, wastingSpendCents: 700 })
  })

  it('orders by spend by default, by place and words otherwise, stably', () => {
    const rows = [row('a', { d: { ...row('x', {}).d!, spendCents: 10 } }), row('b', { d: { ...row('x', {}).d!, spendCents: 30 } })]
    expect([...rows].sort(compareRows('-spend')).map((r) => r.id)).toEqual(['b', 'a'])
    expect([...rows].sort(compareRows('text')).map((r) => r.id)).toEqual(['a', 'b'])
  })
})
