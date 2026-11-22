import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MONEY_PLAN_ACTS } from '@nexus/factory-domain/sales/orders/money-plan'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { canOf, deposit, order, SCHEDULE, SCHEDULE_OPEN, SENT_LINK, TODAY } from '../../_demo/fixtures'
import type { MoneyPlanAct } from '../../api'
import { beforeAfterOf, handBodyOf, handInputOf, handWindowOf, reasonProblemOf, shareOf, type HandInput } from './hand'
import { planOf } from './plan'
import { amountsOf } from './word'

/**
 * F-OM-201 (order MONEY tab, 10-design §9; 13-backend §3; 18-lead-settles L1) — the plan's hand windows: what each asks, the ONE body it
 * sends (the act, the target's version, the reason), the five parts it says, the before → after of its preview, and the money wall
 * (no amount in a window's words without the price grain). Every name and number is made up.
 */

const value = order('CONFIRMED')
const model = planOf({ order: value, schedule: SCHEDULE_OPEN, settlement: null, can: { ...canOf('owner'), moneyPlan: true }, stepCan: null, today: TODAY, stillToPay: null })
const deposit_ = model.rows[0]!
const balance = model.rows[1]!
const input = (over: Partial<HandInput> = {}): HandInput => ({ share: '', day: '2026-11-20', kind: 'BEFORE_SHIPPING', label: '', restTo: '', from: '', termsId: '', why: 'BANK_CHARGES', reason: 'The customer asked it by phone', ...over })
const ctx = (row = deposit_) => ({ step: row.step, request: row.request, order: value, today: TODAY, steps: SCHEDULE_OPEN.steps })

describe('F-OM-201: a share or an amount — never a total', () => {
  it('"25 %" is a share; "3.050,00" an amount; anything else nothing', () => {
    expect(shareOf('25 %')).toEqual({ pct: '25' })
    expect(shareOf('12,5%')).toEqual({ pct: '12.5' })
    expect(shareOf('3.050,00')).toEqual({ amount: 305000 })
    expect(shareOf('3050')).toEqual({ amount: 305000 })
    for (const wrong of ['', '0 %', '150 %', 'abc', '-5']) expect(shareOf(wrong), wrong).toBeNull()
  })

  it('a reason of 3 to 500 characters, kept in the history', () => {
    expect(reasonProblemOf('ok')).toEqual({ key: 'moneyTab.hand.problem.reasonShort' })
    expect(reasonProblemOf('x'.repeat(501))).toEqual({ key: 'moneyTab.hand.problem.reasonLong' })
    expect(reasonProblemOf('Agreed by phone')).toBeNull()
  })
})

