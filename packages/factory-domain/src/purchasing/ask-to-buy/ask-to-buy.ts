import { isBusinessDate, type BusinessDate } from '../../core/time'
import { addDays } from '../../planning/buy'
import { decimalOf, QUANTITY_SCALE } from '../../product/units/units'
import type { RequestStatus } from '../requests/requests'

/**
 * Ask to buy (B-W2b-332; SCM-035 "Purchase request by staff", SCM-037 "Buy from a shortage"; design purchasing.requests
 * pop-up "Ask to buy": material, quantity, date, reason, work order; "Send request"), pure. factory-db buying-depth.prisma
 * PurchaseRequest holds it (B-W2b-285); apps/factory-api modules/purchasing/ask-to-buy writes it, always through command().
 *
 *   OFFICE     anyone in the office asks: a material of the library (its colour, words of one's own about it), how much in
 *              one of the material's units, by when (today or later), why, and the work order it is for when there is one.
 *   SHORTAGE   a line of the shortage list (an open work order short of a material, planning's live plan): the request
 *              names the work order and the material, and keeps the shortage as it was seen (what was short, by when, the
 *              plan run); the same work order and material is asked once while a request of it is open. A buyer may draft
 *              the purchase order line at once instead ("Draft a purchase order now"): the request is written and drafted
 *              in the same command.
 *
 * The life of a request: a switched-on PURCHASE_REQUEST approval rule may ask a yes first (PENDING_APPROVAL; never from the
 * person who asked, the Owner included), then it waits for the buyer (OPEN), who drafts it into a purchase order line with
 * the other requests to buy (Purchasing › Requests to buy, "Draft POs for n": CONVERTED) or refuses it with the reason
 * (REJECTED). The person who asked (or a buyer) may take it back while it is open or waits for its yes (CANCELLED). What was
 * asked never changes after it is asked; nothing is deleted.
 *
 * In the buyer's queue (purchasing/requests) a request is the kind ASKED: OPEN is open, PENDING_APPROVAL is WAITING_APPROVAL
 * (held: it cannot be drafted yet), CONVERTED is converted, REJECTED is SET_ASIDE (refused, with the reason); a CANCELLED one
 * leaves the queue (the asker still sees it in their own list).
 */

export const PURCHASE_REQUEST_STATUSES = ['OPEN', 'PENDING_APPROVAL', 'CONVERTED', 'REJECTED', 'CANCELLED'] as const
export type PurchaseRequestStatus = (typeof PURCHASE_REQUEST_STATUSES)[number]
export const PURCHASE_REQUEST_SOURCES = ['OFFICE', 'SHORTAGE'] as const
export type PurchaseRequestSource = (typeof PURCHASE_REQUEST_SOURCES)[number]

/** Still to be decided: what the asker may take back. */
export const LIVE_REQUEST_STATUSES: readonly PurchaseRequestStatus[] = Object.freeze(['OPEN', 'PENDING_APPROVAL'])

export const ASK_LIMITS = Object.freeze({
  /** The reason, a refusal's or a cancellation's words (the database's 1 to 2000). */
  words: 2000,
  /** Words of one's own about the material (size, model, brand). */
  description: 2000,
  /** Decimal(18,4): at most 14 whole digits. */
  quantityDigits: 14,
  /** The latest need date: two years ahead. */
  horizonDays: 730,
  /** At most this many requests refused or taken back at once. */
  batch: 100,
  /** The options' materials and work orders, at most. */
  options: 300,
})

/** The queue's status of a request (null: it leaves the queue). */
export const QUEUE_STATUS_OF: Readonly<Record<PurchaseRequestStatus, RequestStatus | null>> = Object.freeze({
  OPEN: 'OPEN',
  PENDING_APPROVAL: 'WAITING_APPROVAL',
  CONVERTED: 'CONVERTED',
  REJECTED: 'SET_ASIDE',
  CANCELLED: null,
})

/** The request statuses behind a queue status (the list's filter). */
export function requestStatusesOf(status: RequestStatus | 'ALL'): PurchaseRequestStatus[] {
  if (status === 'ALL') return ['OPEN', 'PENDING_APPROVAL', 'CONVERTED', 'REJECTED']
  return PURCHASE_REQUEST_STATUSES.filter((entry) => QUEUE_STATUS_OF[entry] === status)
}

export interface Problem {
  readonly path: string
  readonly message: string
}

const trimmed = (value: string | null | undefined): string => (value ?? '').trim()

/** A quantity above 0, at most four decimal places and fourteen whole digits; null when it is not one. */
export function quantityOf(text: string): string | null {
  const value = text.trim()
  if (!/^\d+(\.\d{1,4})?$/.test(value)) return null
  const whole = value.split('.')[0]!.replace(/^0+(?=\d)/, '')
  if (whole.length > ASK_LIMITS.quantityDigits) return null
  const parsed = decimalOf(value)
  return parsed.gt(0) ? parsed.toFixed(QUANTITY_SCALE) : null
}

export interface AskFields {
  readonly quantity: string
  readonly needDate: string
  readonly reason: string
  readonly description?: string | null | undefined
}

