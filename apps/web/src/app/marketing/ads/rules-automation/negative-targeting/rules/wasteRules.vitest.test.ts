/**
 * Negative Targeting page, Rules view (2026-10-11) — the pure rules of the table, the draft, the waiting asks and a
 * stop-waste rule's words. Names and numbers are made up.
 */
import { describe, expect, it } from 'vitest'
import {
  actionWord, askRowsTag, askWhat, autoLockOf, changeFromTo, decidedElsewhere, harvestWaitingHref, heldStep, isPseudo, last7Parts, last7Tab, last7Text, modeLock, negativeWord, ownerOf, partHolds, previewParts, refusalWhy,
  rowMatchesSearch, RULES_NOTE, scopeCount, sharedWhy, scopeLevel, scopePath, scopeText, testWords, verbWords, visibleRows, waitingAsksOf, waitingGap, whoWord,
  type WaitingRow, type WasteRuleRow,
} from './wasteRulesModel'
import {
  archiveReviewChanges, canStop, modeConflicts, modeGroups, modeReviewChanges, modeUndoLabel, pickMode, pickModeFor, retidyModes, waitsOf,
  shownMode, unarchiveReviewChanges,
} from './wasteRuleChanges'
import { negativeBuilderSettings } from './negativeSettings'

const ref = (id: string, name = id) => ({ id, name, href: `/x/${id}` })
const mode = (set: 'OFF' | 'WATCH' | 'ASK' | 'AUTO', extra: Partial<WasteRuleRow['mode']> = {}): WasteRuleRow['mode'] => ({ set, acts: set, heldBy: null, also: [], autoLocked: null, ...extra })

function rule(over: Partial<WasteRuleRow> = {}): WasteRuleRow {
  return {
    id: 'r1', kind: 'NEGATE_TERM', source: 'rule', readOnly: false, name: 'Stop waste — terms', sentence: 'Search terms: 0 orders → negative exact',
    market: 'IT', mode: mode('WATCH'), test: { kind: 'NEGATE_TERM', windowDays: 60, minClicks: 20, cpaMultiple: 1.5, spendFloorCents: 1500 },
    scope: { portfolios: [ref('pf1', 'Boots IT')], campaigns: [ref('c1', 'Boots Auto')], adGroups: [], counts: { portfolios: 1, campaigns: 1, adGroups: 0 }, all: false, product: null, adGroup: null },
    changed7d: { portfolios: [], campaigns: [], adGroups: [], paused: 0, negated: 0 },
    last7d: { runs: 0, asks: 0, applied: 0, written: 0, refused: 0, askedByCaps: 0 },
    waiting: 0, lastRunAt: null, nextRunAt: null, archived: false,
    ...over,
  }
}
const brain = () => rule({ id: 'brain', source: 'brain', readOnly: true, name: 'Brain (negatives)' })
const harvest = () => rule({ id: 'harvest', source: 'harvest', readOnly: true, name: 'Harvest (source negatives)' })

describe('owners and locks', () => {
  it('the Brain and Harvest are read only and say who owns them', () => {
    expect(isPseudo(brain())).toBe(true)
    expect(ownerOf(brain())?.word).toBe('Brain')
    expect(ownerOf(harvest())?.word).toBe('Harvest')
    expect(ownerOf(rule())).toBeNull()
    expect(modeLock(harvest())).toMatch(/Harvest owns/)
    expect(modeLock(rule({ archived: true }))).toMatch(/unarchive/)
    expect(modeLock(rule(), 'Needs the ads automation permission')).toBe('Needs the ads automation permission')
    expect(modeLock(rule())).toBeNull()
  })

  it('Auto is held with the API reason, and from Off the next step is said', () => {
    const locked = rule({ mode: mode('ASK', { autoLocked: { kind: 'graduation', label: 'Auto from 25 Oct', reason: 'A new rule first runs 14 days.' } }) })
    expect(heldStep(locked, 'AUTO')).toBe('A new rule first runs 14 days.')
    expect(heldStep(locked, 'ASK')).toBeNull()
    expect(heldStep({ mode: mode('OFF', { autoLocked: { kind: 'g', label: 'x' } }) }, 'AUTO')).toBe('Pick Watch or Ask me first')
    expect(autoLockOf(locked)?.label).toBe('Auto from 25 Oct')
    expect(autoLockOf({ ...locked, archived: true })).toBeNull()
    expect(autoLockOf({ ...locked, source: 'brain', readOnly: true })).toBeNull()
    expect(autoLockOf(rule({ mode: mode('ASK', { autoLocked: { kind: 'gate', label: 'Amazon test mode' } }) }))?.label).toBe('Auto: Amazon test mode')
    expect(autoLockOf(rule({ mode: mode('ASK', { autoLocked: { kind: 'graduation', label: 'Always asks' } }) }))?.label).toBe('Asks first')
  })

  it('part holds show only while it acts as set', () => {
    const also = [{ kind: 'allowlist', label: '2 campaigns locked' }]
    expect(partHolds(mode('ASK', { also }))).toHaveLength(1)
    expect(partHolds(mode('ASK', { acts: 'WATCH', also }))).toHaveLength(0)
  })
})

