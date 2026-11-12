import type { Issue } from '../../core/errors'
import { Dec, type Decimal } from '../../tax/decimal'
import { decimalOf, QUANTITY_SCALE } from '../../product/units/units'

/**
 * The material balance per job (B-W2b-331; SCM-143, SCM-144, follow-up TZ1:01; design purchasing.subcontracting record tab
 * "Material balance": "Sent = in returned goods + returned unused + declared scrap + loss; what is still open"; factory-db
 * buying-depth.prisma SubcontractConsumption, B-W2b-285). Pure. Per SENT kit line of an order, in the line's unit:
 *
 *   sent       the kit line's quantity (what left our place with the kit)
 *   checked    what the workshop counted when the kit came (its kit check, B-W2b-176), short when it is less than sent
 *   announced  the unused material its send-back notices say comes back (B-W2b-176's materialBack)
 *   back       the material of the line that came back into our places with the order's receipts (the receive's moves)
 *   used, returned, scrapped
 *              what the workshop declared (DECLARED rows, with the goods back) and the adjustments after the receipt
 *              (ADJUSTMENT rows, signed, with their reason: SCM-143)
 *   open       sent − used − returned − scrapped: still out (a loss once the job is closed)
 *
 * The book of a row moves our stock where the material went (the API's balance command): what was used leaves the
 * workshop's place to the work order (ISSUE; less used comes back from it: RETURN), what was scrapped is written off at the
 * workshop's place (SCRAP; less scrap takes the scrap moves back). What was returned is the receive's own move back into
 * our place: a declaration never moves it. So the workshop's place holds, per line, the open rest and what was declared
 * returned but has not come back yet.
 */

export const CONSUMPTION_KINDS = ['DECLARED', 'ADJUSTMENT'] as const
export type ConsumptionKind = (typeof CONSUMPTION_KINDS)[number]

/** Codes are a REWORK list's style (no spaces, at most 40); words at most 2000 (the database's). */
export const REASON_CODE = /^[A-Z0-9][A-Z0-9_-]{0,39}$/
export const REASON_MAX = 2000

const ZERO = new Dec(0)
const q = (value: Decimal): string => value.toFixed(QUANTITY_SCALE)

export interface Sums {
  readonly used: Decimal
  readonly returned: Decimal
  readonly scrapped: Decimal
}

export interface ConsumptionRowFacts {
  readonly kind: ConsumptionKind
  readonly used: string
  readonly returned: string
  readonly scrapped: string
}

/** The sums of a kit line's rows (signed adjustments included). */
export function sumsOf(rows: readonly ConsumptionRowFacts[]): Sums {
  return rows.reduce<Sums>(
    (sum, row) => ({ used: sum.used.plus(decimalOf(row.used)), returned: sum.returned.plus(decimalOf(row.returned)), scrapped: sum.scrapped.plus(decimalOf(row.scrapped)) }),
    { used: ZERO, returned: ZERO, scrapped: ZERO },
  )
}

/** Still out: sent less what the workshop declared used, returned and scrapped. */
export const openOf = (sent: Decimal, sums: Sums): Decimal => sent.minus(sums.used).minus(sums.returned).minus(sums.scrapped)

export const BALANCE_FLAGS = ['SHORT_AT_WORKSHOP', 'NOT_DECLARED', 'RETURN_NOT_BACK', 'BACK_NOT_DECLARED', 'OPEN_AFTER_BACK'] as const
export type BalanceFlag = (typeof BALANCE_FLAGS)[number]

export interface LineFacts {
  /** In the line's unit, 4 places. */
  readonly sent: string
  readonly uom: string
  /** The workshop's kit check; null: not checked. */
  readonly checked: string | null
  /** The order's receipts brought this much of the line back into our places. */
  readonly back: string
  readonly rows: readonly ConsumptionRowFacts[]
}

export interface OrderBackFacts {
  /** Every piece of the order came back (RECEIVED or CLOSED). */
  readonly allBack: boolean
  /** Some pieces came back. */
  readonly someBack: boolean
}

export interface LineBalance {
  readonly sent: string
  readonly used: string
  readonly returned: string
  readonly scrapped: string
  readonly open: string
  /** checked − sent when the workshop counted less (negative), else null. */
  readonly short: string | null
  readonly flags: { readonly flag: BalanceFlag; readonly words: string }[]
}

