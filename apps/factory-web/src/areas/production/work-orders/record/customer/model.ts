import { URGENCY_LOCK_REASON_MAX, URGENCY_OFFICE_BATCH_MAX } from '@nexus/factory-domain/production-brand/urgency'
import { isApiError } from '../../../../../lib/api/errors'
import type { ProductionLimits } from '../../../../admin/users/partners/api'
import { LIMITS_ANCHOR, seesNow } from '../../../../sales/customers/portal/limits/model'
import type { WorkOrder } from '../../../_shared/api'
import type { Phrase } from '../../../_shared/model'
import type { OrderThreadChoice, ThreadPick } from '../order-files/model'
import type { AskedApproval, CustomerIssue, CustomerIssues, CustomerRequest, CustomerUrgency, UrgencyAnswer, UrgencyOrder } from './api'

/**
 * F-PR-05b — the work order record's Customer card, without a screen (production plan §3 "Set a customer's order back to Regular, lock,
 * unlock: production.brand.override, step-up, no second person", §5 "Customer card (its requests, customer urgency with Set to
 * regular / Lock, supervisor)"; lead picks L18, L21, L24, L27; review fixes R-41, R-42, R-45, R-46; 06-tree A.4 O-WO-brand; 17-web-r2
 * §1.7). ONE card per customer of the work order (one, or — made before the one-customer rule — one block per customer, PW-07):
 *
 *   requests       what the customer asked on these orders (kind · state · asked · our answer); a request that waits on us is
 *                  answered in Home › Approvals ("Answer in Approvals" opens it there: one place to answer, L11)
 *   approvals      what we asked the customer to approve on these orders (kind · state · due or answered)
 *   urgency        per order: "Urgent · 2nd of their 3", "Urgent – asked" (a RUSH request that waits), "Regular", "Set to regular
 *                  by us" + the reason the customer reads; who set it and when (names: the office's own card). Set to regular…, Lock
 *                  and Unlock, each with a reason the customer reads (Unlock: none), production.brand.override with a fresh code and
 *                  no second person (it is our own plan). While the customer's urgent orders are off, the marks are kept and count for
 *                  nothing (the API's words say so, R-46).
 *   supervisor     the band's fact (F-PR-21) with Change…
 *   problems       the open ones on this work order or its orders (reported by the customer or by us): "Waiting on us since 16 Nov",
 *                  "No reply sent yet" when its task was ticked without a reply (R-42), how far it went up, Open thread
 *   limits         what the customer sees (its level) and may do (urgent orders on, at most n), a door to the limits card
 *   sees           what the customer sees of this order (each shared section) and Open as <customer> (the band's preview)
 *
 * The wall (PW-07, PW-08, PW-10, PW-14, PW-17): only the work order's own customers and orders are read and written; an answer row of
 * another order is dropped here too (`ownRows`); a refused row is named only when it is one of ours, the others are counted.
 * Words: catalogue `production` (`customerCard.*`); the level and section words are the limits card's (`portal-access`).
 */

export const CARD_LIMITS = Object.freeze({ reason: URGENCY_LOCK_REASON_MAX, orders: URGENCY_OFFICE_BATCH_MAX })

/** A part the card reads (null value while it is read; a problem when it failed: never drawn as empty). */
export interface CardPart<T> {
  readonly value: T | null
  readonly problem: string | null
}

// ---- whose card ---------------------------------------------------------------------------------------------------------------

export interface CardOrder {
  readonly id: string
  readonly number: string
  readonly customerRef: string | null
}

export interface CardCustomer {
  readonly partyId: string
  readonly name: string
  readonly orders: readonly CardOrder[]
}

/**
 * The customers the card shows, each with its own orders of this work order, in the order they come: one for a work order of one
 * customer, one block per customer for one made before the rule (PW-07: rows of that customer only), none for one of no order.
 */
export function cardCustomersOf(workOrder: Pick<WorkOrder, 'orders'>): CardCustomer[] {
  const byParty = new Map<string, { partyId: string; name: string; orders: CardOrder[] }>()
  for (const order of workOrder.orders) {
    const entry = byParty.get(order.partyId) ?? { partyId: order.partyId, name: order.partyName, orders: [] }
    if (!entry.orders.some((seen) => seen.id === order.id)) entry.orders.push({ id: order.id, number: order.number, customerRef: order.customerRef ?? null })
    byParty.set(order.partyId, entry)
  }
  return [...byParty.values()]
}

/** Rows of this customer's own orders only (an answer never shows another order, PW-07). */
export const ownRows = <T extends { readonly orderId: string }>(rows: readonly T[], customer: Pick<CardCustomer, 'orders'>): T[] => rows.filter((row) => customer.orders.some((order) => order.id === row.orderId))

