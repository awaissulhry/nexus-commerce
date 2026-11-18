import { readFileSync } from 'node:fs'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { APPROVAL_KINDS, KIND_RULES } from '@nexus/factory-domain/approvals-out/kinds'
import { createApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import { LOCALES } from '../../../lib/i18n/locales'
import { leftKeys, renderView, textOf } from '../../../lib/record-thread/parts/testing' // F-PR-16
import { CATALOGUE } from '../../../lib/i18n/messages'
import { scanText } from '../../../lib/testing/brand-scan'
import { BRAND_ALPHA, BRAND_BETA } from '../../../lib/testing/two-brands'
import { decideForParty, readOverrideRequest, readRecordRequests, reverseAnswer, type OverrideRequest } from './api'
import {
  actOf,
  decideBodyOf,
  decideDraftHeld,
  decisionsFor,
  effectKey,
  emptyDecideDraft,
  factsOf,
  KNOWN_EFFECTS,
  KNOWN_REFUSALS,
  NS,
  outcomeKey,
  outcomeOfDecide,
  outcomeOfReverse,
  OVERRIDE_LIMITS,
  overrideHeld,
  overrideProblem,
  OWN_WORD_KINDS,
  pickRequest,
  readOutcomeOf,
  reasonHeld,
  refusalCodeOf,
  reverseWhatKey,
  stepUpProblemOf,
  taskHref,
} from './model'
import { CustomerOverrideContext, CustomerOverrideSlot } from './slot'
import { designScreen } from './fixtures' // F-PR-16

/**
 * F-PR-09 — "Decide for <customer>" and "Reverse" on approvals asked of a customer (production plan §3 "No silent decisions",
 * "Decide for a brand, undo — production.brand.override, step-up; a second person when the brand's switch is on"; the API's
 * B-PR-30a/30b): the calls, which act a request offers and why it is held, the decision's draft and body, the refusals said from
 * their codes, what was done, the words in both languages, and where the part is mounted (the sample round, its swatches, a
 * gate's round, a new date's answer, our counter-offer).
 * Wall, web side (PW-04, PW-09): the part is about one request of the reader's own customer; another customer's id answers 404 and
 * the part draws nothing — no word of it names another customer, and Brand Beta's request shows nothing of Brand Alpha.
 */

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function client(...answers: Array<() => Response>) {
  let index = 0
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => (answers[Math.min(index++, answers.length - 1)] ?? (() => json(500, {})))())
  const api = createApiClient({ baseUrl: '/api', fetch: fetch as unknown as typeof globalThis.fetch, company: 'DEMO', csrfToken: () => 'csrf-1' })
  const sent = (call = 0) => {
    const [url, init] = fetch.mock.calls[call]!
    return { url, method: init.method, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined }
  }
  return { api, fetch, sent }
}

/** Brand Beta's pre-production round, asked and open (made up). */
const OPEN: OverrideRequest = {
  id: 'b2b2b2b2-0009-4000-8000-000000000001',
  companyId: 'c0c0c0c0-0009-4000-8000-000000000001',
  kind: 'SAMPLE',
  record: { type: 'SampleRound', id: 'b2b2b2b2-0009-4000-8000-000000000011', words: { it: 'SR-2026-0202 · Pre-produzione · giro 1', en: 'SR-2026-0202 · Pre-production · round 1' } },
  party: { id: 'b2b2b2b2-0009-4000-8000-000000000021', name: BRAND_BETA.legalName },
  question: 'Approve the pre-production sample of BX-200 (made up).',
  dueAt: '2026-11-25T16:00:00.000Z',
  status: 'OPEN',
  answer: null,
  decidedForParty: null,
  reversed: null,
  override: null,
  askedBy: 'Carlo Prova',
  may: { withdraw: true, decideForParty: true, reverse: false },
  version: 3,
}
const ANSWERED: OverrideRequest = {
  ...OPEN,
  status: 'APPROVED',
  answer: { at: '2026-11-18T09:00:00.000Z', typedName: BRAND_BETA.portalPerson.name, words: null, via: 'PORTAL', personName: BRAND_BETA.portalPerson.name },
  may: { withdraw: false, decideForParty: false, reverse: true },
  version: 4,
}
const REVERSED: OverrideRequest = { ...ANSWERED, reversed: { at: '2026-11-18T10:00:00.000Z', byName: 'Carlo Prova', reason: 'The sample was sent by mistake (made up).' }, may: { withdraw: false, decideForParty: false, reverse: false }, version: 5 }
const CAN = { can: true, offline: false, busy: false, locale: 'en' as const }
const words = (locale: (typeof LOCALES)[number]) => CATALOGUE[locale][NS] as Record<string, string>

