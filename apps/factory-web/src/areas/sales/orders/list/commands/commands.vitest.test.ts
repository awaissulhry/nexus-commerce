import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CANCEL_STATUSES, orderActions } from '@nexus/factory-domain/sales/orders/orders'
import { ApiError } from '../../../../../lib/api/errors'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { ORDER_STATUSES, type OpenApproval, type Order, type OrderRow, type OrderStatus } from '../../api'
import { canOf, deposit, order, ROLES, type Role } from '../../_demo/fixtures'
import { actionOf, cancelHeld, closeHeld, depositGate, nextStep, readProblem, readyHeld, writeProblem } from '../../model'
import { confirmHeldOf, doneWords, orderYesDoor, ROW_COMMANDS, rowStepsOf, statesText, stillInView, windowGoOf, windowHeldOf, windowTitleOf, wordsText, type RowCommand, type Words } from './model'

/**
 * F-CP-108 (customer page plan C2b, D8, K2; 10-customer-page §3.1; picture 20): the row ⋯ "Next steps" of the Orders sheet runs the order
 * page's OWN commands — A14's state → action map (the PARITY test: A14's nextStep / *Held on a full order of each status give the row's
 * menu), never a system move and no free status, held in words from the row's facts, the order page's own dialogs mounted (never a
 * copy), every write with the order's version and an Idempotency-Key, refusals in the order page's words (409 stale, the state moved
 * on, a right missing, 404 neutral). Brand wall: each command re-checks the order's customer on the server (unknown = 404, neutral);
 * money wall: no amount in any held word.
 */

const ROLE_NAMES = Object.keys(ROLES) as Role[]
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const words = (locale: (typeof LOCALES)[number]) => {
  const all = messagesFor(locale, ['orders', 'orders-sheet'])
  const t = createTranslator(locale, all.orders!)
  const s = createTranslator(locale, all['orders-sheet']!)
  return { t, s, say: (value: Words) => wordsText(value, t, s, locale) }
}

/** A full order of a state, its actions as the API's own map gives them (factory-domain orderActions; settled unless asked). */
function full(status: OrderStatus, over: Partial<Order> & { settled?: boolean } = {}): Order {
  const value = order(status, over)
  const settled = over.settled ?? true
  const actions = orderActions(status, { settlement: { settled, missing: settled ? [] : [{ code: 'BALANCE_DUE', message: 'The invoices are not paid in full.' }], source: 'invoicing' } }).map((entry) => ({ action: entry.action, allowed: entry.allowed, needsReason: entry.needsReason, held: entry.held }))
  return { ...value, actions, settlement: { ...value.settlement, settled } }
}

/** The list row of that order: its status and its deposit as the gate reads it (the row's own facts). */
function rowOf(value: Order): Pick<OrderRow, 'status' | 'deposit'> {
  const gate = depositGate(value)
  const state = gate.state === 'WAITING' ? 'OPEN' : gate.state
  return { status: value.status, deposit: { state, dueDate: state === 'OPEN' ? (gate.request?.dueDate ?? null) : null } }
}

const heldOf = (steps: ReturnType<typeof rowStepsOf>, command: RowCommand) => steps.find((step) => step.command === command)?.held ?? null
const has = (steps: ReturnType<typeof rowStepsOf>, command: RowCommand) => steps.some((step) => step.command === command)

const task = (over: Partial<OpenApproval> = {}): OpenApproval => ({
  taskId: 'a0a0a0a0-0000-4000-8000-000000000001',
  kind: 'SALES_ORDER',
  kindLabel: { en: 'Sales order', it: 'Ordine di vendita' },
  requestedAt: '2026-11-18T09:30:00Z',
  requester: { name: 'Luca Prova', me: false },
  approver: { kind: 'ROLE', name: 'Finance', me: false },
  version: 1,
  requireStepUp: true,
  approve: { allowed: true, why: null },
  reject: { allowed: true, why: null },
  withdraw: { allowed: false, why: 'Only the person who asked for this request takes it back.' },
  ...over,
})
const OTHERS = 'This request waits for another approver: it is not addressed to you or to a role you hold over its company.'
const OWN = 'You asked for this request: another person decides.'
const YES = {
  decide: task(),
  selfAsked: task({ requester: { name: 'Giulia Esempio', me: true }, approve: { allowed: false, why: OWN }, reject: { allowed: false, why: OWN }, withdraw: { allowed: true, why: null } }),
  whoDecides: task({ approve: { allowed: false, why: OTHERS }, reject: { allowed: false, why: OTHERS } }),
}

