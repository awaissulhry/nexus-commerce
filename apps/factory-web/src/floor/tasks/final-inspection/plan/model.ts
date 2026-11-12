import type { DefectClass } from '@nexus/factory-domain/quality/final/rules'
import { measuredOutcome, wayOf } from '../../inline/model'
import type { BenchPayload, ChartPoint, FinalDefect, PlansAnswer, Sheet, SheetCheck } from './api'

/**
 * The final bench on its plan (B-W2b-109; design floor.final "aql", "checklist", "measure", "serial", "photos"; QHS-023,
 * QHS-049, QHS-052 … QHS-054, QHS-067): the rules of the screen without React or the network, so the tests hold them. The
 * sheet (B-W2b-97) is the model: the sample size and every accept and reject number come from it (B-W2b-93's AQL engine),
 * never computed here. One section at a time, big targets, one hand:
 *
 *   aql       the AQL counter: "+ one piece", a defect per class with its + and −, the verdict as it stands (QHS-023, QHS-049)
 *   checks    the plan's checks: a tap (pass / fail, a fail says what is wrong and takes a photo when the plan asks), a value
 *             (a count or a choice), read in the office (free text), or read only (an instruction)
 *   measure   one point of measure per step: target ± tolerance, the value on the pad, in or out by the numbers; a
 *             made-to-measure point against the rider's profile asks its tolerance, a size-chart point its nominal too (QHS-053)
 *   serial    the garments' serials (or the batch label) scanned: a tick per garment, missing and unknown numbers said (QHS-052)
 *   photos    the photo set's slots (front, back, label …) and the photos results wait for (QHS-054)
 *
 * Every write is one `quality.final.record` payload (B-W2b-106): online first, the same payload kept on the tablet when the
 * network fails, and the sheet on screen moves at once (`applyKept`) so the inspector goes on. Never a person, never money.
 */

export const BENCH_SECTIONS = ['aql', 'checks', 'measure', 'serial', 'photos'] as const
export type BenchSection = (typeof BENCH_SECTIONS)[number]
export type SectionState = 'open' | 'partly' | 'done' | 'failed'

/** A result is recorded for the sample as a whole: the first unit (W1's checklist is per inspection, the plan's checks too). */
export const FIRST_UNIT = 1

/** The checks answered in the Checks section: not on the chart, not the photo set's slots. */
export const listedChecks = (sheet: Pick<Sheet, 'checks'>): SheetCheck[] => sheet.checks.filter((check) => !check.onChart && check.type !== 'PHOTO')

/** The first unit's result of a check, or null. */
export const firstResult = (check: Pick<SheetCheck, 'results'>) => check.results.find((result) => result.sampleIndex === FIRST_UNIT) ?? check.results[0] ?? null

const answered = (check: Pick<SheetCheck, 'results'>) => check.results.length > 0

function checksState(sheet: Pick<Sheet, 'checks'>): SectionState {
  const checks = listedChecks(sheet).filter((check) => check.takesResult && wayOf(check) !== 'office')
  if (checks.some((check) => check.results.some((result) => result.outcome === 'FAIL'))) return 'failed'
  if (checks.length === 0 || checks.every(answered)) return 'done'
  if (checks.filter((check) => check.mandatory).every(answered) && checks.some(answered)) return 'done'
  return checks.some(answered) ? 'partly' : 'open'
}

/** The points a value is asked for: a plan's measurement check (the API holds a PASS without it), else every point. */
const neededPoints = (points: readonly ChartPoint[]) => (points.some((point) => point.checkCode !== null) ? points.filter((point) => point.checkCode !== null) : points)

function measureState(sheet: Pick<Sheet, 'chart'>): SectionState {
  const { points } = sheet.chart
  if (points.some((point) => point.values.some((value) => !value.pass))) return 'failed'
  if (neededPoints(points).every((point) => point.values.length > 0)) return 'done'
  return points.some((point) => point.values.length > 0) ? 'partly' : 'open'
}