describe('F-PR-09 — the calls (B-PR-30a decide for, B-PR-30b reverse)', () => {
  it('reads one request, or a record’s requests, through the one client', async () => {
    const one = client(() => json(200, { request: { ...OPEN, files: [], links: [] } }))
    expect((await readOverrideRequest(one.api, OPEN.id)).id).toBe(OPEN.id)
    expect(one.sent().url).toBe(`/api/approvals-out/${OPEN.id}`)
    expect(one.sent().method).toBe('GET')
    const list = client(() => json(200, { record: { type: 'SampleRound', id: OPEN.record.id, words: OPEN.record.words }, kinds: ['SAMPLE'], held: null, requests: [OPEN, ANSWERED] }))
    expect((await readRecordRequests(list.api, { type: 'SampleRound', id: OPEN.record.id })).map((request) => request.status)).toEqual(['OPEN', 'APPROVED'])
    expect(list.sent().url).toBe(`/api/approvals-out?recordType=SampleRound&recordId=${OPEN.record.id}`)
  })

  it('Decide for: POST …/decide-for-party with the version, the decision, the words, the typed name and why — the CSRF token and one Idempotency-Key', async () => {
    const write = client(() => json(200, { request: ANSWERED, override: { outcome: 'DONE', taskId: null, words: null } }))
    const answer = await decideForParty(write.api, OPEN.id, { version: 3, decision: 'REFUSED', answer: 'The seam is crooked (made up).', typedName: 'Carlo Prova', reason: 'They told us on the phone (made up).' }, 'key-1')
    const call = write.sent()
    expect(`${call.method} ${call.url}`).toBe(`POST /api/approvals-out/${OPEN.id}/decide-for-party`)
    expect(call.body).toEqual({ version: 3, decision: 'REFUSED', answer: 'The seam is crooked (made up).', typedName: 'Carlo Prova', reason: 'They told us on the phone (made up).' })
    expect(call.headers.get('x-csrf-token')).toBe('csrf-1')
    expect(call.headers.get('idempotency-key')).toBe('key-1')
    expect(outcomeOfDecide(answer)).toEqual({ act: 'decide', secondPerson: false, taskId: null, effects: [], link: null })
  })

  it('Reverse: POST …/reverse with the version and why; what it did, a new date asked again with its link once', async () => {
    const write = client(() => json(200, { request: REVERSED, override: { outcome: 'DONE', taskId: null, words: null }, effects: ['ASK_AGAIN'], asked: { requestId: 'b2b2b2b2-0009-4000-8000-000000000031', url: 'https://factory.example.com/l#t=made-up' } }))
    const answer = await reverseAnswer(write.api, ANSWERED.id, { version: 4, reason: 'The date moved again (made up).' })
    expect(`${write.sent().method} ${write.sent().url}`).toBe(`POST /api/approvals-out/${ANSWERED.id}/reverse`)
    expect(write.sent().body).toEqual({ version: 4, reason: 'The date moved again (made up).' })
    expect(write.sent().headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/)
    expect(outcomeOfReverse(answer)).toEqual({ act: 'reverse', secondPerson: false, taskId: null, effects: ['ASK_AGAIN'], link: 'https://factory.example.com/l#t=made-up' })
    // A second person grants it first (the customer's switch): nothing done yet, its task in Home › Approvals.
    const second = outcomeOfReverse({ override: { outcome: 'SECOND_PERSON', taskId: 't0t0t0t0-0009-4000-8000-000000000001', words: { it: 'x', en: 'x' } }, effects: [], asked: null })
    expect(outcomeKey(second)).toBe('done.secondPerson')
    expect(taskHref('/w/DEMO', 't0t0t0t0-0009-4000-8000-000000000001')).toBe('/w/DEMO/home/approvals?open=t0t0t0t0-0009-4000-8000-000000000001')
  })
})

