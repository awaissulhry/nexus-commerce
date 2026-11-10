import { DISPOSITIONS, type Disposition } from '../versions/drift'

/**
 * Change requests and change orders (B-W2b-226; PRD-169, PRD-170, PRD-175, PRD-259, MES-006; design products.changes,
 * floor.instructions "Report a spec problem", production.workorders "Change request"), pure. factory-db changes.prisma
 * (B-W2b-212) holds the rows and the …_changes_samples_w2b_guards triggers repeat every rule below for every login; this file
 * says each refusal FIRST, in words, so a person never meets the database's message.
 *
 * A change request says what should change in a style and why, from the office, the floor (a spec problem with a photo), a
 * customer, a sample round or a supplier, maybe about the work order where it was seen (MES-006: what is already cut or
 * sewn). It is triaged (OPEN → IN_REVIEW → ACCEPTED | REJECTED, or straight from OPEN) and is DONE once the change order that
 * carries it is RELEASED.
 *
 * A change order carries accepted requests from the style's RELEASED revision to the DRAFT revision holding the redlines,
 * names what each change touches (CHANGE lines: a record before → after) and what happens to each open work order's work
 * in progress (WORK_IN_PROGRESS lines: finish on the old spec, rework, scrap or hold), and is approved by someone who is not
 * its author (one stage in V1, PRD-170: every required approver approves, none rejects). Released, it releases its revision
 * (the old one becomes OBSOLETE) and its requests become DONE, in one command:
 *
 *   DRAFT ──submit──▶ SUBMITTED ──every required approval──▶ APPROVED ──release──▶ RELEASED
 *     │                   │──one rejection──▶ REJECTED            │
 *     └──cancel───────────┴──cancel──────────────────────────────┴──cancel──▶ CANCELLED
 *
 * What it says is fixed once submitted: its lines, requests, revisions and approvers change only while DRAFT (approvers also
 * while SUBMITTED, before they decide), and its proposed revision is frozen too (the edit rule's DRAFT_UNDER_CHANGE_ORDER,
 * product/lifecycle): the approver approves what the draft holds.
 */

export const CHANGE_REQUEST_SOURCES = ['OFFICE', 'FLOOR', 'CUSTOMER', 'SAMPLE', 'SUPPLIER'] as const
export type ChangeRequestSource = (typeof CHANGE_REQUEST_SOURCES)[number]
/** The sources an office person raises (FLOOR is the tablet's). */
export const OFFICE_SOURCES = ['OFFICE', 'CUSTOMER', 'SAMPLE', 'SUPPLIER'] as const satisfies readonly ChangeRequestSource[]
export type OfficeSource = (typeof OFFICE_SOURCES)[number]

export const CHANGE_REQUEST_STATUSES = ['OPEN', 'IN_REVIEW', 'ACCEPTED', 'REJECTED', 'DONE'] as const
export type ChangeRequestStatus = (typeof CHANGE_REQUEST_STATUSES)[number]

export const CHANGE_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const
export type ChangePriority = (typeof CHANGE_PRIORITIES)[number]

export const CHANGE_ORDER_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'RELEASED', 'CANCELLED'] as const
export type ChangeOrderStatus = (typeof CHANGE_ORDER_STATUSES)[number]
/** A change order still going: it holds its proposed revision (the database's one live order per revision). */
export const LIVE_ORDER_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED'] as const satisfies readonly ChangeOrderStatus[]
export const isLiveOrder = (status: ChangeOrderStatus): boolean => (LIVE_ORDER_STATUSES as readonly string[]).includes(status)

export const CHANGE_EFFECTS = ['NEXT_ORDER', 'DATE', 'AT_ONCE'] as const
export type ChangeEffect = (typeof CHANGE_EFFECTS)[number]

export const CHANGE_ITEM_KINDS = ['CHANGE', 'WORK_IN_PROGRESS'] as const
export type ChangeItemKind = (typeof CHANGE_ITEM_KINDS)[number]

/** What happens to an open work order's work in progress (MES-006; the floor's banner reads it: product/versions/drift). */
export const WIP_DISPOSITIONS = DISPOSITIONS
export type WipDisposition = Disposition

export const CHANGE_DECISIONS = ['APPROVED', 'REJECTED'] as const
export type ChangeDecision = (typeof CHANGE_DECISIONS)[number]