/** Which sections the plan has, in the bench's order, each with how it stands (icon + word on screen, never colour alone). */
export function sectionsOf(sheet: Sheet): { readonly id: BenchSection; readonly state: SectionState }[] {
  const out: { id: BenchSection; state: SectionState }[] = []
  const { counter, identity, photos } = sheet
  out.push({ id: 'aql', state: counter.verdict === 'reject' ? 'failed' : counter.inspected >= counter.sampleSize ? 'done' : counter.inspected > 0 || counter.classes.some((entry) => entry.found > 0) ? 'partly' : 'open' })
  if (listedChecks(sheet).length > 0) out.push({ id: 'checks', state: checksState(sheet) })
  if (sheet.chart.points.length > 0) out.push({ id: 'measure', state: measureState(sheet) })
  out.push({ id: 'serial', state: identity.ok === false ? 'failed' : identity.done ? 'done' : identity.scans > 0 ? 'partly' : 'open' })
  if (photos.slots.length > 0 || photos.waiting.length > 0) {
    const missing = photos.mandatoryMissing.length > 0 || photos.waiting.length > 0 || photos.slots.some((slot) => slot.state === 'MISSING')
    out.push({ id: 'photos', state: !missing ? 'done' : photos.slots.some((slot) => slot.state === 'TAKEN') ? 'partly' : 'open' })
  }
  return out
}

/** The first section not done (else the AQL counter): where the bench opens. */
export function firstOpenSection(sheet: Sheet): BenchSection {
  return sectionsOf(sheet).find((section) => section.state === 'open' || section.state === 'partly')?.id ?? 'aql'
}

// ---- the checks as the DS FloorChecklist takes them -------------------------------------------------------------------------

export const CLASS_ORDER = ['CRITICAL', 'MAJOR', 'MINOR', 'OTHER'] as const
export type ClassGroup = (typeof CLASS_ORDER)[number]

/** The tap checks in one group per class, critical first (a safety check is seen first). */
export function tapGroups(sheet: Pick<Sheet, 'checks'>): { readonly id: ClassGroup; readonly checks: SheetCheck[] }[] {
  const taps = listedChecks(sheet).filter((check) => wayOf(check) === 'tap')
  return CLASS_ORDER.map((id) => ({ id, checks: taps.filter((check) => (check.checkClass ?? 'OTHER') === id) })).filter((group) => group.checks.length > 0)
}

export const valueChecks = (sheet: Pick<Sheet, 'checks'>): SheetCheck[] => listedChecks(sheet).filter((check) => wayOf(check) === 'value')
export const officeChecks = (sheet: Pick<Sheet, 'checks'>): SheetCheck[] => listedChecks(sheet).filter((check) => wayOf(check) === 'office')
export const instructions = (sheet: Pick<Sheet, 'checks'>): SheetCheck[] => listedChecks(sheet).filter((check) => wayOf(check) === 'read')

/** A check's answer on the checklist: pass or fail (a not-applicable result is an office answer, shown as answered). */
export function tapAnswer(check: SheetCheck): 'pass' | 'fail' | null {
  const result = firstResult(check)
  if (!result || result.outcome === 'NOT_APPLICABLE') return null
  return result.outcome === 'PASS' ? 'pass' : 'fail'
}

/** "Group passes" and a single pass: every check named passes at the first unit. */
export const passPayload = (inspectionId: string, codes: readonly string[]): BenchPayload => ({ what: 'RESULTS', inspectionId, results: codes.map((checkCode) => ({ checkCode, sampleIndex: FIRST_UNIT, outcome: 'PASS', note: null })) })

/** A failed check says what is wrong (the API refuses a FAIL without it): the defect's words and its code, or the bench's words. */
export const failNote = (words: string, code: string | null): string => (code ? `${words} (${code})` : words).slice(0, 500)

export const failPayload = (inspectionId: string, checkCode: string, note: string): BenchPayload => ({ what: 'RESULTS', inspectionId, results: [{ checkCode, sampleIndex: FIRST_UNIT, outcome: 'FAIL', note }] })

