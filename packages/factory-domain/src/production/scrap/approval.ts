import type { WorkOrderStatus } from '../work-orders/machine'
import { limitAt, scrapNeedsApproval, type LimitChange } from '../settings/floor-rules'

/**
 * Scrap above the site's limit waits for the team leader's approval (B-W2b-53; MES-128 "Scrap over a quantity or value
 * limit waits for a supervisor before it posts"; design floor.supervisor "Waiting for you", production.scrap "Waiting for
 * approval (over the limit)" and the DetailModal's approve or reject), pure.
 *
 * The scan counts at once (Owner answer F3: finishing a bundle is one tap; the bundle goes on to its next operation); its
 * scrap above the limit WAITS before it posts: no replacement (recut or lower quantity) is asked of it, no scrap of stock
 * names it and the cost ledger records its scrap only once it is approved. Which scans wait: a floor REPORT (from a
 * tablet; a correction is a lead's or the office's decision already, and an outside operation's report is the office's
 * receipt) that still stands (not undone or corrected), of a work order not CANCELLED or CLOSED, whose scrap is above
 * the limit in force when it was taken (a limit applies from its moment on: `limitAt`).
 *
 * The decision: APPROVED (the scrap posts) or REFUSED with a reason tile (the scrap does not post; the scan's counts are
 * put right by a correction, which voids the scan, and the new counts are judged again). Taken once; never by the person
 * who took the scan (four eyes: the worker it names, the account that wrote it, the office user that worker also is).
 * The team leader decides on the tablet (floor.lead, approve signs with the PIN), the office in Scrap & rework
 * (production.scrap.overLimit). No money on the floor: the limit is a count.
 */

export const SCRAP_DECISIONS = ['APPROVED', 'REFUSED'] as const
export type ScrapDecision = (typeof SCRAP_DECISIONS)[number]

/** A scan's scrap: waiting for the decision, approved, or refused. */
export const SCRAP_APPROVAL_STATES = ['WAITING', 'APPROVED', 'REFUSED'] as const
export type ScrapApprovalState = (typeof SCRAP_APPROVAL_STATES)[number]

export const DECIDED_ON = ['FLOOR', 'OFFICE'] as const
export type DecidedOn = (typeof DECIDED_ON)[number]

/** The audit action that records a decision (the decision's ledger; the step's schema gap names a table for it). */
export const SCRAP_DECISION_ACTION = 'production.decideScrapOverLimit'

/** The reason tiles of a refusal (the floor's FloorReasonGrid; OTHER asks for a note). Made-up wording a factory may not change yet. */
export const SCRAP_REFUSAL_REASONS = ['REWORK_INSTEAD', 'WRONG_COUNT', 'WRONG_REASON', 'OTHER'] as const
export type ScrapRefusalReason = (typeof SCRAP_REFUSAL_REASONS)[number]

export interface RefusalTile {
  readonly code: ScrapRefusalReason
  readonly labelIt: string
  readonly labelEn: string
  /** The design system's tag icon and swatch (factory-domain reasons/rules REASON_ICONS, REASON_COLOURS). */
  readonly icon: string
  readonly colour: string
  readonly needsDetail: boolean
}

export const SCRAP_REFUSAL_TILES: readonly RefusalTile[] = Object.freeze([
  Object.freeze({ code: 'REWORK_INSTEAD', labelIt: 'Si può riparare: rilavorazione', labelEn: 'It can be repaired: rework', icon: 'shirt', colour: '#1f6fde', needsDetail: false }),
  Object.freeze({ code: 'WRONG_COUNT', labelIt: 'Conteggio sbagliato', labelEn: 'Wrong count', icon: 'alert', colour: '#ea580c', needsDetail: false }),
  Object.freeze({ code: 'WRONG_REASON', labelIt: 'Motivo sbagliato', labelEn: 'Wrong reason', icon: 'flag', colour: '#b87503', needsDetail: false }),
  Object.freeze({ code: 'OTHER', labelIt: 'Altro', labelEn: 'Other', icon: 'bookmark', colour: '#5b6573', needsDetail: true }),
] as const satisfies readonly RefusalTile[])

export const isScrapRefusalReason = (value: unknown): value is ScrapRefusalReason => (SCRAP_REFUSAL_REASONS as readonly unknown[]).includes(value)

export const NOTE_MAX = 500

export const OVER_LIMIT_REFUSALS = ['NOT_OVER_LIMIT', 'DECIDED_ALREADY', 'SELF_DECISION', 'SCAN_VOIDED', 'WORK_ORDER_CLOSED', 'NOTE_NEEDED', 'NOT_A_FLOOR_REPORT'] as const
export type OverLimitRefusalCode = (typeof OVER_LIMIT_REFUSALS)[number]