/** The floor's tiles (design floor.instructions "Report a spec problem": wrong measurement, unclear, material differs, other). */
export const FLOOR_PROBLEMS = ['WRONG_MEASUREMENT', 'UNCLEAR', 'MATERIAL_DIFFERS', 'OTHER'] as const
export type FloorProblem = (typeof FLOOR_PROBLEMS)[number]

export const FLOOR_PROBLEM_WORDS: Readonly<Record<FloorProblem, { readonly en: string; readonly it: string }>> = Object.freeze({
  WRONG_MEASUREMENT: { en: 'Wrong measurement', it: 'Misura sbagliata' },
  UNCLEAR: { en: 'Unclear instruction', it: 'Istruzione poco chiara' },
  MATERIAL_DIFFERS: { en: 'Material differs', it: 'Materiale diverso' },
  OTHER: { en: 'Other spec problem', it: 'Altro problema della scheda' },
})

/** The database's limits (…_changes_samples_w2b_guards factory_changes_words_ok), said first. */
export const CHANGE_LIMITS = Object.freeze({
  title: 200,
  reason: 4000,
  description: 10_000,
  decisionNote: 2000,
  approvalReason: 2000,
  cancelReason: 1000,
  itemNote: 1000,
  floorNote: 1000,
  /** Lines and approvers of one change order, requests linked at once: a screen's worth. */
  items: 200,
  approvers: 10,
  requests: 50,
})

/** The record type of a CHANGE line (a model name) and its field (the database's patterns). */
export const RECORD_TYPE_PATTERN = /^[A-Z][A-Za-z0-9]{0,59}$/
export const FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_.]{0,99}$/

export const REQUEST_STATUS_WORDS: Readonly<Record<ChangeRequestStatus, string>> = Object.freeze({
  OPEN: 'open',
  IN_REVIEW: 'in review',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  DONE: 'done',
})

export const ORDER_STATUS_WORDS: Readonly<Record<ChangeOrderStatus, string>> = Object.freeze({
  DRAFT: 'a draft',
  SUBMITTED: 'waiting for approval',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  RELEASED: 'released',
  CANCELLED: 'cancelled',
})

export const DISPOSITION_WORDS: Readonly<Record<WipDisposition, string>> = Object.freeze({
  FINISH_OLD: 'finish on the old spec',
  REWORK: 'rework to the new spec',
  SCRAP: 'scrap what is made',
  HOLD: 'hold until someone decides',
})

// ---- refusals -----------------------------------------------------------------------------------------------------------

export const CHANGE_REFUSALS = [
  'REQUEST_DECIDED',
  'REQUEST_MOVE',
  'REASON_NEEDED',
  'REQUEST_NOT_LINKABLE',
  'ORDER_NOT_DRAFT',
  'ORDER_MOVE',
  'NO_RELEASED_REVISION',
  'REVISION_NOT_DRAFT',
  'DRAFT_EXISTS',
  'NO_DRAFT_REVISION',
  'NO_APPROVER',
  'OWN_APPROVAL',
  'APPROVER_CANNOT',
  'NOT_APPROVER',
  'ALREADY_DECIDED',
  'NOT_APPROVED',
  'NOT_YET_EFFECTIVE',
  'EFFECT_DATE',
  'WORK_ORDER_NOT_OPEN',
  'LINE_INVALID',
  'CANCEL_REASON',
] as const
export type ChangeRefusalCode = (typeof CHANGE_REFUSALS)[number]

export interface ChangeRefusal {
  readonly code: ChangeRefusalCode
  readonly message: string
}

const refusal = (code: ChangeRefusalCode, message: string): ChangeRefusal => ({ code, message })

/** "change request CR-2026-0001" (a floor request not taken up yet has no number). */
export const requestName = (number: string | null): string => (number ? `Change request ${number}` : 'This change request from the floor')

// ---- change requests ----------------------------------------------------------------------------------------------------

export const REQUEST_MOVES: Readonly<Record<ChangeRequestStatus, readonly ChangeRequestStatus[]>> = Object.freeze({
  OPEN: ['IN_REVIEW', 'ACCEPTED', 'REJECTED'],
  IN_REVIEW: ['ACCEPTED', 'REJECTED'],
  ACCEPTED: ['DONE'],
  REJECTED: [],
  DONE: [],
})

export const isDecidedRequest = (status: ChangeRequestStatus): boolean => status === 'ACCEPTED' || status === 'REJECTED' || status === 'DONE'

export interface RequestFacts {
  readonly number: string | null
  readonly status: ChangeRequestStatus
}

