import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CANCEL_STATUSES, orderActions } from '@nexus/factory-domain/sales/orders/orders'
import { releasedPiecesOf } from '@nexus/factory-domain/sales/orders/orders' // F-OO-112: the API's counts on the fixture
import { ApiError } from '../../../../../lib/api/errors'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { ORDER_STATUSES, type OpenApproval, type Order, type OrderRow, type OrderStatus } from '../../api'
import { canOf, deposit, order, ROLES, type Role } from '../../_demo/fixtures'
import { actionOf, cancelHeld, closeHeld, depositGate, nextStep, readProblem, readyHeld, writeProblem } from '../../model'
import { confirmHeldOf, doneWords, orderYesDoor, ROW_COMMANDS, rowStepsOf, statesText, stillInView, windowGoOf, windowHeldOf, windowTitleOf, wordsText, type RowCommand, type Words } from './model'
// ---- F-CP-109 ----
import { createElement } from 'react'
import { render, textOf } from '../../../../../lib/record-thread/parts/testing'
import { STEP_UP_CLOSED } from '../../hooks'
import { MANY_COMMANDS, MANY_MAX, MANY_READ_AT_ONCE, manyGoHeld, manyHeld, manyLabel, manyNeedsReason, manyOutcomeOf, manyPreview, manyReadOf, manyReceipt, manyShown, runMany, yesTaskOf, type ManyLine, type ManyRead, type ManyResult, type ManyTarget, type OrderCommandManyModel } from './model'
import { OrderCommandManyBody } from './view/OrderCommandManyDialog'
// ---- end F-CP-109

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

/**
 * A full order of a state, its actions as the API's own map gives them (factory-domain orderActions; settled unless asked). F-OO-112
 * (B-OO-002, Owner D1): quality released every piece unless asked (`released: false`: the demo's 7 of 14) — Mark ready is allowed then,
 * so the parity compares the row with readyHeld on a released fixture; the quality hold is the window's (its own test below).
 */
function full(status: OrderStatus, over: Partial<Order> & { settled?: boolean; released?: boolean } = {}): Order {
  const { released = true, ...rest } = over // F-OO-112
  const value = order(status, rest)
  const settled = over.settled ?? true
  const releasedPieces = releasedPiecesOf(value.lines.map((line) => ({ kind: line.kind, rows: line.sizes.map((size) => size.progress) }))) // F-OO-112
  const actions = orderActions(status, { released, releasedPieces, settlement: { settled, missing: settled ? [] : [{ code: 'BALANCE_DUE', message: 'The invoices are not paid in full.' }], source: 'invoicing' } }).map((entry) => ({ action: entry.action, allowed: entry.allowed, needsReason: entry.needsReason, held: entry.held }))
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
        // In production: Mark ready…, held as readyHeld (the API's markReady action is there) — F-OO-112: on a released fixture (`full`'s
        // default); the quality hold is the window's, from the read (as Close's "not settled"): see the F-OO-112 test.
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
      // B-OO-003 (order overview N3): a waiting order is cancelled too (CANCEL_STATUSES): Cancel order… follows Confirm or refuse….
      expect(rowStepsOf(rowOf(value), can).map((entry) => entry.command), name).toEqual(['confirm', 'cancel'])
    }
    expect(confirmHeldOf(full('PENDING_APPROVAL', { openApprovals: [YES.decide] }))).toBeNull()
    expect(confirmHeldOf(full('PENDING_APPROVAL', { openApprovals: [YES.selfAsked] }))).toEqual({ key: 'approval.selfAsked' })
    expect(confirmHeldOf(full('PENDING_APPROVAL', { openApprovals: [YES.whoDecides] }))).toEqual({ key: 'approval.whoDecides', params: { who: 'Finance' } })
    // Nobody asked yet (asking is the order page's): said so, never a dead Confirm.
    expect(confirmHeldOf(full('PENDING_APPROVAL', { openApprovals: [] }))).toEqual({ key: 'commands.noYes', sheet: true })
    expect(confirmHeldOf(full('CONFIRMED'))).toEqual({ key: 'commands.confirmState', sheet: true })
  })
})

