/**
 * The records' words and rules (recordModel.ts): the header, the banner per state, the tiles, the page's test as three
 * checks, what Approve does, did the stop work and its sum, the history sentences, and the review's final words.
 */
import { describe, expect, it } from 'vitest'
import {
  addedByWords, approveView, historyStep, keepUntilWords, kindLead, lastChangeWords, lookedAfter, negativeWords, orderLimitOf, otherNegativeWords,
  ownerWords, placePill, ranResult, recordNoun, savingSum, sparkWords, statePill, stillSpendsPlaces, stoppedBanner, stoppedMetrics, verbPhrase,
  verbStops, wasteBanner, wasteChecks, wasteMetrics, whereWords,
} from './recordModel'
import type { HistoryItem, Place, StoppedRow, WasteRow } from './wasteTypes'

const ref = (id: string, name = id) => ({ id, name, href: `/x/${id}` })
const DEFAULT_SENTENCE = 'Wastes: 0 orders, 400 clicks of 72, spend past the bar in 60 days. Bar: 0 orders, 72 clicks or more (at the product\'s pooled 4.10 % conversion, never under 20), spend 1.5 × the target cost per order (the account\'s default target ACoS).'

function term(over: Partial<WasteRow> = {}): WasteRow {
  return {
    id: 'term:IT|AG1|cheap jacket', kind: 'TERM', text: 'cheap jacket', match: 'AUTO', channel: 'AMAZON', market: 'IT', currency: 'EUR',
    portfolio: ref('pf1', 'Jackets'), campaign: ref('c1', 'Touring jacket | IT | Auto'), adGroup: ref('g1', 'Auto group'), product: ref('p1', 'TJ-200-GRY'), productCount: 1,
    via: ref('v1', 'Loose match'), state: 'RUNNING', owner: { kind: 'BRAIN', name: 'Brain', id: 'brain' }, verb: { action: 'NEGATE_EXACT', where: 'adGroup', held: null },
    test: { met: true, by: null, sentence: DEFAULT_SENTENCE, windowDays: 60, clicksNeeded: 72, spendBarCents: 2973, xCpaBar: 1.5 },
    d: { impressions: 9000, clicks: 400, orders: 0, spendCents: 16000, salesCents: 0, acosPct: null, cpcCents: 40, xCpa: 8.1 },
    d90: { clicks: 520, orders: 0, spendCents: 21400 }, spark: [1420, 1420, 1600, 1720, 1840, 1900, 1960, 2180], stockOutDays: 0, waiting: null, skipped: null,
    stillServesIn: 0, lastChange: null, ...over,
  }
}

function stopped(over: Partial<StoppedRow> = {}): StoppedRow {
  return {
    id: 'kw:k8', kind: 'KEYWORD', text: 'trail boot leather', match: 'EXACT', level: null, market: 'IT', currency: 'EUR', portfolio: null,
    campaign: ref('c8', 'Trail boots | IT | Exact'), adGroup: ref('g8', 'Exact group'), product: ref('p8', 'TB-400-42'), owner: { kind: 'PERSON', name: 'You', id: 'u1' },
    since: '2026-10-05T09:00:00.000Z', sinceSource: 'hold', keptPaused: { by: ref('u1', 'You'), at: '2026-10-05T09:00:00.000Z', until: '2026-11-04', reason: null },
    spendBeforeCents: 400, state: 'KEPT_PAUSED', stillServesIn: 1, places: 1,
    actions: { turnOn: { allowed: true, why: '' }, removeNegative: { allowed: false, why: 'Not a negative' }, release: { allowed: true, why: '' } },
    effect: { since: '2026-10-05T09:00:00.000Z', days: 21, verdict: 'STILL_SPENDS', beforePerDayCents: 13, afterCents: 0, savedCents: 240, words: 'Stopped here, but its words still spend in 1 other ad group' },
    ...over,
  }
}

