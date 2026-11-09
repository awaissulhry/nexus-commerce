import type { Issue } from '../../core/errors'

/**
 * Send measurements by link (B-W2b-171; SAL-096 the measurement form link, SAL-286 measurement photos; design links.measure,
 * SCR-195), pure: what the rider fills in, how it is checked, and what lands in the measurement profile (W1, parties.prisma
 * MeasurementProfile) as a new revision. The web and the API share these rules: the page says the same thing before the
 * send as the API says at it.
 *
 *   the notice      first (GDPR art. 13: body data and photos are personal data): no field and no photo before the rider
 *                   ticked that they read how the measurements are used; the notice shown is the link's company's public
 *                   notice in force (PRIVACY_PUBLIC), named on the revision
 *   about you       height, weight, age and the units (cm and kg, or inches and pounds): all needed by the pattern
 *                   department (SAL-288); kept in centimetres and kilograms
 *   points          the points of measure of the profile's garment type (MeasurementTemplate.code = garmentType: its
 *                   ACTIVE MeasurementPoint rows, in order), grouped by body zone (upper body, arms, legs, riding position,
 *                   others: from the point's code, a template has no zone column); a required point needs a value; a value
 *                   outside the point's range or out of proportion to the height is a HINT that never blocks the send
 *   how you like it fit (snug or regular), posture and riding notes, asymmetry: words for the fitter (MeasurementProfile.fitNotes)
 *   photos          front, side and back in a base layer (SAL-286), as the sender asked: required or optional; JPEG or PNG
 *                   only (a HEIC keeps location data and cannot be shown back stripped, B-W2b-160)
 *
 * Values are decimal strings (never floats): a point is kept in centimetres with at most two decimals, an inch converted
 * exactly (1 in = 2.54 cm), a pound as 0.45359237 kg rounded to two decimals.
 */

export const MEASURE_UNITS = ['cm', 'in'] as const
export type MeasureUnit = (typeof MEASURE_UNITS)[number]
/** The weight's unit that goes with the length unit chosen. */
export const WEIGHT_UNIT_OF: Readonly<Record<MeasureUnit, 'kg' | 'lb'>> = Object.freeze({ cm: 'kg', in: 'lb' })

export const FITS = ['SNUG', 'REGULAR'] as const
export type Fit = (typeof FITS)[number]

export const PHOTO_VIEWS = ['FRONT', 'SIDE', 'BACK'] as const
export type PhotoView = (typeof PHOTO_VIEWS)[number]

/** The sender's choice when making the link (design sec:photos "optional or required per the sender's setting"). */
export const PHOTO_RULES = ['REQUIRED', 'OPTIONAL'] as const
export type PhotoRule = (typeof PHOTO_RULES)[number]
export const DEFAULT_PHOTO_RULE: PhotoRule = 'OPTIONAL'

/** Pictures only as JPEG or PNG (iOS converts HEIC when the page asks for these). */
export const PHOTO_TYPES = ['image/jpeg', 'image/png'] as const
export const PHOTO_MAX_BYTES = 15 * 1_048_576

/**
 * How long the body photos are kept (Owner question 3 of W2b-3, the recommended answer): 90 days after the garment
 * ships; the numbers stay in the profile. A constant until the Owner's setting exists (the notes name the gap).
 */
export const PHOTO_RETENTION_DAYS_AFTER_SHIPPING = 90
/**
 * Photos uploaded through a link whose form was never sent: deleted once the link can no longer send them (the longest
 * link life, 60 days, plus the 7 days a draft is kept after it).
 */
export const UNSENT_PHOTO_DAYS = 67

export const MEASURE_LIMITS = Object.freeze({
  /** Hard limits: a value outside them is a typing mistake, refused (the plausibility hints are softer: below). */
  heightCm: { min: 100, max: 250 },
  weightKg: { min: 25, max: 300 },
  age: { min: 10, max: 110 },
  pointCm: { min: 1, max: 300 },
  /** Fit notes: posture and riding, asymmetry. */
  notes: 1000,
  typedName: 100,
})

