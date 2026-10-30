import { describe, expect, it } from 'vitest'
import { cancelBlocksOf, cancelImpact, closeShortPlan, dailyActions, reopenPlan, type CancelFacts, type ShortLine } from './daily'
import { paymentScheduleOf, remadeSchedule, type StoredMilestone } from './schedule'
import type { Instalment } from '../terms/terms'

const line = (id: string, seq: number, quantity: number, shipped: number, closedShort = false): ShortLine => ({ id, seq, quantity, shipped, closedShort })

describe('close remaining lines (SAL-210)', () => {
  const lines = [line('L1', 10, 50, 48), line('L2', 20, 6, 6), line('L3', 30, 4, 0)]

  it('closes what is left of each line named, or of every open line; done once every line shipped or closed', () => {
    expect(closeShortPlan('PARTLY_SHIPPED', lines, ['L1'])).toEqual({ close: [{ id: 'L1', seq: 10, closedShortQuantity: 2 }], done: false })
    expect(closeShortPlan('PARTLY_SHIPPED', lines, [])).toEqual({
      close: [
        { id: 'L1', seq: 10, closedShortQuantity: 2 },
        { id: 'L3', seq: 30, closedShortQuantity: 4 },
      ],
      done: true,
    })
  })

  it('refuses a line shipped in full, closed already, named twice or not of the order, and another state', () => {
    const problems = closeShortPlan('PARTLY_SHIPPED', [...lines, line('L4', 40, 3, 1, true)], ['L2', 'L4', 'L9', 'L1', 'L1'])
    expect(Array.isArray(problems) && problems.map((issue) => [issue.path, issue.message])).toEqual([
      ['body/lineIds/0', 'Line 20 shipped in full: nothing is left to close.'],
      ['body/lineIds/1', 'Line 40 is closed short already.'],
      ['body/lineIds/2', 'Not a line of this order.'],
      ['body/lineIds/4', 'This line is named twice.'],
    ])
    expect(closeShortPlan('SHIPPED', lines, [])).toEqual([{ path: 'body', message: 'The order is SHIPPED: its lines are no longer closed short.' }])
  })

  it('an order that shipped nothing is cancelled, not closed line by line to nothing', () => {
    const none = [line('A', 10, 5, 0), line('B', 20, 3, 0)]
    expect(closeShortPlan('IN_PRODUCTION', none, ['A'])).toEqual({ close: [{ id: 'A', seq: 10, closedShortQuantity: 5 }], done: false })
    expect(closeShortPlan('IN_PRODUCTION', none, [])).toEqual([{ path: 'body/lineIds', message: 'Nothing has shipped: closing every line would leave an empty order. Cancel the order instead.' }])
  })

  it('reopens closed lines while the order is not closed', () => {
    const closed = [line('L1', 10, 50, 48, true), line('L2', 20, 6, 6)]
    expect(reopenPlan('SHIPPED', closed, [])).toEqual({ reopen: ['L1'] })
    expect(reopenPlan('PARTLY_SHIPPED', closed, ['L2'])).toEqual([{ path: 'body/lineIds/0', message: 'Line 20 is not closed short.' }])
    expect(reopenPlan('CLOSED', closed, [])).toEqual([{ path: 'body', message: 'The order is CLOSED: its closed lines stay closed.' }])
  })

  it('the daily actions say why they are held', () => {
    expect(dailyActions('CONFIRMED', [line('A', 10, 5, 0)])).toEqual([
      { action: 'amend', allowed: true, held: null },
      { action: 'closeLines', allowed: false, held: 'Nothing has shipped and this is the only open line: cancel the order instead.' },
      { action: 'reopenLines', allowed: false, held: 'No line is closed short.' },
      { action: 'copyAsQuote', allowed: true, held: null },
    ])
    const partly = dailyActions('PARTLY_SHIPPED', [line('L1', 10, 50, 48, true), line('L2', 20, 6, 3)])
    expect(partly.map((action) => [action.action, action.allowed])).toEqual([['amend', false], ['closeLines', true], ['reopenLines', true], ['copyAsQuote', true]])
    expect(partly[0]!.held).toMatch(/PARTLY_SHIPPED: its lines no longer change/)
  })
})

