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

describe('the permission and its roles (B-W2b-183)', () => {
  it('is a partner write held by the customer Buyer and the customer Admin only', () => {
    expect(FACTORY_PERMISSIONS.get(PORTAL_SALES_ORDERS_ASK)).toMatchObject({ partner: true, risk: 'write' })
    expect(ORDER_CHANGE_ASKER_TEMPLATES).toEqual(['customer-buyer'])
    for (const key of ['customer-buyer', 'customer-admin']) expect(partnerTemplateOf(key)?.permissions).toContain(PORTAL_SALES_ORDERS_ASK)
    for (const key of ['customer-finance', 'customer-quality', 'customer-designer', 'customer-viewer', 'supplier-orders', 'supplier-admin', 'subcontractor-jobs', 'guest-accountant', 'partner-approve']) expect(partnerTemplateOf(key)?.permissions).not.toContain(PORTAL_SALES_ORDERS_ASK)
    for (const template of ROLE_TEMPLATES) expect(template.permissions).not.toContain(PORTAL_SALES_ORDERS_ASK)
  })

  it('declares its events (ids, kinds and states only) and the Approvals kind the office answers with orders.manage', () => {
    for (const type of ['order_change_request.asked', 'order_change_request.withdrawn', 'order_change_request.answered']) expect(EVENT_CATALOGUE.find(type, 1)?.live?.permission).toBe('orders.view')
    expect(() => EVENT_CATALOGUE.parse('order_change_request.asked', 1, { requestId: L1, orderId: L2, partyId: L1, kind: 'CHANGE', lines: 1, wholeOrder: false, note: 'x' })).toThrow()
    expect(KIND_RULES.ORDER_CHANGE_REQUEST).toMatchObject({ category: 'APPROVAL', view: 'orders.view', act: ['orders.manage'], decide: 'OPEN' })
    expect(orderChangeRequestWords({ number: 'SO-1', customer: 'Demo Racing', kind: 'CHANGE', sizes: 3, lines: 1 }).sentence.text).toBe('Demo Racing asks to change 3 sizes of order SO-1.')
    expect(orderChangeRequestWords({ number: 'SO-1', customer: 'Demo Racing', kind: 'CHANGE', sizes: 0, lines: 0 }).sentence.text).toBe('Demo Racing asks to change the delivery of order SO-1.')
    expect(orderChangeRequestWords({ number: 'SO-1', customer: 'Demo Racing', kind: 'CANCEL', sizes: 0, lines: 0 }).sentence.text).toBe('Demo Racing asks to cancel order SO-1.')
    expect(orderChangeRequestWords({ number: 'SO-1', customer: 'Demo Racing', kind: 'CANCEL', sizes: 0, lines: 1 }).sentence.text).toBe('Demo Racing asks to cancel 1 line of order SO-1.')
  })

  it('tells the customer of the answer in an order mail topic, without the office’s words', () => {
    for (const key of ['portal.order.change_accepted', 'portal.order.change_refused', 'portal.order.cancel_accepted', 'portal.order.cancel_refused'] as const) expect(PARTNER_MESSAGE_TEMPLATES[key].topic).toBe('ORDERS')
    expect(partnerSentence({ messageKey: 'portal.order.change_refused', recordLabel: 'SO-1', params: {} }, 'it', 'Demo')).toBe('La tua richiesta di modifica su SO-1 non è stata accettata')
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
    expect(rulesOf(order({ status: 'PARTLY_SHIPPED' }), NO_CUTOFFS, TODAY).cancel).toMatchObject({ code: 'NOT_ASKABLE', words: { en: 'Not possible: the order is already partly shipped' } })
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
    expect(changeProblems({ cells: [] }, changeFacts())[0]!.message).toBe('Say what should change: sizes, the date or the delivery address.')
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
