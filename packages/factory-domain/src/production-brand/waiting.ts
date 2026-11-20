import type { ApprovalTaskKind } from '../approvals/rules' // B-OO-011

/**
 * B-PR-13 (production plan §4 "Waiting on"; 07-control §4.1): who an order in production waits on, pure. The API finds the
 * blockers of the customer's own order from real data; each has an owner and the time it started:
 *
 *   the customer   an approval asked of it is open (sample, PP, size set, TOP, colour, leather, fabric, trims, artwork,
 *                  proof, concession, a revised order to confirm); a task of ours waits for it (a new date to answer, how
 *                  to ship); the deposit is unpaid while it holds the release; material it supplies has not all come; it
 *                  asked for a pause that holds
 *   a supplier     a material is short and its purchase comes after the need, or a trims gate waits for the goods
 *   a workshop     an operation is out at a subcontractor and the pieces are not back
 *   us             a request of the customer waits for our answer; a gate we own, a release check, a quality hold or
 *                  nonconformance, or work that does not move
 *
 * The order waits on the first owner with a blocker in this order: customer → supplier → workshop → us, since its earliest
 * blocker; with no blocker it waits on us (the work is ours). The office reads the four; the customer reads only two: "You"
 * or "Us" — a supplier and a workshop are the factory's business and are never named to it.
 */
export const WAITING_ON = ['BRAND', 'SUPPLIER', 'WORKSHOP', 'US'] as const
export type WaitingOn = (typeof WAITING_ON)[number]

export const BLOCKER_KINDS = [
  'APPROVAL',
  'PARTNER_TASK',
  'DEPOSIT',
  'CUSTOMER_MATERIAL',
  'BRAND_PAUSE',
  'MATERIAL_SHORT',
  'SUBCONTRACT',
  'BRAND_REQUEST',
  'GATE',
  'RELEASE_CHECK',
  'QUALITY_HOLD',
  'NONCONFORMANCE',
  'NO_MOVE',
] as const
export type BlockerKind = (typeof BLOCKER_KINDS)[number]

/** Whose move each blocker waits for. */
export const BLOCKER_OWNER: Readonly<Record<BlockerKind, WaitingOn>> = Object.freeze({
  APPROVAL: 'BRAND',
  PARTNER_TASK: 'BRAND',
  DEPOSIT: 'BRAND',
  CUSTOMER_MATERIAL: 'BRAND',
  BRAND_PAUSE: 'BRAND',
  MATERIAL_SHORT: 'SUPPLIER',
  SUBCONTRACT: 'WORKSHOP',
  BRAND_REQUEST: 'US',
  GATE: 'US',
  RELEASE_CHECK: 'US',
  QUALITY_HOLD: 'US',
  NONCONFORMANCE: 'US',
  NO_MOVE: 'US',
})

// ── B-OP-021 (order page plan N1; 13-backend §3 B4): what an office blocker names — the office only (the customer's reads keep
// `waiting` alone, and FORBIDDEN_BRAND_KEYS holds `blockers` out of every customer read) ──
/**
 * A customer request that waits on us, by what it is: a request still OPEN, a counter-offer it agreed to or that lapsed (ours to
 * carry out or answer), a problem it reported, a new date it refused (its follow-up open).
 */
export const BLOCKER_SUBS = ['REQUEST', 'COUNTER', 'PROBLEM', 'REPROMISE'] as const
export type BlockerSub = (typeof BLOCKER_SUBS)[number]

/** The one record a blocker is about (the order page's door to it): its model and id. */
export interface BlockerRef {
  readonly type: string
  readonly id: string
  /** F-OP-103: a problem the customer reported — the message it was raised with in the order's own thread (Reply in the thread). */
  readonly messageId?: string | null
}
// ── end B-OP-021 ──

export interface Blocker {
  readonly kind: BlockerKind
  /** When it started (asked, opened, held, issued…; null: not known). */
  readonly since: Date | null
  /** B-OP-021 (office only): the record it is about; null or absent: no one record (a material the plan finds late). */
  readonly ref?: BlockerRef | null
  /** B-OP-021 (office only): what a BRAND_REQUEST is; null or absent for every other kind. */
  readonly sub?: BlockerSub | null
}

export interface Waiting {
  readonly on: WaitingOn
  /** The earliest known start of that owner's blockers (null: none known, or nothing blocks). */
  readonly since: Date | null
}