describe('F-CP-108 — the PARITY test: A14\'s map on a full order of each status = the row\'s Next steps', () => {
  for (const role of ROLE_NAMES) {
    for (const status of ORDER_STATUSES) {
      it(`${role} · ${status}`, () => {
        const can = canOf(role)
        const value = full(status)
        const steps = rowStepsOf(rowOf(value), can)
        const step = nextStep(value, can)
        // Waiting for a yes: Confirm or refuse… (its door is the window's: who decides, the asker's hold).
        expect(has(steps, 'confirm')).toBe(step.kind === 'confirmYes' || step.kind === 'askYes')
        // Confirmed: Make work orders, held exactly as the band's primary.
        expect(has(steps, 'make')).toBe(step.kind === 'makeWorkOrders')
        if (step.kind === 'makeWorkOrders') expect(heldOf(steps, 'make')).toEqual(step.held)
        // Shipped or delivered: Close order…, held as closeHeld (settled; "not settled" is the window's, from the read).
        expect(has(steps, 'close')).toBe(step.kind === 'close')
        if (step.kind === 'close') expect(heldOf(steps, 'close')).toEqual(closeHeld(value, can))
        // In production: Mark ready…, held as readyHeld (the API's markReady action is there).
        expect(has(steps, 'ready')).toBe(!!actionOf(value, 'markReady'))
        if (has(steps, 'ready')) expect(heldOf(steps, 'ready')).toEqual(readyHeld(value, can))
        // Cancel order…: where the API offers the cancel; held as cancelHeld.
        expect(has(steps, 'cancel')).toBe(!!actionOf(value, 'cancel') && CANCEL_STATUSES.includes(status))
        if (has(steps, 'cancel')) expect(heldOf(steps, 'cancel')).toEqual(cancelHeld(value, can))
      })
    }
  }

  it('the deposit gate: the row\'s deposit holds Make work orders as the band does (waiting, missing, paid, waived, not needed)', () => {
    const can = canOf('owner')
    const cases: Array<[string, Order]> = [
      ['waiting', full('CONFIRMED', { chain: { ...order('CONFIRMED').chain, depositRequests: [deposit({ dueDate: '2026-11-09' })] } })],
      ['missing', full('CONFIRMED', { chain: { ...order('CONFIRMED').chain, depositRequests: [] } })],
      ['paid', full('CONFIRMED', { chain: { ...order('CONFIRMED').chain, depositRequests: [deposit({ status: 'PAID' })] } })],
      ['waived', full('CONFIRMED', { chain: { ...order('CONFIRMED').chain, depositRequests: [deposit({ status: 'WAIVED' })] } })],
      ['not needed', full('CONFIRMED', { depositRequired: false })],
    ]
    for (const [name, value] of cases) expect(heldOf(rowStepsOf(rowOf(value), can), 'make'), name).toEqual(nextStep(value, can).held)
    expect(heldOf(rowStepsOf(rowOf(cases[0]![1]), can), 'make')).toEqual({ key: 'held.deposit', params: { date: '2026-11-09' } })
  })

  it('the yes: the window\'s door is nextStep\'s (an approver who did not ask decides; the asker is held; anyone else is told who decides)', () => {
    const can = canOf('owner')
    for (const [name, yes] of Object.entries(YES)) {
      const value = full('PENDING_APPROVAL', { openApprovals: [yes] })
      const step = nextStep(value, can)
      const door = orderYesDoor(value)
      expect(door?.kind, name).toBe(name)
      expect(step.kind === 'confirmYes', name).toBe(door?.kind === 'decide')
      if (step.kind === 'confirmYes') expect(step.taskId).toBe(door?.task.taskId)
      expect(rowStepsOf(rowOf(value), can).map((entry) => entry.command), name).toEqual(['confirm'])
    }
    expect(confirmHeldOf(full('PENDING_APPROVAL', { openApprovals: [YES.decide] }))).toBeNull()
    expect(confirmHeldOf(full('PENDING_APPROVAL', { openApprovals: [YES.selfAsked] }))).toEqual({ key: 'approval.selfAsked' })
    expect(confirmHeldOf(full('PENDING_APPROVAL', { openApprovals: [YES.whoDecides] }))).toEqual({ key: 'approval.whoDecides', params: { who: 'Finance' } })
    // Nobody asked yet (asking is the order page's): said so, never a dead Confirm.
    expect(confirmHeldOf(full('PENDING_APPROVAL', { openApprovals: [] }))).toEqual({ key: 'commands.noYes', sheet: true })
    expect(confirmHeldOf(full('CONFIRMED'))).toEqual({ key: 'commands.confirmState', sheet: true })
  })
})