describe('scope: market › portfolio › campaign › ad group', () => {
  it('one ad group: the whole path down to it', () => {
    const r = rule({ scope: { ...rule().scope, adGroup: ref('g1', 'Auto group'), adGroups: [ref('g1', 'Auto group')], counts: { portfolios: 1, campaigns: 1, adGroups: 1 } } })
    expect(scopeLevel(r)).toBe('adGroup')
    expect(scopePath(r).map((s) => s.name)).toEqual(['IT', 'Boots IT', 'Boots Auto', 'Auto group'])
    expect(scopeCount(r)).toBe(0)
  })

  it('one campaign; a portfolio of several campaigns says how many', () => {
    expect(scopePath(rule()).map((s) => s.name)).toEqual(['IT', 'Boots IT', 'Boots Auto'])
    const pf = rule({ scope: { ...rule().scope, campaigns: [ref('c1'), ref('c2')], counts: { portfolios: 1, campaigns: 4, adGroups: 0 } } })
    expect(scopeLevel(pf)).toBe('portfolio')
    expect(scopePath(pf).map((s) => s.name)).toEqual(['IT', 'Boots IT'])
    expect(scopeCount(pf)).toBe(4)
    expect(scopeText(pf)).toBe('IT › Boots IT · 4 campaigns')
  })

  it('the whole market, every market, a product', () => {
    const whole = rule({ scope: { ...rule().scope, all: true, portfolios: [ref('a'), ref('b')], campaigns: [ref('c1'), ref('c2')], counts: { portfolios: 2, campaigns: 150, adGroups: 0 } } })
    expect(scopePath(whole).map((s) => s.name)).toEqual(['IT'])
    expect(scopeText(whole)).toBe('IT · whole market · 150 campaigns')
    expect(scopeLevel({ ...whole, market: null })).toBe('account')
    expect(scopePath({ ...whole, market: null })[0].name).toBe('All markets')
    const prod = rule({ scope: { ...rule().scope, product: ref('p1', 'BOOT-1') } })
    expect(scopePath(prod).map((s) => s.name)).toEqual(['IT', 'BOOT-1'])
  })

  it('the market step is never a link', () => {
    expect(scopePath(rule())[0].href).toBeUndefined()
  })
})

describe('last 7 days', () => {
  it('chips: paused and negatives open History, asks open Waiting, refusals warn', () => {
    const r = rule({ changed7d: { ...rule().changed7d, paused: 2, negated: 1 }, last7d: { runs: 3, asks: 1, applied: 0, written: 3, refused: 1, askedByCaps: 0 } })
    expect(last7Parts(r).map((p) => [p.text, p.tab ?? p.tone])).toEqual([['2 paused', 'history'], ['1 negative', 'history'], ['1 asked', 'waiting'], ['1 refused', 'warning']])
    expect(last7Text(r)).toBe('2 paused · 1 negative · 1 asked · 1 refused · 3 runs')
    expect(last7Text(rule({ last7d: { ...r.last7d, asks: 0, refused: 0, runs: 2 }, changed7d: rule().changed7d }))).toBe('2 runs, nothing stopped')
    expect(last7Text(rule())).toBe('No runs')
  })

  it('Enter goes to the asks while some wait', () => {
    expect(last7Tab(rule({ waiting: 2 }))).toBe('waiting')
    expect(last7Tab(rule({ changed7d: { ...rule().changed7d, negated: 1 } }))).toBe('history')
    expect(last7Tab(rule())).toBe('overview')
  })
})

