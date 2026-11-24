import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../../lib/i18n/messages'
import { canOf, deposit, DEPOSIT_ID, order, PAID, SCHEDULE, SCHEDULE_OPEN, SENT_LINK, TODAY } from '../../../_demo/fixtures'
import type { DepositRequest, Order, Schedule } from '../../../api'
import type { OrderAbilities } from '../../../model'
import type { StepAbilities } from '../../schedule/model'
import { DOOR_ACTS, doorCanOf, doorLabelOf, doorRulingOf, NEVER_FROM_A_ROW, rowActsOf, type DoorAsk, type DoorCan, type DoorRow } from './model'

/**
 * F-CM-k2 (customer MONEY tab, 13-backend §4.1, 15-steps K2.2–K2.4; 18-lead-settles Z5) — the money door: a To-collect row of the
 * customer's Money tab runs the ORDER's own acts in the ORDER's own windows. Which acts a row offers, per role (hidden without the
 * right); Open for payment, Ask again… and Undo this payment… never from a row; on the order AS READ the plan's own rule holds or opens
 * the act. Every name and number is made up.
 */

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

const OWNER: DoorCan = { recordPayment: true, price: true, moneyPlan: true, waive: true }
const FINANCE: DoorCan = { recordPayment: true, price: true, moneyPlan: true, waive: false }
const SALES: DoorCan = { recordPayment: false, price: false, moneyPlan: false, waive: false }
const READ_ONLY: DoorCan = { recordPayment: false, price: false, moneyPlan: false, waive: false }
const DEPOSIT_ROW: DoorRow = { stepKind: 'DEPOSIT', partPaid: null }
const BALANCE_ROW: DoorRow = { stepKind: 'BEFORE_SHIPPING', partPaid: null }

const OWNER_CAN: OrderAbilities = { ...canOf('owner'), moneyPlan: true, links: true }
const FINANCE_CAN: OrderAbilities = { ...canOf('finance'), moneyPlan: true, links: false }
const OWNER_STEPS: StepAbilities = { manageOrders: true, manageInvoices: true, waive: true }
const FINANCE_STEPS: StepAbilities = { manageOrders: false, manageInvoices: true, waive: false }
const withRequests = (value: Order, requests: DepositRequest[]): Order => ({ ...value, chain: { ...value.chain, depositRequests: requests } })
const ask = (act: DoorAsk['act'], requestId = DEPOSIT_ID): DoorAsk => ({ act, requestId })
const rule = (asked: DoorAsk, over: { order?: Order; schedule?: Schedule; can?: OrderAbilities; stepCan?: StepAbilities | null } = {}) =>
  doorRulingOf({ ask: asked, order: over.order ?? order('CONFIRMED'), schedule: over.schedule ?? SCHEDULE_OPEN, settlement: null, can: over.can ?? OWNER_CAN, stepCan: over.stepCan === undefined ? OWNER_STEPS : over.stepCan, today: TODAY })