describe('F-PR-09 — which act a request offers, and why it is held', () => {
  it('an open request is decided for the customer; an answer not reversed yet is reversed; a reversed or withdrawn one offers nothing', () => {
    expect(actOf(OPEN)).toBe('decide')
    expect(actOf(ANSWERED)).toBe('reverse')
    expect(actOf(REVERSED)).toBeNull()
    expect(actOf({ ...OPEN, status: 'WITHDRAWN' })).toBeNull()
    expect(actOf({ ...OPEN, status: 'EXPIRED' })).toBeNull()
  })

  it('held by the right, the customer’s own word, a second person asked, never the person who asked, the reach, busy and offline', () => {
    expect(overrideHeld(OPEN, 'decide', CAN)).toBeNull()
    expect(overrideHeld(ANSWERED, 'reverse', CAN)).toBeNull()
    expect(overrideHeld(OPEN, 'decide', { ...CAN, can: false })).toEqual({ key: 'held.noRight' })
    expect(overrideHeld({ ...OPEN, kind: 'PROOF' }, 'decide', CAN)).toEqual({ key: 'held.ownWord', params: { kind: 'Design proof' } })
    expect(overrideHeld({ ...OPEN, kind: 'CONCESSION' }, 'decide', { ...CAN, locale: 'it' })).toEqual({ key: 'held.ownWord', params: { kind: 'Concessione' } })
    expect(overrideHeld({ ...OPEN, override: { taskId: 't1', act: 'DECIDE_FOR' } }, 'decide', CAN)).toEqual({ key: 'held.pending' })
    // The API's `may` is false for the person who asked the customer (or a right that does not reach this customer).
    expect(overrideHeld({ ...OPEN, may: { ...OPEN.may, decideForParty: false } }, 'decide', CAN)).toEqual({ key: 'held.notYours' })
    expect(overrideHeld(ANSWERED, 'decide', CAN)).toEqual({ key: 'held.answered' })
    expect(overrideHeld({ ...OPEN, status: 'WITHDRAWN' }, 'decide', CAN)).toEqual({ key: 'held.notOpen' })
    expect(overrideHeld(REVERSED, 'reverse', CAN)).toEqual({ key: 'held.reversed' })
    expect(overrideHeld(OPEN, 'reverse', CAN)).toEqual({ key: 'held.notAnswered' })
    expect(overrideHeld({ ...ANSWERED, may: { ...ANSWERED.may, reverse: false } }, 'reverse', CAN)).toEqual({ key: 'held.noReach' })
    expect(overrideHeld(OPEN, 'decide', { ...CAN, busy: true })).toEqual({ key: 'held.busy' })
    expect(overrideHeld(OPEN, 'decide', { ...CAN, offline: true })).toEqual({ key: 'held.offline' })
  })

  it('the customer’s own word mirrors the API’s four kinds; every other kind may be decided for them', () => {
    expect([...OWN_WORD_KINDS].sort()).toEqual(['CONCESSION', 'PROOF', 'REVISED_ORDER', 'SIGNATURE'])
    for (const kind of APPROVAL_KINDS.filter((one) => !OWN_WORD_KINDS.includes(one))) expect(overrideHeld({ ...OPEN, kind }, 'decide', CAN), kind).toBeNull()
  })

  it('of a record’s requests (a gate’s round): the open one first, else the newest answer not reversed, else the reversed one', () => {
    const asked = { ...OPEN, id: 'r-open' }
    expect(pickRequest([ANSWERED, asked])?.id).toBe('r-open')
    expect(pickRequest([REVERSED, { ...ANSWERED, id: 'r-answered' }])?.id).toBe('r-answered')
    expect(pickRequest([{ ...OPEN, status: 'WITHDRAWN' }, REVERSED])?.id).toBe(REVERSED.id)
    expect(pickRequest([{ ...OPEN, status: 'EXPIRED' }])).toBeNull()
    expect(pickRequest([])).toBeNull()
  })

  it('what was done: decided for the customer, reversed, a second person waiting (its task)', () => {
    expect(factsOf(OPEN)).toEqual([])
    const ours = { ...ANSWERED, decidedForParty: { byName: 'Carlo Prova', reason: 'Approved on the phone (made up).' }, reversed: REVERSED.reversed, override: { taskId: 't2', act: 'REVERSE' as const } }
    expect(factsOf(ours).map((fact) => fact.kind)).toEqual(['decidedFor', 'reversed', 'pending'])
  })

  it('what a reversal does, said before: a round back under review (and its gate), a swatch undecided, a new date asked again, a counter no longer standing', () => {
    expect(reverseWhatKey(ANSWERED)).toBe('reverse.what.SampleRound')
    expect(reverseWhatKey({ kind: 'FABRIC', record: { ...ANSWERED.record, type: 'SampleSwatch' } })).toBe('reverse.what.SampleSwatch')
    expect(reverseWhatKey({ kind: 'REPROMISE', record: { ...ANSWERED.record, type: 'SalesOrder' } })).toBe('reverse.what.REPROMISE')
    expect(reverseWhatKey({ kind: 'COUNTER_OFFER', record: { ...ANSWERED.record, type: 'OrderChangeRequest' } })).toBe('reverse.what.COUNTER_OFFER')
    expect(reverseWhatKey({ kind: 'ARTWORK', record: { ...ANSWERED.record, type: 'Style' } })).toBe('reverse.what.other')
    for (const effect of KNOWN_EFFECTS) expect(effectKey(effect)).toBe(`effect.${effect}`)
    expect(effectKey('SOMETHING_NEW')).toBe('effect.other')
  })
})

