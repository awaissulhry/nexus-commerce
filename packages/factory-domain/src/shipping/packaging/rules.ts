import type { Issue } from '../../core/errors'
import { fitsDecimal, isCurrencyCode } from '../../core/money'
import { parseDecimal } from '../../tax/decimal'

/**
 * Packaging and carton marks (B-W2b-384; LOG-008, LOG-013; design warehouse.shipping "Packaging", floor.pack "Close
 * carton"), pure. The database (…_packing_w2b_guards) holds the same rules for every login; the API says them in words
 * first, at their fields.
 *
 *   PackagingType         a company's carton, box, pallet, polybag or hanger: inner size (cm, all three or none), tare and
 *                         most weight (kg, the most above the tare), a pallet's kind (exactly on a PALLET), the cost per
 *                         unit with its currency (both or neither; a cost); switched off, never deleted
 *   PackagingDefault      which type a style, or a run of sizes of a size scale, takes by default: one live default per
 *                         company, kind and scope; the most precise one wins (bestDefault)
 *   ShippingMarkTemplate  what a carton's marks show, in order (1 to 16 fields, each once), and their language
 */

export const PACKAGING_KINDS = ['CARTON', 'PALLET', 'POLYBAG', 'HANGER', 'BOX'] as const
export type PackagingKind = (typeof PACKAGING_KINDS)[number]

/** What a parcel (a carton of a shipment) is packed in; a polybag and a hanger go with each garment. */
export const PARCEL_PACKAGING_KINDS = ['CARTON', 'BOX', 'PALLET'] as const satisfies readonly PackagingKind[]
export const isParcelPackaging = (kind: PackagingKind): boolean => (PARCEL_PACKAGING_KINDS as readonly string[]).includes(kind)

export const PALLET_KINDS = ['EUR', 'OTHER'] as const
export type PalletKind = (typeof PALLET_KINDS)[number]

export const PACKAGING_NAME_MAX = 100

/** A packaging type's values as stored or sent: decimals as strings, null when not given. */
export interface PackagingTypeValues {
  readonly name: string
  readonly innerLengthCm: string | null
  readonly innerWidthCm: string | null
  readonly innerHeightCm: string | null
  readonly tareKg: string | null
  readonly maxWeightKg: string | null
  readonly palletKind: PalletKind | null
  readonly costPerUnit: string | null
  readonly costCurrency: string | null
}

const decimalIn = (value: string, precision: number, scale: number) => (fitsDecimal(value, precision, scale) ? parseDecimal(value) : null)

/** Every reason the type cannot be kept as it stands (path `<at>/<field>`). */
export function packagingTypeProblems(kind: PackagingKind, values: PackagingTypeValues, at = 'body'): Issue[] {
  const problems: Issue[] = []
  const name = values.name.trim()
  if (name === '' || [...name].length > PACKAGING_NAME_MAX || /[\r\n]/.test(values.name)) problems.push({ path: `${at}/name`, message: `A name of 1 to ${PACKAGING_NAME_MAX} characters on one line.` })
  const inner = [values.innerLengthCm, values.innerWidthCm, values.innerHeightCm]
  const given = inner.filter((value) => value !== null)
  if (given.length > 0 && given.length < 3) problems.push({ path: `${at}/innerLengthCm`, message: 'The inner length, width and height: all three or none.' })
  for (const [key, value] of [['innerLengthCm', values.innerLengthCm], ['innerWidthCm', values.innerWidthCm], ['innerHeightCm', values.innerHeightCm]] as const) {
    if (value !== null && !(decimalIn(value, 10, 2)?.greaterThan(0) ?? false)) problems.push({ path: `${at}/${key}`, message: 'Expected centimetres above 0, with at most 2 decimals.' })
  }
  const tare = values.tareKg === null ? null : decimalIn(values.tareKg, 18, 4)
  if (values.tareKg !== null && (tare === null || tare.isNegative())) problems.push({ path: `${at}/tareKg`, message: 'Expected its own weight in kilograms, 0 or more, with at most 4 decimals.' })
  const most = values.maxWeightKg === null ? null : decimalIn(values.maxWeightKg, 18, 4)
  if (values.maxWeightKg !== null && (most === null || !most.greaterThan(0))) problems.push({ path: `${at}/maxWeightKg`, message: 'Expected the most it may weigh full, in kilograms above 0, with at most 4 decimals.' })
  else if (most !== null && tare !== null && !tare.isNegative() && !most.greaterThan(tare)) problems.push({ path: `${at}/maxWeightKg`, message: 'The most it may weigh full is more than its own weight.' })
  if (kind === 'PALLET' && values.palletKind === null) problems.push({ path: `${at}/palletKind`, message: 'A pallet says its kind (EUR or OTHER).' })
  if (kind !== 'PALLET' && values.palletKind !== null) problems.push({ path: `${at}/palletKind`, message: 'Only a pallet has a pallet kind.' })
  if ((values.costPerUnit === null) !== (values.costCurrency === null)) problems.push({ path: `${at}/costPerUnit`, message: 'The cost per unit and its currency: both or neither.' })
  if (values.costPerUnit !== null && (decimalIn(values.costPerUnit, 18, 6)?.isNegative() ?? true)) problems.push({ path: `${at}/costPerUnit`, message: 'Expected a cost per unit of 0 or more, with at most 6 decimals.' })
  if (values.costCurrency !== null && !isCurrencyCode(values.costCurrency)) problems.push({ path: `${at}/costCurrency`, message: 'Expected an ISO 4217 currency code.' })
  return problems
}

/**
 * The weight of a carton's goods: its gross weight less the tare of its packaging, when both are known and the gross
 * weighs more; null otherwise. Kilograms, 4 decimals.
 */
