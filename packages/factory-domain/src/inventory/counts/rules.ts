import type { Issue } from '../../core/errors'
import { toMinorUnits, type CurrencyCode, type MinorUnits } from '../../core/money'
import { businessDayRange, isBusinessDate, type BusinessDate } from '../../core/time'
import { ITEM_KINDS } from '../../product/materials/rules'
import { defineMachine } from '../../state/machine'
import { Dec, HUNDRED, parseDecimal, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'
import { QUANTITY_SCALE, quantityText, type LocatedKey } from '../ledger/moves'

/**
 * Stock counts: the cycle count and the year-end physical inventory of a site (B-W2a-15; SCM-224, SCM-230; SCM-229 and
 * SCM-293 for the approval; c.c. art. 2217: the inventory drawn up at the end of each fiscal year). Pure: the API's
 * modules/inventory/counts reads the ledger and the costs and writes through command(); the …_stock_plan_w2a_guards
 * triggers hold the same rules for every login.
 *
 *   DRAFT      the scope is set (a location and everything under it, an item, a lot of it, a kind of material; none: the
 *              whole site) and nothing is frozen yet;
 *   COUNTING   the expected quantities are frozen: one line per stock key (location, item, colour, lot, hide) the ledger
 *              held inside the scope at the snapshot, its expected quantity that balance. People type what they counted
 *              (0: not found), add what they found that was not expected (an ADDED line, expected 0), and recount;
 *   SUBMITTED  every line counted, every recount asked for done, every line that differs says why; the differences are
 *              valued (|difference| × unit cost, the cost grain) and the value decides whether a second person approves;
 *   APPROVED   by a person who counted or recounted no line that differs (when an approval is needed);
 *   APPLIED    one COUNT move per line that differs, into its location for more, out of it for less, dated at the snapshot;
 *   SIGNED_OFF a year-end count only: the valued list as of its inventory date, frozen as a file of the count.
 * A SUBMITTED count goes back to COUNTING with the approver's reason (a recount); DRAFT to APPROVED may be CANCELLED.
 *
 * The limits the Warehouse settings will hold in W2b (SCM-229) are domain defaults until then: COUNT_RULES.
 */

export const STOCK_COUNT_KINDS = ['CYCLE', 'YEAR_END'] as const
export type StockCountKind = (typeof STOCK_COUNT_KINDS)[number]

export const STOCK_COUNT_STATUSES = ['DRAFT', 'COUNTING', 'SUBMITTED', 'APPROVED', 'APPLIED', 'SIGNED_OFF', 'CANCELLED'] as const
export type StockCountStatus = (typeof STOCK_COUNT_STATUSES)[number]

/** The states in which a count holds its stock keys: no other count may count them at the same time. */
export const OPEN_COUNT_STATUSES = ['COUNTING', 'SUBMITTED', 'APPROVED'] as const satisfies readonly StockCountStatus[]

export const COUNT_LINE_ORIGINS = ['SNAPSHOT', 'ADDED'] as const
export type CountLineOrigin = (typeof COUNT_LINE_ORIGINS)[number]

/** The kinds of material a count may be limited to: the materials' kinds and the finished garments. */
export const COUNT_ITEM_KINDS = [...ITEM_KINDS, 'FINISHED'] as const
export type CountItemKind = (typeof COUNT_ITEM_KINDS)[number]

export const stockCountMachine = defineMachine({
  name: 'stock count',
  states: STOCK_COUNT_STATUSES,
  transitions: {
    DRAFT: ['COUNTING', 'CANCELLED'],
    COUNTING: ['SUBMITTED', 'CANCELLED'],
    SUBMITTED: ['APPROVED', 'COUNTING', 'CANCELLED'],
    APPROVED: ['APPLIED', 'CANCELLED'],
    APPLIED: ['SIGNED_OFF'],
  },
})

export interface CountRules {
  /** Differences worth more than this, in minor units of the company's currency, need a second person's approval. */
  readonly approvalLimitMinor: MinorUnits
  /** A line whose difference is more than this percentage of what was expected is flagged for a recount. */
  readonly recountPercent: string
}

/**
 * The counts' rules until the Warehouse settings exist (W2b, SCM-229): an approval over EUR 500.00 of differences, and
 * a recount flag over 5 % of the expected quantity (and for every hide that differs, and anything found where nothing
 * was expected). Named defaults, not settings: GATE-ACCOUNTANT or the Owner may change them with the settings step.
 */
export const COUNT_RULES: CountRules = Object.freeze({ approvalLimitMinor: 50_000, recountPercent: '5' })

export const COUNT_LIMITS = Object.freeze({
  /** Lines one count may hold (a narrower scope counts more). */
  maxLines: 10_000,
  /** Lines one request records or asks to recount. */
  batch: 500,
  /** A page of lines. */
  page: 500,
  team: 120,
  note: 1000,
  reasonNote: 500,
  reason: 500,
})

/** The fiscal year ends on 31 December (Q28; no company column for another fiscal year yet). */
export const FISCAL_YEAR_END = Object.freeze({ month: 12, day: 31 })
export const isFiscalYearEnd = (date: BusinessDate): boolean =>
  isBusinessDate(date) && date.slice(5) === `${String(FISCAL_YEAR_END.month).padStart(2, '0')}-${String(FISCAL_YEAR_END.day).padStart(2, '0')}`

// ---- creating and starting ----------------------------------------------------------------------------------------------

export interface NewCountFacts {
  readonly kind: StockCountKind
  readonly inventoryDate: BusinessDate | null
}

/** What is wrong with a new count's kind and date (paths `body/…`). */
export function createProblems(input: NewCountFacts): Issue[] {
  const problems: Issue[] = []
  if (input.kind === 'YEAR_END') {
    if (input.inventoryDate === null) problems.push({ path: 'body/inventoryDate', message: 'A year-end inventory names its inventory date (the last day of the fiscal year).' })
    else if (!isFiscalYearEnd(input.inventoryDate)) problems.push({ path: 'body/inventoryDate', message: 'The year-end inventory is taken as of the last day of the fiscal year, 31 December.' })
  } else if (input.inventoryDate !== null) {
    problems.push({ path: 'body/inventoryDate', message: 'Only a year-end inventory has an inventory date.' })
  }
  return problems
}

export type SnapshotDecision = { readonly at: Date; readonly problem?: undefined } | { readonly at?: undefined; readonly problem: string }

/**
 * The instant whose ledger balances a count expects. A cycle count: its start. A year-end inventory: the end of its
 * inventory date (Europe/Rome) when it starts later, its start when it starts on the day itself; it never starts before
 * the day.
 */
export function snapshotFor(kind: StockCountKind, inventoryDate: BusinessDate | null, now: Date): SnapshotDecision {
  if (kind === 'CYCLE' || inventoryDate === null) return { at: now }
  const { start, end } = businessDayRange(inventoryDate)
  if (now.getTime() < start.getTime()) return { problem: `A year-end inventory starts on its inventory date (${inventoryDate}) or after it.` }
  if (now.getTime() < end.getTime()) return { at: now }
  return { at: new Date(end.getTime() - 1) }
}

/** A stock key the ledger held at the snapshot, with its balance there. */
export interface SnapshotBalance extends LocatedKey {
  readonly onHand: DecimalInput
}

export interface SnapshotLine extends LocatedKey {
  readonly seq: number
  readonly expected: string
}

/**
 * The count sheet's lines from the snapshot's balances: every stock key with stock (a hide one line each), in the
 * order the sheet is walked (`order`: the location's path, then the item, colour, lot and hide codes), numbered 10, 20, …
 */
export function snapshotLines(balances: readonly SnapshotBalance[], order: (key: LocatedKey) => readonly string[]): SnapshotLine[] {
  const held = balances.filter((balance) => new Dec(balance.onHand).greaterThan(0))
  const keyed = held.map((balance) => ({ balance, sort: order(balance) }))
  keyed.sort((a, b) => {
    for (let index = 0; index < Math.max(a.sort.length, b.sort.length); index++) {
      const left = a.sort[index] ?? ''
      const right = b.sort[index] ?? ''
      if (left !== right) return left < right ? -1 : 1
    }
    return 0
  })
  return keyed.map(({ balance }, index) => ({
    siteId: balance.siteId,
    locationId: balance.locationId,
    itemId: balance.itemId,
    itemColourId: balance.itemColourId ?? null,
    lotId: balance.lotId ?? null,
    hideId: balance.hideId ?? null,
    seq: (index + 1) * 10,
    expected: quantityText(balance.onHand),
  }))
}

// ---- one line -----------------------------------------------------------------------------------------------------------

export interface LineFacts {
  readonly expected: DecimalInput
  readonly counted: DecimalInput | null
  readonly recountRequested: boolean
  readonly recount: DecimalInput | null
}

export type LineStatus = 'UNCOUNTED' | 'RECOUNT_DUE' | 'COUNTED'

export function lineStatus(line: LineFacts): LineStatus {
  if (line.counted === null) return 'UNCOUNTED'
  if (line.recountRequested && line.recount === null) return 'RECOUNT_DUE'
  return 'COUNTED'
}

/** What the line says is there: the recount, else the count; null while not counted. */
export function finalCount(line: LineFacts): Decimal | null {
  if (line.recount !== null) return new Dec(line.recount)
  return line.counted === null ? null : new Dec(line.counted)
}

/** The final count less what was expected: + found more, − found less; null while not counted. */
export function differenceOf(line: LineFacts): Decimal | null {
  const final = finalCount(line)
  return final === null ? null : final.minus(line.expected)
}

export const differs = (line: LineFacts): boolean => {
  const difference = differenceOf(line)
  return difference !== null && !difference.isZero()
}

/** The difference as a percentage of what was expected (one decimal); null when nothing was expected or not counted. */
export function differencePercent(line: LineFacts): string | null {
  const difference = differenceOf(line)
  const expected = new Dec(line.expected)
  if (difference === null || expected.isZero()) return null
  return difference.dividedBy(expected).times(HUNDRED).toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1)
}