// ---- body zones ------------------------------------------------------------------------------------------------------

export const BODY_ZONES = ['UPPER', 'ARMS', 'LEGS', 'RIDING', 'OTHER'] as const
export type BodyZone = (typeof BODY_ZONES)[number]

const ZONE_CODES: Readonly<Record<Exclude<BodyZone, 'OTHER'>, readonly string[]>> = Object.freeze({
  UPPER: ['neck', 'chest', 'bust', 'underbust', 'waist', 'shoulder', 'shoulders', 'shoulder_width', 'back_width', 'back_length', 'front_length', 'torso', 'torso_length', 'jacket_length', 'nape_to_waist', 'belly'],
  ARMS: ['sleeve', 'sleeve_length', 'arm', 'arm_length', 'bicep', 'biceps', 'upper_arm', 'elbow', 'forearm', 'wrist', 'hand'],
  LEGS: ['hip', 'hips', 'seat', 'inside_leg', 'inseam', 'outside_leg', 'outseam', 'thigh', 'knee', 'calf', 'ankle', 'crotch', 'rise', 'leg_length'],
  RIDING: ['reach', 'arm_reach', 'knee_bend'],
})

const normalCode = (code: string): string => code.trim().toLowerCase().replace(/[\s-]+/g, '_')

/** The body zone of a point of measure, from its code ("riding_…" codes are the riding position's). */
export function zoneOf(code: string): BodyZone {
  const normal = normalCode(code)
  if (normal.startsWith('riding_')) return 'RIDING'
  for (const zone of ['UPPER', 'ARMS', 'LEGS', 'RIDING'] as const) if (ZONE_CODES[zone].includes(normal)) return zone
  return 'OTHER'
}

/** Girths whose size against the height is checked (design: "Chest 140 cm is unusual for 172 cm height — check it"). */
const GIRTHS = new Set(['chest', 'bust', 'underbust', 'waist', 'hip', 'hips', 'seat', 'belly'])

// ---- numbers -----------------------------------------------------------------------------------------------------------

const DECIMAL = /^\d{1,4}(?:[.,]\d{1,2})?$/

/** A typed decimal ("61.5", "61,5") as hundredths, or null when it is not a number of that shape. */
export function hundredthsOf(text: string | null | undefined): number | null {
  const trimmed = (text ?? '').trim()
  if (!DECIMAL.test(trimmed)) return null
  const [whole, fraction = ''] = trimmed.replace(',', '.').split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}

