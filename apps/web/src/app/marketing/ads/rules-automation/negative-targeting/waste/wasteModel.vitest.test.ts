import { describe, expect, it } from 'vitest'
import {
  ackWords, appliedWords, chipOwner, decideLines, decideSummary, planWords, doneLine, isFinal, keepWord, olderKeep, shownSteps, unknownAction, detailTabOf, emptyWords, idKind, kindOf, landsWord, listSearch, previewSummary, saveWords,
  sinceView, skipIds, sortOf, sortParam, spendHint, verbLabel, stateSentence, stoppedBulkPlan, stoppedShowOf, stoppedVerb, termOfId, tileQuery, tilesOf, undoWords, viewOf, waitingOf,
  wasteBulkCounts, wasteBulkPlan, wastingShowOf, wasteVerb, xCpaText,
  decideAria, headerLine, KIND_WORDS, noteLine, ownFilterCount, pagerWords, stateChip, stateSub, stoppedRowMenu, tickedCount, toolbarCount, wasteRowMenu, wastingChips,
} from './wasteModel'
import type { PreviewStep, StoppedRow, StoppedTotals, WaitingSteps, WasteRow, WasteTotals } from './wasteTypes'

const ref = (id: string, name = id) => ({ id, name, href: `/x/${id}` })

function row(over: Partial<WasteRow> = {}): WasteRow {
  return {
    id: 'kw:k1', kind: 'KEYWORD', text: 'rain jacket', match: 'EXACT', channel: 'AMAZON', market: 'IT', currency: 'EUR',
    portfolio: ref('pf1', 'Jackets'), campaign: ref('c1', 'Jacket Exact'), adGroup: ref('g1', 'Exact group'), product: ref('p1', 'JACKET'), productCount: 1, via: null,
    state: 'RUNNING', owner: { kind: 'NONE', name: '—', id: null }, verb: { action: 'PAUSE', where: 'adGroup', held: null },
    test: { met: true, by: null, sentence: 'Wastes', windowDays: 60, clicksNeeded: 20, spendBarCents: 3000, xCpaBar: 2 },
    d: { impressions: 100, clicks: 40, orders: 0, spendCents: 4000, salesCents: 0, acosPct: null, cpcCents: 100, xCpa: 2.5 },
    d90: { clicks: 40, orders: 0, spendCents: 4000 }, spark: [0, 0, 1000], stockOutDays: 0, waiting: null, skipped: null, stillServesIn: 0, lastChange: null,
    ...over,
  }
}
const term = (over: Partial<WasteRow> = {}) => row({ id: 'term:IT|EXT1|rain coat', kind: 'TERM', text: 'rain coat', match: 'AUTO', verb: { action: 'NEGATE_EXACT', where: 'adGroup', held: null }, ...over })

function stopped(over: Partial<StoppedRow> = {}): StoppedRow {
  return {
    id: 'neg:n1', kind: 'TERM', text: 'cheap coat', match: 'EXACT', level: 'AD_GROUP', market: 'IT', currency: 'EUR', portfolio: null, campaign: ref('c1'), adGroup: ref('g1'),
    product: null, owner: { kind: 'PERSON', name: 'You', id: 'u1' }, since: '2026-10-01T10:00:00.000Z', sinceSource: 'record', keptPaused: null, spendBeforeCents: 1000,
    state: 'NEGATED', stillServesIn: 0, places: 1,
    actions: { turnOn: { allowed: false, why: 'A negative is not turned on' }, removeNegative: { allowed: true, why: 'Final' }, release: { allowed: false, why: 'Not kept paused' } },
    ...over,
  }
}

describe('the address', () => {
  it('reads every param with a safe default', () => {
    expect(viewOf('stopped')).toBe('stopped')
    expect(viewOf('nope')).toBe('wasting')
    expect(wastingShowOf('waiting')).toBe('waiting')
    expect(wastingShowOf('kept')).toBe('wasting')
    expect(stoppedShowOf('turned-on')).toBe('turned-on')
    expect(stoppedShowOf(null)).toBe('all')
    expect(kindOf('term')).toBe('term')
    expect(detailTabOf('history')).toBe('history')
    expect(detailTabOf('why')).toBe('overview')
  })
  it('turns a header sort into the server key and back', () => {
    expect(sortParam({ colId: 'spend', dir: 'desc' })).toBe('-spend')
    expect(sortParam({ colId: 'trend', dir: 'asc' })).toBeNull()
    expect(sortOf('-xCpa')).toEqual({ colId: 'xCpa', dir: 'desc' })
    expect(sortOf('bogus')).toBeNull()
  })
  it('builds the list query and leaves out what is empty', () => {
    expect(listSearch({ market: 'it', lists: null, kind: 'all', show: 'wasting', q: ' ', page: 1, pageSize: 50 })).toBe('?market=IT&show=wasting&pageSize=50')
    expect(listSearch({ market: 'all', lists: { campaignIds: 'c1,c2' }, kind: 'term', show: 'all', q: 'coat', sort: '-spend', page: 2 })).toBe('?campaignIds=c1%2Cc2&kind=term&show=all&q=coat&sort=-spend&page=2')
  })
  it('sends the filter bar\'s lists, only those with a pick', () => {
    const qs = new URLSearchParams(listSearch({ market: 'IT', lists: { portfolioIds: 'p1', adGroupIds: 'g1,g2' }, kind: 'all', show: 'wasting', q: '' }).slice(1))
    expect(qs.get('portfolioIds')).toBe('p1')
    expect(qs.get('adGroupIds')).toBe('g1,g2')
    expect(qs.has('campaignIds')).toBe(false)
    expect(qs.has('portfolioId')).toBe(false)
  })
})

