import { CANCEL_STATUSES, OPEN_STATUSES } from '@nexus/factory-domain/sales/orders/orders'
import type { RejectReason } from '../../../../home/approvals/api'
import { ORDER_STATUSES, type CancelCheck, type Order, type OrderRow, type OrderStatus } from '../../api'
import { bannerYesOf, yesDoorOf, type YesDoor } from '../../depth/model'
import type { StepUpState } from '../../hooks'
import { cancelHeld, closeHeld, readyHeld, type OrderAbilities, type Phrase, type RowView } from '../../model'
import type { Part, YesActions } from '../../record/record-model'
import type { ExtraOutcome } from '@nexus/factory-domain/order-apply/rules'

/**
 * F-CP-108 / F-CP-109 (customer page plan C2b, D8, K2; 10-customer-page §3): the order page's OWN commands on the Orders sheet — the
 * row ⋯ "Next steps" and the bar's Mark {count} ready… · Close {count}… · Confirm {count}…, on every host of the ONE sheet (Sales ›
 * Orders and the customer page's Work tab). Rule 46 stays: no inline status editor, no free status, a system move (In production,
 * Partly shipped, Shipped, Delivered) is never offered; each command is the order page's (A14's state → action map: nextStep,
 * readyHeld, closeHeld, cancelHeld; F-OP-101's yes), its dialog the order page's own (so/record/view, mounted, never copied), its
 * write the order page's route with the order's version and an Idempotency-Key. The server checks the order's customer on every
 * read and write (an order out of reach answers 404: said neutrally, counted and never named in a list). No amount is drawn here:
 * the close of an order that is not settled says "not settled" in words only (the money wall).
 *
 * Pure rules; the containers (use-order-command-door.ts, use-order-command-many.ts) keep the state, the views draw it.
 */

/** Words of the window: a key of the `orders` catalogue, or (`sheet`) of `orders-sheet`; `states` fills `{state}` with status words. */
export interface Words {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
  readonly sheet?: true
  readonly states?: readonly OrderStatus[]
}

const orders = (key: string, params?: Record<string, string | number>): Words => (params ? { key, params } : { key })
const sheet = (key: string, params?: Record<string, string | number>): Words => (params ? { key, params, sheet: true } : { key, sheet: true })

type Translate = (key: string, params?: Record<string, string | number>) => string

/** Status words inside a sentence ("None of the 2 is waiting for a yes."): lower case, joined by "or" in the page's language. */
export function statesText(states: readonly OrderStatus[], t: Translate, locale: string): string {
  const names = states.map((status) => t(`status.${status}`).toLocaleLowerCase(locale))
  try {
    return new Intl.ListFormat(locale, { type: 'disjunction' }).format(names)
  } catch {
    return names.join(' / ')
  }
}

/** Words as the view says them: `orders` (t) or `orders-sheet` (s), `{state}` filled with the status words. */
export function wordsText(words: Words, t: Translate, s: Translate, locale: string): string {
  const params: Record<string, string | number> = { ...(words.params ?? {}) }
  if (words.states) params.state = statesText(words.states, t, locale)
  return (words.sheet ? s : t)(words.key, params)
}

// ---- F-CP-108: the row ⋯ "Next steps" ---------------------------------------------------------------------------------------------

/** The row's commands, in the menu's order (Cancel order… last, after a rule, in the danger tone). */
export const ROW_COMMANDS = ['confirm', 'make', 'ready', 'close', 'cancel'] as const
export type RowCommand = (typeof ROW_COMMANDS)[number]
/** The commands that open a window on this page (Make work orders is today's link to Production's New work order). */
export type WindowCommand = Exclude<RowCommand, 'make'>

export interface RowStep {
  readonly command: RowCommand
  /** Why it waits, from the row's own facts (the `orders` catalogue's held words); null: it opens. */
  readonly held: Words | null
}

/** A shipped (or delivered) order closes (F-SA-201: the order page's CLOSE_FROM). */
const CLOSE_STATUSES: readonly OrderStatus[] = Object.freeze(['SHIPPED', 'DELIVERED'])

/**
 * The row ⋯ "Next steps" by the row's status — A14's map read from the row's facts (the parity test runs A14's own rules on a full order
 * of each status and finds the same commands and holds):
 *   Waiting for a yes → Confirm or refuse… (who decides is said in the window: the order read's open yes, F-OP-101)
 *   Confirmed         → Make work orders (the production manager's right; held while production waits for the deposit) · Cancel order…
 *   In production     → Mark ready… · Cancel order…
 *   Ready             → Cancel order…
 *   Shipped, Delivered → Close order… (held without the right to manage or close orders; "not settled" is the window's, from the read)
 * Partly shipped, Closed, Cancelled: nothing (a system move or a final state). Each held item keeps its words (held-not-disabled).
 */
export function rowStepsOf(row: Pick<OrderRow, 'status' | 'deposit'>, can: OrderAbilities): RowStep[] {
  const steps: RowStep[] = []
  if (row.status === 'PENDING_APPROVAL') steps.push({ command: 'confirm', held: null })
  if (row.status === 'CONFIRMED') steps.push({ command: 'make', held: makeHeldOfRow(row, can) })
  if (row.status === 'IN_PRODUCTION') steps.push({ command: 'ready', held: can.manage ? null : orders('held.noManage') })
  if (CLOSE_STATUSES.includes(row.status)) steps.push({ command: 'close', held: can.manage || can.close ? null : orders('held.noClose') })
  if (CANCEL_STATUSES.includes(row.status)) steps.push({ command: 'cancel', held: can.manage ? null : orders('held.noManage') })
  return steps
}