/**
 * Whether the difference asks for a recount (the Differences tab's flag): a hide that differs (found, missing or of
 * another area), anything found where nothing was expected, or a difference over the recount percentage.
 */
export function recountSuggested(line: LineFacts & { readonly hideId: string | null }, rules: CountRules = COUNT_RULES): boolean {
  const difference = differenceOf(line)
  if (difference === null || difference.isZero()) return false
  if (line.hideId !== null) return true
  const expected = new Dec(line.expected)
  if (expected.isZero()) return true
  return difference.abs().dividedBy(expected).times(HUNDRED).greaterThan(rules.recountPercent)
}

/** What a counted quantity must be (path `…/<field>`). A hide is counted by its area, never more than it measured. */
export function quantityProblem(value: string, path: string, hideArea: DecimalInput | null = null): Issue | null {
  const parsed = parseDecimal(value)
  if (parsed === null || parsed.isNegative() || parsed.decimalPlaces() > QUANTITY_SCALE) {
    return { path, message: `Expected a quantity from 0, with at most ${QUANTITY_SCALE} decimals.` }
  }
  if (parsed.greaterThan('99999999999999')) return { path, message: 'The quantity is too large.' }
  if (hideArea !== null && parsed.greaterThan(hideArea)) return { path, message: `A hide is counted by its area: at most ${quantityText(hideArea)}, the area it measured.` }
  return null
}

