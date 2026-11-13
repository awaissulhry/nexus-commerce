import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { decimalOf, hundredthsOf } from '../measure-link/rules'
import type { MtmLineCode } from './codes'

/**
 * The made-to-measure office (B-W2b-358; SAL-276, SAL-291, SAL-292, SAL-300; design sales.mtm), pure: the values of a revision
 * the office records (against its template's points), when measures are old, the factory review's refusals, whether
 * made-to-measure has started for a style (GATE-MTM: Style.mtmAllowed and its template's rulesOn, both off as built), and a
 * made-to-measure line's findings in words. No money, no person's figure.
 *
 * A revision's values: each ACTIVE point of the template, in its unit (cm or mm: { "chest": { "value": "102.5", "unit": "cm" } }),
 * plus the rider's height (cm) and weight (kg) as the measurement link keeps them (the certificate's made-to-measure route asks
 * the height). A required point must be measured; a value is a number above 0 with at most 4 digits and 2 decimals; a value
 * outside the point's plausible range is asked again in words, and kept once the person says they checked it.
 */

export const MTM_OFFICE_LIMITS = Object.freeze({
  /** Values of one revision (the template's points, height and weight). */
  values: 62,
  rider: 200,
  takenBy: 200,
  place: 200,
  notes: 4000,
  review: 2000,
  noticeRef: 200,
})

/** Measures older than this many months are asked again before a repeat order (design tile "Older than 12 months (re-measure)"). */
export const OLD_AFTER_MONTHS = 12

export const REVIEW_STATUSES = ['WAITING', 'CONFIRMED', 'NEED_MORE'] as const
export type ReviewStatus = (typeof REVIEW_STATUSES)[number]
export const REVIEW_DECISIONS = ['CONFIRM', 'NEED_MORE'] as const
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number]

/** The basics every revision may carry beside the template's points (the link's: height in cm, weight in kg). */
export const BASIC_MEASURES = Object.freeze({ height: 'cm', weight: 'kg' } as const)

// ---- the values of a revision -------------------------------------------------------------------------------------------

/** One point of the template as the office form reads it (MeasurementPoint). */
export interface MeasuredPoint {
  readonly code: string
  readonly name: string
  /** The point's unit (Uom): CM or MM for a body measure. */
  readonly uom: string
  readonly required: boolean
  /** The plausible range in the point's unit, as plain decimals; null: no bound. */
  readonly minValue: string | null
  readonly maxValue: string | null
  readonly status: 'ACTIVE' | 'ARCHIVED'
}

export interface MeasuredValues {
  readonly measurements: Record<string, { value: string; unit: string }>
  readonly problems: Issue[]
  /** The points outside their plausible range the person confirmed. */
  readonly outside: string[]
}

const unitOf = (uom: string): string => uom.toLowerCase()

/** The values typed for a revision, checked against the template's points (see the file's head). */
export function measuredValuesOf(values: Readonly<Record<string, string>>, points: readonly MeasuredPoint[], confirmedOutside: readonly string[] = []): MeasuredValues {
  const measurements: Record<string, { value: string; unit: string }> = {}
  const problems: Issue[] = []
  const outside: string[] = []
  const active = points.filter((point) => point.status === 'ACTIVE')
  const known = new Set([...active.map((point) => point.code), ...Object.keys(BASIC_MEASURES)])
  for (const code of Object.keys(values)) {
    if (!known.has(code)) problems.push({ path: `body/measurements/${code}`, message: points.some((point) => point.code === code) ? 'This point is archived in the template: it is not measured any more.' : 'Not a point of this measurement template.' })
  }
  if (Object.keys(values).length > MTM_OFFICE_LIMITS.values) problems.push({ path: 'body/measurements', message: `At most ${MTM_OFFICE_LIMITS.values} values.` })
  for (const point of active) {
    const typed = values[point.code]?.trim() ?? ''
    if (typed === '') {
      if (point.required) problems.push({ path: `body/measurements/${point.code}`, message: `${point.name} is measured on every revision.` })
      continue
    }
    const hundredths = hundredthsOf(typed)
    if (hundredths === null || hundredths <= 0) {
      problems.push({ path: `body/measurements/${point.code}`, message: 'A number above 0 with at most 4 digits and 2 decimals ("102.5").' })
      continue
    }
    const unit = unitOf(point.uom)
    const min = hundredthsOf(point.minValue)
    const max = hundredthsOf(point.maxValue)
    if ((min !== null && hundredths < min) || (max !== null && hundredths > max)) {
      if (!confirmedOutside.includes(point.code)) {
        const range = `${point.minValue ?? '…'}–${point.maxValue ?? '…'} ${unit}`
        problems.push({ path: `body/measurements/${point.code}`, message: `${point.name} ${decimalOf(hundredths)} ${unit} is outside ${range}: check it, then confirm it (confirmedOutside).` })
        continue
      }
      outside.push(point.code)
    }
    measurements[point.code] = { value: decimalOf(hundredths), unit }
  }
  for (const [code, unit] of Object.entries(BASIC_MEASURES)) {
    if (active.some((point) => point.code === code)) continue
    const typed = values[code]?.trim() ?? ''
    if (typed === '') continue
    const hundredths = hundredthsOf(typed)
    if (hundredths === null || hundredths <= 0) problems.push({ path: `body/measurements/${code}`, message: 'A number above 0 with at most 4 digits and 2 decimals ("178").' })
    else measurements[code] = { value: decimalOf(hundredths), unit }
  }
  return { measurements, problems, outside }
}

