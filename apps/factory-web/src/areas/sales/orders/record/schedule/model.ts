import type { Phrase } from '../../model'
import type { Milestone, Order } from '../../api'

/**
 * The schedule card's verbs, pure (B-W2a-80; B-W2a-F2's note): a before-shipping step without its request → "Open for
 * payment" (a day picker when the step has none); a deposit or before-shipping step with its request → "Invoice this step"
 * (its TD02 of what is paid and not invoiced). Each held with its reason; words in the `orders` catalogue (schedule.verbs.*).
 */

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

export interface StepAbilities {
  /** orders.manage: open a step for payment. */
  manageOrders: boolean
  /** invoices.manage: invoice a step (a TD02 draft). */
  manageInvoices: boolean
}

export const stepAbilitiesOf = (permissions: readonly string[]): StepAbilities => {
  const held = new Set(permissions)
  return { manageOrders: held.has('orders.manage'), manageInvoices: held.has('invoices.manage') }
}

const OPEN_STATES: readonly Order['status'][] = ['CONFIRMED', 'IN_PRODUCTION', 'READY']

export type StepVerb = { kind: 'open'; held: Phrase | null; needsDay: boolean } | { kind: 'invoice'; held: Phrase | null }

/** The verbs a step offers now, each with why it waits (or null). */
export function stepVerbs(step: Pick<Milestone, 'kind' | 'status' | 'depositRequestId' | 'dueDate'>, order: Pick<Order, 'status'>, can: StepAbilities): StepVerb[] {
  if (step.status !== 'OPEN' && step.status !== 'PAID') return []
  if (step.kind === 'BEFORE_SHIPPING' && !step.depositRequestId) {
    if (step.status !== 'OPEN') return []
    const held = !can.manageOrders ? phrase('schedule.verbs.held.noManage') : !OPEN_STATES.includes(order.status) ? phrase('schedule.verbs.held.goodsLeft') : null
    return [{ kind: 'open', held, needsDay: step.dueDate === null }]
  }
  if ((step.kind === 'DEPOSIT' || step.kind === 'BEFORE_SHIPPING') && step.depositRequestId) {
    return [{ kind: 'invoice', held: can.manageInvoices ? null : phrase('schedule.verbs.held.noInvoice') }]
  }
  return []
}

/** The day the request falls due: today or later (YYYY-MM-DD), or its problem. */
export const dayProblem = (day: string, today: string): string | null => (!/^\d{4}-\d{2}-\d{2}$/.test(day) ? 'schedule.verbs.problem.day' : day < today ? 'schedule.verbs.problem.past' : null)
