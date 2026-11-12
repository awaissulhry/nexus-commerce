import type { Issue } from '../../core/errors'
import { fromMinorUnits, isCurrencyCode, toMinorUnits, type MinorUnits } from '../../core/money'
import type { BusinessDate } from '../../core/time'
import { Dec, parseDecimal } from '../../tax/decimal'
import { FREIGHT_PAYERS, type FreightPayer, type ReturnCause, type ReturnStatus } from '../returns/rules'

/**
 * Returns in depth (B-W2b-341; SAL-336 serial, size and lot on every return line, SAL-337 the deadline on the RMA, SAL-338
 * the policy check per channel, SAL-342 credit without a return, SAL-343 restocking or handling fees by rule, SAL-346 a scan
 * code on the RMA papers), pure. apps/factory-api's modules/sales/returns-depth says these rules in words before the
 * …_service_safety_w2b_guards triggers would refuse the same, and builds its answers from them.
 *
 *   policy       a company's return policy per channel (factory-db service.prisma ReturnPolicy): business customers (B2B)
 *                or consumers who bought at a distance (CONSUMER_DISTANCE). One live policy per company and channel: a
 *                new one retires the live one; one an RMA names keeps its terms. The channel of a return follows the
 *                customer: a private person (Party kind PERSON) buys as a consumer, an organisation as a business.
 *   the check    each line's delivery day against the policy's window (outside it: a warning in words, never a refusal:
 *                the office may still take a return back as a courtesy, and says why); the consumer's right of
 *                withdrawal (Codice del Consumo art. 52: 14 days from delivery) only for standard goods sold at a
 *                distance: never for goods made to the consumer's specifications or personalised (art. 59 c.1 c), nor
 *                on an order that states it (SalesOrder.noWithdrawal). The legal words are the lawyer's to confirm.
 *   deadline     the goods are due by the authorisation day + the policy's goodsDueDays (the RMA's goodsDueBy); a
 *                receipt whose Rome day is after it arrived late (a reading, no column).
 *   fees         the first active fee rule of the RMA's company (lowest sequence) whose channel is the policy's or none,
 *                and whose reason codes are none or hold the line's reason, gives a fee withheld from the line's credit:
 *                a percent of the credit, or a fixed amount per line (never more than the credit); dropped when the
 *                cause found is ours (our defect, or damage on the way, as the freight's BY_CAUSE rule reads it); no
 *                credit, no fee. Only on a return checked against a policy (the policy names the channel).
 *   credit       a line credited without the goods coming back: none of its pieces arrived, not decided, the RMA open;
 *                CREDIT_ONLY with a credit above 0 and at most what its pieces are worth; within the approval limit
 *                (an approval rule of kind CREDIT_WITHOUT_RETURN asks a yes). No fee: nothing comes back to restock.
 *   scan code    the code printed as a barcode on the RMA sheet and the box label (capitals, digits and dashes, 6 to 40;
 *                unique in the tenant), from the RMA's number; the dock's "Scan the return" reads it.
 */

export const POLICY_CHANNELS = ['B2B', 'CONSUMER_DISTANCE'] as const
export type PolicyChannel = (typeof POLICY_CHANNELS)[number]
export const FEE_KINDS = ['PERCENT', 'AMOUNT'] as const
export type FeeKind = (typeof FEE_KINDS)[number]

/** The database's limits (…_service_safety_w2b_guards), checked here first so a refusal is in words. */
export const DEPTH_LIMITS = Object.freeze({
  name: 120,
  conditions: 4000,
  withdrawalWords: 8000,
  days: 365,
  /** A consumer at a distance has at least 14 days (art. 52). */
  consumerDays: 14,
  reasonCodes: 50,
  sequence: 9999,
  /** Why a return outside the window is taken back anyway, and other short reasons. */
  reason: 500,
  scanCode: 40,
  /** At most this many returns in one list answer. */
  list: 200,
})

/** The consumer's right of withdrawal: 14 days from delivery (Codice del Consumo art. 52 c.1, c.2 b). */
export const WITHDRAWAL_DAYS = 14

const REASON_CODE = /^[A-Z][A-Z0-9_]{1,39}$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
// eslint-disable-next-line no-control-regex
const CONTROL_BUT_BREAKS = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/

