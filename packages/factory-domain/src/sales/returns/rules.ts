import type { Issue } from '../../core/errors'
import { minorPlaces, toMinorUnits, type CurrencyCode, type MinorUnits } from '../../core/money'
import type { BusinessDate } from '../../core/time'
import { Dec, parseDecimal } from '../../tax/decimal'

/**
 * Customer returns (B-W2a-43; SAL-333 the RMA, SAL-335 its lines from the invoiced order, SAL-340 reason codes, SAL-341
 * the disposition that decides the outcome, SAL-352 the replacement order, SAL-362 status and tracking, LOG-114 the dock
 * receipt, QHS-117 inspection and grading), pure. apps/factory-api's modules/sales/returns says these rules in words
 * before the database's …_sales_w2a_guards triggers would refuse the same, and builds every answer from them.
 *
 *   the RMA      AUTHORISED when the office makes it (REQUESTED is the W2b portal's), numbered from the company's RETURN
 *                series; RECEIVED with its first dock receipt; INSPECTED once every received line is decided (back to
 *                RECEIVED when more goods come); CLOSED with a finish reason; CANCELLED before the goods arrive. The goods
 *                are due back by the return policy's days from the authorisation.
 *   its lines    copied from what the customer was invoiced (an invoice line, with its order line and size when it bills
 *                one) or shipped and not yet invoiced (an order line and size): never more pieces than were sold, less
 *                what other live RMAs take back. Changed or removed only before the goods arrive.
 *   the dock     each arrival is a receipt (parcels, their condition, the customer's DDT, photos) with the pieces of each
 *                line; a line receives at most its pieces.
 *   grading      each received line gets its grade (new … unusable), the cause found and its condition in words.
 *   deciding     each graded line gets what the customer gets (REPAIR, REPLACE, CREDIT_ONLY, RETURN_UNCHANGED, SCRAP;
 *                REMAKE is the made-to-measure remake of W2b) and where the goods go (RESTOCK, SECOND_QUALITY,
 *                QUARANTINE, REPAIR, SCRAP, BACK_TO_CUSTOMER), and a credit value from 0 to what came back is worth.
 *                A used protective garment never goes back into stock as new; one returned for a defect (or found
 *                defective or misused) goes back on the market only after a safety check: repaired (the repair checks
 *                it), held in quarantine or scrapped.
 */

export const RETURN_STATUSES = ['REQUESTED', 'AUTHORISED', 'RECEIVED', 'INSPECTED', 'CLOSED', 'REJECTED', 'CANCELLED'] as const
export type ReturnStatus = (typeof RETURN_STATUSES)[number]
export const FINAL_RETURN_STATUSES: readonly ReturnStatus[] = Object.freeze(['CLOSED', 'REJECTED', 'CANCELLED'])
export const OPEN_RETURN_STATUSES: readonly ReturnStatus[] = Object.freeze(['REQUESTED', 'AUTHORISED', 'RECEIVED', 'INSPECTED'])
/** What comes back is fixed once the goods arrived. */
export const BEFORE_GOODS: readonly ReturnStatus[] = Object.freeze(['REQUESTED', 'AUTHORISED'])
/** The dock receives while the RMA is open to goods. */
export const RECEIVING_STATUSES: readonly ReturnStatus[] = Object.freeze(['AUTHORISED', 'RECEIVED', 'INSPECTED'])
/** Grading and deciding happen once goods are here, before the RMA closes. */
export const DECIDING_STATUSES: readonly ReturnStatus[] = Object.freeze(['RECEIVED', 'INSPECTED'])

export const RETURN_GRADES = ['NEW', 'LIKE_NEW', 'GOOD', 'DAMAGED', 'UNUSABLE'] as const
export type ReturnGrade = (typeof RETURN_GRADES)[number]
export const RETURN_CAUSES = ['OUR_DEFECT', 'TRANSIT', 'MISUSE', 'WEAR', 'NO_FAULT'] as const
export type ReturnCause = (typeof RETURN_CAUSES)[number]
export const RETURN_DISPOSITIONS = ['REPAIR', 'REMAKE', 'REPLACE', 'CREDIT_ONLY', 'RETURN_UNCHANGED', 'SCRAP'] as const
export type ReturnDisposition = (typeof RETURN_DISPOSITIONS)[number]
export const GOODS_OUTCOMES = ['RESTOCK', 'SECOND_QUALITY', 'QUARANTINE', 'REPAIR', 'SCRAP', 'BACK_TO_CUSTOMER'] as const
export type GoodsOutcome = (typeof GOODS_OUTCOMES)[number]
export const PARCEL_CONDITIONS = ['INTACT', 'DAMAGED', 'OPENED'] as const
export type ParcelCondition = (typeof PARCEL_CONDITIONS)[number]
export const FREIGHT_PAYERS = ['CUSTOMER', 'COMPANY', 'BY_CAUSE'] as const
export type FreightPayer = (typeof FREIGHT_PAYERS)[number]

