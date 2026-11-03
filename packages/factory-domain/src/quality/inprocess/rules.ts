import { createHash } from 'node:crypto'
import { canonicalJson } from '../../accounting/manifest'
import type { Issue } from '../../core/errors'
import type { PlanStage } from '../plans/rules'

/**
 * In-process checks (B-W2b-99; QHS-039 first piece, QHS-040 cutting, QHS-041 roving, QHS-042 end of line and DHU, MES-127 a
 * defect charged to its operation; design floor.inline SCR-176, floor.reasons "Which operation caused it?", floor.operation
 * "Waiting first-piece approval", floor.display "Quality"): pure rules, figures by hand in inprocess.vitest.test.ts. The
 * database holds the same rules for every login (…_inspection_plans_w2b_guards: InProcessCheck_guard and the first-piece
 * hold OperationScan_awaits_first_piece); the API answers with these words first.
 *
 *   first piece   a check of a work order's first bundle (at one operation, or naming none: at all of them). From the
 *                 moment it is written its RUN waits: no other bundle of the work order is worked there until a first
 *                 piece of the run is APPROVED (signed: the floor's PIN, the office's fresh code). A rejected one keeps
 *                 the hold; a new one approved lifts it; a cancelled one holds nothing. Stopping and mending work
 *                 (pause, hand back, undo, correction) always passes.
 *   cutting       pieces against the pattern for a work order (a lay or a hide): pass, or fail with the pieces rejected
 *                 (they are recut: the existing replacement, B-W2a's recut ticket).
 *   roving        a few pieces of one operation of a line: green, amber or red (the traffic light: none wrong green, one
 *                 amber, two or more or a critical defect red), per operation; per named operator only behind the gate.
 *   end of line   each garment or bundle at the line's end: pass, or a defect (from the library) charged to the operation
 *                 that caused it (MES-127) and sent back there (the rework loop, B-W2a-13). Its defects per 100 pieces are
 *                 the line's DHU of the day (replacing the W2b-1 estimate from scrap and rework scans).
 *
 * Statuto dei Lavoratori art. 4 (Owner answers W1, F2): every figure here is per line and operation. A check names its
 * operator only where the site's PERFORMANCE legal gate is in force, and only the API in the tenant's system scope writes it
 * (the floor reads no legal basis); no list, filter, group or total carries a person.
 */

type Words = Readonly<{ it: string; en: string }>
const w = (it: string, en: string): Words => Object.freeze({ it, en })

export const IN_PROCESS_KINDS = ['FIRST_PIECE', 'CUTTING', 'ROVING', 'END_OF_LINE'] as const
export type InProcessKind = (typeof IN_PROCESS_KINDS)[number]
export const IN_PROCESS_STATUSES = ['OPEN', 'DECIDED', 'CANCELLED'] as const
export type InProcessStatus = (typeof IN_PROCESS_STATUSES)[number]
export const IN_PROCESS_OUTCOMES = ['APPROVED', 'REJECTED', 'PASS', 'FAIL', 'GREEN', 'AMBER', 'RED'] as const
export type InProcessOutcome = (typeof IN_PROCESS_OUTCOMES)[number]

/** The outcomes each kind takes (the database's InProcessOutcome rule). */
export const OUTCOMES_OF: Readonly<Record<InProcessKind, readonly InProcessOutcome[]>> = Object.freeze({
  FIRST_PIECE: ['APPROVED', 'REJECTED'],
  CUTTING: ['PASS', 'FAIL'],
  ROVING: ['GREEN', 'AMBER', 'RED'],
  END_OF_LINE: ['PASS', 'FAIL'],
})

/** The outcomes that pass: on a plan they need every mandatory result and no failed critical check. */
export const PASSING_OUTCOMES: readonly InProcessOutcome[] = Object.freeze(['APPROVED', 'PASS', 'GREEN'])
export const isPassing = (outcome: InProcessOutcome): boolean => PASSING_OUTCOMES.includes(outcome)

