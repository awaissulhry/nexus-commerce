import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EXPEDITE_REASONS as DOMAIN_REASONS, MAX_CHASE_MESSAGE as DOMAIN_MAX_CHASE } from '@nexus/factory-domain/purchasing/expediting/worklist'
import { OVERRIDE_LIMITS, REQUIREMENT_KINDS as DOMAIN_KINDS, REQUIREMENT_STATES as DOMAIN_STATES } from '@nexus/factory-domain/purchasing/qualification/gate'
import { createApiClient, type ApiClient } from '../../../../lib/api/client'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { ROLES } from '../../../_shared/buying/fixtures'
import { isWaitingSend, sendMany, sendOrder } from '../api'
import { outcomeWords } from '../daily-model'
import { BLOCKED_DRAFT, leatherLine, order, protectorLine } from '../demo/fixtures'
import { designScreen as listScreen } from '../list/fixtures'
import { nextStep, sendItems } from '../model'
import { designScreen as recordScreen } from '../record/fixtures'
import { EXPEDITE_REASONS, getDepth, MAX_CHASE_MESSAGE, OVERRIDE_REASON, REQUIREMENT_KINDS, REQUIREMENT_STATES, SOURCES, type Compliance } from './api'
import { approvalOf, chaseModel, complianceOf, depthOf, depthOrder, kindsOf, liningLine, REQUEST, TODAY, WORKLIST_ROWS } from './demo/fixtures'
import {
  allChecks,
  approvalPhrase,
  blocksByOrder,
  blocksOf,
  chaseHeld,
  closedDays,
  copyableLines,
  DEPTH,
  depthCanOf,
  differencePct,
  duplicateDraftHeld,
  kindBody,
  kindDraftOf,
  kindDraftHeld,
  kindPhrases,
  kindWarns,
  lineHeldMark,
  onClosedDay,
  overrideAskHeld,
  overrideDecideHeld,
  overrideReasonHeld,
  rateDraftHeld,
  rateEditHeld,
  receiptLines,
  requirementPhrase,
  scheduleBody,
  scheduleDraftOf,
  scheduleEditHeld,
  scheduleHeld,
  scheduleRows,
  scheduleTotal,
  splitEvenly,
  supplierDateDraftHeld,
  supplierDateHeld,
  supplierDateMode,
  withdrawHeld,
} from './model'

const BUYER = depthCanOf(ROLES.buyer)
const PLANNER = depthCanOf(ROLES.planner)

describe('the lists this screen mirrors (B-W2b-315, B-W2b-305)', () => {
  it('equal the domain’s', () => {
    expect(REQUIREMENT_KINDS).toEqual(DOMAIN_KINDS)
    expect(REQUIREMENT_STATES).toEqual(DOMAIN_STATES)
    expect(OVERRIDE_REASON).toEqual({ min: OVERRIDE_LIMITS.reasonMin, max: OVERRIDE_LIMITS.reason })
    expect(MAX_CHASE_MESSAGE).toBe(DOMAIN_MAX_CHASE)
    expect(EXPEDITE_REASONS).toEqual(DOMAIN_REASONS)
  })
})