describe('F-CP-108 — never a system move, no free status', () => {
  it('the commands are the order page\'s five; Partly shipped, Closed and Cancelled offer none; no command names a state', () => {
    for (const role of ROLE_NAMES) {
      for (const status of ORDER_STATUSES) {
        const steps = rowStepsOf({ status, deposit: { state: 'PAID', dueDate: null } }, canOf(role))
        for (const step of steps) expect(ROW_COMMANDS).toContain(step.command)
        for (const step of steps) expect(ORDER_STATUSES as readonly string[]).not.toContain(step.command)
        if (['PARTLY_SHIPPED', 'CLOSED', 'CANCELLED'].includes(status)) expect(steps, `${role} ${status}`).toEqual([])
      }
    }
    // Cancel order… is last (the menu draws it after a rule, in the danger tone).
    const steps = rowStepsOf({ status: 'IN_PRODUCTION', deposit: { state: 'PAID', dueDate: null } }, canOf('owner'))
    expect(steps.map((step) => step.command)).toEqual(['ready', 'cancel'])
  })

  it('the menu offers no status editor: the pill stays a filter and the items are the commands (source)', () => {
    const view = read('../view/OrdersListView.tsx')
    expect(view).toContain("rowStepsOf(data, can)")
    expect(view).toContain("{ id: 'head-next', heading: true, label: t('menu.group.next') }")
    expect(view).toContain("...(cancel ? [{ id: 'sep-danger', separator: true }, stepItem(cancel, data)] : [])")
    expect(view).toContain("tone: 'danger' as const")
    expect(view).not.toMatch(/onStatus|setStatus|status\.edit/)
  })
})

describe('F-CP-108 — held words from the row\'s facts (held, never hidden; no amount without the price grain)', () => {
  const inProduction = { status: 'IN_PRODUCTION' as const, deposit: { state: 'PAID' as const, dueDate: null } }
  it('as Production manager (no orders.manage, no orders.close): Mark ready… and Cancel order… held "needs the sales right"; Close order… held', () => {
    const can = canOf('manager')
    expect(rowStepsOf(inProduction, can)).toEqual([
      { command: 'ready', held: { key: 'held.noManage' } },
      { command: 'cancel', held: { key: 'held.noManage' } },
    ])
    expect(rowStepsOf({ status: 'SHIPPED', deposit: { state: 'PAID', dueDate: null } }, can)).toEqual([{ command: 'close', held: { key: 'held.noClose' } }])
    expect(rowStepsOf({ status: 'DELIVERED', deposit: { state: 'PAID', dueDate: null } }, can)).toEqual([{ command: 'close', held: { key: 'held.noClose' } }])
  })
  it('Make work orders: the production manager\'s right first, then the deposit (open: its due day; never asked: missing)', () => {
    const noWork = { ...canOf('sales'), makeWorkOrders: false }
    expect(rowStepsOf({ status: 'CONFIRMED', deposit: { state: 'PAID', dueDate: null } }, noWork)[0]).toEqual({ command: 'make', held: { key: 'held.noWorkOrders' } })
    expect(rowStepsOf({ status: 'CONFIRMED', deposit: { state: 'OPEN', dueDate: '2026-11-04' } }, canOf('owner'))[0]).toEqual({ command: 'make', held: { key: 'held.deposit', params: { date: '2026-11-04' } } })
    expect(rowStepsOf({ status: 'CONFIRMED', deposit: { state: 'MISSING', dueDate: null } }, canOf('owner'))[0]).toEqual({ command: 'make', held: { key: 'held.depositMissing' } })
    expect(rowStepsOf({ status: 'CONFIRMED', deposit: { state: 'NOT_NEEDED', dueDate: null } }, canOf('owner'))[0]).toEqual({ command: 'make', held: null })
  })
  it('every held word is words in both languages, without a figure of money', () => {
    for (const locale of LOCALES) {
      const { say } = words(locale)
      for (const role of ROLE_NAMES) {
        for (const status of ORDER_STATUSES) {
          for (const step of rowStepsOf({ status, deposit: { state: 'MISSING', dueDate: null } }, canOf(role))) {
            if (!step.held) continue
            const text = say(step.held)
            expect(text, `${locale} ${role} ${status}`).not.toMatch(/€|EUR|\d+[.,]\d{2}/)
            expect(text).not.toMatch(/^held\./)
          }
        }
      }
    }
  })
})