describe('F-OM-201: the ONE body of each act (B-OM-011 … 016), with the target\'s version', () => {
  it('Change the deposit… replaces the request at its version with a share or an amount', () => {
    expect(handBodyOf('REPLACE_DEPOSIT', input({ share: '25 %' }), ctx()).body).toEqual({ act: 'REPLACE_DEPOSIT', requestId: deposit().id, version: 1, reason: 'The customer asked it by phone', pct: '25' })
    expect(handBodyOf('REPLACE_DEPOSIT', input(), ctx()).problem).toEqual({ key: 'moneyTab.hand.problem.share' })
  })

  it('Ask for the deposit again… sends the target\'s version too (S2)', () => {
    expect(handBodyOf('ASK_AGAIN', input(), ctx()).body).toEqual({ act: 'ASK_AGAIN', milestoneId: SCHEDULE.steps[0]!.id, version: SCHEDULE.steps[0]!.version, dueDate: '2026-11-20', reason: 'The customer asked it by phone' })
  })

  it('Move due day… names the step (its version), else the request; a day before today is refused here', () => {
    expect(handBodyOf('MOVE_DUE', input(), ctx()).body).toEqual({ act: 'MOVE_DUE', milestoneId: SCHEDULE.steps[0]!.id, version: SCHEDULE.steps[0]!.version, dueDate: '2026-11-20', reason: 'The customer asked it by phone' })
    expect(handBodyOf('MOVE_DUE', input({ day: '2026-10-01' }), ctx()).problem).toEqual({ key: 'moneyTab.hand.problem.past' })
    const typed = { step: null, request: deposit_.request, order: value, today: TODAY }
    expect(handBodyOf('MOVE_DUE', input(), typed).body).toMatchObject({ requestId: deposit().id, version: 1 })
  })

  it('Change amount… and Remove step… need where the rest goes; Rename… a name of at most 120; Undo opening the step only', () => {
    expect(handBodyOf('CHANGE_STEP', input({ share: '20 %' }), ctx(balance)).problem).toEqual({ key: 'moneyTab.hand.problem.restTo' })
    expect(handBodyOf('CHANGE_STEP', input({ share: '20 %', restTo: deposit_.step!.id }), ctx(balance)).body).toEqual({ act: 'CHANGE_STEP', milestoneId: balance.step!.id, version: balance.step!.version, restTo: deposit_.step!.id, reason: 'The customer asked it by phone', pct: '20' })
    expect(handBodyOf('REMOVE_STEP', input({ restTo: deposit_.step!.id }), ctx(balance)).body).toMatchObject({ act: 'REMOVE_STEP', restTo: deposit_.step!.id })
    expect(handBodyOf('RENAME_STEP', input({ label: '' }), ctx(balance)).problem).toEqual({ key: 'moneyTab.hand.problem.label' })
    expect(handBodyOf('RENAME_STEP', input({ label: 'x'.repeat(121) }), ctx(balance)).problem).toEqual({ key: 'moneyTab.hand.problem.labelLong' })
    expect(handBodyOf('RENAME_STEP', input({ label: ' Second instalment ' }), ctx(balance)).body).toMatchObject({ label: 'Second instalment' })
    expect(handBodyOf('UNDO_OPEN', input(), ctx(balance)).body).toEqual({ act: 'UNDO_OPEN', milestoneId: balance.step!.id, version: balance.step!.version, reason: 'The customer asked it by phone' })
  })

  it('Add a step… takes from an open step; Change payment terms… sends the order\'s version, never the same terms; Accept short… why', () => {
    expect(handBodyOf('ADD_STEP', input({ share: '20 %' }), ctx()).problem).toEqual({ key: 'moneyTab.hand.problem.from' })
    // S2: the version is the step it takes from.
    expect(handBodyOf('ADD_STEP', input({ share: '20 %', from: balance.step!.id, label: 'Second instalment' }), ctx()).body).toEqual({ act: 'ADD_STEP', kind: 'BEFORE_SHIPPING', from: balance.step!.id, version: balance.step!.version, dueDate: '2026-11-20', label: 'Second instalment', reason: 'The customer asked it by phone', pct: '20' })
    expect(handBodyOf('CHANGE_TERMS', input({ termsId: value.paymentTermsId! }), ctx()).problem).toEqual({ key: 'moneyTab.hand.problem.termsSame' })
    expect(handBodyOf('CHANGE_TERMS', input({ termsId: 'other-terms' }), ctx()).body).toEqual({ act: 'CHANGE_TERMS', paymentTermsId: 'other-terms', version: value.version, reason: 'The customer asked it by phone' })
    expect(handBodyOf('ACCEPT_SHORT', input({ why: 'ROUNDING' }), ctx()).body).toEqual({ act: 'ACCEPT_SHORT', requestId: deposit().id, version: 1, why: 'ROUNDING', reason: 'The customer asked it by phone' })
  })

  it('the reason holds the write, never the preview: the body is there with its reason problem said beside it', () => {
    const built = handBodyOf('MOVE_DUE', input({ reason: '' }), ctx())
    expect(built.body).not.toBeNull()
    expect(built.reasonProblem).toEqual({ key: 'moneyTab.hand.problem.reasonShort' })
  })
})