/** A count or a choice with the inspector's pass or fail. */
export const valuePayload = (inspectionId: string, checkCode: string, value: string, outcome: 'PASS' | 'FAIL', note: string | null): BenchPayload => ({
  what: 'RESULTS',
  inspectionId,
  results: [{ checkCode, sampleIndex: FIRST_UNIT, outcome, value, note: outcome === 'FAIL' ? note : null }],
})

/** A typed count as the API takes it (a whole number). */
export const countText = (value: number): string => String(Math.max(0, Math.round(value)))

// ---- the AQL counter and the defects found -----------------------------------------------------------------------------------

export interface DefectLine {
  readonly defectClass: DefectClass
  readonly code: string
  readonly quantity: number
}

export const defectLinesOf = (defects: readonly { readonly defectClass: DefectClass; readonly code: string; readonly quantity: number }[]): DefectLine[] =>
  defects.filter((line) => line.quantity > 0).map((line) => ({ defectClass: line.defectClass, code: line.code, quantity: line.quantity }))

/** The whole list after one defect counted (+1) or taken back (−1); a line at zero goes (PUT …/defects sends them all). */
export function withDefectDelta(lines: readonly DefectLine[], line: Pick<DefectLine, 'defectClass' | 'code'>, delta: 1 | -1): DefectLine[] {
  const found = lines.find((entry) => entry.code === line.code && entry.defectClass === line.defectClass)
  if (!found) return delta > 0 ? [...lines, { defectClass: line.defectClass, code: line.code, quantity: 1 }] : [...lines]
  return lines.flatMap((entry) => (entry === found ? (entry.quantity + delta > 0 ? [{ ...entry, quantity: entry.quantity + delta }] : []) : [entry]))
}

export const defectsPayload = (inspectionId: string, lines: readonly DefectLine[]): BenchPayload => ({ what: 'DEFECTS', inspectionId, defects: lines.map((line) => ({ defectClass: line.defectClass, code: line.code, quantity: line.quantity })) })

/** "+ one piece" (relative, so two tablets add up) or one taken back. */
export const countPayload = (inspectionId: string, add: number): BenchPayload => ({ what: 'COUNT', inspectionId, add })

/** The defects a class's + offers: the FINAL vocabulary's of that severity; the class's own tile when the vocabulary has none. */
export function defectsOfClass(defects: readonly FinalDefect[], defectClass: DefectClass): { readonly code: string; readonly label: string | null }[] {
  const own = defects.filter((defect) => defect.severity === defectClass).map((defect) => ({ code: defect.code, label: defect.label }))
  return own.length > 0 ? own : [{ code: `${defectClass}-OTHER`, label: null }]
}

/** What − on a class does: the one line of the class goes down at once; several lines ask which; none holds it. */
export function classTakeBack(lines: readonly DefectLine[], defectClass: DefectClass): { readonly kind: 'one'; readonly line: DefectLine } | { readonly kind: 'pick'; readonly lines: DefectLine[] } | { readonly kind: 'none' } {
  const of = lines.filter((line) => line.defectClass === defectClass)
  if (of.length === 0) return { kind: 'none' }
  return of.length === 1 ? { kind: 'one', line: of[0]! } : { kind: 'pick', lines: of }
}

/** A defect's words: the vocabulary's label in the worker's language, else its code. */
export const defectWords = (defects: readonly FinalDefect[], code: string): string => defects.find((defect) => defect.code === code)?.label ?? code

// ---- measurements -------------------------------------------------------------------------------------------------------------

/** What the inspector types for a point: the value; a profile point its tolerance too; a size-chart or typed point its nominal too. */
export function pointAsks(point: Pick<ChartPoint, 'source' | 'nominal' | 'tolerance'>): { readonly nominal: boolean; readonly tolerance: boolean } {
  // B-W2b-283 (FU1:05): the approved spec gives both, per size (the API refuses anything else typed).
  if (point.source === 'PLAN' || point.source === 'SPEC') return { nominal: false, tolerance: false }
  return { nominal: point.nominal === null, tolerance: point.tolerance === null }
}

