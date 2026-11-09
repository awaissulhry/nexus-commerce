/**
 * Which spec a quote, an order or a work order is on, against the one in force (B-W2b-220), pure:
 *
 *   PRD-194 "spec drift warning at release": a quote or order line priced on one revision while another is the style's
 *           released one now, or a work order released on another revision than the one its order was quoted on — and how
 *           they differ (the compare's parts, ./compare differsOf) with the cost impact (the API's, cost grain only)
 *   PRD-195 "spec-changed banner on the floor": a newer revision exists for an open work order; the floor keeps to the
 *           frozen pages until the office decides (a change order's work-in-progress line, B-W2b-226: finish on the old
 *           spec, rework to the new, scrap or hold), and shows the new pages only after a decision to rework
 *
 * Every answer has a code a screen says in its own words, and the English words as a fallback.
 */

export interface RevisionRef {
  readonly id: string
  readonly revision: number
  readonly status: string
}

// ---- a newer spec for a work order (PRD-195) ------------------------------------------------------------------------------

export const NEWER_SPEC_STATES = ['CURRENT', 'NEWER_RELEASED', 'WITHDRAWN', 'NOT_RELEASED', 'NO_REVISION'] as const
export type NewerSpecState = (typeof NEWER_SPEC_STATES)[number]

/** What a change order decided for this work order (ChangeOrderItem WORK_IN_PROGRESS of an approved or released order). */
export const DISPOSITIONS = ['FINISH_OLD', 'REWORK', 'SCRAP', 'HOLD'] as const
export type Disposition = (typeof DISPOSITIONS)[number]

export interface Decision {
  readonly disposition: Disposition
  /** The change order's number (ECO-…). */
  readonly changeOrder: string
}

export interface NewerSpecFacts {
  /** The revision the work order is made to (frozen at its release); null: none chosen. */
  readonly pinned: RevisionRef | null
  /** The style's RELEASED revision now; null: none. */
  readonly released: RevisionRef | null
  readonly decision: Decision | null
}

export interface NewerSpec {
  readonly state: NewerSpecState
  /** A banner is due (a newer released revision, or the pinned one withdrawn). */
  readonly banner: boolean
  /** The new pages may be shown: the office decided to rework to the new spec. */
  readonly newPages: boolean
  readonly message: string
}

const DECIDED: Readonly<Record<Disposition, (decision: Decision, pinned: number, newer: number) => string>> = {
  FINISH_OLD: (decision, pinned) => `Decided in ${decision.changeOrder}: finish this work order on revision ${pinned}.`,
  REWORK: (decision, _pinned, newer) => `Decided in ${decision.changeOrder}: rework to revision ${newer}; the new pages apply.`,
  SCRAP: (decision) => `Decided in ${decision.changeOrder}: the work in progress is scrapped. Stop and ask your team leader.`,
  HOLD: (decision) => `Decided in ${decision.changeOrder}: the work order is held. Stop and ask your team leader.`,
}

export function newerSpecOf(facts: NewerSpecFacts): NewerSpec {
  const { pinned, released, decision } = facts
  if (!pinned) return { state: 'NO_REVISION', banner: false, newPages: false, message: 'No revision is chosen yet: the work order takes the released one when it is released.' }
  if (pinned.status === 'DRAFT') return { state: 'NOT_RELEASED', banner: false, newPages: false, message: `Revision ${pinned.revision} is a draft: release it before the work order.` }
  if (released && released.id === pinned.id) return { state: 'CURRENT', banner: false, newPages: false, message: `Made to revision ${pinned.revision}, the spec in force.` }
  if (!released) {
    return {
      state: 'WITHDRAWN',
      banner: true,
      newPages: false,
      message: `Revision ${pinned.revision} was withdrawn and no revision replaces it. Keep to the pages you have and ask the office before going on.`,
    }
  }
  const head = `A newer spec exists: revision ${released.revision}. This work order is made to revision ${pinned.revision}.`
  if (!decision) return { state: 'NEWER_RELEASED', banner: true, newPages: false, message: `${head} Keep to revision ${pinned.revision} until the office decides.` }
  return { state: 'NEWER_RELEASED', banner: true, newPages: decision.disposition === 'REWORK', message: `${head} ${DECIDED[decision.disposition](decision, pinned.revision, released.revision)}` }
}

// ---- drift of a quote, an order or a work order (PRD-194) --------------------------------------------------------------------

export const DRIFT_STATES = ['SAME', 'DIFFERENT', 'NO_REVISION', 'NO_RELEASED'] as const
export type DriftState = (typeof DRIFT_STATES)[number]

/** A document line's revision against the one it is compared with (the style's released one, or a work order's). */
export function driftOf(pinned: Pick<RevisionRef, 'id'> | null, target: Pick<RevisionRef, 'id'> | null): DriftState {
  if (!pinned) return 'NO_REVISION'
  if (!target) return 'NO_RELEASED'
  return pinned.id === target.id ? 'SAME' : 'DIFFERENT'
}

export const DOCUMENT_KINDS = ['QUOTE', 'ORDER', 'WORK_ORDER'] as const
export type DocumentKind = (typeof DOCUMENT_KINDS)[number]

const DOCUMENT_WORDS: Readonly<Record<DocumentKind, (number: string, seq: number | null) => string>> = {
  QUOTE: (number, seq) => `Quote ${number}${seq === null ? '' : ` line ${seq}`}`,
  ORDER: (number, seq) => `Order ${number}${seq === null ? '' : ` line ${seq}`}`,
  WORK_ORDER: (number) => `Work order ${number}`,
}

/**
 * "Order SEED-SO-0002 line 10 is on revision 1; revision 2 is the spec in force: BOM: 1 changed." — `against` names what the
 * other revision is ("the spec in force", "this work order's spec").
 */
export function driftWords(kind: DocumentKind, number: string, seq: number | null, pinned: number, other: number, against: string, differs: string): string {
  return `${DOCUMENT_WORDS[kind](number, seq)} is on revision ${pinned}; revision ${other} is ${against}: ${differs}.`
}