const place = (over: Partial<Place> = {}): Place => ({
  portfolio: null, campaign: ref('c9', 'Trail boots | IT | Broad'), adGroup: ref('g9', 'Broad group'), match: 'BROAD', state: 'RUNNING',
  owner: { kind: 'NONE', name: '—', id: null }, d: { impressions: 10, clicks: 8, orders: 0, spendCents: 310 }, rowId: 'term:IT|g9|trail boot leather', ...over,
})

const item = (over: Partial<HistoryItem> = {}): HistoryItem => ({
  at: '2026-10-02T11:48:00.000Z', action: 'removed', text: 'cheap jacket', kind: 'TERM', rowId: 'neg:n1', campaign: ref('c1'), adGroup: ref('g1'), product: null,
  by: { id: 'u1', name: 'You' }, why: null, changeId: 'l1', changeSetId: null, delivery: 'LIVE', undo: { available: false, why: 'Amazon archives a removed negative: it cannot come back.' },
  ...over,
})

describe('the header tag reads as a sentence', () => {
  it('"A person" (no name known) is lower case inside it', () => {
    expect(lookedAfter({ kind: 'PERSON', name: 'A person', id: null } as never)?.label).toBe('Looked after by a person')
  })
})

describe('the header', () => {
  it('names what the record is, in plain words', () => {
    expect(kindLead(term())).toBe('Shopper\'s search term')
    expect(kindLead(term({ match: 'ASIN', text: 'b0c1234567' }))).toBe('Product a shopper viewed')
    expect(kindLead(stopped())).toBe('Your keyword')
    expect(kindLead({ id: 'kw:t1', kind: 'TARGET', text: 'B0C1', match: 'ASIN' })).toBe('Your product target')
    expect(kindLead({ id: 'neg:n1', kind: 'TERM', text: 'free' })).toBe('Negative')
    expect(recordNoun(term())).toBe('term')
    expect(recordNoun(stopped())).toBe('keyword')
  })

  it('draws the state pill in the state\'s tone, its sentence for a screen reader', () => {
    expect(statePill(term())).toMatchObject({ word: 'Wasting', tone: 'danger', sentence: 'it runs and spends' })
    expect(statePill(term({ test: { ...term().test, met: false } }))).toMatchObject({ word: 'Running', tone: 'neutral' })
    expect(statePill(term({ d: null }))).toMatchObject({ word: 'No data', tone: 'neutral' })
    expect(statePill(term({ state: 'PROTECTED', protection: { terms: [{ id: 'p1', term: 'waterproof', match: 'CONTAINS', market: 'IT', campaign: null, reason: null }, { id: 'p2', term: 'waterproof jacket', match: 'EXACT', market: 'IT', campaign: null, reason: null }], then: null } })))
      .toMatchObject({ word: 'Protected', tone: 'info', sentence: '2 protected terms keep it safe' })
    const waiting = statePill(term({ waiting: { approvalId: 'a1', by: ref('brain', 'Brain'), at: new Date().toISOString(), expiresAt: null } }))
    expect(waiting).toMatchObject({ word: 'Waiting · asked by Brain', tone: 'warning' })
    expect(statePill(stopped())).toMatchObject({ word: 'Kept paused', tone: 'info', sentence: 'no rule, Brain or plan turns it on' })
  })

  it('says who looks after it, and nothing when nobody does', () => {
    expect(lookedAfter({ kind: 'BRAIN', name: 'Brain', id: 'brain' })).toMatchObject({ label: 'Looked after by Brain' })
    expect(lookedAfter({ kind: 'RULE', name: 'Old auto negatives', id: 'r1' })).toMatchObject({ label: 'Looked after by the rule "Old auto negatives"', ruleId: 'r1' })
    expect(lookedAfter({ kind: 'PERSON', name: 'You', id: 'u1' })?.label).toBe('Looked after by You')
    expect(lookedAfter({ kind: 'NONE', name: '—', id: null })).toBeNull()
    expect(ownerWords({ kind: 'NONE', name: '—', id: null })).toBe('Nobody')
  })
})