/** The next unit of the sample without a value for this point (and size), else the last one measured. */
export function nextUnit(point: Pick<ChartPoint, 'values'>, sampleSize: number, size: string | null): number {
  const taken = new Set(point.values.filter((value) => size === null || value.size === size).map((value) => value.sampleIndex))
  for (let unit = 1; unit <= Math.max(1, sampleSize); unit++) if (!taken.has(unit)) return unit
  return Math.max(1, sampleSize)
}

export interface MeasureDraft {
  readonly pointCode: string
  readonly unit: number
  readonly size: string | null
  readonly value: number | null
  readonly nominal: number | null
  readonly tolerance: number | null
  /** Which number the pad types now. */
  readonly field: 'value' | 'nominal' | 'tolerance'
}

/** The draft of a point's next value: the unit not measured yet, the size of the point or the only one. */
export function measureDraft(point: ChartPoint, sampleSize: number, sizes: readonly string[]): MeasureDraft {
  const size = point.size ?? (sizes.length === 1 ? sizes[0]! : null)
  const asks = pointAsks(point)
  return { pointCode: point.pointCode, unit: nextUnit(point, sampleSize, size), size, value: null, nominal: null, tolerance: null, field: asks.nominal ? 'nominal' : asks.tolerance ? 'tolerance' : 'value' }
}

/**
 * Nominal and tolerance the value is judged against: the point's, else what the inspector typed. B-W2b-283 (FU1:05): a spec
 * point's cell of the size measured, its band (nominal − minus … nominal + plus) as its centre ± half for the meter and the
 * verdict (the same band; the database judges the band itself).
 */
export function specOf(point: Pick<ChartPoint, 'nominal' | 'tolerance'> & Partial<Pick<ChartPoint, 'source' | 'bySize'>>, draft: Pick<MeasureDraft, 'nominal' | 'tolerance'> & Partial<Pick<MeasureDraft, 'size'>>): { readonly nominal: number | null; readonly tolerance: number | null } {
  if (point.source === 'SPEC') {
    const cell = point.bySize?.find((entry) => entry.size === draft.size)
    if (!cell) return { nominal: null, tolerance: null }
    const minus = Number(cell.toleranceMinus ?? cell.tolerance)
    const plus = Number(cell.tolerancePlus ?? cell.tolerance)
    return { nominal: Number(cell.nominal) + (plus - minus) / 2, tolerance: (plus + minus) / 2 }
  }
  return { nominal: point.nominal !== null ? Number(point.nominal) : draft.nominal, tolerance: point.tolerance !== null ? Number(point.tolerance) : draft.tolerance }
}

const decimal = (value: number): string => String(Math.round(value * 1000) / 1000)

/** B-W2b-283 (FU1:05): a value's band (nominal − minus … nominal + plus) as one centre ± half, to say it with one tolerance. */
export function valueBand(value: { readonly nominal: string; readonly tolerance: string; readonly toleranceMinus?: string | null | undefined; readonly tolerancePlus?: string | null | undefined }): { readonly nominal: number; readonly tolerance: number } {
  if (value.toleranceMinus == null || value.tolerancePlus == null) return { nominal: Number(value.nominal), tolerance: Number(value.tolerance) }
  const minus = Number(value.toleranceMinus)
  const plus = Number(value.tolerancePlus)
  return { nominal: Number(value.nominal) + (plus - minus) / 2, tolerance: (plus + minus) / 2 }
}

/** In or out by the numbers (= factory-domain measurementPass; the database writes the same), or null while a number is missing. */
export function measureVerdict(point: ChartPoint, draft: MeasureDraft): 'PASS' | 'FAIL' | null {
  const spec = specOf(point, draft)
  if (draft.value === null || spec.nominal === null || spec.tolerance === null) return null
  return measuredOutcome(decimal(draft.value), decimal(spec.nominal), decimal(spec.tolerance))
}