/** What is wrong with what is asked, field by field (the API's 400 paths; the dialog's own words come from the paths). */
export function askProblems(fields: AskFields, today: BusinessDate): Problem[] {
  const problems: Problem[] = []
  if (quantityOf(fields.quantity) === null) problems.push({ path: 'body/quantity', message: 'A quantity above 0, with at most four decimals.' })
  if (!isBusinessDate(fields.needDate)) problems.push({ path: 'body/needDate', message: 'A calendar day.' })
  else if (fields.needDate < today) problems.push({ path: 'body/needDate', message: 'Today or later: the day it is needed at the site.' })
  else if (fields.needDate > addDays(today, ASK_LIMITS.horizonDays)) problems.push({ path: 'body/needDate', message: 'At most two years ahead.' })
  const reason = trimmed(fields.reason)
  if (reason === '') problems.push({ path: 'body/reason', message: 'Say why it is needed.' })
  else if (reason.length > ASK_LIMITS.words) problems.push({ path: 'body/reason', message: `At most ${ASK_LIMITS.words} characters.` })
  if (trimmed(fields.description).length > ASK_LIMITS.description) problems.push({ path: 'body/description', message: `At most ${ASK_LIMITS.description} characters.` })
  return problems
}

/** Words of a refusal or a cancellation: 1 to 2000 characters once trimmed; null when they are not. */
export function wordsOf(text: string | null | undefined): string | null {
  const value = trimmed(text)
  return value === '' || value.length > ASK_LIMITS.words ? null : value
}

export const ASK_REFUSALS = Object.freeze({
  NOT_A_MATERIAL: 'This is not a material we buy: pick a material of the library (a finished product is made, not bought).',
  MATERIAL_ARCHIVED: 'This material is archived: it is not bought any more.',
  COLOUR_NOT_OURS: 'This colour is not one of the material’s active colours.',
  UNIT_NOT_CONVERTED: 'The material is not counted in this unit: use its own unit or its purchase unit.',
  WORK_ORDER_GONE: 'The work order is not an open work order of this site.',
  SHORTAGE_GONE: 'This work order is not short of this material any more: nothing to ask.',
  SHORTAGE_ASKED: 'This shortage was asked already: its request waits for the buyer.',
  NOT_LIVE: 'This request is decided already: it cannot be taken back.',
  NOT_OPEN: 'Only a request that waits for the buyer can be refused (one that waits for a yes is the approver’s to decide).',
  NOT_YOURS: 'You can take back only your own requests (a buyer can take back any).',
  WAITS_FOR_YES: 'It waits for a yes first: it is drafted once it is approved.',
  NO_SUPPLIER: 'Pick the supplier: the material has no approved source or default supplier.',
  LINE_ASKED: 'This line buys a request asked in the office: it stays on the order (change its quantity instead; the request keeps its line).',
})

/** Why the person may not take this request back (null: they may). */
export function cancelProblem(request: { readonly status: PurchaseRequestStatus; readonly requestedById: string }, personId: string, buyer: boolean): string | null {
  if (!LIVE_REQUEST_STATUSES.includes(request.status)) return ASK_REFUSALS.NOT_LIVE
  if (request.requestedById !== personId && !buyer) return ASK_REFUSALS.NOT_YOURS
  return null
}

/** Why the buyer may not refuse it (null: they may). */
export const rejectProblem = (status: PurchaseRequestStatus): string | null => (status === 'OPEN' ? null : ASK_REFUSALS.NOT_OPEN)

/** The shortage as it was seen (PurchaseRequest.shortage): the database wants an object. */
export interface ShortageSeen {
  readonly word: 'NOT_ENOUGH' | 'DELAYED'
  readonly short: string
  readonly uom: string
  readonly needDate: BusinessDate
  readonly runId: string | null
  readonly workOrderNumber: string
}

export function shortageSeen(row: ShortageSeen): Record<string, string | null> {
  return { word: row.word, short: row.short, uom: row.uom, needDate: row.needDate, runId: row.runId, workOrderNumber: row.workOrderNumber }
}

/** A stored shortage read back (null: none, or not one we wrote). */
export function readShortage(json: unknown): ShortageSeen | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  const value = json as Record<string, unknown>
  if ((value.word !== 'NOT_ENOUGH' && value.word !== 'DELAYED') || typeof value.short !== 'string' || typeof value.uom !== 'string' || !isBusinessDate(value.needDate) || typeof value.workOrderNumber !== 'string') return null
  return { word: value.word, short: value.short, uom: value.uom, needDate: value.needDate, runId: typeof value.runId === 'string' ? value.runId : null, workOrderNumber: value.workOrderNumber }
}

/** "Draft a purchase order now" (a buyer, from a shortage) or "Send to the buyers" (anyone). */
export const SHORTAGE_THEN = ['REQUEST', 'DRAFT'] as const
export type ShortageThen = (typeof SHORTAGE_THEN)[number]

/**
 * The database's own refusal to delete a purchase order line that a request to buy was converted into (PurchaseRequest's
 * foreign key, ON DELETE RESTRICT; a CONVERTED request is final), when a line's removal reached it (a draft's "remove the
 * line", the Draft PO's Undo): the issue the API answers 409 with, in words, never a 500. null: not that refusal.
 */
export function askedLineRefusal(error: unknown): { readonly path: string; readonly message: string } | null {
  const shaped = error as { code?: unknown; message?: unknown; meta?: { constraint?: unknown; field_name?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown; constraint?: unknown } } } } | null
  const cause = shaped?.meta?.driverAdapterError?.cause
  const texts = [shaped?.meta?.constraint, shaped?.meta?.field_name, cause?.originalMessage, cause?.constraint, typeof shaped?.message === 'string' ? shaped.message : null].map((text) => (typeof text === 'string' ? text : JSON.stringify(text ?? '')))
  const foreignKey = shaped?.code === 'P2003' || cause?.originalCode === '23503'
  if (!foreignKey || !texts.some((text) => text.includes('PurchaseRequest') && text.includes('purchaseOrderLineId'))) return null
  return { path: 'refusal/LINE_ASKED', message: ASK_REFUSALS.LINE_ASKED }
}
