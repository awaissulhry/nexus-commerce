import { describe, expect, it } from 'vitest'
import type { HarvestCandidateRow } from '../_shared/types'
import {
  approveHeld, barWords, bulkHeld, currencyOfRow, harvestSourceOf, rowMoney, waitingDecision, bulkSplit, copyText, countWords, decideButtonWords, decideChanges, decideDoneLine, decideHeld, emptyWords,
  goesToText, harvestHeld, harvestToHeld, historyStateOf, inSourceWords, isTermTab, isTermsShow, listStates, productsOf, requestIds, roleWord,
  rowNumbers, showMatches, skipChanges, skipHeld, statusOf, undoChanges, undoHeld, undoWhyWords, unskipChanges, unskipHeld,
} from './termsModel'

const NOW = Date.parse('2026-10-11T12:00:00Z')
const DAY = 86_400_000
const ref = (id: string, name = id) => ({ id, name, href: `/x/${id}` })

function row(over: Partial<HarvestCandidateRow> = {}): HarvestCandidateRow {
  return {
    id: 'IT|p1|mesh jacket', term: 'mesh jacket', kind: 'keyword', market: 'IT', currency: 'EUR',
    product: ref('p1', 'Jacket'),
    source: { portfolio: null, campaign: ref('c-auto', 'Jacket Auto'), adGroup: ref('g-auto', 'Auto group'), role: 'AUTO' },
    sources: [{ portfolio: null, campaign: ref('c-auto', 'Jacket Auto'), adGroup: ref('g-auto', 'Auto group'), role: 'AUTO', clicks: 40, action: 'negate', why: 'stops paying' }],
    metrics: { windowDays: 60, impressions: 400, clicks: 40, orders: 4, spendCents: 1600, salesCents: 16000, acosPct: 10, cpcCents: 40 },
    bar: { by: 'brain', label: '1+ order · ACoS under band', passes: true },
    state: 'READY', owner: { kind: 'NONE', id: null, name: 'Nobody' }, heldBy: null,
    destination: { kind: 'existing', how: 'own', portfolio: ref('pf', 'Jackets'), campaign: ref('c-exact', 'Jacket Exact'), adGroup: ref('g-exact', 'Exact group'), match: 'EXACT', status: 'will-create' },
    funnel: [], startBidCents: 50, bidWhy: null, skipped: null, waiting: null, lastHarvest: null,
    ...over,
  }
}
const harvested = (verdict: 'better' | 'worse' | 'too-early' | null, daysAgo: number, status = 'DONE') =>
  row({ state: 'HARVESTED', lastHarvest: { harvestId: 'h1', at: new Date(NOW - daysAgo * DAY).toISOString(), by: { kind: 'PERSON', id: null }, status, verdict, undo: { available: true, why: null }, keyword: { state: 'ENABLED' }, judge: null } })
const waiting = (approvalId: string, term = 'mesh jacket', product = 'Jacket') =>
  row({ id: `IT|p1|${term}`, term, product: ref(product, product), state: 'WAITING', waiting: { approvalId, by: { kind: 'BRAIN', id: null }, at: new Date(NOW - 3_600_000).toISOString(), expiresAt: null } })