/** Why Save waits: the size, the nominal, the tolerance, the value (first missing), or null. */
export function measureHeld(point: ChartPoint, draft: MeasureDraft): 'size' | 'nominal' | 'tolerance' | 'value' | null {
  const asks = pointAsks(point)
  if (draft.size === null) return 'size'
  if (asks.nominal && draft.nominal === null) return 'nominal'
  if (asks.tolerance && draft.tolerance === null) return 'tolerance'
  if (draft.value === null) return 'value'
  return null
}

/** One value of one point, unit and size; what the plan sets is never typed (the API refuses a nominal other than the plan's). */
export function measurePayload(inspectionId: string, point: ChartPoint, draft: MeasureDraft): BenchPayload {
  const asks = pointAsks(point)
  return {
    what: 'MEASUREMENTS',
    inspectionId,
    measurements: [
      {
        ...(point.checkCode ? { checkCode: point.checkCode } : { pointCode: point.pointCode }),
        size: draft.size,
        sampleIndex: draft.unit,
        measured: draft.value === null ? null : decimal(draft.value),
        ...(asks.nominal && draft.nominal !== null ? { nominal: decimal(draft.nominal) } : {}),
        ...(asks.tolerance && draft.tolerance !== null ? { tolerance: decimal(draft.tolerance) } : {}),
        ...(asks.nominal && point.uom ? { uom: point.uom } : {}),
      },
    ],
  }
}

/** A value taken back (its place only). */
export function takeBackPayload(inspectionId: string, point: ChartPoint, value: { readonly size: string; readonly sampleIndex: number }): BenchPayload {
  return { what: 'MEASUREMENTS', inspectionId, measurements: [{ ...(point.checkCode ? { checkCode: point.checkCode } : { pointCode: point.pointCode }), size: value.size, sampleIndex: value.sampleIndex, measured: null }] }
}

// ---- the serial or batch check ----------------------------------------------------------------------------------------------------

export const identityAdd = (inspectionId: string, code: string | null): BenchPayload => ({ what: 'IDENTITY', inspectionId, add: [code === null ? null : code.trim()] })
export const identityRemove = (inspectionId: string, code: string): BenchPayload => ({ what: 'IDENTITY', inspectionId, remove: [code] })
export const NO_NUMBER = 'NO_NUMBER'

/** How the check stands, as a key and its figures (the screen's words; never the API's English). */
export function identityLine(identity: Sheet['identity']): { readonly key: string; readonly params: Record<string, string | number>; readonly tone: 'info' | 'success' | 'danger' } {
  if (identity.mode === 'BATCH') {
    if (identity.ok === false) return { key: 'serial.batch.wrong', params: { batch: identity.batchNumber ?? '' }, tone: 'danger' }
    return identity.done ? { key: 'serial.batch.done', params: { batch: identity.batchNumber ?? '' }, tone: 'success' } : { key: 'serial.batch.open', params: { batch: identity.batchNumber ?? '' }, tone: 'info' }
  }
  if (identity.ok === false) return { key: 'serial.serial.wrong', params: { matched: identity.matched, target: identity.target, unknown: identity.unknown.length, noNumber: identity.noNumber, missing: identity.missingCount }, tone: 'danger' }
  return identity.done ? { key: 'serial.serial.done', params: { matched: identity.matched, target: identity.target }, tone: 'success' } : { key: 'serial.serial.open', params: { matched: identity.matched, target: identity.target }, tone: 'info' }
}

// ---- the photo set -------------------------------------------------------------------------------------------------------------

export interface PhotoTarget {
  /** `slot:<check code>` or `result:<result id>`. */
  readonly key: string
  readonly kind: 'slot' | 'result'
  readonly checkCode: string
  readonly label: string
  readonly state: 'TAKEN' | 'MISSING' | 'NOT_APPLICABLE' | 'OPEN'
  readonly mandatory: boolean
  readonly photos: number
  /** The result the photo goes onto: a slot's first result once recorded; a waiting result's own. */
  readonly resultId: string | null
}

