import { Dec, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'
import { COUNT_RULES, differs, recountSuggested, type CountRules, type LineFacts } from '../counts/rules'
import { quantityText } from '../ledger/moves'

/**
 * Counting by scanning every unit (B-W2b-299; SCM-228; design floor.count "Scan every unit", "Differences"; SCM-229 for the
 * recount): a bin of a COUNTING count is counted unit by unit, each scan a StockCountScan with its own quantity (a hide's
 * area, a roll's length, the pieces typed on the number pad for an item without a label). Blind: what the bin should hold is
 * shown only after "Bin done", with what is missing (expected, not scanned) and what is extra (scanned, not expected).
 * "Finish bin" writes each line of the bin: its count (or its recount) is the sum of its scans of that pass, 0 when none.
 * A line counted by scans whose difference is over the recount rule (a hide that differs, something found where nothing
 * was expected, more than 5 %) has its recount asked at once, and a recount is another person's (the database holds it while
 * the separation switch is on). Pure.
 */

export const SCAN_PASSES = ['COUNT', 'RECOUNT'] as const
export type ScanPass = (typeof SCAN_PASSES)[number]

export const SCAN_LIMITS = Object.freeze({ code: 120, perRequest: 1, bin: 500 })

/** What a bin's line is, for scanning. */
export interface BinLine extends LineFacts {
  readonly id: string
  readonly seq: number
  readonly origin: 'SNAPSHOT' | 'ADDED'
  readonly hideId: string | null
  readonly countedById: string | null
}

/** The pass a line is scanned in now: its count, else its recount once one is asked; null: counted (a recount asks again). */
export function passOf(line: Pick<LineFacts, 'counted' | 'recountRequested' | 'recount'>): ScanPass | null {
  if (line.counted === null) return 'COUNT'
  if (line.recountRequested && line.recount === null) return 'RECOUNT'
  return null
}

export interface ScanFacts {
  readonly lineId: string
  readonly pass: ScanPass
  readonly quantity: DecimalInput
  readonly code: string | null
}

/** The sum of a line's scans of a pass. */
export function scannedOf(scans: readonly ScanFacts[], lineId: string, pass: ScanPass): Decimal {
  return scans.filter((scan) => scan.lineId === lineId && scan.pass === pass).reduce<Decimal>((sum, scan) => sum.plus(scan.quantity), ZERO)
}

export const scanCount = (scans: readonly ScanFacts[], lineId: string, pass: ScanPass): number => scans.filter((scan) => scan.lineId === lineId && scan.pass === pass).length

/** A unit's own tag (a hide, a roll) is scanned once per pass of a count: a second scan is "Already counted". */
export function alreadyScanned(scans: readonly ScanFacts[], code: string | null, pass: ScanPass): boolean {
  if (code === null) return false
  const wanted = code.trim().toUpperCase()
  return scans.some((scan) => scan.pass === pass && scan.code !== null && scan.code.trim().toUpperCase() === wanted)
}

export type DifferenceKind = 'MATCH' | 'MISSING' | 'EXTRA' | 'SHORT' | 'OVER'

export interface BinDifference {
  readonly lineId: string
  readonly seq: number
  readonly pass: ScanPass
  readonly expected: string
  readonly scanned: string
  readonly scans: number
  readonly difference: string
  readonly kind: DifferenceKind
}

/** What "Bin done" shows: each line of the bin in its pass, what it should hold and what was scanned (blind until now). */
export function binDifferences(lines: readonly BinLine[], scans: readonly ScanFacts[]): BinDifference[] {
  const out: BinDifference[] = []
  for (const line of lines) {
    const pass = passOf(line)
    if (pass === null) continue
    const expected = new Dec(line.expected)
    const scanned = scannedOf(scans, line.id, pass)
    const difference = scanned.minus(expected)
    const kind: DifferenceKind = difference.isZero()
      ? 'MATCH'
      : scanned.isZero()
        ? 'MISSING'
        : expected.isZero()
          ? 'EXTRA'
          : difference.isNegative()
            ? 'SHORT'
            : 'OVER'
    out.push({ lineId: line.id, seq: line.seq, pass, expected: quantityText(expected), scanned: quantityText(scanned), scans: scanCount(scans, line.id, pass), difference: quantityText(difference), kind })
  }
  return out
}

export interface FinishWrite {
  readonly lineId: string
  readonly pass: ScanPass
  /** The line's count (COUNT) or recount (RECOUNT): the sum of its scans of the pass, 0 when none. */
  readonly quantity: string
}

/** "Finish bin": what each line of the bin is written as (the sum of its scans), in its pass. */
export function finishWrites(lines: readonly BinLine[], scans: readonly ScanFacts[]): FinishWrite[] {
  return lines.flatMap((line) => {
    const pass = passOf(line)
    return pass === null ? [] : [{ lineId: line.id, pass, quantity: quantityText(scannedOf(scans, line.id, pass)) }]
  })
}

/**
 * The recounts a finished bin asks at once (SCM-229 "a variance above the rule asks a recount by another person"): a line
 * just counted by its scans (COUNT pass) that differs over the recount rule, with no recount asked yet.
 */
export function recountsToAsk(finished: readonly (LineFacts & { readonly id: string; readonly hideId: string | null })[], rules: CountRules = COUNT_RULES): string[] {
  return finished.filter((line) => !line.recountRequested && differs(line) && recountSuggested(line, rules)).map((line) => line.id)
}

export interface Person {
  readonly userId: string | null
  readonly workerId: string | null
}

const samePerson = (a: Person, b: Person): boolean => (a.userId !== null && a.userId === b.userId) || (a.workerId !== null && a.workerId === b.workerId)

/**
 * A recount is another person's (SCM-229, while the separation switch is on): not the line's counter (an office user who
 * typed or scanned its count) and nobody who scanned a unit of its count pass (a worker, or the office user a worker is).
 */
export function recountByAnotherProblem(input: { readonly switchOn: boolean; readonly seq: number; readonly scanner: Person; readonly counters: readonly Person[] }): { readonly code: 'OWN_RECOUNT'; readonly message: string } | null {
  if (!input.switchOn) return null
  if (!input.counters.some((counter) => samePerson(counter, input.scanner))) return null
  return { code: 'OWN_RECOUNT', message: `You counted line ${input.seq}: its recount is another person's (separation of duties).` }
}

/** The quantity a scan adds, in words when it cannot (a unit's own size above 0, at most a hide's measured area). */
export function scanQuantityProblem(quantity: Decimal | null, hideArea: DecimalInput | null): string | null {
  if (quantity === null) return 'Type how much this unit holds on the number pad (it has no label that says it).'
  if (!quantity.greaterThan(0)) return 'A scanned unit holds something: above 0.'
  if (quantity.decimalPlaces() > 4) return 'At most 4 decimals.'
  if (hideArea !== null && quantity.greaterThan(hideArea)) return `A hide is counted by its area: at most ${quantityText(hideArea)}, the area it measured.`
  return null
}