/** The reason list the customer's reasons come from (B-W2a-18). */
export const RETURN_REASON_LIST = 'RETURN' as const

export const RETURN_LIMITS = Object.freeze({
  lines: 100,
  description: 300,
  reasonNote: 500,
  serial: 60,
  batchNumber: 60,
  customerRef: 80,
  internalNote: 2000,
  statusReason: 500,
  conditionNote: 1000,
  carrierName: 120,
  trackingNumber: 80,
  ddtNumber: 40,
  receiptNote: 1000,
  parcels: 99,
  photos: 12,
  conditions: 2000,
  /** The days of the return window and of the goods' deadline. */
  days: 365,
  /** At most this many returns in one list answer. */
  list: 200,
})

// ---- the RMA's moves (the …_sales_w2a_guards trigger's) -------------------------------------------------------------

export const RETURN_MOVES: Readonly<Record<ReturnStatus, readonly ReturnStatus[]>> = Object.freeze({
  REQUESTED: ['AUTHORISED', 'REJECTED', 'CANCELLED'],
  AUTHORISED: ['RECEIVED', 'CANCELLED', 'CLOSED'],
  RECEIVED: ['INSPECTED', 'CLOSED'],
  INSPECTED: ['RECEIVED', 'CLOSED'],
  CLOSED: [],
  REJECTED: [],
  CANCELLED: [],
})

export const canMove = (from: ReturnStatus, to: ReturnStatus): boolean => RETURN_MOVES[from].includes(to)
export const isFinal = (status: ReturnStatus): boolean => FINAL_RETURN_STATUSES.includes(status)

// ---- the return policy (SalesSettings return*) ----------------------------------------------------------------------

export interface ReturnPolicy {
  /** Days from delivery the customer may ask for a return; null: no window. */
  readonly windowDays: number | null
  /** Days from the authorisation the goods must arrive in; null: no deadline. */
  readonly goodsDueDays: number | null
  readonly freightPaidBy: FreightPayer | null
  /** Percent of the credited value, above 0 and at most 100 (W2b applies it: SAL-343). */
  readonly restockingFeePct: string | null
  readonly conditions: string | null
}

export const NO_POLICY: ReturnPolicy = Object.freeze({ windowDays: null, goodsDueDays: null, freightPaidBy: null, restockingFeePct: null, conditions: null })

/** The policy in force: a company's own value of each field, else the tenant's (each field on its own). */
export function policyInForce(company: Partial<ReturnPolicy> | null, tenant: Partial<ReturnPolicy> | null): ReturnPolicy {
  const pick = <K extends keyof ReturnPolicy>(key: K): ReturnPolicy[K] => (company?.[key] ?? tenant?.[key] ?? null) as ReturnPolicy[K]
  return { windowDays: pick('windowDays'), goodsDueDays: pick('goodsDueDays'), freightPaidBy: pick('freightPaidBy'), restockingFeePct: pick('restockingFeePct'), conditions: pick('conditions') }
}

/** The problems of a policy as typed, each at its field. */
export function policyProblems(policy: ReturnPolicy): Issue[] {
  const problems: Issue[] = []
  for (const field of ['windowDays', 'goodsDueDays'] as const) {
    const days = policy[field]
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > RETURN_LIMITS.days)) problems.push({ path: field, message: `1 to ${RETURN_LIMITS.days} days, or none.` })
  }
  if (policy.freightPaidBy !== null && !FREIGHT_PAYERS.includes(policy.freightPaidBy)) problems.push({ path: 'freightPaidBy', message: 'The customer, the company, or whoever caused the return.' })
  if (policy.restockingFeePct !== null) {
    const fee = parseDecimal(policy.restockingFeePct)
    if (fee === null || fee.lte(0) || fee.gt(100) || fee.decimalPlaces() > 4) problems.push({ path: 'restockingFeePct', message: 'A fee above 0 and at most 100 percent (4 decimals), or none.' })
  }
  if (policy.conditions !== null && policy.conditions.length > RETURN_LIMITS.conditions) problems.push({ path: 'conditions', message: `At most ${RETURN_LIMITS.conditions} characters.` })
  return problems
}