describe('tiles filter exactly what the server counts (audit M1)', () => {
  it('Ready, Waiting (approvable), Harvested · 60 d (older harvests out), Worse', () => {
    expect(showMatches(row(), 'ready', NOW)).toBe(true)
    expect(showMatches(waiting('a1'), 'waiting', NOW)).toBe(true)
    expect(showMatches(harvested(null, 10), 'harvested', NOW)).toBe(true)
    expect(showMatches(harvested(null, 40), 'harvested', NOW)).toBe(true)
    expect(showMatches(harvested(null, 70), 'harvested', NOW)).toBe(false)
    const stale = { ...waiting('r1'), waiting: { approvalId: 'r1', kind: 'rule-ask' as const, by: { kind: 'RULE', id: 'x' }, at: '', expiresAt: null, stale: { why: 'The rule changed after it asked.' } } }
    expect(showMatches(stale, 'waiting', NOW)).toBe(false)
    // "N out of date" filters to exactly those (functional walk).
    expect(showMatches(stale, 'stale', NOW)).toBe(true)
    expect(showMatches(waiting('a1'), 'stale', NOW)).toBe(false)
    expect(isTermsShow('stale')).toBe(true)
    expect(statusOf(stale)).toEqual({ word: 'Out of date', tone: 'neutral', hint: 'The rule changed after it asked.' })
    expect(showMatches(harvested('worse', 40), 'worse', NOW)).toBe(true)
    expect(showMatches(harvested('better', 5), 'worse', NOW)).toBe(false)
    expect(showMatches(row(), null, NOW)).toBe(true)
  })
  it('knows its params', () => {
    expect(isTermsShow('worse')).toBe(true)
    expect(isTermsShow('skipped')).toBe(false)
    expect(listStates('skipped')).toEqual(['SKIPPED'])
    expect(listStates('open')).toBeNull()
    expect(isTermTab('where')).toBe(true)
  })
})

describe('words', () => {
  it('count and empty states', () => {
    expect(countWords(3, 48, true)).toBe('3 of 48')
    expect(countWords(48, 48, false)).toBe('48 terms')
    expect(countWords(1, 1, false)).toBe('1 term')
    expect(emptyWords({ show: null, list: 'open', search: '', any: false })).toEqual({ title: 'Nothing to harvest', clear: false })
    expect(emptyWords({ show: 'worse', list: 'open', search: '', any: true })).toEqual({ title: 'No terms match', clear: true })
    expect(emptyWords({ show: null, list: 'skipped', search: '', any: false })).toEqual({ title: 'Nothing skipped', clear: true })
  })
  it('status: one plain word per state, the hold\'s own label, verdicts', () => {
    expect(statusOf(row()).word).toBe('Ready')
    expect(statusOf(waiting('a1'), NOW).word).toBe('Waiting for you')
    expect(statusOf(waiting('a1'), NOW).hint).toBe('Brain asked 1 h ago')
    expect(statusOf({ ...waiting('a1'), waiting: { approvalId: 'a1', by: { kind: 'PERSON', id: null }, at: new Date(NOW - 3_600_000).toISOString(), expiresAt: new Date(NOW + 17 * 3_600_000).toISOString() } }, NOW).hint)
      .toBe('Asked 1 h ago · expires in 17 h')
    expect(statusOf(harvested('better', 5), NOW).word).toBe('Better')
    expect(statusOf(harvested('worse', 5), NOW).tone).toBe('danger')
    expect(statusOf(harvested(null, 5), NOW).word).toBe('Not checked yet')
    expect(statusOf(row({ state: 'NEEDS_DESTINATION', heldBy: { kind: 'destination', label: 'Paused', reason: 'The exact campaign is paused.' } })))
      .toEqual({ word: 'Paused', tone: 'warning', hint: 'The exact campaign is paused.' })
    expect(statusOf(row({ state: 'SKIPPED', skipped: { until: null, by: 'user:u1', at: null } })).hint).toBe('Skipped for good')
    expect(statusOf(row({ state: 'AT_HOME' })).word).toBe('Already a keyword')
    expect(statusOf(row({ state: 'OWNED_BY_SIBLING' })).word).toBe('Other product')
  })
  it('the place a harvest goes, and where it was found', () => {
    expect(goesToText(row())).toBe('Jackets › Jacket Exact › Exact group')
    expect(goesToText(row({ destination: { kind: 'new', how: 'new', match: 'EXACT', plan: { name: 'SKU-SP-Keyword-Exact-Harvest', adGroupName: 'g', portfolio: null } } }))).toBe('New campaign · SKU-SP-Keyword-Exact-Harvest')
    expect(goesToText(row({ destination: null }))).toBe('')
    expect(roleWord('BROAD')).toBe('Broad')
    expect(roleWord(null)).toBeNull()
    expect(inSourceWords(row().sources)).toBe('1 ad group')
    expect(barWords('1+ order · ACoS under band')).toBe('1+ order · ACoS under target')
    expect(inSourceWords([{ action: 'kept' }])).toBe('Keeps running')
    expect(historyStateOf('DONE')).toBe('live')
    expect(historyStateOf('UNDONE')).toBe('undone')
    expect(historyStateOf('FAILED')).toBe('failed')
    // M3: never "Live" when the keyword does not run.
    expect(historyStateOf('DONE', { keyword: { state: 'PAUSED' } })).toBe('paused')
    expect(historyStateOf('DONE', { keyword: { state: 'ENABLED' } })).toBe('live')
    expect(historyStateOf('DONE', { keyword: { state: 'ARCHIVED' } })).toBe('undone')
    expect(historyStateOf('DONE', { keyword: { state: null } })).toBe('off')
    expect(historyStateOf('DONE', { keyword: null })).toBe('off')
  })
})