describe('F-OM-201: the window — its five parts, the money wall', () => {
  it('every act has a window with what happens, the customer, what never changes; the terms ask a fresh code', () => {
    for (const act of MONEY_PLAN_ACTS) {
      const window = handWindowOf(act, { order: value, row: act === 'ADD_STEP' || act === 'CHANGE_TERMS' ? null : deposit_, price: true })
      expect(window.happens.length, act).toBeGreaterThan(0)
      expect(window.told.key, act).toMatch(/^moneyTab\.hand\./)
      expect(window.never.key, act).toBe(`moneyTab.hand.${act}.never`)
    }
    expect(handWindowOf('CHANGE_TERMS', { order: value, row: null, price: true }).code).toBe(true)
    expect(handWindowOf('MOVE_DUE', { order: value, row: deposit_, price: true }).code).toBe(false)
  })

  it('L1 Accept short: "the missing part stays owed and goes on the final invoice"; its TD02 stays (the TD02 rule only)', () => {
    const short = planOf({ order: order('CONFIRMED', { chain: { ...value.chain, depositRequests: [deposit({ link: SENT_LINK, paidAmount: 226884 })] } }), schedule: SCHEDULE_OPEN, settlement: null, can: { ...canOf('owner'), moneyPlan: true }, stepCan: null, today: TODAY, stillToPay: null }).rows[0]!
    const window = handWindowOf('ACCEPT_SHORT', { order: value, row: short, price: true })
    expect(window.title).toEqual({ key: 'moneyTab.hand.ACCEPT_SHORT.title', money: { amount: 1500 } })
    expect(window.happens.map((entry) => entry.key)).toEqual(['moneyTab.hand.ACCEPT_SHORT.happens.paid', 'moneyTab.hand.ACCEPT_SHORT.happens.owed', 'moneyTab.hand.ACCEPT_SHORT.happens.td02'])
    // Without the price grain no amount in any word of the window.
    const words = handWindowOf('ACCEPT_SHORT', { order: value, row: short, price: false })
    expect([words.title, words.go, ...words.happens, words.told, words.never].flatMap(amountsOf)).toEqual([])
  })

  it('Move due day…: a live page shows the new day by itself; no page sent: the customer is not told', () => {
    const live = planOf({ order: order('CONFIRMED', { chain: { ...value.chain, depositRequests: [deposit({ link: SENT_LINK })] } }), schedule: SCHEDULE_OPEN, settlement: null, can: canOf('owner'), stepCan: null, today: TODAY, stillToPay: null }).rows[0]!
    expect(handWindowOf('MOVE_DUE', { order: value, row: live, price: true }).told).toEqual({ key: 'moneyTab.hand.MOVE_DUE.toldLive' })
    expect(handWindowOf('MOVE_DUE', { order: value, row: deposit_, price: true }).told).toEqual({ key: 'moneyTab.hand.MOVE_DUE.toldNone' })
  })

  it('what a window opens with: the row\'s own day (today or later), the first place the rest may go, the order\'s terms, bank charges', () => {
    expect(handInputOf('MOVE_DUE', { row: deposit_, order: value, openSteps: model.openSteps, today: TODAY })).toMatchObject({ day: '2026-11-04', restTo: balance.step!.id, termsId: value.paymentTermsId, why: 'BANK_CHARGES' })
    expect(handInputOf('MOVE_DUE', { row: deposit_, order: value, openSteps: model.openSteps, today: '2026-11-10' }).day).toBe('2026-11-10')
    expect(handInputOf('RENAME_STEP', { row: balance, order: value, openSteps: model.openSteps, today: TODAY }).label).toBe('Before shipping')
  })

  it('the preview\'s before → after (S2): a step that goes is CANCELLED after, one that comes has no before; a refusal has none', () => {
    const figures = (amount: number, status = 'OPEN') => ({ amount, dueDate: '2026-12-10', status, label: null })
    const answer = {
      act: 'CHANGE_STEP',
      refusal: null,
      preview: {
        steps: [
          { id: 'a', kind: 'DEPOSIT' as const, words: 'x', before: figures(228384), after: figures(190320) },
          { id: 'b', kind: 'BEFORE_SHIPPING' as const, words: 'x', before: figures(532896), after: figures(532896, 'CANCELLED') },
          { id: null, kind: 'ON_INVOICE' as const, words: 'x', before: null, after: figures(570960) },
        ],
        requests: [],
        remade: { cancelled: [], added: [] },
        short: null,
        needsFreshCode: false,
      },
    }
    expect(beforeAfterOf(answer)!.map((row) => [row.key, row.added, row.removed])).toEqual([['a', false, false], ['b', false, true], ['new-2', true, false]])
    expect(beforeAfterOf(null)).toBeNull()
    expect(beforeAfterOf({ ...answer, refusal: { code: 'MONEY_PLACED', words: { en: 'x', it: 'y' } }, preview: null })).toBeNull()
  })
})