describe('the delivery schedule (SCM-052)', () => {
  const line = depthOf(depthOrder(order('DRAFT')), 'one').lines.find((entry) => entry.seq === 10)!
  it('starts a line of one delivery as two a week apart, and keeps a scheduled line’s deliveries', () => {
    expect(scheduleDraftOf(line)).toEqual([
      { quantity: '210', needDate: '2026-11-20', note: '' },
      { quantity: '210', needDate: '2026-11-27', note: '' },
    ])
    const split = depthOf(depthOrder(order('DRAFT')), 'split').lines.find((entry) => entry.seq === 10)!
    expect(scheduleDraftOf(split).map((row) => row.quantity)).toEqual(['220', '200'])
  })
  it('splits evenly with the last taking the rest (adds up exactly)', () => {
    const rows = splitEvenly('100', 3, '2026-11-20', 7)
    expect(rows.map((row) => row.quantity)).toEqual(['33.3333', '33.3333', '33.3334'])
    expect(rows.map((row) => row.needDate)).toEqual(['2026-11-20', '2026-11-27', '2026-12-04'])
    expect(scheduleTotal(rows)).toBe('100')
  })
  it('holds a schedule the API would refuse, in words', () => {
    const at = (rows: { quantity: string; needDate: string }[]) => scheduleHeld(line, rows.map((row) => ({ ...row, note: '' })), TODAY)?.key ?? null
    expect(at([{ quantity: '420', needDate: '2026-11-20' }])).toBe('schedule.held.two')
    expect(at([{ quantity: '220', needDate: '2026-11-20' }, { quantity: '0', needDate: '2026-11-27' }])).toBe('schedule.held.quantity')
    expect(at([{ quantity: '220', needDate: '2026-10-20' }, { quantity: '200', needDate: '2026-11-27' }])).toBe('schedule.held.past')
    expect(at([{ quantity: '220', needDate: '2026-11-20' }, { quantity: '200', needDate: '2026-11-20' }])).toBe('schedule.held.sameDay')
    expect(at([{ quantity: '220', needDate: '2026-11-20' }, { quantity: '180', needDate: '2026-11-27' }])).toBe('schedule.held.sum')
    expect(at([{ quantity: '220,5', needDate: '2026-11-20' }, { quantity: '199.5', needDate: '2026-11-27' }])).toBeNull()
  })
  it('sends the deliveries by day, a comma read as a decimal point', () => {
    expect(scheduleBody([{ quantity: '199,5', needDate: '2026-11-27', note: ' x ' }, { quantity: '220.5', needDate: '2026-11-20', note: '' }])).toEqual([{ quantity: '220.5', needDate: '2026-11-20' }, { quantity: '199.5', needDate: '2026-11-27', note: 'x' }])
  })
  it('changes only on a draft with purchasing.manage', () => {
    expect(scheduleEditHeld('DRAFT', line, BUYER)).toBeNull()
    expect(scheduleEditHeld('SENT', line, BUYER)?.key).toBe('schedule.held.sent')
    expect(scheduleEditHeld('PENDING_APPROVAL', line, BUYER)?.key).toBe('held.waitingForYes')
    expect(scheduleEditHeld('DRAFT', line, PLANNER)?.key).toBe('buying:held.noManage')
  })
  it('records the supplier’s first day (no reason) or a move (a reason), in the states the API takes', () => {
    const depth = depthOf(depthOrder(order('CONFIRMED')), 'later')
    const rows = scheduleRows(depth)
    const second = rows.find((row) => row.delivery?.seq === 2)!
    expect(second.confirmedLaterBy).toBe(7)
    expect(supplierDateMode(second)).toBe('MOVED')
    expect(supplierDateHeld('CONFIRMED', second, BUYER)).toBeNull()
    expect(supplierDateHeld('PARTLY_RECEIVED', second, BUYER)).toBeNull()
    expect(supplierDateHeld('PARTLY_RECEIVED', { confirmedDate: null, ended: false }, BUYER)?.key).toBe('date.held.closed')
    expect(supplierDateHeld('DRAFT', second, BUYER)?.key).toBe('date.held.notSent')
    const draft = { lineId: 'l', deliveryId: 'd', mode: 'MOVED' as const, from: '2026-12-04', date: '2026-12-09', source: 'SUPPLIER' as const, reason: '', contact: '' }
    expect(supplierDateDraftHeld(draft)?.key).toBe('date.held.reason')
    expect(supplierDateDraftHeld({ ...draft, date: '2026-12-04', reason: 'x' })?.key).toBe('date.held.same')
    expect(supplierDateDraftHeld({ ...draft, mode: 'FIRST' })).toBeNull()
    expect(SOURCES).toEqual(['SUPPLIER', 'BUYER'])
  })
  it('shades the supplier’s closures: weekly days off and dated spans', () => {
    const closed = closedDays({ weeklyDaysOff: [6, 7], ahead: [{ from: '2026-12-24', to: '2026-12-26', kind: 'CLOSURE', name: 'Natale', days: 3 }] })
    expect(closed.weekly).toEqual([false, false, false, false, false, true, true])
    expect(Object.keys(closed.days)).toEqual(['2026-12-24', '2026-12-25', '2026-12-26'])
    expect(onClosedDay('2026-11-21', closed)).toBe(true) // a Saturday
    expect(onClosedDay('2026-11-20', closed)).toBe(false)
    expect(onClosedDay('2026-12-24', closed)).toBe(true)
  })
})