const addDays = (day: BusinessDate, days: number): BusinessDate => {
  const date = new Date(`${day}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** The last day the goods may arrive: the policy's days from the authorisation (null: no deadline). */
export const goodsDueByOf = (authorisedOn: BusinessDate, policy: Pick<ReturnPolicy, 'goodsDueDays'>): BusinessDate | null =>
  policy.goodsDueDays === null ? null : addDays(authorisedOn, policy.goodsDueDays)

/**
 * The window check (a warning, never a refusal: the policy check itself is SAL-338, W2b): the line was delivered more
 * than the window's days before today. Answers the words, or null.
 */
export function windowWarning(deliveredOn: BusinessDate | null, today: BusinessDate, policy: Pick<ReturnPolicy, 'windowDays'>): string | null {
  if (deliveredOn === null || policy.windowDays === null) return null
  const last = addDays(deliveredOn, policy.windowDays)
  if (today <= last) return null
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${deliveredOn}T00:00:00Z`)) / 86_400_000)
  return `Delivered ${days} days ago (${deliveredOn}); the return window is ${policy.windowDays} days.`
}

/** Who pays the freight back, for a return of this cause (null: the policy names nobody, or the cause is not known). */
export function freightPayerOf(policy: Pick<ReturnPolicy, 'freightPaidBy'>, cause: ReturnCause | null): 'CUSTOMER' | 'COMPANY' | null {
  if (policy.freightPaidBy === null) return null
  if (policy.freightPaidBy !== 'BY_CAUSE') return policy.freightPaidBy
  if (cause === null) return null
  return cause === 'OUR_DEFECT' || cause === 'TRANSIT' ? 'COMPANY' : 'CUSTOMER'
}

// ---- what may come back ---------------------------------------------------------------------------------------------

/** Pieces of a sold line (an invoice line, or an order line and size) and how many may still come back. */
export interface SoldLine {
  /** What the customer was sold (invoice line pieces, or what shipped and is not invoiced). */
  readonly sold: number
  /** Pieces live RMAs other than this one take back (open: their pieces; closed: what they received). */
  readonly taken: number
  /** A second bound: what shipped of the order line and size, less what every RMA takes back of it. */
  readonly shippedLeft?: number | null
}

export const leftOf = (line: SoldLine): number => Math.max(0, Math.min(line.sold - line.taken, line.shippedLeft ?? Number.POSITIVE_INFINITY))

/** The words of a quantity above what may come back (the cell's refusal: "with the sold number"). */
export function aboveSoldWords(wanted: number, line: SoldLine): string | null {
  const left = leftOf(line)
  if (wanted <= left) return null
  const taken = line.taken > 0 ? `, ${line.taken} already on other returns` : ''
  return left === 0 ? `Nothing of it can come back: ${line.sold} sold${taken}.` : `At most ${left} can come back: ${line.sold} sold${taken}.`
}

// ---- protective garments --------------------------------------------------------------------------------------------

/** The customer's reasons that call a protective garment into question (the RETURN list's standard DEFECT). */
export const SAFETY_REASON_CODES: readonly string[] = Object.freeze(['DEFECT'])

/**
 * A protective garment returned for a defect, or found defective or misused at the inspection: it goes back on the
 * market only after a safety check (design rma.inspection "A decision on a PPE garment from an impact asks for a safety
 * check first"), and the PPE register records it (Reg. (EU) 2016/425 art. 8(4)).
 */
export const isSafetyReturn = (line: { readonly ppe: boolean; readonly reasonCode: string; readonly cause?: ReturnCause | null }): boolean =>
  line.ppe && (SAFETY_REASON_CODES.includes(line.reasonCode) || line.cause === 'OUR_DEFECT' || line.cause === 'MISUSE')

// ---- grading --------------------------------------------------------------------------------------------------------

export interface GradedLine {
  readonly grade: ReturnGrade
  readonly cause: ReturnCause | null
  readonly ppe: boolean
  readonly reasonCode: string
}