export interface PlannedMove {
  readonly direction: 'IN' | 'OUT'
  readonly fromLocationId: string | null
  readonly toLocationId: string | null
  /** In the item's base unit, above 0. */
  readonly baseQuantity: string
}

/** The COUNT move a line's difference posts: into its location for more, out of it for less; null when it agrees. */
export function plannedMoveOf(line: LineFacts & { readonly locationId: string }): PlannedMove | null {
  const difference = differenceOf(line)
  if (difference === null || difference.isZero()) return null
  const into = difference.greaterThan(0)
  return {
    direction: into ? 'IN' : 'OUT',
    fromLocationId: into ? null : line.locationId,
    toLocationId: into ? line.locationId : null,
    baseQuantity: quantityText(difference.abs()),
  }
}

/** The COUNT move's note (the ledger's "why", SCM-192): the count, the line and its reason. */
export function countMoveNote(number: string, seq: number, reasonCode: string | null, reasonNote: string | null): string {
  const reason = [reasonCode, reasonNote?.trim() || null].filter((part): part is string => part !== null && part !== '').join(' — ')
  return `Count ${number} line ${seq}${reason ? `: ${reason}` : ''}`.slice(0, 500)
}

// ---- the value of the differences and the approval ---------------------------------------------------------------------

export interface ValuedLine extends LineFacts {
  /** Per base unit (the lot's cost, else the item's standard cost); null: nothing gives one. */
  readonly unitCost: DecimalInput | null
  readonly currency: CurrencyCode
}

export interface DifferenceValue {
  /** Σ |difference| × unit cost, in minor units of the company's currency, rounded once. */
  readonly amount: MinorUnits
  /** Lines that differ. */
  readonly lines: number
  /** Lines that differ without a unit cost: their value is unknown. */
  readonly unvalued: number
  /** Lines that differ in another currency than the company's: not added. */
  readonly otherCurrency: number
}

/** What a count's differences are worth (SCM-229's value): the approval rule reads it. */
export function differenceValue(lines: readonly ValuedLine[], companyCurrency: CurrencyCode): DifferenceValue {
  let exact = ZERO
  let count = 0
  let unvalued = 0
  let otherCurrency = 0
  for (const line of lines) {
    const difference = differenceOf(line)
    if (difference === null || difference.isZero()) continue
    count += 1
    if (line.unitCost === null) unvalued += 1
    else if (line.currency !== companyCurrency) otherCurrency += 1
    else exact = exact.plus(difference.abs().times(line.unitCost))
  }
  return { amount: toMinorUnits(exact, companyCurrency), lines: count, unvalued, otherCurrency }
}