/** The photo set's slots (front, back, label …), then the results that wait for their photo (a "photo required" fail). */
export function photoTargets(sheet: Pick<Sheet, 'checks' | 'photos'>, language: string): PhotoTarget[] {
  const label = (labels: { labelIt: string; labelEn: string }) => (language === 'it' ? labels.labelIt || labels.labelEn : labels.labelEn || labels.labelIt)
  const slots: PhotoTarget[] = sheet.photos.slots.map((slot) => {
    const check = sheet.checks.find((entry) => entry.code === slot.code)
    return { key: `slot:${slot.code}`, kind: 'slot', checkCode: slot.code, label: check?.label ?? label(slot), state: slot.state, mandatory: slot.mandatory, photos: slot.photos, resultId: check ? (firstResult(check)?.id ?? null) : null }
  })
  const waiting: PhotoTarget[] = sheet.checks
    .filter((check) => check.photoRequired && check.type !== 'PHOTO')
    .flatMap((check) =>
      check.results
        .filter((result) => result.outcome !== 'NOT_APPLICABLE' && result.photos.filter((photo) => photo.status === 'AVAILABLE').length === 0)
        .map((result): PhotoTarget => ({ key: `result:${result.id}`, kind: 'result', checkCode: check.code, label: check.label, state: 'MISSING', mandatory: true, photos: 0, resultId: result.id })),
    )
  return [...slots, ...waiting]
}

/** A slot's photo needs its PHOTO check recorded first (the photo hangs on the result): pass at the first unit. */
export const slotResultPayload = (inspectionId: string, checkCode: string): BenchPayload => passPayload(inspectionId, [checkCode])

// ---- the signature -------------------------------------------------------------------------------------------------------------

export type SignHeldWord = { readonly key: string; readonly params?: Record<string, string | number> }

/**
 * What holds the signature of the result the numbers give, in the screen's words from the sheet's facts (the API's
 * `sign` says the same in English and decides again): the photos results wait for, then for a PASS every mandatory
 * check, the photo set, the serial or batch check and the whole sample; for a FAIL the whole sample unless the stop rule
 * lets a rejected sample stop. The office's own reasons stand in when it holds for a reason the screen cannot name.
 */
export function signHeld(sheet: Sheet, decision: 'PASS' | 'FAIL'): SignHeldWord[] {
  const words: SignHeldWord[] = []
  const { counter, photos, identity } = sheet
  if (photos.waiting.length > 0) words.push({ key: 'sign.held.photosWaiting', params: { count: photos.waiting.length } })
  if (decision === 'PASS') {
    const missing = sheet.checks.filter((check) => check.mandatory && check.takesResult && (check.onChart ? !sheet.chart.points.some((point) => point.checkCode === check.code && point.values.length > 0) : check.results.length === 0)).length
    if (missing > 0) words.push({ key: 'sign.held.checks', params: { count: missing } })
    if (photos.mandatoryMissing.length > 0) words.push({ key: 'sign.held.photoSet', params: { count: photos.mandatoryMissing.length } })
    if (!identity.done) words.push({ key: identity.mode === 'BATCH' ? 'sign.held.batch' : 'sign.held.serials', params: { matched: identity.matched, target: identity.target } })
    if (counter.inspected < counter.sampleSize) words.push({ key: 'sign.held.sample', params: { inspected: counter.inspected, sample: counter.sampleSize } })
  } else if (counter.inspected < counter.sampleSize && !(counter.stop.stop && counter.verdict === 'reject')) {
    words.push({ key: counter.stop.stop ? 'sign.held.sampleStop' : 'sign.held.sampleFail', params: { inspected: counter.inspected, sample: counter.sampleSize } })
  }
  const office = decision === 'PASS' ? sheet.sign.pass : sheet.sign.fail
  if (office.held && words.length === 0) words.push({ key: 'sign.held.office' })
  return words
}