// ---- F-OO-112 (order overview N13, Owner D1; B-OO-002): Mark ready only after quality released every piece — the hold is the window's ----
describe('F-OO-112 — the row holds Mark ready by the right only (as Close); the window and Mark N ready say the quality hold in words', () => {
  it('quality released 7 of 14: the row\'s Mark ready… opens its window, which says the N of M words; Mark N ready puts it under "Not on"', () => {
    const can = canOf('owner')
    const held = full('IN_PRODUCTION', { released: false })
    expect(heldOf(rowStepsOf(rowOf(held), can), 'ready')).toBeNull()
    expect(windowHeldOf('ready', held, can)).toEqual({ key: 'held.readyQuality', params: { n: 7, m: 14 } })
    expect(windowHeldOf('ready', held, can)).toEqual(readyHeld(held, can))
    expect(words('en').say(windowHeldOf('ready', held, can)!)).toBe('Quality releases the garments: 7 of 14 released. The order turns Ready by itself when all are.')
    expect(words('it').say(windowHeldOf('ready', held, can)!)).toBe("Il rilascio lo fa la qualità: 7 su 14 rilasciati. L'ordine diventa Pronto da solo quando lo sono tutti.")
    // Released: the window opens (the catch-up before the system moves it).
    expect(windowHeldOf('ready', full('IN_PRODUCTION'), can)).toBeNull()
    // Mark N ready: the held one is named with its words, the released one runs (the same readyHeld; the bulk code is unchanged).
    const target = (id: string, number: string) => ({ id, number, customerRef: null })
    const preview = manyPreview('ready', [target('a', 'SO-1'), target('b', 'SO-2')], { a: { state: 'ready', order: held }, b: { state: 'ready', order: full('IN_PRODUCTION') } }, can)
    expect(preview.runs.map((line) => line.target.number)).toEqual(['SO-2'])
    expect(preview.notOn.map((line) => [line.target.number, line.why])).toEqual([['SO-1', { key: 'held.readyQuality', params: { n: 7, m: 14 } }]])
    // Without orders.manage the row and the window say the right first (unchanged).
    expect(heldOf(rowStepsOf(rowOf(held), canOf('manager')), 'ready')).toEqual(windowHeldOf('ready', held, canOf('manager')))
  })
})
// ---- end F-OO-112

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
    expect(sheet).toContain('commands: { window: commandDoor.model, moved, receipt, ')
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

// ---- F-CP-109 (customer page plan C2b, D8; 10-customer-page §3.2; lead pick: ≤ 50 with ONE step-up) ----------------------------------

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const target = (n: number, customerRef: string | null = null): ManyTarget => ({ id: uid(n), number: `SO-2026-0${140 + n}`, customerRef })
const fullOf = (n: number, status: OrderStatus, over: Partial<Order> & { settled?: boolean } = {}): Order => ({ ...full(status, over), id: uid(n), number: `SO-2026-0${140 + n}` })
const manyModel = (over: Partial<OrderCommandManyModel> = {}): OrderCommandManyModel => ({ command: 'close', targets: [], reads: {}, reason: '', phase: 'preview', progress: null, results: {}, stepUp: STEP_UP_CLOSED, can: canOf('owner'), ...over })
const ready = (order: Order): ManyRead => ({ state: 'ready', order })
const conflictOn = (path: string) => new ApiError('conflict', 409, 'conflict', 'x', 'req-1', [{ path, message: 'x' }])