/**
 * Where the goods should go after their grade (floor.returnsin "the suggested outcome from the return policy: restock,
 * repair, second quality, scrap"; a used protective garment is held from "restock as new").
 */
export function suggestedOutcome(line: GradedLine): GoodsOutcome {
  const safety = isSafetyReturn(line)
  switch (line.grade) {
    case 'NEW':
      return safety ? 'QUARANTINE' : 'RESTOCK'
    case 'LIKE_NEW':
      return safety ? 'QUARANTINE' : line.ppe ? 'SECOND_QUALITY' : 'RESTOCK'
    case 'GOOD':
      return safety ? 'QUARANTINE' : 'SECOND_QUALITY'
    case 'DAMAGED':
      return 'REPAIR'
    case 'UNUSABLE':
      return 'SCRAP'
  }
}

/** Why the suggested outcome is held from RESTOCK, in words (null: nothing held). */
export function restockHeldWords(line: GradedLine): string | null {
  if (isSafetyReturn(line)) return 'A protective garment returned for a defect goes back on the market only after a safety check: repair it (the repair checks it), hold it in quarantine or scrap it.'
  if (line.grade === 'NEW' || (line.grade === 'LIKE_NEW' && !line.ppe)) return null
  return line.ppe ? 'A used protective garment is never restocked as new: second quality, quarantine or scrap.' : 'Only a new or like-new garment goes back into stock as new.'
}

// ---- deciding -------------------------------------------------------------------------------------------------------

/** Where the goods may go for each disposition, the usual one first. */
export const OUTCOMES_BY_DISPOSITION: Readonly<Record<ReturnDisposition, readonly GoodsOutcome[]>> = Object.freeze({
  REPAIR: ['REPAIR'],
  REMAKE: [],
  REPLACE: ['RESTOCK', 'SECOND_QUALITY', 'QUARANTINE', 'REPAIR', 'SCRAP'],
  CREDIT_ONLY: ['RESTOCK', 'SECOND_QUALITY', 'QUARANTINE', 'REPAIR', 'SCRAP'],
  RETURN_UNCHANGED: ['BACK_TO_CUSTOMER'],
  SCRAP: ['SCRAP'],
})

/** The outcomes that put the goods into stock (a stock move into a place of the site). */
export const STOCK_OUTCOMES: readonly GoodsOutcome[] = Object.freeze(['RESTOCK', 'SECOND_QUALITY', 'QUARANTINE'])

/** What a decision starts next (the work part of its effect). */
export const RETURN_FOLLOW_UPS = ['REPAIR_ORDER', 'REPLACEMENT_ORDER', 'CREDIT_NOTE', 'RETURN_DDT'] as const
export type ReturnFollowUp = (typeof RETURN_FOLLOW_UPS)[number]

export function followUpOf(disposition: ReturnDisposition, creditAmount: number): ReturnFollowUp | null {
  if (disposition === 'REPAIR') return 'REPAIR_ORDER'
  if (disposition === 'REPLACE') return 'REPLACEMENT_ORDER'
  if (disposition === 'RETURN_UNCHANGED') return 'RETURN_DDT'
  return creditAmount > 0 ? 'CREDIT_NOTE' : null
}

export interface DecisionDraft {
  readonly disposition: ReturnDisposition
  readonly goodsOutcome: GoodsOutcome
  /** Minor units; undefined: the default for the disposition. */
  readonly creditAmount?: number | undefined
}

export interface DecisionFacts extends Partial<GradedLine> {
  /** The received pieces. */
  readonly received: number
  /** What the received pieces are worth (net, minor units); null: no price known. */
  readonly value: number | null
}

/** The credit a disposition starts from: the value of what came back for CREDIT_ONLY, else none. */
export const defaultCredit = (disposition: ReturnDisposition, value: number | null): number => (disposition === 'CREDIT_ONLY' ? (value ?? 0) : 0)

