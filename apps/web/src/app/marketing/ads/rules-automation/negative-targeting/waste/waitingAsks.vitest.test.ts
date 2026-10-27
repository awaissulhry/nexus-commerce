/**
 * Negative Targeting page, HONEST 10 · 11 · 12 · 15 · 17 — what waits for a person, in the ask's OWN words:
 *   10  a waiting row words the ask's change (its action, match, level and words), never the row's own verb
 *   11  a request with several changes is not "N places": the review lists each change; one negative in a whole campaign
 *       covers its term's ad groups
 *   12  Approve says what it really does, per kind: a request runs as the approver after the 20 s window (Undo inside
 *       it); a rule's card applies now, as the rule, with no window
 *   15  a row listed only for its ask shows no checks: the page's test never ran on it
 *   17  a skip's History Undo is the page's own Unskip (Nexus only)
 * Values are made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import { approveView, askReachItem, askWords, skipUndoRow, wasteBanner, wasteChecks, wasteMetrics } from './recordModel'
import { decideAfterWords, decideAria, decideLines, decideNoUndo, decideSummary, waitingOf } from './wasteModel'
import type { HistoryItem, WaitingSteps, WasteRow } from './wasteTypes'

const ref = (id: string, name = id) => ({ id, name, href: `/x/${id}` })
const HOUR = 3_600_000

function row(over: Partial<WasteRow> = {}): WasteRow {
  return {
    id: 'kw:k1', kind: 'KEYWORD', text: 'rain jacket', match: 'EXACT', channel: 'AMAZON', market: 'IT', currency: 'EUR',
    portfolio: ref('pf1', 'Jackets'), campaign: ref('c1', 'Jacket | IT | Exact'), adGroup: ref('g1', 'Exact group'), product: ref('p1', 'JK-100'), productCount: 1, via: null,
    state: 'RUNNING', owner: { kind: 'NONE', name: '—', id: null }, verb: { action: 'PAUSE', where: 'adGroup', held: null },
    test: { met: false, by: null, sentence: 'Not wasting', windowDays: 60, clicksNeeded: 20, spendBarCents: 3000, xCpaBar: 2 },
    d: { impressions: 100, clicks: 10, orders: 1, spendCents: 1000, salesCents: 3000, acosPct: 33, cpcCents: 100, xCpa: 0.5 },
    d90: null, spark: [], stockOutDays: 0, waiting: null, skipped: null, stillServesIn: 0, lastChange: null, ...over,
  }
}
const term = (over: Partial<WasteRow> = {}) => row({ id: 'term:IT|EXT1|rain cover', kind: 'TERM', text: 'rain cover', match: 'BROAD', adGroup: ref('g2', 'Broad group'), verb: { action: 'NEGATE_EXACT', where: 'adGroup', held: null }, ...over })
const asked = (over: Partial<NonNullable<WasteRow['waiting']>> = {}): NonNullable<WasteRow['waiting']> => ({
  approvalId: 'appr-1', by: ref('brain', 'Brain'), at: new Date(Date.now() - 2 * HOUR).toISOString(), expiresAt: null, rows: 1, changes: 1, ...over,
})

describe('HONEST 10 — a waiting row words the ask\'s own change, never the row\'s verb', () => {
  it('a keyword whose verb is the clash\'s Remove, asked to be paused: the ask is a pause', () => {
    const r = row({ verb: { action: 'REMOVE_NEGATIVE', where: 'adGroup', held: null, targetRowId: 'neg:n1' }, waiting: asked({ by: ref('appr-1', 'Claude'), action: 'PAUSE', match: 'EXACT', level: null, text: 'rain jacket', keepPaused: true }) })
    expect(askWords(r)).toBe('Claude asks to pause "rain jacket" and keep it paused')
    expect(waitingOf([r])).toMatchObject([{ approvalId: 'appr-1', what: 'Pause', text: 'rain jacket' }])
    expect(approveView(r)).toMatchObject({ desc: 'It pauses "rain jacket" and keeps it paused', change: 'Pause · rain jacket', after: 'Kept paused' })
  })

  it('a pause that does not keep it paused says only that it pauses', () => {
    const r = row({ waiting: asked({ action: 'PAUSE', match: 'EXACT', level: null, text: 'rain jacket', keepPaused: false }) })
    expect(askWords(r)).toBe('Brain asks to pause "rain jacket"')
    expect(approveView(r)).toMatchObject({ desc: 'It pauses "rain jacket"', after: 'Paused' })
  })

  it('a negative: the ask\'s match, place and words, not the row\'s verb (here: exact in the ad group)', () => {
    const r = term({ waiting: asked({ action: 'NEGATE_PHRASE', match: 'PHRASE', level: 'CAMPAIGN', text: 'rain' }) })
    expect(askWords(r)).toBe('Brain asks to add a negative phrase "rain" in the whole campaign')
    expect(waitingOf([r])).toMatchObject([{ what: 'Negative phrase · whole campaign', text: 'rain' }])
    expect(approveView(r)).toMatchObject({ desc: 'It adds the negative phrase "rain" in the whole campaign, so the term stops there', change: 'Negative phrase · whole campaign · rain', after: 'Blocked' })
  })

  it('a removal names the negative it removes, its match and its place', () => {
    const r = term({ id: 'neg:n1', state: 'NEGATED', askOnly: true, verb: { action: 'REMOVE_NEGATIVE', where: 'adGroup', held: null, targetRowId: 'neg:n1' }, waiting: asked({ action: 'REMOVE_NEGATIVE', match: 'EXACT', level: 'AD_GROUP', text: 'rain cover' }) })
    expect(askWords(r)).toBe('Brain asks to remove the negative exact "rain cover" in Broad group')
    expect(waitingOf([r])).toMatchObject([{ what: 'Remove negative', text: 'rain cover' }])
  })

  it('an older answer (no ask fields) keeps the guard: a clash row\'s Remove is never called its ask', () => {
    const r = row({ verb: { action: 'REMOVE_NEGATIVE', where: 'adGroup', held: null, targetRowId: 'neg:n1' }, waiting: { approvalId: 'a', by: ref('brain', 'Brain'), at: new Date().toISOString(), expiresAt: null } })
    expect(askWords(r)).toBe('Brain asks for a change to "rain jacket"')
    expect(waitingOf([r])[0].what).toBeUndefined()
  })
})

describe('HONEST 11 — a request with several changes is not one term in "N places"', () => {
  it('the record: one of N changes, decided by one answer; never "both places"', () => {
    const r = term({ waiting: asked({ rows: 2, changes: 3, action: 'NEGATE_EXACT', match: 'EXACT', level: 'AD_GROUP', text: 'rain cover' }) })
    expect(askWords(r)).toBe('Brain asks to add a negative exact "rain cover" in Broad group')
    expect(wasteBanner(r).desc).toBe('It waits for your answer: asked 2 h ago. It is one of 3 changes in this request: one answer decides them all.')
    expect(wasteMetrics(r)[3]).toEqual({ id: 'changes', label: 'Changes', value: '3', hint: 'one answer for all 3' })
    expect(approveView(r)!.reach).toBe('It is one of 3 changes in this request: the review lists each one first.')
    expect(askReachItem(r.waiting!)).toEqual({ label: 'In this request', value: '3 changes', hint: 'One answer decides them all' })
    expect(askReachItem(asked())).toBeNull()
  })

  it('one negative in a whole campaign over two listed ad groups: it covers both', () => {
    const r = term({ waiting: asked({ approvalId: 'suggestion:s1', by: ref('r1', 'Stop waste'), rows: 2, changes: 1, action: 'NEGATE_EXACT', match: 'EXACT', level: 'CAMPAIGN', text: 'rain cover' }) })
    expect(wasteBanner(r).desc).toBe('It waits for your answer: asked 2 h ago. One negative in the whole campaign: it covers this term in both ad groups listed.')
    expect(wasteMetrics(r)[3]).toEqual({ id: 'places', label: 'Ad groups', value: '2', hint: 'one negative covers both' })
    expect(approveView(r)!.reach).toBe('One negative in the whole campaign covers this term in both ad groups listed.')
    expect(decideAria('approve', r)).toBe('Approve rain cover · whole campaign, 2 ad groups')
    expect(askReachItem(r.waiting!)).toEqual({ label: 'Covers', value: '2 ad groups', hint: 'One negative in the whole campaign' })
  })

  it('a single request holding several negatives lists each one (the server\'s lines), decided together', () => {
    const steps: WaitingSteps = {
      approvalId: 'appr-3', status: 'pending', plan: false, title: null, offPage: 0,
      steps: [{
        step: 1, tool: 'add-negative-targets', words: 'Add negatives', onPage: true, status: 'pending', where: null, summary: null, hidden: null, changeCount: 3,
        changes: [
          { label: 'Negative exact "rain cover" · Jacket › Broad group', from: null, to: 'Added' },
          { label: 'Negative exact "cheap coat" · Jacket › Auto group', from: null, to: 'Added' },
          { label: 'Negative phrase "free" · Jacket › Broad group', from: null, to: 'Added' },
        ],
      }],
    }
    const [w] = waitingOf([term({ waiting: asked({ approvalId: 'appr-3', rows: 2, changes: 3, action: 'NEGATE_EXACT', match: 'EXACT', level: 'AD_GROUP', text: 'rain cover' }) })])
    const lines = decideLines([w], new Map([['appr-3', steps]]), 'approve')
    expect(lines.map((l) => l.what)).toEqual(['Add negatives · Negative exact "rain cover" · Jacket › Broad group', 'Add negatives · Negative exact "cheap coat" · Jacket › Auto group', 'Add negatives · Negative phrase "free" · Jacket › Broad group'])
    expect(lines.every((l) => l.note === 'Approved together · 3 changes · Brain')).toBe(true)
    expect(decideSummary([w], new Map([['appr-3', steps]]), 'approve')).toBe('This request is approved whole: every change below runs together.')
  })

  it('a rule\'s card (one change, not read) is one line; over two ad groups it says the campaign covers them', () => {
    const [w] = waitingOf([term({ waiting: asked({ approvalId: 'suggestion:s1', by: ref('r1', 'Stop waste'), rows: 2, changes: 1, action: 'NEGATE_EXACT', match: 'EXACT', level: 'CAMPAIGN', text: 'rain cover' }) })])
    expect(decideLines([w], new Map(), 'approve')).toEqual([expect.objectContaining({ id: 'suggestion:s1', what: 'Negative exact · whole campaign · rain cover', note: 'One negative · covers 2 ad groups here' })])
  })
})

describe('HONEST 12 — what Approve and Reject really do, per kind of request', () => {
  it('a request runs as the approver after the 20 s window; a rule\'s card applies now, as the rule, with no window', () => {
    expect(decideAfterWords('approve', ['appr-1'])).toBe('Runs as you after a 20-second window in which you can undo it.')
    expect(decideAfterWords('approve', ['suggestion:s1'])).toBe('Applies now, as the rule\'s own change: there is no window to undo it.')
    expect(decideAfterWords('approve', ['appr-1', 'suggestion:s1'])).toBe('A request runs as you after a 20-second window in which you can undo it; a rule\'s ask applies now, as the rule\'s own change, with no window to undo it.')
    expect(decideAfterWords('reject', ['suggestion:s1'])).toBe('Nothing is sent. Undo brings it back to waiting.')
    expect(decideAfterWords('reject', ['appr-1'])).toBe('Nothing is sent. A rejected request does not come back.')
    expect(decideAfterWords('reject', ['appr-1', 'suggestion:s1'])).toBe('Nothing is sent. A rule\'s ask can come back to waiting; the others do not.')
  })

  it('Done says why there is no Undo: a rule\'s card ran at once; a rejected request does not come back', () => {
    expect(decideNoUndo('approve', ['suggestion:s1'])).toBe('A rule\'s ask ran at once: there is no window to undo it')
    expect(decideNoUndo('reject', ['appr-1'])).toBe('A rejected request does not come back')
  })

  it('the record\'s "What Approve does" never promises an Undo a rule\'s card does not have', () => {
    const card = approveView(term({ waiting: asked({ approvalId: 'suggestion:s1', by: ref('r1', 'Stop waste'), action: 'NEGATE_EXACT', match: 'EXACT', level: 'AD_GROUP', text: 'rain cover' }) }))!
    expect(card.foot).toBe('Approve shows the review first. After you approve, it applies now, as the rule\'s own change: there is no window to undo it. Reject sends nothing; its Undo brings it back to waiting.')
    const request = approveView(term({ waiting: asked({ action: 'NEGATE_EXACT', match: 'EXACT', level: 'AD_GROUP', text: 'rain cover' }) }))!
    expect(request.foot).toBe('Approve shows the review first. After you approve, it runs as you after a 20-second window in which you can undo it. Reject sends nothing, and the request does not come back.')
  })
})

describe('HONEST 15 — a row listed only for its ask is not judged', () => {
  it('no checks are drawn, and the banner says why', () => {
    const r = term({ askOnly: true, test: { met: false, judged: false, by: null, sentence: 'Asked by Brain: it waits for your answer', windowDays: 60, clicksNeeded: 0, spendBarCents: null, xCpaBar: null }, d: { impressions: 0, clicks: 0, orders: 0, spendCents: 0 }, waiting: asked({ action: 'NEGATE_PHRASE', match: 'PHRASE', level: 'AD_GROUP', text: 'rain' }) })
    expect(wasteChecks(r)).toBeNull()
    expect(wasteBanner(r).desc).toBe('It waits for your answer: asked 2 h ago. It is listed for this ask only: the page\'s test did not judge it.')
    expect(wasteMetrics(r)[3]).toEqual({ id: 'xcpa', label: 'Cost against target', value: '—', hint: 'not judged: listed for its ask' })
    // An older answer: askOnly alone says the same.
    expect(wasteChecks({ ...r, test: { ...r.test, judged: undefined } })).toBeNull()
  })
})

describe('HONEST 17 — a skip\'s History Undo is the page\'s own Unskip', () => {
  const skip = (over: Partial<HistoryItem> = {}): HistoryItem => ({
    at: '2026-10-20T08:00:00.000Z', action: 'skipped', text: 'rain cover', kind: 'TERM', rowId: 'term:IT|EXT1|rain cover', campaign: ref('c1'), adGroup: ref('g2'), product: null,
    by: { id: 'u1', name: 'Rosa' }, why: 'Skipped until 3 Nov: it comes back with fresh numbers.', changeId: null, changeSetId: null, delivery: 'LIVE',
    undo: { available: true, why: 'Unskip shows it again now: Nexus only.' }, ...over,
  })
  it('names the row to unskip, with its place; any other change keeps its own Undo', () => {
    expect(skipUndoRow(skip())).toEqual({ id: 'term:IT|EXT1|rain cover', text: 'rain cover', place: [ref('c1'), ref('g2')] })
    expect(skipUndoRow(skip({ undo: { available: false, why: 'Already undone.' } }))).toBeNull()
    expect(skipUndoRow(skip({ rowId: null }))).toBeNull()
    expect(skipUndoRow(skip({ action: 'paused', changeId: 'l1' }))).toBeNull()
  })
})