describe('the verbs in words', () => {
  it('says what the primary does, and the menu items say the whole thing', () => {
    expect(verbPhrase('NEGATE_EXACT', 'adGroup', 'Auto group')).toEqual({ label: 'Add negative exact', sentence: 'Add a negative exact in Auto group' })
    expect(verbPhrase('NEGATE_PHRASE', 'campaign', 'Auto group').label).toBe('Add negative phrase · whole campaign')
    expect(verbPhrase('PAUSE', null, null, 'Pause again').label).toBe('Pause again')
    expect(otherNegativeWords('NEGATE_PHRASE', 'adGroup', 'Auto group')).toBe('Negative phrase · in Auto group')
    expect(otherNegativeWords('NEGATE_EXACT', 'campaign', 'Auto group')).toBe('Negative exact · in the whole campaign')
    expect(verbStops('NEGATE_EXACT', 'adGroup', 'Auto group')).toBe('A negative exact in Auto group stops it there.')
    expect(keepUntilWords(7, Date.parse('2026-10-26T10:00:00Z'))).toBe('Keep paused 7 days, to 2 Nov')
    expect(keepUntilWords(null)).toBe('Keep paused always')
  })
})

describe('the banner', () => {
  it('a wasting term: the main number, the cost against target, what the main button does', () => {
    expect(wasteBanner(term(), { action: 'NEGATE_EXACT', where: 'adGroup', held: null })).toEqual({
      tone: 'danger', title: 'It spent €160.00 in 60 days and sold nothing',
      desc: 'That is 8.1 × your target cost per order. A negative exact in Auto group stops it there.',
    })
  })

  it('a held verb says it is held, and why', () => {
    expect(wasteBanner(term(), { action: 'NEGATE_EXACT', where: 'adGroup', held: 'Harvest keeps it' }).desc).toContain('Add negative exact is held: Harvest keeps it.')
  })

  it('a protected term: info, what the test says, and that the protection goes first', () => {
    const b = wasteBanner(term({
      state: 'PROTECTED', d: { impressions: 1, clicks: 198, orders: 0, spendCents: 7700 },
      protection: { terms: [{ id: 'p1', term: 'waterproof', match: 'CONTAINS', market: 'IT', campaign: null, reason: null }, { id: 'p2', term: 'waterproof jacket', match: 'EXACT', market: 'IT', campaign: null, reason: null }], then: null },
    }))
    expect(b.tone).toBe('info')
    expect(b.title).toBe('Protected: Nexus never blocks or pauses this term')
    expect(b.desc).toBe('By the page\'s test it would count as wasting: €77.00 in 60 days, 198 clicks, 0 orders. 2 protected terms keep it safe, so to stop it the protection goes first.')
  })

  it('a waiting ask: what is asked, where (the ask\'s own words, HONEST 10), and what one answer covers (HONEST 11)', () => {
    const b = wasteBanner(term({ text: 'rain cover', verb: { action: 'NEGATE_PHRASE', where: 'adGroup', held: null }, waiting: { approvalId: 'a1', by: ref('brain', 'Brain'), at: new Date(Date.now() - 2 * 3_600_000).toISOString(), expiresAt: new Date(Date.now() + 6 * 86_400_000 + 60_000).toISOString(), rows: 2, changes: 1, action: 'NEGATE_PHRASE', match: 'PHRASE', level: 'CAMPAIGN', text: 'rain cover' } }))
    expect(b.tone).toBe('warning')
    expect(b.title).toBe('Brain asks to add a negative phrase "rain cover" in the whole campaign')
    expect(b.desc).toBe('It waits for your answer: asked 2 h ago, it expires in 6 d. One negative in the whole campaign: it covers this term in both ad groups listed.')
  })

  it('no data is never "not wasting"', () => {
    expect(wasteBanner(term({ d: null }))).toMatchObject({ tone: 'info', title: 'No data in 60 days' })
  })

  it('a term under the limit says which check is not true yet', () => {
    const b = wasteBanner(term({ test: { ...term().test, met: false }, d: { impressions: 1, clicks: 46, orders: 0, spendCents: 1840 } }))
    expect(b).toEqual({ tone: 'info', title: 'Not wasting by this page\'s test', desc: 'In 60 days the clicks are still under the limit and the spend is still under the limit, so it does not count as wasting yet.' })
  })
})