describe('the rate at order (SCM-065)', () => {
  it('is typed on a draft in another currency than the company’s', () => {
    const usd = depthOrder(order('DRAFT', { currency: 'USD' }))
    const depth = depthOf(usd, 'one')
    expect(rateEditHeld(usd, depth, BUYER)).toBeNull()
    expect(rateEditHeld(order('SENT', { currency: 'USD' }), depth, BUYER)?.key).toBe('rate.held.sent')
    expect(rateEditHeld(order('DRAFT'), depthOf(order('DRAFT'), 'one'), BUYER)?.key).toBe('rate.held.sameCurrency')
    expect(rateDraftHeld('1,085')).toBeNull()
    expect(rateDraftHeld('0')?.key).toBe('rate.held.bad')
    expect(rateDraftHeld('1.123456789')?.key).toBe('rate.held.bad')
    expect(rateDraftHeld(' ')?.key).toBe('rate.held.empty')
  })
})

describe('lines by kind (SCM-076, SCM-077, SCM-186)', () => {
  const kinds = kindsOf(depthOrder(order('DRAFT')))
  const lining = kinds.lines.find((line) => line.buysAs === 'FABRIC')!
  const protector = kinds.lines.find((line) => line.buysAs === 'PROTECTOR')!
  it('says the rolls, the certificate and a variant', () => {
    expect(kindPhrases(lining)).toEqual([{ key: 'kind.rolls.full', params: { count: 3, length: '50', width: '150' } }])
    expect(kindPhrases(protector)).toEqual([{ key: 'kind.certificate', params: { number: 'CERT-DEMO-0002', standard: 'EN 1621-1:2012' } }])
    expect(kindWarns(protector)).toBe(false)
    const suspended = { ...protector, certificate: { ...protector.certificate!, state: 'NOT_VALID' as const } }
    expect(kindPhrases(suspended).map((words) => words.key)).toEqual(['kind.certificate', 'kind.certificateState.NOT_VALID'])
    expect(kindWarns(suspended)).toBe(true)
    expect(kindPhrases({ ...protector, certificate: null }).map((words) => words.key)).toEqual(['kind.noCertificate'])
  })
  it('sends only what changed; null clears', () => {
    const draft = kindDraftOf(lining)
    expect(kindBody(lining, draft, 4)).toEqual({ version: 4 })
    expect(kindBody(lining, { ...draft, count: '4' }, 4)).toEqual({ version: 4, rolls: { count: 4, lengthM: '50', widthCm: '150' } })
    expect(kindBody(lining, { ...draft, byRolls: false }, 4)).toEqual({ version: 4, rolls: null })
    expect(kindBody(lining, { ...draft, variantCode: 'DEMO-FOD-02-GRY' }, 4)).toEqual({ version: 4, variantCode: 'DEMO-FOD-02-GRY' })
    expect(kindBody(protector, { ...kindDraftOf(protector), certificateId: '' }, 4)).toEqual({ version: 4, certificateId: null })
    expect(kindDraftHeld(lining, { ...draft, count: '0' })?.key).toBe('kind.held.count')
    expect(kindDraftHeld(lining, { ...draft, widthCm: '1000.5' })?.key).toBe('kind.held.width')
  })
})