// ---- requests -------------------------------------------------------------------------------------------------------------------

/** The requests of the card: those that wait (on us first, then on the customer), then the last three answered, newest first. */
export function requestsOf(rows: readonly CustomerRequest[]): { readonly waiting: CustomerRequest[]; readonly answered: CustomerRequest[] } {
  const waiting = rows.filter((row) => row.status === 'OPEN' || row.status === 'COUNTERED').sort((a, b) => (a.waitingOn === b.waitingOn ? a.askedAt.localeCompare(b.askedAt) : a.waitingOn === 'US' ? -1 : 1))
  const answered = rows
    .filter((row) => row.status !== 'OPEN' && row.status !== 'COUNTERED')
    .sort((a, b) => (b.answeredAt ?? b.askedAt).localeCompare(a.answeredAt ?? a.askedAt))
    .slice(0, 3)
  return { waiting, answered }
}

/** Home › Approvals with the request open (its review window: the one place a customer's request is answered, L11). */
export const answerHref = (prefix: string, requestId: string): string => `${prefix}/home/approvals?open=${encodeURIComponent(requestId)}`

/** How long something waits, in the card's words: "4 h", "2 d" (under an hour: "just now"). */
export function ageOf(since: string, now: number): Phrase {
  const hours = Math.max(0, Math.floor((now - new Date(since).getTime()) / 3_600_000))
  if (hours < 1) return { key: 'customerCard.age.now' }
  if (hours < 48) return { key: 'customerCard.age.hours', params: { count: hours } }
  return { key: 'customerCard.age.days', params: { count: Math.floor(hours / 24) } }
}

// ---- approvals asked of the customer --------------------------------------------------------------------------------------------

/** The approvals of the card: the open ones first (soonest due), then the last three decided, newest first. */
export function approvalsOf(rows: readonly AskedApproval[]): { readonly open: AskedApproval[]; readonly decided: AskedApproval[] } {
  const seen = new Set<string>()
  const once = rows.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)))
  return {
    open: once.filter((row) => row.status === 'OPEN').sort((a, b) => a.dueAt.localeCompare(b.dueAt)),
    decided: once
      .filter((row) => row.status !== 'OPEN')
      .sort((a, b) => (b.answer?.at ?? b.createdAt).localeCompare(a.answer?.at ?? a.createdAt))
      .slice(0, 3),
  }
}

// ---- customer urgency -----------------------------------------------------------------------------------------------------------

/** One of the work order's orders as its customer's urgency reads it. */
export type UrgencyState = 'URGENT' | 'URGENT_DORMANT' | 'ASKED' | 'SET_BACK' | 'REGULAR'

export interface UrgencyLine {
  readonly order: UrgencyOrder
  readonly companyId: string
  readonly state: UrgencyState
  /** Its place in the customer's own Urgent list and the customer's quota ("2nd of their 3"); never a place in our plan. */
  readonly rank: number | null
  readonly max: number
  /** production.brand.override over its company and customer (the API's). */
  readonly mayOverride: boolean
}

/**
 * The work order's orders in the customer's urgency read (only its own: PW-07): Urgent (counted, with its rank), Urgent but dormant
 * (the switch is off: kept, counts for nothing), Urgent – asked (a RUSH request that waits on us), Set to regular by us (by us, or
 * locked), Regular. An order the read does not list (not open, not kept yet) has no line.
 */
export function urgencyLinesOf(read: CustomerUrgency | null, customer: Pick<CardCustomer, 'orders'>, waitingRush: ReadonlySet<string>): UrgencyLine[] {
  if (!read) return []
  const lines: UrgencyLine[] = []
  for (const company of read.companies) {
    for (const order of company.orders) {
      if (!customer.orders.some((own) => own.id === order.id) || lines.some((line) => line.order.id === order.id)) continue
      const state: UrgencyState =
        order.urgency === 'URGENT' ? (order.counted ? 'URGENT' : 'URGENT_DORMANT') : waitingRush.has(order.id) ? 'ASKED' : order.setBy === 'FACTORY' || order.locked ? 'SET_BACK' : 'REGULAR'
      lines.push({ order, companyId: company.company.id, state, rank: order.urgency === 'URGENT' ? order.urgentRank : null, max: company.use.max, mayOverride: company.mayOverride })
    }
  }
  const index = (id: string) => customer.orders.findIndex((own) => own.id === id)
  return lines.sort((a, b) => index(a.order.id) - index(b.order.id))
}

/** The orders with a RUSH request that waits ("Urgent – asked"). */
export const waitingRushOf = (requests: readonly CustomerRequest[]): ReadonlySet<string> => new Set(requests.filter((row) => row.kind === 'RUSH' && (row.status === 'OPEN' || row.status === 'COUNTERED')).map((row) => row.orderId))

