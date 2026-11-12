import type { BusinessDate } from '../../core/time'

/**
 * The lot page's W2b facts (B-W2b-313; SCM-238 "Where the lot is, how much, reserved for whom, moves, documents, garments
 * made from it"; design warehouse.lots lt-release "incoming inspection passed (W2b)", lt-status "the person who received the
 * lot cannot release it (separation of duties, W2b)", lt-metrics "Documents expiring in 30 days (W2b)", lt-stock
 * "depleted: 'Nothing left · depleted 3 Nov'"; Owner answer W3: a person with the quality role types the lot code, never
 * the person who received it). Pure: the API reads the rows, these say what they mean.
 */

/** A document is "expiring" this many days ahead (the tile's 30 days). */
export const EXPIRING_DAYS = 30

export const DOCUMENT_STATES = ['VALID', 'NO_END', 'EXPIRING', 'EXPIRED'] as const
export type DocumentState = (typeof DOCUMENT_STATES)[number]

/** The day `days` after `day` (YYYY-MM-DD, calendar arithmetic in UTC: a business date has no time). */
export function addDays(day: BusinessDate, days: number): BusinessDate {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** Where an ACTIVE document stands today: no end, valid, expiring within EXPIRING_DAYS (its last day included), expired. */
export function documentState(validTo: BusinessDate | null, today: BusinessDate): DocumentState {
  if (validTo === null) return 'NO_END'
  if (validTo < today) return 'EXPIRED'
  if (validTo <= addDays(today, EXPIRING_DAYS)) return 'EXPIRING'
  return 'VALID'
}

/** Days from today to the last valid day (negative: expired that many days ago). */
export function daysLeft(validTo: BusinessDate, today: BusinessDate): number {
  return Math.round((Date.parse(`${validTo}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)
}

export const INCOMING_STATES = ['NOT_INSPECTED', 'OPEN', 'PASSED', 'FAILED', 'CANCELLED'] as const
export type IncomingState = (typeof INCOMING_STATES)[number]

/** One incoming inspection of the lot (or of its parent, for a child lot). */
export interface IncomingFacts {
  readonly number: string
  readonly status: 'OPEN' | 'DECIDED' | 'CANCELLED'
  readonly computedResult: 'PASS' | 'FAIL' | null
  readonly overrideReason: string | null
  readonly accepted: string | null
  readonly rejected: string | null
  readonly toSort: string | null
  readonly decidedAt: string | null
  readonly createdAt: string
}

export interface IncomingCheck {
  readonly state: IncomingState
  /** The inspection the check rests on: the open one, else the newest decided, else the newest. */
  readonly number: string | null
  readonly words: string
}

/**
 * Did the lot pass its incoming inspection? An open one is not passed yet; the newest decided one says PASSED (its sample
 * passed, or the whole lot was accepted over a soft FAIL with the reason) or FAILED; a lot never inspected says so (the
 * release checklist of the lab does not ask for one yet: B-W2b-98's gap 1, the lab's step).
 */
export function incomingCheck(inspections: readonly IncomingFacts[]): IncomingCheck {
  const newest = [...inspections].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  const open = newest.find((inspection) => inspection.status === 'OPEN')
  if (open) return { state: 'OPEN', number: open.number, words: `Incoming inspection ${open.number} is still open: not passed yet.` }
  const decided = newest.find((inspection) => inspection.status === 'DECIDED')
  if (decided) {
    const overridden = decided.computedResult === 'FAIL' && decided.overrideReason !== null
    if (decided.computedResult === 'PASS' || overridden) {
      return { state: 'PASSED', number: decided.number, words: overridden ? `Incoming inspection ${decided.number} accepted the lot over its sample, with the reason: ${decided.overrideReason}` : `Incoming inspection ${decided.number} passed.` }
    }
    return { state: 'FAILED', number: decided.number, words: `Incoming inspection ${decided.number} did not pass: ${decided.accepted ?? '0'} accepted, ${decided.rejected ?? '0'} rejected, ${decided.toSort ?? '0'} to sort.` }
  }
  const cancelled = newest.find((inspection) => inspection.status === 'CANCELLED')
  if (cancelled) return { state: 'CANCELLED', number: cancelled.number, words: `Incoming inspection ${cancelled.number} was cancelled; no other is recorded.` }
  return { state: 'NOT_INSPECTED', number: null, words: 'No incoming inspection is recorded for this lot.' }
}

export const SEPARATION_STATES = ['WAITING', 'KEPT', 'NOT_KEPT', 'NOT_RECORDED'] as const
export type SeparationState = (typeof SEPARATION_STATES)[number]

export interface SeparationFacts {
  readonly qualityStatus: string
  /** Who received it (Lot.createdById: the receiver; a child lot carries its parent's). */
  readonly receivedById: string | null
  /** Who made the last quality decision (Lot.qualityDecidedById). */
  readonly decidedById: string | null
  /** The person reading the page. */
  readonly viewerId: string | null
}

export interface SeparationCheck {
  readonly state: SeparationState
  /** The viewer received the lot: another person releases it. */
  readonly viewerReceived: boolean
  readonly words: string
}

/**
 * The separation of duties on release (Owner answer W3): the person who received the lot never releases it. In quarantine
 * the page says who may not (the viewer, when they received it); once released, whether the release kept the rule.
 */
export function separationCheck(facts: SeparationFacts): SeparationCheck {
  const viewerReceived = facts.viewerId !== null && facts.receivedById !== null && facts.viewerId === facts.receivedById
  if (facts.qualityStatus === 'QUARANTINE') {
    return {
      state: 'WAITING',
      viewerReceived,
      words: viewerReceived ? 'You received this lot: another person with the quality role releases it.' : 'Released by a person with the quality role who did not receive it.',
    }
  }
  if (facts.receivedById === null || facts.decidedById === null) return { state: 'NOT_RECORDED', viewerReceived, words: 'Who received or decided on this lot is not recorded (opening stock or a decision by the system).' }
  if (facts.receivedById === facts.decidedById) return { state: 'NOT_KEPT', viewerReceived, words: 'The person who received this lot also decided on it.' }
  return { state: 'KEPT', viewerReceived, words: 'Received and decided by two different people.' }
}