describe('F-PR-09 — the decision we take for the customer', () => {
  it('the decisions the kind allows: a new date or a counter-offer is approved or refused, a sample may be approved with changes', () => {
    expect(decisionsFor('SAMPLE')).toEqual(['APPROVED', 'APPROVED_WITH_CHANGES', 'REFUSED'])
    expect(decisionsFor('REPROMISE')).toEqual(['APPROVED', 'REFUSED'])
    expect(decisionsFor('COUNTER_OFFER')).toEqual(['APPROVED', 'REFUSED'])
    for (const kind of APPROVAL_KINDS) expect(decisionsFor(kind).includes('APPROVED_WITH_CHANGES')).toBe(KIND_RULES[kind].withChanges)
  })

  it('Send is held until the decision, the words of a change or a refusal, why (the customer reads it) and the typed name say enough', () => {
    const draft = emptyDecideDraft('Carlo Prova')
    expect(draft).toEqual({ decision: null, answer: '', reason: '', typedName: 'Carlo Prova' })
    expect(decideDraftHeld('SAMPLE', draft)).toEqual({ key: 'decide.held.pick' })
    expect(decideDraftHeld('REPROMISE', { ...draft, decision: 'APPROVED_WITH_CHANGES' })).toEqual({ key: 'decide.held.pick' })
    expect(decideDraftHeld('SAMPLE', { ...draft, decision: 'REFUSED' })).toEqual({ key: 'decide.held.why' })
    expect(decideDraftHeld('SAMPLE', { ...draft, decision: 'APPROVED_WITH_CHANGES' })).toEqual({ key: 'decide.held.changes' })
    expect(decideDraftHeld('SAMPLE', { ...draft, decision: 'REFUSED', answer: 'x'.repeat(OVERRIDE_LIMITS.answer + 1) })).toEqual({ key: 'decide.held.answerLong', params: { max: OVERRIDE_LIMITS.answer } })
    expect(decideDraftHeld('SAMPLE', { ...draft, decision: 'APPROVED' })).toEqual({ key: 'held.reason' })
    expect(decideDraftHeld('SAMPLE', { ...draft, decision: 'APPROVED', reason: '   ' })).toEqual({ key: 'held.reason' })
    expect(decideDraftHeld('SAMPLE', { ...draft, decision: 'APPROVED', reason: 'x'.repeat(1001) })).toEqual({ key: 'held.reasonLong', params: { max: 1000 } })
    expect(decideDraftHeld('SAMPLE', { ...draft, decision: 'APPROVED', reason: 'Approved on the phone.', typedName: 'C' })).toEqual({ key: 'decide.held.typedName' })
    expect(decideDraftHeld('SAMPLE', { ...draft, decision: 'APPROVED', reason: 'Approved on the phone.', typedName: 'x'.repeat(201) })).toEqual({ key: 'decide.held.typedNameLong', params: { max: 200 } })
    expect(decideDraftHeld('SAMPLE', { ...draft, decision: 'APPROVED', reason: 'Approved on the phone.' })).toBeNull()
    expect(reasonHeld('  Sent by mistake.  ')).toBeNull()
  })

  it('the body: trimmed; a plain approval sends no words; the version as read', () => {
    expect(decideBodyOf(OPEN, { decision: 'APPROVED', answer: '  left over  ', reason: '  On the phone.  ', typedName: ' Carlo Prova ' })).toEqual({ version: 3, decision: 'APPROVED', typedName: 'Carlo Prova', reason: 'On the phone.' })
    expect(decideBodyOf(OPEN, { decision: 'APPROVED_WITH_CHANGES', answer: ' Shorter sleeve. ', reason: 'On the phone.', typedName: 'Carlo Prova' })).toEqual({ version: 3, decision: 'APPROVED_WITH_CHANGES', answer: 'Shorter sleeve.', typedName: 'Carlo Prova', reason: 'On the phone.' })
  })
})