/** What, why, the revision and the priority change only until the request is decided. */
export function requestEditRefusal(request: RequestFacts, fields: readonly string[]): ChangeRefusal | null {
  if (request.status === 'REJECTED' || request.status === 'DONE') {
    return refusal('REQUEST_DECIDED', `${requestName(request.number)} is ${REQUEST_STATUS_WORDS[request.status]}: it no longer changes.`)
  }
  const locked = fields.filter((field) => field !== 'priority')
  if (request.status === 'ACCEPTED' && locked.length > 0) {
    return refusal('REQUEST_DECIDED', `${requestName(request.number)} is accepted: what, why and the revision stay as they were accepted (only its priority changes).`)
  }
  return null
}

/** A triage move of the office (review, accept, reject); DONE is the change order's release, never a person's move. */
export function requestMoveRefusal(request: RequestFacts, to: ChangeRequestStatus, note: string | null): ChangeRefusal | null {
  if (to === 'DONE' || !REQUEST_MOVES[request.status].includes(to)) {
    return refusal(
      'REQUEST_MOVE',
      to === 'DONE'
        ? `${requestName(request.number)} is done when the change order that carries it is released, not by hand.`
        : `${requestName(request.number)} is ${REQUEST_STATUS_WORDS[request.status]}: it cannot be marked ${REQUEST_STATUS_WORDS[to]}.`,
    )
  }
  if (to === 'REJECTED' && (note === null || note.trim() === '')) {
    return refusal('REASON_NEEDED', `Say why ${request.number ?? 'this request'} is rejected: whoever raised it reads the reason.`)
  }
  return null
}

export interface LinkFacts {
  readonly number: string | null
  readonly status: ChangeRequestStatus
  readonly sameStyle: boolean
  /** The live change order that carries it now (another one), by number; null: none. */
  readonly carriedBy: string | null
}

/** A request carried by a change order: of its style, not rejected or done, not in another live order. */
export function linkRefusal(request: LinkFacts, orderNumber: string): ChangeRefusal | null {
  if (!request.sameStyle) return refusal('REQUEST_NOT_LINKABLE', `${requestName(request.number)} is about another style: ${orderNumber} changes one style only.`)
  if (request.status === 'REJECTED' || request.status === 'DONE') {
    return refusal('REQUEST_NOT_LINKABLE', `${requestName(request.number)} is ${REQUEST_STATUS_WORDS[request.status]}: no change order carries it.`)
  }
  if (request.carriedBy !== null && request.carriedBy !== orderNumber) {
    return refusal('REQUEST_NOT_LINKABLE', `${requestName(request.number)} is carried by change order ${request.carriedBy}: take it out there first.`)
  }
  return null
}

/** The floor's request in words: the tile as the title, the operation, the work order and the worker's words as the reason. */
export function floorRequestText(input: {
  readonly problem: FloorProblem
  readonly note: string | null
  readonly workOrder: string | null
  readonly operation: { readonly seq: number; readonly name: string } | null
  readonly bundle: string | null
}): { title: string; reason: string } {
  const what = FLOOR_PROBLEM_WORDS[input.problem].en
  const where = [
    input.operation ? `operation ${input.operation.seq} · ${input.operation.name}` : null,
    input.workOrder ? `work order ${input.workOrder}` : null,
    input.bundle ? `bundle ${input.bundle}` : null,
  ].filter((part): part is string => part !== null)
  const said = input.note?.trim() ?? ''
  const reason = `${what}, reported from the floor${where.length > 0 ? ` (${where.join(', ')})` : ''}.${said ? ` ${said}` : ''}`
  return { title: `Spec problem: ${what.toLowerCase()}`.slice(0, CHANGE_LIMITS.title), reason: reason.slice(0, CHANGE_LIMITS.reason) }
}

// ---- change orders ------------------------------------------------------------------------------------------------------

export interface OrderFacts {
  readonly number: string
  readonly status: ChangeOrderStatus
}

/** What a change order says (lines, requests, revisions, effect) changes only while DRAFT. */
export function orderEditRefusal(order: OrderFacts): ChangeRefusal | null {
  if (order.status === 'DRAFT') return null
  return refusal(
    'ORDER_NOT_DRAFT',
    isLiveOrder(order.status)
      ? `Change order ${order.number} is ${ORDER_STATUS_WORDS[order.status]}: what it changes was fixed when it was submitted. Cancel it and write a new one to change it.`
      : `Change order ${order.number} is ${ORDER_STATUS_WORDS[order.status]}: it no longer changes.`,
  )
}