/** The plan stage a kind runs on (the database: FIRST_PIECE and ROVING on IN_LINE plans). */
export const STAGE_OF_KIND: Readonly<Record<InProcessKind, PlanStage>> = Object.freeze({
  FIRST_PIECE: 'IN_LINE',
  CUTTING: 'CUTTING',
  ROVING: 'IN_LINE',
  END_OF_LINE: 'END_OF_LINE',
})

/**
 * The kinds recorded in one step (written DECIDED at once, the design's taps: a roving tile, an end-of-line pass or defect,
 * a cutting result). A first piece never: it is signed, after its checklist.
 */
export const ONE_STEP_KINDS: readonly InProcessKind[] = Object.freeze(['CUTTING', 'ROVING', 'END_OF_LINE'])

export const KIND_WORDS: Readonly<Record<InProcessKind, Words>> = Object.freeze({
  FIRST_PIECE: w('Primo capo', 'First piece'),
  CUTTING: w('Controllo taglio', 'Cutting inspection'),
  ROVING: w('Controllo itinerante', 'Roving check'),
  END_OF_LINE: w('Fine linea', 'End of line'),
})

export const STATUS_WORDS: Readonly<Record<InProcessStatus, Words>> = Object.freeze({
  OPEN: w('Aperto', 'Open'),
  DECIDED: w('Deciso', 'Decided'),
  CANCELLED: w('Annullato', 'Cancelled'),
})

export const OUTCOME_WORDS: Readonly<Record<InProcessOutcome, Words>> = Object.freeze({
  APPROVED: w('Approvato', 'Approved'),
  REJECTED: w('Respinto', 'Rejected'),
  PASS: w('Conforme', 'Pass'),
  FAIL: w('Non conforme', 'Fail'),
  GREEN: w('Verde', 'Green'),
  AMBER: w('Giallo', 'Amber'),
  RED: w('Rosso', 'Red'),
})

export const LIMITS = Object.freeze({
  /** Pieces a check looks at, defects it finds (a bundle holds at most 500; a lay more). */
  pieces: 100_000,
  defects: 100_000,
  note: 1000,
  reason: 500,
  /** Results and measurements one save takes (the whole list). */
  results: 500,
  /** Rows a list answers. */
  list: 500,
})

/** The words a language asks, else English. */
export const wordsIn = (words: Words, language: string | null | undefined): string => (language === 'it' ? words.it : words.en)

// ---- where a check is ---------------------------------------------------------------------------------------------------------

export interface Place {
  readonly lineId?: string | null | undefined
  readonly workOrderId?: string | null | undefined
  readonly bundleId?: string | null | undefined
  readonly workOrderOperationId?: string | null | undefined
}

/** Where a check must be (the database's rule, in words; paths without the `body/` prefix). */
export function placeProblems(kind: InProcessKind, place: Place): Issue[] {
  const problems: Issue[] = []
  if ((place.bundleId || place.workOrderOperationId) && !place.workOrderId) problems.push({ path: 'workOrderId', message: 'A bundle or an operation is checked with its work order.' })
  if (kind === 'FIRST_PIECE') {
    if (!place.workOrderId) problems.push({ path: 'workOrderId', message: 'A first piece names its work order.' })
    if (!place.bundleId) problems.push({ path: 'bundleId', message: 'A first piece names the first bundle of its run: the one it is cut, sewn or made from.' })
  }
  if (kind === 'CUTTING' && !place.workOrderId) problems.push({ path: 'workOrderId', message: 'A cutting inspection names the work order whose pieces it checks.' })
  if ((kind === 'ROVING' || kind === 'END_OF_LINE') && !place.lineId && !place.workOrderId) problems.push({ path: 'lineId', message: `A ${kind === 'ROVING' ? 'roving' : 'end-of-line'} check names its line or its work order.` })
  return problems
}

// ---- what a check found -------------------------------------------------------------------------------------------------------