/** Make work orders from the row: the production manager's right first, then the deposit gate (the row's deposit is the gate's state). */
function makeHeldOfRow(row: Pick<OrderRow, 'deposit'>, can: OrderAbilities): Words | null {
  if (!can.makeWorkOrders) return orders('held.noWorkOrders')
  if (row.deposit.state === 'OPEN') return orders('held.deposit', { date: row.deposit.dueDate ?? '' })
  if (row.deposit.state === 'MISSING') return orders('held.depositMissing')
  return null
}

/** The order's own yes (F-OP-101's door): the decide door when this reader decides one, else the first (selfAsked / whoDecides). */
export function orderYesDoor(order: Pick<Order, 'openApprovals'>, busy = false): YesDoor | null {
  const doors = bannerYesOf(order.openApprovals)
    .filter((task) => task.kind === 'SALES_ORDER')
    .map((task) => yesDoorOf(task, busy))
  return doors.find((door) => door.kind === 'decide') ?? doors[0] ?? null
}

/** Why Confirm waits on the order as read, or null: not waiting for a yes, nobody asked yet, the asker's own, another's to decide. */
export function confirmHeldOf(order: Pick<Order, 'status' | 'openApprovals'>): Words | null {
  if (order.status !== 'PENDING_APPROVAL') return sheet('commands.confirmState')
  const door = orderYesDoor(order)
  if (!door) return sheet('commands.noYes')
  if (door.kind === 'selfAsked') return orders('approval.selfAsked')
  if (door.kind === 'whoDecides') return orders('approval.whoDecides', { who: door.who })
  return door.confirmHeld
}

/**
 * Why the window's command waits on the order as READ (the row may be older than the order: someone moved it meanwhile), or null —
 * A14's own rules: readyHeld, closeHeld, cancelHeld, and the yes's door. Said in the window with the order page's words.
 */
export function windowHeldOf(command: WindowCommand, order: Order, can: OrderAbilities): Words | null {
  if (command === 'ready') return readyHeld(order, can)
  if (command === 'close') return closeHeld(order, can)
  if (command === 'cancel') return cancelHeld(order, can)
  return order.status === 'PENDING_APPROVAL' ? null : sheet('commands.confirmState')
}

/**
 * Whether a row whose order moved on still belongs to the view on screen (the row stays in place either way, greyed when it no longer
 * belongs, until "N updates · Show"): every order — yes; Open orders — the open states; a state's view — that state; the server's own
 * views (late, deposit, waiting for the customer, shipped not invoiced) — a closed or cancelled order leaves them, the rest the next read says.
 */
export function stillInView(rows: RowView, status: OrderStatus): boolean {
  if (rows === 'all') return true
  if (rows === 'open') return OPEN_STATUSES.includes(status)
  if ((ORDER_STATUSES as readonly string[]).includes(rows)) return rows === status
  return status !== 'CLOSED' && status !== 'CANCELLED'
}

/** The toast after a command ("SO-0142 marked ready"): orders-sheet `commands.done.*`. */
export const doneWords = (command: WindowCommand | 'refuse', number: string): Words => sheet(`commands.done.${command}`, { number })

/** The window's title before the order is read (and when it cannot be): the order page's dialog titles; the yes: our own. */
export function windowTitleOf(command: WindowCommand, number: string): Words {
  if (command === 'ready') return orders('ready.title', { number })
  if (command === 'close') return orders('close.title', { number })
  if (command === 'cancel') return orders('cancel.title', { number })
  return sheet('commands.yesTitle', { number })
}

/** The window's go words (the held window keeps the order page's button words). */
export function windowGoOf(command: WindowCommand): Words {
  if (command === 'ready') return orders('ready.go')
  if (command === 'close') return orders('close.go')
  if (command === 'cancel') return orders('cancel.go')
  return orders('approval.confirm')
}

/** The ONE command window of the sheet (use-order-command-door keeps it; view/OrderCommandWindow draws it). */
export interface OrderCommandModel {
  readonly command: WindowCommand
  /** The row it was opened on (the number names the window while the order is read). */
  readonly target: { readonly id: string; readonly number: string }
  /** The order read once on opening (GET /sales/orders/:id: the server's wall); null while read or when the read failed. */
  readonly order: Order | null
  /** The read's problem (an `orders` key: `problem.read.*`; 404 is neutral words); null: none. */
  readonly problem: string | null
  readonly busy: boolean
  /** A refused write, said inside the dialog (the order page's words); what was typed stays. */
  readonly dialogProblem: Phrase | null
  /** Cancel order…: the impact check (read with the order); null otherwise. */
  readonly cancelCheck: Part<CancelCheck> | null
  /** Confirm or refuse…: Refuse… is open on this yes. */
  readonly refuse: { readonly taskId: string } | null
  /** The reasons a no names, while Refuse… is open. */
  readonly refuseReasons: Part<RejectReason[]> | null
  /** The yes's fresh authenticator code (when its rule asks one). */
  readonly stepUp: StepUpState
  readonly can: OrderAbilities
  readonly prefix: string
}

export interface OrderCommandActions {
  readonly onClose?: () => void
  /** Read the order again (Try again). */
  readonly onRetry?: () => void
  readonly onReady?: (reason: string) => void
  readonly onCloseOrder?: (reason: string | null) => void
  readonly onCancel?: (reason: string, typed: string, extraOutcome?: ExtraOutcome | null) => void
  readonly onRetryCheck?: () => void
  /** The yes (F-OP-101's acts: Confirm, Refuse…, the no's reasons). */
  readonly yes?: YesActions
  /** Refuse… closed: back to the yes's window. */
  readonly onRefuseBack?: () => void
  readonly onStepUpSubmit?: (code: string) => void
  readonly onStepUpCancel?: () => void
}
