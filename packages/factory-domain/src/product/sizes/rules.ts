import { Decimal } from 'decimal.js'
import type { Issue } from '../../core/errors'
import { fitsDecimal } from '../../core/money'
import { defineMachine } from '../../state/machine'
import { decimalText } from '../units/units'

/**
 * The size scale library (plan A1 §2.4 B; features PRD-047, PRD-048), pure. A scale (factory-db `SizeScale`) is an
 * ordered list of sizes (`Size`): EU 44-64, S-4XL, gloves 7-13, women 38-50, reused by many styles. A style picks its
 * range from one scale (../styles), and every row after it names a size by its CODE: the style's range and base size,
 * its SKUs, BOM quantities per size, certificate coverage, quote and order lines, work orders and labels. So:
 *
 *   code        a size code is 1 to 10 capital letters or digits, with . or _ inside, never `-` (the SKU separator:
 *               ../styles/sku keeps SKUs unique by it), and unique in its scale
 *   in use      once a style of the scale names a size (range, base size, SKU, BOM, coverage, order line), its code never
 *               changes and the scale's order stays as it is (styles keep their range in the scale's order); sizes are
 *               still added (at the end or before a size) and archived (out of new use), never removed
 *   measures    the body measures a size is for (EN 17092 size pictogram, PRD-288): per measurement point a range with
 *               its unit; one point has one unit across the scale
 *
 * apps/factory-api's modules/product/styles checks every write against these rules BEFORE it writes, and asks the
 * database what is in use.
 */

export const MASTER_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export type MasterStatus = (typeof MASTER_STATUSES)[number]

/** A scale and a size: ACTIVE ↔ ARCHIVED (PRD-022: in use, archived, never deleted). */
export const sizeScaleMachine = defineMachine({ name: 'size scale', states: MASTER_STATUSES, transitions: { ACTIVE: ['ARCHIVED'], ARCHIVED: ['ACTIVE'] } })
export const sizeMachine = defineMachine({ name: 'size', states: MASTER_STATUSES, transitions: { ACTIVE: ['ARCHIVED'], ARCHIVED: ['ACTIVE'] } })

/** A scale's code: 1 to 40 capital letters or digits, with . _ - / inside ("EU-44-64", "GLOVES-7-13"). */
export const SCALE_CODE = /^[A-Z0-9](?:[A-Z0-9._/-]{0,38}[A-Z0-9])?$/
export const SCALE_CODE_RULE = '1 to 40 capital letters or digits, with . _ - / inside'

/** A size code: 1 to 10 capital letters or digits, with . or _ inside ("52", "XL", "3XL", "7.5"); never `-`. */
export const SIZE_CODE = /^[A-Z0-9](?:[A-Z0-9._]{0,8}[A-Z0-9])?$/
export const SIZE_CODE_RULE = '1 to 10 capital letters or digits, with . or _ inside (no -)'

/** At most this many sizes in one scale. */
export const MAX_SCALE_SIZES = 60

/** A code as typed: trimmed and upper-cased. */
export const normaliseSizeCode = (value: string): string => value.trim().toUpperCase()

// ---- body measures ------------------------------------------------------------------------------------------------------

/** The units a body measure is written in: lengths, and body mass for a few pictograms. */
export const BODY_MEASURE_UNITS = ['cm', 'mm', 'in', 'kg'] as const
export type BodyMeasureUnit = (typeof BODY_MEASURE_UNITS)[number]

/** A measurement point's key ("chest", "inside_leg"): the code a measurement template and a size use. */
export const MEASURE_POINT = /^[a-z][a-z0-9_]{0,39}$/
export const MAX_MEASURE_POINTS = 30

/** The range of one body measure: at least one end, decimal strings, `min` ≤ `max`. */
export interface BodyMeasure {
  readonly min: string | null
  readonly max: string | null
  readonly unit: BodyMeasureUnit
}
export type BodyMeasures = Readonly<Record<string, BodyMeasure>>

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP })
const PLAIN = /^\d+(?:\.\d+)?$/
const measureValueOk = (value: string): boolean => PLAIN.test(value) && fitsDecimal(value, 8, 2) && new D(value).gt(0)

