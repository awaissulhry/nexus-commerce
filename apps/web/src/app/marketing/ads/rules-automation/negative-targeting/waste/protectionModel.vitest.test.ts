/**
 * Negative Targeting page, step 4 — the Protected tile's words and rules. Made-up words.
 */
import { describe, expect, it } from 'vitest'
import {
  alsoKeepsLine, alsoKeepsTitle, followUpLine, followUpSentence, followUpWords, keepProtectedIds, keptProtectedWords, MAX_REVIEW_ITEMS, protectionChipWords, protectionScopeWords,
  protectionSentence, removeProtectionBulkCount, removeProtectionBulkPlan, removeProtectionHeld, removeProtectionItems, stepOrderNote, termKeys, watchFollowUp,
  WATCH_TRIES, type WatchDeps,
} from './protectionModel'
import { ackWords, appliedWords, emptyWords, landsWord, saveWords, stateSentence, undoWords, wastingShowOf } from './wasteModel'
import type { FollowUpView, PreviewStep, ProtectionTerm, RowProtection, WasteRow } from './wasteTypes'

const term = (id: string, words: string, extra: Partial<ProtectionTerm> = {}): ProtectionTerm => ({ id, term: words, match: 'CONTAINS', market: 'IT', campaign: null, reason: null, ...extra })
const prot = (terms: ProtectionTerm[], then: RowProtection['then'] = null): RowProtection => ({ terms, then })
const row = (extra: Partial<WasteRow> = {}): WasteRow => ({
  id: 'term:IT|AG1|rain hat', kind: 'TERM', text: 'rain hat', state: 'PROTECTED', skipped: null, waiting: null,
  verb: { action: 'NEGATE_EXACT', where: 'campaign', held: { label: 'Protected', reason: '"rain" is a protected term' } },
  test: { met: true }, protection: prot([term('p1', 'rain'), term('p2', 'rain hat', { match: 'EXACT', market: null })]), ...extra,
} as unknown as WasteRow)
const step = (extra: Partial<PreviewStep> = {}): PreviewStep => ({
  rowId: 'r', action: 'UNPROTECT', text: 'rain', place: { portfolio: null, campaign: null, adGroup: null }, from: 'PROTECTED', to: 'NOT_PROTECTED',
  lands: 'nexus', runsAt: null, refusal: null, raise: true, needsCode: false, tool: 'set-ad-guardrail', summary: null, ...extra,
})

describe('a protected term in words', () => {
  it('its scope, the chip and the whole sentence', () => {
    expect(protectionScopeWords(term('p', 'rain'))).toBe('Amazon IT · every campaign')
    expect(protectionScopeWords(term('p', 'rain', { market: null, campaign: { id: 'c', name: 'Test summer' } }))).toBe('Every market · Test summer')
    expect(protectionChipWords(row().protection!)).toEqual({ label: 'rain', more: 1 })
    expect(protectionSentence(prot([term('p', 'rain', { reason: 'our brand' })]))).toBe('Kept safe by the protected term "rain" (contains, Amazon IT, every campaign): our brand. No negative and no pause may stop it.')
    expect(stateSentence(row())).toBe('Protected by "rain" and 1 more term: never negated')
    expect(stateSentence({ state: 'PROTECTED' })).toBe('Protected: never negated')
  })
  it('the Protected filter is an address and has its own empty words', () => {
    expect(wastingShowOf('protected')).toBe('protected')
    expect(emptyWords('wasting', 'protected', false)).toEqual({ title: 'Nothing wasting is protected', clear: true })
  })
})

describe('Keep protected', () => {
  it('fits the protected rows not kept already; a kept one says until when', () => {
    expect(keepProtectedIds([row({ id: 'a' }), row({ id: 'b', skipped: { until: '2026-11-24T10:00:00Z', by: null, at: null } }), row({ id: 'c', state: 'RUNNING' }), { id: 'd' }])).toEqual(['a'])
    expect(keptProtectedWords(row({ skipped: { until: '2026-11-24T10:00:00Z', by: null, at: null } }))).toMatch(/^Kept protected until 24 Nov/)
    expect(keptProtectedWords(row({ state: 'RUNNING', skipped: { until: '2026-11-24T10:00:00Z', by: null, at: null } }))).toBeNull()
  })
})