describe('F-CM-k2: the acts a To-collect row offers — by its kind and the reader\'s rights (hidden without the right)', () => {
  it('the Owner: ONE act Record a payment; its ⋯ Send the page · Move due day… · Change the deposit… · Accept short… · Waive…', () => {
    expect(rowActsOf(DEPOSIT_ROW, OWNER)).toEqual({ act: 'record', more: ['send', 'MOVE_DUE', 'REPLACE_DEPOSIT', 'ACCEPT_SHORT', 'waive'] })
  })

  it('Finance: the same without Waive… (the Owner\'s); a balance before shipping: no Change the deposit…', () => {
    expect(rowActsOf(DEPOSIT_ROW, FINANCE)).toEqual({ act: 'record', more: ['send', 'MOVE_DUE', 'REPLACE_DEPOSIT', 'ACCEPT_SHORT'] })
    expect(rowActsOf(BALANCE_ROW, OWNER)).toEqual({ act: 'record', more: ['send', 'MOVE_DUE', 'ACCEPT_SHORT', 'waive'] })
  })

  it('Accept short… only on a row that may be short: part paid, or a row that cannot say; never on one known to hold no money', () => {
    expect(rowActsOf({ stepKind: 'DEPOSIT', partPaid: true }, OWNER).more).toContain('ACCEPT_SHORT')
    expect(rowActsOf({ stepKind: 'DEPOSIT', partPaid: false }, OWNER).more).not.toContain('ACCEPT_SHORT')
  })

  it('Sales and Read-only: no act and nothing in the ⋯ from the door (the host keeps its doors, Show in the thread, Copy link)', () => {
    for (const can of [SALES, READ_ONLY]) for (const row of [DEPOSIT_ROW, BALANCE_ROW]) expect(rowActsOf(row, can)).toEqual({ act: null, more: [] })
    // A payment right without the price grain: no Record a payment (it says an amount); the page may still be sent.
    expect(rowActsOf(DEPOSIT_ROW, { recordPayment: true, price: false, moneyPlan: false, waive: false })).toEqual({ act: null, more: ['send'] })
  })

  it('the rights are the order page\'s own (abilitiesOf, orders.waive)', () => {
    expect(doorCanOf(['payments.record', 'money.price', 'orders.moneyPlan', 'orders.waive'])).toEqual(OWNER)
    expect(doorCanOf(['payments.record', 'money.price', 'orders.moneyPlan'])).toEqual(FINANCE)
    expect(doorCanOf([])).toEqual(READ_ONLY)
  })

  it('NEVER from a row: Open for payment, Ask again…, Undo this payment… (nor Stop the page) — for any reader, any row', () => {
    for (const never of NEVER_FROM_A_ROW) expect(DOOR_ACTS as readonly string[], never).not.toContain(never)
    expect(NEVER_FROM_A_ROW).toEqual(expect.arrayContaining(['open', 'ASK_AGAIN', 'undoPayment']))
    for (const can of [OWNER, FINANCE, SALES, READ_ONLY])
      for (const stepKind of ['DEPOSIT', 'BEFORE_SHIPPING', null] as const)
        for (const partPaid of [true, false, null]) {
          const acts = rowActsOf({ stepKind, partPaid }, can)
          for (const id of [acts.act, ...acts.more]) expect(NEVER_FROM_A_ROW as readonly (string | null)[], `${String(id)}`).not.toContain(id)
        }
  })

  it('each act says the order page\'s own words (the row\'s button, its ⋯ line, the window\'s title while it reads)', () => {
    expect(DOOR_ACTS.map(doorLabelOf)).toEqual([{ key: 'deposit.record' }, { key: 'moneyTab.plan.act.send' }, { key: 'moneyTab.plan.act.MOVE_DUE' }, { key: 'moneyTab.plan.act.REPLACE_DEPOSIT' }, { key: 'moneyTab.plan.act.ACCEPT_SHORT' }, { key: 'moneyTab.plan.act.waive' }])
  })
})