describe('the tiles', () => {
  it('Spend · Clicks · Orders · Cost against target, with plain lines and a bad value marked', () => {
    expect(wasteMetrics(term())).toEqual([
      { id: 'spend', label: 'Spend', value: '€160.00', hint: '60 days' },
      { id: 'clicks', label: 'Clicks', value: '400', hint: '€0.40 a click' },
      { id: 'orders', label: 'Orders', value: '0', hint: 'up to today' },
      { id: 'xcpa', label: 'Cost against target', value: '8.1×', hint: 'the limit is 1.5×', tone: 'bad' },
    ])
  })

  it('a dash says why: no target set, or no ad-spend permission', () => {
    expect(wasteMetrics(term({ d: { ...term().d!, xCpa: null } }))[3]).toMatchObject({ value: '—', hint: 'no target cost per order set' })
    expect(wasteMetrics(term({ d: { impressions: 1, clicks: 400, orders: 0 } }))[0]).toMatchObject({ value: '—', hint: 'You cannot see ad spend' })
  })

  it('an ask over two rows (an older answer: not which kind) says how far one answer reaches, never "places"', () => {
    expect(wasteMetrics(term({ waiting: { approvalId: 'a1', by: ref('brain', 'Brain'), at: '2026-10-26T07:00:00Z', expiresAt: null, rows: 2 } }))[3]).toEqual({ id: 'places', label: 'Rows', value: '2', hint: 'one answer for both' })
  })
})

describe('the page\'s test as three checks', () => {
  it('every check, its limit and its result; the verdict; where the limits come from', () => {
    const c = wasteChecks(term())!
    expect(c.title).toBe('Why it counts as wasting')
    expect(c.verdict).toBe('All 3 checks are true in 60 days')
    expect(c.column).toBe('This term')
    expect(c.rows.map((r) => [r.check, r.value, r.limit, r.result.word])).toEqual([
      ['Orders', '0', '0 orders', 'No orders'],
      ['Clicks', '400', '72 clicks or more', 'Past the limit'],
      ['Spend', '€160.00', '€29.73 or more', 'Past the limit'],
    ])
    expect(c.note).toBe('The limits come from this page\'s default test. 0 orders in 72 clicks: it very likely converts below the product\'s 4.10 % (95 % sure). €29.73 is 1.5 × the target cost per order.')
  })

  it('a fixed limit, a rule\'s limits, a check under the limit', () => {
    const fixed = wasteChecks(term({
      test: { met: false, by: null, windowDays: 60, clicksNeeded: 86, spendBarCents: 1500, xCpaBar: null, sentence: 'Not wasting: 0 orders, 46 clicks of 86 — 40 more needed, spend past the bar in 60 days. Bar: 0 orders, 86 clicks or more (at the product\'s pooled 3.43 % conversion, never under 20), spend past a fixed bar: no target ACoS is set for this product anywhere.' },
      d: { impressions: 1, clicks: 46, orders: 0, spendCents: 1840 }, product: ref('p2', 'RJ-100-BLK'),
    }))!
    expect(fixed.title).toBe('This page\'s test')
    expect(fixed.verdict).toBe('2 of 3 checks are true: not wasting yet')
    expect(fixed.rows[1].result).toEqual({ tone: 'neutral', word: 'Under the limit' })
    expect(fixed.note).toContain('€15.00 is a fixed limit, as there is no target cost per order for RJ-100-BLK.')
    const rule = wasteChecks(term({ test: { ...term().test, by: { id: 'r1', name: 'Stop waste — IT' }, sentence: 'Wastes: … Bar: the rule "Stop waste — IT": 30 clicks or more, spend at its minimum, at most 1 order, 60 days.' }, d: { ...term().d!, orders: 1 } }))!
    expect(rule.note.startsWith('The limits come from the rule "Stop waste — IT".')).toBe(true)
    expect(rule.rows[0]).toMatchObject({ limit: '1 order', result: { word: 'Within the limit' } })
    expect(orderLimitOf({ sentence: 'at most 2 orders' })).toBe(2)
  })

  it('a waiting ask: the asker\'s own test, not the page\'s', () => {
    const c = wasteChecks(term({ test: { ...term().test, met: false }, d: { impressions: 1, clicks: 46, orders: 0, spendCents: 4000 }, waiting: { approvalId: 'a1', by: ref('brain', 'Brain'), at: '2026-10-26T07:00:00Z', expiresAt: null } }))!
    expect(c.verdict).toBe('2 of 3 checks are true: not wasting by this page\'s test')
    expect(c.note.startsWith('Brain asked by its own test, not by this page\'s: here the clicks are still under the limit. ')).toBe(true)
  })

  it('no ad-spend permission: the spend check is not shown, never guessed', () => {
    const c = wasteChecks(term({ d: { impressions: 1, clicks: 400, orders: 0 }, test: { ...term().test, spendBarCents: undefined } }))!
    expect(c.rows[2]).toMatchObject({ value: '—', limit: '—', holds: null, result: { word: 'Not shown' } })
  })

  it('no numbers: no checks', () => {
    expect(wasteChecks(term({ d: null }))).toBeNull()
  })
})

