import type { DepositRequest, Order, Schedule, Settlement } from '../../../api'
import type { StepUpState } from '../../../hooks'
import { abilitiesOf, isFinal, type OrderAbilities, type Phrase } from '../../../model'
import type { MoneyDialog, Part } from '../../record-model'
import type { WaiveTarget } from '../../schedule/api'
import { stepAbilitiesOf, type StepAbilities } from '../../schedule/model'
import type { MoneyDialogActions, MoneyDialogModel } from '../../view/Dialogs'
import { planOf, type PlanAct, type PlanRow } from '../plan'
import { stillToPayOf } from '../totals'
import { word, type MoneyWord } from '../word'

/**
 * F-CM-k2 (customer MONEY tab, 13-backend §4.1; 18-lead-settles Z5; 10-design §5.2, §6, §9) — the money DOOR's rule, pure. A row of the
 * customer's To collect is ONE request of ONE order (a deposit, an extra deposit, a balance before shipping); its acts are the ORDER's
 * own, run in the order page's own windows (the door: use-order-money-door.ts, OrderMoneyWindow.tsx). Two questions:
 *
 *   rowActsOf     which acts the row offers, by its kind and the reader's rights (hidden without the right, never held for it):
 *                 ONE act  Record a payment (payments.record + the price grain)
 *                 its ⋯    Send the page (payments.record) · Move due day… (orders.moneyPlan) · Change the deposit… (orders.moneyPlan +
 *                          price; not on a balance before shipping) · Accept short (bank charges)… (orders.moneyPlan + price; not on a row
 *                          known to be paid nothing) · Waive… (orders.waive: the Owner)
 *   doorRulingOf  once the window read the order, its plan and its settlement: does the act still stand on the order AS READ (the plan's
 *                 own rule, money/plan.ts planOf — the row may be older than the order)? Held: in the plan's words. Else: which of the
 *                 order page's windows it opens on this request.
 *
 * NEVER from a row: Open for payment and Ask again… (they act on a step with NO open request: such a step has no row) · Undo this
 * payment… (it needs a payment's id) · Stop the page (the row does not know of a page). They stay on the order's Money ("Open the
 * order's Money ›").
 */

/** The order's acts a To-collect row may offer, in the row's order (the ONE act first, then its ⋯). */
export const DOOR_ACTS = ['record', 'send', 'MOVE_DUE', 'REPLACE_DEPOSIT', 'ACCEPT_SHORT', 'waive'] as const
export type DoorActId = (typeof DOOR_ACTS)[number]

/** The order page's acts a row never offers: they stay on the order's Money. */
export const NEVER_FROM_A_ROW = ['open', 'ASK_AGAIN', 'undoPayment', 'stopPage'] as const

/** The rights the row's acts read: the order page's own (abilitiesOf) and the waive (orders.waive). */
export type DoorCan = Pick<OrderAbilities, 'recordPayment' | 'price' | 'moneyPlan'> & { readonly waive: boolean }

/** The row's rights from the reader's permissions, by the order page's own rules (one rule with it). */
export function doorCanOf(permissions: readonly string[]): DoorCan {
  const can = abilitiesOf(permissions)
  return { recordPayment: can.recordPayment, price: can.price, moneyPlan: can.moneyPlan, waive: stepAbilitiesOf(permissions).waive }
}

/** A To-collect row of one request, as the customer's tab knows it (`GET /payments/open-items`). */
export interface DoorRow {
  /** The request's step: the deposit (or an extra deposit), or the balance before shipping; null: not said. */
  readonly stepKind: 'DEPOSIT' | 'BEFORE_SHIPPING' | null
  /** Money is placed on it and some is still open (the price grain's amounts); null: the row cannot say. */
  readonly partPaid: boolean | null
}

export interface DoorActs {
  /** The row's ONE act (Record a payment); null: not for this reader. */
  readonly act: DoorActId | null
  /** Its ⋯, in this order (each opens the order's own window). */
  readonly more: readonly DoorActId[]
}

/** The acts a row offers this reader: hidden without the right (never held for it); the order as read may still hold one. */
export function rowActsOf(row: DoorRow, can: DoorCan): DoorActs {
  const offered = DOOR_ACTS.filter((id) => offers(id, row, can))
  const act = offered.includes('record') ? 'record' : null
  return { act, more: offered.filter((id) => id !== act) }
}

function offers(id: DoorActId, row: DoorRow, can: DoorCan): boolean {
  switch (id) {
    case 'record':
      return can.recordPayment && can.price
    case 'send':
      return can.recordPayment
    case 'MOVE_DUE':
      return !!can.moneyPlan
    case 'REPLACE_DEPOSIT':
      return !!can.moneyPlan && can.price && row.stepKind !== 'BEFORE_SHIPPING'
    case 'ACCEPT_SHORT':
      return !!can.moneyPlan && can.price && row.partPaid !== false
    case 'waive':
      return can.waive
  }
}

/** The act's words — the order page's own: the row's button or ⋯ line, and the door window's title while it reads. */
export function doorLabelOf(id: DoorActId): MoneyWord {
  if (id === 'record') return word('deposit.record')
  if (id === 'send') return word('moneyTab.plan.act.send')
  return word(`moneyTab.plan.act.${id}`)
}