describe('F-CM-k2: on the order AS READ — the plan\'s own rule holds the act, or opens the order\'s own window', () => {
  it('an open deposit: Record a payment and Send the page open the order page\'s windows on that request', () => {
    expect(rule(ask('record'))).toEqual({ held: null, start: { kind: 'dialog', dialog: { kind: 'depositPayment', requestId: DEPOSIT_ID } } })
    expect(rule(ask('send'))).toEqual({ held: null, start: { kind: 'dialog', dialog: { kind: 'depositLink', requestId: DEPOSIT_ID } } })
  })

  it('Move due day… and Change the deposit… open the plan\'s hand window on the request\'s row (its step and its request)', () => {
    for (const act of ['MOVE_DUE', 'REPLACE_DEPOSIT'] as const) {
      expect(rule(ask(act)), act).toEqual({ held: null, start: { kind: 'dialog', dialog: { kind: 'moneyPlan', act, stepId: SCHEDULE.steps[0]!.id, requestId: DEPOSIT_ID } } })
    }
  })

  it('Waive… (the Owner) opens the order\'s own Waive window on the step, with the row\'s words', () => {
    const ruled = rule(ask('waive'))
    expect(ruled.held).toBeNull()
    expect(ruled.start).toMatchObject({ kind: 'waive', target: { kind: 'step', id: SCHEDULE.steps[0]!.id, version: 2 }, stepKind: 'DEPOSIT', title: { key: 'moneyTab.plan.title' } })
  })

  it('held by the order\'s state, in the plan\'s own words: money placed on it holds Change the deposit… and Waive…', () => {
    const placed = withRequests(order('CONFIRMED'), [deposit({ link: SENT_LINK, paidAmount: 100000 })])
    expect(rule(ask('REPLACE_DEPOSIT'), { order: placed })).toEqual({ held: { key: 'moneyTab.plan.held.moneyPlaced' }, start: null })
    expect(rule(ask('waive'), { order: placed })).toEqual({ held: { key: 'schedule.verbs.held.partPaid' }, start: null })
  })

  it('the row is older than the order: paid meanwhile, or the act no longer offered — "The plan changed meanwhile", never the window', () => {
    expect(rule(ask('record'), { order: withRequests(order('CONFIRMED'), [PAID]), schedule: SCHEDULE })).toEqual({ held: { key: 'moneyTab.refusal.MOVED' }, start: null })
    expect(rule(ask('record', 'no-such-request'))).toEqual({ held: { key: 'moneyTab.refusal.MOVED' }, start: null })
    // A right the order as read does not grant this reader (Finance: no waive) is never opened.
    expect(rule(ask('waive'), { can: FINANCE_CAN, stepCan: FINANCE_STEPS })).toEqual({ held: { key: 'moneyTab.refusal.MOVED' }, start: null })
  })

  it('a closed or cancelled order: held, in the order page\'s words', () => {
    for (const status of ['CLOSED', 'CANCELLED'] as const) expect(rule(ask('record'), { order: order(status), schedule: SCHEDULE }), status).toEqual({ held: { key: 'impact.STATE_final' }, start: null })
  })

  it('Accept short (bank charges)…: within the company\'s tolerance it opens the hand window; without the plan right it is not opened', () => {
    const part = deposit({ link: SENT_LINK, paidAmount: 226884 })
    const value = withRequests(order('CONFIRMED'), [part])
    const planned: Schedule = { ...SCHEDULE_OPEN, requests: [{ id: part.id, milestoneId: SCHEDULE.steps[0]!.id, kind: 'ACCONTO', stepKind: 'DEPOSIT', status: 'OPEN', dueDate: '2026-11-04', fiscalDocument: 'TD02', short: { amount: 1500, withinTolerance: true } }], tolerance: 2500 }
    expect(rule(ask('ACCEPT_SHORT'), { order: value, schedule: planned })).toEqual({ held: null, start: { kind: 'dialog', dialog: { kind: 'moneyPlan', act: 'ACCEPT_SHORT', stepId: SCHEDULE.steps[0]!.id, requestId: DEPOSIT_ID } } })
    expect(rule(ask('ACCEPT_SHORT'), { order: value, schedule: planned, can: { ...FINANCE_CAN, moneyPlan: false }, stepCan: FINANCE_STEPS })).toEqual({ held: { key: 'moneyTab.refusal.MOVED' }, start: null })
  })
})

describe('F-CM-k2: the words', () => {
  it('exist in both languages: the acts, the held words, the window\'s reading and failed lines', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of [...DOOR_ACTS.map((id) => doorLabelOf(id).key), 'moneyTab.refusal.MOVED', 'impact.STATE_final', 'moneyTab.plan.held.moneyPlaced', 'schedule.verbs.held.partPaid', 'common.cancel', 'common.retry', 'stepUp.title', 'stepUp.confirm']) {
        expect(t(key), `${locale} ${key}`).not.toBe(key)
      }
      const s = createTranslator(locale, messagesFor(locale, ['orders-sheet'])['orders-sheet']!)
      expect(s('commands.reading', { number: 'SEED-SO-0002' }), locale).toContain('SEED-SO-0002')
      expect(s('commands.readFailed', { number: 'SEED-SO-0002', problem: 'P' }), locale).toContain('SEED-SO-0002')
    }
  })
})

describe('F-CM-k2: the order side is changed by TYPE only (K2.1, the F-CP-108 way)', () => {
  it('the money windows take a Pick of the record\'s model; Send the page… and Record a payment… are exported for the door', () => {
    const dialogs = source('../../view/Dialogs.tsx')
    for (const name of ['export type MoneyDialogModel = Pick<OrderRecordModel,', 'export type MoneyDialogActions = Pick<OrderRecordActions,', 'export /* F-CM-k2 */ function LinkDialog(', 'export /* F-CM-k2 */ function PaymentDialog(']) expect(dialogs, name).toContain(name)
    const money = source('../view/MoneyDialogs.tsx')
    expect(money).toContain('export function MoneyDialogs({ order, model, actions }: { order: Order; model: MoneyDialogModel; actions?: MoneyDialogActions })')
    expect(money).not.toContain('OrderRecordModel')
  })
})