describe('what Approve does', () => {
  it('the change, now and after, and what Approve and Reject do', () => {
    const a = approveView(term({ text: 'rain cover', verb: { action: 'NEGATE_PHRASE', where: 'adGroup', held: null }, waiting: { approvalId: 'a1', by: ref('brain', 'Brain'), at: '2026-10-26T07:00:00Z', expiresAt: null, rows: 2 } }))!
    expect(a.desc).toBe('It adds the negative phrase "rain cover" in Auto group, so the term stops there')
    expect([a.change, a.now, a.after, a.reach]).toEqual(['Negative phrase · rain cover', 'Running', 'Blocked', 'One answer decides both rows it is on.'])
    expect(a.foot).toContain('Reject sends nothing, and the request does not come back.')
    expect(approveView(term({ waiting: { approvalId: 'suggestion:s1', by: ref('r1', 'Stop waste'), at: '2026-10-26T07:00:00Z', expiresAt: null } }))!.foot).toContain('its Undo brings it back to waiting')
    expect(approveView(term())).toBeNull()
  })
})

describe('a stop: did it work?', () => {
  const others = stillSpendsPlaces(stopped(), [place(), place({ rowId: 'kw:k8' }), place({ rowId: 'term:x', state: 'NEGATED' })])

  it('the places where its words still spend', () => {
    expect(others.map((p) => p.rowId)).toEqual(['term:IT|g9|trail boot leather'])
  })

  it('amber when it saved here but its words still spend elsewhere, with where and the fix', () => {
    expect(stoppedBanner(stopped(), others)).toEqual({
      tone: 'warning', title: 'It saved €2.40 so far, but its words spent in 1 other ad group since the stop',
      desc: 'Before the stop it cost €0.13 a day here, and €0.00 since. In Broad group the same words spent €3.10 with 0 orders. A negative exact there stops the rest; its button is on the Where it runs tab.',
    })
  })

  it('green when it saved; info too early; info when not known', () => {
    expect(stoppedBanner(stopped({ stillServesIn: 0, effect: { ...stopped().effect!, verdict: 'SAVED' } }))).toMatchObject({ tone: 'success', title: 'It saved €2.40 so far' })
    expect(stoppedBanner(stopped({ effect: { since: '2026-10-20', days: 6, verdict: 'TOO_EARLY', words: 'Stopped 6 days ago, checked from 14 days' } }))).toEqual({ tone: 'info', title: 'Too early to tell', desc: 'Stopped 6 days ago, checked from 14 days.' })
    expect(stoppedBanner(stopped({ effect: null }))).toMatchObject({ tone: 'info', title: 'Not known yet whether it worked' })
    expect(stoppedBanner(stopped({ state: 'TURNED_ON_ELSEWHERE' })).tone).toBe('danger')
  })

  it('the tiles: saved, a day before, since, stopped since', () => {
    const m = stoppedMetrics(stopped())
    expect(m.map((x) => [x.label, x.value])).toEqual([['Saved so far', '€2.40'], ['Before the stop', '€0.13'], ['After the stop', '€0.00'], ['Stopped since', '5 Oct']])
    expect(m[0]).toMatchObject({ hint: 'in this ad group', tone: 'warn' })
    // Too early to count a saving: the tile still says what it spent in the 30 days before the stop (never "not known").
    const early = stoppedMetrics(stopped({ effect: { since: '2026-10-17', days: 9, verdict: 'TOO_EARLY', words: 'Stopped 9 days ago, checked from 14 days' } }))
    expect(early[1]).toMatchObject({ value: '€4.00', hint: 'in the 30 days before the stop' })
    expect(stoppedMetrics(stopped({ effect: null, spendBeforeCents: null }))[1]).toMatchObject({ value: '—', hint: 'not known yet' })
  })

  it('how the saving is counted: the server\'s numbers in their sum; none before there is a saving', () => {
    const sum = savingSum(stopped())!
    expect(sum.rows.map((r) => [r.part, r.value])).toEqual([['A day before the stop', '€0.13'], ['Spent since the stop', '€0.00'], ['Saved', '€2.40']])
    expect(sum.rows[2].how).toBe('€0.13 a day × the days since − €0.00')
    expect(sum.note).toContain('It counts this ad group only. Its words spent elsewhere since the stop, so the answer is amber, not green.')
    expect(savingSum(stopped({ effect: { since: '2026-10-20', days: 6, verdict: 'TOO_EARLY', words: 'x' } }))).toBeNull()
  })
})