describe('F-CP-108 — the window: A14\'s rules on the order as READ (the row may be older than the order)', () => {
  it('a command the read order no longer allows is held in the order page\'s words', () => {
    expect(windowHeldOf('ready', full('IN_PRODUCTION'), canOf('owner'))).toBeNull()
    expect(windowHeldOf('ready', full('READY'), canOf('owner'))).toEqual({ key: 'held.readyState' })
    expect(windowHeldOf('ready', full('IN_PRODUCTION'), canOf('manager'))).toEqual({ key: 'held.noManage' })
    expect(windowHeldOf('close', full('SHIPPED'), canOf('owner'))).toBeNull()
    expect(windowHeldOf('close', full('SHIPPED', { settled: false }), canOf('sales'))).toEqual({ key: 'held.notSettled' })
    expect(windowHeldOf('close', full('IN_PRODUCTION'), canOf('owner'))).toEqual({ key: 'held.closeState' })
    expect(windowHeldOf('cancel', full('CONFIRMED'), canOf('owner'))).toBeNull()
    expect(windowHeldOf('cancel', full('PARTLY_SHIPPED'), canOf('owner'))).toEqual({ key: 'held.cancelState' })
    expect(windowHeldOf('cancel', full('CLOSED'), canOf('owner'))).toEqual({ key: 'held.final' })
    expect(windowHeldOf('confirm', full('PENDING_APPROVAL', { openApprovals: [YES.decide] }), canOf('owner'))).toBeNull()
    expect(windowHeldOf('confirm', full('CONFIRMED'), canOf('owner'))).toEqual({ key: 'commands.confirmState', sheet: true })
  })
  it('titles and buttons are the order page\'s own words ("Mark SO-… ready to ship", "Close the order", "Cancel order")', () => {
    const { say } = words('en')
    expect(say(windowTitleOf('ready', 'SO-2026-0142'))).toBe('Mark SO-2026-0142 ready to ship')
    expect(say(windowTitleOf('close', 'SO-2026-0142'))).toBe('Close SO-2026-0142')
    expect(say(windowTitleOf('cancel', 'SO-2026-0142'))).toBe('Cancel order SO-2026-0142')
    expect(say(windowTitleOf('confirm', 'SO-2026-0142'))).toBe('Confirm or refuse SO-2026-0142')
    expect(say(windowGoOf('ready'))).toBe('Mark ready')
    expect(say(windowGoOf('close'))).toBe('Close the order')
    expect(say(windowGoOf('confirm'))).toBe('Confirm the order')
  })
  it('the close of an order not settled names what is missing in words, never an amount (the money wall)', () => {
    const dialogs = read('../../record/view/Dialogs.tsx')
    expect(dialogs).toContain('settlementWords(order).map((key) =>')
    const { t } = words('en')
    for (const key of ['settlement.BALANCE_DUE', 'settlement.NOT_INVOICED', 'close.notSettled']) expect(t(key)).not.toMatch(/€|\d/)
  })
})

