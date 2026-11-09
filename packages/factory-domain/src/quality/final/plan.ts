import type { Issue } from '../../core/errors'
import { UOMS, type Uom } from '../../product/units/units'
import { Dec } from '../../tax/decimal'
import { classState, type ChecksNow } from '../aql/result'
import { chipsMatch, type CheckType, type Chip, type ChipFacts } from '../plans/rules'
import { NOTE_MAX, type DefectClass, type InspectionResult, type SamplingPlan } from './rules'

/**
 * The final inspection BY PLAN (B-W2b-97; QHS-014 measurement charts, QHS-023 live accept/reject counter, QHS-049 final
 * AQL inspection, QHS-052 serial or batch check, QHS-053 made-to-measure final check, QHS-054 mandatory photo set; design
 * floor.final "serial", "aql", "measure", "photos" and quality.inspections "Checks & results", "Sample & AQL",
 * "Measurements", "Required photo set"): pure rules, figures by hand in plan.vitest.test.ts. An inspection opened on an
 * APPROVED version of a FINAL plan (Inspection.planVersionId, frozen) runs that version's checks; one opened without a
 * plan is W1's (its fixed checklist, rules.ts) and nothing here touches it.
 *
 *   results        one per check and sampled unit (InspectionCheckResult): passed, failed (with what is wrong) or not
 *                  applicable (a CRITICAL check only with the reason: a safety check is never silently skipped); a value
 *                  by the check's type. A MEASUREMENT check is answered on the measurement chart, never here.
 *   measurements   one per point, size and sampled unit (InspectionMeasurement) against nominal ± tolerance: the plan's
 *                  check gives both, else the rider's measurement profile (a made-to-measure unit: QHS-053, nominal by
 *                  the template's point code) or the inspector types them from the size chart (no graded garment spec is
 *                  kept yet: a schema need). The database writes `pass`.
 *   the counter    the units of the sample inspected so far (the bench's "+ one piece"): Inspection.inspectedCount
 *                  (B-W2b-213; W2b schema wave 24/33). Before the column the count was the AQL_SAMPLE entry of
 *                  `checklist`: `inspectedNow` reads the column, else that entry (decided inspections keep it: W1's guard
 *                  freezes them), and the next count of an OPEN one copies it into the column once and drops the entry.
 *                  The decision still writes the entry into the signed checklist (W1's rule wants a non-empty list; a FAIL
 *                  may be signed with no check answered). A PASS needs the whole sample; a FAIL too, unless the stop rule (the plan version's stopAtReject, else
 *                  the company's, else the tenant's QualitySettings.stopAtRejectNumber, else finish the sample) is on and
 *                  the sample already rejects (a class at its reject number, a critical defect or a failed critical check).
 *   the identity   the serial (a serial-tracked style: every garment of the lot) or the batch number (once) scanned
 *                  against the work order's; a garment without a readable number, or a number that is not this work
 *                  order's, fails the check (PPE Regulation (EU) 2016/425 art. 8: identification). Kept in `checklist` as
 *                  its IDENTITY entry (no table yet: a schema need). A PASS needs it done and clean.
 *   photos         the plan's PHOTO checks are the photo set's slots (front, back, label …: QHS-054); a check marked
 *                  "photo required" takes a photo with each result. Files of the result (StoredFile recordType
 *                  "InspectionCheckResult"). A result that needs its photo holds the signature; a mandatory slot holds a PASS.
 *   the decision   W1's: the database computes the result from `checklist` and the defects (Inspection_guard), so the
 *                  command writes `checklist` from the results by check code (a failed check: ok false, so the lot FAILS
 *                  and no PASS is ever signed over it), and the plan's guard (Inspection_plan_guard) adds "every mandatory
 *                  check answered, no failed CRITICAL check" for a PASS. A critical defect always fails (Ac 0).
 */

// ---- the entries the API keeps in Inspection.checklist besides the checks' answers -------------------------------------

/** The counter's entry: `inspected` units of the sample. Neither ok nor failed (ok null), so W1's rule never reads it. */
export const SAMPLE_ENTRY = 'AQL_SAMPLE'
/** The serial or batch check's entry: ok false when it failed (W1's rule then FAILS the lot), with its scans. */
export const IDENTITY_ENTRY = 'IDENTITY'
export const SYSTEM_ENTRIES: readonly string[] = Object.freeze([SAMPLE_ENTRY, IDENTITY_ENTRY])
export const isSystemEntry = (code: unknown): boolean => typeof code === 'string' && SYSTEM_ENTRIES.includes(code)

export interface ChecklistEntry {
  readonly code: string
  readonly ok: boolean | null
  readonly note: string | null
  readonly [key: string]: unknown
}

const entriesOf = (checklist: unknown): ChecklistEntry[] =>
  Array.isArray(checklist) ? checklist.filter((entry): entry is ChecklistEntry => entry !== null && typeof entry === 'object' && typeof (entry as { code?: unknown }).code === 'string') : []

const entryOf = (checklist: unknown, code: string): ChecklistEntry | undefined => entriesOf(checklist).find((entry) => entry.code === code)