/** The problems of a decision, each at its field (`disposition`, `goodsOutcome`, `creditAmount`). */
export function decisionProblems(draft: DecisionDraft, facts: DecisionFacts): Issue[] {
  const problems: Issue[] = []
  if (facts.received <= 0) return [{ path: 'disposition', message: 'Nothing of this line arrived yet: receive it first.' }]
  if (!facts.grade) return [{ path: 'disposition', message: 'Grade the line first (new to unusable).' }]
  if (draft.disposition === 'REMAKE') return [{ path: 'disposition', message: 'A remake is for made-to-measure garments, which come later: replace it instead.' }]
  const allowed = OUTCOMES_BY_DISPOSITION[draft.disposition]
  if (!allowed.includes(draft.goodsOutcome)) problems.push({ path: 'goodsOutcome', message: `${dispositionWords(draft.disposition)}: the goods ${allowed.map(outcomeWords).join(', or ')}.` })
  const line: GradedLine = { grade: facts.grade, cause: facts.cause ?? null, ppe: facts.ppe ?? false, reasonCode: facts.reasonCode ?? '' }
  if (draft.goodsOutcome === 'RESTOCK') {
    const held = restockHeldWords(line)
    if (held) problems.push({ path: 'goodsOutcome', message: held })
  } else if ((draft.goodsOutcome === 'SECOND_QUALITY' || draft.goodsOutcome === 'BACK_TO_CUSTOMER') && isSafetyReturn(line)) {
    problems.push({ path: 'goodsOutcome', message: 'A protective garment returned for a defect goes back on the market only after a safety check: repair it (the repair checks it), hold it in quarantine or scrap it.' })
  }
  if (draft.creditAmount !== undefined) {
    if (!Number.isInteger(draft.creditAmount) || draft.creditAmount < 0) problems.push({ path: 'creditAmount', message: 'A credit of 0 or more, in cents.' })
    else if (facts.value === null && draft.creditAmount > 0) problems.push({ path: 'creditAmount', message: 'No price is known for this line: it cannot be credited here.' })
    else if (facts.value !== null && draft.creditAmount > facts.value) problems.push({ path: 'creditAmount', message: 'Never more than what came back is worth.' })
  }
  const credit = draft.creditAmount ?? defaultCredit(draft.disposition, facts.value)
  if (draft.disposition === 'CREDIT_ONLY' && credit <= 0) problems.push({ path: 'creditAmount', message: facts.value === null ? 'No price is known for this line: decide another way.' : 'A credit only needs a credit above 0.' })
  return problems
}

/**
 * What the received pieces are worth, net: the invoice line's net amount for those pieces (its discount applied), or
 * the order line's for an order line not yet invoiced; null without a price.
 */
export function valueOf(line: { readonly netAmount: number | null; readonly quantity: string | number | null }, pieces: number, currency: CurrencyCode): MinorUnits | null {
  if (line.netAmount === null || line.quantity === null || pieces <= 0) return pieces <= 0 ? 0 : null
  const quantity = new Dec(String(line.quantity))
  if (quantity.lte(0)) return null
  return toMinorUnits(new Dec(line.netAmount).times(pieces).dividedBy(quantity).dividedBy(new Dec(10).pow(minorPlaces(currency))), currency)
}


// ---- words ----------------------------------------------------------------------------------------------------------

const DISPOSITION_WORDS: Readonly<Record<ReturnDisposition, string>> = {
  REPAIR: 'Repair',
  REMAKE: 'Remake',
  REPLACE: 'Replace',
  CREDIT_ONLY: 'Credit only',
  RETURN_UNCHANGED: 'Return unchanged',
  SCRAP: 'Scrap',
}
const OUTCOME_WORDS: Readonly<Record<GoodsOutcome, string>> = {
  RESTOCK: 'go back into stock',
  SECOND_QUALITY: 'go to second quality',
  QUARANTINE: 'are held in quarantine',
  REPAIR: 'go to repair',
  SCRAP: 'are scrapped',
  BACK_TO_CUSTOMER: 'go back to the customer unchanged',
}
const FOLLOW_UP_WORDS: Readonly<Record<ReturnFollowUp, string>> = {
  REPAIR_ORDER: 'a repair order to make',
  REPLACEMENT_ORDER: 'on the replacement order',
  CREDIT_NOTE: 'a credit note to make (Finance)',
  RETURN_DDT: 'a return DDT to issue',
}

export const dispositionWords = (disposition: ReturnDisposition): string => DISPOSITION_WORDS[disposition]
export const outcomeWords = (outcome: GoodsOutcome): string => OUTCOME_WORDS[outcome]

/**
 * A decision's effect in words, without an amount (design "Effect in words": money, stock and work in one line): "A
 * credit; goods go back into stock at A1-FG; a credit note to make (Finance)". The amount is a separate, priced field.
 */