describe('F-PR-09 — refusals in our words, from their codes', () => {
  const coded = (code: string, kind: 'conflict' | 'forbidden' = 'conflict') => new ApiError(kind, kind === 'conflict' ? 409 : 403, kind, 'English for the logs.', null, [{ path: `refusal/${code}`, message: 'English for the logs.' }])

  it('every code the two routes send has its words; an unknown one is said plainly; the person who asked reads OWN_ASK on a 403', () => {
    for (const code of KNOWN_REFUSALS) expect(overrideProblem(coded(code)).phrase).toEqual({ key: `refusal.${code}` })
    expect(overrideProblem(coded('OWN_ASK', 'forbidden'))).toEqual({ phrase: { key: 'refusal.OWN_ASK' }, fields: {}, reload: true })
    expect(refusalCodeOf(coded('LEATHER_CUT'))).toBe('LEATHER_CUT')
    expect(overrideProblem(coded('SOMETHING_NEW')).phrase).toEqual({ key: 'refusal.other' })
  })

  it('a changed version reads again; a 400 marks its fields; the rest by kind', () => {
    expect(overrideProblem(new ApiError('conflict', 409, 'conflict', 'x', null, []))).toEqual({ phrase: { key: 'refusal.stale' }, fields: {}, reload: true })
    expect(overrideProblem(new ApiError('invalid', 400, 'validation', 'x', null, [{ path: 'body.reason' }, { path: 'body/typedName' }, { path: 'body/answer' }]))).toEqual({
      phrase: { key: 'refusal.invalid' },
      fields: { reason: { key: 'field.reason' }, typedName: { key: 'field.typedName' }, answer: { key: 'field.answer' } },
      reload: false,
    })
    expect(overrideProblem(new ApiError('forbidden', 403, 'forbidden', 'x')).phrase).toEqual({ key: 'refusal.forbidden' })
    expect(overrideProblem(new ApiError('rate_limited', 429, 'rate', 'x')).phrase).toEqual({ key: 'refusal.rateLimited' })
    expect(overrideProblem(new ApiError('unavailable', 503, 'down', 'x')).phrase).toEqual({ key: 'refusal.unavailable' })
    expect(overrideProblem(new Error('boom')).phrase).toEqual({ key: 'refusal.failed' })
    expect(stepUpProblemOf(new ApiError('rate_limited', 429, 'rate', 'x'))).toBe('stepUp.problem.locked')
    expect(stepUpProblemOf(new ApiError('invalid', 400, 'code', 'x'))).toBe('stepUp.problem.wrong')
  })

  it('PW-04 / PW-09 (web): another customer’s request answers 404 — the part draws nothing, and a write refused so reads "not there any more"', () => {
    expect(readOutcomeOf(new ApiError('not_found', 404, 'not_found', 'Approval request not found.'))).toEqual({ hidden: true })
    expect(readOutcomeOf(new ApiError('forbidden', 403, 'forbidden', 'x'))).toEqual({ hidden: true })
    expect(readOutcomeOf(new ApiError('unavailable', 503, 'down', 'x'))).toEqual({ hidden: false, problem: 'read.offline' })
    expect(overrideProblem(new ApiError('not_found', 404, 'not_found', 'x'))).toEqual({ phrase: { key: 'refusal.notFound' }, fields: {}, reload: true })
    for (const locale of LOCALES) {
      const all = Object.values(words(locale)).join('\n')
      expect(all.toLowerCase()).not.toMatch(/another customer|altro cliente|other customer/)
      expect(scanText(all, BRAND_ALPHA)).toEqual([])
      expect(scanText(all, BRAND_BETA)).toEqual([])
    }
  })
})

