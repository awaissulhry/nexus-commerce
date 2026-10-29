import { NOT_COUNTED_WORDS, usabilityOf, type LotQuality, type UnusableReason } from '../../planning/usable'
import type { WorkOrderStatus } from '../../production/work-orders/machine'
import { Dec, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'
import { quantityText } from '../ledger/moves'

/**
 * Picking and issuing to a work order (B-W1-39; SCM-215, SCM-194, SCM-216; PLAN §4.7 stage 11a-issue; A2 SCR-093), pure:
 * what may be issued to a work order, what may come back from it, and when an issue may be undone or reversed. The API
 * (apps/factory-api modules/inventory/issue) reads the facts inside the issuing command, under the work order's issue
 * lock, and posts the moves through the ledger's one writer (postMoves): the …_supply_guards trigger stays the last word
 * on RELEASED lots, used-up hides and stock never below zero.
 *
 *   issue      only to a RELEASED or IN_PROGRESS work order; only material it plans, in the colour it plans; only usable
 *              stock (a RELEASED lot, with a chromium VI PASS where the test is required: planning/usable); never a
 *              CONSUMED or SCRAPPED hide. A hide is issued whole, with what it measures on hand (its area, or what a
 *              returned remnant measured); a lot or an untracked material by quantity, by default what the work order
 *              still needs of it (up to what is on hand). More than the work order still needs is an over-issue: only
 *              with a reason (the office). A hide counts as an over-issue only when nothing is left to issue: a hide is
 *              never cut to fit the need.
 *   return     what the work order did not use goes back to a location of its site, measured (a remnant's area, a roll's
 *              metres): at most what the work order holds of that stock (issued minus returned) and, for a hide, minus
 *              what was cut of it. A hide that left part of itself with the work order comes back as a REMNANT.
 *   undo       the poster's own last issue, before its next stock action (the floor's "Undo" strip): mirror moves.
 *   reversal   any issue or return, by the office with the reason: mirror moves (the ledger's reversal rule). Reversing
 *              an issue of a hide gives its area back to stock, so what was cut of it must still fit what stays.
 *
 * Quantities are in the item's base unit, as decimals (decimal.js), never floats.
 */

/** A work order receives stock only while it is released or in progress. */
export const ISSUABLE_STATUSES: readonly WorkOrderStatus[] = Object.freeze(['RELEASED', 'IN_PROGRESS'])

export const HIDE_STATES = ['FULL', 'PARTLY_CUT', 'REMNANT', 'CONSUMED', 'SCRAPPED'] as const
export type HideState = (typeof HIDE_STATES)[number]

/** Why an issue, a return, an undo or a reversal is refused: a stable code (the screens' words) and its sentence. */
export const REFUSALS = [
  'WORK_ORDER_NOT_OPEN',
  'NOT_IN_WORK_ORDER',
  'OTHER_COLOUR',
  'CR_VI_PENDING',
  'CR_VI_FAILED',
  'QUALITY_HOLD',
  'BLOCKED',
  'REJECTED',
  'HIDE_USED_UP',
  'NOTHING_ON_HAND',
  'ALREADY_ISSUED',
  'MORE_THAN_ON_HAND',
  'OVER_ISSUE',
  'NOTHING_AT_WORK_ORDER',
  'MORE_THAN_AT_WORK_ORDER',
  'ALREADY_CUT',
  'NOT_LAST_ACTION',
  'REVERSED_ALREADY',
] as const
export type RefusalCode = (typeof REFUSALS)[number]

export interface Refusal {
  readonly code: RefusalCode
  readonly message: string
}

const refuse = (code: RefusalCode, message: string): { readonly ok: false; readonly refusal: Refusal } => ({ ok: false, refusal: { code, message } })
const dec = (value: DecimalInput): Decimal => new Dec(value)
const text = quantityText

/** The words of a lot that is not usable, for an issue refusal ('Lot L-1 is on quality hold (…): it cannot be issued.'). */
export function unusableWords(lotCode: string, reason: UnusableReason): string {
  return `Lot ${lotCode}: ${NOT_COUNTED_WORDS[reason]}. Only released stock is issued (REACH Annex XVII entry 47: chromium VI).`
}

// ---- issue ----------------------------------------------------------------------------------------------------------------

export interface IssueFacts {
  readonly workOrder: { readonly number: string; readonly status: WorkOrderStatus }
  /** The stock asked for: its material label ('LEATHER BLK') for the sentences. */
  readonly label: string
  readonly baseUom: string
  /** The work order's line for the stock's material and colour (planned and net issued so far); null: it plans none. */
  readonly line: { readonly planned: DecimalInput; readonly issued: DecimalInput } | null
  /** The work order plans the material in another colour (so the stock is of the wrong colour). */
  readonly materialPlanned: boolean
  readonly lot: (LotQuality & { readonly code: string }) | null
  readonly hide: { readonly code: string; readonly state: HideState } | null
  /** What is on hand of the stock at the site now (every location), in the base unit. */
  readonly onHand: DecimalInput
  /** A hide: none (issued whole). A lot or material: the base quantity asked, or null for the default. */
  readonly requested: DecimalInput | null
  /** The over-issue's reason, when the caller gives one (the API checks it may). */
  readonly overIssueReason: string | null
}

export type IssueDecision =
  | { readonly ok: true; readonly baseQuantity: string; readonly overIssue: boolean; readonly toIssue: string }
  | { readonly ok: false; readonly refusal: Refusal }

/** What the work order still needs of a line: planned − issued, from 0. */
export const stillToIssue = (line: { readonly planned: DecimalInput; readonly issued: DecimalInput }): Decimal => Dec.max(ZERO, dec(line.planned).minus(dec(line.issued)))

/** Whether this stock may be issued to the work order, and how much (rules in the header). */
export function issueDecision(facts: IssueFacts): IssueDecision {
  const { workOrder, label, baseUom } = facts
  if (!ISSUABLE_STATUSES.includes(workOrder.status)) {
    return refuse('WORK_ORDER_NOT_OPEN', `Work order ${workOrder.number} is ${workOrder.status}; stock is issued only to a RELEASED or IN_PROGRESS work order.`)
  }
  if (!facts.line) {
    return facts.materialPlanned
      ? refuse('OTHER_COLOUR', `Work order ${workOrder.number} needs this material in another colour; this stock is ${label}.`)
      : refuse('NOT_IN_WORK_ORDER', `Work order ${workOrder.number} does not use ${label}.`)
  }
  if (facts.lot) {
    const usability = usabilityOf(facts.lot)
    if (!usability.usable) return refuse(usability.reason, unusableWords(facts.lot.code, usability.reason))
  }
  if (facts.hide && (facts.hide.state === 'CONSUMED' || facts.hide.state === 'SCRAPPED')) {
    return refuse('HIDE_USED_UP', `Hide ${facts.hide.code} is ${facts.hide.state === 'CONSUMED' ? 'used up' : 'scrapped'}; it is not issued.`)
  }
  const onHand = dec(facts.onHand)
  if (onHand.lte(0)) return refuse('NOTHING_ON_HAND', `None of ${facts.hide ? `hide ${facts.hide.code}` : label} is in stock at this site.`)

  const toIssue = stillToIssue(facts.line)
  const reason = facts.overIssueReason?.trim() || null
  let quantity: Decimal
  let over: boolean
  if (facts.hide) {
    quantity = onHand
    over = toIssue.lte(0)
  } else {
    const asked = facts.requested === null ? null : dec(facts.requested)
    quantity = asked ?? Dec.min(toIssue, onHand)
    if (quantity.lte(0)) {
      return refuse('OVER_ISSUE', `Work order ${workOrder.number} has all it needs of ${label}. More is an over-issue: the office issues it with a reason and its quantity.`)
    }
    if (quantity.gt(onHand)) return refuse('MORE_THAN_ON_HAND', `Only ${text(onHand)} ${baseUom} of ${label} is in stock at this site; the issue asks ${text(quantity)}.`)
    over = quantity.gt(toIssue)
  }
  if (over && !reason) {
    const needs = toIssue.lte(0)
      ? `has all it needs of ${label} (planned ${text(facts.line.planned)} ${baseUom}, issued ${text(facts.line.issued)})`
      : `still needs ${text(toIssue)} ${baseUom} of ${label}; the issue is ${text(quantity)}`
    return refuse('OVER_ISSUE', `Work order ${workOrder.number} ${needs}. More is an over-issue: the office issues it with a reason.`)
  }
  return { ok: true, baseQuantity: text(quantity), overIssue: over, toIssue: text(toIssue) }
}

// ---- return ---------------------------------------------------------------------------------------------------------------

export interface ReturnFacts {
  readonly workOrder: { readonly number: string }
  readonly label: string
  readonly baseUom: string
  /** What the work order holds of this stock: issued minus returned (the ledger), in the base unit. */
  readonly atWorkOrder: DecimalInput
  /** A hide: what was cut of it for the work order (its cut log, net of reversals); else 0. */
  readonly cut: DecimalInput
  readonly hide: { readonly code: string; readonly state: HideState } | null
  /** The measured quantity coming back, in the base unit. */
  readonly baseQuantity: DecimalInput
}

export type ReturnDecision = { readonly ok: true; readonly hideState: HideState | null } | { readonly ok: false; readonly refusal: Refusal }

/** Whether this much may come back from the work order, and the hide's state after it (rules in the header). */
export function returnDecision(facts: ReturnFacts): ReturnDecision {
  const at = dec(facts.atWorkOrder)
  const cut = dec(facts.cut)
  const back = dec(facts.baseQuantity)
  const what = facts.hide ? `hide ${facts.hide.code}` : facts.label
  if (facts.hide && (facts.hide.state === 'CONSUMED' || facts.hide.state === 'SCRAPPED')) {
    return refuse('HIDE_USED_UP', `Hide ${facts.hide.code} is ${facts.hide.state === 'CONSUMED' ? 'used up' : 'scrapped'}; nothing of it comes back.`)
  }
  if (at.lte(0)) return refuse('NOTHING_AT_WORK_ORDER', `Work order ${facts.workOrder.number} holds none of ${what}: nothing of it was issued, or it all came back.`)
  const free = at.minus(cut)
  if (back.gt(free)) {
    return cut.gt(0)
      ? refuse('MORE_THAN_AT_WORK_ORDER', `Work order ${facts.workOrder.number} holds ${text(at)} ${facts.baseUom} of ${what} and ${text(cut)} of it was cut; at most ${text(Dec.max(ZERO, free))} comes back.`)
      : refuse('MORE_THAN_AT_WORK_ORDER', `Work order ${facts.workOrder.number} holds ${text(at)} ${facts.baseUom} of ${what}; the return is ${text(back)}.`)
  }
  return { ok: true, hideState: facts.hide ? hideStateAfterReturn(facts.hide.state, back.equals(at) && cut.isZero()) : null }
}

/** A hide that comes back whole (nothing cut, all of it) keeps its state; one that left part of itself is a REMNANT. */
export function hideStateAfterReturn(state: HideState, whole: boolean): HideState {
  if (state === 'CONSUMED' || state === 'SCRAPPED') return state
  return whole ? state : 'REMNANT'
}

// ---- undo and reversal ------------------------------------------------------------------------------------------------------

/** A move as the undo and the reversal read it. */
export interface PickedMove {
  readonly id: string
  readonly reason: string
  readonly workOrderId: string | null
  readonly reversalOfId: string | null
  readonly hideId: string | null
  readonly baseQuantity: DecimalInput
  readonly fromLocationId: string | null
  readonly toLocationId: string | null
}

/**
 * Why these moves (one issue or one return: the moves of one command) cannot be reversed, or null. `reversed`: some
 * of them have a reversal already. For an issue of a hide, `hide` gives what the work order holds of it and what was
 * cut: giving the issue back to stock must leave what was cut.
 */
export function reversalRefusal(
  moves: readonly PickedMove[],
  facts: { readonly reversed: boolean; readonly workOrderNumber: string; readonly hide?: { readonly code: string; readonly atWorkOrder: DecimalInput; readonly cut: DecimalInput; readonly baseUom: string } | null },
): Refusal | null {
  if (moves.length === 0 || moves.some((move) => move.reversalOfId !== null || (move.reason !== 'ISSUE' && move.reason !== 'RETURN') || move.workOrderId === null)) {
    return { code: 'NOT_IN_WORK_ORDER', message: 'Only an issue to a work order or a return from it is reversed here (never a reversal).' }
  }
  if (facts.reversed) return { code: 'REVERSED_ALREADY', message: 'This was reversed already; a move has at most one reversal.' }
  const hide = facts.hide
  if (hide && moves[0]!.reason === 'ISSUE') {
    const giving = moves.reduce((sum, move) => sum.plus(dec(move.baseQuantity)), ZERO)
    const stays = dec(hide.atWorkOrder).minus(giving)
    if (stays.lt(dec(hide.cut))) {
      return {
        code: 'ALREADY_CUT',
        message: `${text(hide.cut)} ${hide.baseUom} of hide ${hide.code} was already cut for work order ${facts.workOrderNumber}; the issue is not taken back. Return the remnant instead.`,
      }
    }
  }
  return null
}

/**
 * The floor's undo (and the office's own): only the poster's last stock action, before its next one. `latest` is the
 * id of the poster's newest move at the site (a device's, or an office user's own).
 */
export function undoRefusal(moves: readonly PickedMove[], latest: string | null): Refusal | null {
  if (moves.length === 0 || moves[0]!.reason !== 'ISSUE') return { code: 'NOT_IN_WORK_ORDER', message: 'Only an issue is undone.' }
  if (latest === null || !moves.some((move) => move.id === latest)) {
    return { code: 'NOT_LAST_ACTION', message: 'Only the last issue is undone, before the next action; ask the office to reverse an older one.' }
  }
  return null
}