export function effectWords(decision: { readonly disposition: ReturnDisposition; readonly goodsOutcome: GoodsOutcome | null; readonly creditAmount: number | null }, place: string | null = null): string {
  const credit = decision.creditAmount && decision.creditAmount > 0 ? 'A credit' : 'No credit'
  const goods = decision.goodsOutcome ? `goods ${outcomeWords(decision.goodsOutcome)}${place && STOCK_OUTCOMES.includes(decision.goodsOutcome) ? ` at ${place}` : ''}` : 'goods not decided'
  const follow = followUpOf(decision.disposition, decision.creditAmount ?? 0)
  const work = follow === null ? 'no new work' : FOLLOW_UP_WORDS[follow]
  const extra = decision.disposition !== 'CREDIT_ONLY' && follow !== 'CREDIT_NOTE' && (decision.creditAmount ?? 0) > 0 ? '; a credit note to make (Finance)' : ''
  return `${credit}; ${goods}; ${work}${extra}`
}

/** The same with the amount (for a caller with the price grain): "Credit 120.00 EUR; …". */
export function effectWithAmount(decision: Parameters<typeof effectWords>[0], place: string | null, amountText: string | null): string {
  const words = effectWords(decision, place)
  return amountText && (decision.creditAmount ?? 0) > 0 ? words.replace(/^A credit/, `Credit ${amountText}`) : words
}

// ---- status and tracking (SAL-362) ----------------------------------------------------------------------------------

export const TRACKING_STEPS = ['REQUESTED', 'AUTHORISED', 'GOODS_BACK', 'INSPECTED', 'OUTCOME'] as const
export type TrackingStep = (typeof TRACKING_STEPS)[number]
export const STEP_STATES = ['DONE', 'CURRENT', 'WAITING', 'SKIPPED'] as const
export type StepState = (typeof STEP_STATES)[number]

export interface TrackingFacts {
  readonly status: ReturnStatus
  readonly requestedAt: string
  readonly authorisedAt: string | null
  readonly goodsDueBy: BusinessDate | null
  readonly receivedAt: string | null
  readonly inspectedAt: string | null
  readonly closedAt: string | null
  /** The lines received and decided (the outcome step is current while some wait). */
  readonly linesReceived: number
  readonly linesDecided: number
}

export interface TrackingRow {
  readonly step: TrackingStep
  readonly state: StepState
  readonly at: string | null
  /** The step's date in a sentence ("send it back by 2026-11-20"). */
  readonly words: string
}

/** The RMA's steps with their dates (the design's MilestoneTracker: received · decided · back with us · inspected · outcome). */
export function trackingOf(facts: TrackingFacts): TrackingRow[] {
  const ended = facts.status === 'CANCELLED' || facts.status === 'REJECTED'
  const goodsBack = facts.receivedAt !== null
  const inspected = facts.inspectedAt !== null && (facts.status === 'INSPECTED' || facts.status === 'CLOSED')
  const rows: TrackingRow[] = []
  rows.push({ step: 'REQUESTED', state: 'DONE', at: facts.requestedAt, words: 'Asked for' })
  rows.push(
    facts.authorisedAt
      ? { step: 'AUTHORISED', state: 'DONE', at: facts.authorisedAt, words: facts.goodsDueBy ? `Authorised: send it back by ${facts.goodsDueBy}` : 'Authorised' }
      : { step: 'AUTHORISED', state: ended ? 'SKIPPED' : 'CURRENT', at: null, words: facts.status === 'REJECTED' ? 'Not authorised' : 'Waiting for the authorisation' },
  )
  rows.push(
    goodsBack
      ? { step: 'GOODS_BACK', state: 'DONE', at: facts.receivedAt, words: 'Back with us' }
      : { step: 'GOODS_BACK', state: ended || facts.status === 'CLOSED' ? 'SKIPPED' : facts.authorisedAt ? 'CURRENT' : 'WAITING', at: null, words: facts.status === 'CLOSED' ? 'Closed before the goods came' : 'Waiting for the goods' },
  )
  rows.push(
    inspected
      ? { step: 'INSPECTED', state: 'DONE', at: facts.inspectedAt, words: 'Inspected and decided' }
      : { step: 'INSPECTED', state: !goodsBack || ended ? (ended || facts.status === 'CLOSED' ? 'SKIPPED' : 'WAITING') : facts.status === 'CLOSED' ? 'SKIPPED' : 'CURRENT', at: null, words: goodsBack ? `${facts.linesDecided} of ${facts.linesReceived} received lines decided` : 'Waiting for the goods' },
  )
  rows.push(
    facts.status === 'CLOSED'
      ? { step: 'OUTCOME', state: 'DONE', at: facts.closedAt, words: 'Closed' }
      : ended
        ? { step: 'OUTCOME', state: 'SKIPPED', at: facts.closedAt, words: facts.status === 'CANCELLED' ? 'Cancelled' : 'Rejected' }
        : { step: 'OUTCOME', state: inspected ? 'CURRENT' : 'WAITING', at: null, words: inspected ? 'Outcome under way (credit, replacement, repair or goods back)' : 'Waiting for the decision' },
  )
  return rows
}

