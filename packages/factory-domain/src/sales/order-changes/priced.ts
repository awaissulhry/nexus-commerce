import type { ApprovalField, Facts, PreviewChange, Words } from '../../approvals/rules'
import type { Issue } from '../../core/errors'
import { fromMinorUnits, isCurrencyCode, toMinorUnits, type MinorUnits } from '../../core/money'
import { Dec, HUNDRED } from '../../tax/decimal'
import type { LineChange } from '../amendments/amendments'
import { ORDER_FREEZE_STAGES, STAGE_WORDS, type OrderFreezeStage } from './freeze'

/**
 * A priced change request after the start, its extra deposit, and the new yes after an edit (B-W2b-309; SAL-219, SAL-221,
 * SAL-190; design order.changes.priced "Priced change requests": Change · Extra cost and price · Customer decision), pure.
 *
 *   priced    an amendment (W2a's, B-W2a-30) that carries its price: the parts of the change (factory-db
 *             SalesOrderAmendment.priceDeltaLines: one per line whose net moved — "Line 10: 6 → 7 pieces" — with its signed
 *             amount in minor units, the office's own words when given) and a change fee (feeAmount, net, above 0). A
 *             change of a field a freeze rule holds as CHANGE_REQUEST is only accepted priced. A priced change always asks
 *             the customer to accept it again (reacceptanceNeeded; B-W2b-184's REVISED_ORDER link shows the parts and the
 *             fee).
 *   deposit   a bigger order asks an extra deposit (SAL-221): of the gross growth, the order's own deposit percent unless
 *             the office names a percent or an amount; never more than the growth (the database's rule), never on a change
 *             that does not grow the gross total.
 *   new yes   SALES_ORDER_CHANGE (the approval engine's kind): an edit of a confirmed order asks a yes again when one of
 *             the company's rules holds on its facts (no rule: nothing is asked, as today). The facts below.
 */

export const PRICED_LIMITS = Object.freeze({ parts: 100, label: 200, reason: 500 })
const ONE_LINE = /^[^\r\n]+$/
const DECIMAL = /^\d{1,12}(\.\d{1,2})?$/
const PCT = /^\d{1,3}(\.\d{1,4})?$/

/** One priced part as the amendment keeps it (SalesOrderAmendment.priceDeltaLines). */
export interface PricedPart {
  readonly label: string
  readonly orderLineId?: string
  /** Signed, in minor units, never 0. */
  readonly amount: MinorUnits
}

/** The parts of a change: one per line whose net moved, in the office's words when given (by the line's id). */
export function pricedPartsOf(lines: readonly LineChange[], labels: ReadonlyMap<string, string> = new Map()): PricedPart[] {
  const parts: PricedPart[] = []
  for (const line of lines) {
    const amount = line.netAfter - line.netBefore
    if (amount === 0) continue
    const own = labels.get(line.lineId)?.trim()
    const label =
      own && own.length > 0
        ? own
        : line.change === 'ADDED'
          ? `Line ${line.seq} added: ${line.piecesAfter} pieces`
          : line.change === 'REMOVED'
            ? `Line ${line.seq} removed: ${line.piecesBefore} pieces`
            : line.piecesBefore !== line.piecesAfter
              ? `Line ${line.seq}: ${line.piecesBefore} → ${line.piecesAfter} pieces`
              : `Line ${line.seq}: new price`
    parts.push({ label: label.slice(0, PRICED_LIMITS.label), orderLineId: line.lineId, amount })
  }
  return parts
}

/** The input of a priced change's money (the route's body). */
export interface PricedInput {
  /** The office's words per line part: { "<lineId>": "One more jacket in 52, cut on its own" }. */
  readonly labels?: Readonly<Record<string, string>> | undefined
  /** The change fee, net, in major units ("25.00"); null / absent: none. */
  readonly fee?: string | null | undefined
  /** The extra deposit: absent = the order's own percent of the growth; null = none; else a percent or an amount. */
  readonly deposit?: { readonly pct?: string | undefined; readonly amount?: string | undefined; readonly dueDate?: string | undefined; readonly kind?: string | undefined } | null | undefined
}