describe('Remove protection and stop', () => {
  it('one removal per protected term, then the row\'s own verb where it lands', () => {
    expect(removeProtectionItems(row())).toEqual([
      { rowId: 'term:IT|AG1|rain hat', action: 'UNPROTECT', protectionId: 'p1' },
      { rowId: 'term:IT|AG1|rain hat', action: 'UNPROTECT', protectionId: 'p2' },
      { rowId: 'term:IT|AG1|rain hat', action: 'NEGATE_EXACT', where: 'campaign' },
    ])
    expect(removeProtectionItems(row({ id: 'kw:k1', kind: 'KEYWORD', verb: { action: 'PAUSE', where: 'adGroup', held: null }, protection: prot([term('p1', 'rain')]) })).at(-1)).toEqual({ rowId: 'kw:k1', action: 'PAUSE' })
  })
  it('held with why: the person, then a stop that would still be held without the protection', () => {
    expect(removeProtectionHeld(row(), { write: true, unprotect: true })).toBeNull()
    expect(removeProtectionHeld(row(), { write: false, unprotect: true })).toBe('You can see ads here, not change them')
    expect(removeProtectionHeld(row(), { write: true, unprotect: false })).toMatch(/needs the ads automation, bids, budgets and ad spend permissions/)
    expect(removeProtectionHeld(row({ followUp: { status: 'WAITING', why: null, at: 'z' } }), { write: true, unprotect: true })).toMatch(/^Its protection is being removed/)
    expect(removeProtectionHeld(row({ protection: prot([term('p1', 'rain')], { label: 'New place', reason: 'The ad group is 5 days old.' }) }), { write: true, unprotect: true }))
      .toBe('Removing the protection would not stop it: The ad group is 5 days old.')
  })
  it('the review: what else it keeps safe, the order, the button, the tick and the undo in words', () => {
    const keeps = { count: 3, terms: [{ text: 'rain coat', kind: 'TERM' as const, places: 2, wasting: true }] }
    expect(alsoKeepsTitle([step({ protection: { ...term('p1', 'rain'), alsoKeeps: keeps } }), step({ action: 'NEGATE_EXACT', after: 'UNPROTECT' })])).toEqual({ title: 'This protection also keeps 3 other terms safe', tone: 'warning' })
    expect(alsoKeepsTitle([step({ protection: { ...term('p1', 'rain'), alsoKeeps: { count: 0, terms: [] } } })])).toEqual({ title: 'This protection keeps no other term safe', tone: 'info' })
    expect(alsoKeepsTitle([step({ protection: { ...term('p1', 'a'), alsoKeeps: keeps } }), step({ protection: { ...term('p2', 'b'), alsoKeeps: { count: 1, terms: [] } } })])?.title).toBe('These 2 protections also keep 4 other terms safe')
    expect(alsoKeepsLine(keeps.terms[0])).toBe('rain coat · 2 places · wastes')
    const two = [step(), step({ action: 'NEGATE_EXACT', after: 'UNPROTECT', lands: 'amazon', raise: false, tool: 'add-negative-targets' })]
    expect(stepOrderNote(two, 1, landsWord(two[1]))).toBe('Step 2 · Sends to Amazon once the protection is removed')
    expect(stepOrderNote([step({ action: 'PAUSE' })], 0, 'Nexus only')).toBe('Nexus only')
    expect(saveWords(two)).toBe('Remove protection and add a negative')
    expect(saveWords([step(), step(), step({ action: 'PAUSE' })])).toBe('Remove 2 protections and pause')
    expect(saveWords([step(), step({ action: 'PAUSE' }), step({ action: 'NEGATE_EXACT', after: 'UNPROTECT' })])).toBe('Remove protection and stop 2')
    expect(undoWords(['UNPROTECT', 'PAUSE'])).toBe('Undo: protect again and turn back on')
    expect(undoWords(['UNPROTECT', 'NEGATE_EXACT'])).toBe('Undo: protect again and remove the negative')
    expect(ackWords(two)).toBe('I understand without the protection, rules, the Brain and Claude may stop what it kept safe.')
    expect(appliedWords(two[0], { status: 'queued' })).toEqual({ ok: true, words: 'Removes in 20 s' })
    expect(appliedWords(two[1], { status: 'queued' })).toEqual({ ok: true, words: 'Waits for the removal' })
  })
})