/** A kit line's balance and what is wrong with it, in words. */
export function lineBalanceOf(line: LineFacts, order: OrderBackFacts): LineBalance {
  const sent = decimalOf(line.sent)
  const sums = sumsOf(line.rows)
  const open = openOf(sent, sums)
  const back = decimalOf(line.back)
  const flags: { flag: BalanceFlag; words: string }[] = []
  const short = line.checked !== null && decimalOf(line.checked).lessThan(sent) ? decimalOf(line.checked).minus(sent) : null
  if (short) flags.push({ flag: 'SHORT_AT_WORKSHOP', words: `The workshop counted ${q(decimalOf(line.checked!))} ${line.uom} of the ${q(sent)} sent: ${q(short.negated())} short on arrival.` })
  const declared = line.rows.some((row) => row.kind === 'DECLARED')
  if (!declared && order.someBack) flags.push({ flag: 'NOT_DECLARED', words: 'Goods came back, but the workshop has not declared what it used of this material yet.' })
  if (sums.returned.greaterThan(back)) flags.push({ flag: 'RETURN_NOT_BACK', words: `Declared returned ${q(sums.returned)} ${line.uom}; ${q(back)} came back into our places so far.` })
  if (back.greaterThan(sums.returned)) flags.push({ flag: 'BACK_NOT_DECLARED', words: `${q(back)} ${line.uom} came back into our places; the workshop declared ${q(sums.returned)} returned.` })
  if (order.allBack && open.greaterThan(0)) flags.push({ flag: 'OPEN_AFTER_BACK', words: `Every piece is back and ${q(open)} ${line.uom} is still out: book it as used, returned or scrapped (a loss).` })
  return { sent: q(sent), used: q(sums.used), returned: q(sums.returned), scrapped: q(sums.scrapped), open: q(open), short: short ? q(short) : null, flags }
}

export interface Quantities {
  readonly used: string
  readonly returned: string
  readonly scrapped: string
}

const words = (value: string | null | undefined): boolean => value !== null && value !== undefined && value.trim().length >= 1 && value.trim().length <= REASON_MAX

function reasonProblems(at: string, reasonCode: string | null | undefined, reason: string | null | undefined, required: boolean): Issue[] {
  const problems: Issue[] = []
  if (required && !words(reason)) problems.push({ path: `${at}/reason`, message: `Say why (1 to ${REASON_MAX} characters).` })
  if (!required && reason !== null && reason !== undefined && !words(reason)) problems.push({ path: `${at}/reason`, message: `The reason is 1 to ${REASON_MAX} characters.` })
  if (reasonCode !== null && reasonCode !== undefined) {
    if (!REASON_CODE.test(reasonCode)) problems.push({ path: `${at}/reasonCode`, message: 'A reason code is a code of the list: capitals, digits, - and _, at most 40.' })
    else if (!words(reason)) problems.push({ path: `${at}/reason`, message: 'A reason code goes with the reason in words.' })
  }
  return problems
}

/** A declaration of the workshop for one SENT kit line (path `body/lines/<i>`): each 0 or more, one above 0, within what is open. */
export function declarationProblems(at: string, line: LineFacts, input: Quantities & { readonly reasonCode?: string | null | undefined; readonly reason?: string | null | undefined }): Issue[] {
  const used = decimalOf(input.used, `${at}/used`)
  const returned = decimalOf(input.returned, `${at}/returned`)
  const scrapped = decimalOf(input.scrapped, `${at}/scrapped`)
  const problems: Issue[] = []
  for (const [field, value] of [['used', used], ['returned', returned], ['scrapped', scrapped]] as const) {
    if (value.lessThan(0)) problems.push({ path: `${at}/${field}`, message: 'A declaration holds 0 or more: a correction later is an adjustment with its reason.' })
    if (value.decimalPlaces() > QUANTITY_SCALE) problems.push({ path: `${at}/${field}`, message: `At most ${QUANTITY_SCALE} decimals.` })
  }
  if (used.isZero() && returned.isZero() && scrapped.isZero()) problems.push({ path: `${at}/used`, message: 'Declare at least one quantity above 0.' })
  const open = openOf(decimalOf(line.sent), sumsOf(line.rows))
  const asked = used.plus(returned).plus(scrapped)
  if (problems.length === 0 && asked.greaterThan(open)) {
    problems.push({ path: `${at}/used`, message: `Only ${q(open)} ${line.uom} of the ${q(decimalOf(line.sent))} sent is still open; the declaration says ${q(asked)}.` })
  }
  return [...problems, ...reasonProblems(at, input.reasonCode, input.reason, false)]
}

/**
 * An adjustment after the receipt (SCM-143; path `body`): signed changes, at least one not 0, after a declaration, with its
 * reason; the sums stay 0 or more and never pass what was sent.
 */