describe('verbs', () => {
  it('a running keyword pauses, a running term negates where the server says', () => {
    expect(wasteVerb(row())).toMatchObject({ action: 'PAUSE', where: null, label: 'Pause', short: 'Pause', held: null })
    expect(wasteVerb(term({ verb: { action: 'NEGATE_EXACT', where: 'campaign', held: null } }))).toMatchObject({ label: 'Negative exact · whole campaign', short: 'Negative' })
  })
  it('a held verb stays, with the server\'s reason; a protected row\'s verb opens its record (step 4: its two actions are there)', () => {
    expect(wasteVerb(term({ verb: { action: 'NEGATE_EXACT', where: 'adGroup', held: { label: 'Our keyword', reason: 'It would block our own keyword' } } }))?.held).toBe('It would block our own keyword')
    expect(wasteVerb(term({ state: 'PROTECTED', verb: { action: 'NEGATE_EXACT', where: 'adGroup', held: { label: 'Protected', reason: '"x" is a protected term' } } }))).toMatchObject({ label: 'Protected…', held: null, primary: false, opens: true })
  })
  it('turned on outside Nexus: Pause again (kept paused), in bulk too', () => {
    expect(wasteVerb(row({ state: 'TURNED_ON_ELSEWHERE' }))).toMatchObject({ action: 'PAUSE', label: 'Pause again', held: null })
    expect(wasteBulkPlan([row({ state: 'TURNED_ON_ELSEWHERE' })], 'pause').items).toEqual([{ rowId: 'kw:k1', action: 'PAUSE' }])
    expect(wasteBulkPlan([term({ state: 'TURNED_ON_ELSEWHERE' })], 'negExact').left[0].why).toBe('Turned on outside Nexus: pause it again')
  })
  it('a row that does not run has no wasting verb', () => {
    expect(wasteVerb(row({ state: 'KEPT_PAUSED' }))).toBeNull()
  })
  it('a stopped row offers its one verb, gated by the server', () => {
    expect(stoppedVerb(stopped())).toMatchObject({ action: 'REMOVE_NEGATIVE', held: null })
    expect(stoppedVerb(stopped({ actions: { ...stopped().actions, removeNegative: { allowed: false, why: 'Harvest keeps it' } } })).held).toBe('Harvest keeps it')
    expect(stoppedVerb(stopped({ id: 'kw:k1', kind: 'KEYWORD', state: 'KEPT_PAUSED', actions: { turnOn: { allowed: true, why: '' }, removeNegative: { allowed: false, why: '' }, release: { allowed: true, why: '' } } })).action).toBe('TURN_ON')
    expect(stoppedVerb(stopped({ id: 'kw:k1', kind: 'KEYWORD', state: 'TURNED_ON_ELSEWHERE' })).action).toBe('RELEASE')
  })
})

describe('bulk', () => {
  const rows = [row(), term(), term({ id: 'term:IT|EXT1|b0abcdefgh', text: 'b0abcdefgh', match: 'ASIN', verb: { action: 'NEGATE_ASIN', where: 'adGroup', held: null } }), row({ id: 'kw:k2', state: 'KEPT_PAUSED' })]
  it('counts what each verb fits and leaves the rest out with why', () => {
    expect(wasteBulkCounts(rows)).toEqual({ pause: 1, negExact: 2, negPhrase: 1, negCampaign: 1 })
    const plan = wasteBulkPlan(rows, 'pause')
    expect(plan.items).toEqual([{ rowId: 'kw:k1', action: 'PAUSE' }])
    expect(plan.left.map((l) => l.why)).toEqual(['A search term is negated, not paused', 'A search term is negated, not paused', 'Kept paused already'])
  })
  it('negates a product as a product target, never phrase or campaign-wide', () => {
    expect(wasteBulkPlan(rows, 'negExact').items).toEqual([
      { rowId: 'term:IT|EXT1|rain coat', action: 'NEGATE_EXACT', where: 'adGroup' },
      { rowId: 'term:IT|EXT1|b0abcdefgh', action: 'NEGATE_ASIN' },
    ])
    expect(wasteBulkPlan(rows, 'negCampaign').items).toEqual([{ rowId: 'term:IT|EXT1|rain coat', action: 'NEGATE_EXACT', where: 'campaign' }])
  })
  it('reads a row ticked by id only (select all across pages) from its id', () => {
    expect(idKind('kw:x')).toBe('kw')
    expect(termOfId('term:IT|G1|giacca%20moto')).toBe('giacca moto')
    const plan = wasteBulkPlan([{ id: 'kw:x' }, { id: 'term:IT|G1|b0zzzzzzzz' }, { id: 'term:IT|G1|coat' }], 'negExact')
    expect(plan.items).toEqual([{ rowId: 'term:IT|G1|b0zzzzzzzz', action: 'NEGATE_ASIN' }, { rowId: 'term:IT|G1|coat', action: 'NEGATE_EXACT', where: 'adGroup' }])
    expect(plan.left).toHaveLength(1)
  })
  it('skip, unskip and waiting pick their rows', () => {
    const s = row({ id: 'kw:s', skipped: { until: '2026-11-01T00:00:00Z', by: null, at: null } })
    const w = term({ id: 'term:IT|G|w', waiting: { approvalId: 'a1', by: ref('brain', 'Brain'), at: '2026-10-10T00:00:00Z', expiresAt: null } })
    expect(skipIds([row(), s, w])).toEqual({ skip: ['kw:k1', 'term:IT|G|w'], unskip: ['kw:s'] })
    expect(waitingOf([row(), w])).toMatchObject([{ rowId: 'term:IT|G|w', approvalId: 'a1', text: 'rain coat', by: 'Brain', what: 'Negative exact', places: 1, place: [{ id: 'pf1' }, { id: 'c1' }, { id: 'g1' }] }])
  })
  it('stopped bulk: remove only negatives, turn on only ours, keep paused with an end', () => {
    const kept = stopped({ id: 'kw:k1', kind: 'KEYWORD', state: 'KEPT_PAUSED', actions: { turnOn: { allowed: true, why: '' }, removeNegative: { allowed: false, why: '' }, release: { allowed: true, why: '' } } })
    const harvest = stopped({ id: 'neg:h', actions: { ...stopped().actions, removeNegative: { allowed: false, why: 'Harvest keeps it' } } })
    expect(stoppedBulkPlan([stopped(), kept, harvest], 'remove')).toEqual({
      items: [{ rowId: 'neg:n1', action: 'REMOVE_NEGATIVE' }],
      left: [{ id: 'kw:k1', text: 'cheap coat', why: 'Not a negative: turn it on instead' }, { id: 'neg:h', text: 'cheap coat', why: 'Harvest keeps it' }],
    })
    expect(stoppedBulkPlan([kept], 'keepUntil', '2026-12-01').items).toEqual([{ rowId: 'kw:k1', action: 'KEEP_UNTIL', keepUntil: '2026-12-01' }])
  })
})