export interface Finding {
  readonly outcome: InProcessOutcome
  readonly pieces: number
  readonly defectivePieces: number
  readonly defects: number
  readonly defectCodeId?: string | null | undefined
}

const whole = (value: number, from: number, to: number) => Number.isInteger(value) && value >= from && value <= to

/**
 * A decision of a kind, in words: its outcome is of the kind, at least one piece looked at, those with a defect up to the
 * pieces, at least one defect on each of them; a pass has no defect (end of line, cutting), green none wrong (roving); a fail
 * at the end of line names the defect found and at least one piece with it; a cutting fail names the pieces rejected.
 */
export function findingProblems(kind: InProcessKind, finding: Finding): Issue[] {
  const problems: Issue[] = []
  if (!OUTCOMES_OF[kind].includes(finding.outcome)) problems.push({ path: 'outcome', message: `A ${wordsIn(KIND_WORDS[kind], 'en').toLowerCase()} is ${OUTCOMES_OF[kind].join(', ')}.` })
  if (!whole(finding.pieces, 1, LIMITS.pieces)) problems.push({ path: 'pieces', message: `At least one piece is looked at (up to ${LIMITS.pieces}).` })
  if (!whole(finding.defectivePieces, 0, Math.max(0, Math.min(finding.pieces, LIMITS.pieces)))) problems.push({ path: 'defectivePieces', message: 'The pieces with a defect are from 0 up to the pieces looked at.' })
  if (!whole(finding.defects, 0, LIMITS.defects)) problems.push({ path: 'defects', message: `The defects found are from 0 (up to ${LIMITS.defects}).` })
  else if (finding.defects < finding.defectivePieces) problems.push({ path: 'defects', message: 'Each piece with a defect has at least one defect.' })
  if (problems.length > 0) return problems
  const { outcome } = finding
  if (outcome === 'PASS' && finding.defects > 0) problems.push({ path: 'defects', message: kind === 'CUTTING' ? 'A cutting pass rejects no piece: record a fail with the pieces to recut.' : 'A pass has no defect: record the defect instead.' })
  if (outcome === 'GREEN' && finding.defectivePieces > 0) problems.push({ path: 'outcome', message: 'Green means every piece looked at is right: one piece wrong is amber, two or more red.' })
  if (outcome === 'FAIL' && finding.defectivePieces < 1) problems.push({ path: 'defectivePieces', message: kind === 'CUTTING' ? 'A cutting fail names the pieces rejected (they are recut).' : 'A defect sent back names at least one piece with it.' })
  if (kind === 'END_OF_LINE' && outcome === 'FAIL' && !finding.defectCodeId) problems.push({ path: 'defectCodeId', message: 'Pick the defect found from the list.' })
  if (finding.defects === 0 && finding.defectCodeId) problems.push({ path: 'defectCodeId', message: 'A defect is named only when one was found.' })
  return problems
}

/**
 * The roving traffic light (QHS-041; the common seven-piece rule): every piece right is green, one piece wrong amber, two or
 * more, or a critical defect, red. A suggestion: the inspector says the colour.
 */
export function rovingColourOf(finding: { readonly defectivePieces: number; readonly critical?: boolean | undefined }): 'GREEN' | 'AMBER' | 'RED' {
  if (finding.critical) return 'RED'
  if (finding.defectivePieces <= 0) return 'GREEN'
  return finding.defectivePieces === 1 ? 'AMBER' : 'RED'
}

/** The defects found per 100 pieces looked at, one decimal ("4.5"), or null when nothing was looked at. */
export function dhuOf(defects: number, pieces: number): string | null {
  if (pieces <= 0) return null
  return (Math.round((Math.max(0, defects) * 1000) / pieces) / 10).toFixed(1)
}

export interface DhuFacts {
  readonly defects: number
  readonly pieces: number
  /** End-of-line checks counted. */
  readonly checks: number
}

