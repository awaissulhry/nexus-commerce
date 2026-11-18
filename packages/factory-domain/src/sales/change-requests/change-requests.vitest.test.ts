import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { partnerTemplateOf, ROLE_TEMPLATES } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { KIND_RULES } from '../../insights/attention'
import { orderChangeRequestWords } from '../../insights/words'
import { PARTNER_MESSAGE_TEMPLATES, partnerSentence } from '../../portal/notifications/messages'
import { ORDER_CHANGE_ASKER_TEMPLATES, PORTAL_SALES_ORDERS_ASK } from './permissions'
import {
  amendmentLinesOf,
  answerProblems,
  askedSummary,
  isSalesRequestKind,
  isWaitingRequest,
  KIND_WORDS,
  ORDER_REQUEST_KIND_WORDS,
  ORDER_REQUEST_KINDS,
  REQUEST_STATUS_WORDS,
  REQUEST_STATUSES,
  WAITING_REQUEST_STATUSES,
  cancelCellsOf,
  cancelProblems,
  changeCellsOf,
  changeProblems,
  cutoffProblems,
  cutoffsOf,
  dayWords,
  NO_CUTOFFS,
  rulesOf,
  type Cutoffs,
  type RuleLine,
  type RuleOrder,
} from './rules'
// B-PR-24: the production asks, the impact, the counter-offer, the one date-only helper.
import { DATE_ONLY_KEYS, dateOnly } from '../../planning/promise/date-only'
import { ASK_NOT_OPEN_WORDS } from '../../production-brand/words'
import { suggestedAnswer } from '../inquiries/production-answer'
import type { FreezeRuleFacts } from '../order-changes/freeze'
import { acceptedWithCounter, counterAnswerHeld, counterAnswerOf, counteredWords, counterForReader, counterOutcome, counterPriced, counterProblems, counterQuestion, isCounterable } from './counter'
// B-PR-26: the office's answers, the counter's state and page; every kind in Today's words.
import { ASKED_ONLY_FROM_COUNTER, counterAnswererHeld, counterFactsOf, counterGoneWords, counterStateOf, COUNTER_STATE_WORDS, COUNTER_STATES, officeAnswerProblem, officeAnswersOf } from './counter'
import { customerRequestWords } from '../../insights/words'
import { blockedProblems, earliestWords, IMPACT_NOTES, impactKeepable, impactNamesOnly, impactOf, PRICED_WORDS, type ImpactLine } from './impact'
import { acceptWayProblems, ASK_RULES, askLineVerdict, askVerdict, changeAcceptWays, FLOOR_TASK_WORDS, productionAskProblems, productionCellsOf, productionColumnsOf, type ProductionAskFacts } from './rules'
import { colourInWorkWords, colourKeepsTotal, colourLinesOf, sizesAfter } from './rules' // B-PR-27a

const TODAY = '2026-11-07'
const line = (id: string, seq: number, overrides: Partial<RuleLine> = {}): RuleLine => ({
  id,
  seq,
  kind: 'SIZE_GRID',
  closedShort: false,
  sizes: [
    { size: '50', quantity: 2 },
    { size: '52', quantity: 3 },
  ],
  cut: null,
  ...overrides,
})
const L1 = '00000000-0000-4000-8000-000000000001'
const L2 = '00000000-0000-4000-8000-000000000002'
const order = (overrides: Partial<RuleOrder> = {}): RuleOrder => ({ status: 'CONFIRMED', promiseDate: '2026-12-20', lines: [line(L1, 10), line(L2, 20)], openRequestDay: null, ...overrides })
const cutoffs = (overrides: Partial<Cutoffs> = {}): Cutoffs => ({ ...NO_CUTOFFS, ...overrides })
const offered = new Map([
  [L1, new Set(['48', '50', '52', '54'])],
  [L2, new Set(['50', '52'])],
])
const changeFacts = (overrides: Partial<Parameters<typeof changeProblems>[1]> = {}) => ({ order: order(), cutoffs: NO_CUTOFFS, today: TODAY, requestedDate: '2026-12-01', offered, addressOk: null, ...overrides })
const reasons = new Map([
  ['LEAD_TIME', { needsNote: false }],
  ['OTHER', { needsNote: true }],
])
// B-PR-26: a priced counter-offer (the B-PR-24 tests' own is in their describe).
const COUNTER_B26 = { date: '2026-12-10', fee: 2500, note: 'Only lines 10 and 20.' }