/** What is wrong with one size's body measures (paths below `at`). */
export function bodyMeasuresProblems(measures: BodyMeasures | null, at = 'bodyMeasures'): Issue[] {
  if (measures === null) return []
  const entries = Object.entries(measures)
  if (entries.length > MAX_MEASURE_POINTS) return [{ path: at, message: `At most ${MAX_MEASURE_POINTS} body measures.` }]
  const issues: Issue[] = []
  for (const [point, measure] of entries) {
    const path = `${at}/${point}`
    if (!MEASURE_POINT.test(point)) {
      issues.push({ path, message: 'A measurement point is named in lower case: letters, digits and _, at most 40 ("chest", "inside_leg").' })
      continue
    }
    if (!(BODY_MEASURE_UNITS as readonly string[]).includes(measure.unit)) issues.push({ path: `${path}/unit`, message: `Expected one of ${BODY_MEASURE_UNITS.join(', ')}.` })
    if (measure.min === null && measure.max === null) {
      issues.push({ path, message: 'Give at least the smallest or the largest value.' })
      continue
    }
    for (const end of ['min', 'max'] as const) {
      const value = measure[end]
      if (value !== null && !measureValueOk(value)) issues.push({ path: `${path}/${end}`, message: 'Expected a number above 0 with at most 6 digits and 2 decimals.' })
    }
    if (measure.min !== null && measure.max !== null && measureValueOk(measure.min) && measureValueOk(measure.max) && new D(measure.min).gt(measure.max)) {
      issues.push({ path: `${path}/max`, message: 'The largest value is at least the smallest.' })
    }
  }
  return issues
}

/** The measures as stored: decimals written plainly, points in name order. */
export function normaliseBodyMeasures(measures: BodyMeasures | null | undefined): BodyMeasures | null {
  if (measures === null || measures === undefined) return null
  const entries = Object.entries(measures)
  if (entries.length === 0) return null
  return Object.fromEntries(
    entries
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([point, measure]) => [
        point,
        {
          min: measure.min === null || !PLAIN.test(measure.min) ? measure.min : decimalText(measure.min),
          max: measure.max === null || !PLAIN.test(measure.max) ? measure.max : decimalText(measure.max),
          unit: measure.unit,
        },
      ]),
  )
}

// ---- one size, a list of sizes ------------------------------------------------------------------------------------------

/** What a size holds besides its place and status. */
export interface SizeFields {
  readonly code: string
  /** How it is shown when not by its code ("52 (L)"). */
  readonly label: string | null
  readonly bodyMeasures: BodyMeasures | null
}

/** A size as typed: the code upper-cased, the label trimmed (empty: none), the measures written plainly. */
export function normaliseSize(size: { readonly code: string; readonly label?: string | null | undefined; readonly bodyMeasures?: BodyMeasures | null | undefined }): SizeFields {
  const label = size.label?.trim() ?? ''
  return { code: normaliseSizeCode(size.code), label: label === '' ? null : label, bodyMeasures: normaliseBodyMeasures(size.bodyMeasures) }
}

export function sizeProblems(size: SizeFields, at = ''): Issue[] {
  const issues: Issue[] = []
  if (!SIZE_CODE.test(size.code)) issues.push({ path: `${at}code`, message: `Expected ${SIZE_CODE_RULE}.` })
  if (size.label !== null && (size.label.trim() !== size.label || size.label === '' || size.label.length > 40)) {
    issues.push({ path: `${at}label`, message: 'A label is at most 40 characters.' })
  }
  issues.push(...bodyMeasuresProblems(size.bodyMeasures, `${at}bodyMeasures`))
  return issues
}

/**
 * One measurement point has one unit across the scale (a chest in cm in every size): the units of `sizes` against each
 * other and against the units the scale already uses (`known`: point → unit).
 */
export function measureUnitProblems(sizes: readonly SizeFields[], known: Readonly<Record<string, BodyMeasureUnit>> = {}, at = 'sizes/'): Issue[] {
  const units = new Map<string, BodyMeasureUnit>(Object.entries(known))
  const issues: Issue[] = []
  sizes.forEach((size, index) => {
    for (const [point, measure] of Object.entries(size.bodyMeasures ?? {})) {
      const unit = units.get(point)
      if (unit === undefined) units.set(point, measure.unit)
      else if (unit !== measure.unit) issues.push({ path: `${at}${index}/bodyMeasures/${point}/unit`, message: `The scale measures ${point} in ${unit}: use ${unit} in every size.` })
    }
  })
  return issues
}

/** The units a scale's sizes use, per measurement point (the first size that names a point sets it). */
export function measureUnitsOf(sizes: readonly Pick<SizeFields, 'bodyMeasures'>[]): Record<string, BodyMeasureUnit> {
  const units: Record<string, BodyMeasureUnit> = {}
  for (const size of sizes) for (const [point, measure] of Object.entries(size.bodyMeasures ?? {})) units[point] ??= measure.unit
  return units
}

