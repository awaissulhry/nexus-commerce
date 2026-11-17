import type { BusinessDate } from '../core/time'
import type { Words } from '../portal/tasks/kinds'
import { qualityResultsShown, type ProductionShareLevel } from './levels'

/**
 * B-PR-19 (production plan §2 the brand wall, §4 "+ Quality & photos", 06-tree §0.5 and P-ORD-quality, 08-backend "GET
 * /portal/production/:orderId/quality"; lead pick L8; the Owner rule 2026-11-16: "One brand must not be able to see anything related
 * to any other brand. But we, as the production unit, should be able to see it all. And manage it all as well."): the quality of a
 * customer's own goods as its portal reads it at the QUALITY level, pure. The API (apps/factory-api modules/production/brand-portal
 * quality.ts) reads its OWN order in the partner scope first, then the office's facts of exactly that order's cells, and words
 * them here:
 *
 *   cells     per line and size of its own order: pieces released by quality and taken back (a reversal), at every work order
 *             (a legacy work order that mixed customers gives it only its own cells), never above what it ordered
 *   results   final inspections (passed, failed, waiting; the sampling plan and the defects found) and first-piece, cutting and
 *             end-of-line checks ONLY of a work order that is the customer's alone (WorkOrder.partyId = it and every cell of the
 *             work order its own): a shared lot's results judge other goods too, so a line made on one reads "results are
 *             shared only for work made for you alone" instead (never a lot, a sample or a count of another's goods)
 *   holds     what held its goods, by reason code and its words (never the office's note, never who)
 *   photos    the photos the factory shared on its order (Use on, B-TH-024), only when the copy's source is its own record or
 *             one of no customer
 *   report    the inspection report a single-customer work order's inspection keeps (the factory's newest kept version)
 *
 * A roving check (green, amber, red per operation) is about the line and its operators: it never reaches a customer.
 */

// ---- final inspections -------------------------------------------------------------------------------------------------------

export const FINAL_STATES = ['PASSED', 'FAILED', 'WAITING'] as const
export type FinalState = (typeof FINAL_STATES)[number]

export const FINAL_STATE_WORDS: Readonly<Record<FinalState, Words>> = Object.freeze({
  PASSED: { it: 'Superato', en: 'Passed' },
  FAILED: { it: 'Non superato', en: 'Failed' },
  WAITING: { it: 'In attesa', en: 'Waiting' },
})

/** An inspection's status as the customer reads it; a cancelled one (opened by mistake) is never shown. */
export function finalStateOf(status: string): FinalState | null {
  if (status === 'PASSED') return 'PASSED'
  if (status === 'FAILED') return 'FAILED'
  if (status === 'OPEN') return 'WAITING'
  return null
}

export const DEFECT_CLASSES = ['CRITICAL', 'MAJOR', 'MINOR'] as const
export type BrandDefectClass = (typeof DEFECT_CLASSES)[number]

export const DEFECT_CLASS_WORDS: Readonly<Record<BrandDefectClass, Words>> = Object.freeze({
  CRITICAL: { it: 'Critico', en: 'Critical' },
  MAJOR: { it: 'Maggiore', en: 'Major' },
  MINOR: { it: 'Minore', en: 'Minor' },
})

/** The garments with a defect of each class in the sample (an inspection's defect rows: one per class and code). */
export function defectTotalsOf(defects: readonly { readonly defectClass: string; readonly quantity: number }[]): Readonly<Record<BrandDefectClass, number>> {
  const totals: Record<BrandDefectClass, number> = { CRITICAL: 0, MAJOR: 0, MINOR: 0 }
  for (const defect of defects) if ((DEFECT_CLASSES as readonly string[]).includes(defect.defectClass)) totals[defect.defectClass as BrandDefectClass] += defect.quantity
  return Object.freeze(totals)
}

// ---- in-process checks -------------------------------------------------------------------------------------------------------

/** The in-process checks a customer reads (never ROVING: it judges the line and its operators, not the goods). */
export const BRAND_CHECK_KINDS = ['FIRST_PIECE', 'CUTTING', 'END_OF_LINE'] as const
export type BrandCheckKind = (typeof BRAND_CHECK_KINDS)[number]

export const CHECK_KIND_WORDS: Readonly<Record<BrandCheckKind, Words>> = Object.freeze({
  FIRST_PIECE: { it: 'Primo capo', en: 'First piece' },
  CUTTING: { it: 'Controllo del taglio', en: 'Cutting check' },
  END_OF_LINE: { it: 'Controllo a fine linea', en: 'End-of-line check' },
})

const PASSING = new Set(['APPROVED', 'PASS'])
const FAILING = new Set(['REJECTED', 'FAIL'])

export interface CheckRow {
  readonly kind: string
  /** OPEN, DECIDED or CANCELLED. */
  readonly status: string
  readonly outcome: string | null
  readonly pieces: number
  readonly defectivePieces: number
  readonly decidedOn: BusinessDate | null
}

export interface CheckSummary {
  readonly kind: BrandCheckKind
  readonly passed: number
  readonly failed: number
  readonly waiting: number
  /** Pieces looked at in the decided checks, and those with a defect. */
  readonly pieces: number
  readonly defectivePieces: number
  /** The day of the last decided check; null: none decided yet. */
  readonly lastOn: BusinessDate | null
  /** The last decided check's result; WAITING while only open ones exist. */
  readonly state: FinalState
}

