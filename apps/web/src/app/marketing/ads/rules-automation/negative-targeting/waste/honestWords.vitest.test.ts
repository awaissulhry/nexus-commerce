/**
 * Negative Targeting page — HONEST items 13, 14, 16, 18, 19 (2026-10-27) on the web: every sentence says exactly what
 * the data counts — the negative that really blocks a term, "Did it work?" when it spends more, what the clicks limit
 * means, the real window ("60 days to 24 Oct"), what a removal Amazon never had does, a person by their own name.
 * Values are made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import { approveView, blockedNote, inWindow, placeWindowNote, stoppedBanner, wasteBanner, wasteChecks, wasteMetrics, whereWords } from './recordModel'
import { chipOwner, isFinal, landsWord, NEXUS_ONLY_REMOVAL, stateChip, stateSentence, stoppedVerb, tilesOf } from './wasteModel'
import type { Place, StoppedRow, WasteRow, WasteTotals } from './wasteTypes'

const ref = (id: string, name = id) => ({ id, name, href: `/x/${id}` })
const SENTENCE = 'Wastes: 0 orders, 400 clicks of 72, spend past the bar in 60 days. Bar: 0 orders, 72 clicks or more (at the product\'s pooled 4.10 % conversion, never under 20), spend 1.5 × the target cost per order (the account\'s default target ACoS).'

function term(over: Partial<WasteRow> = {}): WasteRow {
  return {
    id: 'term:IT|AG1|made up jacket', kind: 'TERM', text: 'made up jacket', match: 'EXACT', channel: 'AMAZON', market: 'IT', currency: 'EUR',
    portfolio: null, campaign: ref('c1', 'Test campaign'), adGroup: ref('g1', 'Test group'), product: ref('p1', 'TST-1'), productCount: 1,
    via: ref('v1', 'made up'), state: 'RUNNING', owner: { kind: 'BRAIN', name: 'Brain', id: 'brain' }, verb: { action: 'NEGATE_EXACT', where: 'adGroup', held: null },
    test: { met: true, by: null, sentence: SENTENCE, windowDays: 60, clicksNeeded: 72, spendBarCents: 2973, xCpaBar: 1.5, settledThrough: '2026-10-24' },
    d: { impressions: 9000, clicks: 400, orders: 0, spendCents: 16000, salesCents: 0, acosPct: null, cpcCents: 40, xCpa: 8.1 },
    d90: null, spark: [], stockOutDays: 0, waiting: null, skipped: null, stillServesIn: 0, lastChange: null, ...over,
  }
}

function stopped(over: Partial<StoppedRow> = {}): StoppedRow {
  return {
    id: 'neg:n1', kind: 'TERM', text: 'made up boots', match: 'EXACT', level: 'AD_GROUP', market: 'IT', currency: 'EUR', portfolio: null,
    campaign: ref('c8'), adGroup: ref('g8', 'Exact group'), product: null, owner: { kind: 'PERSON', name: 'Test person one', id: 'u1' },
    since: '2026-09-17T09:00:00.000Z', sinceSource: 'record', keptPaused: null, spendBeforeCents: 9000, state: 'NEGATED', stillServesIn: 0, places: 1,
    actions: { turnOn: { allowed: false, why: '' }, removeNegative: { allowed: true, why: '' }, release: { allowed: false, why: '' } },
    effect: { since: '2026-09-17T09:00:00.000Z', days: 40, verdict: 'SAVED', beforePerDayCents: 300, afterCents: 11400, savedCents: -300, words: 'Spends more here in the 37 days since the stop than before it' },
    ...over,
  }
}

const place = (over: Partial<Place> = {}): Place => ({
  portfolio: null, campaign: ref('c9'), adGroup: ref('g9', 'Broad group'), match: 'BROAD', state: 'RUNNING', owner: { kind: 'NONE', name: '—', id: null },
  d: { impressions: 10, clicks: 8, orders: 0, spendCents: 310 }, windowDays: 60, rowId: 'term:IT|g9|made up boots', ...over,
})

describe('HONEST 13 — a blocked term names the negative that blocks it', () => {
  it('its own match, words and level — never the match of the keyword that bought the term', () => {
    const blocked = term({ state: 'NEGATED', match: 'EXACT', blockedBy: { rowId: 'neg:n2', text: 'made up', match: 'PHRASE', level: 'CAMPAIGN', campaign: ref('c1'), adGroup: null, owner: { kind: 'BRAIN', name: 'Brain', id: 'brain' } } })
    expect(stateSentence(blocked)).toBe('Negative phrase "made up" in the whole campaign')
    expect(stateChip(blocked).title).toBe('Negative phrase "made up" in the whole campaign')
    expect(wasteBanner(blocked).title).toBe('Negative phrase "made up" in the whole campaign')
    // The same words: they are not repeated.
    expect(stateSentence(term({ state: 'NEGATED', blockedBy: { rowId: 'neg:n3', text: 'Made up  jacket', match: 'EXACT', level: 'AD_GROUP', campaign: ref('c1'), adGroup: ref('g1'), owner: { kind: 'NONE', name: '—', id: null } } }))).toBe('Negative exact in this ad group')
    // No blocker known (an older answer): no match is guessed.
    expect(stateSentence(term({ state: 'NEGATED', match: 'BROAD' }))).toBe('Blocked here by a negative')
    // A negative's own row is that negative.
    expect(stateSentence(stopped({ match: 'PHRASE', level: 'CAMPAIGN' }))).toBe('Negative phrase in the whole campaign')
  })
})

describe('HONEST 14 — "Did it work?" when it spends more than before: one true sentence', () => {
  it('it spends more, with the minus; never "as much", never "saved nothing"', () => {
    const b = stoppedBanner(stopped({ effect: { ...stopped().effect!, words: 'Spends as much here as before, in the 37 days since the stop' } }))
    expect(b.title).toBe('It spends more here than before the stop')
    expect(b.desc).toBe('Saved so far: −€3.00. Before the stop it cost €3.00 a day here, and €114.00 since.')
    expect(`${b.title} ${b.desc}`).not.toMatch(/as much|saved nothing/i)
    const still = stoppedBanner(stopped({ stillServesIn: 2, effect: { ...stopped().effect!, verdict: 'STILL_SPENDS' } }))
    expect(still.title).toBe('It spends more here than before, and its words spent in 2 other ad groups since the stop')
  })
})

describe('HONEST 16 — what the clicks limit means', () => {
  it('no order in that many clicks: it very likely converts below the product\'s rate (never "enough for 1 order")', () => {
    const note = wasteChecks(term())!.note
    expect(note).toContain('0 orders in 72 clicks: it very likely converts below the product\'s 4.10 % (95 % sure).')
    expect(note).not.toMatch(/enough for 1 order/)
    // At the floor the limit is higher than the 95 % call: surer still.
    const floor = wasteChecks(term({ test: { ...term().test, clicksNeeded: 20, sentence: SENTENCE.replace('72 clicks or more (at the product\'s pooled 4.10 %', '20 clicks or more (at the product\'s pooled 30.00 %') } }))!.note
    expect(floor).toContain('0 orders in 20 clicks: it very likely converts below the product\'s 30.00 % (at least 95 % sure: the limit is never under 20 clicks).')
  })
})

describe('HONEST 18 — the words say exactly what is counted', () => {
  it('a: a negative in the Blocked here list that blocks nothing now says so', () => {
    expect(blockedNote({ state: 'NEGATED' })).toBeNull()
    expect(blockedNote({ state: 'NOT_AT_AMAZON' })).toBe('Not at Amazon: blocks nothing')
    expect(blockedNote({ state: 'PAUSED' })).toBe('Paused: blocks nothing now')
  })

  it('b: still spends means spent since the stop (the server\'s count), never the places of the window', () => {
    const b = stoppedBanner(stopped({ stillServesIn: 1, effect: { ...stopped().effect!, verdict: 'STILL_SPENDS', savedCents: 600 } }), [place(), place({ rowId: 'term:IT|g10|made up boots' })], '2026-10-24')
    expect(b.title).toBe('It saved €6.00 so far, but its words spent in 1 other ad group since the stop')
    expect(b.desc).toContain('In Broad group the same words spent €3.10 with 0 orders in the 60 days to 24 Oct.')
  })

  it('c: the real window, never "the last 60 days"', () => {
    const r = term()
    expect(inWindow(r.test)).toBe('in the 60 days to 24 Oct')
    expect(wasteBanner(r).title).toBe('It spent €160.00 in the 60 days to 24 Oct and sold nothing')
    expect(wasteMetrics(r)[0].hint).toBe('60 days to 24 Oct')
    expect(wasteChecks(r)!.verdict).toBe('All 3 checks are true in the 60 days to 24 Oct')
    expect(whereWords(r).intro).toBe('Where this search term spends, and where a negative already blocks it. Numbers in the 60 days to 24 Oct.')
    expect(wasteBanner(term({ d: null })).title).toBe('No data in the 60 days to 24 Oct')
    for (const s of [wasteBanner(r).title, wasteMetrics(r)[0].hint, wasteChecks(r)!.verdict, whereWords(r).intro]) expect(s).not.toMatch(/last \d+ days/i)
    // A place on another window says its own.
    expect(placeWindowNote(place({ windowDays: 90 }), r)).toBe('in 90 days')
    expect(placeWindowNote(place(), r)).toBeNull()
  })

  it('c: the Wasting tile says the windows of the rows it sums and their last day', () => {
    const totals = (w: number[] | undefined): WasteTotals => ({ wasting: 3, wastingSpendCents: 75450, currency: 'EUR', keywords: 1, terms: 2, waiting: 0, keptPaused: 0, negated: 0, clashes: 0, skipped: 0, ...(w ? { wastingWindows: w } : {}) })
    const tile = (w: number[] | undefined) => tilesOf({ waste: totals(w), stopped: null, view: 'wasting', wastingShow: 'wasting', stoppedShow: 'all', currency: 'EUR', windowDays: 60, through: '2026-10-24' })[0]
    expect(tile([30, 90]).hint).toBe('€754.50 in 30–90 days to 24 Oct')
    expect(tile([30, 90]).title).toMatch(/each row's own window \(30–90 days\) to 24 Oct/)
    expect(tile([90]).hint).toBe('€754.50 in 90 days to 24 Oct')
    expect(tile([90]).title).toMatch(/the 90 days to 24 Oct/)
    // An older server: the criteria's window.
    expect(tile(undefined).hint).toBe('€754.50 in 60 days to 24 Oct')
  })

  it('d: removing a negative Amazon never had changes Nexus only — never "archived at Amazon"', () => {
    const removal = { action: 'REMOVE_NEGATIVE' as const, refusal: null, needsCode: false, runsAt: null, after: undefined }
    expect(landsWord({ ...removal, lands: 'nexus', final: false })).toBe('Nexus only — nothing changes at Amazon')
    // An older server that still said final: Nexus only wins.
    expect(isFinal({ action: 'REMOVE_NEGATIVE', lands: 'nexus', final: true })).toBe(false)
    expect(landsWord({ ...removal, lands: 'amazon', final: true })).toBe('Archived at Amazon — final, cannot come back')
    expect(stoppedVerb(stopped({ state: 'NOT_AT_AMAZON' })).sentence).toBe(NEXUS_ONLY_REMOVAL)
    expect(stoppedVerb(stopped()).sentence).toBe('Remove the negative: Amazon archives it, final')
  })

  it('d: an ask to remove a negative Amazon never had says Nexus only; one Amazon holds stays final; not known is said', () => {
    const ask = (atAmazon: boolean | undefined) => term({
      id: 'neg:n5', state: 'NEGATED', askOnly: true, verb: { action: 'REMOVE_NEGATIVE', where: 'adGroup', held: null, targetRowId: 'neg:n5' },
      waiting: { approvalId: 'appr-1', by: { id: 'brain', name: 'Brain' }, at: '2026-10-26T07:00:00.000Z', expiresAt: null, action: 'REMOVE_NEGATIVE', match: 'EXACT', level: 'AD_GROUP', text: 'made up', ...(atAmazon === undefined ? {} : { atAmazon }) },
    })
    expect(approveView(ask(false))!.desc).toBe('It removes the negative exact "made up": Amazon never had it, so it changes Nexus only')
    expect(approveView(ask(true))!.desc).toBe('It removes the negative exact "made up": Amazon archives it, final')
    expect(approveView(ask(undefined))!.desc).toBe('It removes the negative exact "made up": if Amazon holds it, Amazon archives it, final')
  })
})

describe('HONEST 19 — a person by their own name; "You" only for the person looking', () => {
  it('the chip shows the name the server gives; none: "A person" — never "You" unless the server says it is the viewer', () => {
    expect(chipOwner({ kind: 'PERSON', name: 'Test person one', id: 'u1' })).toMatchObject({ label: 'Test person one', hint: 'Test person one' })
    expect(chipOwner({ kind: 'PERSON', name: '', id: null })).toMatchObject({ label: 'A person' })
    expect(chipOwner({ kind: 'PERSON', name: 'You', id: 'u1' }).label).toBe('You')
  })
})