describe('F-PR-09 — words (it, en) and where the part is mounted', () => {
  it('every key the part says exists in both languages, with the same placeholders; the office says "Customer"', () => {
    const keys = [
      'read.loading', 'read.retry', 'read.failed', 'read.offline', 'act.decide', 'act.reverse',
      ...['noRight', 'ownWord', 'pending', 'answered', 'notOpen', 'notYours', 'reversed', 'notAnswered', 'noReach', 'busy', 'offline', 'reason', 'reasonLong'].map((key) => `held.${key}`),
      ...['pick', 'why', 'changes', 'answerLong', 'typedName', 'typedNameLong'].map((key) => `decide.held.${key}`),
      'fact.decidedFor', 'fact.decidedForUs', 'fact.reversed', 'fact.reversedUs', 'fact.pending.DECIDE_FOR', 'fact.pending.REVERSE', 'fact.openTask',
      'row.decidedFor', 'row.reversed', 'row.pending', 'row.done', 'row.asked',
      'done.decided', 'done.reversed', 'done.secondPerson', 'done.copy', 'done.copied', 'done.copyFailed', 'done.linkOnce',
      ...KNOWN_EFFECTS.map((effect) => `effect.${effect}`), 'effect.other',
      ...['title', 'go', 'body', 'asked', 'legend', 'why', 'changes', 'answerHint', 'reason', 'reasonHint', 'typedName', 'typedNameHint', 'stepUp', 'secondPerson'].map((key) => `decide.${key}`),
      ...['APPROVED', 'APPROVED_WITH_CHANGES', 'REFUSED'].flatMap((decision) => [`decision.${decision}`, `decision.hint.${decision}`]),
      ...['title', 'go', 'answer', 'answerOurs', 'body', 'reason', 'reasonHint'].map((key) => `reverse.${key}`),
      ...['SampleRound', 'SampleSwatch', 'REPROMISE', 'COUNTER_OFFER', 'other'].map((key) => `reverse.what.${key}`),
      ...['OPEN', 'APPROVED', 'APPROVED_WITH_CHANGES', 'REFUSED', 'WITHDRAWN', 'EXPIRED'].map((status) => `status.${status}`),
      ...KNOWN_REFUSALS.map((code) => `refusal.${code}`),
      ...['other', 'stale', 'invalid', 'forbidden', 'notFound', 'stepUp', 'rateLimited', 'unavailable', 'failed'].map((key) => `refusal.${key}`),
      ...['decision', 'answer', 'reason', 'typedName'].map((field) => `field.${field}`),
      'stepUp.title', 'stepUp.sentence', 'stepUp.confirm', 'stepUp.problem.wrong', 'stepUp.problem.locked', 'stepUp.problem.unavailable', 'common.cancel',
    ]
    const holes = (text: string) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort().join(',')
    for (const key of keys) {
      expect(words('en')[key], `en ${key}`).toBeTruthy()
      expect(words('it')[key], `it ${key}`).toBeTruthy()
      expect(holes(words('it')[key]!), key).toBe(holes(words('en')[key]!))
    }
    expect(words('en')['act.decide']).toBe('Decide for {customer}…')
    expect(words('it')['act.decide']).toBe('Decidi per {customer}…')
    for (const text of Object.values(words('en'))) expect(text).not.toMatch(/\bbrand\b/i)
    // The words the customer reads are quoted as the API writes them (approvals-out/rules decidedForPartyWords, reversedWords).
    expect(words('en')['decide.reasonHint']).toContain('Decided by us for you:')
    expect(words('it')['decide.reasonHint']).toContain('Deciso da noi per voi:')
    expect(words('en')['reverse.reasonHint']).toContain('Put back by us:')
    expect(words('it')['reverse.reasonHint']).toContain('Revocato da noi:')
  })

  it('a view’s slot draws nothing without the page’s provider (design cases, tests) and what the provider draws with it', () => {
    const slot = createElement(CustomerOverrideSlot, { source: { requestId: OPEN.id }, customer: BRAND_BETA.legalName })
    expect(renderToStaticMarkup(slot)).toBe('')
    const seen: string[] = []
    const scope = { render: (props: { readonly source: { readonly requestId: string } | { readonly record: { readonly type: string; readonly id: string } }; readonly customer: string }) => (seen.push(props.customer), createElement('i', null, 'part')) }
    expect(renderToStaticMarkup(createElement(CustomerOverrideContext.Provider, { value: scope }, slot))).toBe('<i>part</i>')
    expect(seen).toEqual([BRAND_BETA.legalName])
  })

  it('mounted on the sample round, its swatches, a gate’s round, a new date’s answer and our counter-offer; each page provides it', () => {
    const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
    const approval = source('../../products/samples/record/view/ApprovalTab.tsx')
    expect(approval).toContain('<CustomerOverrideSlot source={{ requestId: view.request.id }}')
    expect(approval).toContain('layout="row"')
    expect(source('../../planning/milestones/view/MilestoneDialog.tsx')).toContain("source={{ record: { type: 'SampleRound', id: gate.sampleRound.id } }}")
    expect(source('../../planning/promise/view/RepromiseModal.tsx')).toContain('source={{ requestId: answer.requestId }}')
    expect(source('../../home/approvals/requests/view/RequestReview.tsx')).toContain('source={{ requestId: request.counter.approvalRequestId }}')
    for (const page of ['../../products/samples/record/SampleRecord.tsx', '../../planning/milestones/MilestonesPage.tsx', '../../planning/promise/PromisePage.tsx', '../../home/approvals/Approvals.tsx']) expect(source(page), page).toContain('<CustomerOverrideProvider')
    // The views only name the request: the slot module fetches nothing (the provider's module does).
    expect(source('./slot.tsx')).not.toMatch(/lib\/api|lib\/session/)
  })
})