describe('search and archived', () => {
  const rows = [brain(), harvest(), rule(), rule({ id: 'r2', name: 'Old one', archived: true })]
  it('the Brain and Harvest stay on top of the active list, never in Archived', () => {
    expect(visibleRows(rows, { search: '', archived: false }).map((r) => r.id)).toEqual(['brain', 'harvest', 'r1'])
    expect(visibleRows(rows, { search: '', archived: true }).map((r) => r.id)).toEqual(['r2'])
  })
  it('search reads the name, the sentence and the places, without accents', () => {
    expect(rowMatchesSearch(rule(), 'boots auto')).toBe(true)
    expect(rowMatchesSearch(rule({ name: 'Già fatto' }), 'gia')).toBe(true)
    expect(rowMatchesSearch(rule(), 'jacket')).toBe(false)
    expect(visibleRows(rows, { search: 'harvest', archived: false }).map((r) => r.id)).toEqual(['harvest'])
  })
})

describe('history and preview words', () => {
  it('a change as before → after', () => {
    expect(changeFromTo({ action: 'paused', from: 'ENABLED', to: 'PAUSED', match: null, level: null })).toEqual({ what: 'State', from: 'On', to: 'Paused' })
    expect(changeFromTo({ action: 'negated', from: null, to: null, match: 'NEGATIVE_PHRASE', level: 'CAMPAIGN' })).toEqual({ what: 'Negative', from: '—', to: 'Negative phrase · campaign' })
    expect(changeFromTo({ action: 'removed', from: null, to: null, match: 'EXACT', level: null }).to).toBe('Removed')
    expect(negativeWord(null)).toBe('Negative exact')
  })
  it('who made it, only when it is not this row', () => {
    const c = (kind: 'rule' | 'brain' | 'harvest' | 'person', id: string | null, name = '') => ({ who: { kind, id, name } })
    expect(whoWord(c('rule', 'r1', 'A'), 'r1')).toBeNull()
    expect(whoWord(c('rule', 'r9', 'Other'), 'r1')).toBe('Other')
    expect(whoWord(c('person', null), 'r1')).toBe('You')
    expect(whoWord(c('brain', 'brain'), 'brain')).toBeNull()
    expect(whoWord(c('harvest', null), 'r1')).toBe('Harvest')
  })
  it('preview chips and refusal words', () => {
    expect(previewParts({ wouldChange: 5, wouldAsk: 1, refused: [{ row: ref('x'), why: 'y' }] }).map((p) => p.text)).toEqual(['5 would change', '1 would ask', '1 refused'])
    expect(refusalWhy('source-ad-group-not-in-mappings')).toBe('Source ad group not in mappings')
    expect(refusalWhy('Refused by a guard: it sold.')).toBe('Refused by a guard: it sold.')
    const same = { why: 'Its trigger and conditions match now (its own window)' }
    expect(sharedWhy([same, same])).toBe('Passes its test now')
    expect(sharedWhy([same, { why: 'other' }])).toBeNull()
    expect(sharedWhy([same])).toBeNull()
  })
})