export function adjustmentProblems(at: string, line: LineFacts, change: Quantities & { readonly reasonCode?: string | null | undefined; readonly reason?: string | null | undefined }): Issue[] {
  const used = decimalOf(change.used, `${at}/used`)
  const returned = decimalOf(change.returned, `${at}/returned`)
  const scrapped = decimalOf(change.scrapped, `${at}/scrapped`)
  const problems: Issue[] = []
  for (const [field, value] of [['used', used], ['returned', returned], ['scrapped', scrapped]] as const) {
    if (value.decimalPlaces() > QUANTITY_SCALE) problems.push({ path: `${at}/${field}`, message: `At most ${QUANTITY_SCALE} decimals.` })
  }
  if (used.isZero() && returned.isZero() && scrapped.isZero()) problems.push({ path: `${at}/used`, message: 'Change at least one quantity (up or down).' })
  if (!line.rows.some((row) => row.kind === 'DECLARED')) problems.push({ path: `${at}/kitLineId`, message: 'The workshop has not declared this material yet: book its declaration first, then adjust it.' })
  const sums = sumsOf(line.rows)
  const after = { used: sums.used.plus(used), returned: sums.returned.plus(returned), scrapped: sums.scrapped.plus(scrapped) }
  for (const [field, value] of Object.entries(after)) {
    if (value.lessThan(0)) problems.push({ path: `${at}/${field}`, message: `The ${field} quantity would go below 0 (it is ${q(sums[field as keyof Sums])} ${line.uom}).` })
  }
  const sent = decimalOf(line.sent)
  if (after.used.plus(after.returned).plus(after.scrapped).greaterThan(sent)) {
    problems.push({ path: `${at}/used`, message: `Used, returned and scrapped would pass the ${q(sent)} ${line.uom} sent.` })
  }
  return [...problems, ...reasonProblems(at, change.reasonCode, change.reason, true)]
}

/**
 * The stock moves a row books, from its changes (4 places, each 0 or more): `issue` leaves the workshop's place to the work
 * order, `giveBack` comes back from the work order into the workshop's place (less used), `scrap` is written off there,
 * `unscrap` takes earlier scrap moves back (less scrapped). A returned change moves nothing (the receive moves it).
 */
export function movesOf(change: Pick<Quantities, 'used' | 'scrapped'>): { readonly issue: string; readonly giveBack: string; readonly scrap: string; readonly unscrap: string } {
  const used = decimalOf(change.used)
  const scrapped = decimalOf(change.scrapped)
  return {
    issue: q(used.greaterThan(0) ? used : ZERO),
    giveBack: q(used.lessThan(0) ? used.negated() : ZERO),
    scrap: q(scrapped.greaterThan(0) ? scrapped : ZERO),
    unscrap: q(scrapped.lessThan(0) ? scrapped.negated() : ZERO),
  }
}

/**
 * Which earlier scrap moves to take back for `unscrap` (newest first, whole moves: a move is reversed as it is) and what to
 * scrap again of the last one taken back (when it held more than needed). Null when the moves standing hold less.
 */
export function unscrapPlan(standing: readonly { readonly id: string; readonly quantity: string }[], unscrap: string): { readonly reverse: readonly string[]; readonly scrapAgain: string } | null {
  let need = decimalOf(unscrap)
  if (!need.greaterThan(0)) return { reverse: [], scrapAgain: q(ZERO) }
  const reverse: string[] = []
  let taken = ZERO
  for (const move of [...standing].reverse()) {
    if (!need.greaterThan(taken)) break
    reverse.push(move.id)
    taken = taken.plus(decimalOf(move.quantity))
  }
  if (taken.lessThan(need)) return null
  need = taken.minus(need)
  return { reverse, scrapAgain: q(need) }
}

export interface SuggestionFacts {
  readonly line: LineFacts
  /** The share of the pieces back (0 to 1) over the order's operations: the least share of any operation that sent pieces. */
  readonly shareBack: Decimal
}

/**
 * What a declaration is expected to say now, for the office to check against the workshop's papers: returned = what came
 * back into our places and is not declared yet; used = the line's share for the pieces back less what is declared used;
 * scrapped 0. Within what is open; each 0 or more.
 */
export function suggestionOf({ line, shareBack }: SuggestionFacts): Quantities {
  const sent = decimalOf(line.sent)
  const sums = sumsOf(line.rows)
  const open = openOf(sent, sums)
  const returned = Dec.max(ZERO, Dec.min(open, decimalOf(line.back).minus(sums.returned)))
  const expected = sent.times(Dec.min(new Dec(1), Dec.max(ZERO, shareBack))).toDecimalPlaces(QUANTITY_SCALE, Dec.ROUND_HALF_UP)
  const used = Dec.max(ZERO, Dec.min(open.minus(returned), expected.minus(sums.used)))
  return { used: q(used), returned: q(returned), scrapped: q(ZERO) }
}

/** The least share of the pieces back over the operations that sent pieces (back good + defective + scrapped over sent). */
export function shareBackOf(operations: readonly { readonly piecesSent: number; readonly piecesBackGood: number; readonly piecesBackDefective: number; readonly piecesScrapped: number }[]): Decimal {
  const shares = operations.filter((row) => row.piecesSent > 0).map((row) => new Dec(row.piecesBackGood + row.piecesBackDefective + row.piecesScrapped).div(row.piecesSent))
  return shares.length === 0 ? ZERO : Dec.min(...shares)
}

/** The lines whose balance the job still owes: any open rest once every piece is back. */
export const balanceOpen = (lines: readonly LineBalance[], order: OrderBackFacts): boolean => order.allBack && lines.some((line) => decimalOf(line.open).greaterThan(0))