/** The line's DHU of a day from its decided end-of-line checks (QHS-042). */
export function lineDhu(checks: readonly { readonly kind: string; readonly status: string; readonly pieces: number; readonly defects: number }[]): DhuFacts & { readonly dhu: string | null } {
  const counted = checks.filter((check) => check.kind === 'END_OF_LINE' && check.status === 'DECIDED')
  const pieces = counted.reduce((sum, check) => sum + check.pieces, 0)
  const defects = counted.reduce((sum, check) => sum + check.defects, 0)
  return { checks: counted.length, pieces, defects, dhu: dhuOf(defects, pieces) }
}

// ---- plan results -------------------------------------------------------------------------------------------------------------

export const RESULT_OUTCOMES = ['PASS', 'FAIL', 'NOT_APPLICABLE'] as const
export type ResultOutcome = (typeof RESULT_OUTCOMES)[number]

export interface ResultInput {
  readonly code: string
  readonly sampleIndex?: number | undefined
  readonly outcome: ResultOutcome
  readonly value?: string | null | undefined
  readonly note?: string | null | undefined
}

export interface PlanCheckFacts {
  readonly code: string
  readonly type: string
  readonly nominal: string | null
  readonly tolerance: string | null
  readonly choices: readonly string[]
}

const DECIMAL = /^-?\d{1,9}(\.\d{1,3})?$/

/** A measurement against its nominal ± tolerance, by the numbers (the database computes the same). */
export function measuredOutcome(value: string, nominal: string, tolerance: string): 'PASS' | 'FAIL' {
  const thousandths = (text: string) => Math.round(Number(text) * 1000)
  return Math.abs(thousandths(value) - thousandths(nominal)) <= thousandths(tolerance) ? 'PASS' : 'FAIL'
}

/**
 * The plan results of a check, in words (the database's InspectionCheckResult_guard): each names a check of the frozen
 * version (never an instruction), once per sampled unit; a value by type unless not applicable (a decimal, a whole number,
 * one of the choices, words); a measurement against a nominal passes exactly when the numbers say so.
 */
export function resultProblems(results: readonly ResultInput[], checks: readonly PlanCheckFacts[]): Issue[] {
  const problems: Issue[] = []
  const byCode = new Map(checks.map((check) => [check.code, check]))
  const seen = new Set<string>()
  if (results.length > LIMITS.results) return [{ path: 'results', message: `At most ${LIMITS.results} results in one save.` }]
  results.forEach((result, index) => {
    const at = (field: string) => `results/${index}/${field}`
    const check = byCode.get(result.code)
    const unit = result.sampleIndex ?? 1
    if (!check) return void problems.push({ path: at('code'), message: `${result.code} is not a check of this plan version.` })
    if (check.type === 'INSTRUCTION') return void problems.push({ path: at('code'), message: `${result.code} is an instruction: it takes no result.` })
    if (!Number.isInteger(unit) || unit < 1 || unit > LIMITS.pieces) problems.push({ path: at('sampleIndex'), message: 'The unit of the sample is from 1.' })
    const key = `${result.code}|${unit}`
    if (seen.has(key)) problems.push({ path: at('code'), message: `${result.code} is answered once per unit.` })
    seen.add(key)
    if (result.note && result.note.length > LIMITS.note) problems.push({ path: at('note'), message: `At most ${LIMITS.note} characters.` })
    if (result.outcome === 'NOT_APPLICABLE') return
    const value = (result.value ?? '').trim()
    if (check.type === 'MEASUREMENT' && !DECIMAL.test(value)) return void problems.push({ path: at('value'), message: 'A measurement takes a number (up to three decimals).' })
    if (check.type === 'COUNT' && !/^\d{1,9}$/.test(value)) return void problems.push({ path: at('value'), message: 'A count takes a whole number.' })
    if (check.type === 'CHOICE' && !check.choices.includes(value)) return void problems.push({ path: at('value'), message: `Pick one of: ${check.choices.join(', ')}.` })
    if (check.type === 'FREE_TEXT' && value === '') return void problems.push({ path: at('value'), message: 'Write the answer.' })
    if (check.type === 'MEASUREMENT' && check.nominal !== null && check.tolerance !== null) {
      const by = measuredOutcome(value, check.nominal, check.tolerance)
      if (by !== result.outcome) problems.push({ path: at('outcome'), message: `${value} against ${check.nominal} ± ${check.tolerance} is a ${by === 'PASS' ? 'pass' : 'fail'}, by the numbers.` })
    }
  })
  return problems
}