/** "2nd", "3rd" (en) or "2º" (it): the customer's own order inside Urgent. */
export function ordinalOf(rank: number, locale: string): string {
  if (locale === 'it') return `${rank}º`
  const tens = rank % 100
  const suffix = tens >= 11 && tens <= 13 ? 'th' : rank % 10 === 1 ? 'st' : rank % 10 === 2 ? 'nd' : rank % 10 === 3 ? 'rd' : 'th'
  return `${rank}${suffix}`
}

/** The line's words ("Urgent · 2nd of their 3", "Urgent – asked", "Set to regular by us: …", "Regular"). */
export function urgencyWordsOf(line: UrgencyLine, locale: string): Phrase {
  if (line.state === 'URGENT') return line.rank !== null ? { key: 'customerCard.urgency.urgentRank', params: { rank: ordinalOf(line.rank, locale), max: line.max } } : { key: 'customerCard.urgency.urgent' }
  if (line.state === 'URGENT_DORMANT') return { key: 'customerCard.urgency.dormant' }
  if (line.state === 'ASKED') return { key: 'customerCard.urgency.asked' }
  if (line.state === 'SET_BACK') return line.order.locked && line.order.lockReason ? { key: 'customerCard.urgency.setBackWhy', params: { reason: line.order.lockReason } } : { key: 'customerCard.urgency.setBack' }
  return { key: 'customerCard.urgency.regular' }
}

/** Who set the mark and when ("set by Alex Demo, 12 Nov"), who locked it ("locked by …"): names on the office's own card only. */
export function urgencyByOf(line: UrgencyLine): { readonly set: { readonly name: string | null; readonly at: string; readonly byUs: boolean } | null; readonly lock: { readonly name: string | null; readonly at: string | null } | null } {
  const order = line.order
  return {
    set: order.setAt ? { name: order.setByPerson?.name ?? null, at: order.setAt, byUs: order.setBy === 'FACTORY' } : null,
    lock: order.locked ? { name: order.lockedBy?.name ?? null, at: order.lockedAt } : null,
  }
}

/** The urgency acts the office has: Set to regular… (an Urgent order), Lock (not locked), Unlock (locked). */
export type UrgencyAct = 'regular' | 'lock' | 'unlock'

/** The acts a line offers, each with why it waits (null: it may): production.brand.override over its company and customer. */
export function urgencyActsOf(line: UrgencyLine, busy: boolean): ReadonlyArray<{ readonly act: UrgencyAct; readonly held: Phrase | null }> {
  const held: Phrase | null = !line.mayOverride ? { key: 'customerCard.urgency.held.noOverride' } : busy ? { key: 'held.busy' } : null
  const acts: UrgencyAct[] = []
  if (line.order.urgency === 'URGENT') acts.push('regular')
  acts.push(line.order.locked ? 'unlock' : 'lock')
  return acts.map((act) => ({ act, held }))
}

export interface UrgencyDialog {
  readonly act: UrgencyAct
  readonly partyId: string
  readonly orders: readonly CardOrder[]
}

/** Why the dialog's Send waits: a reason the customer reads for Set to regular and Lock (one line, at most 500); busy. */
export function urgencyDialogHeld(act: UrgencyAct, reason: string, busy: boolean): Phrase | null {
  if (act !== 'unlock') {
    if (reason.trim() === '') return { key: 'customerCard.urgency.held.reason' }
    if (/[\r\n]/.test(reason)) return { key: 'customerCard.urgency.held.line' }
    if (reason.trim().length > CARD_LIMITS.reason) return { key: 'customerCard.urgency.held.long', params: { count: CARD_LIMITS.reason } }
  }
  if (busy) return { key: 'held.busy' }
  return null
}

/** What a set-back, lock or unlock did: per order done, or why not (the API's words, only for this card's own orders); others counted. */
export interface UrgencyOutcome {
  readonly act: UrgencyAct
  readonly done: readonly string[]
  readonly notDone: ReadonlyArray<{ readonly number: string; readonly words: { readonly it: string; readonly en: string } | null }>
  /** Rows the reader does not reach, or not of this card: counted, never named (PW-10). */
  readonly notShown: number
}

export function urgencyOutcomeOf(act: UrgencyAct, answer: UrgencyAnswer, asked: readonly CardOrder[]): UrgencyOutcome {
  const own = (orderId: string) => asked.some((order) => order.id === orderId)
  const rows = answer.results.filter((row) => own(row.orderId))
  return {
    act,
    done: rows.filter((row) => row.done).map((row) => row.number),
    notDone: rows.filter((row) => !row.done).map((row) => ({ number: row.number, words: row.words })),
    notShown: answer.notFound + (answer.results.length - rows.length),
  }
}