describe('the review', () => {
  const step = (over: Partial<PreviewStep> = {}): PreviewStep => ({
    rowId: 'kw:k1', action: 'PAUSE', text: 'rain jacket', place: { portfolio: null, campaign: ref('c1'), adGroup: ref('g1') }, from: 'RUNNING', to: 'KEPT_PAUSED',
    lands: 'amazon', runsAt: null, refusal: null, raise: false, needsCode: false, tool: 'pause-ads', summary: null, ...over,
  })
  it('says where each change lands, and what is left out', () => {
    expect(landsWord(step())).toBe('Sends to Amazon')
    expect(landsWord(step({ lands: 'nexus' }))).toBe('Nexus only')
    expect(landsWord(step({ needsCode: true }))).toBe('Needs your code')
    expect(landsWord(step({ refusal: { code: 'x', label: 'Harvest keeps it' } }))).toBe('Left out: Harvest keeps it')
    expect(previewSummary([step(), step({ lands: 'nexus' }), step({ refusal: { code: 'x', label: 'no' } })], 'it')).toBe('Amazon IT · 1 to Amazon · 1 Nexus only · 1 left out')
  })
  it('counts the Save button by what it sends', () => {
    expect(saveWords([step(), step()])).toBe('Pause 2')
    expect(saveWords([step({ action: 'NEGATE_EXACT' }), step({ action: 'NEGATE_PHRASE' })])).toBe('Add 2 negatives')
    expect(saveWords([step({ action: 'REMOVE_NEGATIVE' })])).toBe('Remove 1 negative')
    expect(saveWords([step(), step({ action: 'NEGATE_EXACT' })])).toBe('Send 2 changes')
  })
  it('Undo says what it does', () => {
    expect(undoWords(['PAUSE'])).toBe('Undo: turn 1 back on')
    expect(undoWords(['NEGATE_EXACT', 'NEGATE_PHRASE'])).toBe('Undo: remove 2 negatives')
    expect(undoWords(['PAUSE', 'NEGATE_EXACT'])).toBe('Undo: put 2 back')
  })
  it('reads the apply answer per step', () => {
    expect(appliedWords(step(), { status: 'queued' })).toEqual({ ok: true, words: 'Sending' })
    expect(appliedWords(step({ lands: 'nexus' }), { status: 'applied' })).toEqual({ ok: true, words: 'Saved in Nexus' })
    expect(appliedWords(step(), { status: 'waiting', approve: { ok: false, error: 'Code needed' } })).toEqual({ ok: false, words: 'Waiting: Code needed' })
  })
})

describe('tiles', () => {
  const waste: WasteTotals = { wasting: 4, wastingSpendCents: 12000, keywords: 2, terms: 2, waiting: 2, keptPaused: 1, negated: 9, clashes: 3, skipped: 0, protected: 1 }
  const stop: StoppedTotals = { all: 12, kept: 2, paused: 1, negated: 9, turnedOn: 0, stillBought: 1, notAtAmazon: 0, inactive: 5 }
  it('each number comes from the read whose table it opens', () => {
    const t = tilesOf({ waste, stopped: stop, view: 'wasting', wastingShow: 'wasting', stoppedShow: 'all', currency: 'EUR' })
    expect(t.map((x) => [x.id, x.value, x.active, x.clickable])).toEqual([
      ['wasting', 4, true, true], ['waiting', 2, false, true], ['kept', 2, false, true], ['blocked', 9, false, true], ['clashes', 3, false, true], ['protected', 1, false, true],
    ])
    // Step 4 — an older server without the count: a dash, never zero, and not a button.
    expect(tilesOf({ waste: { ...waste, protected: undefined }, stopped: stop, view: 'wasting', wastingShow: 'wasting', stoppedShow: 'all', currency: 'EUR' })[5]).toMatchObject({ id: 'protected', value: null, clickable: false })
    expect(t[0].hint).toBe('€120.00')
  })
  it('unknown is a dash, never zero', () => {
    expect(tilesOf({ waste: null, stopped: null, view: 'wasting', wastingShow: 'wasting', stoppedShow: 'all', currency: 'EUR' }).map((x) => x.value)).toEqual([null, null, null, null, null, null])
  })
  it('a tile goes to its view; the pressed one goes back', () => {
    expect(tileQuery('kept', false)).toMatchObject({ view: 'stopped', show: 'kept' })
    expect(tileQuery('kept', true)).toMatchObject({ view: 'stopped', show: null })
    expect(tileQuery('waiting', false)).toMatchObject({ view: null, show: 'waiting' })
    expect(tileQuery('clashes', false)).toMatchObject({ view: null, show: 'clashes' })
    expect(tileQuery('protected', false)).toMatchObject({ view: null, show: 'protected' })
    expect(tileQuery('protected', true)).toMatchObject({ view: null, show: null })
  })
  it('money in several currencies is split, never added up', () => {
    expect(spendHint({ wastingSpendCents: null, currency: null, wastingSpendByCurrency: { GBP: 4000, EUR: 50000 }, wastingSpendNote: 'several' }, 'EUR')).toEqual({ text: '€500.00 · £40.00', note: 'several' })
    expect(spendHint({ wastingSpendCents: 500, currency: 'GBP', wastingSpendByCurrency: { GBP: 500 }, wastingSpendNote: null }, 'EUR')).toEqual({ text: '£5.00', note: null })
    expect(spendHint({ wastingSpendCents: null, currency: null, wastingSpendByCurrency: {}, wastingSpendNote: null }, 'EUR')).toBeNull()
    expect(tilesOf({ waste: { ...waste, wastingSpendCents: null, wastingSpendByCurrency: { EUR: 100, GBP: 200 } }, stopped: stop, view: 'wasting', wastingShow: 'wasting', stoppedShow: 'all', currency: 'EUR' })[0].hint).toBe('€1.00 · £2.00')
  })
})