/** What is wrong with a priced change's money as given (paths under `at`). */
export function pricedInputProblems(input: PricedInput, currency: string, at = 'body'): Issue[] {
  const issues: Issue[] = []
  for (const [lineId, label] of Object.entries(input.labels ?? {})) {
    const text = label.trim()
    if (text.length === 0 || text.length > PRICED_LIMITS.label || !ONE_LINE.test(text)) issues.push({ path: `${at}/labels/${lineId}`, message: `The words of a part are one line of 1 to ${PRICED_LIMITS.label} characters.` })
  }
  if (input.fee !== undefined && input.fee !== null) {
    if (!DECIMAL.test(input.fee) || new Dec(input.fee).lte(0)) issues.push({ path: `${at}/fee`, message: 'A change fee above 0, with at most 2 decimals.' })
    else if (!isCurrencyCode(currency)) issues.push({ path: `${at}/fee`, message: 'The order has no currency to charge a fee in.' })
  }
  const deposit = input.deposit
  if (deposit) {
    if (deposit.pct !== undefined && deposit.amount !== undefined) issues.push({ path: `${at}/deposit`, message: 'Either a percent or an amount, not both.' })
    if (deposit.pct !== undefined && (!PCT.test(deposit.pct) || new Dec(deposit.pct).lte(0) || new Dec(deposit.pct).gt(HUNDRED))) issues.push({ path: `${at}/deposit/pct`, message: 'A percent above 0 and at most 100.' })
    if (deposit.amount !== undefined && (!DECIMAL.test(deposit.amount) || new Dec(deposit.amount).lte(0))) issues.push({ path: `${at}/deposit/amount`, message: 'An amount above 0, with at most 2 decimals.' })
  }
  return issues
}

/** The fee in minor units (null: none). */
export const feeMinorOf = (fee: string | null | undefined, currency: string): MinorUnits | null => (fee === undefined || fee === null ? null : toMinorUnits(fee, currency))

export interface ExtraDepositPlan {
  readonly amount: MinorUnits
  /** The percent of the growth it is (4 decimals), as asked or as worked out from an amount. */
  readonly pct: string
  /** How it was decided: the order's own percent, the office's percent, the office's amount. */
  readonly basis: 'ORDER_PERCENT' | 'PERCENT' | 'AMOUNT'
}

/**
 * The extra deposit of a change (SAL-221): only when the gross total grew; of the growth, by the office's percent or amount,
 * else the order's own deposit percent (null: the order asks no deposit, so none). Never more than the growth.
 * Returns the plan, null (none), or the problem in words.
 */
export function extraDepositOf(input: { readonly growth: MinorUnits; readonly currency: string; readonly orderPct: string | null; readonly asked: PricedInput['deposit'] }): ExtraDepositPlan | null | Issue {
  if (input.growth <= 0 || input.asked === null) return null
  const asked = input.asked
  if (asked?.amount !== undefined) {
    const amount = toMinorUnits(asked.amount, input.currency)
    if (amount > input.growth) return { path: 'body/deposit/amount', message: `The extra deposit is at most what the order grew by (${fromMinorUnits(input.growth, input.currency).toFixed(2)} ${input.currency}).` }
    return { amount, pct: new Dec(amount).dividedBy(input.growth).times(HUNDRED).toDecimalPlaces(4).toFixed(4), basis: 'AMOUNT' }
  }
  const pct = asked?.pct ?? input.orderPct
  if (pct === null || new Dec(pct).lte(0)) return null
  const amount = Math.min(input.growth, Number.parseInt(new Dec(input.growth).times(new Dec(pct)).dividedBy(HUNDRED).toDecimalPlaces(0, Dec.ROUND_HALF_UP).toFixed(0), 10))
  if (amount <= 0) return null
  return { amount, pct: new Dec(pct).toDecimalPlaces(4).toFixed(4), basis: asked?.pct !== undefined ? 'PERCENT' : 'ORDER_PERCENT' }
}

// ---- the new yes after an edit (SALES_ORDER_CHANGE) ------------------------------------------------------------------------

export const CHANGE_STAGES = ['NONE', ...ORDER_FREEZE_STAGES] as const
export type ChangeStage = (typeof CHANGE_STAGES)[number]

const STAGE_OPTION_WORDS: Readonly<Record<ChangeStage, Words>> = Object.freeze({ NONE: { en: 'Not in production yet', it: 'Non ancora in produzione' }, ...STAGE_WORDS })