/** One summary per kind the customer reads, in BRAND_CHECK_KINDS order; a kind with no check is left out, cancelled ones too. */
export function checkSummariesOf(rows: readonly CheckRow[]): CheckSummary[] {
  return BRAND_CHECK_KINDS.flatMap((kind): CheckSummary[] => {
    const own = rows.filter((row) => row.kind === kind && row.status !== 'CANCELLED')
    if (own.length === 0) return []
    const decided = own.filter((row) => row.status === 'DECIDED' && row.outcome !== null)
    const passed = decided.filter((row) => PASSING.has(row.outcome!))
    const failed = decided.filter((row) => FAILING.has(row.outcome!))
    const last = [...passed, ...failed].reduce<CheckRow | null>((latest, row) => (latest === null || (row.decidedOn ?? '') > (latest.decidedOn ?? '') ? row : latest), null)
    return [
      {
        kind,
        passed: passed.length,
        failed: failed.length,
        waiting: own.filter((row) => row.status === 'OPEN').length,
        pieces: [...passed, ...failed].reduce((sum, row) => sum + row.pieces, 0),
        defectivePieces: [...passed, ...failed].reduce((sum, row) => sum + row.defectivePieces, 0),
        lastOn: last?.decidedOn ?? null,
        state: last === null ? 'WAITING' : PASSING.has(last.outcome!) ? 'PASSED' : 'FAILED',
      },
    ]
  })
}

/** "3 passed · 1 failed · 1 waiting" (the parts that are not 0). */
export function checkCountWords(summary: Pick<CheckSummary, 'passed' | 'failed' | 'waiting'>): Words {
  const counts: readonly number[] = [summary.passed, summary.failed, summary.waiting]
  const parts = (words: readonly ((count: number) => string)[]): string =>
    counts
      .map((count, at) => (count > 0 ? `${count} ${words[at]!(count)}` : ''))
      .filter((part) => part !== '')
      .join(' · ')
  return {
    it: parts([(n) => (n === 1 ? 'superato' : 'superati'), (n) => (n === 1 ? 'non superato' : 'non superati'), () => 'in attesa']),
    en: parts([() => 'passed', () => 'failed', () => 'waiting']),
  }
}

// ---- the customer's own cells --------------------------------------------------------------------------------------------------

/** A work order is the customer's alone: its customer is it and every cell of it that names a customer names it (L8). */
export function workOrderAlone(level: ProductionShareLevel, workOrder: { readonly partyId: string | null; readonly cellParties: readonly (string | null)[] }, partyId: string): boolean {
  return qualityResultsShown(level, workOrder.partyId, partyId) && workOrder.cellParties.every((party) => party === null || party === partyId)
}

export interface CellCount {
  readonly lineId: string
  readonly size: string | null
  readonly released: number
  readonly reversed: number
}

export interface LineSizes {
  readonly id: string
  readonly sizes: readonly { readonly size: string; readonly quantity: number }[]
  readonly quantity: number
}

export interface SizeFigures {
  readonly size: string | null
  readonly ordered: number
  /** Pieces released by quality, never above what it ordered of the size. */
  readonly released: number
  /** Of them, taken back since (a reversal), never above what was released. */
  readonly reversed: number
}

/**
 * Per line and size of its own order: what it ordered, released and reversed, summed over every work order cell of the size (a
 * line may be split over several work orders) and capped at what it ordered, so no figure of a shared lot passes its own goods.
 * A line without sizes reads one row (size null) of its whole quantity.
 */
export function cellFiguresOf(lines: readonly LineSizes[], cells: readonly CellCount[]): Map<string, SizeFigures[]> {
  const out = new Map<string, SizeFigures[]>()
  for (const line of lines) {
    const sizes = line.sizes.length > 0 ? line.sizes.map((entry) => ({ size: entry.size as string | null, ordered: entry.quantity })) : [{ size: null as string | null, ordered: line.quantity }]
    out.set(
      line.id,
      sizes.map(({ size, ordered }) => {
        const own = cells.filter((cell) => cell.lineId === line.id && (line.sizes.length === 0 || cell.size === size))
        const released = Math.min(ordered, own.reduce((sum, cell) => sum + Math.max(0, cell.released), 0))
        const reversed = Math.min(released, own.reduce((sum, cell) => sum + Math.max(0, cell.reversed), 0))
        return { size, ordered, released, reversed }
      }),
    )
  }
  return out
}

/** Beside a line some of whose goods are made on a work order that is not the customer's alone (its results stay ours). */
export const SHARED_WORK_WORDS: Words = Object.freeze({
  it: 'I risultati dei controlli si condividono solo per la produzione fatta interamente per voi.',
  en: 'Inspection results are shared only for work made for you alone.',
})

// ---- holds -------------------------------------------------------------------------------------------------------------------

export const HOLD_STATE_WORDS: Readonly<Record<'ACTIVE' | 'ENDED', Words>> = Object.freeze({
  ACTIVE: { it: 'In corso', en: 'Active' },
  ENDED: { it: 'Concluso', en: 'Ended' },
})

// ---- the inspection report ---------------------------------------------------------------------------------------------------

/** The version of an inspection's report the customer opens: the newest in its language, else the newest. */
export function reportVersionOf<V extends { readonly version: number; readonly language: string }>(versions: readonly V[], locale: string): V | null {
  const newest = (list: readonly V[]) => list.reduce<V | null>((best, version) => (best === null || version.version > best.version ? version : best), null)
  return newest(versions.filter((version) => version.language === locale)) ?? newest(versions)
}

// ---- refusals (404: the section is not drawn, as an unknown one) --------------------------------------------------------------

export const QUALITY_NOT_SHARED = 'Quality is not shared for this account.'
export const REPORT_NOT_FOUND = 'Inspection report not found.'
export const NO_REPORT_YET = 'No inspection report has been issued for this check yet.'