/** One line of 1 to `max` characters (no line break). */
const oneLine = (value: string | null | undefined, max: number): boolean => typeof value === 'string' && value.trim() !== '' && value.length <= max && !CONTROL.test(value)
/** Words of 1 to `max` characters, line breaks allowed; null passes. */
const wordsOk = (value: string | null | undefined, max: number): boolean => value === null || value === undefined || (value.trim() !== '' && value.length <= max && !CONTROL_BUT_BREAKS.test(value))

const addDays = (day: BusinessDate, days: number): BusinessDate => {
  const date = new Date(`${day}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}
const daysBetween = (from: BusinessDate, to: BusinessDate): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

// ---- the policy (SAL-338) --------------------------------------------------------------------------------------------

export interface PolicyDraft {
  readonly channel: PolicyChannel
  readonly name: string
  readonly windowDays: number
  readonly goodsDueDays: number | null
  readonly freightPaidBy: FreightPayer
  readonly conditions: string | null
  readonly withdrawalWords: string | null
  readonly effectiveFrom: BusinessDate
}

/** The problems of a policy as typed, each at its field (the guard's rules, in words). */
export function policyDraftProblems(draft: PolicyDraft): Issue[] {
  const problems: Issue[] = []
  if (!POLICY_CHANNELS.includes(draft.channel)) problems.push({ path: 'channel', message: 'Business customers, or consumers who bought at a distance.' })
  if (!oneLine(draft.name, DEPTH_LIMITS.name)) problems.push({ path: 'name', message: `A name of one line, 1 to ${DEPTH_LIMITS.name} characters.` })
  const least = draft.channel === 'CONSUMER_DISTANCE' ? DEPTH_LIMITS.consumerDays : 1
  if (!Number.isInteger(draft.windowDays) || draft.windowDays < least || draft.windowDays > DEPTH_LIMITS.days) {
    problems.push({ path: 'windowDays', message: draft.channel === 'CONSUMER_DISTANCE' ? `A consumer at a distance has at least ${DEPTH_LIMITS.consumerDays} days to ask (Codice del Consumo art. 52): ${DEPTH_LIMITS.consumerDays} to ${DEPTH_LIMITS.days}.` : `1 to ${DEPTH_LIMITS.days} days from delivery.` })
  }
  if (draft.goodsDueDays !== null && (!Number.isInteger(draft.goodsDueDays) || draft.goodsDueDays < 1 || draft.goodsDueDays > DEPTH_LIMITS.days)) problems.push({ path: 'goodsDueDays', message: `1 to ${DEPTH_LIMITS.days} days from the authorisation, or no deadline.` })
  if (!FREIGHT_PAYERS.includes(draft.freightPaidBy)) problems.push({ path: 'freightPaidBy', message: 'The customer, the company, or whoever caused the return.' })
  if (!wordsOk(draft.conditions, DEPTH_LIMITS.conditions)) problems.push({ path: 'conditions', message: `The conditions printed on the RMA: 1 to ${DEPTH_LIMITS.conditions} characters, or none.` })
  if (draft.withdrawalWords !== null && draft.channel !== 'CONSUMER_DISTANCE') problems.push({ path: 'withdrawalWords', message: 'The withdrawal words are for consumers who bought at a distance only.' })
  else if (!wordsOk(draft.withdrawalWords, DEPTH_LIMITS.withdrawalWords)) problems.push({ path: 'withdrawalWords', message: `1 to ${DEPTH_LIMITS.withdrawalWords} characters, or none.` })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.effectiveFrom)) problems.push({ path: 'effectiveFrom', message: 'The day it applies from.' })
  return problems
}

/** The channel a customer buys through: a private person as a consumer (at a distance: our sales are by mail, phone and portal), an organisation as a business. */
export const channelOfParty = (kind: string): PolicyChannel => (kind === 'PERSON' ? 'CONSUMER_DISTANCE' : 'B2B')

export const channelWords = (channel: PolicyChannel): string => (channel === 'B2B' ? 'business customers' : 'consumers who bought at a distance')

// ---- the window and the withdrawal -----------------------------------------------------------------------------------

export interface WindowCheck {
  /** When the goods reached the customer (null: not known). */
  readonly deliveredOn: BusinessDate | null
  /** The last day a return may be asked (null: not known, or no window). */
  readonly lastDay: BusinessDate | null
  readonly inWindow: boolean
  /** Days past the window's last day (0 inside it). */
  readonly daysOver: number
  /** The check in words, or null when inside the window. */
  readonly words: string | null
}

/** One line's delivery day against the policy's window (days from delivery). */
export function windowCheckOf(deliveredOn: BusinessDate | null, today: BusinessDate, windowDays: number | null, seq: number | null = null): WindowCheck {
  const what = seq === null ? 'It' : `Line ${seq}`
  if (windowDays === null) return { deliveredOn, lastDay: null, inWindow: true, daysOver: 0, words: null }
  if (deliveredOn === null) return { deliveredOn, lastDay: null, inWindow: true, daysOver: 0, words: `${what}: the delivery day is not known, so the ${windowDays} days of the policy cannot be counted.` }
  const lastDay = addDays(deliveredOn, windowDays)
  if (today <= lastDay) return { deliveredOn, lastDay, inWindow: true, daysOver: 0, words: null }
  const over = daysBetween(lastDay, today)
  return { deliveredOn, lastDay, inWindow: false, daysOver: over, words: `${what} was delivered on ${deliveredOn}: the policy's ${windowDays} days ended on ${lastDay} (${over} ${over === 1 ? 'day' : 'days'} ago).` }
}

export interface WithdrawalLine {
  readonly seq: number | null
  readonly deliveredOn: BusinessDate | null
  /** Made to the consumer's specifications (a made-to-measure unit). */
  readonly madeToMeasure: boolean
  /** Clearly personalised: the customer's artwork, or words of their own on an option (a name, a number). */
  readonly personalised: boolean
  /** The order states that it has no right of withdrawal (SalesOrder.noWithdrawal). */
  readonly orderSaysNone: boolean
}

export interface WithdrawalCheck {
  /** Whether the consumer's right of withdrawal applies to every line. */
  readonly applies: boolean
  /** Why not, in words, one per reason (empty when it applies). */
  readonly why: readonly string[]
  /** What the office should know although it applies (a delivery day not known). */
  readonly notes: readonly string[]
}

/**
 * The consumer's right of withdrawal (Codice del Consumo art. 52): only for a consumer who bought at a distance, within 14
 * days from delivery, and only for standard goods: never for goods made to the consumer's specifications or clearly
 * personalised (art. 59 c.1 c). Whether it applies, and why not, in words; the wording is the lawyer's to confirm.
 */
export function withdrawalOf(input: { readonly channel: PolicyChannel; readonly today: BusinessDate; readonly lines: readonly WithdrawalLine[] }): WithdrawalCheck {
  if (input.channel !== 'CONSUMER_DISTANCE') return { applies: false, why: ["The right of withdrawal is a consumer's who bought at a distance (Codice del Consumo art. 52): this return is under the business customers' policy."], notes: [] }
  const why: string[] = []
  const notes: string[] = []
  for (const line of input.lines) {
    const what = line.seq === null ? 'It' : `Line ${line.seq}`
    if (line.orderSaysNone) why.push(`${what}: its order states that it has no right of withdrawal (made to measure for the consumer).`)
    else if (line.madeToMeasure) why.push(`${what} is made to measure: goods made to the consumer's specifications have no right of withdrawal (art. 59 c.1 c).`)
    else if (line.personalised) why.push(`${what} is personalised (the customer's artwork or own words): no right of withdrawal (art. 59 c.1 c).`)
    if (line.deliveredOn === null) notes.push(`${what}: the delivery day is not known; the ${WITHDRAWAL_DAYS} days count from delivery.`)
    else {
      const last = addDays(line.deliveredOn, WITHDRAWAL_DAYS)
      if (input.today > last) why.push(`${what} was delivered on ${line.deliveredOn}: the ${WITHDRAWAL_DAYS} days of withdrawal ended on ${last}.`)
    }
  }
  return { applies: why.length === 0, why, notes }
}

// ---- the deadline (SAL-337) ------------------------------------------------------------------------------------------

/** The last day the goods may arrive: the policy's days from the authorisation day (null: no deadline). */
export const deadlineOf = (authorisedOn: BusinessDate, goodsDueDays: number | null): BusinessDate | null => (goodsDueDays === null ? null : addDays(authorisedOn, goodsDueDays))

export const ARRIVAL_STATES = ['NO_DEADLINE', 'WAITING', 'OVERDUE', 'ON_TIME', 'LATE'] as const
export type ArrivalState = (typeof ARRIVAL_STATES)[number]

export interface ArrivalCheck {
  readonly state: ArrivalState
  /** Days after the deadline: of the first receipt (LATE), or of today while still waiting (OVERDUE); else 0. */
  readonly daysLate: number
  readonly words: string
}

/** The goods against the deadline: on time, late (the first receipt's Rome day after goodsDueBy), still waiting or overdue. */
export function arrivalOf(goodsDueBy: BusinessDate | null, receivedOn: BusinessDate | null, today: BusinessDate): ArrivalCheck {
  if (goodsDueBy === null) return { state: 'NO_DEADLINE', daysLate: 0, words: receivedOn ? `Arrived on ${receivedOn}; the return has no deadline.` : 'No deadline for the goods.' }
  if (receivedOn === null) {
    if (today <= goodsDueBy) return { state: 'WAITING', daysLate: 0, words: `Waiting for the goods by ${goodsDueBy}.` }
    const late = daysBetween(goodsDueBy, today)
    return { state: 'OVERDUE', daysLate: late, words: `The goods were due by ${goodsDueBy}: ${late} ${late === 1 ? 'day' : 'days'} late and not here yet.` }
  }
  if (receivedOn <= goodsDueBy) return { state: 'ON_TIME', daysLate: 0, words: `Arrived on ${receivedOn}, by the deadline (${goodsDueBy}).` }
  const late = daysBetween(goodsDueBy, receivedOn)
  return { state: 'LATE', daysLate: late, words: `Arrived after the deadline: on ${receivedOn}, ${late} ${late === 1 ? 'day' : 'days'} after ${goodsDueBy}.` }
}

// ---- fees (SAL-343) --------------------------------------------------------------------------------------------------

export interface FeeRuleDraft {
  readonly channel: PolicyChannel | null
  readonly name: string
  readonly reasonCodes: readonly string[]
  readonly kind: FeeKind
  /** PERCENT: of the credit, above 0 and at most 100 (4 decimals). */
  readonly percent: string | null
  /** AMOUNT: minor units of `currency`, above 0. */
  readonly amount: number | null
  readonly currency: string | null
  readonly sequence: number
}

/** The problems of a fee rule as typed, each at its field. */
export function feeRuleProblems(draft: FeeRuleDraft): Issue[] {
  const problems: Issue[] = []
  if (draft.channel !== null && !POLICY_CHANNELS.includes(draft.channel)) problems.push({ path: 'channel', message: 'Business customers, consumers at a distance, or both.' })
  if (!oneLine(draft.name, DEPTH_LIMITS.name)) problems.push({ path: 'name', message: `The reason group's name: one line, 1 to ${DEPTH_LIMITS.name} characters.` })
  if (draft.reasonCodes.length > DEPTH_LIMITS.reasonCodes) problems.push({ path: 'reasonCodes', message: `At most ${DEPTH_LIMITS.reasonCodes} reason codes.` })
  else if (new Set(draft.reasonCodes).size !== draft.reasonCodes.length) problems.push({ path: 'reasonCodes', message: 'Each reason once.' })
  else {
    const bad = draft.reasonCodes.findIndex((code) => !REASON_CODE.test(code))
    if (bad >= 0) problems.push({ path: `reasonCodes/${bad}`, message: 'A reason code: capitals, digits and _ (2 to 40).' })
  }
  if (draft.kind === 'PERCENT') {
    const percent = draft.percent === null ? null : parseDecimal(draft.percent)
    if (percent === null || percent.lte(0) || percent.gt(100) || percent.decimalPlaces() > 4) problems.push({ path: 'percent', message: 'A percent of the credit above 0 and at most 100 (4 decimals).' })
    if (draft.amount !== null) problems.push({ path: 'amount', message: 'A percent rule has no amount.' })
    if (draft.currency !== null) problems.push({ path: 'currency', message: 'A percent rule has no currency.' })
  } else if (draft.kind === 'AMOUNT') {
    if (draft.amount === null || !Number.isSafeInteger(draft.amount) || draft.amount <= 0) problems.push({ path: 'amount', message: 'A fee above 0, in cents.' })
    if (draft.currency === null || !/^[A-Z]{3}$/.test(draft.currency) || !isCurrencyCode(draft.currency)) problems.push({ path: 'currency', message: 'The currency of the amount (EUR).' })
    if (draft.percent !== null) problems.push({ path: 'percent', message: 'An amount rule has no percent.' })
  } else {
    problems.push({ path: 'kind', message: 'A percent of the credit, or a fixed amount per line.' })
  }
  if (!Number.isInteger(draft.sequence) || draft.sequence < 1 || draft.sequence > DEPTH_LIMITS.sequence) problems.push({ path: 'sequence', message: `Its order among the rules: 1 to ${DEPTH_LIMITS.sequence} (lower first).` })
  return problems
}

export interface FeeRuleLike {
  readonly id: string
  readonly name: string
  readonly channel: PolicyChannel | null
  readonly reasonCodes: readonly string[]
  readonly kind: FeeKind
  readonly percent: string | null
  readonly amount: number | null
  readonly currency: string | null
  readonly sequence: number
  readonly active: boolean
  /** For the order among rules of one sequence (oldest first). */
  readonly createdAt?: string | null
}

/** The rule that gives a line its fee: the first active one (sequence, oldest, id) of the channel (or none) and the reason (or every reason). */
export function pickFeeRule<R extends FeeRuleLike>(rules: readonly R[], line: { readonly channel: PolicyChannel; readonly reasonCode: string }): R | null {
  const ordered = [...rules].filter((rule) => rule.active).sort((a, b) => a.sequence - b.sequence || (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id))
  return ordered.find((rule) => (rule.channel === null || rule.channel === line.channel) && (rule.reasonCodes.length === 0 || rule.reasonCodes.includes(line.reasonCode))) ?? null
}

/** Causes that are ours to carry (our defect, damage on the way: the freight's BY_CAUSE reading): the fee is dropped. */
export const OUR_CAUSES: readonly ReturnCause[] = Object.freeze(['OUR_DEFECT', 'TRANSIT'])

export const FEE_DROPS = ['OUR_CAUSE', 'NO_CREDIT', 'OTHER_CURRENCY'] as const
export type FeeDrop = (typeof FEE_DROPS)[number]

export interface FeeOutcome {
  /** The fee withheld from the credit, minor units (0 when dropped). */
  readonly amount: MinorUnits
  /** Why there is no fee, when there is none. */
  readonly dropped: FeeDrop | null
  /** The credit after the fee (minor units). */
  readonly creditAfter: MinorUnits
  /** The fee in words, without an amount ("Change of mind: 10 % of the credit" / "… dropped: the cause is ours"). */
  readonly words: string
}

/** A rule's terms in words, without an amount for a fixed fee ("10 % of the credit", "a fixed amount per line"). */
export function feeTermsWords(rule: Pick<FeeRuleLike, 'kind' | 'percent'>): string {
  return rule.kind === 'PERCENT' ? `${new Dec(rule.percent ?? '0').toFixed()} % of the credit` : 'a fixed amount per line'
}

/**
 * The fee a rule gives a line's credit: PERCENT of the credit (rounded half up to the cent), or the fixed AMOUNT (never
 * more than the credit); dropped when the cause found is ours, when there is no credit, or when a fixed fee is in another
 * currency than the credit.
 */
export function feeOf(rule: Pick<FeeRuleLike, 'name' | 'kind' | 'percent' | 'amount' | 'currency'>, line: { readonly credit: number; readonly currency: string | null; readonly cause: ReturnCause | null }): FeeOutcome {
  const terms = `${rule.name}: ${feeTermsWords(rule)}`
  const none = (dropped: FeeDrop, why: string): FeeOutcome => ({ amount: 0, dropped, creditAfter: Math.max(0, line.credit), words: `${terms}, dropped: ${why}.` })
  if (line.cause !== null && OUR_CAUSES.includes(line.cause)) return none('OUR_CAUSE', line.cause === 'OUR_DEFECT' ? 'the cause is ours (our defect)' : 'the cause is ours (damaged on the way)')
  if (line.credit <= 0 || line.currency === null) return none('NO_CREDIT', 'there is no credit to withhold it from')
  let fee: number
  if (rule.kind === 'PERCENT') {
    fee = Number(new Dec(line.credit).times(new Dec(rule.percent ?? '0')).dividedBy(100).toDecimalPlaces(0, Dec.ROUND_HALF_UP).toFixed(0))
  } else {
    if (rule.currency !== line.currency) return none('OTHER_CURRENCY', `the fee is in ${rule.currency ?? '?'}, the credit in ${line.currency}`)
    fee = rule.amount ?? 0
  }
  const amount = Math.min(Math.max(0, fee), line.credit)
  return { amount, dropped: null, creditAfter: line.credit - amount, words: terms }
}

/** A fee with its amount (for a caller with the price grain): "Change of mind: 10 % of the credit = 12.00 EUR". */
export function feeWithAmount(fee: Pick<FeeOutcome, 'amount' | 'dropped' | 'words'>, currency: string | null): string {
  if (fee.dropped !== null || currency === null || !isCurrencyCode(currency)) return fee.words
  return `${fee.words} = ${fromMinorUnits(fee.amount, currency).toFixed(2)} ${currency}`
}

/** A fixed fee typed in major units ("15.00") as minor units of its currency (null: not a fee). */
export function feeAmountOf(value: string, currency: string): MinorUnits | null {
  const parsed = parseDecimal(value)
  if (parsed === null || parsed.lte(0) || !isCurrencyCode(currency)) return null
  return toMinorUnits(parsed, currency)
}

// ---- credit without a return (SAL-342) -------------------------------------------------------------------------------

export const CREDIT_WITHOUT_RETURN_STATUSES: readonly ReturnStatus[] = Object.freeze(['AUTHORISED', 'RECEIVED', 'INSPECTED'])

export interface CreditWithoutReturnFacts {
  readonly status: ReturnStatus
  readonly seq: number
  readonly quantity: number
  readonly received: number
  readonly decided: boolean
  /** What the line's pieces are worth, net (minor units); null: no price known. */
  readonly value: number | null
  /** A yes is waiting for it already. */
  readonly waiting: boolean
}

/** The problems of crediting a line without the goods coming back (`creditAmount` minor units; undefined: what it is worth). */
export function creditWithoutReturnProblems(facts: CreditWithoutReturnFacts, creditAmount: number | undefined): Issue[] {
  if (!CREDIT_WITHOUT_RETURN_STATUSES.includes(facts.status)) {
    return [{ path: 'status', message: facts.status === 'REQUESTED' ? 'Authorise the return first.' : `The return is ${facts.status.toLowerCase()}: nothing more is credited on it.` }]
  }
  if (facts.decided) return [{ path: 'lineId', message: `Line ${facts.seq} is decided already.` }]
  if (facts.received > 0) return [{ path: 'lineId', message: `Pieces of line ${facts.seq} arrived: decide them at the inspection (a credit without the goods is for a line none of whose pieces came).` }]
  if (facts.waiting) return [{ path: 'lineId', message: `A credit of line ${facts.seq} without the goods waits for a yes already.` }]
  if (facts.value === null) return [{ path: 'creditAmount', message: 'No price is known for this line: it cannot be credited here.' }]
  const credit = creditAmount ?? facts.value
  if (!Number.isSafeInteger(credit) || credit <= 0) return [{ path: 'creditAmount', message: 'A credit above 0, in cents.' }]
  if (credit > facts.value) return [{ path: 'creditAmount', message: 'Never more than what its pieces are worth.' }]
  return []
}

/** The effect of a credit without the goods, in words (no amount). */
export const CREDIT_WITHOUT_RETURN_EFFECT = 'A credit; the goods stay with the customer (credited without a return); a credit note to make (Finance)'

// ---- the scan code (SAL-346) -----------------------------------------------------------------------------------------

/** The scan code's shape (the guard's): capitals, digits and dashes, 6 to 40, starting with a capital or a digit. */
export const SCAN_CODE = /^[A-Z0-9][A-Z0-9-]{5,39}$/

const scanPart = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

const fit = (code: string): string => {
  const cut = code.slice(0, DEPTH_LIMITS.scanCode).replace(/-+$/, '')
  return cut.length >= 6 ? cut : `RMA-${cut}`.padEnd(6, '0').slice(0, DEPTH_LIMITS.scanCode)
}

/**
 * The scan codes an RMA may take, in the order they are tried: its number as capitals, digits and dashes
 * ("RMA-2026-0001"); its company's code before it when another RMA of the tenant holds that (two companies number alike);
 * then the same with -2, -3 … Every candidate fits the shape.
 */
export function scanCodeCandidates(number: string, companyCode: string, tries = 5): string[] {
  const own = fit(scanPart(number) || 'RMA')
  const company = scanPart(companyCode)
  const prefixed = fit(company ? `${company}-${scanPart(number) || 'RMA'}` : own)
  const out = [own, prefixed]
  for (let n = 2; n < 2 + tries; n++) out.push(fit(`${prefixed.slice(0, DEPTH_LIMITS.scanCode - 1 - String(n).length)}-${n}`))
  return [...new Set(out)].filter((code) => SCAN_CODE.test(code))
}

/** A scanned or typed code read as a scan code (capitals; null: it cannot be one). */
export function scanCodeOf(value: string): string | null {
  const code = value.trim().toUpperCase()
  return SCAN_CODE.test(code) ? code : null
}