describe('words', () => {
  it('owner chips: kind word, name on hover, the owner\'s lock', () => {
    expect(chipOwner({ kind: 'RULE', name: 'Stop waste', id: 'r1' })).toMatchObject({ label: 'Rule', hint: 'Rule: Stop waste', ruleId: 'r1' })
    expect(chipOwner({ kind: 'BRAIN', name: 'Brain funnel', id: null })).toMatchObject({ label: 'Brain', hint: 'The Brain keeps it', locked: true })
    expect(chipOwner({ kind: 'HARVEST', name: 'Harvest', id: null }).hint).toBe('Harvest keeps it')
    expect(chipOwner({ kind: 'HARVEST', name: 'Harvest', id: null }).locked).toBe(true)
    expect(chipOwner({ kind: 'PERSON', name: 'Playbook', id: null }).label).toBe('Playbook')
    expect(chipOwner({ kind: 'NONE', name: 'Unknown', id: null })).toMatchObject({ label: '—', hint: 'Unknown' })
  })
  it('state marks say the whole state', () => {
    expect(stateSentence({ state: 'KEPT_PAUSED', keptPaused: { by: ref('u', 'You'), at: '', until: null, reason: null } })).toBe('Kept paused by You: no rule, Brain or plan turns it on')
    expect(stateSentence({ state: 'NEGATED', match: 'PHRASE', level: 'CAMPAIGN' })).toBe('Negative phrase in the whole campaign')
  })
  it('×CPA and empties', () => {
    expect(xCpaText(2.06)).toBe('2.1×')
    expect(xCpaText(null)).toBe('—')
    expect(emptyWords('wasting', 'wasting', false)).toEqual({ title: 'Nothing wasting', clear: false })
    expect(emptyWords('stopped', 'kept', false)).toEqual({ title: 'None here', clear: true })
    expect(emptyWords('wasting', 'wasting', true).clear).toBe(true)
  })
})

