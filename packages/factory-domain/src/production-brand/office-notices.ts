import { SAMPLE_ROUND_RECORD, SAMPLE_SWATCH_RECORD, type ApprovalDecision, type ApprovalKind } from '../approvals-out/kinds'
import type { MessageKey, NotificationCategory } from '../notifications/rules'
import type { CounterAnswer } from '../sales/change-requests/counter'
import type { OrderRequestKind } from '../sales/change-requests/rules'
import { APPROVER_ROUND_KINDS, approverRuleOf } from './approver'
import type { BatchAskKind } from './bulk'
import type { UrgencyChange } from './events'
import type { BrandUrgency, UrgencyActor } from './urgency'

/**
 * B-PR-32 — the factory is told of every customer action on its production (production plan §1 "Full control", §3, §6 slice 3
 * "notices"; lead picks L15, L21; review fixes R-43, R-51, R-60; 06-tree A.7 O-NOTIF-brand; Appendix C "TOP gates nothing; a
 * refusal tells the office"; the Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But
 * we, as the production unit, should be able to see it all. And manage it all as well."), pure: which office notice an event of a
 * customer's act makes, and in which category. The API's fan-out rule (apps/factory-api platform/notifications/rules/
 * brand-production.ts) reads the records, decides who is told (the order's supervisor and the customer's backup, else the holders
 * of production.brand.manage over the order's company and customer — each re-checked at the fan-out) and asks these:
 *
 *   brand_production.urgency_changed      the customer's OWN acts only (by BRAND): marked Urgent, set back to Regular, its urgent
 *                                         list put in a new order, an earlier batch undone. Ours (by FACTORY: set back, lock,
 *                                         unlock, our yes to its "Urgent – asked") are never told as the customer's (FOLLOWING:
 *                                         news of orders the supervisor follows)
 *   order_change_request.asked            an ask of ONE order, without a batch (every kind: change, cancel, urgent, pause, resume,
 *                                         ship what is ready, another sample round) — APPROVAL: it waits for our answer. An ask
 *                                         that carries a batch is never told on its own: its batch is
 *   order_change_request.batch_asked      a bulk ask (Ask N, Mark urgent over the quota or from Cutting): ONE notice per batch,
 *                                         "asks to pause 12 orders" (one request of a batch reads as one order)
 *   order_change_request.withdrawn        a request withdrawn — a batch's Undo is told once for the requests it withdrew together
 *   order_change_request.counter_answered our counter-offer accepted or refused
 *   approval_request.answered             one of the customer's PRODUCTION approvals answered (approver.ts approverRuleOf: the PP
 *                                         sample, the size set, the top of production, fabric, trims), a refused top of
 *                                         production (it gates nothing: quality decides), and a refused new date (REPROMISE: the
 *                                         date stands). A counter-offer's answer is counter_answered's; development samples,
 *                                         artwork, proofs, colours, leathers, concessions, revised orders and signatures are not
 *                                         production approvals
 * The answers (withdrawn, a refused counter, approvals) are decisions (APPROVAL, notifications/preferences DECIDED_MESSAGE_KEYS); an
 * ask and a counter-offer it accepted wait for our answer (APPROVAL, "approval waiting"). Each sentence
 * names the customer ({customer}: told only to a person who reads that customer's records) and its orders by our number — never a
 * person of the customer, an amount, a reason a person typed or anything of another customer.
 */

/** A notice: its sentence (notifications/rules MESSAGE_TEMPLATES) and its category (the bell's tab, the person's matrix row). */
export interface OfficeNotice {
  readonly key: MessageKey
  readonly category: NotificationCategory
}

const notice = (key: MessageKey, category: NotificationCategory): OfficeNotice => Object.freeze({ key, category })

/** The sentences of the customer's urgency acts (one order, several). */
export const URGENCY_OFFICE_KEYS = Object.freeze({
  URGENT: { one: 'notifications.production.customerUrgent', many: 'notifications.production.customerUrgentMany' },
  REGULAR: { one: 'notifications.production.customerRegular', many: 'notifications.production.customerRegularMany' },
  UNDO: { one: 'notifications.production.customerUndid', many: 'notifications.production.customerUndidMany' },
  ORDER: 'notifications.production.customerReordered',
} as const satisfies { readonly [key: string]: MessageKey | { readonly one: MessageKey; readonly many: MessageKey } })