describe('F-CP-109 — the bar: Mark {count} ready… · Close {count}… · Confirm {count}…, held in words before the click', () => {
  const rows = (...statuses: OrderStatus[]) => statuses.map((status) => ({ status }))
  it('which buttons: Mark ready for everyone (held without orders.manage), Close with manage or close, Confirm for who decides yeses; never Cancel', () => {
    expect([...MANY_COMMANDS]).toEqual(['ready', 'close', 'confirm'])
    expect(manyShown(canOf('owner'), true)).toEqual(['ready', 'close', 'confirm'])
    expect(manyShown(canOf('owner'), false)).toEqual(['ready', 'close'])
    expect(manyShown(canOf('finance'), true)).toEqual(['ready', 'close', 'confirm'])
    // As Production manager (picture 20-pm): only Mark 2 ready…, held in the catalogue's words.
    expect(manyShown(canOf('manager'), false)).toEqual(['ready'])
    expect(manyHeld('ready', rows('IN_PRODUCTION', 'IN_PRODUCTION'), canOf('manager'))).toEqual({ key: 'held.noManage' })
    expect(manyHeld('close', rows('SHIPPED'), canOf('manager'))).toEqual({ key: 'held.noClose' })
  })
  it('more than 50: "At most 50 orders at once."; 50 is fine', () => {
    expect(MANY_MAX).toBe(50)
    const fifty = Array.from({ length: 50 }, () => ({ status: 'IN_PRODUCTION' as const }))
    expect(manyHeld('ready', fifty, canOf('owner'))).toBeNull()
    expect(manyHeld('ready', [...fifty, { status: 'IN_PRODUCTION' as const }], canOf('owner'))).toEqual({ key: 'bulk.tooMany', params: { max: 50 }, sheet: true })
    expect(words('en').say({ key: 'bulk.tooMany', params: { max: 50 }, sheet: true })).toBe('At most 50 orders at once.')
  })
  it('noneInState: "None of the 2 is waiting for a yes." (picture 20) — the status words in the sentence, both languages', () => {
    const held = manyHeld('confirm', rows('IN_PRODUCTION', 'CONFIRMED'), canOf('owner'))!
    expect(held).toEqual({ key: 'bulk.noneInState', params: { count: 2 }, sheet: true, states: ['PENDING_APPROVAL'] })
    expect(words('en').say(held)).toBe('None of the 2 is waiting for a yes.')
    expect(words('it').say(held)).toBe('Nessuno dei 2 è «in attesa di approvazione».')
    expect(words('en').say(manyHeld('ready', rows('READY'), canOf('owner'))!)).toBe('The order ticked is not in production.')
    expect(words('en').say(manyHeld('close', rows('IN_PRODUCTION', 'READY', 'CONFIRMED'), canOf('owner'))!)).toBe('None of the 3 is shipped or delivered.')
    // One in the state is enough: the preview says why the others do not run.
    expect(manyHeld('close', rows('IN_PRODUCTION', 'DELIVERED'), canOf('owner'))).toBeNull()
  })
  it('the buttons\' words', () => {
    const en = words('en')
    expect(en.say(manyLabel('ready', 2))).toBe('Mark 2 ready…')
    expect(en.say(manyLabel('close', 2))).toBe('Close 2…')
    expect(en.say(manyLabel('confirm', 2))).toBe('Confirm 2…')
    const ita = words('it')
    expect(ita.say(manyLabel('ready', 2))).toBe('Segna 2 come pronti…')
    expect(ita.say(manyLabel('ready', 1))).toBe('Segna 1 come pronto…')
    expect(ita.say(manyLabel('confirm', 2))).toBe('Conferma 2…')
  })
  it('the bar draws them after Reply to N, the bulk window beside the other windows; the sheet gives them on every host (source)', () => {
    const view = read('../view/OrdersListView.tsx')
    expect(view).toContain('manyShown(model.can, !!model.commands?.decide).map((command) => {')
    expect(view).toContain('heldReason={held ? wordsText(held, t, s, locale) : null}')
    expect(view).toContain('{model.commands?.many && <OrderCommandManyDialog model={model.commands.many} actions={actions?.commandMany} />}')
    expect(view.indexOf('actions?.onReplyMany && (')).toBeLessThan(view.indexOf('actions?.onCommandMany &&'))
    const sheet = read('../use-orders-sheet.ts')
    expect(sheet).toContain('onCommandMany: (ids, command) => commandMany.open(command, pickedRows(ids)),')
    expect(sheet).toContain("decide: session.permissions.includes('approvals.decide')")
  })
})