describe('the compliance gate and the override (SCM-022)', () => {
  const draft = depthOrder(order('DRAFT'))
  const held = complianceOf(draft, 'held')
  it('marks the held line and says what holds it', () => {
    expect(lineHeldMark(held, leatherLine().id)).toHaveLength(1)
    expect(lineHeldMark(held, protectorLine().id)).toHaveLength(0)
    expect(requirementPhrase(held.requirements[0]!)).toEqual({ key: 'mark.CR_VI_TEST_REPORT.EXPIRED', params: { items: 'DEMO-LEA-01', lines: '10', date: '2026-10-02' } })
    // The record's own checks lack the gate's: both are counted, once each.
    expect(allChecks(draft.send!.checks, held).map((check) => check.code)).toEqual(['NOT_A_MULTIPLE', 'COMPLIANCE_DOCUMENT_MISSING'])
    expect(allChecks(held.checks, held)).toHaveLength(1)
  })
  it('asks: a draft, purchasing.send, something held, no request waiting', () => {
    expect(overrideAskHeld(draft, held, BUYER)).toBeNull()
    expect(overrideAskHeld(draft, held, PLANNER)?.key).toBe('buying:held.noSend')
    expect(overrideAskHeld(order('SENT'), held, BUYER)?.key).toBe('override.held.notDraft')
    expect(overrideAskHeld(draft, complianceOf(draft, 'met'), BUYER)?.key).toBe('override.held.nothing')
    expect(overrideAskHeld(draft, complianceOf(draft, 'held', REQUEST()), BUYER)?.key).toBe('override.held.waiting')
    expect(overrideReasonHeld('ok')?.key).toBe('override.held.reason')
    expect(overrideReasonHeld('the new report is on its way')).toBeNull()
  })
  it('decides: never the asker (the Owner included), the override right, still current', () => {
    const other = (over: Partial<NonNullable<Compliance['request']>> = {}) => complianceOf(draft, 'held', REQUEST({ askedBy: { id: 'a', name: 'Anna Demo', me: false }, ...over }), { decide: true })
    const decider = depthCanOf([...ROLES.owner, 'purchasing.compliance.override'])
    expect(overrideDecideHeld(other(), decider)).toBeNull()
    expect(overrideDecideHeld(complianceOf(draft, 'held', REQUEST(), { decide: true }), decider)?.key).toBe('decide.held.own')
    expect(overrideDecideHeld(other(), depthCanOf(ROLES.owner))?.key).toBe('decide.held.noRight')
    expect(overrideDecideHeld(other({ current: false }), decider)?.key).toBe('decide.held.stale')
    expect(overrideDecideHeld(complianceOf(draft, 'held'), decider)?.key).toBe('decide.held.none')
  })
})

describe('what a line blocks if late (SCM-064) and the list’s worklist (SCM-068)', () => {
  it('names the work and customer orders, the most days late', () => {
    const blocks = blocksOf(WORKLIST_ROWS[0]!.blocks.entries)
    expect(blocks.salesOrders.map((entry) => entry.number)).toEqual(['SO-DEMO-1043'])
    expect(blocks.workOrders).toEqual([])
    expect(blocks.lateBy).toBe(3)
    const byOrder = blocksByOrder(WORKLIST_ROWS)
    expect([...byOrder.keys()]).toHaveLength(2)
    expect(byOrder.get(WORKLIST_ROWS[1]!.purchaseOrderId)!.workOrders.map((entry) => entry.number)).toEqual(['WO-DEMO-0230'])
  })
})

describe('the chase', () => {
  const sent = depthOrder(order('CONFIRMED'))
  it('holds Send chase with the reason', () => {
    expect(chaseHeld(chaseModel(sent), 'CONFIRMED', BUYER)).toBeNull()
    expect(chaseHeld(chaseModel(sent), 'CONFIRMED', PLANNER)?.key).toBe('buying:held.noSend')
    expect(chaseHeld(chaseModel(sent), 'CONFIRMED', BUYER, true)?.key).toBe('chase.held.offline')
    expect(chaseHeld(chaseModel(sent), 'DRAFT', BUYER)?.key).toBe('chase.held.notSent')
    expect(chaseHeld(chaseModel(sent, { preview: { status: 'loading' } }), 'CONFIRMED', BUYER)?.key).toBe('chase.held.reading')
    expect(chaseHeld(chaseModel(sent, { lineIds: [] }), 'CONFIRMED', BUYER)?.key).toBe('chase.held.noLine')
    expect(chaseHeld(chaseModel(sent, { message: 'x'.repeat(MAX_CHASE_MESSAGE + 1) }), 'CONFIRMED', BUYER)?.key).toBe('chase.held.long')
  })
})