/** Who the order waits on: the first owner with a blocker (customer → supplier → workshop → us), else us. */
export function waitingOn(blockers: readonly Blocker[]): Waiting {
  for (const on of WAITING_ON) {
    const mine = blockers.filter((blocker) => BLOCKER_OWNER[blocker.kind] === on)
    if (mine.length === 0) continue
    const known = mine.flatMap((blocker) => (blocker.since === null ? [] : [blocker.since.getTime()]))
    return { on, since: known.length > 0 ? new Date(Math.min(...known)) : null }
  }
  return { on: 'US', since: null }
}

// ── B-OO-011 (order overview plan §9; review F3, F15): ONE place per waiting row — the office only ──
/**
 * Where the order page shows each thing the order waits for, decided once here (the web stamps it, the office read uses it):
 *
 *   HOLD     something stops the work: the deposit, the customer's pause, our production hold, a quality hold, a nonconformance,
 *            the release check — Where it is now
 *   DATE     something has a day: a gate, a short material, work out at a workshop, the customer's own material, and a new date
 *            the customer refused (BRAND_REQUEST · REPROMISE: answered with the promise, so it leaves the Changes badge) — Next dates
 *   REQUEST  someone must answer: a customer request still open, a counter-offer agreed or lapsed, a problem it reported, a yes
 *            asked of the customer, an open task on its portal — Requests & changes
 *
 * Who acts next stays `waitingOn` (the keeper's one rule, read by the orders list and the portal): a place never changes it.
 */
export const BLOCKER_PLACES = ['HOLD', 'DATE', 'REQUEST'] as const
export type BlockerPlace = (typeof BLOCKER_PLACES)[number]

/** Each blocker kind's place (a BRAND_REQUEST's own place follows its sub: BRAND_REQUEST_PLACE). */
export const BLOCKER_PLACE: Readonly<Record<BlockerKind, BlockerPlace>> = Object.freeze({
  APPROVAL: 'REQUEST',
  PARTNER_TASK: 'REQUEST',
  DEPOSIT: 'HOLD',
  CUSTOMER_MATERIAL: 'DATE',
  BRAND_PAUSE: 'HOLD',
  MATERIAL_SHORT: 'DATE',
  SUBCONTRACT: 'DATE',
  BRAND_REQUEST: 'REQUEST',
  GATE: 'DATE',
  RELEASE_CHECK: 'HOLD',
  QUALITY_HOLD: 'HOLD',
  NONCONFORMANCE: 'HOLD',
  NO_MOVE: 'HOLD',
})

/** A customer request waiting on us, by what it is: a refused new date is a date (F3); the others are requests. */
export const BRAND_REQUEST_PLACE: Readonly<Record<BlockerSub, BlockerPlace>> = Object.freeze({
  REQUEST: 'REQUEST',
  COUNTER: 'REQUEST',
  PROBLEM: 'REQUEST',
  REPROMISE: 'DATE',
})

/** The place of one blocker, keyed on its kind and, for a BRAND_REQUEST, its sub (none: a request). */
export function placeOf(blocker: { readonly kind: BlockerKind; readonly sub?: BlockerSub | null }): BlockerPlace {
  if (blocker.kind === 'BRAND_REQUEST' && blocker.sub) return BRAND_REQUEST_PLACE[blocker.sub]
  return BLOCKER_PLACE[blocker.kind]
}

/**
 * The yes the order read lists (`openApprovals`: the approval engine's kinds of one order — its own SALES_ORDER, an old
 * SALES_ORDER_CHANGE, a CREDIT_OVERRIDE of its credit hold) and each one's place: the order's yes and the credit hold stop the
 * order (HOLD); a yes for a change of a confirmed order is a request (REQUEST).
 */
export const ORDER_YES_KINDS = ['SALES_ORDER', 'SALES_ORDER_CHANGE', 'CREDIT_OVERRIDE'] as const satisfies readonly ApprovalTaskKind[]
export type OrderYesKind = (typeof ORDER_YES_KINDS)[number]

export const YES_PLACE: Readonly<Record<OrderYesKind, BlockerPlace>> = Object.freeze({
  SALES_ORDER: 'HOLD',
  CREDIT_OVERRIDE: 'HOLD',
  SALES_ORDER_CHANGE: 'REQUEST',
})
// ── end B-OO-011 ──

/** What the customer reads: only You or Us. */
export const BRAND_SIDES = ['YOU', 'US'] as const
export type BrandSide = (typeof BRAND_SIDES)[number]

/** The customer's side of a waiting owner (a supplier or a workshop reads as us). */
export const brandSideOf = (on: WaitingOn): BrandSide => (on === 'BRAND' ? 'YOU' : 'US')