export function netWeightKg(grossWeightKg: string | null, tareKg: string | null): string | null {
  const gross = grossWeightKg === null ? null : parseDecimal(grossWeightKg)
  const tare = tareKg === null ? null : parseDecimal(tareKg)
  if (!gross || !tare || !gross.greaterThan(tare)) return null
  return gross.minus(tare).toFixed(4)
}

/** The gross weight is above what the packaging may hold (null when either is not known). */
export function overweight(grossWeightKg: string | null, maxWeightKg: string | null): boolean {
  const gross = grossWeightKg === null ? null : parseDecimal(grossWeightKg)
  const most = maxWeightKg === null ? null : parseDecimal(maxWeightKg)
  return gross !== null && most !== null && gross.greaterThan(most)
}

// ---- defaults per style or size run --------------------------------------------------------------------------------

/** What a default is for: a style, a size scale, or both, with an optional run of sizes of the scale. */
export interface DefaultScope {
  readonly styleId: string | null
  readonly sizeScaleId: string | null
  readonly fromSize: string | null
  readonly toSize: string | null
}

/** The shape of a default's scope (the database checks the sizes, the style and the scale against their records). */
export function defaultScopeProblems(scope: DefaultScope, at = 'body'): Issue[] {
  const problems: Issue[] = []
  if (scope.styleId === null && scope.sizeScaleId === null) problems.push({ path: `${at}/styleId`, message: 'A default is for a style or a size run (a size scale), at least one.' })
  if ((scope.fromSize === null) !== (scope.toSize === null)) problems.push({ path: `${at}/fromSize`, message: 'A size run goes from one size to another: both or neither.' })
  else if (scope.fromSize !== null && scope.sizeScaleId === null) problems.push({ path: `${at}/sizeScaleId`, message: 'A size run names its size scale.' })
  return problems
}

/** A live default, its run as the positions of its sizes in the scale (null: every size). */
export interface LiveDefault {
  readonly id: string
  readonly packagingTypeId: string
  readonly kind: PackagingKind
  readonly styleId: string | null
  readonly sizeScaleId: string | null
  readonly fromSeq: number | null
  readonly toSeq: number | null
}

/** The garment a default is looked for: its style, the style's size scale, its size's position in that scale. */
export interface DefaultFor {
  readonly styleId: string
  readonly sizeScaleId: string
  readonly sizeSeq: number | null
}

/**
 * How precise a default is for a garment, or null when it is not for it: a style's run 3, the style 2, a scale's run 1,
 * the whole scale 0.
 */
function precisionOf(entry: LiveDefault, garment: DefaultFor): number | null {
  if (entry.styleId !== null && entry.styleId !== garment.styleId) return null
  if (entry.sizeScaleId !== null && entry.sizeScaleId !== garment.sizeScaleId) return null
  const run = entry.fromSeq !== null && entry.toSeq !== null
  if (run && (garment.sizeSeq === null || garment.sizeSeq < entry.fromSeq! || garment.sizeSeq > entry.toSeq!)) return null
  return (entry.styleId !== null ? 2 : 0) + (run ? 1 : 0)
}

/** The live default of a kind that fits the garment best (most precise; on a tie the first given), or null. */
export function bestDefault(defaults: readonly LiveDefault[], kind: PackagingKind, garment: DefaultFor): LiveDefault | null {
  let best: { entry: LiveDefault; precision: number } | null = null
  for (const entry of defaults) {
    if (entry.kind !== kind) continue
    const precision = precisionOf(entry, garment)
    if (precision !== null && (best === null || precision > best.precision)) best = { entry, precision }
  }
  return best?.entry ?? null
}

// ---- shipping-mark templates ---------------------------------------------------------------------------------------

/** What a carton's marks can show, each in the template's language (factory-db ShippingMarkField). */
export const SHIPPING_MARK_FIELDS = [
  'SHIP_TO',
  'SENDER',
  'CUSTOMER_ORDER',
  'ORDER_NUMBER',
  'SHIPMENT_NUMBER',
  'STYLE',
  'CUSTOMER_STYLE',
  'COLOUR',
  'SIZES',
  'QUANTITY',
  'CARTON_NUMBER',
  'GROSS_WEIGHT',
  'NET_WEIGHT',
  'DIMENSIONS',
  'BATCH',
  'ORIGIN',
] as const
export type ShippingMarkField = (typeof SHIPPING_MARK_FIELDS)[number]

export const MARK_LANGUAGE = /^[a-z]{2}$/

/** The fields (1 to 16, each once) and the language (ISO 639-1) of a template. */
export function markTemplateProblems(template: { readonly fields: readonly string[]; readonly language: string }, at = 'body'): Issue[] {
  const problems: Issue[] = []
  const known = template.fields.every((field) => (SHIPPING_MARK_FIELDS as readonly string[]).includes(field))
  if (template.fields.length < 1 || template.fields.length > SHIPPING_MARK_FIELDS.length || !known || new Set(template.fields).size !== template.fields.length) {
    problems.push({ path: `${at}/fields`, message: `Choose 1 to ${SHIPPING_MARK_FIELDS.length} of the mark fields, each once.` })
  }
  if (!MARK_LANGUAGE.test(template.language)) problems.push({ path: `${at}/language`, message: 'Expected a language of two lower-case letters (ISO 639-1), such as it or en.' })
  return problems
}

/** The template that prints a carton's marks: the customer's own live one, else the company's live default, else none. */
export function templateFor<Template extends { readonly partyId: string | null; readonly active: boolean }>(templates: readonly Template[], partyId: string): Template | null {
  return templates.find((template) => template.active && template.partyId === partyId) ?? templates.find((template) => template.active && template.partyId === null) ?? null
}