// ---- the first-piece hold -----------------------------------------------------------------------------------------------------

/** The scan kinds the hold stops (the database trigger's WHEN): stopping and mending work always passes. */
export const HOLD_FREE_SCAN_KINDS: readonly string[] = Object.freeze(['PAUSE', 'HAND_BACK', 'UNDO', 'CORRECTION'])
export const holdsScanKind = (kind: string): boolean => !HOLD_FREE_SCAN_KINDS.includes(kind)

export interface FirstPieceRow {
  readonly id: string
  readonly status: InProcessStatus
  readonly outcome: InProcessOutcome | null
  readonly bundleId: string | null
  readonly workOrderOperationId: string | null
  readonly createdAt: Date
}

export interface FirstPieceHold {
  /** The run waits: a first piece is asked, none approved, and this is not the first bundle. */
  readonly held: boolean
  /** A first piece of the run is APPROVED: nothing holds it any more. */
  readonly approved: boolean
  /** This bundle is a first piece's own: it goes through. */
  readonly firstBundle: boolean
  /** The run's newest first piece not cancelled (what the operation screen shows), or null: none asked. */
  readonly check: FirstPieceRow | null
}

/**
 * Does a run wait for its first piece at this operation? EXACTLY the database's OperationScan_awaits_first_piece: the work
 * order's FIRST_PIECE checks not CANCELLED, at this operation or naming none; held when there is one, none is APPROVED and
 * the bundle is none of theirs.
 */
export function firstPieceHold(rows: readonly FirstPieceRow[], scan: { readonly bundleId: string; readonly workOrderOperationId: string | null }): FirstPieceHold {
  const run = rows.filter((row) => row.status !== 'CANCELLED' && (row.workOrderOperationId === null || row.workOrderOperationId === scan.workOrderOperationId))
  const approved = run.some((row) => row.outcome === 'APPROVED')
  const firstBundle = run.some((row) => row.bundleId === scan.bundleId)
  const check = [...run].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null
  return { held: run.length > 0 && !approved && !firstBundle, approved, firstBundle, check }
}

/** Of a work order's operations, those its first pieces hold now for any bundle but a first piece's own. */
export function heldOperations(rows: readonly FirstPieceRow[], operationIds: readonly string[]): string[] {
  return operationIds.filter((workOrderOperationId) => firstPieceHold(rows, { bundleId: '', workOrderOperationId }).held)
}

export interface FirstPieceRefusal {
  readonly code: 'FIRST_PIECE'
  readonly message: string
  readonly fix: string
  readonly final: false
}

/** The hold in words (the operation screen's flag and the scan's refusal), before the database would refuse. */
export function firstPieceRefusal(facts: { readonly workOrderNumber: string; readonly firstBundleCode: string | null; readonly rejected: boolean }): FirstPieceRefusal {
  const status = facts.rejected ? 'its first piece was rejected' : 'its first piece is not approved yet'
  return {
    code: 'FIRST_PIECE',
    message: `Waiting for first-piece approval: work order ${facts.workOrderNumber} runs at this operation once a first piece is approved, and ${status} (QHS-039).`,
    fix: facts.firstBundleCode
      ? `Work on the first bundle ${facts.firstBundleCode}, or ask the inspector or your team leader to approve its first piece.`
      : 'Ask the inspector or your team leader to approve the first piece.',
    final: false,
  }
}

// ---- the signature --------------------------------------------------------------------------------------------------------------