/** What a row asks of the door: one act on one request (its order is the door's `open` target). */
export interface DoorAsk {
  readonly act: DoorActId
  readonly requestId: string
}

/** What the door opens: one of the order page's windows on the request, or the order's own Waive… window. */
export type DoorStart =
  | { readonly kind: 'dialog'; readonly dialog: Extract<MoneyDialog, { kind: 'depositPayment' | 'depositLink' | 'moneyPlan' }> }
  | { readonly kind: 'waive'; readonly target: WaiveTarget; readonly title: MoneyWord; readonly stepKind: 'DEPOSIT' | 'BEFORE_SHIPPING' }

/** The act on the order as read: held (the plan's words, in the order page's frame), or the window it opens. */
export type DoorRuling = { readonly held: MoneyWord; readonly start: null } | { readonly held: null; readonly start: DoorStart }

/**
 * The plan's own rule on the order AS READ (as the order's Payments section reads it: the settlement only with invoices.view): the
 * request's row, and the act among its acts. A closed or cancelled order: held. The request no longer a live row, or the act no longer
 * offered on it (paid, waived, replaced meanwhile; a right changed): "The plan changed meanwhile". An act held by its state: the plan's
 * own words ("Money is placed on it: undo the payment first."). Else the window it opens.
 */
export function doorRulingOf(input: { readonly ask: DoorAsk; readonly order: Order; readonly schedule: Schedule; readonly settlement: Settlement | null; readonly can: OrderAbilities; readonly stepCan: StepAbilities | null; readonly today: string }): DoorRuling {
  const { ask, order, schedule, can, stepCan, today } = input
  if (isFinal(order)) return { held: word('impact.STATE_final'), start: null }
  const settlement = can.viewInvoices ? input.settlement : null
  const plan = planOf({ order, schedule, settlement, can, stepCan, today, stillToPay: stillToPayOf(order, settlement) })
  const row = plan.rows.find((entry) => entry.request?.id === ask.requestId) ?? null
  const request = row?.request ?? null
  const act = row ? ([row.act, ...row.more].find((entry): entry is PlanAct => !!entry && entry.id === ask.act) ?? null) : null
  if (!row || !request || !act) return { held: word('moneyTab.refusal.MOVED'), start: null }
  if (act.held) return { held: act.held, start: null }
  return { held: null, start: startOf(ask.act, row, request) }
}

/** The window an act opens — as the order's plan row opens it (PlanRow.tsx `run`). */
function startOf(act: DoorActId, row: PlanRow, request: DepositRequest): DoorStart {
  switch (act) {
    case 'record':
      return { kind: 'dialog', dialog: { kind: 'depositPayment', requestId: request.id } }
    case 'send':
      return { kind: 'dialog', dialog: { kind: 'depositLink', requestId: request.id } }
    case 'MOVE_DUE':
    case 'REPLACE_DEPOSIT':
    case 'ACCEPT_SHORT':
      return { kind: 'dialog', dialog: { kind: 'moneyPlan', act, stepId: row.step?.id ?? null, requestId: request.id } }
    case 'waive':
      return {
        kind: 'waive',
        target: row.step ? { kind: 'step', id: row.step.id, version: row.step.version } : { kind: 'request', id: request.id, version: request.version },
        title: row.title,
        stepKind: row.kind === 'BEFORE_SHIPPING' ? 'BEFORE_SHIPPING' : 'DEPOSIT',
      }
  }
}

// ---- the door's window: its model and acts (the hook fills them, OrderMoneyWindow.tsx draws them) ----

/** The door's window as it stands: what is asked, the order and its plan as read, the plan's rule on them, the order's windows. */
export interface OrderMoneyDoorModel {
  readonly target: { readonly id: string; readonly number: string }
  readonly ask: DoorAsk
  /** The order as read; null while it reads, or when the read failed (`problem`). */
  readonly order: Order | null
  /** The order's read failed: its words (`orders` problem.read.*; an order out of the reader's reach answers 404, said neutrally). */
  readonly problem: string | null
  /** The payment plan's read (value null while it reads). */
  readonly schedule: Part<Schedule> | null
  /** The settlement's read (invoices.view); null without the right. */
  readonly settlement: Part<Settlement> | null
  /** The plan's rule on the order as FIRST read (model.ts doorRulingOf); null while it reads. A read after a write never rules again. */
  readonly ruling: DoorRuling | null
  /** What the order page's money windows read (a Pick of the record's model: rec/view/Dialogs.tsx MoneyDialogModel). */
  readonly dialogs: MoneyDialogModel
  /** The fresh authenticator code's dialog (the order page's own state: useStepUp). */
  readonly stepUp: StepUpState
}

export interface OrderMoneyDoorActions {
  readonly onClose: () => void
  /** A failed read: read the order and its plan again. */
  readonly onRetry: () => void
  /** The order page's money windows' acts — the record's own (useMoneyActs); a window's Cancel or Done closes the door. */
  readonly dialogs: MoneyDialogActions
  readonly onStepUpSubmit: (code: string) => void
  readonly onStepUpCancel: () => void
}

/** An act went: its order and act, and the order page's own words for it when it has some (else the host says its own). */
export interface OrderMoneyDoorDone {
  readonly id: string
  readonly number: string
  readonly act: DoorActId
  readonly words: Phrase | null
}