/** A refused write in the card's words (a 409 carries each row's words: the card reads again). */
export function urgencyProblemOf(error: unknown): Phrase {
  if (isApiError(error)) {
    if (error.kind === 'forbidden') return { key: 'customerCard.urgency.problem.forbidden' }
    if (error.kind === 'conflict') return { key: 'customerCard.urgency.problem.conflict' }
    if (error.kind === 'not_found') return { key: 'customerCard.urgency.problem.gone' }
    if (error.kind === 'invalid') return { key: 'customerCard.urgency.problem.invalid' }
    if (error.kind === 'unavailable') return { key: 'error.offline' }
  }
  return { key: 'customerCard.urgency.problem.failed' }
}

// ---- open problems --------------------------------------------------------------------------------------------------------------

/** The open problems of this work order and its customer's orders on it (reported by the customer or by us); the oldest first. */
export function issuesOfWorkOrder(read: CustomerIssues | null, workOrderId: string, customer: Pick<CardCustomer, 'orders'>): CustomerIssue[] {
  if (!read) return []
  const ours = (issue: CustomerIssue) =>
    (issue.record.type === 'WorkOrder' && issue.record.id === workOrderId) || customer.orders.some((order) => order.id === issue.salesOrder?.id || (issue.record.type === 'SalesOrder' && issue.record.id === order.id))
  return read.issues.filter((issue) => issue.status === 'OPEN' && ours(issue)).sort((a, b) => a.raisedAt.localeCompare(b.raisedAt))
}

/**
 * Where "Open thread" goes: the work order's own notes for an issue on the work order; the order's thread in the dock when the reader
 * may read it (the band's thread choices); null: not readable here (held in words).
 */
export function issueThreadOf(issue: Pick<CustomerIssue, 'record' | 'salesOrder'>, choices: readonly OrderThreadChoice[]): ThreadPick | null {
  if (issue.record.type === 'WorkOrder') return 'workOrder'
  const orderId = issue.salesOrder?.id ?? issue.record.id
  return choices.some((choice) => choice.orderId === orderId) ? orderId : null
}

// ---- limits and what the customer sees ------------------------------------------------------------------------------------------

/** The limits card on Customer › Portal access (its anchor). */
export const limitsHref = (prefix: string, partyId: string): string => `${prefix}/sales/customers/${encodeURIComponent(partyId)}?tab=portal#${LIMITS_ANCHOR}`

/** The card's limits line: the level, urgent orders on (at most n, n marked now) or off (the kept marks' words). */
export function limitsLineOf(read: ProductionLimits): { readonly level: ProductionLimits['production']['level']; readonly urgencyOn: boolean; readonly max: number; readonly now: number; readonly dormant: { readonly it: string; readonly en: string } | null } {
  const production = read.production
  return { level: production.level, urgencyOn: production.urgency.on, max: production.urgency.max, now: production.urgency.now, dormant: production.urgency.dormant }
}

/** What the customer sees of its orders at its level: each section shared or not (every level shows the stage, date, health …). */
export const seesOf = (read: ProductionLimits) => seesNow(read.production.level)

// ---- the card's model -------------------------------------------------------------------------------------------------------------

export interface CustomerBlock {
  readonly customer: CardCustomer
  /** Its requests on these orders (workorders.view or orders.view). */
  readonly requests: CardPart<CustomerRequest[]>
  /** What we asked it to approve (partners.approvals.view; null without: said in words). */
  readonly approvals: CardPart<AskedApproval[]> | null
  readonly urgency: CardPart<CustomerUrgency>
  readonly issues: CardPart<CustomerIssues>
  /** Its limits card (partners.view; null without: said in words). */
  readonly limits: CardPart<ProductionLimits> | null
}

export interface CustomerCardModel {
  readonly blocks: readonly CustomerBlock[]
  readonly dialog: UrgencyDialog | null
  readonly busy: boolean
  /** A refused write, said in the dialog. */
  readonly problem: Phrase | null
  /** The last set-back, lock or unlock: per order done or why not. */
  readonly outcome: UrgencyOutcome | null
  /** The reader's clock (ages: "waiting on us 4 h"). */
  readonly now: number
  /** Design cases: the dialog's reason and lock. */
  readonly draft?: { readonly reason?: string; readonly lock?: boolean }
}

export interface CustomerCardActions {
  onDialog?: (dialog: UrgencyDialog | null) => void
  onUrgency?: (input: { readonly act: UrgencyAct; readonly partyId: string; readonly orders: readonly CardOrder[]; readonly reason: string; readonly lock: boolean }) => void
  onDismissOutcome?: () => void
  onRetry?: () => void
}