/** The stored values outside their point's plausible range (the review shows them: kept because the person checked them). */
export function outsidePoints(measurements: Readonly<Record<string, { readonly value: string; readonly unit: string }>>, points: readonly MeasuredPoint[]): string[] {
  return points.flatMap((point) => {
    const value = hundredthsOf(measurements[point.code]?.value)
    if (value === null) return []
    const min = hundredthsOf(point.minValue)
    const max = hundredthsOf(point.maxValue)
    return (min !== null && value < min) || (max !== null && value > max) ? [point.code] : []
  })
}

// ---- old measures ---------------------------------------------------------------------------------------------------------

/** A business date `months` months later (the last day of a shorter month). */
export function addMonths(day: BusinessDate, months: number): BusinessDate {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  const total = year * 12 + (month - 1) + months
  const toYear = Math.floor(total / 12)
  const toMonth = (total % 12) + 1
  const last = new Date(Date.UTC(toYear, toMonth, 0)).getUTCDate()
  return `${String(toYear).padStart(4, '0')}-${String(toMonth).padStart(2, '0')}-${String(Math.min(date, last)).padStart(2, '0')}`
}

/** Whole months from `from` to `to` (0 when `to` is earlier). */
export function monthsBetween(from: BusinessDate, to: BusinessDate): number {
  if (to <= from) return 0
  let months = 0
  while (addMonths(from, months + 1) <= to) months += 1
  return months
}

/** Measures taken on `takenOn` are old on `today` (OLD_AFTER_MONTHS or more). */
export const isOld = (takenOn: BusinessDate, today: BusinessDate): boolean => addMonths(takenOn, OLD_AFTER_MONTHS) <= today

// ---- the factory review ---------------------------------------------------------------------------------------------------

export interface ReviewFacts {
  readonly status: ReviewStatus
  readonly revision: number
  /** The rider's newest revision of the garment type. */
  readonly latestRevision: number
  readonly measuredByUserId: string | null
  readonly takenAt: Date
  readonly submittedAt: Date | null
  readonly reviewedAt: Date | null
}

const dayText = (at: Date): string => at.toISOString().slice(0, 16).replace('T', ' ')

/**
 * Why the review cannot be made now (409, in words), or null. The database refuses the same (MeasurementProfile_review_check):
 * a CONFIRMED review never changes, never back to WAITING, nobody confirms measures they took themselves (Owner answer Q3),
 * never before the rider was measured or the revision was sent; and here: only the rider's newest revision is reviewed.
 */
export function reviewRefusal(facts: ReviewFacts, decision: ReviewDecision, actorId: string, now: Date): string | null {
  if (facts.status === 'CONFIRMED') return `Revision ${facts.revision} is confirmed: its review does not change (a change is a new revision).`
  if (facts.revision !== facts.latestRevision) return `Revision ${facts.revision} is not the newest (revision ${facts.latestRevision} is): review the newest.`
  if (decision === 'CONFIRM' && facts.measuredByUserId !== null && facts.measuredByUserId === actorId) return 'You measured this revision: someone else confirms it (nobody confirms their own measures).'
  if (now.getTime() < facts.takenAt.getTime()) return `This revision was measured at ${dayText(facts.takenAt)} UTC: it is reviewed after that.`
  if (facts.submittedAt !== null && now.getTime() < facts.submittedAt.getTime()) return `This revision is sent at ${dayText(facts.submittedAt)} UTC: it is reviewed once it has been sent.`
  if (facts.reviewedAt !== null && now.getTime() < facts.reviewedAt.getTime()) return 'This revision is reviewed again no earlier than its last review.'
  return null
}