describe('bulk Remove protection and stop: one removal per protected term, then each row\'s verb', () => {
  const can = { write: true, unprotect: true }
  const a = term('pa', 'rain'), b = term('pb', 'storm')
  const r1 = row({ id: 'term:IT|AG1|rain hat', protection: prot([a]) })
  const r2 = row({ id: 'term:IT|AG1|rain coat', text: 'rain coat', protection: prot([a, b]) })
  const kw = row({ id: 'kw:k1', kind: 'KEYWORD', text: 'storm boots', verb: { action: 'PAUSE', where: 'adGroup', held: { label: 'Protected', reason: 'x' } }, protection: prot([b]) })
  it('a term holding many rows is ONE removal; each row keeps its own verb; the rest are left out, each with why', () => {
    const plan = removeProtectionBulkPlan([r1, r2, kw, row({ id: 'term:IT|AG1|plain', state: 'RUNNING', protection: undefined }), row({ id: 'term:IT|AG1|new', protection: prot([a], { label: 'New place', reason: 'too young.' }) }), { id: 'term:IT|AG1|bare' }], can)
    expect(plan.items).toEqual([
      { rowId: r1.id, action: 'UNPROTECT', protectionId: 'pa' }, { rowId: r2.id, action: 'UNPROTECT', protectionId: 'pb' },
      { rowId: r1.id, action: 'NEGATE_EXACT', where: 'campaign' }, { rowId: r2.id, action: 'NEGATE_EXACT', where: 'campaign' }, { rowId: 'kw:k1', action: 'PAUSE' },
    ])
    expect(plan.left.map((l) => l.why)).toEqual(['No protected term keeps it safe', 'Removing the protection would not stop it: too young.', 'Not read yet'])
    expect(removeProtectionBulkCount([r1, r2, kw], can)).toBe(3)
    expect(removeProtectionBulkPlan([r1], { write: true, unprotect: false }).left[0].why).toMatch(/needs the ads automation/)
  })
  it('the review\'s limit: past it a row is left out, never sent in part', () => {
    const many = Array.from({ length: MAX_REVIEW_ITEMS }, (_, i) => row({ id: `term:IT|AG1|w${i}`, protection: prot([term(`p${i}`, `w${i}`)]) }))
    const plan = removeProtectionBulkPlan(many, can)
    expect(plan.items.length).toBeLessThanOrEqual(MAX_REVIEW_ITEMS)
    expect(plan.left.at(-1)?.why).toBe(`At most ${MAX_REVIEW_ITEMS} changes in one review`)
  })
})