/** Hundredths as a decimal string without trailing zeros (6150 → "61.5", 6100 → "61", 10287 → "102.87"). */
export function decimalOf(hundredths: number): string {
  const whole = Math.trunc(hundredths / 100)
  const fraction = String(hundredths % 100).padStart(2, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : String(whole)
}

/** A length typed in the unit chosen, in hundredths of a centimetre (an inch exactly 2.54 cm, rounded half up). */
export function centimetresOf(text: string | null | undefined, unit: MeasureUnit): number | null {
  const hundredths = hundredthsOf(text)
  if (hundredths === null) return null
  return unit === 'cm' ? hundredths : Math.round((hundredths * 254) / 100)
}

/** A weight typed in the unit that goes with the length unit, in hundredths of a kilogram. */
export function kilogramsOf(text: string | null | undefined, unit: MeasureUnit): number | null {
  const hundredths = hundredthsOf(text)
  if (hundredths === null) return null
  return unit === 'cm' ? hundredths : Number((BigInt(hundredths) * 45_359_237n + 50_000_000n) / 100_000_000n)
}

/** A length in hundredths of a centimetre shown in the unit chosen (inches with two decimals at most). */
export function lengthIn(hundredthsCm: number, unit: MeasureUnit): string {
  return unit === 'cm' ? decimalOf(hundredthsCm) : decimalOf(Math.round((hundredthsCm * 100) / 254))
}

// ---- the form ----------------------------------------------------------------------------------------------------------

/** One point of measure as the link shows it (MeasurementPoint; its range in centimetres, null when the template has none). */
export interface MeasurePoint {
  readonly code: string
  readonly name: string
  readonly nameI18n?: Readonly<Record<string, string>> | null
  readonly seq: number
  readonly required: boolean
  readonly minCm: string | null
  readonly maxCm: string | null
  readonly howTo: string | null
}

export interface MeasureForm {
  readonly units: MeasureUnit
  readonly basics: { readonly height: string; readonly weight: string; readonly age: string }
  /** Point code → the value typed, in `units`. */
  readonly values: Readonly<Record<string, string>>
  readonly fit: { readonly fit: Fit | null; readonly posture: string; readonly asymmetry: string }
  /** View → the uploaded photo's file id. */
  readonly photos: Partial<Readonly<Record<PhotoView, string>>>
}

export type MeasureProblemCode = 'REQUIRED' | 'NOT_A_NUMBER' | 'OUT_OF_LIMITS' | 'TOO_LONG' | 'PHOTO_REQUIRED' | 'UNKNOWN_POINT' | 'SAME_PHOTO'

/** A problem with a field: where (`body/…`), what (a code the page turns into its own words), and the API's English. */
export interface MeasureProblem extends Issue {
  readonly code: MeasureProblemCode
}

const problem = (path: string, code: MeasureProblemCode, message: string): MeasureProblem => ({ path, code, message })

/** The problems of About you (all three are needed). */
export function basicProblems(form: MeasureForm): MeasureProblem[] {
  const out: MeasureProblem[] = []
  const height = centimetresOf(form.basics.height, form.units)
  const heightLimits = MEASURE_LIMITS.heightCm
  if (!form.basics.height.trim()) out.push(problem('body/basics/height', 'REQUIRED', 'Your height.'))
  else if (height === null) out.push(problem('body/basics/height', 'NOT_A_NUMBER', 'A number, e.g. 178.'))
  else if (height < heightLimits.min * 100 || height > heightLimits.max * 100) out.push(problem('body/basics/height', 'OUT_OF_LIMITS', `Between ${heightLimits.min} and ${heightLimits.max} cm.`))
  const weight = kilogramsOf(form.basics.weight, form.units)
  const weightLimits = MEASURE_LIMITS.weightKg
  if (!form.basics.weight.trim()) out.push(problem('body/basics/weight', 'REQUIRED', 'Your weight.'))
  else if (weight === null) out.push(problem('body/basics/weight', 'NOT_A_NUMBER', 'A number, e.g. 74.'))
  else if (weight < weightLimits.min * 100 || weight > weightLimits.max * 100) out.push(problem('body/basics/weight', 'OUT_OF_LIMITS', `Between ${weightLimits.min} and ${weightLimits.max} kg.`))
  const ageText = form.basics.age.trim()
  const ageLimits = MEASURE_LIMITS.age
  if (!ageText) out.push(problem('body/basics/age', 'REQUIRED', 'Your age.'))
  else if (!/^\d{1,3}$/.test(ageText)) out.push(problem('body/basics/age', 'NOT_A_NUMBER', 'Whole years, e.g. 34.'))
  else if (Number(ageText) < ageLimits.min || Number(ageText) > ageLimits.max) out.push(problem('body/basics/age', 'OUT_OF_LIMITS', `Between ${ageLimits.min} and ${ageLimits.max}.`))
  return out
}

/** The problems of the points: a required one without a value, a value that is not a number or beyond the hard limits. */
export function pointProblems(form: MeasureForm, points: readonly MeasurePoint[]): MeasureProblem[] {
  const out: MeasureProblem[] = []
  const codes = new Set(points.map((point) => point.code))
  for (const code of Object.keys(form.values)) if (!codes.has(code) && form.values[code]?.trim()) out.push(problem(`body/values/${code}`, 'UNKNOWN_POINT', 'Not a point of this form.'))
  for (const point of points) {
    const text = (form.values[point.code] ?? '').trim()
    const path = `body/values/${point.code}`
    if (!text) {
      if (point.required) out.push(problem(path, 'REQUIRED', `${point.name}: a value.`))
      continue
    }
    const cm = centimetresOf(text, form.units)
    if (cm === null) out.push(problem(path, 'NOT_A_NUMBER', `${point.name}: a number, e.g. 61.5.`))
    else if (cm < MEASURE_LIMITS.pointCm.min * 100 || cm > MEASURE_LIMITS.pointCm.max * 100) out.push(problem(path, 'OUT_OF_LIMITS', `${point.name}: between ${MEASURE_LIMITS.pointCm.min} and ${MEASURE_LIMITS.pointCm.max} cm.`))
  }
  return out
}

export function fitProblems(form: MeasureForm): MeasureProblem[] {
  const out: MeasureProblem[] = []
  if (form.fit.posture.length > MEASURE_LIMITS.notes) out.push(problem('body/fit/posture', 'TOO_LONG', `At most ${MEASURE_LIMITS.notes} characters.`))
  if (form.fit.asymmetry.length > MEASURE_LIMITS.notes) out.push(problem('body/fit/asymmetry', 'TOO_LONG', `At most ${MEASURE_LIMITS.notes} characters.`))
  return out
}

/** The photos: each view needed when the sender asked for them; one file per view, never the same file twice. */
export function photoProblems(form: MeasureForm, rule: PhotoRule): MeasureProblem[] {
  const out: MeasureProblem[] = []
  const seen = new Set<string>()
  for (const view of PHOTO_VIEWS) {
    const id = form.photos[view]
    if (!id) {
      if (rule === 'REQUIRED') out.push(problem(`body/photos/${view}`, 'PHOTO_REQUIRED', `The ${view.toLowerCase()} photo.`))
      continue
    }
    if (seen.has(id)) out.push(problem(`body/photos/${view}`, 'SAME_PHOTO', 'Another photo for each view.'))
    seen.add(id)
  }
  return out
}

/** Every problem of the form, in the order of the page (about you, points, how you like it, photos). */
export function formProblems(form: MeasureForm, points: readonly MeasurePoint[], rule: PhotoRule): MeasureProblem[] {
  return [...basicProblems(form), ...pointProblems(form, points), ...fitProblems(form), ...photoProblems(form, rule)]
}

// ---- hints: never a refusal --------------------------------------------------------------------------------------------

export type HintKind = 'BELOW_RANGE' | 'ABOVE_RANGE' | 'FOR_HEIGHT'

/** A value worth checking again: the page says it beside the field and on Check and send; the send goes on. */
export interface MeasureHint {
  readonly code: string
  readonly kind: HintKind
  /** The value and the range or the height, in hundredths of a centimetre (the page shows them in the units chosen). */
  readonly valueCm: number
  readonly boundCm: number
}

/** The hints of the points typed (a range from the template; a girth above 75 % of the height; any length above the height). */
export function hintsOf(form: MeasureForm, points: readonly MeasurePoint[]): MeasureHint[] {
  const height = centimetresOf(form.basics.height, form.units)
  const out: MeasureHint[] = []
  for (const point of points) {
    const cm = centimetresOf(form.values[point.code], form.units)
    if (cm === null) continue
    const min = hundredthsOf(point.minCm)
    const max = hundredthsOf(point.maxCm)
    if (min !== null && cm < min) out.push({ code: point.code, kind: 'BELOW_RANGE', valueCm: cm, boundCm: min })
    else if (max !== null && cm > max) out.push({ code: point.code, kind: 'ABOVE_RANGE', valueCm: cm, boundCm: max })
    else if (height !== null && height >= MEASURE_LIMITS.heightCm.min * 100) {
      const girth = GIRTHS.has(normalCode(point.code))
      if ((girth && cm * 4 > height * 3) || cm > height) out.push({ code: point.code, kind: 'FOR_HEIGHT', valueCm: cm, boundCm: height })
    }
  }
  return out
}

// ---- grouping and progress ---------------------------------------------------------------------------------------------

/**
 * The points by body zone in the page's order (zones without a point left out), each zone's points in template order.
 * B-W2b-224 (SZ1:02): a point's own zone (its library point of measure's body zone) first; its code only when it has none.
 */
export function pointsByZone<P extends Pick<MeasurePoint, 'code' | 'seq'> & { readonly zone?: BodyZone | null }>(points: readonly P[]): Array<{ zone: BodyZone; points: P[] }> {
  const sorted = [...points].sort((a, b) => a.seq - b.seq || (a.code < b.code ? -1 : 1))
  return BODY_ZONES.map((zone) => ({ zone, points: sorted.filter((point) => (point.zone ?? zoneOf(point.code)) === zone) })).filter((group) => group.points.length > 0)
}

/** The points in the order the page walks them (zone by zone): what "Point 9 of 24" counts. */
export function walkOrder<P extends Pick<MeasurePoint, 'code' | 'seq'> & { readonly zone?: BodyZone | null }>(points: readonly P[]): P[] {
  return pointsByZone(points).flatMap((group) => group.points)
}

/** How many points have a value (the progress bar). */
export function filledCount(form: Pick<MeasureForm, 'values'>, points: readonly Pick<MeasurePoint, 'code'>[]): number {
  return points.filter((point) => (form.values[point.code] ?? '').trim() !== '').length
}

// ---- what lands in the profile -----------------------------------------------------------------------------------------

export interface ProfileValues {
  /** { "<point code>": { value: "61.5", unit: "cm" } } plus the height (cm) and the weight (kg). */
  readonly measurements: Record<string, { value: string; unit: string }>
  /** Fit, posture and riding notes, asymmetry and age, for the pattern maker (labels in English: data, as the office types it). */
  readonly fitNotes: string | null
}

/** The revision's values from a form without problems (the API calls it after formProblems is empty). */
export function profileValuesOf(form: MeasureForm, points: readonly MeasurePoint[]): ProfileValues {
  const measurements: Record<string, { value: string; unit: string }> = {}
  for (const point of walkOrder(points)) {
    const cm = centimetresOf(form.values[point.code], form.units)
    if (cm !== null) measurements[point.code] = { value: decimalOf(cm), unit: 'cm' }
  }
  const height = centimetresOf(form.basics.height, form.units)
  const weight = kilogramsOf(form.basics.weight, form.units)
  if (height !== null && !measurements.height) measurements.height = { value: decimalOf(height), unit: 'cm' }
  if (weight !== null && !measurements.weight) measurements.weight = { value: decimalOf(weight), unit: 'kg' }
  const lines = [
    form.fit.fit ? `Fit: ${form.fit.fit === 'SNUG' ? 'snug' : 'regular'}.` : null,
    form.basics.age.trim() ? `Age: ${form.basics.age.trim()}.` : null,
    form.units === 'in' ? 'Typed in inches and pounds (kept in cm and kg).' : null,
    form.fit.posture.trim() ? `Posture and riding: ${form.fit.posture.trim()}` : null,
    form.fit.asymmetry.trim() ? `Asymmetry: ${form.fit.asymmetry.trim()}` : null,
  ].filter((line): line is string => line !== null)
  return { measurements, fitNotes: lines.length > 0 ? lines.join('\n') : null }
}

/** The day the photos are deleted for a garment that shipped at `shippedAt` (Owner question 3). */
export function photosDeleteAfterFor(shippedAt: Date): Date {
  return new Date(shippedAt.getTime() + PHOTO_RETENTION_DAYS_AFTER_SHIPPING * 86_400_000)
}