/** The review's words: required to ask for more (they reach the rider or dealer), optional design notes to confirm. */
export function reviewNoteProblems(decision: ReviewDecision, note: string | null | undefined): Issue[] {
  const text = note?.trim() ?? ''
  if (decision === 'NEED_MORE' && text === '') return [{ path: 'body/note', message: 'Say what more is needed: the rider or dealer reads it.' }]
  if (text.length > MTM_OFFICE_LIMITS.review) return [{ path: 'body/note', message: `At most ${MTM_OFFICE_LIMITS.review} characters.` }]
  return []
}

// ---- made-to-measure started (GATE-MTM, PRD-017) ------------------------------------------------------------------------------

export interface StartFacts {
  readonly style: { readonly code: string; readonly mtmAllowed: boolean }
  /** The style's measurement template; null: none. */
  readonly template: { readonly code: string; readonly rulesOn: boolean } | null
  /** The profile's garment type, when a profile is named. */
  readonly garmentType?: string | null | undefined
}

/**
 * Why a made-to-measure unit of the style cannot be quoted or ordered (in words), or null: the style flagged made to measure
 * (PRD-017, the database's QuoteLine_mtm_style too), a template, the template's rules on (made-to-measure started per template,
 * GATE-MTM: the Owner's switch, product.mtm.switch), and the rider measured for that template's garment type.
 */
export function notStartedProblem(facts: StartFacts): string | null {
  if (!facts.style.mtmAllowed) return `${facts.style.code} is not made to measure: a person flags the style first (PRD-017).`
  if (!facts.template) return `${facts.style.code} has no measurement template: choose the template its made-to-measure units are measured with.`
  if (!facts.template.rulesOn) return `Made-to-measure has not started for measurement template ${facts.template.code}: its rules stay off until the Owner starts them (GATE-MTM).`
  if (facts.garmentType && facts.garmentType !== facts.template.code) return `The rider was measured for ${facts.garmentType}, not for ${facts.template.code} (the template of ${facts.style.code}).`
  return null
}

// ---- a made-to-measure line's findings ------------------------------------------------------------------------------------------

export interface UnitFacts extends StartFacts {
  readonly kind: 'QUOTE' | 'ORDER'
  readonly seq: number
  /** The line as the person knows it ("line 20, SEED-JKT-01 BLK"). */
  readonly label: string
  readonly profile: { readonly riderName: string; readonly garmentType: string; readonly revision: number; readonly latestRevision: number; readonly reviewStatus: ReviewStatus; readonly takenOn: BusinessDate }
  /** The one check's (B-W2b-248) blocking findings other than the style's: rules, alterations, the certificate. */
  readonly blocks: readonly string[]
  readonly today: BusinessDate
}

export interface UnitFinding {
  readonly code: MtmLineCode
  readonly severity: 'BLOCKS' | 'WARNING'
  readonly message: string
}

/** The findings of one made-to-measure line, the BLOCKS first (see ./codes.ts). */
export function unitFindings(unit: UnitFacts): UnitFinding[] {
  const out: UnitFinding[] = []
  const notStarted = notStartedProblem({ ...unit, garmentType: unit.profile.garmentType })
  if (notStarted) out.push({ code: 'MTM_NOT_STARTED', severity: 'BLOCKS', message: `${unit.label}: ${notStarted}` })
  if (unit.blocks.length > 0) out.push({ code: 'MTM_OUTSIDE_RANGE', severity: 'BLOCKS', message: `${unit.label}: outside the certified range of the basic model, a pattern maker reviews it (${unit.blocks.join(' ')})` })
  const { profile } = unit
  if (profile.reviewStatus !== 'CONFIRMED') {
    const order = unit.kind === 'QUOTE' ? 'its order waits for the review' : 'the order waits for the review'
    out.push({
      code: 'MTM_NOT_CONFIRMED',
      severity: 'WARNING',
      message: profile.reviewStatus === 'NEED_MORE' ? `${unit.label}: the factory asked for more measures of revision ${profile.revision}; ${order}.` : `${unit.label}: revision ${profile.revision} waits for the factory review; ${order}.`,
    })
  }
  if (profile.revision < profile.latestRevision) out.push({ code: 'MTM_NOT_LATEST', severity: 'WARNING', message: `${unit.label}: made to revision ${profile.revision}; the rider has revision ${profile.latestRevision} now.` })
  if (isOld(profile.takenOn, unit.today)) out.push({ code: 'MTM_OLD_MEASURES', severity: 'WARNING', message: `${unit.label}: measured on ${profile.takenOn}, ${monthsBetween(profile.takenOn, unit.today)} months ago: ask for a new measure.` })
  return out
}