describe('the permission and its roles (B-W2b-183)', () => {
  // B-PR-25: and the customer Production role (production plan §5 Roles: it asks every kind its limits open).
  it('is a partner write held by the customer Buyer, Admin and Production roles only', () => {
    expect(FACTORY_PERMISSIONS.get(PORTAL_SALES_ORDERS_ASK)).toMatchObject({ partner: true, risk: 'write' })
    expect(ORDER_CHANGE_ASKER_TEMPLATES).toEqual(['customer-buyer'])
    for (const key of ['customer-buyer', 'customer-admin', 'customer-production']) expect(partnerTemplateOf(key)?.permissions).toContain(PORTAL_SALES_ORDERS_ASK)
    for (const key of ['customer-finance', 'customer-quality', 'customer-designer', 'customer-viewer', 'supplier-orders', 'supplier-admin', 'subcontractor-jobs', 'guest-accountant', 'partner-approve']) expect(partnerTemplateOf(key)?.permissions).not.toContain(PORTAL_SALES_ORDERS_ASK)
    for (const template of ROLE_TEMPLATES) expect(template.permissions).not.toContain(PORTAL_SALES_ORDERS_ASK)
  })

  it('declares its events (ids, kinds and states only) and the Approvals kind the office answers with orders.manage', () => {
    for (const type of ['order_change_request.asked', 'order_change_request.withdrawn', 'order_change_request.answered']) expect(EVENT_CATALOGUE.find(type, 1)?.live?.permission).toBe('orders.view')
    expect(() => EVENT_CATALOGUE.parse('order_change_request.asked', 1, { requestId: L1, orderId: L2, partyId: L1, kind: 'CHANGE', lines: 1, wholeOrder: false, note: 'x' })).toThrow()
    // B-PR-26: every kind a customer asks, each row acted on by its kind's permission (the rows name it: ASK_RULES answeredWith).
    expect(KIND_RULES.ORDER_CHANGE_REQUEST).toMatchObject({ category: 'APPROVAL', view: 'orders.view', act: ['orders.manage', 'production.brand.manage', 'sales.samples.manage'], decide: 'OPEN' })
    expect(orderChangeRequestWords({ number: 'SO-1', customer: 'Demo Racing', kind: 'CHANGE', sizes: 3, lines: 1 }).sentence.text).toBe('Demo Racing asks to change 3 sizes of order SO-1.')
    expect(orderChangeRequestWords({ number: 'SO-1', customer: 'Demo Racing', kind: 'CHANGE', sizes: 0, lines: 0 }).sentence.text).toBe('Demo Racing asks to change the delivery of order SO-1.')
    expect(orderChangeRequestWords({ number: 'SO-1', customer: 'Demo Racing', kind: 'CANCEL', sizes: 0, lines: 0 }).sentence.text).toBe('Demo Racing asks to cancel order SO-1.')
    expect(orderChangeRequestWords({ number: 'SO-1', customer: 'Demo Racing', kind: 'CANCEL', sizes: 0, lines: 1 }).sentence.text).toBe('Demo Racing asks to cancel 1 line of order SO-1.')
  })

  it('tells the customer of the answer in an order mail topic, without the office’s words', () => {
    for (const key of ['portal.order.change_accepted', 'portal.order.change_refused', 'portal.order.cancel_accepted', 'portal.order.cancel_refused'] as const) expect(PARTNER_MESSAGE_TEMPLATES[key].topic).toBe('ORDERS')
    // th2-backend step 7 (#1549, threads plan §0.5): the notice names the order by the customer's own number (the API's
    // orderNamed: chip "#12", params yourKind/yourSeq), never the office's SO-… series; "per" reads right before "il vostro ordine".
    const notice = { messageKey: 'portal.order.change_refused', recordLabel: '#12', params: { yourKind: 'ORDER', yourSeq: 12 } }
    expect(partnerSentence(notice, 'it', 'Demo')).toBe('La vostra richiesta di modifica per il vostro ordine 12 non è stata accettata')
    expect(partnerSentence(notice, 'en', 'Demo')).toBe('Your change request on your order 12 was not accepted')
    for (const key of ['portal.order.change_accepted', 'portal.order.change_refused', 'portal.order.cancel_accepted', 'portal.order.cancel_refused'] as const)
      for (const locale of ['it', 'en'] as const) expect(partnerSentence({ ...notice, messageKey: key }, locale, 'Demo'), `${key} ${locale}`).not.toMatch(/SO-|#12/)
  })
})

describe('the cut-off rules, before the click (SAL-078)', () => {
  it('lets a confirmed order with no rule be changed and cancelled freely, line by line', () => {
    const rules = rulesOf(order(), NO_CUTOFFS, TODAY)
    expect([rules.change.code, rules.cancel.code]).toEqual(['FREE', 'FREE'])
    expect(rules.cancel.words).toEqual({ it: 'Senza costi', en: 'Free' })
    expect(rules.lines.map((entry) => [entry.seq, entry.change.possible, entry.cancel.possible])).toEqual([
      [10, true, true],
      [20, true, true],
    ])
  })

  it('holds a line whose cutting started, in both languages and with the day', () => {
    expect(dayWords('2026-10-12', 'en')).toBe('12 Oct')
    expect(dayWords('2026-10-12', 'it')).toBe('12 ott')
    const cut = order({ lines: [line(L1, 10, { cut: { day: '2026-10-12', leather: true } }), line(L2, 20, { cut: { day: '2026-10-14', leather: false } })] })
    const rules = rulesOf(cut, NO_CUTOFFS, TODAY)
    expect(rules.lines[0]!.change).toMatchObject({ possible: false, code: 'LEATHER_CUT', day: '2026-10-12', words: { en: 'Not possible: the leather was cut on 12 Oct', it: 'Non possibile: la pelle è stata tagliata il 12 ott' } })
    expect(rules.lines[1]!.cancel).toMatchObject({ possible: false, code: 'CUT', words: { en: 'Not possible: cutting started on 14 Oct' } })
    // A cancel after cutting started is refused for the whole order (the earliest cut named); a change of the date alone still may be asked.
    expect(rules.cancel).toMatchObject({ possible: false, code: 'LEATHER_CUT', day: '2026-10-12' })
    expect(rules.change.possible).toBe(true)
  })

  it('applies the status cut-offs from that status on, the days before the promise, an open request, and the state', () => {
    const settings = cutoffs({ cancelStatus: 'IN_PRODUCTION', cancelDays: 14, changeStatus: 'READY' })
    expect(rulesOf(order({ status: 'IN_PRODUCTION' }), settings, TODAY).cancel).toMatchObject({ code: 'STATUS', words: { en: 'Not possible: in production', it: 'Non possibile: in produzione' } })
    expect(rulesOf(order({ status: 'IN_PRODUCTION' }), settings, TODAY).change.possible).toBe(true)
    expect(rulesOf(order({ status: 'READY' }), settings, TODAY).change).toMatchObject({ code: 'STATUS', words: { en: 'Not possible: ready to ship' } })
    // 14 days to the promise: inside; 15 days: outside; a past promise: inside.
    expect(rulesOf(order({ promiseDate: '2026-11-21' }), settings, TODAY).cancel).toMatchObject({ code: 'DAYS', day: '2026-11-21', words: { en: 'Not possible within 14 days of the delivery date (21 Nov)' } })
    expect(rulesOf(order({ promiseDate: '2026-11-22' }), settings, TODAY).cancel.possible).toBe(true)
    expect(rulesOf(order({ promiseDate: '2026-11-01' }), settings, TODAY).cancel.code).toBe('DAYS')
    expect(rulesOf(order({ promiseDate: null }), settings, TODAY).cancel.possible).toBe(true)
    expect(rulesOf(order(), cutoffs({ changeStatus: 'CONFIRMED' }), TODAY).change.words.en).toBe('Not possible from the portal: write to us on the order')
    expect(rulesOf(order({ openRequestDay: '2026-11-05' }), NO_CUTOFFS, TODAY).change).toMatchObject({ code: 'OPEN_REQUEST', words: { en: 'Your request of 5 Nov waits for our answer' } })
    // B-PR-26 (plan §3, R-35): a partly shipped order is still asked to cancel what is left to ship (closed short at the answer);
    // a change of it is not.
    expect(rulesOf(order({ status: 'PARTLY_SHIPPED' }), NO_CUTOFFS, TODAY).cancel.possible).toBe(true)
    expect(rulesOf(order({ status: 'PARTLY_SHIPPED' }), NO_CUTOFFS, TODAY).change).toMatchObject({ code: 'NOT_ASKABLE', words: { en: 'Not possible: the order is already partly shipped' } })
  })

  it('keeps made-to-measure and closed lines out of what an amendment cannot do; SAL-304 still lets a whole cancel be asked', () => {
    const mtm = order({ lines: [line(L1, 10), line(L2, 20, { kind: 'MADE_TO_MEASURE', sizes: [] })] })
    const rules = rulesOf(mtm, NO_CUTOFFS, TODAY)
    expect(rules.change.code).toBe('MADE_TO_MEASURE')
    expect(rules.lines[0]!.cancel.code).toBe('WHOLE_ORDER_ONLY')
    expect(rules.cancel.possible).toBe(true)
    expect(rulesOf(order({ lines: [line(L1, 10, { closedShort: true }), line(L2, 20)] }), NO_CUTOFFS, TODAY).lines[0]!.change.code).toBe('CLOSED_SHORT')
  })

  it('reads and checks the settings', () => {
    expect(cutoffsOf(null)).toEqual(NO_CUTOFFS)
    expect(cutoffsOf({ cancelCutoffStatus: 'IN_PRODUCTION', cancelCutoffDays: 14, changeCutoffStatus: 'PARTLY_SHIPPED' })).toEqual({ cancelStatus: 'IN_PRODUCTION', cancelDays: 14, changeStatus: null })
    expect(cutoffProblems({ cancelStatus: 'READY', cancelDays: 30, changeStatus: null })).toEqual([])
    expect(cutoffProblems({ cancelStatus: 'SHIPPED', cancelDays: 0, changeStatus: 'X' }).map((issue) => issue.path)).toEqual(['body/cancelCutoffStatus', 'body/changeCutoffStatus', 'body/cancelCutoffDays'])
  })
})

describe('what is asked, at the click (SAL-077, SAL-078)', () => {
  it('takes sizes and pieces of free lines, a new date, an address; refuses in words what the rules hold', () => {
    const ask = { cells: [{ lineId: L1, size: '52', quantity: 5 }, { lineId: L1, size: '54', quantity: 1 }, { lineId: L2, size: '50', quantity: 0 }], requestedDate: '2026-12-10', shipToAddressId: null }
    expect(changeProblems(ask, changeFacts())).toEqual([])
    expect(changeCellsOf(ask, order())).toEqual([
      { orderLineId: L1, size: '52', quantityBefore: 3, quantity: 5 },
      { orderLineId: L1, size: '54', quantityBefore: 0, quantity: 1 },
      { orderLineId: L2, size: '50', quantityBefore: 2, quantity: 0 },
    ])
    const held = changeFacts({ order: order({ lines: [line(L1, 10, { cut: { day: '2026-10-12', leather: true } }), line(L2, 20)] }) })
    expect(changeProblems({ cells: [{ lineId: L1, size: '52', quantity: 5 }] }, held)).toEqual([{ path: 'body/cells/0/LEATHER_CUT', message: 'Not possible: the leather was cut on 12 Oct.' }])
    expect(changeProblems({ cells: [{ lineId: L2, size: '48', quantity: 1 }] }, changeFacts()).map((issue) => issue.path)).toEqual(['body/cells/0/size'])
    expect(changeProblems({ cells: [{ lineId: L2, size: '50', quantity: 2 }] }, changeFacts())[0]!.message).toBe('Size 50 of line 20 already has 2 piece(s).')
    expect(changeProblems({ cells: [{ lineId: L2, size: '50', quantity: 0 }, { lineId: L2, size: '52', quantity: 0 }] }, changeFacts())[0]!.message).toBe('Every piece of line 20 is asked away: ask to cancel that line instead.')
    expect(changeProblems({ cells: [], requestedDate: '2026-11-06' }, changeFacts())[0]!.path).toBe('body/requestedDate')
    expect(changeProblems({ cells: [], requestedDate: '2026-12-01' }, changeFacts())[0]!.message).toBe('The order already asks for this date.')
    expect(changeProblems({ cells: [], shipToAddressId: L1 }, changeFacts({ addressOk: false }))[0]!.path).toBe('body/shipToAddressId')
    expect(changeProblems({ cells: [] }, changeFacts())[0]!.message).toBe('Say what should change: sizes, a colour, the date or the delivery address.') // B-PR-27a: a colour too
    expect(changeProblems({ cells: [] }, changeFacts({ cutoffs: cutoffs({ changeStatus: 'CONFIRMED' }) }))[0]!.path).toBe('body/STATUS')
  })

  it('takes a cancel of the whole order or of some lines with a reason; "Other" asks for their words', () => {
    const facts = { order: order(), cutoffs: NO_CUTOFFS, today: TODAY, reasons }
    expect(cancelProblems({ reasonCode: 'LEAD_TIME' }, facts)).toEqual([])
    expect(cancelCellsOf({ reasonCode: 'LEAD_TIME' }, order())).toEqual([])
    // Every line named is the whole order.
    expect(cancelCellsOf({ reasonCode: 'LEAD_TIME', lineIds: [L1, L2] }, order())).toEqual([])
    expect(cancelCellsOf({ reasonCode: 'LEAD_TIME', lineIds: [L2] }, order())).toEqual([{ orderLineId: L2, size: null, quantityBefore: 5, quantity: 0 }])
    expect(cancelProblems({ reasonCode: 'NOPE' }, facts)[0]!.path).toBe('body/reasonCode')
    expect(cancelProblems({ reasonCode: 'OTHER' }, facts)[0]!.message).toBe('Say why in a few words.')
    expect(cancelProblems({ reasonCode: 'OTHER', note: 'Our season moved' }, facts)).toEqual([])
    const cut = { ...facts, order: order({ lines: [line(L1, 10, { cut: { day: '2026-10-30', leather: true } }), line(L2, 20)] }) }
    expect(cancelProblems({ reasonCode: 'LEAD_TIME' }, cut)[0]).toEqual({ path: 'body/LEATHER_CUT', message: 'Not possible: the leather was cut on 30 Oct.' })
    expect(cancelProblems({ reasonCode: 'LEAD_TIME', lineIds: [L2] }, cut)).toEqual([])
    expect(cancelProblems({ reasonCode: 'LEAD_TIME', lineIds: [L1] }, cut)[0]!.path).toBe('body/lineIds/0/LEATHER_CUT')
  })
})

describe('the office’s answer', () => {
  it('needs words to refuse, at most 2000; accepting may say a word', () => {
    expect(answerProblems('REFUSED', '  ')[0]!.path).toBe('body/answer')
    expect(answerProblems('REFUSED', 'Production already started.')).toEqual([])
    expect(answerProblems('ACCEPTED', null)).toEqual([])
    expect(answerProblems('ACCEPTED', 'x'.repeat(2001))[0]!.message).toBe('At most 2000 characters.')
  })

  it('makes the amendment’s lines: every line named, the asked sizes as asked (0 drops a size)', () => {
    const lines = [line(L1, 10), line(L2, 20)]
    expect(amendmentLinesOf([{ orderLineId: L1, size: '52', quantityBefore: 3, quantity: 5 }, { orderLineId: L1, size: '50', quantityBefore: 2, quantity: 0 }, { orderLineId: L1, size: '54', quantityBefore: 0, quantity: 1 }], lines)).toEqual({
      lines: [
        { id: L1, sizes: [{ size: '52', quantity: 5 }, { size: '54', quantity: 1 }] },
        { id: L2 },
      ],
      changed: true,
    })
    expect(amendmentLinesOf([], lines)).toEqual({ lines: [{ id: L1 }, { id: L2 }], changed: false })
  })
})

// ---- B-PR-23 (production plan, schema wave 4/5): every kind of request said in words, the counter-offer's state --------------
describe('B-PR-23: every kind of request on an order, and a countered one', () => {
  it('the kinds are the portal’s and the production asks, each said in Italian and English; Sales answers CHANGE and CANCEL', () => {
    expect(ORDER_REQUEST_KINDS).toEqual(['CHANGE', 'CANCEL', 'RUSH', 'HOLD', 'RESUME', 'SPLIT_SHIPMENT', 'SAMPLE_ROUND'])
    for (const kind of ORDER_REQUEST_KINDS) {
      const words = ORDER_REQUEST_KIND_WORDS[kind]
      expect(words.it.trim(), kind).not.toBe('')
      expect(words.en.trim(), kind).not.toBe('')
      expect(words.it, kind).not.toBe(words.en)
    }
    expect(ORDER_REQUEST_KIND_WORDS.CHANGE).toEqual(KIND_WORDS.CHANGE)
    expect(ORDER_REQUEST_KIND_WORDS.CANCEL).toEqual(KIND_WORDS.CANCEL)
    // The plan's own words for a customer's urgent ask (17-web-r2 §5).
    expect(ORDER_REQUEST_KIND_WORDS.RUSH).toEqual({ it: 'Urgente – richiesto', en: 'Urgent – asked' })
    expect(ORDER_REQUEST_KINDS.filter((kind) => isSalesRequestKind(kind))).toEqual(['CHANGE', 'CANCEL'])
    expect(isSalesRequestKind('RUSH')).toBe(false)
  })

  it('a countered request waits for the customer, in words that name no amount and no person', () => {
    expect(REQUEST_STATUSES).toContain('COUNTERED')
    for (const status of REQUEST_STATUSES) expect(REQUEST_STATUS_WORDS[status].en.trim(), status).not.toBe('')
    expect(REQUEST_STATUS_WORDS.COUNTERED).toEqual({ it: 'Controproposta: in attesa della vostra risposta', en: 'Our counter-offer: waiting for your answer' })
    expect(WAITING_REQUEST_STATUSES).toEqual(['OPEN', 'COUNTERED'])
    expect(REQUEST_STATUSES.filter((status) => isWaitingRequest(status))).toEqual(['OPEN', 'COUNTERED'])
  })

  it('a production ask asks no sizes and is never a whole-order cancel', () => {
    expect(askedSummary('RUSH', [], { requestedDate: '2026-12-04', shipToAddressId: null })).toEqual({ sizes: 0, lines: 0, date: true, address: false, wholeOrder: false })
    expect(askedSummary('CANCEL', [], { requestedDate: null, shipToAddressId: null }).wholeOrder).toBe(true)
  })
})

// ---- B-PR-24 (production plan §3 "Brand asks, we decide"; 08-backend §4.2; review fixes R-09, R-12, R-14, R-32, R-35, R-50) ---
describe('B-PR-24: what each production ask needs, when it is asked, what accepting it does and who answers it', () => {
  const OPEN_ALL = { productionUrgencyOn: true, productionAskKinds: ['HOLD', 'RESUME', 'SPLIT_SHIPMENT', 'SAMPLE_ROUND'] }
  const askFacts = (overrides: Partial<ProductionAskFacts> = {}): ProductionAskFacts => ({
    order: order({ status: 'IN_PRODUCTION' }),
    limits: OPEN_ALL,
    waitingDay: null,
    ready: false,
    pauseOn: false,
    urgency: null,
    shipComplete: true,
    today: TODAY,
    ...overrides,
  })
  const paths = (issues: readonly { path: string }[]) => issues.map((issue) => issue.path)

  it('one rule per kind: the database\'s columns, who answers it (plan §3), what accepting it does; a resume is never countered', () => {
    expect(Object.keys(ASK_RULES)).toEqual([...ORDER_REQUEST_KINDS])
    const by = (test: (kind: (typeof ORDER_REQUEST_KINDS)[number]) => boolean) => ORDER_REQUEST_KINDS.filter(test)
    expect(by((kind) => ASK_RULES[kind].answeredWith === 'orders.manage')).toEqual(['CHANGE', 'CANCEL', 'SPLIT_SHIPMENT'])
    expect(by((kind) => ASK_RULES[kind].answeredWith === 'production.brand.manage')).toEqual(['RUSH', 'HOLD', 'RESUME'])
    expect(by((kind) => ASK_RULES[kind].answeredWith === 'sales.samples.manage')).toEqual(['SAMPLE_ROUND'])
    // R-35: a partly shipped order may still ask a cancel (its unshipped lines), a rush, a pause and a resume.
    expect(by((kind) => ASK_RULES[kind].statuses.includes('PARTLY_SHIPPED'))).toEqual(['CANCEL', 'RUSH', 'HOLD', 'RESUME'])
    // The database: a date only on a change, a rush (need-by) or a split (first part); a code only on a cancel or a pause.
    expect(by((kind) => ASK_RULES[kind].date)).toEqual(['CHANGE', 'RUSH', 'SPLIT_SHIPMENT'])
    expect(by((kind) => ASK_RULES[kind].reasonCode !== 'NONE')).toEqual(['CANCEL', 'HOLD'])
    expect(by((kind) => ASK_RULES[kind].lines === 'NONE')).toEqual(['RUSH', 'HOLD', 'RESUME'])
    expect(ASK_RULES.SAMPLE_ROUND).toMatchObject({ lines: 'ONE', sampleKind: true, accept: ['SAMPLE_ROUND'] })
    expect(ASK_RULES.RUSH.accept).toEqual(['MARK_URGENT', 'REPROMISE', 'RUSH_FLOOR'])
    expect(ASK_RULES.HOLD.accept).toEqual(['BRAND_HOLD'])
    expect(ASK_RULES.RESUME.accept).toEqual(['LIFT_BRAND_HOLDS'])
    expect(ASK_RULES.SPLIT_SHIPMENT.accept).toEqual(['SHIP_AS_READY', 'REPROMISE'])
    expect(ASK_RULES.CHANGE.accept).toEqual(['AMEND', 'CANCEL_AND_REMAKE', 'CLOSE_SHORT'])
    expect(by((kind) => !isCounterable(kind))).toEqual(['RESUME'])
    for (const kind of ORDER_REQUEST_KINDS) expect(ASK_RULES[kind].acceptWords.it, kind).not.toBe(ASK_RULES[kind].acceptWords.en)
  })

  it('R-50: "Urgent – asked" is open exactly while the urgency switch is on, never through the list; a closed ask says so neutrally', () => {
    expect(askVerdict('RUSH', askFacts({ limits: { productionUrgencyOn: false, productionAskKinds: ['RUSH', 'HOLD'] } }))).toMatchObject({ possible: false, code: 'NOT_OPEN', words: ASK_NOT_OPEN_WORDS })
    expect(askVerdict('RUSH', askFacts({ limits: { productionUrgencyOn: true, productionAskKinds: [] } })).possible).toBe(true)
    expect(askVerdict('HOLD', askFacts({ limits: { productionUrgencyOn: true, productionAskKinds: [] } })).code).toBe('NOT_OPEN')
    expect(askVerdict('SAMPLE_ROUND', askFacts({ limits: { productionUrgencyOn: true, productionAskKinds: ['HOLD'] } })).code).toBe('NOT_OPEN')
    expect(ASK_NOT_OPEN_WORDS.en).not.toMatch(/other customer|another customer|other brand/i)
    expect(paths(productionAskProblems({ kind: 'RUSH' }, askFacts({ limits: { productionUrgencyOn: false, productionAskKinds: [] } })))).toEqual(['body/NOT_OPEN'])
  })

  it('when: a rush or a pause not once everything is ready, a rush not while we locked the order, a pause not twice, a resume only while paused, a split only of an order that ships complete', () => {
    expect(askVerdict('RUSH', askFacts({ order: order({ status: 'PARTLY_SHIPPED' }) })).possible).toBe(true)
    expect(askVerdict('RUSH', askFacts({ order: order({ status: 'SHIPPED' }) }))).toMatchObject({ code: 'NOT_ASKABLE', words: { en: 'Not possible: the order is already shipped' } })
    expect(askVerdict('RUSH', askFacts({ ready: true })).code).toBe('READY')
    expect(askVerdict('RUSH', askFacts({ urgency: { urgency: 'REGULAR', locked: true, lockReason: 'Capacity is full this month' } }))).toMatchObject({ code: 'LOCKED', words: { en: 'Set to Regular by us: Capacity is full this month' } })
    expect(askVerdict('RUSH', askFacts({ waitingDay: '2026-11-02' }))).toMatchObject({ code: 'WAITING', day: '2026-11-02', words: { en: 'Your request of 2 Nov waits for our answer' } })
    expect(askVerdict('HOLD', askFacts({ order: order({ status: 'READY' }), ready: true }))).toMatchObject({ code: 'READY', words: { en: expect.stringMatching(/write to us in the order's thread/) } })
    expect(askVerdict('HOLD', askFacts({ pauseOn: true })).code).toBe('PAUSED')
    expect(askVerdict('HOLD', askFacts({ order: order({ status: 'PARTLY_SHIPPED' }) })).possible).toBe(true)
    expect(askVerdict('RESUME', askFacts()).code).toBe('NOT_PAUSED')
    expect(askVerdict('RESUME', askFacts({ pauseOn: true })).possible).toBe(true)
    expect(askVerdict('SPLIT_SHIPMENT', askFacts({ shipComplete: false })).code).toBe('SHIPS_AS_READY')
    expect(askVerdict('SPLIT_SHIPMENT', askFacts({ order: order({ status: 'PARTLY_SHIPPED' }) })).code).toBe('NOT_ASKABLE')
    expect(askVerdict('SAMPLE_ROUND', askFacts()).possible).toBe(true)
    // A pre-production or size set round only before the line's cutting started; a top-of-production round any time.
    const cutLine = line(L1, 10, { cut: { day: '2026-10-12', leather: true } })
    expect(askLineVerdict('SAMPLE_ROUND', cutLine, askFacts(), 'PRE_PRODUCTION')).toMatchObject({ code: 'LEATHER_CUT', words: { en: expect.stringMatching(/^Not possible: the leather was cut on 12 Oct\. You can ask for a top-of-production sample/) } })
    expect(askLineVerdict('SAMPLE_ROUND', cutLine, askFacts(), 'SIZE_SET').possible).toBe(false)
    expect(askLineVerdict('SAMPLE_ROUND', cutLine, askFacts(), 'TOP_OF_PRODUCTION').possible).toBe(true)
    expect(askLineVerdict('SPLIT_SHIPMENT', line(L1, 10, { closedShort: true }), askFacts()).code).toBe('CLOSED_SHORT')
  })

  it('what each needs: a rush\'s need-by date earlier than the promise, a pause\'s why, a split\'s first part, a sample\'s line and kind', () => {
    // RUSH: the whole order, an optional need-by date (today on, earlier than the promise of 20 Dec), their words.
    expect(productionAskProblems({ kind: 'RUSH', requestedDate: '2026-12-01', note: 'For the fair.' }, askFacts())).toEqual([])
    expect(productionAskProblems({ kind: 'RUSH' }, askFacts())).toEqual([])
    expect(paths(productionAskProblems({ kind: 'RUSH', requestedDate: '2026-11-01' }, askFacts()))).toEqual(['body/requestedDate'])
    expect(productionAskProblems({ kind: 'RUSH', requestedDate: '2026-12-21' }, askFacts())[0]?.message).toBe('The order is promised for 20 Dec already: the date you need it by is earlier than that.')
    expect(paths(productionAskProblems({ kind: 'RUSH' }, askFacts({ urgency: { urgency: 'URGENT', locked: false, lockReason: null } })))).toEqual(['body/ALREADY_URGENT'])
    expect(productionAskProblems({ kind: 'RUSH', requestedDate: '2026-12-01' }, askFacts({ urgency: { urgency: 'URGENT', locked: false, lockReason: null } }))).toEqual([])
    expect(paths(productionAskProblems({ kind: 'RUSH', lineId: L1, reasonCode: 'LEAD_TIME', cells: [{ lineId: L1, size: '50', quantity: 1 }], sampleKind: 'BRAND' }, askFacts()))).toEqual(['body/reasonCode', 'body/cells', 'body/lineId', 'body/sampleKind'])
    // HOLD: why — their words, or a code of the list when one is offered; never a date.
    expect(paths(productionAskProblems({ kind: 'HOLD' }, askFacts()))).toEqual(['body/note'])
    expect(productionAskProblems({ kind: 'HOLD', note: 'Our store opening moved.' }, askFacts())).toEqual([])
    expect(paths(productionAskProblems({ kind: 'HOLD', note: 'x', requestedDate: '2026-12-01' }, askFacts()))).toEqual(['body/requestedDate'])
    expect(paths(productionAskProblems({ kind: 'HOLD', reasonCode: 'NOPE' }, askFacts({ holdReasons: reasons })))).toEqual(['body/reasonCode'])
    expect(productionAskProblems({ kind: 'HOLD', reasonCode: 'LEAD_TIME' }, askFacts({ holdReasons: reasons }))).toEqual([])
    expect(paths(productionAskProblems({ kind: 'HOLD', reasonCode: 'OTHER' }, askFacts({ holdReasons: reasons })))).toEqual(['body/note'])
    // RESUME: nothing more, while paused.
    expect(productionAskProblems({ kind: 'RESUME' }, askFacts({ pauseOn: true }))).toEqual([])
    // SPLIT_SHIPMENT: the first part, 1 to the pieces of each size of the order's own lines, never the whole order.
    expect(productionAskProblems({ kind: 'SPLIT_SHIPMENT', cells: [{ lineId: L1, size: '52', quantity: 2 }], requestedDate: '2026-11-20' }, askFacts())).toEqual([])
    expect(paths(productionAskProblems({ kind: 'SPLIT_SHIPMENT' }, askFacts()))).toEqual(['body/cells'])
    expect(paths(productionAskProblems({ kind: 'SPLIT_SHIPMENT', cells: [{ lineId: L1, size: '52', quantity: 0 }] }, askFacts()))).toEqual(['body/cells/0/quantity'])
    expect(paths(productionAskProblems({ kind: 'SPLIT_SHIPMENT', cells: [{ lineId: L1, size: '52', quantity: 4 }] }, askFacts()))).toEqual(['body/cells/0/quantity'])
    expect(paths(productionAskProblems({ kind: 'SPLIT_SHIPMENT', cells: [{ lineId: L1, size: '56', quantity: 1 }] }, askFacts()))).toEqual(['body/cells/0/size'])
    expect(paths(productionAskProblems({ kind: 'SPLIT_SHIPMENT', cells: [{ lineId: '00000000-0000-4000-8000-0000000000ff', size: '52', quantity: 1 }] }, askFacts()))).toEqual(['body/cells/0/lineId'])
    const whole = [L1, L2].flatMap((id) => [{ lineId: id, size: '50', quantity: 2 }, { lineId: id, size: '52', quantity: 3 }])
    expect(productionAskProblems({ kind: 'SPLIT_SHIPMENT', cells: whole }, askFacts())[0]?.message).toMatch(/^That is the whole order/)
    // SAMPLE_ROUND: one line of the order and the kind of round.
    expect(productionAskProblems({ kind: 'SAMPLE_ROUND', lineId: L2, sampleKind: 'SIZE_SET', note: 'Check the 52.' }, askFacts())).toEqual([])
    expect(paths(productionAskProblems({ kind: 'SAMPLE_ROUND', lineId: L2 }, askFacts()))).toEqual(['body/sampleKind'])
    expect(paths(productionAskProblems({ kind: 'SAMPLE_ROUND', lineId: L2, sampleKind: 'PROTO' }, askFacts()))).toEqual(['body/sampleKind'])
    expect(paths(productionAskProblems({ kind: 'SAMPLE_ROUND', sampleKind: 'BRAND' }, askFacts()))).toEqual(['body/lineId'])
    expect(paths(productionAskProblems({ kind: 'SAMPLE_ROUND', lineId: L1, sampleKind: 'PRE_PRODUCTION', requestedDate: '2026-12-01' }, askFacts({ order: order({ status: 'IN_PRODUCTION', lines: [line(L1, 10, { cut: { day: '2026-11-03', leather: false } }), line(L2, 20)] }) })))).toEqual(['body/requestedDate', 'body/lineId/CUT'])
  })

  it('what it stores: a split\'s first part, the sample round\'s one line (one piece), each column only on its kind', () => {
    const asked = order()
    expect(productionCellsOf({ kind: 'SPLIT_SHIPMENT', cells: [{ lineId: L1, size: '52', quantity: 2 }] }, asked)).toEqual([{ orderLineId: L1, size: '52', quantityBefore: 3, quantity: 2 }])
    expect(productionCellsOf({ kind: 'SAMPLE_ROUND', lineId: L2, sampleKind: 'BRAND' }, asked)).toEqual([{ orderLineId: L2, size: null, quantityBefore: 5, quantity: 1 }])
    expect(productionCellsOf({ kind: 'RUSH', requestedDate: '2026-12-01' }, asked)).toEqual([])
    expect(productionColumnsOf({ kind: 'RUSH', requestedDate: '2026-12-01', reasonCode: 'LEAD_TIME' })).toEqual({ requestedDate: '2026-12-01', reasonCode: null, reason: null, sampleKind: null })
    expect(productionColumnsOf({ kind: 'HOLD', reasonCode: ' LEAD_TIME ', note: ' Store moved. ', requestedDate: '2026-12-01' })).toEqual({ requestedDate: null, reasonCode: 'LEAD_TIME', reason: 'Store moved.', sampleKind: null })
    expect(productionColumnsOf({ kind: 'SAMPLE_ROUND', lineId: L1, sampleKind: 'TOP_OF_PRODUCTION' })).toEqual({ requestedDate: null, reasonCode: null, reason: null, sampleKind: 'TOP_OF_PRODUCTION' })
  })

  it('R-12: after release a size or quantity change is accepted only as cancel-and-remake or close short; the pieces made are a task for the floor lead', () => {
    const lines = [
      { id: L1, seq: 10, released: true },
      { id: L2, seq: 20, released: false },
    ]
    // A line still in a draft work order (or none), or the date and address alone: the amendment.
    expect(changeAcceptWays([{ orderLineId: L2, size: '52', quantityBefore: 3, quantity: 1 }], lines)).toMatchObject({ ways: ['AMEND'], releasedLineIds: [], floorTask: null })
    expect(changeAcceptWays([], lines).ways).toEqual(['AMEND'])
    // Down only on a released line: close short or cancel-and-remake.
    expect(changeAcceptWays([{ orderLineId: L1, size: '52', quantityBefore: 3, quantity: 1 }], lines)).toEqual({
      ways: ['CLOSE_SHORT', 'CANCEL_AND_REMAKE'],
      releasedLineIds: [L1],
      words: { it: 'La riga 10 è già in produzione: si accetta solo chiudendo prima o annullando e rifacendo.', en: 'Line 10 is in production already: accepted only by closing short, or by cancelling and remaking.' },
      floorTask: FLOOR_TASK_WORDS,
    })
    // More pieces, or another colourway, of a released line: only cancel-and-remake.
    expect(changeAcceptWays([{ orderLineId: L1, size: '52', quantityBefore: 3, quantity: 5 }], lines).ways).toEqual(['CANCEL_AND_REMAKE'])
    expect(changeAcceptWays([{ orderLineId: L1, size: '50', quantityBefore: 2, quantity: 2, colourwayId: '00000000-0000-4000-8000-0000000000c1' }], lines).ways).toEqual(['CANCEL_AND_REMAKE'])
    expect(FLOOR_TASK_WORDS.en).toMatch(/floor lead/)
    expect(acceptWayProblems('AMEND', { ways: ['CANCEL_AND_REMAKE'] })[0]?.message).toMatch(/only as cancel-and-remake or close short/)
    expect(acceptWayProblems('CLOSE_SHORT', { ways: ['CLOSE_SHORT', 'CANCEL_AND_REMAKE'] })).toEqual([])
    expect(paths(acceptWayProblems('CANCEL_AND_REMAKE', { ways: ['AMEND'] }))).toEqual(['body/way'])
  })
})

describe('B-PR-24: the impact before Send — what is frozen, priced or not, the earliest date (a date only)', () => {
  const RULES: FreezeRuleFacts[] = [
    { id: 'rule-size-0042', field: 'SIZE_QUANTITY', frozenFrom: 'CUT', action: 'CHANGE_REQUEST', active: true, note: null },
    { id: 'rule-date-0043', field: 'DELIVERY_DATE', frozenFrom: 'SEWING', action: 'BLOCKED', active: true, note: null },
  ]
  const LINES: ImpactLine[] = [
    { id: L1, seq: 10, closedShort: false, stage: 'CUT', sizeStages: { '50': 'CUT', '52': null } },
    { id: L2, seq: 20, closedShort: false, stage: null },
  ]
  const facts = (overrides: Partial<Parameters<typeof impactOf>[1]> = {}): Parameters<typeof impactOf>[1] => ({ lines: LINES, orderStage: 'CUT', rules: RULES, cancelFeePct: null, earliest: null, ...overrides })

  it('lists what the ask touches that is frozen (per size, line or order), priced yes or no, never an amount', () => {
    const change = impactOf({ kind: 'CHANGE', cells: [{ lineId: L1, size: '50' }, { lineId: L1, size: '52' }, { lineId: L2, size: '50' }] }, facts())
    expect(change.frozen).toEqual([
      { field: 'SIZE_QUANTITY', lineId: L1, line: '10', size: '50', state: 'CHANGE_REQUEST', words: { it: 'Riga 10, taglia 50: Taglio iniziato — taglia bloccata: una modifica è una richiesta di modifica con prezzo che il cliente accetta', en: 'Line 10, size 50: Cutting started — size frozen: a change is a priced change request the customer accepts' } },
    ])
    expect(change).toMatchObject({ priced: true, blocked: false, pricedWords: PRICED_WORDS, notes: [], words: { en: 'Part of what you ask is frozen: it becomes a priced change' } })
    expect(PRICED_WORDS.en).toBe('A price may apply: we will tell you')
    const rush = impactOf({ kind: 'RUSH', requestedDate: '2026-12-01' }, facts({ orderStage: 'SEWING' }))
    expect(rush).toMatchObject({ priced: false, blocked: true, pricedWords: null, notes: [IMPACT_NOTES.RUSH] })
    expect(blockedProblems(rush)).toEqual([{ path: 'body/DELIVERY_DATE', message: 'Sewing started — delivery date frozen: it cannot change any more.' }])
    expect(impactOf({ kind: 'CANCEL' }, facts({ cancelFeePct: '15' })).priced).toBe(true)
    expect(impactOf({ kind: 'CANCEL' }, facts({ cancelFeePct: '0' })).priced).toBe(false)
    expect(impactOf({ kind: 'CANCEL' }, facts()).priced).toBe(false)
    expect(impactOf({ kind: 'HOLD' }, facts())).toMatchObject({ frozen: [], priced: false, notes: [{ it: 'Una pausa può spostare la vostra data', en: 'A pause may move your date' }], words: { en: 'Nothing you ask is frozen' } })
    for (const impact of [change, rush]) expect(impactKeepable(impact)).toBe(true)
  })

  it('says the earliest date as an estimate: "From about 12 Dec — we confirm it", later than asked, partial, or none yet', () => {
    expect(earliestWords(dateOnly([{ date: '2026-12-12', complete: true, meetsWanted: null }]))).toEqual({ it: 'Dal 12 dic circa — ve lo confermiamo noi', en: 'From about 12 Dec — we confirm it' })
    expect(earliestWords(dateOnly([{ date: '2026-12-12', complete: false, meetsWanted: false }])).en).toBe('From about 12 Dec, later than the date you asked — we confirm it (some lines are not dated yet)')
    expect(earliestWords(dateOnly([])).en).toBe('We give you a date once we have planned it')
    expect(impactOf({ kind: 'SAMPLE_ROUND' }, facts({ earliest: dateOnly([{ date: '2026-12-12', complete: true, meetsWanted: true }]) })).earliest).toEqual({ date: '2026-12-12', partial: false, meetsWanted: true, words: { it: 'Dal 12 dic circa — ve lo confermiamo noi', en: 'From about 12 Dec — we confirm it' } })
  })

  it('wall (pure, PW-P06): impact words never carry a load, a line, another order or another brand; no number, no rule id', () => {
    const FOREIGN = '00000000-0000-4000-8000-0000000000ff'
    // Planning's answer as the engine gives it: lanes, steps and minutes, a load, another customer's order in its words.
    const engine = [
      {
        key: L1,
        date: '2026-12-12',
        earliest: '2026-12-10',
        complete: true,
        meetsWanted: false,
        daysLate: 3,
        style: { id: L2, code: 'AX-100', name: 'Racer jacket' },
        steps: [{ lane: { code: 'LINE-3', name: 'Sewing line 3' }, minutes: 840 }],
        groups: [{ sizes: ['50'], load: 0.93 }],
        bridgeWords: 'Waits behind SO-2026-0099 of Brand Beta',
        warnings: [{ words: 'Sewing line 3 is 93% loaded' }],
        words: 'Sewing line 3 · 840 min',
      },
    ]
    const earliest = dateOnly(engine, 0)
    expect(Object.keys(earliest).sort()).toEqual([...DATE_ONLY_KEYS].sort())
    const impact = impactOf({ kind: 'CHANGE', cells: [{ lineId: L1, size: '50' }, { lineId: FOREIGN, size: '50' }], requestedDate: '2026-12-01' }, facts({ earliest, orderStage: 'SEWING' }))
    const text = JSON.stringify(impact)
    for (const leak of ['LINE-3', 'Sewing line', '840', '0.93', '93%', 'SO-2026-0099', 'Brand Beta', 'AX-100', 'Racer', FOREIGN, 'rule-size-0042', 'rule-date-0043', '"load"', '"minutes"', '"lane"', '"steps"']) expect(text, leak).not.toContain(leak)
    expect(impact.frozen.map((item) => item.lineId)).toEqual([L1, null])
    expect(impactNamesOnly(impact, new Set([L1, L2]))).toBe(true)
    expect(impactNamesOnly({ frozen: [{ ...impact.frozen[0]!, lineId: FOREIGN }] }, new Set([L1, L2]))).toBe(false)
    // The database's check, said first: an object of words, codes, dates and yes or no — no number anywhere, at most 8000.
    expect(impactKeepable(impact)).toBe(true)
    expect(impactKeepable({ priced: true, fee: 2500 })).toBe(false)
    expect(impactKeepable({ frozen: [{ line: 10 }] })).toBe(false)
    expect(impactKeepable({ words: 'x'.repeat(8001) })).toBe(false)
    expect(impactKeepable([])).toBe(false)
    expect(impactKeepable(null)).toBe(false)
  })
})

describe('B-PR-24: the one date-only helper (shared with threads B-TH-094)', () => {
  const dated = (date: string | null, complete = true, meetsWanted: boolean | null = null) => ({ date, complete, meetsWanted })

  it('the latest line\'s date, partial when a line is undated, incomplete or left out, whether the wanted date is met — nothing else', () => {
    expect(dateOnly([])).toEqual({ date: null, partial: true, meetsWanted: null })
    expect(dateOnly([dated('2026-12-12', true, true), dated('2026-12-20', true, true)])).toEqual({ date: '2026-12-20', partial: false, meetsWanted: true })
    expect(dateOnly([dated('2026-12-12', true, true), dated(null, false, null)])).toEqual({ date: '2026-12-12', partial: true, meetsWanted: null })
    expect(dateOnly([dated('2026-12-12', true, false), dated('2026-12-01', true, true)]).meetsWanted).toBe(false)
    expect(dateOnly([dated('2026-12-12')], 1).partial).toBe(true)
    expect(Object.isFrozen(dateOnly([]))).toBe(true)
  })

  it('production\'s answer on a request reads the same date through it', () => {
    const lines = [dated('2026-12-12'), dated('2026-12-03', false)]
    expect(suggestedAnswer(lines, 1, null, TODAY)).toMatchObject({ readyDate: dateOnly(lines, 1).date, partial: dateOnly(lines, 1).partial })
    expect(suggestedAnswer([], 0, null, TODAY)).toMatchObject({ readyDate: null, partial: true })
  })
})

describe('B-PR-24: our counter-offer — a date, a price or words; answered by the customer; a priced one only by its buyer', () => {
  const COUNTER = { date: '2026-12-10', fee: 2500, note: 'Only lines 10 and 20.' }

  it('counters an OPEN request once, of a kind we counter, with at least a date, a price or words', () => {
    expect(counterProblems({ kind: 'HOLD', status: 'OPEN' }, COUNTER, TODAY)).toEqual([])
    expect(counterProblems({ kind: 'HOLD', status: 'OPEN' }, {}, TODAY)[0]?.message).toBe('Say what you offer instead: a date, a price or words.')
    expect(counterProblems({ kind: 'HOLD', status: 'OPEN' }, { note: '   ' }, TODAY).map((issue) => issue.path)).toEqual(['body'])
    expect(counterProblems({ kind: 'RUSH', status: 'COUNTERED' }, COUNTER, TODAY)[0]?.message).toMatch(/countered this request already/)
    expect(counterProblems({ kind: 'RUSH', status: 'ACCEPTED' }, COUNTER, TODAY)[0]?.message).toMatch(/accepted/)
    expect(counterProblems({ kind: 'RESUME', status: 'OPEN' }, COUNTER, TODAY)[0]?.message).toMatch(/resume is accepted or refused/)
    expect(counterProblems({ kind: 'CHANGE', status: 'OPEN' }, { date: '2026-11-01' }, TODAY).map((issue) => issue.path)).toEqual(['body/date'])
    expect(counterProblems({ kind: 'CHANGE', status: 'OPEN' }, { fee: -1 }, TODAY).map((issue) => issue.path)).toEqual(['body/fee'])
    expect(counterProblems({ kind: 'CHANGE', status: 'OPEN' }, { fee: 12.5 }, TODAY).map((issue) => issue.path)).toEqual(['body/fee'])
    expect(counterProblems({ kind: 'CHANGE', status: 'OPEN' }, { note: 'x'.repeat(2001) }, TODAY).map((issue) => issue.path)).toEqual(['body/note'])
    expect(counterProblems({ kind: 'CANCEL', status: 'OPEN' }, { fee: 0 }, TODAY)).toEqual([])
  })

  it('R-09: the question never names the amount; a reader without the price grain sees only that a price applies, and its buyer answers', () => {
    const question = counterQuestion('RUSH', COUNTER, 'en')
    expect(question).toBe('Our counter-offer to your request “Urgent – asked”. The date we offer: 10 Dec. A price applies: your buyer sees it. Only lines 10 and 20.')
    expect(counterQuestion('RUSH', COUNTER, 'it')).toBe('La nostra controproposta alla vostra richiesta «Urgente – richiesto». La data che proponiamo: 10 dic. È previsto un costo: lo vede il vostro buyer. Only lines 10 and 20.')
    for (const text of [question, counterQuestion('RUSH', COUNTER, 'it'), counteredWords(COUNTER).en, counteredWords(COUNTER).it]) expect(text).not.toMatch(/2500|25[.,]00|€/)
    expect(counterQuestion('HOLD', { date: null, fee: 0, note: null }, 'en')).toBe('Our counter-offer to your request “Pause request”.')
    expect(counterPriced(COUNTER)).toBe(true)
    expect(counterPriced({ fee: 0 })).toBe(false)
    expect(counterPriced({ fee: null })).toBe(false)
    expect(counterForReader(COUNTER, false)).toEqual({ date: '2026-12-10', note: 'Only lines 10 and 20.', priced: true })
    expect(counterForReader(COUNTER, true)).toEqual({ date: '2026-12-10', note: 'Only lines 10 and 20.', priced: true, fee: 2500 })
    expect(counterAnswerHeld({ priced: true, maySeePrices: false, mayAnswer: true })).toBe('A price may apply: your buyer answers this counter-offer.')
    expect(counterAnswerHeld({ priced: true, maySeePrices: true, mayAnswer: true })).toBeNull()
    expect(counterAnswerHeld({ priced: false, maySeePrices: false, mayAnswer: true })).toBeNull()
    expect(counterAnswerHeld({ priced: false, maySeePrices: true, mayAnswer: false }, 'it')).toMatch(/^Potete leggere questa controproposta/)
    expect(counteredWords(COUNTER).en).toBe('Our counter-offer · 10 Dec · a price applies')
  })

  it('the answer: yes carries the request out with the counter (ACCEPTED), no withdraws it', () => {
    expect(counterOutcome('APPROVED')).toBe('ACCEPTED')
    expect(counterOutcome('REFUSED')).toBe('WITHDRAWN')
    expect(counterAnswerOf('APPROVED_WITH_CHANGES')).toBe('ACCEPTED')
    expect(counterAnswerOf('REFUSED')).toBe('REFUSED')
    expect(acceptedWithCounter({ requestedDate: '2026-12-20' }, { date: null, fee: 0, note: null })).toEqual({ date: '2026-12-20', fee: 0, note: null })
    expect(acceptedWithCounter({ requestedDate: '2026-12-20' }, COUNTER)).toEqual({ date: '2026-12-10', fee: 2500, note: 'Only lines 10 and 20.' })
  })

  it('the events: every kind on asked, withdrawn and answered; countered and counter_answered carry ids, the kind and the answer only', () => {
    const ids = { requestId: L1, orderId: L2, partyId: L1 }
    for (const kind of ORDER_REQUEST_KINDS) {
      expect(() => EVENT_CATALOGUE.parse('order_change_request.asked', 1, { ...ids, kind, lines: 0, wholeOrder: false }), kind).not.toThrow()
      expect(() => EVENT_CATALOGUE.parse('order_change_request.withdrawn', 1, { ...ids, kind }), kind).not.toThrow()
      expect(() => EVENT_CATALOGUE.parse('order_change_request.answered', 1, { ...ids, kind, answer: 'ACCEPTED', amendmentId: null, orderCancelled: false }), kind).not.toThrow()
    }
    expect(() => EVENT_CATALOGUE.parse('order_change_request.countered', 1, { ...ids, kind: 'HOLD', approvalRequestId: L2 })).not.toThrow()
    expect(() => EVENT_CATALOGUE.parse('order_change_request.countered', 1, { ...ids, kind: 'HOLD', approvalRequestId: L2, counterFee: 2500 })).toThrow()
    expect(() => EVENT_CATALOGUE.parse('order_change_request.counter_answered', 1, { ...ids, kind: 'RUSH', answer: 'REFUSED' })).not.toThrow()
    expect(() => EVENT_CATALOGUE.parse('order_change_request.counter_answered', 1, { ...ids, kind: 'RUSH', answer: 'APPROVED' })).toThrow()
    for (const type of ['order_change_request.countered', 'order_change_request.counter_answered']) {
      expect(EVENT_CATALOGUE.get(type, 1).context, type).toBe('sales-change-requests')
      expect(EVENT_CATALOGUE.get(type, 1).live?.permission, type).toBe('orders.view')
    }
  })
})

// ── B-PR-26 (production plan §3 "We accept, counter or refuse with words it reads", "Money", "A partly shipped order may still ask
// to cancel unshipped lines (close short)"; §5 Home › Approvals; L4, L26; R-05, R-32, R-35): the office's answers, the counter's
// state and its page, a partly shipped order's cancel, every kind in Today's words. ───────────────────────────────────────────
describe('B-PR-26: what the office may answer, the counter-offer as the customer reads it, a partly shipped cancel', () => {
  it('a request waits on us while OPEN; a countered one on the customer, then on us once they said yes (accept) or it lapsed (refuse)', () => {
    expect(counterStateOf('OPEN')).toBe('WAITING')
    expect(counterStateOf('APPROVED')).toBe('AGREED')
    expect(counterStateOf('APPROVED_WITH_CHANGES')).toBe('AGREED')
    expect(counterStateOf('REFUSED')).toBe('REFUSED')
    expect(counterStateOf('EXPIRED')).toBe('LAPSED')
    expect(counterStateOf('WITHDRAWN')).toBe('LAPSED')
    expect(counterStateOf(null)).toBeNull()
    // B-PR-40: a yes we put back is no yes (it lapses: refused in words, never accepted); a no put back stays a no.
    expect(counterStateOf('APPROVED', true)).toBe('LAPSED')
    expect(counterStateOf('APPROVED_WITH_CHANGES', true)).toBe('LAPSED')
    expect(counterStateOf('REFUSED', true)).toBe('REFUSED')
    expect(counterStateOf('APPROVED', false)).toBe('AGREED')
    expect(COUNTER_STATE_WORDS.LAPSED.office.en).toMatch(/its yes was put back/)
    expect(COUNTER_STATE_WORDS.LAPSED.customer.it).toMatch(/vi rispondiamo noi/)
    const open = officeAnswersOf({ kind: 'HOLD', status: 'OPEN' }, null)
    expect(open).toMatchObject({ accept: true, refuse: true, counter: true, waitingOn: 'US' })
    // A resume is accepted or refused, never countered (the pause is the customer's to end).
    expect(officeAnswersOf({ kind: 'RESUME', status: 'OPEN' }, null)).toMatchObject({ accept: true, refuse: true, counter: false })
    expect(officeAnswerProblem('COUNTERED', { kind: 'RESUME', status: 'OPEN' }, null)?.path).toBe('request/RESUME')
    expect(officeAnswersOf({ kind: 'CANCEL', status: 'COUNTERED' }, 'WAITING')).toMatchObject({ accept: false, refuse: false, counter: false, waitingOn: 'CUSTOMER' })
    expect(officeAnswersOf({ kind: 'CANCEL', status: 'COUNTERED' }, 'AGREED')).toMatchObject({ accept: true, refuse: false, counter: false, waitingOn: 'US' })
    expect(officeAnswersOf({ kind: 'CANCEL', status: 'COUNTERED' }, 'LAPSED')).toMatchObject({ accept: false, refuse: true, counter: false, waitingOn: 'US' })
    expect(officeAnswersOf({ kind: 'CANCEL', status: 'COUNTERED' }, 'REFUSED')).toMatchObject({ accept: false, refuse: false, counter: false, waitingOn: null })
    for (const status of ['ACCEPTED', 'REFUSED', 'WITHDRAWN'] as const) expect(officeAnswersOf({ kind: 'RUSH', status }, null)).toMatchObject({ accept: false, refuse: false, counter: false, waitingOn: null })
    // Refused in words, by path: the request's state, or the counter's.
    expect(officeAnswerProblem('ACCEPTED', { kind: 'CHANGE', status: 'COUNTERED' }, 'WAITING')).toEqual({ path: 'request/COUNTER_WAITING', message: 'Our counter-offer waits for the customer’s answer: they answer it first.' })
    expect(officeAnswerProblem('REFUSED', { kind: 'CHANGE', status: 'COUNTERED' }, 'AGREED')?.path).toBe('request/COUNTER_AGREED')
    expect(officeAnswerProblem('COUNTERED', { kind: 'CHANGE', status: 'COUNTERED' }, 'LAPSED')?.message).toMatch(/^A request is countered once/)
    expect(officeAnswerProblem('ACCEPTED', { kind: 'CHANGE', status: 'COUNTERED' }, 'LAPSED')?.path).toBe('request/COUNTER_LAPSED')
    expect(officeAnswerProblem('REFUSED', { kind: 'CHANGE', status: 'WITHDRAWN' }, null)).toEqual({ path: 'request/WITHDRAWN', message: 'The customer withdrew this request.' })
    expect(officeAnswerProblem('ACCEPTED', { kind: 'CHANGE', status: 'ACCEPTED' }, null)?.path).toBe('request/ACCEPTED')
    expect(officeAnswerProblem('ACCEPTED', { kind: 'CHANGE', status: 'OPEN' }, null)).toBeNull()
    expect(officeAnswerProblem('ACCEPTED', { kind: 'CHANGE', status: 'COUNTERED' }, 'AGREED')).toBeNull()
    expect(officeAnswerProblem('REFUSED', { kind: 'CHANGE', status: 'COUNTERED' }, 'LAPSED')).toBeNull()
    // The words of each state, for both audiences; the customer's Italian says "voi".
    for (const state of COUNTER_STATES) {
      expect(COUNTER_STATE_WORDS[state].customer.it.length, state).toBeGreaterThan(0)
      expect(COUNTER_STATE_WORDS[state].office.en.length, state).toBeGreaterThan(0)
      expect(COUNTER_STATE_WORDS[state].customer.it, state).not.toMatch(/\b(tua|tuo|tuoi|tue|ti)\b/)
    }
  })

  it('money: a priced counter-offer is answered only in the portal by a role with prices; its page never names the amount', () => {
    expect(counterAnswererHeld({ priced: true, via: 'PORTAL', seesPrices: true }, 'en')).toBeNull()
    expect(counterAnswererHeld({ priced: true, via: 'PORTAL', seesPrices: false }, 'en')).toBe('A price may apply: your buyer answers this counter-offer.')
    expect(counterAnswererHeld({ priced: true, via: 'PORTAL', seesPrices: false }, 'it')).toBe('Può essere previsto un costo: a questa controproposta risponde il vostro buyer.')
    expect(counterAnswererHeld({ priced: false, via: 'PORTAL', seesPrices: false }, 'en')).toBeNull()
    // Never by a link (it answers for no role): in the portal.
    expect(counterAnswererHeld({ priced: false, via: 'LINK', seesPrices: true }, 'en')).toBe('Answer this counter-offer in your portal.')
    const facts = counterFactsOf({ kind: 'RUSH', orderNumber: 'SO-1', askedOn: '2026-11-05', requestedDate: '2026-12-20', counter: COUNTER_B26 }, 'en')
    expect(facts).toEqual([
      { label: 'Order', value: 'SO-1' },
      { label: 'Your request', value: 'Urgent – asked · 5 Nov' },
      { label: 'The date you asked', value: '20 Dec' },
      { label: 'The date we offer', value: '10 Dec' },
      { label: 'Price', value: 'A price applies: your buyer sees it' },
      { label: 'Our words', value: 'Only lines 10 and 20.' },
    ])
    for (const locale of ['it', 'en'] as const) expect(JSON.stringify(counterFactsOf({ kind: 'RUSH', orderNumber: 'SO-1', askedOn: '2026-11-05', requestedDate: null, counter: COUNTER_B26 }, locale))).not.toMatch(/2500|25[.,]00|€/)
    expect(counterFactsOf({ kind: 'HOLD', orderNumber: 'SO-1', askedOn: '2026-11-05', requestedDate: null, counter: { date: null, fee: 0, note: null } }, 'it')).toContainEqual({ label: 'Costo', value: 'Nessun costo' })
    expect(counterGoneWords('en')).toBe('This counter-offer no longer waits: the request moved on since.')
    expect(ASKED_ONLY_FROM_COUNTER).toMatch(/Home › Approvals/)
  })

  it('a partly shipped order: a cancel of what is left (a line shipped in full is not asked); the cut-offs and cut lines still hold', () => {
    const partly = order({ status: 'PARTLY_SHIPPED', lines: [line(L1, 10, { shippedInFull: true }), line(L2, 20)] })
    const rules = rulesOf(partly, NO_CUTOFFS, TODAY)
    expect(rules.cancel.possible).toBe(true)
    expect(rules.lines[0]!.cancel).toMatchObject({ code: 'NOT_ASKABLE', words: { en: 'Not possible: this line shipped in full' } })
    expect(rules.lines[1]!.cancel.possible).toBe(true)
    expect(rules.lines[1]!.change.code).toBe('NOT_ASKABLE')
    // Everything shipped: nothing is left to cancel.
    const done = order({ status: 'PARTLY_SHIPPED', lines: [line(L1, 10, { shippedInFull: true }), line(L2, 20, { closedShort: true })] })
    expect(rulesOf(done, NO_CUTOFFS, TODAY).cancel).toMatchObject({ code: 'NOT_ASKABLE', words: { en: 'Not possible: everything of the order has shipped' } })
    // A line still to ship but cut holds the whole cancel (the cut of a line shipped in full does not).
    const cut = { day: '2026-11-01', leather: false }
    expect(rulesOf(order({ status: 'PARTLY_SHIPPED', lines: [line(L1, 10, { shippedInFull: true, cut }), line(L2, 20)] }), NO_CUTOFFS, TODAY).cancel.possible).toBe(true)
    expect(rulesOf(order({ status: 'PARTLY_SHIPPED', lines: [line(L1, 10, { shippedInFull: true }), line(L2, 20, { cut })] }), NO_CUTOFFS, TODAY).cancel.code).toBe('CUT')
    // A status cut-off holds a partly shipped order (it is past READY).
    expect(rulesOf(partly, cutoffs({ cancelStatus: 'READY' }), TODAY).cancel.code).toBe('STATUS')
    // The cancel asked of the rest names no line (closed short at the answer), or the lines still to ship.
    expect(cancelProblems({ reasonCode: 'LEAD_TIME' }, { order: partly, cutoffs: NO_CUTOFFS, today: TODAY, reasons })).toEqual([])
    expect(cancelProblems({ reasonCode: 'LEAD_TIME', lineIds: [L1] }, { order: partly, cutoffs: NO_CUTOFFS, today: TODAY, reasons })[0]!.path).toBe('body/lineIds/0/NOT_ASKABLE')
  })

  it('Today: every kind in words, a batch in one row, a counter the customer agreed or that lapsed; each row goes to its kind’s people', () => {
    const base = { number: 'SO-1', customer: 'Brand Alpha', sizes: 0, lines: 0 }
    expect(customerRequestWords({ ...base, kind: 'HOLD', state: 'ASKED' }).sentence.text).toBe('Brand Alpha asks to pause order SO-1.')
    expect(customerRequestWords({ ...base, kind: 'RUSH', state: 'ASKED', needBy: '2026-12-01' }).sentence).toMatchObject({ key: 'ORDER_CHANGE_REQUEST.RUSH_BY', params: { needByDate: '2026-12-01' } })
    expect(customerRequestWords({ ...base, kind: 'SAMPLE_ROUND', state: 'ASKED' }).sentence.text).toBe('Brand Alpha asks for another sample round on order SO-1.')
    expect(customerRequestWords({ ...base, kind: 'CANCEL', state: 'ASKED', count: 6 }).sentence.text).toBe('Brand Alpha asks to cancel 6 orders.')
    expect(customerRequestWords({ ...base, kind: 'CANCEL', state: 'ASKED' }).sentence.text).toBe('Brand Alpha asks to cancel order SO-1.')
    expect(customerRequestWords({ ...base, kind: 'CHANGE', state: 'AGREED' }).sentence.text).toBe('Brand Alpha said yes to our counter-offer on order SO-1: accept the request to carry it out.')
    expect(customerRequestWords({ ...base, kind: 'CHANGE', state: 'LAPSED' }).sentence.key).toBe('ORDER_CHANGE_REQUEST.LAPSED')
    for (const kind of ORDER_REQUEST_KINDS) {
      expect(customerRequestWords({ ...base, kind, state: 'ASKED' }).sentence.key, kind).toMatch(/^ORDER_CHANGE_REQUEST\./)
      expect(customerRequestWords({ ...base, kind, state: 'ASKED', count: 2 }).sentence.key, kind).toBe(`ORDER_CHANGE_REQUEST.BATCH_${kind}`)
      // The row names the people who answer its kind (plan §3); the kind's rule lets each of them act.
      expect(KIND_RULES.ORDER_CHANGE_REQUEST.act, kind).toContain(ASK_RULES[kind].answeredWith)
    }
  })
})

// ---- B-PR-27a: a line in another colourway of its style (a change) -----------------------------------------------------------
describe('B-PR-27a: a change asks a line in another colourway', () => {
  const RED = '00000000-0000-4000-8000-0000000000aa'
  const NAVY = '00000000-0000-4000-8000-0000000000bb'
  // Line 10's style has RED (in 50, 52, 54) and NAVY (in 50 only) besides its own colourway; line 20's style none.
  const colourways = new Map([[L1, new Map([[RED, new Set(['50', '52', '54'])], [NAVY, new Set(['50'])]])]])
  const facts = (overrides: Partial<Parameters<typeof changeProblems>[1]> = {}) => changeFacts({ colourways, ...overrides })

  it('takes another colourway made in every size the line keeps; stores the line size by size with the colourway', () => {
    const ask = { cells: [{ lineId: L1, size: '54', quantity: 1 }], colourways: [{ lineId: L1, colourwayId: RED }] }
    expect(changeProblems(ask, facts())).toEqual([])
    expect(changeCellsOf(ask, order())).toEqual([
      { orderLineId: L1, size: '50', quantityBefore: 2, quantity: 2, colourwayId: RED },
      { orderLineId: L1, size: '52', quantityBefore: 3, quantity: 3, colourwayId: RED },
      { orderLineId: L1, size: '54', quantityBefore: 0, quantity: 1, colourwayId: RED },
    ])
    // A colour alone is a change (no cells, no date).
    expect(changeProblems({ cells: [], colourways: [{ lineId: L1, colourwayId: RED }] }, facts())).toEqual([])
  })

  it('refuses in words: not another colourway of the style, a size not made in it, a line twice, a held line, everything asked away', () => {
    expect(changeProblems({ cells: [], colourways: [{ lineId: L2, colourwayId: RED }] }, facts())[0]).toEqual({ path: 'body/colourways/0/colourwayId', message: "Not another colourway of line 20's style." })
    expect(changeProblems({ cells: [], colourways: [{ lineId: L1, colourwayId: NAVY }] }, facts())[0]).toEqual({ path: 'body/colourways/0/colourwayId', message: 'Line 10: size 52 is not made in this colourway.' })
    // Dropping size 52 makes NAVY possible.
    expect(changeProblems({ cells: [{ lineId: L1, size: '52', quantity: 0 }], colourways: [{ lineId: L1, colourwayId: NAVY }] }, facts())).toEqual([])
    expect(changeProblems({ cells: [], colourways: [{ lineId: L1, colourwayId: RED }, { lineId: L1, colourwayId: RED }] }, facts()).map((issue) => issue.path)).toEqual(['body/colourways/1/lineId'])
    const cut = facts({ order: order({ lines: [line(L1, 10, { cut: { day: '2026-10-12', leather: true } }), line(L2, 20)] }) })
    expect(changeProblems({ cells: [], colourways: [{ lineId: L1, colourwayId: RED }] }, cut)[0]!.path).toBe('body/colourways/0/LEATHER_CUT')
    expect(changeProblems({ cells: [{ lineId: L1, size: '50', quantity: 0 }, { lineId: L1, size: '52', quantity: 0 }], colourways: [{ lineId: L1, colourwayId: RED }] }, facts()).some((issue) => /asked away/.test(issue.message))).toBe(true)
    const tailored = facts({ order: order({ lines: [line(L1, 10, { kind: 'MADE_TO_MEASURE' }), line(L2, 20)] }) })
    expect(changeProblems({ cells: [], colourways: [{ lineId: L1, colourwayId: RED }] }, tailored)[0]!.message).toMatch(/made-to-measure/) // fix-pr-5: the house spelling (rules.ts MADE_TO_MEASURE)
    expect(changeProblems({ cells: [], colourways: [{ lineId: '00000000-0000-4000-8000-0000000000ff', colourwayId: RED }] }, facts())[0]!.path).toBe('body/colourways/0/lineId')
  })

  it('accepts as a new line in the colourway (the sizes asked) and the old one left as it is for its close; same pieces keep the total', () => {
    const cells = changeCellsOf({ cells: [{ lineId: L1, size: '50', quantity: 0 }], colourways: [{ lineId: L1, colourwayId: RED }] }, order())
    expect(colourLinesOf(cells)).toEqual([{ fromLineId: L1, colourwayId: RED, sizes: [{ size: '52', quantity: 3 }] }])
    // The old line's sizes are not the amendment's: it stays as it is until it is closed short.
    expect(amendmentLinesOf(cells, [line(L1, 10), line(L2, 20)])).toEqual({ lines: [{ id: L1 }, { id: L2 }], changed: true })
    expect(colourKeepsTotal(cells)).toBe(false)
    expect(colourKeepsTotal(changeCellsOf({ cells: [], colourways: [{ lineId: L1, colourwayId: RED }] }, order()))).toBe(true)
    // A size change of another line moves the total: W2a's own rule decides the re-acceptance.
    expect(colourKeepsTotal([...changeCellsOf({ cells: [], colourways: [{ lineId: L1, colourwayId: RED }] }, order()), { orderLineId: L2, size: '50', quantityBefore: 2, quantity: 3 }])).toBe(false)
    expect(sizesAfter(line(L1, 10), [{ lineId: L1, size: '50', quantity: 0 }, { lineId: L2, size: '52', quantity: 9 }])).toEqual([{ size: '50', before: 2, quantity: 0 }, { size: '52', before: 3, quantity: 3 }])
    expect(colourInWorkWords(10, ['WO-0001']).en).toBe('Line 10 is on a work order already (WO-0001): a colour change is then cancel-and-remake. Answer by hand: refuse with words, or cancel and remake the line.')
  })
})