export interface OverLimitRefusal {
  readonly code: OverLimitRefusalCode
  readonly message: string
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** The statuses whose scrap no longer waits for anything (the work order is over). */
export const OVER_STATUSES: readonly WorkOrderStatus[] = Object.freeze(['CANCELLED', 'CLOSED'])

/** A scan as the approval reads it. */
export interface ApprovalScan {
  readonly kind: string
  readonly scrapQuantity: number
  readonly serverTime: Date
  /** A floor report comes from a tablet. */
  readonly deviceId: string | null
  /** An outside operation's report (the office's receipt), never a floor report. */
  readonly subcontractReceiptLineId: string | null
}

/** Is this a floor report the limit applies to (a REPORT from a tablet, not an outside operation's)? */
export const isFloorReport = (scan: ApprovalScan): boolean => scan.kind === 'REPORT' && scan.deviceId !== null && scan.subcontractReceiptLineId === null

/** The limit in force when the scan was taken, and whether its scrap is above it. */
export function overLimitOf(scan: ApprovalScan, history: readonly LimitChange[], current: number | null): { readonly limit: number | null; readonly over: boolean } {
  if (!isFloorReport(scan)) return { limit: null, over: false }
  const limit = limitAt(history, current, scan.serverTime)
  return { limit, over: scrapNeedsApproval(scan.scrapQuantity, limit) }
}

/**
 * The scan's scrap approval: null when none is needed (under the limit, no limit, not a floor report), or when the scan no
 * longer stands (a correction replaced it) and nothing was decided; else WAITING until a decision, then the decision.
 */
export function approvalStateOf(facts: { readonly over: boolean; readonly standing: boolean; readonly decision: ScrapDecision | null }): ScrapApprovalState | null {
  if (facts.decision) return facts.decision
  if (!facts.over || !facts.standing) return null
  return 'WAITING'
}

/** Waiting scrap stops its posting (a replacement, a scrap of stock, the cost); refused scrap never posts. */
export function postingHeldWords(state: ScrapApprovalState | null, scrapQuantity: number, limit: number | null): string | null {
  if (state === 'WAITING') return `${plural(scrapQuantity, 'piece')} scrapped in one scan is above this site's limit of ${limit ?? 0}: it waits for the team leader's approval before it posts.`
  if (state === 'REFUSED') return "The team leader refused this scan's scrap: it does not post. Correct the scan's counts first (a correction), then ask again."
  return null
}

export interface DecisionFacts {
  readonly decision: ScrapDecision
  readonly scan: ApprovalScan & { readonly bundleCode: string }
  readonly limit: number | null
  readonly over: boolean
  readonly standing: boolean
  readonly workOrder: { readonly number: string; readonly status: WorkOrderStatus }
  readonly decidedAlready: ScrapDecision | null
  /** The decider is the person who took the scan (its worker, the account that wrote it, or that worker's office user). */
  readonly selfDecision: boolean
  readonly reason: ScrapRefusalReason | null
  readonly note: string | null
}

/** Why the decision may not be taken, or null. */
export function decisionRefusal(facts: DecisionFacts): OverLimitRefusal | null {
  if (facts.decidedAlready) return { code: 'DECIDED_ALREADY', message: `The scrap of bundle ${facts.scan.bundleCode} was ${facts.decidedAlready.toLowerCase()} already.` }
  if (!isFloorReport(facts.scan)) return { code: 'NOT_A_FLOOR_REPORT', message: 'Only a report from a tablet waits for an approval of its scrap.' }
  if (!facts.standing) return { code: 'SCAN_VOIDED', message: `The scan of bundle ${facts.scan.bundleCode} was undone or corrected since: its scrap waits for nothing.` }
  if (!facts.over) {
    return {
      code: 'NOT_OVER_LIMIT',
      message: facts.limit === null ? 'This site had no scrap limit when the scan was taken: its scrap needs no approval.' : `${plural(facts.scan.scrapQuantity, 'piece')} is not above the limit of ${facts.limit} in force when the scan was taken: no approval is needed.`,
    }
  }
  if (OVER_STATUSES.includes(facts.workOrder.status)) return { code: 'WORK_ORDER_CLOSED', message: `Work order ${facts.workOrder.number} is ${facts.workOrder.status}: its scrap waits for nothing.` }
  if (facts.selfDecision) return { code: 'SELF_DECISION', message: 'You took this scan: another team leader or the production office decides its scrap (four eyes).' }
  if (facts.decision === 'REFUSED') {
    if (!facts.reason) return { code: 'NOTE_NEEDED', message: 'Pick why the scrap is refused.' }
    const tile = SCRAP_REFUSAL_TILES.find((entry) => entry.code === facts.reason)
    if (tile?.needsDetail && !facts.note) return { code: 'NOTE_NEEDED', message: 'Say in a few words why the scrap is refused.' }
  }
  return null
}

/** What the decision means, in words (the answer and the floor's toast). */
export function decisionWords(decision: ScrapDecision, scrapQuantity: number, bundleCode: string): string {
  return decision === 'APPROVED'
    ? `${plural(scrapQuantity, 'piece')} of bundle ${bundleCode} approved as scrap: it posts now (replacement, scrap of stock, cost).`
    : `The scrap of bundle ${bundleCode} is refused: it does not post. The scan's counts are put right by a correction.`
}

/** The refusal tile's words in English (the audit row's reason keeps them with the note). */
export function refusalReasonText(reason: ScrapRefusalReason, note: string | null): string {
  const tile = SCRAP_REFUSAL_TILES.find((entry) => entry.code === reason)!
  return note ? `${tile.labelEn}: ${note}` : tile.labelEn
}