/** The facts a SALES_ORDER_CHANGE rule may test (the RuleBuilder's fields); money with its grain. */
export const SALES_ORDER_CHANGE_FIELDS: readonly ApprovalField[] = Object.freeze<ApprovalField[]>([
  { id: 'orderValue', label: { en: 'order value after the change (net)', it: "valore dell'ordine dopo la modifica (netto)" }, kind: 'number', grain: 'price', min: 0 },
  { id: 'changeValue', label: { en: 'change in value (net)', it: 'variazione di valore (netto)' }, kind: 'number', grain: 'price' },
  { id: 'changePct', label: { en: 'change in value', it: 'variazione di valore' }, kind: 'number', unit: '%' },
  { id: 'feeValue', label: { en: 'change fee (net)', it: 'costo della modifica (netto)' }, kind: 'number', grain: 'price', min: 0 },
  { id: 'currency', label: { en: 'currency', it: 'valuta' }, kind: 'text' },
  { id: 'linesChanged', label: { en: 'lines changed', it: 'righe cambiate' }, kind: 'number', unit: null, min: 0 },
  { id: 'piecesChange', label: { en: 'change in pieces', it: 'variazione di pezzi' }, kind: 'number', unit: 'pcs' },
  { id: 'priced', label: { en: 'a priced change after the start', it: "una modifica con prezzo dopo l'avvio" }, kind: 'yesNo' },
  {
    id: 'stage',
    label: { en: 'furthest production stage of a changed line', it: 'fase di produzione più avanzata di una riga cambiata' },
    kind: 'choice',
    options: CHANGE_STAGES.map((stage) => ({ value: stage, label: STAGE_OPTION_WORDS[stage] })),
  },
  { id: 'customerCode', label: { en: 'customer code', it: 'codice cliente' }, kind: 'text' },
  { id: 'wasApproved', label: { en: 'the order went on with a yes', it: "l'ordine è partito con un'approvazione" }, kind: 'yesNo' },
])

/** An edit as the facts read it. */
export interface ChangeShape {
  readonly currency: string
  readonly netBefore: MinorUnits
  readonly netAfter: MinorUnits
  readonly feeAmount: MinorUnits | null
  readonly lines: readonly Pick<LineChange, 'piecesBefore' | 'piecesAfter'>[]
  readonly priced: boolean
  readonly stage: OrderFreezeStage | null
  readonly customerCode: string | null
  readonly wasApproved: boolean
}

const major = (amount: MinorUnits, currency: string): string | null => (isCurrencyCode(currency) ? fromMinorUnits(amount, currency).toFixed() : null)

/** The facts of an edit (the request's read and its re-read use this one function). */
export function salesOrderChangeFacts(shape: ChangeShape): Facts {
  const change = shape.netAfter - shape.netBefore
  return {
    orderValue: major(shape.netAfter, shape.currency),
    changeValue: major(change, shape.currency),
    changePct: shape.netBefore > 0 ? new Dec(change).dividedBy(shape.netBefore).times(HUNDRED).toDecimalPlaces(2).toFixed(2) : null,
    feeValue: shape.feeAmount === null ? '0' : major(shape.feeAmount, shape.currency),
    currency: shape.currency,
    linesChanged: shape.lines.length,
    piecesChange: shape.lines.reduce((sum, line) => sum + line.piecesAfter - line.piecesBefore, 0),
    priced: shape.priced,
    stage: shape.stage ?? 'NONE',
    customerCode: shape.customerCode,
    wasApproved: shape.wasApproved,
  }
}

/** The request's change entries: the revision asked about, its net value old → new (price grain), and the fee. */
export function salesOrderChangeChanges(input: { readonly revision: number; readonly netBefore: MinorUnits; readonly netAfter: MinorUnits; readonly feeAmount: MinorUnits | null }): PreviewChange[] {
  return [
    { field: 'revision', from: input.revision - 1, to: input.revision, grain: null },
    { field: 'netAmount', from: input.netBefore, to: input.netAfter, grain: 'price' },
    ...(input.feeAmount !== null ? [{ field: 'feeAmount', from: null, to: input.feeAmount, grain: 'price' as const }] : []),
  ]
}

/** The state of an amendment's new yes, as the order's Changes tab reads it. */
export const CHANGE_YES_STATES = ['NOT_ASKED', 'WAITING', 'APPROVED', 'TURNED_DOWN', 'STALE', 'WITHDRAWN'] as const
export type ChangeYesState = (typeof CHANGE_YES_STATES)[number]

export const CHANGE_YES_WORDS: Readonly<Record<ChangeYesState, Words>> = Object.freeze({
  NOT_ASKED: { en: 'No yes needed (no rule held)', it: 'Nessuna approvazione necessaria (nessuna regola)' },
  WAITING: { en: 'Waiting for a yes', it: "In attesa di approvazione" },
  APPROVED: { en: 'Approved', it: 'Approvata' },
  TURNED_DOWN: { en: 'Turned down: put the order back', it: "Respinta: riportare l'ordine com'era" },
  STALE: { en: 'The order changed since: ask again', it: "L'ordine è cambiato da allora: chiedere di nuovo" },
  WITHDRAWN: { en: 'Taken back', it: 'Ritirata' },
})

/** The customer's decision on a priced change (B-W2b-184's REVISED_ORDER request on the amendment). */
export const CUSTOMER_DECISIONS = ['NOT_NEEDED', 'NOT_ASKED', 'WAITING', 'ACCEPTED', 'REFUSED', 'EXPIRED', 'WITHDRAWN'] as const
export type CustomerDecision = (typeof CUSTOMER_DECISIONS)[number]