/** The units of the sample inspected so far as the AQL_SAMPLE entry of `checklist` kept them (0 when it never ran). */
export function inspectedOf(checklist: unknown): number {
  const value = entryOf(checklist, SAMPLE_ENTRY)?.inspected
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

/** The checklist with one system entry put in (replacing its earlier copy), the others kept in their order. */
export function withEntry(checklist: unknown, entry: ChecklistEntry): ChecklistEntry[] {
  const kept = entriesOf(checklist).filter((item) => item.code !== entry.code)
  return [...kept, entry]
}

export const sampleEntry = (inspected: number, sampleSize: number): ChecklistEntry => ({ code: SAMPLE_ENTRY, ok: null, note: `${inspected} of ${sampleSize} inspected`, inspected })

/** The checklist without one system entry, the others in their order (an OPEN inspection's list may be empty). */
export function withoutEntry(checklist: unknown, code: string): ChecklistEntry[] {
  return entriesOf(checklist).filter((item) => item.code !== code)
}

/** Whether `checklist` still keeps the counter's AQL_SAMPLE entry (an inspection counted before the column). */
export const keepsSampleEntry = (checklist: unknown): boolean => entryOf(checklist, SAMPLE_ENTRY) !== undefined

/**
 * B-W2b-213: the units of the sample inspected now: Inspection.inspectedCount, else (an inspection counted before the
 * column, or a decided one) its AQL_SAMPLE entry, else 0.
 */
export function inspectedNow(row: { readonly inspectedCount: number | null; readonly checklist: unknown }): number {
  return row.inspectedCount ?? inspectedOf(row.checklist)
}

/** "38 of 50 inspected" / "38 di 50 controllati". */
export function countWords(inspected: number, sampleSize: number): { readonly it: string; readonly en: string } {
  return { it: `${inspected} di ${sampleSize} controllati`, en: `${inspected} of ${sampleSize} inspected` }
}

// ---- the plan's checks and what was recorded ---------------------------------------------------------------------------

export type ResultOutcome = 'PASS' | 'FAIL' | 'NOT_APPLICABLE'
export const RESULT_OUTCOMES = ['PASS', 'FAIL', 'NOT_APPLICABLE'] as const satisfies readonly ResultOutcome[]

export interface PlanCheck {
  readonly id: string
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  readonly type: CheckType
  readonly checkClass: DefectClass | null
  readonly mandatory: boolean
  readonly photoRequired: boolean
  /** MEASUREMENT: "58.000", or null (the size chart, a rider's profile, or typed). */
  readonly nominal: string | null
  readonly tolerance: string | null
  readonly uom: Uom | null
  readonly choices: readonly string[]
}

export interface ResultRow {
  readonly id: string
  readonly planCheckId: string
  readonly sampleIndex: number
  readonly outcome: ResultOutcome
  readonly value: string | null
  readonly note: string | null
  /** Photos of the result (available or waiting for their upload). */
  readonly photos: number
}

export interface MeasurementRow {
  readonly id: string
  readonly planCheckId: string | null
  readonly pointCode: string
  readonly size: string
  readonly sampleIndex: number
  readonly nominal: string
  readonly tolerance: string
  readonly measured: string
  readonly uom: Uom
  readonly pass: boolean
}

export const takesResult = (check: Pick<PlanCheck, 'type'>): boolean => check.type !== 'INSTRUCTION'

export const PLAN_LIMITS = Object.freeze({ rows: 200, value: 200, photosPerResult: 10, scans: 2000, pointCode: 40, size: 20 })
const MEASURE = /^\d{1,9}(\.\d{1,3})?$/
const POINT_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/
const issue = (path: string, message: string): Issue => ({ path, message })
const isWhole = (value: unknown, min: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min

/** A decimal printed without trailing zeros: "58.000" → "58", "0.800" → "0.8". */
export function decimalWords(value: string): string {
  const fixed = new Dec(value).toFixed(3)
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
}

const unitWords = (uom: Uom): string => uom.toLowerCase()

// ---- results ------------------------------------------------------------------------------------------------------------

export interface ResultInput {
  readonly checkCode: string
  /** The unit of the sample it is about; 1 for a check made once. */
  readonly sampleIndex?: number | undefined
  /** null: take the answer back (Not checked). */
  readonly outcome: ResultOutcome | null
  readonly value?: string | null | undefined
  readonly note?: string | null | undefined
}

/**
 * The results asked for, every problem at once (paths `results/<i>/…`): a check of the frozen version that takes a result
 * here (an instruction takes none; a measurement is answered on the chart), each check and unit once, the unit from 1 up to
 * the sample, a value by the check's type, a failed check says what is wrong, and a CRITICAL check is "not applicable" only
 * with the reason why (a safety check is never skipped in silence).
 */
export function resultProblems(rows: readonly ResultInput[], checks: readonly PlanCheck[], context: { readonly sampleSize: number }): Issue[] {
  const problems: Issue[] = []
  if (rows.length > PLAN_LIMITS.rows) problems.push(issue('results', `At most ${PLAN_LIMITS.rows} results at once.`))
  const byCode = new Map(checks.map((check) => [check.code, check]))
  const seen = new Set<string>()
  rows.forEach((row, index) => {
    const at = `results/${index}`
    const check = byCode.get(row.checkCode)
    if (!check) {
      problems.push(issue(`${at}/checkCode`, `Not a check of this inspection's plan version: ${row.checkCode}.`))
      return
    }
    if (check.type === 'INSTRUCTION') problems.push(issue(`${at}/checkCode`, `${check.labelEn} is an instruction: it takes no result.`))
    if (check.type === 'MEASUREMENT') problems.push(issue(`${at}/checkCode`, `${check.labelEn} is a measurement: record it on the measurement chart (PUT …/measurements).`))
    const sampleIndex = row.sampleIndex ?? 1
    if (!isWhole(sampleIndex, 1)) problems.push(issue(`${at}/sampleIndex`, 'The unit of the sample is a whole number from 1.'))
    else if (sampleIndex > context.sampleSize) problems.push(issue(`${at}/sampleIndex`, `The sample has ${context.sampleSize} unit(s).`))
    const key = `${row.checkCode}|${sampleIndex}`
    if (seen.has(key)) problems.push(issue(`${at}/checkCode`, `${row.checkCode} for unit ${sampleIndex} is answered twice.`))
    seen.add(key)
    const note = row.note?.trim() ?? ''
    if (note.length > NOTE_MAX) problems.push(issue(`${at}/note`, `At most ${NOTE_MAX} characters.`))
    const value = row.value?.trim() ?? ''
    if (value.length > PLAN_LIMITS.value) problems.push(issue(`${at}/value`, `At most ${PLAN_LIMITS.value} characters.`))
    if (row.outcome === null) return
    if (row.outcome === 'FAIL' && note === '') problems.push(issue(`${at}/note`, 'A failed check says what is wrong.'))
    if (row.outcome === 'NOT_APPLICABLE') {
      if (check.checkClass === 'CRITICAL' && note === '') problems.push(issue(`${at}/note`, `${check.labelEn} is a critical check: say why it does not apply (a safety check is never skipped in silence).`))
      return
    }
    if (check.type === 'COUNT' && !/^\d{1,9}$/.test(value)) problems.push(issue(`${at}/value`, 'A count is a whole number from 0.'))
    if (check.type === 'CHOICE' && !check.choices.includes(value)) problems.push(issue(`${at}/value`, `One of: ${check.choices.join(', ')}.`))
    if (check.type === 'FREE_TEXT' && value === '') problems.push(issue(`${at}/value`, 'Write the answer.'))
    if (['PASS_FAIL', 'PHOTO', 'SIGNATURE'].includes(check.type) && value !== '') problems.push(issue(`${at}/value`, `A ${check.type.toLowerCase().replace('_', '/')} check takes no value.`))
  })
  return problems
}

// ---- measurements -------------------------------------------------------------------------------------------------------

export interface MeasurementInput {
  /** The plan's MEASUREMENT check it answers; none: a point of the size chart or of the rider's template. */
  readonly checkCode?: string | null | undefined
  readonly pointCode?: string | null | undefined
  readonly size?: string | null | undefined
  readonly sampleIndex?: number | undefined
  /** null: take the value back. */
  readonly measured: string | null
  /** Typed from the size chart (or the tolerance for a rider's profile) where nothing else gives them. */
  readonly nominal?: string | null | undefined
  readonly tolerance?: string | null | undefined
  readonly uom?: Uom | null | undefined
}

/** A point of the rider's measurement template with the value of their profile revision (QHS-053). */
export interface MtmPoint {
  readonly code: string
  readonly name: string
  readonly nominal: string
  readonly uom: Uom
}

export interface MeasureContext {
  readonly checks: readonly PlanCheck[]
  readonly sampleSize: number
  /** The work order's sizes (the cells'). */
  readonly sizes: readonly string[]
  /** A made-to-measure unit: its base size and the profile's points; null: a size-grid work order. */
  readonly mtm: { readonly size: string; readonly points: readonly MtmPoint[] } | null
}

export type SpecSource = 'PLAN' | 'PROFILE' | 'TYPED'

export interface MeasuredValue {
  readonly measured: string
  readonly nominal: string
  readonly tolerance: string
  readonly uom: Uom
  readonly source: SpecSource
}

export interface ResolvedMeasurement {
  readonly planCheckId: string | null
  readonly pointCode: string
  readonly size: string
  readonly sampleIndex: number
  /** null: the value is taken back. */
  readonly value: MeasuredValue | null
}

const sameCode = (a: string, b: string): boolean => a.toUpperCase() === b.toUpperCase()
const decimalOk = (value: string | null | undefined): value is string => typeof value === 'string' && MEASURE.test(value.trim())
const fixed3 = (value: string): string => new Dec(value.trim()).toFixed(3)

/**
 * Where each value is measured against, every problem at once (paths `measurements/<i>/…`): the plan's check gives
 * nominal, tolerance and unit (nothing typed may differ); a check from the size chart or a free point of a made-to-measure
 * unit takes the rider's profile value as nominal (the template's point by code) and a typed tolerance; anything else is
 * typed whole (nominal, tolerance, unit). The size is one of the work order's (the only one, or the made-to-measure
 * unit's, when not named); the unit of the sample from 1 up to the sample; values decimals from 0.
 */
export function resolveMeasurements(rows: readonly MeasurementInput[], context: MeasureContext): { readonly rows: ResolvedMeasurement[]; readonly problems: Issue[] } {
  const problems: Issue[] = []
  const resolved: ResolvedMeasurement[] = []
  if (rows.length > PLAN_LIMITS.rows) problems.push(issue('measurements', `At most ${PLAN_LIMITS.rows} values at once.`))
  const sizes = [...new Set(context.sizes)]
  const seen = new Set<string>()
  rows.forEach((row, index) => {
    const at = `measurements/${index}`
    const before = problems.length
    const check = row.checkCode ? context.checks.find((entry) => entry.code === row.checkCode) : undefined
    if (row.checkCode && !check) problems.push(issue(`${at}/checkCode`, `Not a check of this inspection's plan version: ${row.checkCode}.`))
    else if (check && check.type !== 'MEASUREMENT') problems.push(issue(`${at}/checkCode`, `${check.labelEn} is not a measurement.`))
    const pointCode = (check?.code ?? row.pointCode ?? '').trim()
    if (!check && !POINT_CODE.test(pointCode)) problems.push(issue(`${at}/pointCode`, 'Name the point of measure: up to 40 letters, digits, dots, dashes or underscores, no spaces ("CHEST-HALF").'))
    const size = (row.size?.trim() || (context.mtm ? context.mtm.size : sizes.length === 1 ? sizes[0]! : '')).trim()
    if (size === '') problems.push(issue(`${at}/size`, `Name the size measured: one of ${sizes.join(', ')}.`))
    else if (!sizes.includes(size)) problems.push(issue(`${at}/size`, `Not a size of this work order: ${size} (${sizes.join(', ')}).`))
    const sampleIndex = row.sampleIndex ?? 1
    if (!isWhole(sampleIndex, 1)) problems.push(issue(`${at}/sampleIndex`, 'The unit of the sample is a whole number from 1.'))
    else if (sampleIndex > context.sampleSize) problems.push(issue(`${at}/sampleIndex`, `The sample has ${context.sampleSize} unit(s).`))
    const key = `${pointCode}|${size}|${sampleIndex}`
    if (seen.has(key)) problems.push(issue(`${at}/pointCode`, `${pointCode} of size ${size}, unit ${sampleIndex}, is given twice.`))
    seen.add(key)
    if (row.measured === null) {
      // Taking a value back needs only its place.
      if (problems.length === before) resolved.push({ planCheckId: check?.id ?? null, pointCode, size, sampleIndex, value: null })
      return
    }
    if (!decimalOk(row.measured)) problems.push(issue(`${at}/measured`, 'A measured value is a decimal from 0, at most three decimals ("61.5").'))
    // Where the value is measured against.
    let spec: { nominal: string; tolerance: string; uom: Uom; source: SpecSource } | null = null
    if (check && check.type === 'MEASUREMENT' && check.nominal !== null && check.tolerance !== null && check.uom !== null) {
      const typed = [row.nominal, row.tolerance].some((value) => typeof value === 'string' && value.trim() !== '')
      const differs = (row.nominal && decimalOk(row.nominal) && fixed3(row.nominal) !== fixed3(check.nominal)) || (row.tolerance && decimalOk(row.tolerance) && fixed3(row.tolerance) !== fixed3(check.tolerance)) || (row.uom && row.uom !== check.uom)
      if (typed && differs) problems.push(issue(`${at}/nominal`, `The plan sets ${check.code} at ${decimalWords(check.nominal)} ± ${decimalWords(check.tolerance)} ${unitWords(check.uom)}: nothing else is typed.`))
      spec = { nominal: fixed3(check.nominal), tolerance: fixed3(check.tolerance), uom: check.uom, source: 'PLAN' }
    } else {
      const point = context.mtm?.points.find((entry) => sameCode(entry.code, pointCode))
      if (point) {
        if (row.nominal && row.nominal.trim() !== '' && (!decimalOk(row.nominal) || fixed3(row.nominal) !== fixed3(point.nominal))) {
          problems.push(issue(`${at}/nominal`, `The rider's measurement profile gives ${point.name} ${decimalWords(point.nominal)} ${unitWords(point.uom)}: the made-to-measure unit is checked against it.`))
        }
        if (!decimalOk(row.tolerance)) problems.push(issue(`${at}/tolerance`, `Type the ± tolerance for ${point.name} (the profile gives the nominal, ${decimalWords(point.nominal)} ${unitWords(point.uom)}).`))
        else spec = { nominal: fixed3(point.nominal), tolerance: fixed3(row.tolerance), uom: point.uom, source: 'PROFILE' }
      } else {
        if (!decimalOk(row.nominal)) problems.push(issue(`${at}/nominal`, `Type the nominal of ${pointCode || 'the point'} from the size chart (no graded spec is kept for it).`))
        if (!decimalOk(row.tolerance)) problems.push(issue(`${at}/tolerance`, 'Type the ± tolerance from the size chart.'))
        const uom = row.uom ?? 'CM'
        if (!(UOMS as readonly string[]).includes(uom)) problems.push(issue(`${at}/uom`, 'Not a unit.'))
        if (decimalOk(row.nominal) && decimalOk(row.tolerance)) spec = { nominal: fixed3(row.nominal), tolerance: fixed3(row.tolerance), uom, source: 'TYPED' }
      }
    }
    if (problems.length > before || spec === null) return
    resolved.push({ planCheckId: check?.id ?? null, pointCode, size, sampleIndex, value: { measured: fixed3(row.measured), ...spec } })
  })
  return { rows: resolved, problems }
}

/** Within nominal ± tolerance (the database writes the same into `pass`). */
export function measurementPass(measured: string, nominal: string, tolerance: string): boolean {
  return new Dec(measured).minus(new Dec(nominal)).abs().lessThanOrEqualTo(new Dec(tolerance))
}

/** A value against its spec in words, never colour alone: "within 58 ± 1 cm", "over by 0.8 cm", "under by 0.5 cm". */
export function deviationWords(measured: string, nominal: string, tolerance: string, uom: Uom): string {
  const value = new Dec(measured)
  const high = new Dec(nominal).plus(new Dec(tolerance))
  const low = new Dec(nominal).minus(new Dec(tolerance))
  if (value.greaterThan(high)) return `over by ${decimalWords(value.minus(high).toFixed(3))} ${unitWords(uom)}`
  if (value.lessThan(low)) return `under by ${decimalWords(low.minus(value).toFixed(3))} ${unitWords(uom)}`
  return `within ${decimalWords(nominal)} ± ${decimalWords(tolerance)} ${unitWords(uom)}`
}

/**
 * The points of a rider's measurement template with their profile revision's values (QHS-053): the profile keeps
 * { "<point code>": { "value": "61.5", "unit": "cm" } }; a point the profile has no value for is left out (the office
 * measured the rider without it). The unit is the profile's (a length the factory knows), else the point's.
 */
export function mtmPoints(points: readonly { readonly code: string; readonly name: string; readonly uom: Uom }[], measurements: unknown): MtmPoint[] {
  const values = measurements && typeof measurements === 'object' && !Array.isArray(measurements) ? (measurements as Record<string, unknown>) : {}
  return points.flatMap((point) => {
    const entry = values[point.code]
    const raw = entry && typeof entry === 'object' ? (entry as { value?: unknown; unit?: unknown }) : null
    if (!raw || typeof raw.value !== 'string' || !MEASURE.test(raw.value.trim())) return []
    const unit = typeof raw.unit === 'string' ? raw.unit.trim().toUpperCase() : ''
    const uom = (UOMS as readonly string[]).includes(unit) ? (unit as Uom) : point.uom
    return [{ code: point.code, name: point.name, nominal: fixed3(raw.value), uom }]
  })
}

// ---- the serial or batch check (QHS-052) --------------------------------------------------------------------------------

export const IDENTITY_MODES = ['SERIAL', 'BATCH'] as const
export type IdentityMode = (typeof IDENTITY_MODES)[number]

export interface IdentityScan {
  /** The number read off the garment, upper-cased; null: the garment carries no readable number. */
  readonly code: string | null
  readonly at: string
  readonly by: 'FLOOR' | 'OFFICE'
}

export interface IdentityAsk {
  readonly mode: IdentityMode
  /** SERIAL: the work order's serials still waiting for a release (MADE). */
  readonly expected: readonly string[]
  /** BATCH: the work order's batch number. */
  readonly batchNumber: string | null
  readonly lotSize: number
  readonly scans: readonly IdentityScan[]
}

export interface IdentitySummary {
  readonly mode: IdentityMode
  /** Garments to tick: the lot's serials (at most the serials waiting), or the batch label once. */
  readonly target: number
  readonly matched: number
  /** Serials not ticked yet, named when the lot is every serial waiting; else only counted. */
  readonly missing: readonly string[]
  readonly missingCount: number
  /** Numbers read that are not this work order's. */
  readonly unknown: readonly string[]
  /** Garments ticked as carrying no readable number. */
  readonly noNumber: number
  /** Every garment ticked (a number, an unknown one or none). */
  readonly done: boolean
  /** Done and clean: true; done with an unknown or missing number: false; not done: null. */
  readonly ok: boolean | null
  readonly words: string
}

export const normalCode = (code: string): string => code.trim().toUpperCase()

/** Where the serial or batch check stands (design ins-identity "Expected 48 · scanned 47 · missing 1 (0142-031) · unknown 0"). */
export function identitySummary(ask: IdentityAsk): IdentitySummary {
  const noNumber = ask.scans.filter((scan) => scan.code === null).length
  if (ask.mode === 'BATCH') {
    const batch = ask.batchNumber ? normalCode(ask.batchNumber) : null
    const codes = ask.scans.flatMap((scan) => (scan.code === null ? [] : [scan.code]))
    const matched = batch !== null && codes.includes(batch) ? 1 : 0
    const unknown = [...new Set(codes.filter((code) => code !== batch))]
    const done = matched + unknown.length + noNumber > 0
    const ok = done ? matched === 1 && unknown.length === 0 && noNumber === 0 : null
    const head = batch === null ? 'The work order has no batch number yet (it gets one when released).' : `Batch ${batch}: ${matched ? 'checked' : 'not checked yet'}`
    const tail = [unknown.length ? `${unknown.length} other number(s) read (${unknown.join(', ')})` : null, noNumber ? `${noNumber} garment(s) without a readable number` : null].filter(Boolean).join(' · ')
    return { mode: 'BATCH', target: 1, matched, missing: matched ? [] : batch ? [batch] : [], missingCount: 1 - matched, unknown, noNumber, done, ok, words: `${head}${tail ? ` · ${tail}` : ''}.` }
  }
  const expected = [...new Set(ask.expected.map(normalCode))]
  const target = Math.min(Math.max(0, ask.lotSize), expected.length)
  const read = [...new Set(ask.scans.flatMap((scan) => (scan.code === null ? [] : [scan.code])))]
  const matchedCodes = read.filter((code) => expected.includes(code))
  const unknown = read.filter((code) => !expected.includes(code))
  const matched = Math.min(matchedCodes.length, target)
  const missingCount = Math.max(0, target - matched)
  const missing = target === expected.length ? expected.filter((code) => !matchedCodes.includes(code)) : []
  const done = target > 0 && matched + unknown.length + noNumber >= target
  const ok = done ? missingCount === 0 && unknown.length === 0 && noNumber === 0 : null
  if (target === 0) {
    return { mode: 'SERIAL', target, matched: 0, missing: [], missingCount: 0, unknown, noNumber, done: false, ok: null, words: 'No serial of this work order waits for a release: the garments get their serials at the final operation first.' }
  }
  const parts = [`Expected ${target}`, `scanned ${matched}`, `missing ${missingCount}${missing.length && missingCount ? ` (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''})` : ''}`, `unknown ${unknown.length}`]
  if (noNumber) parts.push(`no number ${noNumber}`)
  return { mode: 'SERIAL', target, matched, missing, missingCount, unknown, noNumber, done, ok, words: `${parts.join(' · ')}.` }
}

export interface IdentityChange {
  /** Numbers read (any case; trimmed); null: a garment without a readable number. */
  readonly add?: readonly (string | null)[] | undefined
  /** Numbers to take back (a mistaken read); `NO_NUMBER` takes back one garment ticked without a number. */
  readonly remove?: readonly string[] | undefined
}
export const NO_NUMBER = 'NO_NUMBER'

/** The scans after a change: a number read twice is kept once (said in `duplicates`); a removal of what is not there is said. */
export function changeScans(scans: readonly IdentityScan[], change: IdentityChange, stamp: { readonly at: string; readonly by: 'FLOOR' | 'OFFICE' }): { readonly scans: IdentityScan[]; readonly duplicates: string[]; readonly problems: Issue[] } {
  const problems: Issue[] = []
  let next = [...scans]
  ;(change.remove ?? []).forEach((code, index) => {
    if (code === NO_NUMBER) {
      const at = next.findIndex((scan) => scan.code === null)
      if (at < 0) problems.push(issue(`remove/${index}`, 'No garment is ticked without a number.'))
      else next = [...next.slice(0, at), ...next.slice(at + 1)]
      return
    }
    const wanted = normalCode(code)
    if (!next.some((scan) => scan.code === wanted)) problems.push(issue(`remove/${index}`, `${wanted} was not scanned.`))
    next = next.filter((scan) => scan.code !== wanted)
  })
  const duplicates: string[] = []
  ;(change.add ?? []).forEach((raw, index) => {
    if (raw === null) {
      next.push({ code: null, ...stamp })
      return
    }
    const code = normalCode(raw)
    if (code === '' || code.length > 60) {
      problems.push(issue(`add/${index}`, 'A number read is 1 to 60 characters.'))
      return
    }
    if (next.some((scan) => scan.code === code)) duplicates.push(code)
    else next.push({ code, ...stamp })
  })
  if (next.length > PLAN_LIMITS.scans) problems.push(issue('add', `At most ${PLAN_LIMITS.scans} garments ticked on one inspection.`))
  return { scans: next, duplicates, problems }
}

export const identityEntry = (mode: IdentityMode, scans: readonly IdentityScan[], summary: IdentitySummary): ChecklistEntry => ({ code: IDENTITY_ENTRY, ok: summary.ok, note: summary.words, mode, scans: scans.map((scan) => ({ ...scan })) })

/** The scans kept in the IDENTITY entry (none: an empty list). */
export function scansOf(checklist: unknown): IdentityScan[] {
  const raw = entryOf(checklist, IDENTITY_ENTRY)?.scans
  if (!Array.isArray(raw)) return []
  return raw.flatMap((scan) => {
    if (!scan || typeof scan !== 'object') return []
    const entry = scan as { code?: unknown; at?: unknown; by?: unknown }
    if (!(entry.code === null || typeof entry.code === 'string') || typeof entry.at !== 'string' || (entry.by !== 'FLOOR' && entry.by !== 'OFFICE')) return []
    return [{ code: entry.code, at: entry.at, by: entry.by }]
  })
}

// ---- the counter and the stop rule (QHS-023) ----------------------------------------------------------------------------

export type StopSource = 'PLAN' | 'COMPANY' | 'TENANT' | 'DEFAULT'

/** Stop at the reject number, or finish the sample: the plan version's, else the company's, the tenant's, else finish. */
export function stopRuleOf(input: { readonly plan: boolean | null; readonly company: boolean | null; readonly tenant: boolean | null }): { readonly stop: boolean; readonly source: StopSource; readonly words: string } {
  const [stop, source]: [boolean, StopSource] =
    input.plan !== null ? [input.plan, 'PLAN'] : input.company !== null ? [input.company, 'COMPANY'] : input.tenant !== null ? [input.tenant, 'TENANT'] : [false, 'DEFAULT']
  const where = { PLAN: "the plan version's rule", COMPANY: "the company's quality setting", TENANT: 'the quality setting of the group', DEFAULT: 'no setting says otherwise' }[source]
  return { stop, source, words: stop ? `Stop at the reject number (${where}): once a class rejects the lot, the inspection may be signed failed.` : `Finish the whole sample (${where}), also after a class rejects the lot.` }
}

export function countProblem(inspected: number, sampleSize: number): Issue | null {
  if (!isWhole(inspected, 0)) return issue('inspected', 'The units inspected are a whole number from 0.')
  if (inspected > sampleSize) return issue('inspected', `The sample has ${sampleSize} unit(s): no more are inspected.`)
  return null
}

// ---- the checks now, and W1's checklist written from them ----------------------------------------------------------------

export interface ChecksState extends ChecksNow {
  /** Checks that take a result, and how many have one. */
  readonly outOf: number
  readonly answered: number
  readonly failedCount: number
  /** "11 of 12 checked · 1 failed · critical failed: none". */
  readonly words: string
}

/**
 * What the plan's checks say now, as the database's factory_inspection_results_problem and _failed_critical read them: a
 * result or a measurement answers a check; a FAIL result or a measurement out of tolerance fails it.
 */
export function checksState(checks: readonly PlanCheck[], results: readonly Pick<ResultRow, 'planCheckId' | 'outcome'>[], measurements: readonly Pick<MeasurementRow, 'planCheckId' | 'pass'>[]): ChecksState {
  const taking = checks.filter(takesResult)
  const answered = new Set<string>([...results.map((row) => row.planCheckId), ...measurements.flatMap((row) => (row.planCheckId ? [row.planCheckId] : []))])
  const failedIds = new Set<string>([...results.filter((row) => row.outcome === 'FAIL').map((row) => row.planCheckId), ...measurements.flatMap((row) => (row.planCheckId && !row.pass ? [row.planCheckId] : []))])
  const failed = taking.filter((check) => failedIds.has(check.id))
  const failedCritical = failed.filter((check) => check.checkClass === 'CRITICAL')
  const mandatoryMissing = taking.filter((check) => check.mandatory && !answered.has(check.id))
  const count = taking.filter((check) => answered.has(check.id)).length
  const words = `${count} of ${taking.length} checked · ${failed.length} failed · critical failed: ${failedCritical.length ? failedCritical.map((check) => check.labelEn).join(', ') : 'none'}`
  return {
    failed: failed.map((check) => check.labelEn),
    failedCritical: failedCritical.map((check) => check.labelEn),
    mandatoryMissing: mandatoryMissing.map((check) => check.labelEn),
    outOf: taking.length,
    answered: count,
    failedCount: failed.length,
    words,
  }
}

/**
 * Inspection.checklist as W1's database rule reads it, written from the plan's results at the decision (B-W2b-76: "write
 * `checklist` from the results"): one entry per answered check in the plan's order — ok false when any result failed or a
 * measurement is out of tolerance (so the lot FAILS and no PASS is signed over it), ok null when every answer is "not
 * applicable", else ok true — then the counter's entry (never empty: W1's rule wants a list) and the identity's.
 */
export function planChecklist(
  checks: readonly PlanCheck[],
  results: readonly Pick<ResultRow, 'planCheckId' | 'outcome' | 'note' | 'sampleIndex'>[],
  measurements: readonly Pick<MeasurementRow, 'planCheckId' | 'pass' | 'measured' | 'nominal' | 'tolerance' | 'uom' | 'sampleIndex'>[],
  system: { readonly inspected: number; readonly sampleSize: number; readonly identity: ChecklistEntry | null },
): ChecklistEntry[] {
  const entries: ChecklistEntry[] = []
  for (const check of checks.filter(takesResult)) {
    const mine = results.filter((row) => row.planCheckId === check.id)
    const values = measurements.filter((row) => row.planCheckId === check.id)
    if (mine.length === 0 && values.length === 0) continue
    const failedResult = mine.find((row) => row.outcome === 'FAIL')
    const failedValue = values.find((row) => !row.pass)
    if (failedResult || failedValue) {
      const note = failedResult
        ? `${failedResult.note ?? 'Failed'}${mine.length > 1 ? ` (unit ${failedResult.sampleIndex})` : ''}`
        : `Unit ${failedValue!.sampleIndex}: ${deviationWords(failedValue!.measured, failedValue!.nominal, failedValue!.tolerance, failedValue!.uom)}`
      entries.push({ code: check.code, ok: false, note: note.slice(0, NOTE_MAX) })
      continue
    }
    const allNotApplicable = values.length === 0 && mine.every((row) => row.outcome === 'NOT_APPLICABLE')
    entries.push({ code: check.code, ok: allNotApplicable ? null : true, note: allNotApplicable ? (mine.find((row) => row.note)?.note ?? null) : null })
  }
  entries.push(sampleEntry(system.inspected, system.sampleSize))
  if (system.identity) entries.push(system.identity)
  return entries
}

// ---- the photo set (QHS-054) ----------------------------------------------------------------------------------------------

export interface PhotoSlot {
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  readonly mandatory: boolean
  readonly photos: number
  /** TAKEN: a photo is there; MISSING: a mandatory slot without one, or a result waiting for its photo; NOT_APPLICABLE; OPEN: optional, none yet. */
  readonly state: 'TAKEN' | 'MISSING' | 'NOT_APPLICABLE' | 'OPEN'
}

export interface PhotoSet {
  readonly slots: readonly PhotoSlot[]
  /** Results of a "photo required" check (or of a photo slot) that wait for their photo: they hold any signature. */
  readonly waiting: readonly string[]
  /** Mandatory photo slots without a photo: they hold a PASS (a FAIL may be signed early, as a missing check). */
  readonly mandatoryMissing: readonly string[]
  readonly words: string
}

/** The plan's photo slots and the photos results wait for (design ins-photos "Front ✓ · Back ✓ · Label ✕ missing"). */
export function photoSet(checks: readonly PlanCheck[], results: readonly Pick<ResultRow, 'planCheckId' | 'outcome' | 'photos' | 'sampleIndex'>[]): PhotoSet {
  const waiting: string[] = []
  const mandatoryMissing: string[] = []
  const slots: PhotoSlot[] = []
  for (const check of checks) {
    const mine = results.filter((row) => row.planCheckId === check.id)
    const unit = (row: { sampleIndex: number }) => (mine.length > 1 || row.sampleIndex > 1 ? ` (unit ${row.sampleIndex})` : '')
    if (check.type === 'PHOTO') {
      const photos = mine.reduce((sum, row) => sum + row.photos, 0)
      const notApplicable = mine.length > 0 && mine.every((row) => row.outcome === 'NOT_APPLICABLE')
      for (const row of mine) if (row.outcome !== 'NOT_APPLICABLE' && row.photos === 0) waiting.push(`${check.labelEn}${unit(row)}`)
      const state = photos > 0 ? 'TAKEN' : notApplicable ? 'NOT_APPLICABLE' : check.mandatory || mine.length > 0 ? 'MISSING' : 'OPEN'
      if (check.mandatory && photos === 0 && !notApplicable && mine.length === 0) mandatoryMissing.push(check.labelEn)
      slots.push({ code: check.code, labelIt: check.labelIt, labelEn: check.labelEn, mandatory: check.mandatory, photos, state })
    } else if (check.photoRequired) {
      for (const row of mine) if (row.outcome !== 'NOT_APPLICABLE' && row.photos === 0) waiting.push(`Photo with ${check.labelEn}${unit(row)}`)
    }
  }
  const words =
    slots.length === 0 && waiting.length === 0
      ? 'This plan asks for no photos.'
      : [...slots.map((slot) => `${slot.labelEn} ${slot.state === 'TAKEN' ? '✓' : slot.state === 'NOT_APPLICABLE' ? '–' : slot.state === 'MISSING' ? '✕ missing' : '○'}`), ...(waiting.length ? [`${waiting.length} photo(s) waiting`] : [])].join(' · ')
  return { slots, waiting, mandatoryMissing, words }
}

// ---- the decision on a plan ------------------------------------------------------------------------------------------------

export interface PlanDecisionAsk {
  readonly decision: InspectionResult
  readonly checks: Pick<ChecksState, 'mandatoryMissing'>
  readonly identity: Pick<IdentitySummary, 'done' | 'ok' | 'words'>
  readonly photos: Pick<PhotoSet, 'waiting' | 'mandatoryMissing'>
  readonly inspected: number
  readonly sampleSize: number
  /** The stop rule in force. */
  readonly stop: { readonly stop: boolean; readonly words: string }
  /** The sample rejects already: a class at its reject number, a critical defect, a failed critical check. */
  readonly rejected: boolean
}

/**
 * What holds the signature of an inspection on a plan, every problem at once (paths in the body: checks, identity, photos,
 * inspected). A PASS: every mandatory check answered, the serial or batch check done and clean, every photo there, the
 * whole sample inspected. A FAIL: the photos its results need, and the whole sample unless the stop rule lets a rejected
 * sample stop.
 */
export function planDecisionProblems(ask: PlanDecisionAsk): Issue[] {
  const problems: Issue[] = []
  if (ask.photos.waiting.length > 0) problems.push(issue('photos', `Take the photos the results need first: ${ask.photos.waiting.join(', ')}.`))
  if (ask.decision === 'PASS') {
    if (ask.checks.mandatoryMissing.length > 0) problems.push(issue('checks', `Answer every mandatory check before signing a PASS: ${ask.checks.mandatoryMissing.join(', ')}.`))
    if (ask.photos.mandatoryMissing.length > 0) problems.push(issue('photos', `The photo set is not complete: ${ask.photos.mandatoryMissing.join(', ')}.`))
    if (!ask.identity.done) problems.push(issue('identity', `Finish the serial or batch check first (QHS-052): ${ask.identity.words}`))
    if (ask.inspected < ask.sampleSize) problems.push(issue('inspected', `A PASS needs the whole sample inspected: ${ask.inspected} of ${ask.sampleSize}.`))
    return problems
  }
  if (ask.inspected < ask.sampleSize && !(ask.stop.stop && ask.rejected)) {
    problems.push(
      issue('inspected', ask.stop.stop ? `The sample does not reject yet: inspect the rest (${ask.inspected} of ${ask.sampleSize}) or until a class reaches its reject number.` : `${ask.stop.words} ${ask.inspected} of ${ask.sampleSize} inspected.`),
    )
  }
  return problems
}

/** The sample rejects already: a critical defect (critical's Ac is always 0), a class at its reject number, a failed critical check. */
export function sampleRejected(input: { readonly counts: { readonly critical: number; readonly major: number; readonly minor: number }; readonly acceptMajor: number; readonly acceptMinor: number; readonly failedCritical: number }): boolean {
  return input.counts.critical > 0 || input.failedCritical > 0 || classState(input.acceptMajor, input.counts.major) === 'reject' || classState(input.acceptMinor, input.counts.minor) === 'reject'
}

// ---- which plan applies (design qi-new "FIN-JACKET v3 applies because: …") ---------------------------------------------------

export interface PlanCandidate {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly appliesTo: readonly Chip[]
  readonly approved: { readonly id: string; readonly number: number } | null
}

export interface PlanFit extends PlanCandidate {
  readonly matches: boolean
  /** The chips that matched: "applies because …". */
  readonly because: readonly Chip[]
  /** It matches and has a version in force. */
  readonly usable: boolean
}

/**
 * The company's FINAL plans against a work order's facts (its style, the style's category, its customers): THE rule is
 * plans/rules chipsMatch (a chip kind the final inspection does not know, a material or a supplier, never matches). The
 * suggestion is the usable plan that matched the most chips (the most specific), then by code.
 */
export function applicablePlans(candidates: readonly PlanCandidate[], facts: ChipFacts): { readonly plans: PlanFit[]; readonly suggestedId: string | null } {
  const plans = candidates.map((plan) => {
    const fit = chipsMatch(plan.appliesTo, facts, 'fail')
    return { ...plan, matches: fit.matches, because: fit.because, usable: fit.matches && plan.approved !== null }
  })
  const best = plans.filter((plan) => plan.usable).sort((a, b) => b.because.length - a.because.length || a.code.localeCompare(b.code))[0]
  return { plans, suggestedId: best?.id ?? null }
}

// ---- the sampling plan the record keeps ---------------------------------------------------------------------------------------

/** The level a FIXED sample keeps in Inspection.inspectionLevel (W1's text column; no ISO level applies). */
export const FIXED_LEVEL = 'FIXED'

/** A plan version's fixed sample on a lot: its size (at most the lot), AQL 0 and the acceptance numbers given (default 0: nothing accepted). */
export function fixedSampling(fixedSampleSize: number, lotSize: number, accept: { readonly acceptMajor?: number | undefined; readonly acceptMinor?: number | undefined } = {}): SamplingPlan {
  return { lotSize, sampleSize: Math.min(fixedSampleSize, lotSize), inspectionLevel: FIXED_LEVEL, aqlMajor: '0', aqlMinor: '0', acceptMajor: accept.acceptMajor ?? 0, acceptMinor: accept.acceptMinor ?? 0 }
}

export const SAMPLING_FIELDS = ['lotSize', 'sampleSize', 'inspectionLevel', 'aqlMajor', 'aqlMinor', 'acceptMajor', 'acceptMinor'] as const satisfies readonly (keyof SamplingPlan)[]

/** The sampling fields a change would move (AQLs compared as decimals, the level trimmed). */
export function samplingChanges(before: SamplingPlan, asked: Partial<SamplingPlan>): (keyof SamplingPlan)[] {
  const sameDecimal = (a: string, b: string): boolean => /^\d{1,3}(\.\d{1,3})?$/.test(a.trim()) && /^\d{1,3}(\.\d{1,3})?$/.test(b.trim()) && new Dec(a.trim()).equals(new Dec(b.trim()))
  return SAMPLING_FIELDS.filter((field) => {
    const value = asked[field]
    if (value === undefined) return false
    if (field === 'aqlMajor' || field === 'aqlMinor') return !sameDecimal(String(value), String(before[field]))
    if (field === 'inspectionLevel') return String(value).trim() !== before.inspectionLevel.trim()
    return value !== before[field]
  })
}
