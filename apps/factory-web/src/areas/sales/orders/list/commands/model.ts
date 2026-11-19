import { CANCEL_STATUSES, OPEN_STATUSES } from '@nexus/factory-domain/sales/orders/orders'
import { isApiError } from '../../../../../lib/api/errors' // F-CP-109
import type { RejectReason } from '../../../../home/approvals/api'
import { ORDER_STATUSES, type CancelCheck, type Order, type OrderRow, type OrderStatus } from '../../api'
import { bannerYesOf, yesDoorOf, type YesDoor } from '../../depth/model'
import type { StepUpState } from '../../hooks'
import { cancelHeld, closeHeld, readyHeld, type OrderAbilities, type Phrase, type RowView } from '../../model'
import { closeNeedsReason, writeProblem } from '../../model' // F-CP-109
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

// ---- F-CP-109: Mark {count} ready… · Close {count}… · Confirm {count}… on the bar ---------------------------------------------------

export const MANY_COMMANDS = ['ready', 'close', 'confirm'] as const
export type ManyCommand = (typeof MANY_COMMANDS)[number]
/** At most this many orders in one bulk command (lead pick, approved: ≤ 50; Confirm N with ONE code). Cancel stays one at a time. */
export const MANY_MAX = 50
/** Reads of the ticked orders run this many at a time. */
export const MANY_READ_AT_ONCE = 5
/** The states each bulk command takes. */
export const MANY_STATES: Readonly<Record<ManyCommand, readonly OrderStatus[]>> = Object.freeze({ ready: ['IN_PRODUCTION'], close: CLOSE_STATUSES, confirm: ['PENDING_APPROVAL'] })

/**
 * The bar's bulk commands for this reader: Mark N ready (held in words without orders.manage), Close N with orders.manage or
 * orders.close, Confirm N for who decides yeses (approvals.decide). Never Cancel: it is one order at a time.
 */
export function manyShown(can: OrderAbilities, decide: boolean): ManyCommand[] {
  return MANY_COMMANDS.filter((command) => (command === 'close' ? can.manage || can.close : command === 'confirm' ? decide : true))
}

/**
 * Why a bulk button waits before the click, or null: more than 50 ticked; the right (Mark ready: orders.manage; Close: manage or close);
 * none of the ticked orders is in the command's state ("None of the 2 is waiting for a yes.").
 */
export function manyHeld(command: ManyCommand, rows: readonly Pick<OrderRow, 'status'>[], can: OrderAbilities): Words | null {
  if (rows.length === 0) return null
  if (rows.length > MANY_MAX) return sheet('bulk.tooMany', { max: MANY_MAX })
  if (command === 'ready' && !can.manage) return orders('held.noManage')
  if (command === 'close' && !can.manage && !can.close) return orders('held.noClose')
  if (!rows.some((row) => MANY_STATES[command].includes(row.status))) return { key: 'bulk.noneInState', params: { count: rows.length }, sheet: true, states: MANY_STATES[command] }
  return null
}

/** The bar's button words: "Mark {count} ready…" (orders-sheet `bulk.<command>`). */
export const manyLabel = (command: ManyCommand, count: number): Words => sheet(`bulk.${command}`, { count })

/** A ticked order as the window names it: the office number and the customer's PO when it gave one. */
export interface ManyTarget {
  readonly id: string
  readonly number: string
  readonly customerRef: string | null
}
export const manyTargetsOf = (rows: readonly Pick<OrderRow, 'id' | 'number' | 'customerRef'>[]): ManyTarget[] => rows.map((row) => ({ id: row.id, number: row.number, customerRef: row.customerRef }))
export const manyTargetLabel = (target: Pick<ManyTarget, 'number' | 'customerRef'>): string => (target.customerRef ? `${target.number} (${target.customerRef})` : target.number)

/** One ticked order's read: reading, read (the order), out of reach (404 / 403: counted, never named), or failed with why. */
export type ManyRead = { readonly state: 'reading' } | { readonly state: 'ready'; readonly order: Order } | { readonly state: 'gone' } | { readonly state: 'failed'; readonly problem: string }

/** How a read failed: out of reach (the brand wall's neutral answer) or a fault said in words. */
export function manyReadOf(error: unknown): Extract<ManyRead, { state: 'gone' | 'failed' }> {
  if (isApiError(error) && (error.kind === 'not_found' || error.kind === 'forbidden')) return { state: 'gone' }
  const kind = isApiError(error) ? error.kind : null
  return { state: 'failed', problem: kind && ['signed_out', 'unavailable', 'rate_limited'].includes(kind) ? `problem.read.${kind}` : 'problem.read.internal' }
}

/** A line of the preview: the order, whether it runs, why not (beside it), and what it adds ("Not settled", words only). */
export interface ManyLine {
  readonly target: ManyTarget
  readonly order: Order | null
  readonly runs: boolean
  readonly why: Words | null
  readonly note: Words | null
}

/** Confirm N: the order's own yes this reader decides (its task: id, version, whether its rule asks a fresh code); null: none. */
export function yesTaskOf(order: Pick<Order, 'openApprovals'>): YesDoor['task'] | null {
  const door = orderYesDoor(order)
  return door?.kind === 'decide' ? door.task : null
}

/** A14's rule of the bulk command on one order as read (the same rules the row and the order page use). */
export function manyRuleOf(command: ManyCommand, order: Order, can: OrderAbilities): Words | null {
  if (command === 'ready') return readyHeld(order, can)
  if (command === 'close') return closeHeld(order, can)
  return confirmHeldOf(order)
}

/**
 * The preview "Runs on 6 · Not on 2: why is beside each": each ticked order by number with its held words beside it, those still
 * read, and how many are out of reach (counted, never named). A Close that runs on an order not settled says so in words (no amount).
 */