describe('the spend per week', () => {
  it('says the trend in words and this week\'s spend', () => {
    expect(sparkWords(term().spark!, 'EUR')).toEqual({ desc: 'Last 8 weeks · up from €14.20 to €21.80', thisWeek: '€21.80' })
    expect(sparkWords([500, 500], 'EUR')?.desc).toBe('Last 2 weeks · flat at €5.00')
    // The same first and last week, but a change between them: never "flat".
    expect(sparkWords([0, 1200, 2500, 0], 'EUR')?.desc).toBe('Last 4 weeks · between €0.00 and €25.00')
    expect(sparkWords([], 'EUR')).toBeNull()
  })
})

describe('History: one sentence per change', () => {
  it('who did what; the why or the result under it; a reason that matters', () => {
    expect(historyStep(item())).toMatchObject({ label: 'You removed its negative', tone: 'info', undo: false, detail: 'Amazon archives a removed negative: it cannot come back.' })
    expect(historyStep(item({ action: 'negated', by: { id: 'brain', name: 'Brain' }, undo: { available: true, why: 'Undo removes the negative it made (final at Amazon).' } })))
      .toMatchObject({ label: 'Brain added a negative', tone: 'success', undo: true, detail: null, undoLabel: 'Undo: brain added a negative' })
    expect(historyStep(item({ action: 'refused', by: { id: 'brain', name: 'Brain' }, delivery: 'REFUSED', why: 'The Brain\'s daily limit of new negatives was reached', undo: { available: false, why: 'Nothing changed at Amazon: there is nothing to undo.' } })))
      .toMatchObject({ label: 'Brain could not add a negative', tone: 'danger', detail: 'The Brain\'s daily limit of new negatives was reached. Nothing changed at Amazon: there is nothing to undo.' })
  })

  it('a skip: until when in the sentence, how it ended under it', () => {
    expect(historyStep(item({ action: 'skipped', why: 'Skipped until 26 Oct; unskipped 21 Oct, 09:30 by You.', undo: { available: false, why: 'Already undone.' } })))
      .toMatchObject({ label: 'You skipped it until 26 Oct', tone: 'neutral', detail: 'Unskipped 21 Oct, 09:30 by You.' })
    expect(historyStep(item({ action: 'skipped', by: { id: 'c', name: 'Claude' }, why: 'Skipped until 9 Sep: it has ended.' })).label).toBe('Claude skipped it until 9 Sep')
  })

  it('a turn-on kept paused reads as such; an unknown actor is "Someone"', () => {
    expect(historyStep(item({ action: 'refused', kind: 'KEYWORD', by: { id: 'unknown', name: 'Unknown' }, why: 'Kept paused — not turned on', delivery: 'REFUSED', undo: { available: false, why: 'Nothing changed at Amazon: there is nothing to undo.' } }))).toMatchObject({ label: 'Someone could not turn it on', detail: 'Nothing changed at Amazon: there is nothing to undo.' })
  })

  it('a delivery that did not land is said', () => {
    expect(historyStep(item({ action: 'paused', kind: 'KEYWORD', delivery: 'FAILED', undo: { available: false, why: 'It never landed (failed): there is nothing to put back.' } }))).toMatchObject({ tone: 'danger', detail: 'It did not go through. It never landed (failed): there is nothing to put back.' })
  })

  it('the About card\'s last change', () => {
    expect(lastChangeWords({ action: 'removed', at: '2026-10-02T11:48:00Z', by: { name: 'You' } }, 'TERM', Date.parse('2026-10-25T12:00:00Z'))).toEqual({ value: 'You removed its negative', hint: '2 Oct · 23 d ago' })
    expect(lastChangeWords(null, 'TERM')).toBeNull()
  })
})