describe('waiting asks', () => {
  const w = (id: string, approvalId: string, by: string, at: string, group = 'g1'): WaitingRow => ({
    id, kind: 'TERM', text: id, match: 'BROAD', currency: 'EUR', portfolio: null, campaign: ref('c1'), adGroup: ref(group),
    product: null, verb: { action: 'NEGATE_EXACT', where: 'campaign', held: null }, d: { clicks: 40, orders: 0, spendCents: 2000 },
    waiting: { approvalId, by: { id: by, name: by }, at, expiresAt: null },
  })
  it('one ask per approval, the rule\'s own, oldest first; a card over two ad groups is one decision', () => {
    const rows = [w('kids', 'suggestion:k', 'r1', '2026-10-02T00:00:00Z'), w('kids2', 'suggestion:k', 'r1', '2026-10-02T00:00:00Z', 'g2'), w('pink', 'a2', 'r1', '2026-10-01T00:00:00Z'), w('sandal', 'a3', 'brain', '2026-10-01T00:00:00Z')]
    const asks = waitingAsksOf(rows, 'r1')
    expect(asks.map((a) => [a.approvalId, a.rows.length])).toEqual([['a2', 1], ['suggestion:k', 2]])
    expect(waitingAsksOf(rows, 'brain').map((a) => a.approvalId)).toEqual(['a3'])
    expect(waitingGap(4, asks)).toBe(2)
    expect(waitingGap(1, asks)).toBe(0)
  })
  it('as the page\'s one decide review takes them: one line per ask, places said, the path as links', () => {
    const rows = [w('kids', 'suggestion:k', 'r1', '2026-10-02T00:00:00Z'), w('kids', 'suggestion:k', 'r1', '2026-10-02T00:00:00Z', 'g2'), w('pink', 'a2', 'r1', '2026-10-01T00:00:00Z')]
    const waits = waitsOf(waitingAsksOf(rows, 'r1'))
    expect(waits.map((x) => [x.approvalId, x.text, x.what, x.by, x.places])).toEqual([['a2', 'pink', 'Negative exact · campaign', 'r1', 1], ['suggestion:k', 'kids', 'Negative exact · campaign', 'r1', 2]])
    expect(waits[0].place?.map((p) => p?.id ?? null)).toEqual([null, 'c1', 'g1'])
  })
  it('HONEST 10 / 11 — the ask\'s own change, never the row\'s verb; different changes are never "N places"', () => {
    const own = (row: WaitingRow, ask: Partial<NonNullable<WaitingRow['waiting']>>): WaitingRow => ({ ...row, waiting: { ...row.waiting!, ...ask } })
    // A keyword whose own verb is the clash's Remove, asked to be paused (without keeping it paused).
    const kw = own({ ...w('rain jacket', 'a7', 'brain', '2026-10-02T00:00:00Z'), kind: 'KEYWORD', verb: { action: 'REMOVE_NEGATIVE', where: 'adGroup', held: null } }, { action: 'PAUSE', level: null, text: 'rain jacket', keepPaused: false, changes: 1 })
    expect(askWhat(waitingAsksOf([kw], 'brain')[0])).toBe('Pause keyword')
    const kept = own(kw, { keepPaused: true })
    expect(askWhat(waitingAsksOf([kept], 'brain')[0])).toBe('Pause keyword, keep it paused')
    // A phrase in an ad group, on a row whose own verb is an exact in the whole campaign.
    const phrase = own(w('rain', 'a8', 'brain', '2026-10-02T00:00:00Z'), { action: 'NEGATE_PHRASE', level: 'AD_GROUP', text: 'rain', changes: 1 })
    expect(askWhat(waitingAsksOf([phrase], 'brain')[0])).toBe('Negative phrase')
    // The Brain's plan: two different terms, three changes in all.
    const plan = [own(w('cheap', 'p1', 'brain', '2026-10-02T00:00:00Z'), { action: 'NEGATE_EXACT', level: 'AD_GROUP', text: 'cheap', changes: 3 }), own(w('free', 'p1', 'brain', '2026-10-02T00:00:00Z', 'g2'), { action: 'NEGATE_EXACT', level: 'AD_GROUP', text: 'free', changes: 3 })]
    expect(askRowsTag(waitingAsksOf(plan, 'brain')[0])).toEqual({ label: '3 changes', hint: 'One answer decides them all: cheap in g1 · free in g2 · and 1 more' })
    // One card over the same words in two ad groups.
    const card = [own(w('kids', 'suggestion:k', 'r1', '2026-10-02T00:00:00Z'), { action: 'NEGATE_EXACT', level: 'CAMPAIGN', text: 'kids', changes: 1 }), own(w('kids', 'suggestion:k', 'r1', '2026-10-02T00:00:00Z', 'g2'), { action: 'NEGATE_EXACT', level: 'CAMPAIGN', text: 'kids', changes: 1 })]
    expect(askRowsTag(waitingAsksOf(card, 'r1')[0])).toEqual({ label: '2 ad groups', hint: 'g1 · g2' })
    expect(waitsOf(waitingAsksOf(card, 'r1'))[0]).toMatchObject({ text: 'kids', places: 2, changes: 1, level: 'CAMPAIGN' })
    expect(askRowsTag(waitingAsksOf([phrase], 'brain')[0])).toBeNull()
  })
})

