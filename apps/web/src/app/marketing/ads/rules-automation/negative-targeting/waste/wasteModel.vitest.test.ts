import { describe, expect, it } from 'vitest'
import {
  ackWords, appliedWords, chipOwner, doneLine, isFinal, keepWord, olderKeep, shownSteps, unknownAction, detailTabOf, emptyWords, idKind, kindOf, landsWord, listSearch, previewSummary, saveWords, scopeOf, scopeOptions, scopeParams,
  skipIds, sortOf, sortParam, spendHint, verbLabel, waitingCount, stateSentence, stoppedBulkPlan, stoppedShowOf, stoppedVerb, termOfId, tileQuery, tilesOf, undoWords, viewOf, waitingOf,
  wasteBulkCounts, wasteBulkPlan, wastingShowOf, wasteVerb, xCpaText,
} from './wasteModel'
import type { PreviewStep, StoppedRow, StoppedTotals, WasteRow, WasteTotals } from './wasteTypes'

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
  it('reads a scope and gives the API its params', () => {
    expect(scopeOf('cp:c1')).toEqual({ level: 'cp', id: 'c1' })
    expect(scopeOf('xx:1')).toBeNull()
    expect(scopeParams('it', scopeOf('ag:g1'))).toEqual({ market: 'IT', adGroupId: 'g1' })
    expect(scopeParams('all', scopeOf('pf:p'))).toEqual({ portfolioId: 'p' })
  })
  it('turns a header sort into the server key and back', () => {
    expect(sortParam({ colId: 'spend', dir: 'desc' })).toBe('-spend')
    expect(sortParam({ colId: 'trend', dir: 'asc' })).toBeNull()
    expect(sortOf('-xCpa')).toEqual({ colId: 'xCpa', dir: 'desc' })
    expect(sortOf('bogus')).toBeNull()
  })
  it('builds the list query and leaves out what is empty', () => {
    expect(listSearch({ market: 'IT', scope: null, kind: 'all', show: 'wasting', q: ' ', page: 1, pageSize: 50 })).toBe('?market=IT&show=wasting&pageSize=50')
    expect(listSearch({ market: null, scope: scopeOf('cp:c1'), kind: 'term', show: 'all', q: 'coat', sort: '-spend', page: 2 })).toBe('?campaignId=c1&kind=term&show=all&q=coat&sort=-spend&page=2')
  })
})

describe('verbs', () => {
  it('a running keyword pauses, a running term negates where the server says', () => {
    expect(wasteVerb(row())).toMatchObject({ action: 'PAUSE', where: null, label: 'Pause', short: 'Pause', held: null })
    expect(wasteVerb(term({ verb: { action: 'NEGATE_EXACT', where: 'campaign', held: null } }))).toMatchObject({ label: 'Negative exact · whole campaign', short: 'Negative' })
  })
  it('a held verb stays, with the server\'s reason; a protected row is held', () => {
    expect(wasteVerb(term({ verb: { action: 'NEGATE_EXACT', where: 'adGroup', held: { label: 'Our keyword', reason: 'It would block our own keyword' } } }))?.held).toBe('It would block our own keyword')
    expect(wasteVerb(term({ state: 'PROTECTED' }))?.held).toBe('Protected: never negated')
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
  const waste: WasteTotals = { wasting: 4, wastingSpendCents: 12000, keywords: 2, terms: 2, waiting: 2, keptPaused: 1, negated: 9, clashes: 3, skipped: 0 }
  const stop: StoppedTotals = { all: 12, kept: 2, paused: 1, negated: 9, turnedOn: 0, stillBought: 1, notAtAmazon: 0, inactive: 5 }
  it('each number comes from the read whose table it opens', () => {
    const t = tilesOf({ waste, stopped: stop, view: 'wasting', wastingShow: 'wasting', stoppedShow: 'all', currency: 'EUR' })
    expect(t.map((x) => [x.id, x.value, x.active, x.clickable])).toEqual([
      ['wasting', 4, true, true], ['waiting', 2, false, true], ['kept', 2, false, true], ['blocked', 9, false, true], ['clashes', 3, false, true],
    ])
    expect(t[0].hint).toBe('€120.00')
  })
  it('unknown is a dash, never zero', () => {
    expect(tilesOf({ waste: null, stopped: null, view: 'wasting', wastingShow: 'wasting', stoppedShow: 'all', currency: 'EUR' }).map((x) => x.value)).toEqual([null, null, null, null, null])
  })
  it('a tile goes to its view; the pressed one goes back', () => {
    expect(tileQuery('kept', false)).toMatchObject({ view: 'stopped', show: 'kept' })
    expect(tileQuery('kept', true)).toMatchObject({ view: 'stopped', show: null })
    expect(tileQuery('waiting', false)).toMatchObject({ view: null, show: 'waiting' })
    expect(tileQuery('clashes', false)).toMatchObject({ view: null, show: 'clashes' })
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
  it('the scope picker lists every level once, the scope on now always', () => {
    const opts = scopeOptions([row(), term()], scopeOf('cp:zz'), 'Other campaign')
    expect(opts.map((o) => `${o.group}:${o.label}`)).toEqual(['Campaign:Other campaign', 'Portfolio:Jackets', 'Campaign:Jacket Exact', 'Ad group:Exact group · Jacket Exact'])
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
  it('N3: the Waiting list counts asks, as its tile does', () => {
    expect(waitingCount(4, 5)).toBe('4 asks · 5 places')
    expect(waitingCount(1, 1)).toBe('1 ask')
    expect(waitingCount(null, 5)).toBe('5 rows')
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