describe('Where it runs', () => {
  it('this record reads Wasting; other places their own state, Running neutral', () => {
    expect(placePill({ state: 'RUNNING', rowId: term().id }, term())).toEqual({ word: 'Wasting', tone: 'danger' })
    expect(placePill({ state: 'RUNNING', rowId: 'term:other' }, term())).toEqual({ word: 'Running', tone: 'neutral' })
    expect(placePill({ state: 'KEPT_PAUSED', rowId: null }, stopped())).toEqual({ word: 'Kept paused', tone: 'info' })
    expect(negativeWords('EXACT')).toBe('Negative exact')
    expect(addedByWords({ kind: 'BRAIN', name: 'Brain', id: 'brain' })).toBe('Brain')
    expect(addedByWords({ kind: 'RULE', name: 'Old auto negatives', id: 'r1' })).toBe('Old auto negatives')
    expect(whereWords(term()).intro).toBe('Where this search term spends, and where a negative already blocks it. Numbers in 60 days.')
    expect(whereWords(stopped()).intro).toBe('Where the words of this keyword still spend, and where a negative blocks them.')
  })
})

describe('the review, once a removal\'s 20 s window ended', () => {
  it('the rows say it is final: Archived at Amazon (counted "archived"), never "Sending" any more', () => {
    const removal = { action: 'REMOVE_NEGATIVE' as const, final: true, lands: 'amazon' as const, refusal: null }
    expect(ranResult(removal, { ok: true, words: 'Archiving at Amazon', verb: 'sending' })).toEqual({ ok: true, words: 'Archived at Amazon', verb: 'archived' })
    expect(ranResult({ action: 'PAUSE', lands: 'amazon', refusal: null }, { ok: true, words: 'Sending', verb: 'sending' })).toEqual({ ok: true, words: 'Sent', verb: 'sent' })
  })

  it('a Nexus-only, left-out or stopped result stays as it is', () => {
    const saved = { ok: true, words: 'Saved in Nexus', verb: 'saved' }
    expect(ranResult({ action: 'REMOVE_NEGATIVE', lands: 'nexus', refusal: null }, saved)).toBe(saved)
    const left = { ok: false, words: 'Left out: x', verb: 'sent' }
    expect(ranResult({ action: 'REMOVE_NEGATIVE', lands: 'amazon', refusal: { code: 'x', label: 'x' } }, left)).toBe(left)
    expect(ranResult({ action: 'REMOVE_NEGATIVE', lands: 'amazon', refusal: null }, undefined)).toBeUndefined()
  })
})