/** The status in one sentence (the list's substatus). */
export function statusWords(facts: Pick<TrackingFacts, 'status' | 'goodsDueBy' | 'linesReceived' | 'linesDecided'>, today: BusinessDate): string {
  switch (facts.status) {
    case 'REQUESTED':
      return 'Asked for; waiting for the authorisation'
    case 'AUTHORISED':
      return facts.goodsDueBy === null ? 'Waiting for the goods' : facts.goodsDueBy < today ? `Goods late: due by ${facts.goodsDueBy}` : `Waiting for the goods by ${facts.goodsDueBy}`
    case 'RECEIVED':
      return `Received: ${facts.linesDecided} of ${facts.linesReceived} lines decided`
    case 'INSPECTED':
      return 'Inspected and decided'
    case 'CLOSED':
      return 'Closed'
    case 'REJECTED':
      return 'Rejected'
    case 'CANCELLED':
      return 'Cancelled'
  }
}

// ---- the list's saved rows ------------------------------------------------------------------------------------------

/** The returns list's views (design returns.grid savedRows and returns.tiles). */
export const RETURN_LIST_VIEWS = ['open', 'waiting', 'late', 'toInspect', 'toDecide', 'replacement', 'closed', 'all'] as const
export type ReturnListView = (typeof RETURN_LIST_VIEWS)[number]

// ---- what the record offers now -------------------------------------------------------------------------------------

export const RETURN_ACTIONS = ['editLines', 'receive', 'inspect', 'decide', 'makeReplacement', 'issueReturnDdt', 'cancel', 'close'] as const
export type ReturnAction = (typeof RETURN_ACTIONS)[number]

export interface ActionFacts {
  readonly status: ReturnStatus
  readonly lines: readonly {
    readonly quantity: number
    readonly received: number
    readonly graded: boolean
    readonly disposition: ReturnDisposition | null
    readonly goodsOutcome: GoodsOutcome | null
    readonly replaced: boolean
  }[]
  readonly replacementOrder: boolean
}

export interface ActionState {
  readonly action: ReturnAction
  readonly allowed: boolean
  /** Why not, in words (null when allowed). */
  readonly held: string | null
}

/** Each action of the record: allowed, or held with its reason. */
export function returnActions(facts: ActionFacts): ActionState[] {
  const final = isFinal(facts.status)
  const state = facts.status.toLowerCase()
  const received = facts.lines.filter((line) => line.received > 0)
  const open = facts.lines.some((line) => line.received < line.quantity)
  const toGrade = received.filter((line) => !line.graded)
  const toDecide = received.filter((line) => line.graded && line.disposition === null)
  const replace = received.filter((line) => line.disposition === 'REPLACE' && !line.replaced)
  const back = received.filter((line) => line.disposition === 'RETURN_UNCHANGED' || line.goodsOutcome === 'BACK_TO_CUSTOMER')
  const undecided = received.filter((line) => line.disposition === null)
  const held = (action: ReturnAction, why: string | null): ActionState => ({ action, allowed: why === null, held: why })
  return [
    held('editLines', BEFORE_GOODS.includes(facts.status) ? null : final ? `The return is ${state}.` : 'The goods arrived: what comes back is fixed.'),
    held('receive', !RECEIVING_STATUSES.includes(facts.status) ? `The return is ${state}.` : open ? null : 'Every piece arrived.'),
    held('inspect', !DECIDING_STATUSES.includes(facts.status) ? (final ? `The return is ${state}.` : 'Nothing arrived yet.') : toGrade.length > 0 || received.length > 0 ? null : 'Nothing arrived yet.'),
    held('decide', !DECIDING_STATUSES.includes(facts.status) ? (final ? `The return is ${state}.` : 'Nothing arrived yet.') : toDecide.length > 0 || received.some((line) => line.graded) ? null : 'Grade the received lines first.'),
    held('makeReplacement', facts.replacementOrder ? 'The replacement order is made.' : final && facts.status !== 'CLOSED' ? `The return is ${state}.` : replace.length > 0 ? null : 'No line is decided Replace.'),
    held('issueReturnDdt', !['RECEIVED', 'INSPECTED', 'CLOSED'].includes(facts.status) ? 'Nothing arrived yet.' : back.length > 0 ? null : 'No line goes back unchanged.'),
    held('cancel', BEFORE_GOODS.includes(facts.status) ? null : final ? `The return is ${state}.` : 'The goods arrived: close it instead.'),
    held('close', final ? `The return is ${state}.` : facts.status === 'REQUESTED' ? 'Authorise or reject it first.' : undecided.length > 0 ? `Decide the ${undecided.length} received line(s) first.` : null),
  ]
}