/** The sentences of an ask of one order, per kind (a cancel of some lines has its own). */
export const ASK_OFFICE_KEYS = Object.freeze({
  RUSH: 'notifications.production.customerAskedRush',
  HOLD: 'notifications.production.customerAskedHold',
  RESUME: 'notifications.production.customerAskedResume',
  CANCEL: 'notifications.production.customerAskedCancel',
  CHANGE: 'notifications.production.customerAskedChange',
  SPLIT_SHIPMENT: 'notifications.production.customerAskedSplit',
  SAMPLE_ROUND: 'notifications.production.customerAskedSampleRound',
} as const satisfies Readonly<Record<OrderRequestKind, MessageKey>>)
export const ASK_CANCEL_LINES_KEY = 'notifications.production.customerAskedCancelLines' satisfies MessageKey

/** The sentences of a bulk ask of several orders, per kind. */
export const BATCH_ASK_OFFICE_KEYS = Object.freeze({
  RUSH: 'notifications.production.customerAskedRushMany',
  HOLD: 'notifications.production.customerAskedHoldMany',
  RESUME: 'notifications.production.customerAskedResumeMany',
  CANCEL: 'notifications.production.customerAskedCancelMany',
} as const satisfies Readonly<Record<BatchAskKind, MessageKey>>)

export const WITHDRAWN_OFFICE_KEYS = Object.freeze({ one: 'notifications.production.customerWithdrew', many: 'notifications.production.customerWithdrewMany' } as const satisfies { readonly one: MessageKey; readonly many: MessageKey })

export const COUNTER_OFFICE_KEYS = Object.freeze({
  ACCEPTED: 'notifications.production.customerCounterAccepted',
  REFUSED: 'notifications.production.customerCounterRefused',
} as const satisfies Readonly<Record<CounterAnswer, MessageKey>>)

/** The sentences of an answered production approval: what it was about (a sample round, a fabric, a trim) × the answer. */
export const APPROVAL_OFFICE_KEYS = Object.freeze({
  SAMPLE: { APPROVED: 'notifications.production.customerApprovedSample', APPROVED_WITH_CHANGES: 'notifications.production.customerApprovedSampleChanges', REFUSED: 'notifications.production.customerRefusedSample' },
  FABRIC: { APPROVED: 'notifications.production.customerApprovedFabric', APPROVED_WITH_CHANGES: 'notifications.production.customerApprovedFabricChanges', REFUSED: 'notifications.production.customerRefusedFabric' },
  TRIM: { APPROVED: 'notifications.production.customerApprovedTrim', APPROVED_WITH_CHANGES: 'notifications.production.customerApprovedTrimChanges', REFUSED: 'notifications.production.customerRefusedTrim' },
} as const satisfies Readonly<Record<'SAMPLE' | 'FABRIC' | 'TRIM', Readonly<Record<ApprovalDecision, MessageKey>>>>)
/** A refused top of production (it gates nothing: quality decides) and a refused new date (the date stands). */
export const REFUSED_TOP_KEY = 'notifications.production.customerRefusedTop' satisfies MessageKey
export const REFUSED_NEW_DATE_KEY = 'notifications.production.customerRefusedNewDate' satisfies MessageKey

/**
 * Every sentence that tells a decision of the customer (an answer, a withdrawal): the person's matrix row "approval decided". Its
 * yes to our counter-offer is not one: the request then waits for OUR accept, which carries it out ("approval waiting").
 */
export const OFFICE_DECIDED_KEYS: readonly MessageKey[] = Object.freeze([
  WITHDRAWN_OFFICE_KEYS.one,
  WITHDRAWN_OFFICE_KEYS.many,
  COUNTER_OFFICE_KEYS.REFUSED,
  ...Object.values(APPROVAL_OFFICE_KEYS).flatMap((answers): MessageKey[] => [answers.APPROVED, answers.APPROVED_WITH_CHANGES, answers.REFUSED]),
  REFUSED_TOP_KEY,
  REFUSED_NEW_DATE_KEY,
])

/**
 * The records a customer's production approval may be asked on: a sample round, a swatch, and the customer's own records with a
 * thread (its style, quote, order, project). A purchase order's or a subcontract order's (a supplier's lab dip, a workshop's
 * sample) is never a customer's approval.
 */