/** The sizes of a new scale, or added to one: each valid, each code once (also against `taken`), one unit per point. */
export function sizeListProblems(sizes: readonly SizeFields[], options: { readonly taken?: readonly string[]; readonly units?: Readonly<Record<string, BodyMeasureUnit>>; readonly at?: string; readonly max?: number } = {}): Issue[] {
  const at = options.at ?? 'sizes/'
  const max = options.max ?? MAX_SCALE_SIZES
  if (sizes.length === 0) return [{ path: at.replace(/\/$/, ''), message: 'Give at least one size.' }]
  if (sizes.length + (options.taken?.length ?? 0) > max) return [{ path: at.replace(/\/$/, ''), message: `A scale has at most ${max} sizes.` }]
  const seen = new Set<string>(options.taken ?? [])
  const issues = sizes.flatMap((size, index) => {
    const found = sizeProblems(size, `${at}${index}/`)
    if (seen.has(size.code)) found.push({ path: `${at}${index}/code`, message: `The scale has size ${size.code} already.` })
    seen.add(size.code)
    return found
  })
  return [...issues, ...measureUnitProblems(sizes, options.units, at)]
}

// ---- the scale ----------------------------------------------------------------------------------------------------------

export interface ScaleFields {
  readonly code: string
  readonly name: string
}

export function normaliseScale(scale: ScaleFields): ScaleFields {
  return { code: normaliseSizeCode(scale.code), name: scale.name.trim() }
}

export function scaleProblems(scale: ScaleFields): Issue[] {
  const issues: Issue[] = []
  if (!SCALE_CODE.test(scale.code)) issues.push({ path: 'code', message: `Expected ${SCALE_CODE_RULE}.` })
  if (scale.name === '' || scale.name.length > 120) issues.push({ path: 'name', message: 'Name the scale (at most 120 characters).' })
  return issues
}

// ---- the order of the sizes ---------------------------------------------------------------------------------------------

/** A size of a scale as its order needs it. */
export interface PlacedSize {
  readonly code: string
  readonly seq: number
  readonly status: MasterStatus
}

/** The scale's codes from small to large (by seq, then code). */
export function scaleOrder(sizes: readonly Pick<PlacedSize, 'code' | 'seq'>[]): string[] {
  return [...sizes].sort((a, b) => a.seq - b.seq || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)).map((size) => size.code)
}

export type OrderOutcome = { readonly ok: true; readonly order: readonly string[] } | { readonly ok: false; readonly issues: readonly Issue[] }

/**
 * The scale's order with `added` codes put before the size `before` (or at the end): sizes are added to a scale in use,
 * since the order of the sizes already there does not change.
 */
export function insertSizes(current: readonly Pick<PlacedSize, 'code' | 'seq'>[], added: readonly string[], before?: string | null): OrderOutcome {
  const order = scaleOrder(current)
  if (before === undefined || before === null) return { ok: true, order: [...order, ...added] }
  const at = order.indexOf(before)
  if (at < 0) return { ok: false, issues: [{ path: 'before', message: `The scale has no size ${before}.` }] }
  return { ok: true, order: [...order.slice(0, at), ...added, ...order.slice(at)] }
}

/** A new order of a scale's sizes: every size once, none other. */
export function reorderProblems(current: readonly string[], order: readonly string[]): Issue[] {
  const known = new Set(current)
  const seen = new Set<string>()
  const issues: Issue[] = []
  order.forEach((code, index) => {
    if (!known.has(code)) issues.push({ path: `codes/${index}`, message: `The scale has no size ${code}.` })
    else if (seen.has(code)) issues.push({ path: `codes/${index}`, message: `Size ${code} is listed twice.` })
    seen.add(code)
  })
  const missing = current.filter((code) => !seen.has(code))
  if (missing.length > 0) issues.push({ path: 'codes', message: `List every size of the scale once; missing: ${missing.join(', ')}.` })
  return issues
}

/** The seq each code gets for an order: 1, 2, 3 … */
export function sequenceOf(order: readonly string[]): Map<string, number> {
  return new Map(order.map((code, index) => [code, index + 1]))
}

/** Codes put in the scale's order (codes the scale does not have go last, in their own order). */
export function inScaleOrder(codes: readonly string[], scale: readonly Pick<PlacedSize, 'code' | 'seq'>[]): string[] {
  const place = sequenceOf(scaleOrder(scale))
  return [...codes].sort((a, b) => (place.get(a) ?? Number.MAX_SAFE_INTEGER) - (place.get(b) ?? Number.MAX_SAFE_INTEGER))
}

/**
 * Why a size of a scale cannot get a new code: it is in use (a style, SKU, BOM, coverage or order line names it).
 * `inUse` comes from the database.
 */
export function sizeCodeChangeRefusal(code: string, inUse: ReadonlySet<string>): string | null {
  return inUse.has(code) ? `Size ${code} is in use (a style's range, a SKU, a BOM, a certificate or an order names it): its code never changes.` : null
}