describe('verbs: what each row offers, each held one says why', () => {
  it('harvest and harvest to', () => {
    expect(harvestHeld(row())).toBeNull()
    expect(harvestHeld(row({ state: 'NEEDS_CAMPAIGN' }))).toBeNull()
    expect(harvestHeld(row({ state: 'NEEDS_DESTINATION' }))).toBeTruthy()
    expect(harvestToHeld(row({ state: 'NEEDS_DESTINATION' }))).toBeNull()
    expect(harvestToHeld(row({ state: 'HELD', heldBy: { kind: 'destination', label: 'Paused', reason: 'r' } }))).toBeNull()
    expect(harvestToHeld(row({ state: 'HELD', heldBy: { kind: 'bid', label: 'No bid', reason: 'No start bid yet.' } }))).toBe('No start bid yet.')
    expect(harvestToHeld(waiting('a1'))).toBe('Waits for you: approve or reject it')
  })
  it('a stale rule ask holds Approve with the server\'s why and keeps Reject; bulk leaves it out', () => {
    const stale = { ...waiting('r1', 'rain jacket'), waiting: { approvalId: 'r1', kind: 'rule-ask' as const, by: { kind: 'RULE', id: 'rule-1', name: 'Rule' }, at: '', expiresAt: null, stale: { why: 'Its rule was edited after it asked.' } } }
    expect(approveHeld(stale)).toBe('Its rule was edited after it asked.')
    expect(decideHeld(stale)).toBeNull()
    const s = bulkSplit([stale, waiting('a1')])
    expect(s.decide).toHaveLength(2)
    expect(s.approve).toHaveLength(1)
    expect(bulkHeld('approve', 0, 1)).toBe('No ticked request can be approved now')
    // The one waiting decision (Terms and the rule modal): approve leaves the stale one out and counts it; reject takes it.
    const other = waiting('a1', 'other')
    expect(waitingDecision('approve', [stale, other], [stale, other, waiting('a1', 'same request')])).toMatchObject({ leftOut: 1 })
    expect(waitingDecision('approve', [stale, other], [stale, other, waiting('a1', 'same request')]).rows.map((r) => r.term)).toEqual(['other', 'same request'])
    expect(waitingDecision('reject', [stale]).rows).toHaveLength(1)
  })
  it('decide, skip, unskip, undo', () => {
    expect(decideHeld(waiting('a1'))).toBeNull()
    expect(decideHeld(row())).toBeTruthy()
    expect(skipHeld(row())).toBeNull()
    expect(skipHeld(row({ state: 'BELOW_BAR' }))).toBeNull()
    expect(skipHeld(harvested(null, 1))).toBe('Already harvested')
    expect(skipHeld(row({ state: 'SKIPPED' }))).toBe('Already skipped')
    expect(unskipHeld(row({ state: 'SKIPPED' }))).toBeNull()
    expect(undoHeld(harvested(null, 1))).toBeNull()
    expect(undoHeld(harvested(null, 1, 'UNDONE'))).toBe('Already undone')
    // M3: the server's own answer holds Undo, in short words.
    const refused = { ...harvested(null, 1), lastHarvest: { ...harvested(null, 1).lastHarvest!, undo: { available: false, why: 'Nothing of it is left to put back: its keyword is not running.' } } }
    expect(undoHeld(refused)).toBe('Already undone')
    expect(undoWhyWords('An undo of it waits for a person.')).toBe('An undo of it waits for you')
    expect(undoHeld(row())).toBe('Not harvested')
  })
  it('a selection splits by what each bulk action takes; none → why', () => {
    const rows = [row(), waiting('a1', 'b'), harvested(null, 2), row({ id: 's', state: 'SKIPPED' })]
    const s = bulkSplit(rows)
    expect(s.harvest).toHaveLength(1)
    expect(s.decide).toHaveLength(1)
    expect(s.undo).toHaveLength(1)
    expect(s.unskip).toHaveLength(1)
    expect(s.skip).toHaveLength(1)
    expect(bulkHeld('decide', 0, 2)).toBe('No ticked term waits for you')
    expect(bulkHeld('decide', 0, 0)).toBe('Tick terms first')
    expect(bulkHeld('harvest', 3, 3)).toBeNull()
    expect(productsOf([row(), row({ product: ref('p2') })])).toBe(2)
  })
})