describe('polish round 1 (audit 2026-10-11)', () => {
  const step = (over: Partial<PreviewStep> = {}): PreviewStep => ({
    rowId: 'kw:k1', action: 'PAUSE', text: 'rain jacket', place: { portfolio: null, campaign: ref('c1'), adGroup: ref('g1') }, from: 'RUNNING', to: 'KEPT_PAUSED',
    lands: 'amazon', runsAt: null, refusal: null, raise: false, needsCode: false, tool: 'pause-ads', summary: null, ...over,
  })
  it('M6: one ask covering two rows is decided once, and says "2 places"', () => {
    const wait = { approvalId: 'card1', by: ref('r', 'Stop waste'), at: '2026-10-10T00:00:00Z', expiresAt: null }
    const a = term({ id: 'term:IT|G1|kids', waiting: { ...wait, rows: 2 } })
    const b = term({ id: 'term:IT|G2|kids', waiting: { ...wait, rows: 2 } })
    expect(waitingOf([a, b]).map((w) => [w.approvalId, w.places])).toEqual([['card1', 2]])
    expect(waitingOf([a]).map((w) => w.places)).toEqual([2])
  })
  it('M2: a removal is final — the note says so, the tick says so, and there is no Undo', () => {
    const rm = step({ action: 'REMOVE_NEGATIVE', from: 'NEGATED', to: 'REMOVED', raise: true })
    expect(isFinal(rm)).toBe(true)
    expect(isFinal({ ...rm, final: false })).toBe(false)
    expect(landsWord(rm)).toBe('Archived at Amazon — final, cannot come back')
    expect(ackWords([rm])).toBe('I understand Amazon archives a removed negative: it cannot come back.')
    expect(ackWords([step({ action: 'TURN_ON', raise: true })])).toBe('I understand it lets these spend again.')
    expect(ackWords([step()])).toBeUndefined()
    // A removal the server keeps in Nexus (a test account) is not final, but it can let spend rise.
    expect(ackWords([step({ action: 'REMOVE_NEGATIVE', lands: 'nexus', raise: true })])).toBe('I understand it lets these spend again.')
    expect(undoWords(['REMOVE_NEGATIVE'])).toBeNull()
  })
  it('M3: Keep paused reads as its end date, and its Undo puts the old end back', () => {
    const items = [{ rowId: 'kw:k1', action: 'KEEP_UNTIL' as const, keepUntil: '2026-11-10' }]
    // The server knows KEEP_UNTIL: its own from / to.
    const p1 = { steps: [step({ action: 'KEEP_UNTIL', from: 'ALWAYS', to: '2026-11-10' })], blocked: 0, planHash: 'h' }
    expect(shownSteps(p1, { items }, false)[0]).toMatchObject({ action: 'KEEP_UNTIL', from: 'ALWAYS', to: '2026-11-10' })
    // It was not kept (from null): "Paused" → the end; its Undo ends the lock.
    const p0 = { steps: [step({ action: 'KEEP_UNTIL', from: null, to: 'ALWAYS' })], blocked: 0, planHash: 'h' }
    const s0 = shownSteps(p0, { items }, false)[0]
    expect([keepWord(s0.from), keepWord(s0.to)]).toEqual(['Paused', 'Always'])
    expect(undoWords(['KEEP_UNTIL'], [s0.from])).toBe('Undo: end the lock')
    expect(appliedWords(s0, { status: 'queued' })).toEqual({ ok: true, words: 'Kept paused, always' })
    // An older server answered a Pause: the review still reads Keep paused, from the ask's old end.
    const p2 = { steps: [step({ action: 'PAUSE', from: 'KEPT_PAUSED', to: 'KEPT_PAUSED', raise: false })], blocked: 0, planHash: 'h' }
    expect(shownSteps(p2, { items, keepFrom: { 'kw:k1': '2026-10-20' } }, true)[0]).toMatchObject({ action: 'KEEP_UNTIL', from: '2026-10-20', to: '2026-11-10' })
    expect(olderKeep(items)).toEqual([{ rowId: 'kw:k1', action: 'PAUSE', keepUntil: '2026-11-10' }])
    expect(unknownAction(new Error('items.0.action: Invalid enum value. Expected \'PAUSE\' | …'))).toBe(true)
    expect(unknownAction(new Error('Not in this business'))).toBe(false)
    expect(keepWord(null)).toBe('Always')
    expect(keepWord('2026-11-10')).toBe('10 Nov')
    expect(saveWords([step({ action: 'KEEP_UNTIL' })])).toBe('Keep 1 paused')
    expect(undoWords(['KEEP_UNTIL'], [null])).toBe('Undo: back to Always')
    expect(appliedWords(step({ action: 'KEEP_UNTIL', to: '2026-11-10' }), { status: 'queued' })).toEqual({ ok: true, words: 'Kept paused to 10 Nov' })
  })
  it('S1: Done says where it went — Nexus only is never "Sent"', () => {
    expect(appliedWords(step({ lands: 'nexus' }), { status: 'queued' })).toEqual({ ok: true, words: 'Saved in Nexus' })
    expect(doneLine([step({ lands: 'nexus' })], { status: 'queued' })).toBe('Saved in Nexus: nothing is sent to Amazon')
    expect(doneLine([step()], { status: 'queued' })).toBe('Sends to Amazon in 20 s · Undo stops it')
  })
  it('M9 / N1: a negative over our keyword — a wasting one keeps Pause, Remove negative… is its second action', () => {
    const neg = { rowId: 'neg:n9', text: 'rain jacket', match: 'EXACT' as const, level: 'AD_GROUP' as const, campaign: ref('c1'), adGroup: ref('g1'), owner: { kind: 'PERSON' as const, name: 'You', id: null } }
    const clashRow = row({ clash: { kind: 'NEG_OVER_OWN_KEYWORD', label: 'Negative over our own keyword', negative: neg }, verb: { action: 'REMOVE_NEGATIVE', where: 'adGroup', held: null, targetRowId: 'neg:n9' } })
    expect(wasteVerb(clashRow)).toMatchObject({ action: 'PAUSE', primary: true, second: { action: 'REMOVE_NEGATIVE', targetRowId: 'neg:n9', primary: false, held: null } })
    // Not wasting: removing the negative is its one action, never the blue fill.
    expect(wasteVerb({ ...clashRow, test: { ...clashRow.test, met: false } })).toMatchObject({ action: 'REMOVE_NEGATIVE', targetRowId: 'neg:n9', primary: false })
    const harvestNeg = { ...neg, owner: { kind: 'HARVEST' as const, name: 'Harvest', id: null } }
    const harvest = row({ clash: { kind: 'NEG_OVER_OWN_KEYWORD', label: 'x', negative: harvestNeg }, verb: { action: 'REMOVE_NEGATIVE', where: 'adGroup', held: { label: 'Harvest', reason: 'Harvest keeps it' }, targetRowId: 'neg:n9' } })
    expect(wasteVerb(harvest)?.second?.held).toBe('Harvest keeps it')
    // The API may already send Pause as the verb: the second action comes from clash.negative, held by its owner.
    const fromPause = row({ clash: { kind: 'NEG_OVER_OWN_KEYWORD', label: 'x', negative: harvestNeg } })
    expect(wasteVerb(fromPause)).toMatchObject({ action: 'PAUSE', second: { targetRowId: 'neg:n9', held: 'Harvest keeps it' } })
    // Bulk Pause includes it (audit N1).
    expect(wasteBulkPlan([clashRow], 'pause').items).toEqual([{ rowId: 'kw:k1', action: 'PAUSE' }])
  })
  it('S3: the blue fill only for a row that wastes', () => {
    expect(wasteVerb(row())?.primary).toBe(true)
    expect(wasteVerb(row({ test: { ...row().test, met: false } }))?.primary).toBe(false)
  })
  it('N3: the Waiting list counts asks, as its tile does (the redesign: the toolbar count, wasteModel toolbarCount)', () => {
    const words = (asks: number | undefined, places: number) => toolbarCount({ view: 'wasting', show: 'waiting', kind: 'all', total: places, totals: asks == null ? null : { wasting: 0, keywords: 0, terms: 0, waiting: asks, keptPaused: 0, negated: 0, clashes: 0, skipped: 0 }, currency: 'EUR' }).map((p) => `${p.n}${p.words}`).join(' · ')
    expect(words(4, 5)).toBe('4 asks · 5 places')
    expect(words(1, 1)).toBe('1 ask')
    expect(words(undefined, 5)).toBe('5 rows')
  })
  it('M1: a campaign-wide negative says "whole campaign"', () => {
    expect(verbLabel('NEGATE_EXACT', 'campaign')).toBe('Negative exact · whole campaign')
  })
  it('keep paused in bulk: every paused keyword gets its lock\'s end (KEEP_UNTIL)', () => {
    const kept = stopped({ id: 'kw:k1', kind: 'KEYWORD', state: 'KEPT_PAUSED', actions: { turnOn: { allowed: true, why: '' }, removeNegative: { allowed: false, why: '' }, release: { allowed: true, why: '' } } })
    const paused = stopped({ id: 'kw:k2', kind: 'KEYWORD', state: 'PAUSED' })
    expect(stoppedBulkPlan([kept, paused], 'keepUntil', '2026-12-01').items).toEqual([
      { rowId: 'kw:k1', action: 'KEEP_UNTIL', keepUntil: '2026-12-01' },
      { rowId: 'kw:k2', action: 'KEEP_UNTIL', keepUntil: '2026-12-01' },
    ])
  })
})