describe('the follow-up: Nexus sends the negative once the removal ran; the page only watches', () => {
  const view = (status: FollowUpView['status'], extra: Partial<FollowUpView> = {}): FollowUpView => ({ approvalId: 'cs-1', status, changeSetId: null, rowIds: ['r'], results: [], why: null, createdAt: '2026-10-25T10:00:00Z', endedAt: null, ...extra })
  function deps(answers: Array<FollowUpView | null>) {
    const log: string[] = []
    let clock = 0
    const d: WatchDeps = {
      commit: async (id) => { log.push(`commit ${id}`) },
      run: async (id) => { log.push(`run ${id}`); return answers.length > 1 ? answers.shift()! : answers[0] ?? null },
      sleep: async (ms) => { clock += ms },
      now: () => clock,
      sent: (v) => { log.push(`sent ${v.changeSet?.status}`) },
    }
    return { d, log, clock: () => clock }
  }
  const sentTo = (lands: 'amazon' | 'nexus', status: string) => view('SENT', { changeSetId: 'cs-2', results: [{ rowId: 'r', sent: true, why: null, lands }], changeSet: { status, executeAfter: new Date(45_000).toISOString() } })
  it('waits out the window, asks Nexus to run the removal and the follow-up, then the negatives\' own window, until they ran', async () => {
    const { d, log, clock } = deps([view('WAITING'), view('SENDING'), sentTo('amazon', 'scheduled'), sentTo('amazon', 'scheduled'), sentTo('amazon', 'executed')])
    const out = await watchFollowUp({ removalId: 'cs-1', executeAfter: new Date(20_000).toISOString(), stopped: () => false }, d)
    expect(out).toMatchObject({ kind: 'done', view: { status: 'SENT', changeSetId: 'cs-2', changeSet: { status: 'executed' } } })
    expect(log).toEqual(['commit cs-1', 'run cs-1', 'run cs-1', 'run cs-1', 'sent scheduled', 'commit cs-2', 'run cs-1', 'run cs-1'])
    expect(clock()).toBeGreaterThanOrEqual(45_000)
    expect(followUpWords((out as { view: FollowUpView }).view, 'r')).toEqual({ ok: true, words: 'Sent', verb: 'sent' })
  })
  it('never "Sent" before it ran, nor for a change that stays in Nexus (the page\'s own words)', () => {
    expect(followUpWords(sentTo('amazon', 'scheduled'), 'r')).toEqual({ ok: true, words: 'Sending', verb: 'sending' })
    expect(followUpLine(sentTo('amazon', 'scheduled'))).toBe('Protection removed · Sends to Amazon in 20 s · Undo stops it')
    expect(followUpLine(sentTo('amazon', 'executed'))).toBe('Protection removed · Sent to Amazon')
    for (const status of ['scheduled', 'executed']) {
      expect(followUpWords(sentTo('nexus', status), 'r')).toEqual({ ok: true, words: 'Saved in Nexus', verb: 'saved' })
      expect(followUpLine(sentTo('nexus', status))).toBe('Protection removed · Saved in Nexus: nothing is sent to Amazon')
    }
    expect(followUpWords(sentTo('amazon', 'rejected'), 'r')).toMatchObject({ ok: false, words: 'Not sent' })
    expect(followUpLine(null)).toMatch(/the row says how it went/)
  })
  it('a Nexus-only follow-up: the page still runs its change set at the end of its window', async () => {
    const { d, log } = deps([sentTo('nexus', 'scheduled'), sentTo('nexus', 'executed')])
    const out = await watchFollowUp({ removalId: 'cs-1', executeAfter: null, stopped: () => false }, d)
    expect(log).toEqual(['commit cs-1', 'run cs-1', 'sent scheduled', 'commit cs-2', 'run cs-1'])
    expect(followUpLine((out as { view: FollowUpView }).view)).toBe('Protection removed · Saved in Nexus: nothing is sent to Amazon')
  })
  it('the page may go: past its tries it says so (the server finishes it); Undo stops watching', async () => {
    const waiting = deps([view('WAITING')])
    expect(await watchFollowUp({ removalId: 'cs-1', executeAfter: null, stopped: () => false }, waiting.d)).toEqual({ kind: 'late' })
    expect(waiting.log.filter((l) => l.startsWith('run'))).toHaveLength(WATCH_TRIES)
    const stopped = deps([view('SENT')])
    expect(await watchFollowUp({ removalId: 'cs-1', executeAfter: null, stopped: () => true }, stopped.d)).toEqual({ kind: 'stopped' })
    expect(stopped.log).toEqual([])
  })
  it('a refused follow-up says why, per row and on the row', () => {
    expect(followUpWords(view('REFUSED', { why: 'The protection was not removed (it was rejected), so no negative was sent.' }), 'r')).toMatchObject({ ok: false, words: 'Not sent: The protection was not removed (it was rejected), so no negative was sent' })
    expect(followUpWords(view('SENT', { results: [{ rowId: 'r', sent: false, why: '"rain hat" is already negated.' }] }), 'r')).toMatchObject({ ok: false, words: 'Not sent: "rain hat" is already negated' })
    expect(followUpWords(view('CANCELLED'), 'r')).toMatchObject({ ok: false, words: 'Not sent' })
    expect(followUpLine(view('REFUSED', { why: 'it was rejected.' }))).toBe('Protection removed · not sent: it was rejected')
    expect(followUpSentence({ status: 'REFUSED', why: 'it changed.', at: 'z' })).toBe('Not stopped after the protection was removed: it changed')
    expect(followUpSentence({ status: 'WAITING', why: null, at: 'z' })).toMatch(/Nexus sends its negative once it is/)
  })
})

describe('the Term cell\'s keys', () => {
  const chip = { clicked: 0, click() { this.clicked++ } }
  const cell = { closest: () => null, querySelector: (s: string) => (s === '[data-protection-chip] button' ? chip : null) }
  it('Shift+Enter opens the protected term; Enter stays the grid\'s (the record); on the chip its own keys', () => {
    expect(termKeys({ event: { key: 'Enter', shiftKey: true, type: 'keydown', target: cell }, editing: false })).toBe(true)
    expect(chip.clicked).toBe(1)
    expect(termKeys({ event: { key: 'Enter', type: 'keydown', target: cell }, editing: false })).toBe(false)
    expect(termKeys({ event: { key: 'Enter', shiftKey: true, type: 'keydown', target: { closest: () => ({}) } }, editing: false })).toBe(true)
    expect(termKeys({ event: { key: 'Enter', shiftKey: true, type: 'keydown', target: { closest: () => null, querySelector: () => null } }, editing: false })).toBe(false)
  })
})