export function manyPreview(command: ManyCommand, targets: readonly ManyTarget[], reads: Readonly<Record<string, ManyRead>>, can: OrderAbilities): { runs: ManyLine[]; notOn: ManyLine[]; reading: number; gone: number } {
  const runs: ManyLine[] = []
  const notOn: ManyLine[] = []
  let reading = 0
  let gone = 0
  for (const target of targets) {
    const read = reads[target.id] ?? { state: 'reading' }
    if (read.state === 'reading') reading += 1
    else if (read.state === 'gone') gone += 1
    else if (read.state === 'failed') notOn.push({ target, order: null, runs: false, why: orders(read.problem), note: null })
    else {
      const why = manyRuleOf(command, read.order, can)
      const note = command === 'close' && !why && closeNeedsReason(read.order) ? orders('close.notSettled') : null
      ;(why ? notOn : runs).push({ target, order: read.order, runs: !why, why, note })
    }
  }
  return { runs, notOn, reading, gone }
}

/** The ONE reason, asked when a runnable order needs one: Mark ready always (the order page's rule); Close when one is not settled. */
export function manyNeedsReason(command: ManyCommand, runs: readonly Pick<ManyLine, 'order'>[]): boolean {
  if (runs.length === 0 || command === 'confirm') return false
  if (command === 'ready') return true
  return runs.some((line) => !!line.order && closeNeedsReason(line.order))
}

/** Why the window's go waits, or null: a write runs, orders still read, it runs on none, the reason is missing. */
export function manyGoHeld(command: ManyCommand, preview: Pick<ReturnType<typeof manyPreview>, 'runs' | 'reading'>, reason: string, busy: boolean): Words | null {
  if (busy) return orders('held.busy')
  if (preview.reading > 0) return sheet('commands.many.stillReading')
  if (preview.runs.length === 0) return sheet('commands.many.nothing')
  if (manyNeedsReason(command, preview.runs) && reason.trim() === '') return orders(command === 'ready' ? 'ready.reasonNeeded' : 'close.reasonNeeded')
  return null
}

/** One order's answer: done; not done with why (beside it); the code ran out (run the rest again); out of reach (counted, never named). */
export type ManyResult = { readonly state: 'done' } | { readonly state: 'notDone'; readonly why: Words } | { readonly state: 'codeExpired' } | { readonly state: 'gone' }

/** What a refused write means for the result list (the order page's words; a moved order: "SO-0150 changed meanwhile: open it and try again."). */
export function manyOutcomeOf(error: unknown, number: string): Exclude<ManyResult, { state: 'done' }> {
  if (isApiError(error) && error.kind === 'step_up') return { state: 'codeExpired' }
  if (isApiError(error) && (error.kind === 'not_found' || error.kind === 'forbidden')) return { state: 'gone' }
  const words = writeProblem(error)
  if (words.key === 'problem.write.moved' || words.key === 'problem.write.state' || words.key === 'approval.refused.STALE' || words.key === 'approval.refused.NOT_PENDING') return { state: 'notDone', why: sheet('commands.many.stale', { number }) }
  return { state: 'notDone', why: words.params ? orders(words.key, words.params) : orders(words.key) }
}

/**
 * One run: the orders that run, ONE AT A TIME (never two at once), each with its own version and Idempotency-Key (the call's); a failure
 * never stops the rest — an expired code too (each yes that needed it says "run the rest again"). Answers how many were done.
 */
export async function runMany(lines: readonly ManyLine[], one: (line: ManyLine) => Promise<void>, onResult: (id: string, result: ManyResult, done: number) => void): Promise<number> {
  let done = 0
  for (const [index, line] of lines.entries()) {
    let result: ManyResult
    try {
      await one(line)
      result = { state: 'done' }
      done += 1
    } catch (error) {
      result = manyOutcomeOf(error, line.target.number)
    }
    onResult(line.target.id, result, index + 1)
  }
  return done
}

/** The result: "5 done · 1 not done", each named order's line (done, or not with why), and how many are out of reach (counted only). */
export function manyReceipt(targets: readonly ManyTarget[], results: Readonly<Record<string, ManyResult>>): { done: number; left: number; gone: number; again: ManyTarget[]; lines: Array<{ target: ManyTarget; result: ManyResult }> } {
  const lines = targets.flatMap((target) => {
    const result = results[target.id]
    return result && result.state !== 'gone' ? [{ target, result }] : []
  })
  const gone = targets.filter((target) => results[target.id]?.state === 'gone').length
  const done = lines.filter((line) => line.result.state === 'done').length
  // Run the rest again: the named orders not done (read again first: a fresh version, A14's rules again; a fresh code for Confirm N).
  const again = lines.filter((line) => line.result.state !== 'done').map((line) => line.target)
  return { done, left: lines.length - done, gone, again, lines }
}

/** The bulk window (use-order-command-many keeps it; view/OrderCommandManyDialog draws it). */
export interface OrderCommandManyModel {
  readonly command: ManyCommand
  readonly targets: readonly ManyTarget[]
  readonly reads: Readonly<Record<string, ManyRead>>
  readonly reason: string
  readonly phase: 'preview' | 'running' | 'done'
  /** While it runs: how many of how many are done. */
  readonly progress: { readonly done: number; readonly count: number } | null
  readonly results: Readonly<Record<string, ManyResult>>
  readonly stepUp: StepUpState
  readonly can: OrderAbilities
}

export interface OrderCommandManyActions {
  readonly onReason?: (reason: string) => void
  readonly onRun?: () => void
  /** Run the rest again: the named orders not done, read again first. */
  readonly onAgain?: () => void
  readonly onClose?: () => void
  readonly onStepUpSubmit?: (code: string) => void
  readonly onStepUpCancel?: () => void
}