describe('NFIX — Since and the asks the page lists for what waits', () => {
  it('Since: the day, or "—" with why it is not known; a kept-paused keyword names its lock\'s end', () => {
    expect(sinceView(stopped({ sinceWhy: 'Added on this day: the Brain\'s write' }))).toEqual({ text: '1 Oct', hint: 'Added on this day: the Brain\'s write' })
    const unknown = sinceView(stopped({ since: null, sinceSource: null, sinceWhy: 'Added before Nexus kept a record: Nexus first saw it on 11 Oct 2026, in one sync with 311 other negatives' }))
    expect(unknown).toEqual({ text: '—', hint: 'Added before Nexus kept a record: Nexus first saw it on 11 Oct 2026, in one sync with 311 other negatives' })
    // An older answer with no words still says why there is no day.
    expect(sinceView(stopped({ since: null, sinceSource: null }))).toEqual({ text: '—', hint: 'Not on record' })
    expect(sinceView(stopped({ id: 'kw:k1', keptPaused: { by: ref('u1', 'You'), at: '2026-10-01T10:00:00.000Z', until: null, reason: null } })).hint).toBe('Kept paused, always')
  })

  it('a row listed only for its ask decides with the ask\'s own verb (a removal too); a clash row\'s Remove is not its ask', () => {
    const waiting = { approvalId: 'plan1', by: ref('brain', 'Brain'), at: '2026-10-11T05:30:00.000Z', expiresAt: null, rows: 3 }
    const removal = term({ id: 'neg:n1', state: 'NEGATED', verb: { action: 'REMOVE_NEGATIVE', where: 'adGroup', held: null, targetRowId: 'neg:n1' }, waiting, askOnly: true })
    expect(waitingOf([removal])).toMatchObject([{ approvalId: 'plan1', what: 'Remove negative', by: 'Brain', places: 3 }])
    const clash = row({ verb: { action: 'REMOVE_NEGATIVE', where: 'adGroup', held: null, targetRowId: 'neg:n2' }, waiting: { ...waiting, approvalId: 'pause1', rows: 1 } })
    expect(waitingOf([clash])[0].what).toBeUndefined()
    const phrase = term({ id: 'term:IT|G|cheap', text: 'cheap', match: 'PHRASE', test: { ...row().test, met: false }, verb: { action: 'NEGATE_PHRASE', where: 'adGroup', held: null }, waiting, askOnly: true })
    expect(waitingOf([phrase])[0].what).toBe('Negative phrase')
    // Its verb is the ask's: a quiet button that opens the ask (the view opens the record for any waiting row).
    expect(wasteVerb(phrase)).toMatchObject({ action: 'NEGATE_PHRASE', primary: false })
  })
})

describe('NFIX — a request is decided whole: the review lists every step of a change plan', () => {
  const wait = (approvalId: string, over: Partial<Parameters<typeof decideLines>[0][number]> = {}) => ({ rowId: 'term:IT|G|cheap', approvalId, text: 'cheap', by: 'Brain', what: 'Negative phrase', place: [ref('pf1'), ref('c1'), ref('g1')], places: 1, ...over })
  const step = (n: number, tool: string, onPage: boolean, changes: Array<{ label: string; from: string | null; to: string | null }>, over: Partial<WaitingSteps['steps'][number]> = {}) => ({
    step: n, tool, words: tool, onPage, status: 'pending', where: { name: 'Boots exact', href: '/marketing/ads/campaigns/c1' }, changes, changeCount: changes.length, summary: null, hidden: null, ...over,
  })
  const plan: WaitingSteps = {
    approvalId: 'plan1', status: 'pending', plan: true, title: 'made up', offPage: 1,
    steps: [
      step(1, 'Add negatives', true, [{ label: 'Negative phrase "cheap" (ad group "g1")', from: null, to: 'Added' }]),
      step(2, 'Change a target\'s bid', false, [{ label: 'Bid', from: '0.40', to: '0.50' }], { changeCount: 3 }),
      step(3, 'Remove negatives', true, [], { hidden: 'Its details need the permissions of Remove negatives.' }),
    ],
  }

  it('every step\'s every change — the ones this page does not show too — each noted as approved together', () => {
    const lines = decideLines([wait('plan1')], new Map([['plan1', plan]]), 'approve')
    expect(lines.map((l) => [l.id, l.what, l.now, l.next])).toEqual([
      ['plan1#1.0', 'Add negatives · Negative phrase "cheap" (ad group "g1")', '—', 'Added'],
      ['plan1#2.0', 'Change a target\'s bid · Bid', '0.40', '0.50'],
      ['plan1#2.more', 'Change a target\'s bid · and 2 more changes', '—', 'Approved'],
      ['plan1#3', 'Remove negatives', '—', 'Approved'],
    ])
    expect(lines.every((l) => l.approvalId === 'plan1' && l.note?.startsWith('Approved together · 3 steps · Brain'))).toBe(true)
    expect(lines[1]).toMatchObject({ offPage: true, whereLink: { name: 'Boots exact' }, note: expect.stringMatching(/not on this page$/) })
    expect(lines[3].note).toMatch(/Its details need the permissions/)
    expect(decideSummary([wait('plan1')], new Map([['plan1', plan]]), 'approve')).toBe('This request is approved whole: every change below runs together, 1 step not on this page included.')
    expect(decideLines([wait('plan1')], new Map([['plan1', plan]]), 'reject')[0].note).toMatch(/^Rejected together/)
  })

  it('a request that is one change on this page (or a rule\'s card, not read) reads as its row did', () => {
    const single: WaitingSteps = { approvalId: 'one', status: 'pending', plan: false, title: null, offPage: 0, steps: [step(1, 'Pause', true, [{ label: 'Keyword', from: 'Enabled', to: 'Paused' }])] }
    const steps = new Map<string, WaitingSteps | null>([['one', single]])
    expect(decideLines([wait('one', { what: 'Pause', text: 'rain jacket' }), wait('suggestion:c1', { what: undefined, text: 'kids', places: 2 })], steps, 'approve')).toEqual([
      expect.objectContaining({ id: 'one', what: 'Pause · rain jacket', now: 'Waiting · Brain', next: 'Approved' }),
      expect.objectContaining({ id: 'suggestion:c1', what: 'kids', note: 'One answer · 2 rows here' }),
    ])
    expect(decideSummary([wait('one')], steps, 'approve')).toBeNull()
  })
})