export const CUSTOMER_APPROVAL_RECORDS: readonly string[] = Object.freeze([SAMPLE_ROUND_RECORD, SAMPLE_SWATCH_RECORD, 'Style', 'Quote', 'SalesOrder', 'Project'])

/**
 * The notice of a customer's urgency act over `count` of its orders (the orders the reader is told of), or null: not the
 * customer's own act (ours, or our yes to its ask), or nothing to tell.
 */
export function urgencyOfficeNotice(event: { readonly by: UrgencyActor; readonly change: UrgencyChange; readonly urgency: BrandUrgency; readonly undo: boolean; readonly asked: boolean }, count: number): OfficeNotice | null {
  if (event.by !== 'BRAND' || event.asked || count < 1) return null
  const many = count > 1
  if (event.undo) return notice(many ? URGENCY_OFFICE_KEYS.UNDO.many : URGENCY_OFFICE_KEYS.UNDO.one, 'FOLLOWING')
  if (event.change === 'ORDER') return notice(URGENCY_OFFICE_KEYS.ORDER, 'FOLLOWING')
  // SET_BACK, LOCK and UNLOCK are only ever ours.
  if (event.change !== 'MARK') return null
  const keys = URGENCY_OFFICE_KEYS[event.urgency]
  return notice(many ? keys.many : keys.one, 'FOLLOWING')
}

/** The notice of an ask of one order (it waits for our answer). */
export function askOfficeNotice(kind: OrderRequestKind, wholeOrder: boolean): OfficeNotice {
  return notice(kind === 'CANCEL' && !wholeOrder ? ASK_CANCEL_LINES_KEY : ASK_OFFICE_KEYS[kind], 'APPROVAL')
}

/** The notice of a bulk ask over `count` of its orders (one request reads as an ask of one order), or null: none to tell. */
export function batchAskOfficeNotice(kind: BatchAskKind, count: number): OfficeNotice | null {
  if (count < 1) return null
  return notice(count === 1 ? ASK_OFFICE_KEYS[kind] : BATCH_ASK_OFFICE_KEYS[kind], 'APPROVAL')
}

/** The notice of requests withdrawn together (one, or a batch's Undo), or null: none. */
export function withdrawnOfficeNotice(count: number): OfficeNotice | null {
  if (count < 1) return null
  return notice(count === 1 ? WITHDRAWN_OFFICE_KEYS.one : WITHDRAWN_OFFICE_KEYS.many, 'APPROVAL')
}

/** The notice of the customer's answer to our counter-offer. */
export const counterOfficeNotice = (answer: CounterAnswer): OfficeNotice => notice(COUNTER_OFFICE_KEYS[answer], 'APPROVAL')

/**
 * The notice of an answered approval request, or null: not one of the customer's production approvals (see the head). `sampleKind`:
 * the round's kind when the request is about a sample round.
 */
export function approvalOfficeNotice(request: { readonly kind: ApprovalKind; readonly recordType: string; readonly sampleKind: string | null; readonly status: ApprovalDecision }): OfficeNotice | null {
  if (request.kind === 'REPROMISE') return request.status === 'REFUSED' && request.recordType === 'SalesOrder' ? notice(REFUSED_NEW_DATE_KEY, 'APPROVAL') : null
  if (!CUSTOMER_APPROVAL_RECORDS.includes(request.recordType)) return null
  if (approverRuleOf({ kind: request.kind, recordType: request.recordType, sampleKind: request.sampleKind }) === null) return null
  if (request.kind === 'FABRIC' || request.kind === 'TRIM') return notice(APPROVAL_OFFICE_KEYS[request.kind][request.status], 'APPROVAL')
  // A production sample round (PP, size set, top of production); a refused top of production says that it gates nothing.
  if (request.status === 'REFUSED' && request.sampleKind === 'TOP_OF_PRODUCTION') return notice(REFUSED_TOP_KEY, 'APPROVAL')
  return notice(APPROVAL_OFFICE_KEYS.SAMPLE[request.status], 'APPROVAL')
}

/**
 * Whether an answered request may make a notice at all, before its round is read: its kind, record and answer (a round's kind
 * only chooses among the production rounds' sentences, or rules a development round out).
 */
export const mayTellApproval = (request: { readonly kind: ApprovalKind; readonly recordType: string; readonly status: ApprovalDecision }): boolean =>
  approvalOfficeNotice({ ...request, sampleKind: APPROVER_ROUND_KINDS[0] }) !== null