/** The result a signature carries: what the numbers and the checks say (an override is the office's, with a second person). */
export const signDecision = (sheet: Pick<Sheet, 'result'>): 'PASS' | 'FAIL' => sheet.result.resultNow

/** Why the result is a FAIL, in the screen's words: failed checks (their names), values out of tolerance, the serial check, the counts. */
export function failWords(sheet: Sheet): SignHeldWord[] {
  const words: SignHeldWord[] = []
  const failed = sheet.checks.filter((check) => !check.onChart && check.results.some((result) => result.outcome === 'FAIL'))
  if (failed.length > 0) words.push({ key: 'result.failedChecks', params: { names: failed.map((check) => check.label).join(', ') } })
  if (sheet.chart.outOfTolerance > 0) words.push({ key: 'result.outOfTolerance', params: { count: sheet.chart.outOfTolerance } })
  if (sheet.identity.ok === false) words.push({ key: 'result.identity' })
  for (const entry of sheet.counter.classes) if (entry.found >= entry.reject) words.push({ key: `result.class.${entry.defectClass}`, params: { found: entry.found, accept: entry.accept } })
  return words
}

// ---- kept on the tablet: the sheet on screen moves at once -----------------------------------------------------------------------

/**
 * The sheet as the office will see it once a kept write is sent: the counter, a result, a value, a serial tick, the defects.
 * Only what the tablet can know: a value's in or out by the numbers, a scan counted (not whether it is the work order's). The
 * office's answer replaces it when the queue sends it; the version stays (a kept write carries none).
 */
export function applyKept(sheet: Sheet, payload: BenchPayload, now: string): Sheet {
  switch (payload.what) {
    case 'COUNT': {
      const inspected = Math.max(0, Math.min(sheet.counter.sampleSize, sheet.counter.inspected + payload.add))
      return { ...sheet, counter: { ...sheet.counter, inspected, remaining: Math.max(0, sheet.counter.sampleSize - inspected), verdict: sheet.counter.verdict === 'reject' ? 'reject' : inspected >= sheet.counter.sampleSize ? 'accept' : 'open' } }
    }
    case 'RESULTS': {
      const checks = sheet.checks.map((check) => {
        const rows = payload.results.filter((row) => row.checkCode === check.code)
        if (rows.length === 0) return check
        let results = check.results
        for (const row of rows) {
          results = results.filter((result) => result.sampleIndex !== row.sampleIndex)
          if (row.outcome !== null) results = [...results, { id: `kept:${check.code}:${row.sampleIndex}`, sampleIndex: row.sampleIndex, outcome: row.outcome, value: row.value ?? null, note: row.note ?? null, photos: [], recordedBy: 'FLOOR' as const, recordedAt: now }]
        }
        return { ...check, results }
      })
      return { ...sheet, checks }
    }
    case 'MEASUREMENTS': {
      const points = sheet.chart.points.map((point) => {
        const rows = payload.measurements.filter((row) => (row.checkCode ? row.checkCode === point.checkCode : row.pointCode === point.pointCode))
        if (rows.length === 0) return point
        let values = point.values
        for (const row of rows) {
          const size = row.size ?? point.size ?? ''
          values = values.filter((value) => !(value.sampleIndex === row.sampleIndex && value.size === size))
          const nominal = point.nominal ?? row.nominal ?? null
          const tolerance = point.tolerance ?? row.tolerance ?? null
          if (row.measured !== null && nominal !== null && tolerance !== null) {
            values = [...values, { id: `kept:${point.pointCode}:${size}:${row.sampleIndex}`, size, sampleIndex: row.sampleIndex, measured: row.measured, nominal, tolerance, pass: measuredOutcome(row.measured, nominal, tolerance) === 'PASS', words: '' }]
          }
        }
        return { ...point, values }
      })
      const all = points.flatMap((point) => point.values)
      return { ...sheet, chart: { ...sheet.chart, points, values: all.length, outOfTolerance: all.filter((value) => !value.pass).length } }
    }
    case 'IDENTITY': {
      const added = payload.add?.length ?? 0
      const removed = payload.remove?.length ?? 0
      return { ...sheet, identity: { ...sheet.identity, scans: Math.max(0, sheet.identity.scans + added - removed) } }
    }
    case 'DEFECTS': {
      const found = (defectClass: DefectClass) => payload.defects.filter((line) => line.defectClass === defectClass).reduce((sum, line) => sum + line.quantity, 0)
      const classes = sheet.counter.classes.map((entry) => {
        const count = found(entry.defectClass)
        return { ...entry, found: count, state: count >= entry.reject ? ('reject' as const) : count > 0 && count === entry.reject - 1 ? ('limit' as const) : ('ok' as const) }
      })
      const rejected = classes.some((entry) => entry.state === 'reject') || sheet.checksNow.failedCritical.length > 0
      return { ...sheet, counter: { ...sheet.counter, classes, verdict: rejected ? 'reject' : sheet.counter.inspected >= sheet.counter.sampleSize ? 'accept' : 'open' } }
    }
  }
}