describe('NFIX — an ask that is a change plan says so (the record and the row\'s mark)', () => {
  it('names its steps and how many are not on this page; a single request says nothing', () => {
    expect(planWords({ steps: 2, offPage: 1 })).toBe('Plan · 2 steps (1 not on this page)')
    expect(planWords({ steps: 3, offPage: 0 })).toBe('Plan · 3 steps')
    expect(planWords(undefined)).toBeNull()
  })
})

describe('the redesign (2026-10-26): the frame\'s words, the chips, the rows\' ⋯', () => {
  const NOW = Date.parse('2026-10-26T10:00:00Z')
  const totals: WasteTotals = { wasting: 9, wastingSpendCents: 75450, currency: 'EUR', keywords: 4, terms: 5, waiting: 2, keptPaused: 1, negated: 37, clashes: 16, skipped: 4, protected: 3 }

  it('D2: the header line says only what the reads give', () => {
    expect(headerLine({ market: 'IT', freshness: { searchTermsThrough: '2026-10-24', readAt: '2026-10-26T09:54:00Z' }, now: NOW }))
      .toBe('Amazon Italy · stops ads that spend with no orders · search terms to 24 Oct · checked 6 min ago')
    expect(headerLine({ market: 'all', freshness: null })).toBe('Amazon, all markets · stops ads that spend with no orders')
    expect(headerLine({ market: 'IT', freshness: { searchTermsThrough: null, readAt: 'not a day' } })).toBe('Amazon Italy · stops ads that spend with no orders')
  })

  it('D3: every tile has a hint line; the Wasting money says its window when the server gives it', () => {
    const t = tilesOf({ waste: totals, stopped: null, view: 'wasting', wastingShow: 'wasting', stoppedShow: 'all', currency: 'EUR', windowDays: 60 })
    expect(t.map((x) => x.hint)).toEqual(['€754.50 in 60 days', '2 asks', 'nothing turns them on', 'negatives that block now', 'need a look', 'kept safe by a term'])
    expect(tilesOf({ waste: null, stopped: null, view: 'wasting', wastingShow: 'wasting', stoppedShow: 'all', currency: 'EUR' }).every((x) => !!x.hint)).toBe(true)
  })

  it('D5: the count is in the code\'s units, the money only when the rows are what it counts', () => {
    const c = (show: string, total: number, kind: 'all' | 'term' = 'all') => toolbarCount({ view: 'wasting', show, kind, total, totals, currency: 'EUR' }).map((p) => `${p.n}${p.words}`).join(' · ')
    expect(c('wasting', 9)).toBe('9 rows · €754.50')
    expect(c('wasting', 5, 'term')).toBe('5 rows')
    expect(c('waiting', 3)).toBe('2 asks · 3 places')
    expect(c('waiting', 2)).toBe('2 asks')
    expect(c('clashes', 16)).toBe('16 rows')
    expect(c('wasting', 0)).toBe('0 rows')
    expect(toolbarCount({ view: 'stopped', show: 'all', kind: 'all', total: 59, totals: null, currency: 'EUR' })).toEqual([{ n: '59', words: ' rows' }])
    expect(tickedCount(3)).toEqual([{ n: '3', words: ' ticked' }])
  })

  it('D4: Kind in the brief\'s words; the view\'s own fields that filter', () => {
    expect(KIND_WORDS).toEqual({ all: 'All', keyword: 'Our keywords and targets', term: 'Search terms' })
    expect(ownFilterCount('wasting', 'all', 'wasting')).toBe(0)
    expect(ownFilterCount('wasting', 'term', 'waiting')).toBe(2)
    expect(ownFilterCount('stopped', 'all', 'all')).toBe(0)
    expect(ownFilterCount('stopped', 'all', 'kept')).toBe(1)
    expect(wastingChips(totals).map((c) => [c.id, c.count])).toEqual([['wasting', 9], ['waiting', 2], ['skipped', 4], ['turned-on', null], ['clashes', 16], ['protected', 3], ['all', null]])
  })

  it('D7 / D8: the pager line, always; the note in the code\'s own words', () => {
    expect(pagerWords(1, 50, 9)).toBe('1–9 of 9')
    expect(pagerWords(2, 50, 59)).toBe('51–59 of 59')
    expect(pagerWords(1, 50, 0)).toBe('0 of 0')
    expect(noteLine('wasting', { sentence: ' Search terms: 0 orders. ' })).toBe('Search terms: 0 orders.')
    expect(noteLine('wasting', null)).toBeNull()
    expect(noteLine('stopped', null)).toMatch(/^Spend before: spend in the 30 days before it stopped · Saved \(did it work\?\)/)
  })

  it('D6: the state is one chip with a word; Wasting only for a row whose test is met', () => {
    expect(stateChip(row())).toEqual({ word: 'Wasting', tone: 'danger', mark: 'play', title: 'Running' })
    expect(stateChip(row({ test: { ...row().test, met: false } }))).toMatchObject({ word: 'Running', tone: 'neutral' })
    expect(stateChip(term({ state: 'PROTECTED', protection: { terms: [{ id: 'p1', term: 'waterproof', match: 'CONTAINS', market: 'IT', campaign: null, reason: null }], then: null } })))
      .toEqual({ word: 'Protected', tone: 'success', mark: 'shield', title: 'Protected by "waterproof": never negated' })
    expect(stateChip(row({ state: 'TURNED_ON_ELSEWHERE' }))).toMatchObject({ word: 'Turned on', tone: 'warning', title: 'Kept paused, but turned on outside Nexus: it spends again' })
    expect(stateChip(stopped())).toMatchObject({ word: 'Blocked', tone: 'info', mark: 'ban', title: 'Negative exact in this ad group' })
    expect(stateChip(stopped({ state: 'NOT_AT_AMAZON' }))).toMatchObject({ word: 'Not at Amazon', tone: 'neutral' })
    expect(stateChip(stopped({ id: 'kw:k1', state: 'KEPT_PAUSED', keptPaused: { by: ref('u', 'You'), at: '', until: null, reason: null } }))).toMatchObject({ word: 'Kept paused', tone: 'info', mark: 'pause' })
  })

  it('D12: a waiting row says who asked; a rule\'s card is "Rule", its name in the hover', () => {
    const waiting = { approvalId: 'suggestion:c1', by: ref('r1', 'Stop wasting glove terms'), at: '2026-10-26T05:00:00Z', expiresAt: '2026-11-01T10:00:00Z' }
    expect(stateChip(term({ waiting }), NOW)).toEqual({ word: 'Waiting', tone: 'warning', mark: 'hourglass', title: 'Waiting for you · asked by Stop wasting glove terms 5 h ago · expires in 6 d' })
    expect(stateChip(term({ waiting: { ...waiting, approvalId: 'a1', by: ref('brain', 'Brain') } }), NOW).word).toBe('Waiting')
    expect(decideAria('approve', term({ text: 'rain cover', waiting: { ...waiting, rows: 2 } }))).toBe('Approve rain cover · 2 rows')
    expect(decideAria('reject', term({ text: 'glove liner', waiting }))).toBe('Reject glove liner')
  })

  it('D6: the line under the chip — a clash, a follow-up, a skip; a turned-on keyword\'s chip says it already', () => {
    expect(stateSub(row({ clash: { kind: 'NEG_OVER_OWN_KEYWORD', label: 'Negative over our own keyword' } }))).toEqual({ word: 'Negative over our own keyword', tone: 'danger', mark: 'warn' })
    expect(stateSub(row({ state: 'TURNED_ON_ELSEWHERE', clash: { kind: 'TURNED_ON', label: 'Turned on outside Nexus' } }))).toBeNull()
    expect(stateSub(row({ skipped: { until: '2026-11-03', by: null, at: null } }))).toEqual({ word: 'Skipped until 3 Nov', tone: 'muted', mark: 'clock' })
    expect(stateSub(row({ state: 'PROTECTED', skipped: { until: '2026-11-24', by: null, at: null } }), { keptProtected: 'Kept protected until 24 Nov 2026' })?.word).toBe('Kept protected until 24 Nov 2026')
    expect(stateSub(row({ followUp: { status: 'WAITING', why: null, at: '' } }), { followUp: 'Its protection is being removed' })).toMatchObject({ tone: 'muted', mark: 'hourglass' })
    expect(stateSub(row())).toBeNull()
  })

  it('D6: a Wasting row\'s ⋯ — its second verb, Skip (or Unskip), Open record; never a skip for a keyword turned on elsewhere', () => {
    const ids = (e: ReturnType<typeof wasteRowMenu>) => e.map((x) => x.id)
    expect(ids(wasteRowMenu(term(), null))).toEqual(['skip7', 'skip30', 'sep-record', 'record'])
    expect(ids(wasteRowMenu(term({ skipped: { until: '2026-11-03', by: null, at: null } }), null))).toEqual(['unskip', 'sep-record', 'record'])
    expect(ids(wasteRowMenu(row({ state: 'TURNED_ON_ELSEWHERE' }), null))).toEqual(['record'])
    const clash = wasteRowMenu(row({ clash: { kind: 'NEG_OVER_OWN_KEYWORD', label: 'x', negative: { rowId: 'neg:n9', text: 'rain jacket', match: 'EXACT', level: 'AD_GROUP', campaign: ref('c1'), adGroup: ref('g1'), owner: { kind: 'NONE', name: '—', id: null } } } }), 'You can see ads here, not change them')
    expect(clash[0]).toMatchObject({ id: 'REMOVE_NEGATIVE', label: 'Remove negative…', held: 'You can see ads here, not change them', ask: { kind: 'change', item: { rowId: 'kw:k1', action: 'REMOVE_NEGATIVE', targetRowId: 'neg:n9' } } })
    expect(clash.at(-1)).toMatchObject({ id: 'record', held: null })
  })

  it('D13: a Stopped row\'s ⋯ — the record footer\'s other verbs, then Open record', () => {
    const ids = (e: ReturnType<typeof stoppedRowMenu>) => e.map((x) => x.id)
    expect(ids(stoppedRowMenu(stopped(), null, NOW))).toEqual(['record'])
    expect(ids(stoppedRowMenu(stopped({ id: 'kw:k1', state: 'TURNED_ON_ELSEWHERE' }), null, NOW))).toEqual(['pause', 'sep-record', 'record'])
    const kept = stoppedRowMenu(stopped({ id: 'kw:k1', state: 'KEPT_PAUSED', keptPaused: { by: ref('u'), at: '', until: '2026-11-10', reason: null } }), null, NOW)
    expect(ids(kept)).toEqual(['keep', 'keep7', 'keep30', 'keepAlways', 'sep-release', 'release', 'sep-record', 'record'])
    expect(kept[1]).toMatchObject({ label: '7 d', ask: { kind: 'change', item: { rowId: 'kw:k1', action: 'KEEP_UNTIL', keepUntil: '2026-11-02' }, keepFrom: '2026-11-10' } })
    expect(kept[5]).toMatchObject({ label: 'Release lock', held: 'Not kept paused' })
    const paused = stoppedRowMenu(stopped({ id: 'kw:k2', state: 'PAUSED' }), 'You can see ads here, not change them', NOW)
    expect(paused[0]).toEqual({ id: 'keep', heading: 'Keep paused' })
    expect(paused[3]).toMatchObject({ label: 'Always', held: 'You can see ads here, not change them', ask: { item: { keepUntil: null }, keepFrom: 'NOT_KEPT' } })
  })
})