// ---- F-OM-fx3 (W-11): the windows' small differences — the deposit as it is now, the tolerance on Accept short, the fresh code ----
describe('F-OM-fx3: what a window says first', () => {
  it('Change the deposit… says the deposit as it is now under its title (its amount with the price grain only)', () => {
    const sent = planOf({ order: order('CONFIRMED', { chain: { ...value.chain, depositRequests: [deposit({ link: SENT_LINK })] } }), schedule: SCHEDULE_OPEN, settlement: null, can: { ...canOf('owner'), moneyPlan: true }, stepCan: null, today: TODAY, stillToPay: null }).rows[0]!
    const window = handWindowOf('REPLACE_DEPOSIT', { order: value, row: sent, price: true })
    expect(window.sub).toEqual([sent.title, { key: 'moneyTab.hand.sub.amount', money: { amount: 228384 } }, { key: 'moneyTab.hand.sub.openNothing' }, { key: 'moneyTab.hand.sub.pageSent', instants: { date: SENT_LINK.sentAt } }])
    expect(handWindowOf('REPLACE_DEPOSIT', { order: value, row: sent, price: false }).sub.flatMap(amountsOf)).toEqual([])
    // Every other act on a row: its due words; the plan's head: nothing.
    expect(handWindowOf('MOVE_DUE', { order: value, row: balance, price: true }).sub).toEqual([balance.due])
    expect(handWindowOf('ADD_STEP', { order: value, row: null, price: true }).sub).toEqual([])
  })

  it('Accept short says the tolerance first: within it (no code), over it (only the Owner, a fresh code follows)', () => {
    const part = deposit({ link: SENT_LINK, paidAmount: 226884 })
    const rowOf = (withinTolerance: boolean) => planOf({ order: order('CONFIRMED', { chain: { ...value.chain, depositRequests: [part] } }), schedule: { ...SCHEDULE_OPEN, requests: [{ id: part.id, milestoneId: SCHEDULE.steps[0]!.id, kind: 'ACCONTO', stepKind: 'DEPOSIT', status: 'OPEN', dueDate: '2026-11-04', fiscalDocument: 'TD02', short: { amount: 1500, withinTolerance } }], tolerance: 2500 }, settlement: null, can: { ...canOf('owner'), moneyPlan: true }, stepCan: null, today: TODAY, stillToPay: null }).rows[0]!
    const within = handWindowOf('ACCEPT_SHORT', { order: value, row: rowOf(true), price: true, tolerance: 2500 })
    expect(within.happens[0]).toEqual({ key: 'moneyTab.hand.ACCEPT_SHORT.within', money: { amount: 1500, tolerance: 2500 } })
    expect(within.code).toBe(false)
    const over = handWindowOf('ACCEPT_SHORT', { order: value, row: rowOf(false), price: true, tolerance: 2500 })
    expect(over.happens[0]).toEqual({ key: 'moneyTab.hand.ACCEPT_SHORT.over', money: { amount: 1500, tolerance: 2500 } })
    expect(over.code).toBe(true)
    // Without the price grain no tolerance line (it is an amount).
    expect(handWindowOf('ACCEPT_SHORT', { order: value, row: rowOf(true), price: false, tolerance: 2500 }).happens.flatMap(amountsOf)).toEqual([])
  })
})