describe('F-CP-109 — the preview: each ticked order read (5 at a time), A14\'s rule on each, "Runs on 6 · Not on 2: why is beside each"', () => {
  it('each order by number with the order page\'s held words beside it; an order out of reach is counted, never named', () => {
    const targets = [target(1, 'PO-11'), target(2), target(3), target(4), target(5)]
    const reads: Record<string, ManyRead> = {
      [uid(1)]: ready(fullOf(1, 'SHIPPED')),
      [uid(2)]: ready(fullOf(2, 'DELIVERED', { settled: false })),
      [uid(3)]: ready(fullOf(3, 'IN_PRODUCTION')),
      [uid(4)]: { state: 'gone' },
      [uid(5)]: { state: 'reading' },
    }
    const preview = manyPreview('close', targets, reads, canOf('owner'))
    expect(preview.runs.map((line) => line.target.id)).toEqual([uid(1), uid(2)])
    expect(preview.runs[1]!.note).toEqual({ key: 'close.notSettled' }) // words only, never an amount
    expect(preview.notOn.map((line) => [line.target.id, line.why])).toEqual([[uid(3), { key: 'held.closeState' }]])
    expect(preview.gone).toBe(1)
    expect(preview.reading).toBe(1)
    const text = textOf(render(createElement(OrderCommandManyBody, { model: manyModel({ targets, reads }) }), 'en'))
    expect(text).toContain('Runs on 2 · Not on 1: why is beside it')
    expect(text).toContain('SO-2026-0141 (PO-11)')
    expect(text).toContain('SO-2026-0143')
    expect(text).toContain('Only a shipped order is closed')
    expect(text).toContain('1 order can no longer be opened: it is left out.')
    expect(text).not.toContain('SO-2026-0144') // out of reach: counted, never named
    expect(text).toContain('Reading the orders: 4 of 5…')
    expect(text).toContain('Cancelling is one order at a time')
  })
  it('a read that fails says why (named: it is the reader\'s own row); 404 and 403 are out of reach', () => {
    expect(manyReadOf(new ApiError('not_found', 404, 'not_found', 'x'))).toEqual({ state: 'gone' })
    expect(manyReadOf(new ApiError('forbidden', 403, 'forbidden', 'x'))).toEqual({ state: 'gone' })
    expect(manyReadOf(new ApiError('unavailable', 503, 'unavailable', 'x'))).toEqual({ state: 'failed', problem: 'problem.read.unavailable' })
    expect(manyReadOf(new Error('boom'))).toEqual({ state: 'failed', problem: 'problem.read.internal' })
    expect(MANY_READ_AT_ONCE).toBe(5)
    expect(read('./use-order-command-many.ts')).toContain('Array.from({ length: Math.min(MANY_READ_AT_ONCE, targets.length) }, worker)')
  })
  it('Confirm N: each order named, one code for all, the yes this reader decides (the asker and another\'s yes do not run)', () => {
    const targets = [target(1), target(2), target(3)]
    const reads: Record<string, ManyRead> = {
      [uid(1)]: ready(fullOf(1, 'PENDING_APPROVAL', { openApprovals: [YES.decide] })),
      [uid(2)]: ready(fullOf(2, 'PENDING_APPROVAL', { openApprovals: [YES.selfAsked] })),
      [uid(3)]: ready(fullOf(3, 'PENDING_APPROVAL', { openApprovals: [YES.whoDecides] })),
    }
    const preview = manyPreview('confirm', targets, reads, canOf('owner'))
    expect(preview.runs.map((line) => line.target.id)).toEqual([uid(1)])
    expect(yesTaskOf(preview.runs[0]!.order!)?.taskId).toBe(YES.decide.taskId)
    expect(preview.notOn.map((line) => line.why)).toEqual([{ key: 'approval.selfAsked' }, { key: 'approval.whoDecides', params: { who: 'Finance' } }])
    const text = textOf(render(createElement(OrderCommandManyBody, { model: manyModel({ command: 'confirm', targets, reads }) }), 'en'))
    for (const one of targets) expect(text).toContain(one.number)
    expect(text).toContain('One code from your authenticator app confirms each order named here')
    // ONE fresh code before the first yes (ensureFresh once), then one yes per order with its own task version and key.
    const hook = read('./use-order-command-many.ts')
    expect(hook.match(/stepUp\.ensureFresh\('approval\.stepUp'\)/g)).toHaveLength(1)
    expect(hook.indexOf("stepUp.ensureFresh('approval.stepUp')")).toBeLessThan(hook.indexOf('await runMany('))
    expect(hook).toContain('approveTask(api, { id: task.taskId, version: task.version }, null, newIdempotencyKey())')
  })
})