/**
 * Whether a second person approves (SCM-229): the differences are worth more than the limit, or their value is not
 * known in full (a line without a cost, or in another currency), so it cannot be shown to be under it.
 */
export const needsApproval = (value: DifferenceValue, rules: CountRules = COUNT_RULES): boolean =>
  value.unvalued > 0 || value.otherCurrency > 0 || value.amount > rules.approvalLimitMinor

/** One line's difference at its unit cost, signed like the difference, in minor units; null without a cost. */
export function lineValue(line: LineFacts, unitCost: DecimalInput | null, currency: CurrencyCode): MinorUnits | null {
  const difference = differenceOf(line)
  if (difference === null || unitCost === null) return null
  const amount = toMinorUnits(difference.times(unitCost), currency)
  return amount === 0 ? 0 : amount
}

// ---- refusals in words --------------------------------------------------------------------------------------------------

export interface CountProblem {
  readonly code: string
  readonly message: string
}

const listed = (seqs: readonly number[]): string => (seqs.length <= 12 ? seqs.join(', ') : `${seqs.slice(0, 12).join(', ')} and ${seqs.length - 12} more`)

export interface SubmitLine extends LineFacts {
  readonly seq: number
  readonly reasonCode: string | null
}

/** What stops a count from being submitted: lines not counted, recounts not done, differences without a reason. */
export function submitProblems(lines: readonly SubmitLine[]): CountProblem[] {
  const problems: CountProblem[] = []
  const uncounted = lines.filter((line) => lineStatus(line) === 'UNCOUNTED').map((line) => line.seq)
  const recounts = lines.filter((line) => lineStatus(line) === 'RECOUNT_DUE').map((line) => line.seq)
  const unreasoned = lines.filter((line) => lineStatus(line) === 'COUNTED' && differs(line) && !line.reasonCode).map((line) => line.seq)
  if (uncounted.length > 0) problems.push({ code: 'UNCOUNTED', message: `${uncounted.length} line(s) are not counted yet (${listed(uncounted)}); type 0 for what was not found.` })
  if (recounts.length > 0) problems.push({ code: 'RECOUNT_DUE', message: `${recounts.length} recount(s) asked for are not done yet (lines ${listed(recounts)}).` })
  if (unreasoned.length > 0) problems.push({ code: 'NO_REASON', message: `${unreasoned.length} line(s) that differ say no reason (${listed(unreasoned)}); pick one from the adjustment reasons.` })
  return problems
}

export interface ApprovalLine extends LineFacts {
  readonly seq: number
  readonly countedById: string | null
  readonly recountedById: string | null
}

/**
 * The counter never approves their own variance (SCM-229, SCM-293): when the approval is needed, the approver counted or
 * recounted no line that differs. Below the limit anyone who may approve does.
 */
export function approveProblems(approvalRequired: boolean, approverId: string, lines: readonly ApprovalLine[]): CountProblem[] {
  if (!approvalRequired) return []
  const own = lines.filter((line) => differs(line) && (line.countedById === approverId || line.recountedById === approverId)).map((line) => line.seq)
  return own.length > 0
    ? [{ code: 'OWN_VARIANCE', message: `You counted or recounted ${own.length} line(s) that differ (${listed(own)}); a person who did not count them approves the differences.` }]
    : []
}

/** The phrase typed to sign off a year-end inventory: the count's number. */
export const signOffPhrase = (number: string): string => number

export interface SignOffFacts {
  readonly kind: StockCountKind
  readonly status: StockCountStatus
  readonly number: string
}

export function signOffProblems(count: SignOffFacts, phrase: string): CountProblem[] {
  if (count.kind !== 'YEAR_END') return [{ code: 'NOT_YEAR_END', message: 'Only a year-end inventory is signed off; a cycle count is done once applied.' }]
  if (count.status === 'SIGNED_OFF') return [{ code: 'SIGNED_OFF', message: `Inventory ${count.number} is signed off already; its valued list is frozen.` }]
  if (count.status !== 'APPLIED') return [{ code: 'NOT_APPLIED', message: `Inventory ${count.number} is ${count.status}; it is signed off once its differences are applied.` }]
  if (phrase.trim() !== signOffPhrase(count.number)) return [{ code: 'PHRASE', message: `Type the inventory's number, ${signOffPhrase(count.number)}, to sign it off.` }]
  return []
}