describe('the mode draft', () => {
  const rows = new Map([brain(), rule(), rule({ id: 'r2', mode: mode('ASK') }), rule({ id: 'r3', archived: true })].map((r) => [r.id, r]))
  it('never drafts the Brain, Harvest or an archived rule; a pick back drops it', () => {
    let d = pickModeFor({}, [...rows.values()], 'ASK')
    expect(Object.keys(d)).toEqual(['r1'])
    d = pickMode(d, rows.get('r1')!, 'WATCH')
    expect(d).toEqual({})
  })
  it('a pick that lets it stop things ticks; Off → Watch does not', () => {
    expect(canStop('OFF', 'WATCH')).toBe(false)
    expect(canStop('WATCH', 'ASK')).toBe(true)
    expect(canStop('AUTO', 'ASK')).toBe(false)
    const lines = modeReviewChanges({ r1: 'AUTO', r2: 'OFF' }, rows)
    expect(lines.map((l) => [l.id, l.now, l.next, !!l.raise, l.note])).toEqual([['r1', 'Watch', 'Auto', true, 'Acts alone, inside its caps'], ['r2', 'Ask me', 'Off', false, undefined]])
  })
  it('Undo says what it does', () => {
    expect(modeUndoLabel({ a: 'ASK' })).toBe('Undo: back to Ask me')
    expect(modeUndoLabel({ a: 'ASK', b: 'OFF' })).toBe('Undo: put 2 back')
  })
  it('grouped per mode for the one route; conflicts and retidy after a re-read', () => {
    expect(modeGroups({ a: 'ASK', b: 'OFF', c: 'ASK' })).toEqual([{ mode: 'ASK', ids: ['a', 'c'] }, { mode: 'OFF', ids: ['b'] }])
    const fresh = new Map(rows)
    fresh.set('r1', rule({ mode: mode('ASK') }))
    expect(modeConflicts({ r1: 'AUTO' }, rows, fresh)).toEqual([{ label: 'Stop waste — terms', was: 'Watch', now: 'Ask me' }])
    expect(retidyModes({ r1: 'ASK' }, fresh)).toEqual({})
    expect(shownMode(rule(), { r1: 'AUTO' })).toMatchObject({ set: 'AUTO', acts: 'AUTO', heldBy: null })
  })
  it('archive and unarchive lines', () => {
    expect(archiveReviewChanges([brain(), rule({ waiting: 2 })])).toEqual([{ id: 'r1', where: 'Stop waste — terms', what: 'Rule', now: 'Watch', next: 'Archived', note: '2 waiting asks expire' }])
    expect(unarchiveReviewChanges([rule({ archived: true })])[0]).toMatchObject({ now: 'Archived', next: 'Off' })
  })
})

describe('a stop-waste rule in chips\' words', () => {
  it('its action and its test', () => {
    // Audit S4 — one wording, the builder's; no jargon.
    expect(verbWords('PAUSE_KEYWORD')).toBe('Pause keyword, keep it paused')
    expect(verbWords('NEGATE_TERM')).toBe('Negative exact')
    expect(verbWords('NEGATE_TERM', { match: 'PHRASE', level: 'CAMPAIGN' })).toBe('Negative phrase · whole campaign')
    expect(testWords({ windowDays: 60, minClicks: 20, cpaMultiple: 1.5 })).toEqual(['0 orders', '≥ 20 clicks', 'spend ≥ 1.5 × target cost per order', '60 d'])
  })
})

describe('NFIX — Harvest\'s waiting is decided on the Keyword Harvest page: a link with the count, never a count without its list', () => {
  const harvest = rule({ id: 'harvest', source: 'harvest', readOnly: true, waiting: 3, last7d: { runs: 0, asks: 2, applied: 0, written: 0, refused: 0, askedByCaps: 0 } })
  it('links to that page\'s Waiting list in the market; the Brain and the rules stay here', () => {
    expect(decidedElsewhere(harvest)).toBe(true)
    expect(decidedElsewhere(rule({ id: 'brain', source: 'brain', readOnly: true }))).toBe(false)
    expect(decidedElsewhere(rule())).toBe(false)
    expect(harvestWaitingHref('it')).toBe('/marketing/ads/rules-automation/keyword-harvest?show=waiting&market=IT')
    expect(harvestWaitingHref('all')).toBe('/marketing/ads/rules-automation/keyword-harvest?show=waiting')
    expect(harvestWaitingHref(null)).toBe('/marketing/ads/rules-automation/keyword-harvest?show=waiting')
  })
  it('its asks are a word with where they are decided, never a Waiting tab here', () => {
    expect(last7Parts(harvest)).toEqual([{ key: 'asks', text: '2 asked', hint: 'Decided on the Keyword Harvest page' }])
    expect(last7Tab(harvest)).toBe('overview')
    expect(last7Tab(rule({ waiting: 1 }))).toBe('waiting')
  })
  it('a removal the Brain asks for reads in words', () => {
    expect(actionWord('REMOVE_NEGATIVE')).toBe('Remove negative')
  })
})