describe('duplicate, approval, receipts', () => {
  it('copies every line not cancelled; a need date today or later', () => {
    const value = order('CONFIRMED', { lines: [leatherLine(), protectorLine({ ended: { kind: 'CANCELLED', at: '2026-10-29T10:00:00Z', byId: null, reason: 'x' } })] })
    expect(copyableLines(value).map((line) => line.seq)).toEqual([10])
    expect(duplicateDraftHeld({ lineIds: [], needDate: '' }, TODAY)?.key).toBe('duplicate.held.noLine')
    expect(duplicateDraftHeld({ lineIds: ['x'], needDate: '2026-10-01' }, TODAY)?.key).toBe('duplicate.held.past')
  })
  it('says the approval’s state and holds Send while it waits', () => {
    const waiting = depthOrder(order('PENDING_APPROVAL'))
    expect(approvalPhrase(approvalOf(waiting, 'WAITING'))?.words.key).toBe('approval.waitingDue')
    expect(approvalPhrase(approvalOf(waiting, 'NONE'))).toBeNull()
    expect(withdrawHeld(approvalOf(waiting, 'WAITING'), BUYER)).toBeNull()
    expect(withdrawHeld(approvalOf(waiting, 'WAITING'), PLANNER)?.key).toBe('buying:held.noSend')
    expect(nextStep(waiting, { poSend: true, receive: false }, { approval: 'WAITING' })).toEqual({ kind: 'send', held: { key: 'purchasing-orders-depth:held.waitingForYes' } })
    expect(nextStep(waiting, { poSend: true, receive: false }, { approval: 'APPROVED' }).held).toBeNull()
    // The gate's checks hold a draft's Send too.
    expect(nextStep(order('DRAFT'), { poSend: true, receive: false }, { checks: [{ code: 'COMPLIANCE_DOCUMENT_MISSING', severity: 'BLOCKS', path: 'lines/0' }] }).held?.key).toBe('po.check.COMPLIANCE_DOCUMENT_MISSING')
  })
  it('puts each line against its tolerance: over, short, nothing yet', () => {
    const value = depthOrder(order('PARTLY_RECEIVED'), [{ ...leatherLine({ receivedBaseQuantity: '440.0000' }) }, protectorLine({ receivedBaseQuantity: '12.0000' }), liningLine()])
    const lines = receiptLines(value, depthOf(value, 'one'))
    expect(lines.map((line) => line.difference?.kind ?? null)).toEqual(['WITHIN_TOLERANCE', 'SHORT', null])
    expect(differencePct(lines[0]!)).toBe('4.8')
    const over = receiptLines(depthOrder(order('PARTLY_RECEIVED'), [leatherLine({ receivedBaseQuantity: '450.0000' })]), null)
    expect(over[0]!.difference?.kind).toBe('OVER')
  })
})

describe('the send dialog’s check list (pop:send W2b)', () => {
  const words = (key: string) => key
  it('passes "documents valid" unless the gate holds it, and links each depth check to where it is fixed', () => {
    const ok = sendItems([], words, '/w/DEMO/purchasing/orders/x', words)
    expect(ok.status === 'ready' && ok.items.some((item) => item.id === 'pass-documents')).toBe(true)
    const held = sendItems([{ code: 'COMPLIANCE_DOCUMENT_MISSING', severity: 'BLOCKS', path: 'lines/0' }, { code: 'DELIVERY_DATE_PAST', severity: 'BLOCKS', path: 'lines/0' }, { code: 'NO_RATE_AT_ORDER', severity: 'BLOCKS', path: 'rateAtOrder' }], words, '/w/DEMO/purchasing/orders/x', words)
    expect(held.status === 'ready' && held.items.some((item) => item.id === 'pass-documents')).toBe(false)
    if (held.status === 'ready') expect(held.items.filter((item) => item.state === 'blocks').map((item) => item.fix?.href)).toEqual(['/w/DEMO/purchasing/orders/x?tab=lines', '/w/DEMO/purchasing/orders/x?tab=schedule', '/w/DEMO/purchasing/orders/x?tab=lines&edit=rate'])
    // Without this step's words (W1's callers) nothing changes.
    const w1 = sendItems(BLOCKED_DRAFT().send!.checks, words, '/x')
    expect(w1.status === 'ready' && w1.items.some((item) => item.id === 'pass-documents')).toBe(false)
  })
})