export const CUSTOMER_DECISION_WORDS: Readonly<Record<CustomerDecision, Words>> = Object.freeze({
  NOT_NEEDED: { en: 'The customer need not accept it', it: 'Il cliente non deve accettarla' },
  NOT_ASKED: { en: 'Not sent to the customer yet', it: 'Non ancora inviata al cliente' },
  WAITING: { en: 'Waiting for the customer', it: 'In attesa del cliente' },
  ACCEPTED: { en: 'Accepted by the customer', it: 'Accettata dal cliente' },
  REFUSED: { en: 'Refused by the customer: put the order back or change it again', it: "Rifiutata dal cliente: riportare l'ordine com'era o cambiarlo di nuovo" },
  EXPIRED: { en: 'The customer did not answer in time', it: 'Il cliente non ha risposto in tempo' },
  WITHDRAWN: { en: 'The request to the customer was taken back', it: 'La richiesta al cliente è stata ritirata' },
})

/** The customer's decision from the newest REVISED_ORDER request on the amendment (null: none asked). */
export function customerDecisionOf(reacceptanceNeeded: boolean, requestStatus: string | null): CustomerDecision {
  if (!reacceptanceNeeded) return 'NOT_NEEDED'
  switch (requestStatus) {
    case null:
      return 'NOT_ASKED'
    case 'OPEN':
      return 'WAITING'
    case 'APPROVED':
    case 'APPROVED_WITH_CHANGES':
      return 'ACCEPTED'
    case 'REFUSED':
      return 'REFUSED'
    case 'EXPIRED':
      return 'EXPIRED'
    default:
      return 'WITHDRAWN'
  }
}

/** The new yes's state from the newest SALES_ORDER_CHANGE request about the amendment (null: none asked). */
export function changeYesStateOf(taskStatus: string | null): ChangeYesState {
  switch (taskStatus) {
    case null:
      return 'NOT_ASKED'
    case 'PENDING':
      return 'WAITING'
    case 'APPROVED':
      return 'APPROVED'
    case 'REJECTED':
      return 'TURNED_DOWN'
    case 'STALE':
      return 'STALE'
    default:
      return 'WITHDRAWN'
  }
}

// ---- the non-refundable deposit (SAL-248) ----------------------------------------------------------------------------------

/**
 * The caparra penitenziale (c.c. art. 1386): a deposit that buys the right to withdraw — kept by the seller when the buyer
 * withdraws, paid back twice when the seller does. Built switched off (GATE-ACCOUNTANT; SalesSettings.caparraPenitenzialeEnabled,
 * the company's row, else the tenant's, else off): no route asks it while off. The quote routes still ask ACCONTO or CAPARRA
 * only (factory-domain DEPOSIT_KINDS, until the accountant gives its fiscal rule and words); the priced change's extra
 * deposit takes it when its company switched it on.
 */
export const PENITENTIAL_KIND = 'CAPARRA_PENITENZIALE' as const
export const PENITENTIAL_RULE = 'CAPARRA_PENITENZIALE_UNCONFIRMED'
export const PENITENTIAL_WORDS: Words = Object.freeze({ en: 'Non-refundable deposit (caparra penitenziale, c.c. art. 1386)', it: 'Caparra penitenziale (art. 1386 c.c.)' })
export const PENITENTIAL_OFF_WORDS: Words = Object.freeze({
  en: "The non-refundable deposit (caparra penitenziale) is switched off until the accountant's wording: ask an acconto or a caparra confirmatoria.",
  it: "La caparra penitenziale è disattivata finché il commercialista non ne dà la formulazione: chiedere un acconto o una caparra confirmatoria.",
})
export const PENITENTIAL_FISCAL_REASON =
  "A caparra penitenziale (c.c. art. 1386) is the price of the right to withdraw, not a payment on the price: no deposit invoice when it is paid until the accountant's wording says otherwise (GATE-ACCOUNTANT)."

/** Every kind with its words and whether this company may ask it now. */
export const DEPOSIT_KIND_WORDS: Readonly<Record<'ACCONTO' | 'CAPARRA' | 'CAPARRA_PENITENZIALE', Words>> = Object.freeze({
  ACCONTO: { en: 'Advance payment (acconto)', it: 'Acconto' },
  CAPARRA: { en: 'Confirmatory deposit (caparra confirmatoria, c.c. art. 1385)', it: 'Caparra confirmatoria (art. 1385 c.c.)' },
  CAPARRA_PENITENZIALE: PENITENTIAL_WORDS,
})