describe('audit M4 — a negative builder rule\'s settings, in its own words', () => {
  const stored = {
    id: 'r1', name: 'Mine', trigger: 'SEARCH_TERM_WASTING', maxExecutionsPerDay: 10, maxWritesPerDay: null, maxDailyAdSpendCentsEur: 10000,
    createdAt: '2026-10-11T08:00:00Z', createdBy: 'user:anonymous',
    conditions: [{ conditions: [{ metric: 'Sales', op: 'eq', value: '0' }, { metric: 'Clicks', op: 'gte', value: '5' }] }],
    actions: [{
      type: 'negative-targeting', negationLevel: 'adgroup', dedupe: true, protectConverting: true, protectDays: 30,
      searchTerms: [{ term: 'kids', op: 'not' }], filters: { brandExclude: ['acme'], competitorOnly: false },
      mappings: [{ groups: [{ id: 'g1', name: 'Seed broad group', campaignName: 'Seed IT', look: true, types: { P: false, E: true, product: false } }] }],
    }],
  }
  it('criteria, mapping, filters, negatives, runs, limits and who made it — no raw slug, no "?"', () => {
    const groups = negativeBuilderSettings(stored, { currency: 'EUR', schedule: 'Daily · 06:00' })!
    const text = JSON.stringify(groups)
    expect(groups.map((g) => g.title)).toEqual(['Criteria', 'Ad Group Mapping', 'Search terms', 'Negatives', 'Runs', 'Limits', 'Made'])
    expect(groups[0].items).toEqual([{ label: 'If', value: 'Sales = €0 and Clicks ≥ 5' }])
    expect(groups[1].items).toEqual([{ label: 'Seed broad group · Seed IT', value: 'Looks for search terms · creates a negative exact' }])
    expect(groups[2].items).toContainEqual({ label: 'Does not contain', value: '"kids"' })
    expect(groups[5].items[0]).toEqual({ label: 'Matches a day', value: '10' })
    expect(text).not.toMatch(/negative-targeting|"\?|IF 1/)
  })
  it('any other rule: null (the Bid page\'s reader reads it)', () => {
    expect(negativeBuilderSettings({ ...stored, actions: [{ type: 'bid' }] })).toBeNull()
    expect(negativeBuilderSettings({ ...stored, actions: [{ type: 'add_negative_exact' }] })).toBeNull()
  })
})

describe('audit R-M1 — a "Pause keyword, keep it paused" rule\'s settings: only what it uses', () => {
  const pause = {
    id: 'p1', name: 'Pause', trigger: 'TARGET_PERFORMANCE', maxExecutionsPerDay: 10, maxWritesPerDay: null, maxDailyAdSpendCentsEur: null,
    conditions: [{ conditions: [{ metric: 'Clicks', op: 'gte', value: '20' }] }],
    actions: [{
      type: 'negative-targeting', negationLevel: 'adgroup', dedupe: true, protectConverting: true, searchTerms: [{ term: 'kids', op: 'not' }],
      stopWaste: { kind: 'PAUSE_KEYWORD', windowDays: 60, minClicks: 20, cpaMultiple: 2 },
      mappings: [{ groups: [
        { id: 'g1', name: 'Seed exact group', campaignName: 'Seed IT', look: true, types: { P: true, E: true, product: false } },
        { id: 'g2', name: 'Not looked in', campaignName: 'Seed IT', look: false, types: { P: false, E: true, product: false } },
      ] }],
    }],
  }
  it('its criteria, where it pauses (campaign › ad group it looks in), runs, limits in keywords, made — no target, filter or negation', () => {
    const groups = negativeBuilderSettings(pause, { schedule: 'Daily · 06:00' })!
    expect(groups.map((g) => g.title)).toEqual(['Criteria', 'Where it pauses', 'Runs', 'Limits', 'Made'])
    expect(groups[1].items).toEqual([{ label: 'Ad group', value: 'Seed IT › Seed exact group' }])
    expect(groups[3].items[0]).toEqual({ label: 'Keywords a day', value: '10' })
    expect(JSON.stringify(groups)).not.toMatch(/negative exact|Search terms|Negation|kids|Brand/)
  })
})

describe('the note under the card (the redesign, 2026-10-26)', () => {
  it('says what Last 7 d and Waiting count, in the columns\' own words', () => {
    expect(RULES_NOTE).toBe('Last 7 d: keywords it paused, negatives it added, asks it made, refusals · Waiting: asks waiting for you — approve or reject them here')
  })
})