/** The effect and its day: DATE needs the day, the others none. */
export function effectRefusal(effect: ChangeEffect, effectiveDate: string | null): ChangeRefusal | null {
  if ((effect === 'DATE') !== (effectiveDate !== null)) {
    return refusal('EFFECT_DATE', effect === 'DATE' ? 'Say the day the change takes effect.' : 'A day is given only when the change takes effect from a date.')
  }
  return null
}

export interface ApprovalFacts {
  readonly approverId: string
  readonly required: boolean
  readonly decision: ChangeDecision | null
}

/** The four eyes: the author never approves their own change order. */
export function approverRefusal(order: OrderFacts & { readonly authorId: string }, approverId: string): ChangeRefusal | null {
  if (approverId === order.authorId) {
    return refusal('OWN_APPROVAL', `The author of change order ${order.number} cannot approve it: name someone else (four eyes).`)
  }
  return null
}

/** Approvers are named while DRAFT, or SUBMITTED before they decide. */
export function approversRefusal(order: OrderFacts): ChangeRefusal | null {
  if (order.status === 'DRAFT' || order.status === 'SUBMITTED') return null
  return refusal('ORDER_NOT_DRAFT', `Change order ${order.number} is ${ORDER_STATUS_WORDS[order.status]}: its approvers no longer change.`)
}

/** Ready to submit: its DRAFT revision, a required approver who is not the author. */
export function submitRefusal(
  order: OrderFacts & { readonly authorId: string },
  toRevision: { readonly revision: number; readonly status: string } | null,
  approvals: readonly ApprovalFacts[],
): ChangeRefusal | null {
  if (order.status !== 'DRAFT') return refusal('ORDER_MOVE', `Change order ${order.number} is ${ORDER_STATUS_WORDS[order.status]}: only a draft is submitted.`)
  if (toRevision === null) {
    return refusal('NO_DRAFT_REVISION', `Change order ${order.number} has no proposed revision yet: start its draft revision (a copy of the released one), make the change there, then submit.`)
  }
  if (toRevision.status !== 'DRAFT') {
    return refusal('REVISION_NOT_DRAFT', `Revision ${toRevision.revision} is no longer a draft: ${order.number} proposes a draft revision.`)
  }
  if (!approvals.some((approval) => approval.required)) {
    return refusal('NO_APPROVER', `Name at least one required approver for change order ${order.number}: someone other than its author decides it.`)
  }
  const own = approvals.find((approval) => approval.approverId === order.authorId)
  if (own) return approverRefusal(order, own.approverId)
  return null
}

/** The database's count: APPROVED once a required approval is APPROVED, none required waits and none is REJECTED. */
export function approvalOutcome(approvals: readonly ApprovalFacts[]): 'APPROVED' | 'REJECTED' | 'WAITING' {
  if (approvals.some((approval) => approval.decision === 'REJECTED')) return 'REJECTED'
  const required = approvals.filter((approval) => approval.required)
  if (required.some((approval) => approval.decision === 'APPROVED') && required.every((approval) => approval.decision !== null)) return 'APPROVED'
  return 'WAITING'
}

/** "2 of 3": the required approvals given, of those required (the list's Approvals column). */
export function approvalCount(approvals: readonly ApprovalFacts[]): { approved: number; required: number } {
  const required = approvals.filter((approval) => approval.required)
  return { approved: required.filter((approval) => approval.decision === 'APPROVED').length, required: required.length }
}

/** One person's decision on a submitted change order: theirs to give (named), once, with why for a rejection. */
export function decideRefusal(
  order: OrderFacts & { readonly authorId: string },
  approval: ApprovalFacts | null,
  personId: string,
  decision: ChangeDecision,
  reason: string | null,
): ChangeRefusal | null {
  if (personId === order.authorId) return approverRefusal(order, personId)
  if (order.status !== 'SUBMITTED') {
    return refusal('ORDER_MOVE', `Change order ${order.number} is ${ORDER_STATUS_WORDS[order.status]}: it is decided only while it waits for approval.`)
  }
  if (approval === null) return refusal('NOT_APPROVER', `You are not an approver of change order ${order.number}: its author names who decides it.`)
  if (approval.decision !== null) return refusal('ALREADY_DECIDED', `You already ${approval.decision === 'APPROVED' ? 'approved' : 'rejected'} change order ${order.number}: a decision is given once.`)
  if (decision === 'REJECTED' && (reason === null || reason.trim() === '')) {
    return refusal('REASON_NEEDED', `Say why you reject change order ${order.number}: its author reads the reason.`)
  }
  return null
}