describe('F-OM-201: the windows on the page', () => {
  it('mounted once (MoneyDialogs), centred DS windows (Frame), never a drawer; each hand act opens its window from the row\'s ⋯', () => {
    const dialogs = readFileSync(new URL('./view/MoneyDialogs.tsx', import.meta.url), 'utf8')
    expect(dialogs).toContain("dialog?.kind === 'moneyPlan' ? <PlanDialog")
    expect(dialogs).toContain("dialog?.kind === 'undoPayment' ? <UndoPaymentDialog")
    expect(dialogs).toContain('<Frame')
    expect(dialogs).not.toMatch(/Drawer|SidePanel/)
    expect(readFileSync(new URL('./view/PlanRow.tsx', import.meta.url), 'utf8')).toContain("if (isHandAct(act.id)) return actions?.onDialog?.({ kind: 'moneyPlan', act: act.id, stepId: step?.id ?? null, requestId: request?.id ?? null })")
  })

  it('the words of every window, refusal and field exist in both languages', () => {
    const happens: Record<MoneyPlanAct, readonly string[]> = { REPLACE_DEPOSIT: ['replaced', 'asked', 'waits'], MOVE_DUE: ['together', 'overdue'], ASK_AGAIN: ['asked', 'waits'], ADD_STEP: ['taken', 'request'], CHANGE_STEP: ['rest', 'request'], REMOVE_STEP: ['earlier', 'rest'], RENAME_STEP: ['printed'], UNDO_OPEN: ['cancelled', 'shipment'], CHANGE_TERMS: ['remade', 'total'], ACCEPT_SHORT: ['paid', 'owed', 'td02'] }
    const keys = [
      ...MONEY_PLAN_ACTS.flatMap((act) => [`hand.${act}.go`, `hand.${act}.never`, ...happens[act].map((key) => `hand.${act}.happens.${key}`), ...(act === 'MOVE_DUE' ? ['hand.MOVE_DUE.toldLive', 'hand.MOVE_DUE.toldNone'] : [`hand.${act}.told`]), ...(act === 'ACCEPT_SHORT' ? ['hand.ACCEPT_SHORT.title', 'hand.ACCEPT_SHORT.titleWords'] : [`hand.${act}.title`])]),
      'hand.ASK_AGAIN.holds', 'hand.ACCEPT_SHORT.goWords', 'hand.REMOVE_STEP.happens.noDeposit',
      // The planner's own codes are said in the domain's words (MONEY_PLAN_REFUSAL_WORDS); these are this page's.
      ...['OTHER', 'MOVED', 'FORBIDDEN'].map((code) => `refusal.${code}`),
      ...['reasonShort', 'reasonLong', 'share', 'day', 'past', 'gone', 'from', 'restTo', 'label', 'labelLong', 'terms', 'termsSame'].map((key) => `hand.problem.${key}`),
      ...['share', 'shareHint', 'day', 'dayHint', 'dayOptional', 'kind', 'label', 'labelHint', 'restTo', 'from', 'pick', 'terms', 'termsHint', 'termsReading', 'termsFailed', 'shortWhy'].map((key) => `hand.field.${key}`),
      ...['BANK_CHARGES', 'ROUNDING', 'OTHER'].map((why) => `hand.why.${why}`),
      ...['whatHappens', 'customer', 'neverLabel', 'reason', 'whyHint', 'who', 'whoCode', 'thePlan', 'ba.title', 'ba.now', 'ba.after', 'ba.none', 'ba.new', 'ba.removed', 'ba.reading', 'ba.failed', 'ba.waits'].map((key) => `hand.${key}`),
      'stepUp.plan', 'stepUp.terms', 'notice.planChanged', 'notice.undone',
      'undo.title', 'undo.go', 'undo.happens.reversed', 'undo.happens.open', 'undo.happens.production', 'undo.told', 'undo.never',
      'lock.label', 'lock.hint', 'lock.problem', 'payment.undo', 'payment.open', 'payment.copyRef', 'payment.more', 'payments.more',
      'link.contact', 'link.contactHint', 'link.usual', 'link.option',
      // F-OM-fx3 (W-11, W-14): the deposit as it is now, the tolerance, the who line, the TD02 under a payment.
      'hand.sub.amount', 'hand.sub.openNothing', 'hand.sub.openPart', 'hand.sub.pageSent', 'hand.ACCEPT_SHORT.within', 'hand.ACCEPT_SHORT.over', 'hand.whoAs', 'hand.whoAsCode', 'payment.td02', 'payment.td02Words', 'payments.history',
    ]
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of keys) expect(t(`moneyTab.${key}`, { amount: 'A', number: 'N', row: 'R', date: 'D', who: 'W', name: 'X', email: 'E', tolerance: 'T', time: 'H' }), `${locale} ${key}`).not.toMatch(/moneyTab\.|\{/)
      // F-OM-fx3 (W-11): the English hint says an English number.
      if (locale === 'en') expect(t('moneyTab.hand.field.shareHint')).toContain('3,050.00')
    }
  })
})