describe('F-CP-108 — refusals in the dialog with the order page\'s words; 404 neutral (the brand wall)', () => {
  const conflict = (path: string) => new ApiError('conflict', 409, 'conflict', 'x', 'req-1', [{ path, message: 'x' }])
  it('409 stale → "Someone changed this order meanwhile" and read again; the state moved on → read again; a right missing; 404', () => {
    expect(writeProblem(conflict('body/version'))).toEqual({ key: 'problem.write.moved', reload: true })
    expect(writeProblem(conflict('status'))).toEqual({ key: 'problem.write.state', reload: true })
    expect(writeProblem(new ApiError('forbidden', 403, 'forbidden', 'x'))).toEqual({ key: 'problem.write.forbidden', reload: false })
    expect(writeProblem(new ApiError('not_found', 404, 'not_found', 'x'))).toEqual({ key: 'problem.write.not_found', reload: true })
    expect(readProblem(new ApiError('not_found', 404, 'not_found', 'x'))).toBe('problem.read.not_found')
  })
  it('an order out of reach reads as "not there any more": the same words as an unknown id, naming nobody', () => {
    for (const locale of LOCALES) {
      const { t, s } = words(locale)
      const text = s('commands.readFailed', { number: 'SO-2026-0142', problem: t('problem.read.not_found') })
      expect(text).toContain('SO-2026-0142')
      expect(text).toContain(t('problem.read.not_found'))
      expect(text).not.toMatch(/Brand|customer|cliente/i)
    }
  })
  it('the window keeps what was typed: a refusal leaves the dialog mounted with its words (the door does not close on a refusal)', () => {
    const door = read('./use-order-command-door.ts')
    expect(door).toContain('update(mine, (m) => ({ ...m, busy: false, dialogProblem: words }))')
    expect(door).toContain('if (words.reload) read(mine, order.id, now.command)')
  })
})