/** Released once approved, and not before its day when it takes effect from a date (the new revision applies from the day it is released). */
export function releaseRefusal(order: OrderFacts & { readonly effect: ChangeEffect; readonly effectiveDate: string | null }, today: string): ChangeRefusal | null {
  if (order.status !== 'APPROVED') {
    return refusal(
      'NOT_APPROVED',
      order.status === 'SUBMITTED' || order.status === 'DRAFT'
        ? `Change order ${order.number} is ${ORDER_STATUS_WORDS[order.status]}: its revision is released once the change order is approved.`
        : `Change order ${order.number} is ${ORDER_STATUS_WORDS[order.status]}: it is not released.`,
    )
  }
  if (order.effect === 'DATE' && order.effectiveDate !== null && order.effectiveDate > today) {
    return refusal('NOT_YET_EFFECTIVE', `Change order ${order.number} takes effect on ${order.effectiveDate}: release it on that day, not before.`)
  }
  return null
}

/** A cancellation says why, and is not for an order already decided for good. */
export function cancelRefusal(order: OrderFacts, reason: string | null): ChangeRefusal | null {
  if (!isLiveOrder(order.status)) return refusal('ORDER_MOVE', `Change order ${order.number} is ${ORDER_STATUS_WORDS[order.status]}: it is not cancelled.`)
  if (reason === null || reason.trim() === '') return refusal('CANCEL_REASON', `Say why change order ${order.number} is cancelled.`)
  return null
}

export interface ChangeLineInput {
  readonly recordType: string
  readonly field: string | null
  readonly before: unknown
  readonly after: unknown
}

/** A CHANGE line names a record by model name and id, a field (or none) and what it is before and/or after. */
export function changeLineRefusal(line: ChangeLineInput): ChangeRefusal | null {
  if (!RECORD_TYPE_PATTERN.test(line.recordType)) return refusal('LINE_INVALID', `"${line.recordType}" is not a record type: name the model (BomLine, RoutingOperation, MeasurementSpecValue …).`)
  if (line.field !== null && !FIELD_PATTERN.test(line.field)) return refusal('LINE_INVALID', `"${line.field}" is not a field name: letters, digits, dots and underscores, starting with a letter.`)
  if ((line.before === null || line.before === undefined) && (line.after === null || line.after === undefined)) {
    return refusal('LINE_INVALID', 'Say what the record is before, after, or both (only before: it is removed; only after: it is new).')
  }
  return null
}

/** A work-in-progress line is for an open work order of the change order's style. */
export function workInProgressRefusal(workOrder: { readonly number: string; readonly status: string; readonly sameStyle: boolean }): ChangeRefusal | null {
  if (!workOrder.sameStyle) return refusal('WORK_ORDER_NOT_OPEN', `Work order ${workOrder.number} makes another style.`)
  if (workOrder.status === 'CLOSED' || workOrder.status === 'CANCELLED' || workOrder.status === 'COMPLETED') {
    return refusal('WORK_ORDER_NOT_OPEN', `Work order ${workOrder.number} is ${workOrder.status.toLowerCase()}: nothing of it is in progress.`)
  }
  return null
}

// ---- lists --------------------------------------------------------------------------------------------------------------

/** The saved filters of the changes page (design changes.tiles, changes.grid savedRows). */
export const REQUEST_TILES = ['TO_TRIAGE', 'ACCEPTED_FREE', 'MINE', 'ALL'] as const
export type RequestTile = (typeof REQUEST_TILES)[number]
export const ORDER_TILES = ['MINE_TO_APPROVE', 'TO_RELEASE', 'RELEASED_THIS_MONTH', 'OPEN', 'ALL'] as const
export type OrderTile = (typeof ORDER_TILES)[number]

/** The statuses a request tile shows (MINE and ACCEPTED_FREE add their own conditions). */
export const REQUEST_TILE_STATUSES: Readonly<Record<RequestTile, readonly ChangeRequestStatus[]>> = Object.freeze({
  TO_TRIAGE: ['OPEN', 'IN_REVIEW'],
  ACCEPTED_FREE: ['ACCEPTED'],
  MINE: CHANGE_REQUEST_STATUSES,
  ALL: CHANGE_REQUEST_STATUSES,
})

/** The first day of the month of a business date (RELEASED_THIS_MONTH). */
export const monthStart = (today: string): string => `${today.slice(0, 7)}-01`