// ---- B-W2b-16: what closing still leaves open (the close dialog says it before the click) ----------------------------

export const CLOSE_WARNING_CODES = ['REPLACE_WITHOUT_ORDER', 'BACK_WITHOUT_DDT', 'REPAIR_WITHOUT_ORDER'] as const
export type CloseWarningCode = (typeof CLOSE_WARNING_CODES)[number]

export interface CloseWarningLine {
  readonly id: string
  readonly seq: number
  readonly received: number
  readonly disposition: ReturnDisposition | null
  readonly goodsOutcome: GoodsOutcome | null
  readonly replaced: boolean
  /** Repair orders made from the line that are not cancelled (one per garment received on it). */
  readonly repairs: number
}

export interface CloseWarning {
  readonly code: CloseWarningCode
  /** Where it points (as the close's warnings always did): replacementOrder, ddt, repairOrder. */
  readonly path: string
  readonly lineIds: string[]
  readonly seqs: number[]
  readonly message: string
}

const seqWords = (lines: readonly CloseWarningLine[]) => `${lines.length === 1 ? 'Line' : 'Lines'} ${lines.map((line) => line.seq).join(', ')}`

/**
 * What a close would leave behind, never a refusal (B-W2a-43's two warnings, and B-W2b-16 the third one, B-W2a-57's
 * note): Replace lines without the replacement order, unchanged goods without a live return DDT, and lines decided Repair
 * with fewer live repair orders than garments received (each garment gets its own repair order).
 */
export function closeWarningsOf(lines: readonly CloseWarningLine[], liveReturnDdt: boolean): CloseWarning[] {
  const warnings: CloseWarning[] = []
  const add = (code: CloseWarningCode, path: string, found: readonly CloseWarningLine[], words: string) => {
    if (found.length > 0) warnings.push({ code, path, lineIds: found.map((line) => line.id), seqs: found.map((line) => line.seq), message: `${seqWords(found)} ${words}` })
  }
  add('REPLACE_WITHOUT_ORDER', 'replacementOrder', lines.filter((line) => line.disposition === 'REPLACE' && !line.replaced), `${lines.filter((line) => line.disposition === 'REPLACE' && !line.replaced).length === 1 ? 'is' : 'are'} decided Replace and no replacement order was made.`)
  const back = lines.filter((line) => line.disposition === 'RETURN_UNCHANGED' || line.goodsOutcome === 'BACK_TO_CUSTOMER')
  if (!liveReturnDdt) add('BACK_WITHOUT_DDT', 'ddt', back, `${back.length === 1 ? 'goes' : 'go'} back unchanged and no return DDT is issued yet (it can still be issued after the close).`)
  const repair = lines.filter((line) => line.disposition === 'REPAIR' && line.received > 0 && line.repairs < line.received)
  add('REPAIR_WITHOUT_ORDER', 'repairOrder', repair, `${repair.length === 1 ? 'is' : 'are'} decided Repair and no repair order was made for ${repair.length === 1 && repair[0]!.received - repair[0]!.repairs === 1 ? 'the garment' : 'every garment'} (make it from the line, or the garment stays here unrepaired).`)
  return warnings
}