describe('F-CP-108 — the order page\'s OWN dialogs, mounted (never a copy); every write with the version and an Idempotency-Key', () => {
  it('Dialogs.tsx / DailyDialogs.tsx / DepthBand.tsx: a type-only export in a marked block (the order lead\'s yes)', () => {
    const dialogs = read('../../record/view/Dialogs.tsx')
    expect(dialogs).toContain('// ---- F-CP-108 (customer page plan C2b; lane agreement (a), the order lead\'s yes): TYPE ONLY')
    expect(dialogs).toContain("export type CommandDialogModel = Pick<OrderRecordModel, 'busy' | 'draft' | 'can' | 'dialogProblem' | 'cancelCheck' | 'prefix'>")
    expect(dialogs).toContain('export /* F-CP-108 */ function ReadyDialog(')
    expect(dialogs).toContain('export /* F-CP-108 */ function CloseDialog(')
    expect(read('../../record/view/DailyDialogs.tsx')).toContain('export function CancelDialog({ order, model, actions }: { order: Order; model: CommandDialogModel; actions?: CommandDialogActions } /* F-CP-108: type only */)')
    expect(read('../../depth/view/DepthBand.tsx')).toContain("export type RefuseYesModel = Pick<OrderRecordModel, 'dialog' | 'draft' | 'refuseReasons' | 'busy' | 'dialogProblem'>")
  })
  it('the window imports those dialogs and defines none of its own; the view fetches nothing', () => {
    const view = read('./view/OrderCommandWindow.tsx')
    expect(view).toContain("import { CloseDialog, Frame, ReadyDialog, type CommandDialogActions, type CommandDialogModel } from '../../../record/view/Dialogs'")
    expect(view).toContain("import { CancelDialog } from '../../../record/view/DailyDialogs'")
    expect(view).toContain("import { RefuseYesDialog, YesDoorView } from '../../../depth/view/DepthBand'")
    expect(view).not.toMatch(/function (Ready|Close|Cancel|RefuseYes)Dialog/)
    expect(view).not.toMatch(/use-order-command-door|lib\/api\/|fetch\(/)
  })
  it('the door writes through the order page\'s routes with the order\'s version; each route sends an Idempotency-Key', () => {
    const door = read('./use-order-command-door.ts')
    expect(door).toContain('markReady(api, order.id, { version: order.version, reason })')
    expect(door).toContain('closeOrder(api, order.id, { version: order.version, ...(reason ? { reason } : {}) })')
    expect(door).toContain('cancelOrder(api, order.id, { version: order.version, reason, confirmNumber: typed')
    expect(door).toContain('approveTask(api, { id: task.taskId, version: task.version }, null, key)')
    expect(door).toContain("if (task.requireStepUp) await stepUp.ensureFresh('approval.stepUp')")
    const api = read('../../api.ts')
    expect(api).toMatch(/\/ready`, \{ body, schema: one, idempotencyKey: newIdempotencyKey\(\) \}/)
    expect(api).toMatch(/\/close`, \{ body, schema: one, idempotencyKey: newIdempotencyKey\(\) \}/)
    expect(api).toMatch(/\/cancel`, \{ body, schema: .*idempotencyKey: newIdempotencyKey\(\) \}/)
  })
  it('the ONE sheet gives the door on every host (Sales › Orders and the customer page); done: the row in place and a toast', () => {
    const sheet = read('../use-orders-sheet.ts')
    expect(sheet).toContain('const commandDoor = useOrderCommandDoor(api, {')
    expect(sheet).toContain('if (row) commandDoor.open({ id: row.id, number: row.number }, command)')
    expect(sheet).toContain('commands: { window: commandDoor.model, moved, receipt }, // F-CP-108')
    expect(sheet).toContain('setMoved([]) // F-CP-108: a read again puts every row where the view says')
    const view = read('../view/OrdersListView.tsx')
    expect(view).toContain('{model.commands?.window && <OrderCommandWindow model={model.commands.window} actions={actions?.command} />}')
    expect(view).toContain(".map((column) => withMovedMark(column, () => latest.current.model.commands?.moved ?? [])) // F-CP-108")
    expect(view).toContain("toast(wordsText(receipt.words, t, s, locale), 'success')")
  })
})

describe('F-CP-108 — a row that leaves the view stays greyed until "N updates · Show"', () => {
  it('every order: always; Open orders: a closed or cancelled one leaves; a state\'s view: another state leaves; the server\'s views: final ones leave', () => {
    for (const status of ORDER_STATUSES) expect(stillInView('all', status)).toBe(true)
    expect(stillInView('open', 'READY')).toBe(true)
    expect(stillInView('open', 'CANCELLED')).toBe(false)
    expect(stillInView('open', 'SHIPPED')).toBe(false)
    expect(stillInView('IN_PRODUCTION', 'IN_PRODUCTION')).toBe(true)
    expect(stillInView('IN_PRODUCTION', 'READY')).toBe(false)
    expect(stillInView('PENDING_APPROVAL', 'CONFIRMED')).toBe(false)
    expect(stillInView('late', 'READY')).toBe(true)
    expect(stillInView('late', 'CANCELLED')).toBe(false)
  })
})

describe('F-CP-108 — words (it + en, the same placeholders; the order page\'s own words reused)', () => {
  it('the new words', () => {
    const en = words('en')
    expect(en.s('commands.confirmOrRefuse')).toBe('Confirm or refuse…')
    expect(en.say(doneWords('ready', 'SO-2026-0142'))).toBe('SO-2026-0142 marked ready')
    expect(en.say(doneWords('confirm', 'SO-2026-0142'))).toBe('SO-2026-0142 confirmed')
    expect(en.say(doneWords('cancel', 'SO-2026-0142'))).toBe('SO-2026-0142 cancelled')
    const ita = words('it')
    expect(ita.s('commands.confirmOrRefuse')).toBe('Conferma o rifiuta…')
    expect(ita.say(doneWords('ready', 'SO-2026-0142'))).toBe('SO-2026-0142 segnato come pronto')
    for (const locale of LOCALES) {
      const { s } = words(locale)
      for (const key of ['commands.reading', 'commands.yesTitle', 'commands.openOrder', 'commands.done.ready', 'commands.done.close', 'commands.done.cancel', 'commands.done.confirm', 'commands.done.refuse']) expect(s(key, { number: 'SO-1' }), `${locale} ${key}`).toContain('SO-1')
      for (const key of ['commands.noYes', 'commands.confirmState']) expect(s(key)).not.toBe(key)
    }
    // The menu's heading and the commands are the order page's words (one word per meaning).
    expect(en.t('menu.group.next')).toBe('Next steps')
    expect(en.t('action.ready')).toBe('Mark ready…')
    expect(en.t('step.close')).toBe('Close order…')
    expect(en.t('action.cancel')).toBe('Cancel order…')
  })
  it('status words inside a sentence are lower case, joined by "or"', () => {
    const { t } = words('en')
    expect(statesText(['PENDING_APPROVAL'], t, 'en')).toBe('waiting for a yes')
    expect(statesText(['SHIPPED', 'DELIVERED'], t, 'en')).toBe('shipped or delivered')
    const ita = words('it')
    expect(statesText(['SHIPPED', 'DELIVERED'], ita.t, 'it')).toBe('spedito o consegnato')
  })
})