// ---- opening on the plan ------------------------------------------------------------------------------------------------------

/** The plan the bench opens on: the suggested usable plan, or null (none applies: W1's typed plan and fixed checklist). */
export function suggestedPlanOf(answer: Pick<PlansAnswer, 'plans' | 'suggestedId'>): PlansAnswer['plans'][number] | null {
  const plan = answer.plans.find((entry) => entry.id === answer.suggestedId) ?? null
  return plan && plan.usable && plan.approved ? plan : null
}

/** The sample of the lot, as the API gives it (fixed, or the AQL chain's); null while it is not known. */
export function sampleOf(answer: Pick<PlansAnswer, 'sampling'>): { readonly size: number; readonly letter: string | null; readonly level: string | null; readonly classes: readonly { defectClass: DefectClass; aql: string; accept: number; reject: number }[] } | null {
  const sampling = answer.sampling
  if (!sampling) return null
  if (sampling.plan) return { size: sampling.plan.sampleSize, letter: sampling.plan.codeLetter, level: sampling.plan.levelText, classes: sampling.plan.classes }
  return sampling.sampleSize !== null ? { size: sampling.sampleSize, letter: null, level: null, classes: [] } : null
}

// ---- the live counter key ('+' on a keyboard: one piece) -------------------------------------------------------------------------

/** The "+" key counts one piece (design floor.final keyboard), never while a field or the PIN pad has the focus. */
export const isPlusKey = (key: string): boolean => key === '+'

// ---- what waits on the tablet, and where a code goes ----------------------------------------------------------------------------

/** Bench writes of this inspection still waiting on the tablet: the signature waits for them (they go first, in order). */
export function waitingWrites(items: readonly { readonly kind: string; readonly state: string; readonly payload: Readonly<Record<string, unknown>> }[], inspectionId: string): number {
  return items.filter((item) => item.kind === 'quality.final.record' && item.state === 'waiting' && item.payload.inspectionId === inspectionId).length
}

/** The labels the final bench takes to start (QHS-065): a lot, a batch, a bundle, a garment's serial, a carton; a work order is W1's way. */
export const BENCH_LABELS: readonly string[] = ['lot', 'batch', 'bundle', 'serial', 'carton']
export const startsAtBench = (read: { readonly kind: string; readonly type?: string }): boolean => read.kind === 'label' && BENCH_LABELS.includes(read.type ?? '')

/** The refusals of a scan at the bench the screen says in its own words (B-W2b-106's codes); the rest: the generic words. */
export const SCAN_REFUSALS = ['OTHER_BENCH', 'NOTHING_TO_INSPECT', 'CHOOSE', 'LABEL'] as const
export const isScanRefusal = (code: string): boolean => (SCAN_REFUSALS as readonly string[]).includes(code)