export interface FirstPieceStatement {
  readonly checkId: string
  readonly workOrderId: string
  readonly bundleId: string
  readonly workOrderOperationId: string | null
  readonly planVersionId: string | null
  readonly outcome: InProcessOutcome
  readonly pieces: number
  readonly defectivePieces: number
  readonly defects: number
  readonly results: readonly { readonly code: string; readonly sampleIndex: number; readonly outcome: string; readonly value: string | null }[]
  readonly signer: { readonly workerId: string | null; readonly userId: string | null }
  readonly at: string
}

/** What a first-piece approval signs (canonical JSON), and its SHA-256: the e-signature kept on the check. */
export const firstPieceText = (statement: FirstPieceStatement): string => canonicalJson({ signs: 'first-piece decision', ...statement })
export const firstPieceSha256 = (statement: FirstPieceStatement): string => createHash('sha256').update(firstPieceText(statement), 'utf8').digest('hex')

// ---- defects charged to an operation (MES-127) ----------------------------------------------------------------------------------

export const CHARGE_SOURCES = ['END_OF_LINE', 'ROVING', 'SCAN'] as const
export type ChargeSource = (typeof CHARGE_SOURCES)[number]
export const CHARGE_SOURCE_WORDS: Readonly<Record<ChargeSource, Words>> = Object.freeze({
  END_OF_LINE: w('Fine linea', 'End of line'),
  ROVING: w('Controllo itinerante', 'Roving check'),
  SCAN: w('Scarto o rilavorazione', 'Scrap or rework'),
})

export interface Charge {
  readonly source: ChargeSource
  readonly workOrderOperationId: string
  readonly defects: number
}

export interface OperationCharges {
  readonly workOrderOperationId: string
  readonly defects: number
  readonly bySource: Readonly<Record<ChargeSource, number>>
}

/** The defects charged to each operation (per operation, never per person), most first. */
export function chargesByOperation(charges: readonly Charge[]): OperationCharges[] {
  const byOperation = new Map<string, { defects: number; bySource: Record<ChargeSource, number> }>()
  for (const charge of charges) {
    if (charge.defects <= 0) continue
    const entry = byOperation.get(charge.workOrderOperationId) ?? { defects: 0, bySource: { END_OF_LINE: 0, ROVING: 0, SCAN: 0 } }
    entry.defects += charge.defects
    entry.bySource[charge.source] += charge.defects
    byOperation.set(charge.workOrderOperationId, entry)
  }
  return [...byOperation.entries()].map(([workOrderOperationId, entry]) => ({ workOrderOperationId, defects: entry.defects, bySource: entry.bySource })).sort((a, b) => b.defects - a.defects || a.workOrderOperationId.localeCompare(b.workOrderOperationId))
}

/** What the worker's own dispute of a charge says (they send it through My day's dispute of their own report). */
export function chargeDisputeWords(facts: { readonly defect: string; readonly operation: string; readonly bundleCode: string | null; readonly source: ChargeSource }): string {
  const where = facts.bundleCode ? ` on ${facts.bundleCode}` : ''
  return `Defect ${facts.defect} charged to ${facts.operation}${where} (${wordsIn(CHARGE_SOURCE_WORDS[facts.source], 'en').toLowerCase()}).`
}

// ---- the operator, behind the gate ----------------------------------------------------------------------------------------------

/** The PERFORMANCE gate is closed: no check names its operator (the answer says why, the check stays per operation). */
export const OPERATOR_NOT_NAMED = 'This site records checks per operation, not per person: the PERFORMANCE legal gate is not in force (Statuto dei Lavoratori art. 4 c.1).'

/** A reason (cancel) in words, trimmed, or the problem. */
export function reasonProblem(reason: string | null | undefined, path = 'reason'): Issue | null {
  const text = (reason ?? '').trim()
  if (text === '') return { path, message: 'Say why.' }
  if (text.length > LIMITS.reason) return { path, message: `At most ${LIMITS.reason} characters.` }
  return null
}