describe('the cancel impact check (SAL-211)', () => {
  const base: CancelFacts = { status: 'IN_PRODUCTION', workOrders: [], shipments: [], invoices: [], deposits: [], milestones: [], reservations: [], purchaseOrders: [] }

  it('names what it changes and what it leaves behind, without amounts in the words', () => {
    const impact = cancelImpact({
      ...base,
      workOrders: [{ id: 'w1', number: 'WO-1', status: 'IN_PROGRESS', cutHides: 2, cutArea: '9.5' }, { id: 'w2', number: 'WO-2', status: 'CANCELLED', cutHides: 0, cutArea: null }],
      deposits: [{ id: 'd1', status: 'PAID', amount: 228_384 }],
      invoices: [{ id: 'i1', number: 'FT-1', docType: 'TD02', status: 'DELIVERED' }],
      milestones: [{ id: 'm1', kind: 'DEPOSIT', status: 'PAID', amount: 228_384 }, { id: 'm2', kind: 'BEFORE_SHIPPING', status: 'OPEN', amount: 532_896 }],
      reservations: [{ id: 'r1' }],
      purchaseOrders: [{ id: 'p1', number: 'PO-7' }],
    })
    expect(impact.cancellable).toBe(true)
    expect(impact.touches.map((item) => [item.code, item.amount])).toEqual([['PAYMENT_STEPS_CANCELLED', 532_896]])
    expect(impact.leavesBehind.map((item) => item.code)).toEqual(['WORK_ORDERS_OPEN', 'LEATHER_CUT', 'STOCK_RESERVED', 'PURCHASE_ORDERS', 'DEPOSIT_PAID'])
    expect(impact.leavesBehind.find((item) => item.code === 'DEPOSIT_PAID')).toMatchObject({ amount: 228_384, message: expect.stringContaining('invoiced (FT-1)') })
    for (const item of [...impact.touches, ...impact.leavesBehind]) expect(item.message).not.toMatch(/\d{3,}/)
  })

  it('stops at drafts, packed shipments, invoices and a state that shipped', () => {
    const impact = cancelImpact({
      ...base,
      status: 'PARTLY_SHIPPED',
      workOrders: [{ id: 'w1', number: 'WO-1', status: 'DRAFT', cutHides: 0, cutArea: null }],
      shipments: [{ id: 's1', number: 'SH-1', status: 'PACKED' }, { id: 's2', number: 'SH-2', status: 'SHIPPED' }],
      invoices: [{ id: 'i1', number: null, docType: 'TD24', status: 'DRAFT' }, { id: 'i2', number: 'FT-9', docType: 'TD01', status: 'ISSUED' }],
    })
    expect(impact.cancellable).toBe(false)
    expect(impact.blocks.map((item) => item.code)).toEqual(['STATE', 'DRAFT_WORK_ORDERS', 'SHIPMENT_IN_PREPARATION', 'INVOICE_DRAFT', 'INVOICE_ISSUED'])
    expect(cancelBlocksOf(impact)).toHaveLength(3)
    expect(cancelImpact({ ...base, status: 'READY', shipments: [{ id: 's2', number: 'SH-2', status: 'SHIPPED' }] }).blocks.map((item) => item.code)).toEqual(['SHIPPED'])
  })
})

describe('the payment schedule (SAL-216)', () => {
  const DEP30: Instalment[] = [
    { sharePct: '30.0000', from: 'ORDER', days: 0, endOfMonth: false },
    { sharePct: '70.0000', from: 'BEFORE_SHIPPING', days: 5, endOfMonth: false },
  ]
  const BB30FM: Instalment[] = [{ sharePct: '100.0000', from: 'INVOICE', days: 30, endOfMonth: true }]

  it('the deposit step, then the rest over the later instalments', () => {
    expect(paymentScheduleOf({ gross: 761_280, instalments: DEP30, deposit: { requestId: 'd1', amount: 228_384, dueDate: '2026-11-01', sharePct: '30' }, promiseDate: '2026-12-20' })).toEqual([
      { seq: 10, kind: 'DEPOSIT', sharePct: '30', amount: 228_384, dueDate: '2026-11-01', depositRequestId: 'd1' },
      { seq: 20, kind: 'BEFORE_SHIPPING', sharePct: '70.0000', amount: 532_896, dueDate: '2026-12-15', depositRequestId: null },
    ])
    // A deposit of the customer's own (20 %) under DEP30: the rest is the balance.
    expect(paymentScheduleOf({ gross: 100_000, instalments: DEP30, deposit: { requestId: 'd1', amount: 20_000, dueDate: '2026-11-01', sharePct: '20' }, promiseDate: null }).map((step) => [step.kind, step.amount, step.dueDate])).toEqual([
      ['DEPOSIT', 20_000, '2026-11-01'],
      ['BEFORE_SHIPPING', 80_000, null],
    ])
  })

  it('nothing before the invoice: no schedule; a deposit without terms leaves the balance on the invoice', () => {
    expect(paymentScheduleOf({ gross: 100_000, instalments: BB30FM, deposit: null, promiseDate: null })).toEqual([])
    expect(paymentScheduleOf({ gross: 100_000, instalments: null, deposit: null, promiseDate: null })).toEqual([])
    expect(paymentScheduleOf({ gross: 100_000, instalments: null, deposit: { requestId: 'd', amount: 30_000, dueDate: '2026-11-01', sharePct: '30' }, promiseDate: null }).map((step) => [step.seq, step.kind, step.amount, step.sharePct])).toEqual([
      [10, 'DEPOSIT', 30_000, '30'],
      [20, 'ON_INVOICE', 70_000, '70.0000'],
    ])
  })

  it('an amendment remakes the open steps for the new gross; the deposit and paid steps stay', () => {
    const existing: StoredMilestone[] = [
      { id: 'm1', seq: 10, kind: 'DEPOSIT', status: 'PAID', amount: 30_000, dueDate: '2026-11-01', depositRequestId: 'd' },
      { id: 'm2', seq: 20, kind: 'BEFORE_SHIPPING', status: 'OPEN', amount: 70_000, dueDate: null, depositRequestId: null },
    ]
    expect(remadeSchedule(existing, { gross: 120_000, instalments: DEP30, promiseDate: null })).toEqual({
      cancel: ['m2'],
      insert: [{ seq: 30, kind: 'BEFORE_SHIPPING', sharePct: '75.0000', amount: 90_000, dueDate: null, depositRequestId: null }],
      overpaid: 0,
    })
    expect(remadeSchedule(existing, { gross: 100_000, instalments: DEP30, promiseDate: null })).toEqual({ cancel: [], insert: [], overpaid: 0 })
    expect(remadeSchedule(existing, { gross: 25_000, instalments: DEP30, promiseDate: null })).toEqual({ cancel: ['m2'], insert: [], overpaid: 5_000 })
    expect(remadeSchedule([], { gross: 25_000, instalments: DEP30, promiseDate: null })).toEqual({ cancel: [], insert: [], overpaid: 0 })
  })
})