describe('F-CP-109 — ONE reason, the run (one order at a time, its own version), partial results', () => {
  it('one reason when one is needed: Mark ready always; Close only for an order not settled; Confirm never', () => {
    const settled = { order: fullOf(1, 'SHIPPED') }
    const open = { order: fullOf(2, 'SHIPPED', { settled: false }) }
    expect(manyNeedsReason('ready', [{ order: fullOf(3, 'IN_PRODUCTION') }])).toBe(true)
    expect(manyNeedsReason('close', [settled])).toBe(false)
    expect(manyNeedsReason('close', [settled, open])).toBe(true)
    expect(manyNeedsReason('confirm', [{ order: fullOf(4, 'PENDING_APPROVAL') }])).toBe(false)
    expect(manyGoHeld('ready', { runs: [{ target: target(3), order: fullOf(3, 'IN_PRODUCTION'), runs: true, why: null, note: null }], reading: 0 }, '  ', false)).toEqual({ key: 'ready.reasonNeeded' })
    expect(manyGoHeld('close', { runs: [{ target: target(2), ...open, runs: true, why: null, note: null }], reading: 0 }, '', false)).toEqual({ key: 'close.reasonNeeded' })
    expect(manyGoHeld('close', { runs: [], reading: 0 }, '', false)).toEqual({ key: 'commands.many.nothing', sheet: true })
    expect(manyGoHeld('close', { runs: [], reading: 2 }, '', false)).toEqual({ key: 'commands.many.stillReading', sheet: true })
    expect(manyGoHeld('close', { runs: [{ target: target(1), ...settled, runs: true, why: null, note: null }], reading: 0 }, '', true)).toEqual({ key: 'held.busy' })
    // The reason goes only to the orders that need it (a settled one closes with none, as on the order page).
    expect(read('./use-order-command-many.ts')).toContain('closeOrder(api, order.id, { version: order.version, ...(closeNeedsReason(order) ? { reason } : {}) })')
  })
  it('one order at a time, in the ticked order; a failure never stops the rest; each answer lands on its own line', async () => {
    const lines: ManyLine[] = [1, 2, 3, 4].map((n) => ({ target: target(n), order: fullOf(n, 'IN_PRODUCTION'), runs: true, why: null, note: null }))
    const seen: string[] = []
    let running = 0
    let most = 0
    const results: Record<string, ManyResult> = {}
    const done = await runMany(
      lines,
      async (line) => {
        running += 1
        most = Math.max(most, running)
        seen.push(line.target.number)
        await Promise.resolve()
        running -= 1
        if (line.target.number === 'SO-2026-0142') throw conflictOn('body/version')
        if (line.target.number === 'SO-2026-0143') throw new ApiError('forbidden', 403, 'forbidden', 'x')
      },
      (id, result) => {
        results[id] = result
      },
    )
    expect(seen).toEqual(['SO-2026-0141', 'SO-2026-0142', 'SO-2026-0143', 'SO-2026-0144'])
    expect(most).toBe(1)
    expect(done).toBe(2)
    expect(results[uid(1)]).toEqual({ state: 'done' })
    expect(results[uid(2)]).toEqual({ state: 'notDone', why: { key: 'commands.many.stale', params: { number: 'SO-2026-0142' }, sheet: true } })
    expect(results[uid(3)]).toEqual({ state: 'gone' })
    expect(results[uid(4)]).toEqual({ state: 'done' })
    // Each with its own version as read (and the route's own Idempotency-Key).
    expect(read('./use-order-command-many.ts')).toContain('markReady(api, order.id, { version: order.version, reason })')
  })
  it('stale words: "SO-0150 changed meanwhile: open it and try again." (both languages); other refusals keep the order page\'s words', () => {
    const stale = manyOutcomeOf(conflictOn('body/version'), 'SO-2026-0150')
    expect(stale).toEqual({ state: 'notDone', why: { key: 'commands.many.stale', params: { number: 'SO-2026-0150' }, sheet: true } })
    expect(manyOutcomeOf(conflictOn('status'), 'SO-2026-0150')).toEqual(stale)
    expect(words('en').say((stale as { why: Words }).why)).toBe('SO-2026-0150 changed meanwhile: open it and try again.')
    expect(words('it').say((stale as { why: Words }).why)).toBe('SO-2026-0150 è cambiato nel frattempo: aprilo e riprova.')
    expect(manyOutcomeOf(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'body/reason', message: 'x' }]), 'SO-1')).toEqual({ state: 'notDone', why: { key: 'problem.write.invalid' } })
    expect(manyOutcomeOf(new ApiError('not_found', 404, 'not_found', 'x'), 'SO-1')).toEqual({ state: 'gone' })
  })
  it('an expired code → "run the rest again": its orders are not done, Run the rest again reads them again (a fresh version, a fresh code)', () => {
    expect(manyOutcomeOf(new ApiError('step_up', 403, 'forbidden', 'x', null, [{ path: 'stepUp', message: 'x' }]), 'SO-1')).toEqual({ state: 'codeExpired' })
    const targets = [target(1), target(2), target(3), target(4)]
    const results: Record<string, ManyResult> = { [uid(1)]: { state: 'done' }, [uid(2)]: { state: 'codeExpired' }, [uid(3)]: { state: 'notDone', why: { key: 'problem.write.forbidden' } }, [uid(4)]: { state: 'gone' } }
    const receipt = manyReceipt(targets, results)
    expect(receipt).toMatchObject({ done: 1, left: 2, gone: 1 })
    expect(receipt.again.map((one) => one.id)).toEqual([uid(2), uid(3)])
    const text = textOf(render(createElement(OrderCommandManyBody, { model: manyModel({ command: 'confirm', targets, reads: {}, phase: 'done', results }) }), 'en'))
    expect(text).toContain('1 done · 2 not done')
    expect(text).toContain('SO-2026-0142 The code ran out before this one: run the rest again.')
    expect(text).toContain('SO-2026-0143 Not done. Your role may not do this.')
    expect(text).toContain('1 order can no longer be opened: it is left out.')
    expect(text).not.toContain('SO-2026-0144')
    expect(words('en').s('commands.many.runRest', { count: 2 })).toBe('Run the rest again (2)')
    expect(read('./use-order-command-many.ts')).toContain('const again = manyReceipt(now.targets, now.results).again')
  })
  it('the result of a run: each order the run touched takes its answer in place and is read again by id (source)', () => {
    const sheet = read('../use-orders-sheet.ts')
    expect(sheet).toContain('for (const order of answered) placeRow(order.id, (row) => ({ ...row, status: order.status, version: order.version, updatedAt: order.updatedAt }), order.status)')
    expect(sheet).toContain('listOrders(api, { ids: ran.slice(0, 50), production: productionShown, progress: progressShown, limit: 50 })')
  })
})