describe('the calls', () => {
  function recorder(answers: Record<string, { status?: number; body: unknown }>) {
    const calls: { method: string; url: string; body: unknown; key: string | null }[] = []
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : undefined, key: headers.get('idempotency-key') })
      const path = new URL(url, 'http://x').pathname
      const answer = Object.entries(answers).find(([suffix]) => path.endsWith(suffix))?.[1] ?? { body: {} }
      return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const api: ApiClient = createApiClient({ baseUrl: '/api', fetch: fetchFn, csrfToken: () => 'csrf' })
    return { api, calls }
  }
  const value = order('DRAFT')
  it('reads the depth (unknown fields dropped) and a send that waits for a yes (202)', async () => {
    const { api, calls } = recorder({ '/depth': { body: { depth: { ...depthOf(value, 'split'), extra: 1 } } }, '/send': { status: 202, body: { order: { ...value, status: 'PENDING_APPROVAL' }, approval: { taskId: 't1', approver: { kind: 'ROLE', id: 'r', name: 'Finance' }, dueAt: null } } }, '/send-many': { body: { sent: 0, refused: 0, outcomes: [{ id: value.id, number: value.number, outcome: 'WAITING', sent: null, delivery: null, refused: null, approval: { taskId: 't1', approver: null, dueAt: null } }] } } })
    expect((await getDepth(api, 'o1')).lines[0]!.deliveries).toHaveLength(2)
    const answer = await sendOrder(api, 'o1', { version: 4 }, 'k1')
    expect(isWaitingSend(answer) && answer.approval.taskId).toBe('t1')
    const outcomes = await sendMany(api, { orders: [{ id: value.id, version: 4 }] }, 'k2')
    expect(outcomeWords(outcomes[0]!).key).toBe('purchasing-orders-depth:approval.waitingAsked')
    expect(calls.map((call) => `${call.method} ${call.url} ${call.key ?? ''}`)).toEqual(['GET /api/purchasing/orders/o1/depth ', 'POST /api/purchasing/orders/o1/send k1', 'POST /api/purchasing/orders/send-many k2'])
  })
})

describe('the words', () => {
  it('every dynamic key exists in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, [DEPTH])[DEPTH]!)
      const has = (key: string, count?: number) => expect(t(key, count === undefined ? undefined : { count }), `${locale}: ${key}`).not.toBe(key)
      for (const kind of REQUIREMENT_KINDS) for (const state of REQUIREMENT_STATES) has(`mark.${kind}.${state}`)
      for (const kind of REQUIREMENT_KINDS) has(`override.why.${kind}`)
      for (const kind of ['CR_VI_TEST_REPORT', 'PPE_CERTIFICATE']) has(`law.${kind}`)
      for (const reason of EXPEDITE_REASONS) has(`reason.${reason}`)
      for (const state of ['DRAFT', 'ASKED', 'CONFIRMED', 'LATER']) has(`schedule.state.${state}`)
      for (const source of SOURCES) has(`date.sourceOf.${source}`)
      for (const state of ['HOLDS', 'NOT_VALID', 'OTHER_SUPPLIER', 'NOT_COVERING']) has(`kind.certificateState.${state}`)
      for (const kind of ['EXACT', 'WITHIN_TOLERANCE', 'OVER', 'SHORT']) has(`tolerance.kind.${kind}`)
      for (const source of ['LINE', 'RULE', 'NONE']) has(`tolerance.source.${source}`)
      for (const key of ['failed', 'wrong', 'locked', 'noAuthenticator', 'tooMany']) has(`stepUp.problem.${key}`)
      has('later.days', 2)
    }
  })
})

/** A key of this step's catalogue left on screen (the translator answers a missing key with the key itself). */
const OWN_KEY = /\b(?:tab|held|refused|tile|view|list|later|lines|blocks|schedule|scheduleDialog|clear|date|calendar|history|rate|totals|kind|kindDialog|mark|law|request|override|decide|stepUp|withdraw|approval|chase|reason|language|duplicate|late|tolerance|send|notice)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/
const PERMISSIONS = /\b(?:parties\.view|purchasing\.(?:view|manage|send|compliance\.override)|money\.cost)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, Object.keys(CATALOGUE[locale])) }, createElement(View, { model })))
}

describe('every B-W2b-333 design case draws in both languages with no key left on screen', () => {
  for (const screen of [listScreen, recordScreen] as unknown as DesignScreen<unknown>[]) {
    const cases = screen.cases.filter((item) => item.id.startsWith('w2b-333-'))
    it(`${screen.screen}: ${cases.length} cases × it, en`, () => {
      expect(cases.length).toBeGreaterThan(10)
      for (const item of cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(PERMISSIONS, '').replace(/<[^>]+>/g, ' ')
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
          expect(html.match(OWN_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      }
    })
  }
})