// ---- F-PR-16 (the browser walk): Enter sends only from the send button; the dialogs have a design case
describe('F-PR-16 — Decide for and Reverse on screen', () => {
  const draw = (id: string, locale: 'it' | 'en' = 'en') => renderView(designScreen.view as ComponentType<{ model: unknown }>, designScreen.cases.find((item) => item.id === id)!.model, locale)

  it('every case draws in both languages with no key left, and names nothing of another customer', () => {
    for (const item of designScreen.cases)
      for (const locale of LOCALES) {
        const html = draw(item.id, locale)
        expect(leftKeys(html, ['act', 'decide', 'decision', 'reverse', 'held', 'common', 'status']), `${item.id} ${locale}`).toEqual([])
        expect(scanText(html, BRAND_ALPHA), `${item.id} ${locale}`).toEqual([])
      }
  })

  it('Enter in the typed name sends nothing: the fields sit in no form (the send button and ⌘↵ send)', () => {
    for (const id of ['decide', 'decide-refused', 'reverse']) {
      const html = draw(id)
      expect(html, id).toContain('<div class="fw-cov-form"')
      expect(html, id).not.toContain('<form')
      expect(html, id).toContain('aria-keyshortcuts="Meta+Enter Control+Enter"')
    }
    expect(textOf(draw('decide'))).toContain('Decide for Brand Beta')
    expect(textOf(draw('decide-closed'))).not.toContain('Why we decide')
  })
})
// ---- end F-PR-16