describe('F-CP-109 — the money wall: the Close preview says "not settled" in words only (as Sales worker / as Production manager)', () => {
  for (const [who, can] of [
    ['Sales worker', { ...canOf('sales'), price: false, close: true }],
    ['Production manager (with the close right for this case)', { ...canOf('manager'), close: true }],
  ] as const) {
    it(`as ${who}: no amount, no difference, no sum`, () => {
      const targets = [target(1), target(2)]
      const reads: Record<string, ManyRead> = { [uid(1)]: ready(fullOf(1, 'SHIPPED', { settled: false })), [uid(2)]: ready(fullOf(2, 'DELIVERED')) }
      for (const locale of LOCALES) {
        const text = textOf(render(createElement(OrderCommandManyBody, { model: manyModel({ targets, reads, can }) }), locale))
        expect(text).toContain(words(locale).t('close.notSettled'))
        expect(text).not.toMatch(/€|EUR|\d+[.,]\d{2}/)
      }
    })
  }
})

describe('F-CP-109 — words (it + en, plural pairs, the same placeholders)', () => {
  it('the window\'s words', () => {
    const en = words('en')
    expect(en.s('commands.many.title.ready', { count: 6 })).toBe('Mark 6 orders ready')
    expect(en.s('commands.many.title.close', { count: 1 })).toBe('Close 1 order')
    expect(en.s('commands.many.go.confirm', { count: 6 })).toBe('Confirm 6')
    expect(en.s('commands.runs', { count: 6 })).toBe('Runs on 6')
    expect(en.s('commands.notOn', { count: 2 })).toBe('Not on 2: why is beside each')
    expect(en.s('commands.many.result', { done: 5, left: 1 })).toBe('5 done · 1 not done')
    expect(en.s('commands.cancelOne')).toBe('Cancelling is one order at a time (⋯ on its row): each shows what it stops.')
    const ita = words('it')
    expect(ita.s('commands.many.title.ready', { count: 6 })).toBe('Segna 6 ordini come pronti')
    expect(ita.s('commands.runs', { count: 6 })).toBe('Si applica a 6')
    expect(ita.s('commands.many.result', { done: 5, left: 1 })).toBe('5 fatti · 1 non fatti')
    for (const locale of LOCALES) {
      const { s } = words(locale)
      for (const key of ['commands.many.reading', 'commands.many.running']) expect(s(key, { done: 3, count: 6 })).toMatch(/3.*6/)
      for (const key of ['commands.many.stillReading', 'commands.many.nothing', 'commands.many.reasonAll', 'commands.many.oneCode', 'commands.many.codeExpired', 'commands.many.label']) expect(s(key), `${locale} ${key}`).not.toBe(key)
    }
  })
})