describe('reviews', () => {
  it('skip and unskip: one row per term, Nexus words', () => {
    expect(skipChanges([row()], 7)[0]).toMatchObject({ id: 'IT|p1|mesh jacket', where: 'Jacket', what: 'mesh jacket', now: 'Ready', next: 'Skipped · 7 d' })
    expect(skipChanges([row()], null)[0].next).toBe('Skipped for good')
    expect(unskipChanges([row({ state: 'SKIPPED', skipped: { until: null, by: null, at: null } })])[0]).toMatchObject({ now: 'Skipped for good', next: 'Shown' })
  })
  it('Approve shows every write of each request, in Keywords and Negatives (M5), and counts requests (M4)', () => {
    const one = { ...waiting('a1', 'one'), destination: row().destination, startBidCents: 130, funnel: [{ campaign: ref('c-ph', 'Jacket Phrase'), adGroup: ref('g-ph', 'Phrase group'), match: 'EXACT' as const }] }
    const two = waiting('a1', 'two')
    const three = waiting('a2', 'three', 'Gloves')
    const changes = decideChanges([one, two, three], 'approve', NOW)
    const kw = changes.filter((c) => c.group === 'keywords')
    expect(kw).toHaveLength(3)
    expect(kw[0]).toMatchObject({ approvalId: 'a1', where: 'Jacket Exact › Exact group', what: 'one', now: 'CPC €0.40', next: 'Exact · €1.30', note: 'Brain asked 1 h ago' })
    const neg = changes.filter((c) => c.group === 'negatives' && c.what === 'one')
    expect(neg.map((c) => [c.where, c.next, c.note])).toEqual([['Jacket Auto › Auto group', 'Negative exact', 'Where found'], ['Jacket Phrase › Phrase group', 'Negative exact', 'Wider match']])
    expect(decideChanges([one], 'reject', NOW)[0]).toMatchObject({ now: 'Exact · €1.30', next: 'Not sent' })
    expect(requestIds([one, two, three])).toEqual(['a1', 'a2'])
    expect(decideButtonWords('approve', [one, two, three])).toEqual({ label: 'Approve 2', long: 'Approve 2 requests · 3 terms' })
    expect(decideButtonWords('reject', [three])).toEqual({ label: 'Reject 1', long: 'Reject 1 request' })
    // A request's own count of terms wins (it may cover terms the list does not hold); a rule's ask names the rule.
    const ask = { ...waiting('r1', 'rain jacket'), waiting: { approvalId: 'r1', kind: 'rule-ask' as const, by: { kind: 'RULE', id: 'rule-1', name: 'TEST Harvest exact' }, at: new Date(NOW - 7_200_000).toISOString(), expiresAt: null, terms: 2 } }
    expect(decideButtonWords('approve', [ask])).toEqual({ label: 'Approve 1', long: 'Approve 1 request · 2 terms' })
    expect(decideChanges([ask], 'approve', NOW)[0].note).toBe('TEST Harvest exact asked 2 h ago')
    expect(decideDoneLine('approve', new Map([['a1', true], ['a2', false]]))).toEqual({ line: '1 request approved · 1 not approved', tone: 'warning' })
  })
  it('undo: one row per harvest record, the keyword paused', () => {
    const c = undoChanges([harvested(null, 1), row()])
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ id: 'h1', what: 'mesh jacket', next: 'Keyword paused' })
  })
  it('a harvested row shows its keyword\'s own numbers since the harvest (S7)', () => {
    const h = { ...harvested('better', 12), sinceHarvest: { days: 12, clicks: 20, orders: 2, spendCents: 800, salesCents: 8000, acosPct: 10 } }
    expect(rowNumbers(h)).toMatchObject({ since: 12, orders: 2, cpcCents: 40, acosPct: 10 })
    expect(rowNumbers(row())).toMatchObject({ since: null, orders: 4, windowDays: 60 })
  })
  it('R4: Approve lists EVERY write of the request — its new campaign, each keyword, each block where found, each wider block', () => {
    const plan = {
      ...waiting('a9', 'new term'),
      destination: { kind: 'new' as const, how: 'new' as const, match: 'EXACT' as const, plan: { name: 'SKU-SP-Keyword-Exact-Harvest', adGroupName: 'SKU-SP-Keyword-Exact-Harvest Ad Group', portfolio: ref('pf', 'Jackets'), dailyBudgetCents: 1000 } },
      startBidCents: 50,
      funnel: [{ campaign: ref('c-ph', 'Jacket Phrase'), adGroup: ref('g-ph', 'Phrase group'), match: 'EXACT' as const }],
    }
    const twin = { ...plan, id: 'IT|p1|second term', term: 'second term' }
    const c = decideChanges([plan, twin], 'approve', NOW)
    expect(c.filter((x) => x.group === 'campaign')).toHaveLength(1)
    expect(c.find((x) => x.group === 'campaign')).toMatchObject({ what: 'Campaign · SKU-SP-Keyword-Exact-Harvest', where: 'Jackets', next: '€10.00 a day' })
    expect(c.filter((x) => x.group === 'keywords').map((x) => x.what)).toEqual(['new term', 'second term'])
    expect(c.filter((x) => x.group === 'negatives')).toHaveLength(4) // one source + one wider block, per term
  })
  it('R5: each row\'s money in its own market\'s currency, never another row\'s', () => {
    const uk = { ...row({ market: 'UK', currency: null }), metrics: { ...row().metrics, cpcCents: 40 } }
    expect(currencyOfRow(uk)).toBe('GBP')
    expect(rowMoney(uk, 150)).toBe('£1.50')
    expect(rowMoney(row(), 150)).toBe('€1.50')
    const mixed = decideChanges([{ ...waiting('a1', 'it term'), startBidCents: 130 }, { ...waiting('a2', 'uk term'), market: 'UK', currency: 'GBP', startBidCents: 130 }], 'approve', NOW)
    expect(mixed.filter((x) => x.group === 'keywords').map((x) => x.next)).toEqual(['Exact · €1.30', 'Exact · £1.30'])
  })
  it('R7: the Harvest window gets exactly the rows, never a query', () => {
    expect(harvestSourceOf([row()])).toEqual({ rows: [row()] })
    expect('query' in harvestSourceOf([row()])).toBe(false)
  })
  it('copy: one term a line', () => {
    expect(copyText([row(), row({ term: 'b' })])).toBe('mesh jacket\nb')
  })
})
