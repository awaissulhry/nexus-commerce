import type { Issue } from '../../core/errors'
import { formatDecimal } from '../../documents/format'
import type { DocumentLanguage } from '../../documents/model'
import type { ItemKind } from '../../product/materials/rules'
import { dimensionOf, fixedRatio, QUANTITY_SCALE, type Uom } from '../../product/units/units'
import { Dec, parseDecimal, type Decimal } from '../../tax/decimal'

/**
 * A fabric or trim purchase order line by rolls (B-W2b-328; SCM-076; design purchasing.orders record tab "Lines": "Fabric:
 * roll length and width"; factory-db supply.prisma PurchaseOrderLine.rolls, rollLengthM, rollWidthCm), pure.
 * apps/factory-api's modules/purchasing/line-kinds writes it through command(); the …_buying_depth_w2b_guards triggers hold
 * the same shape for every login (rolls above 0, a length or width only with the rolls).
 *
 *   who        fabrics (textile, lining, membrane, padding) and trims (tapes, webbing, elastic, hook-and-loop) are bought
 *              by rolls: how many, each roll's length in metres and its usable width in centimetres. Leather (hides),
 *              protectors, hardware and the rest are not.
 *   quantity   the rolls make the line's quantity when its unit can say it: ROLL = the rolls; a length (m, cm, mm) = rolls ×
 *              length; an area (m², dm², ft²) = rolls × length × width. In another unit (kg) the rolls are words for the
 *              supplier and the quantity stays as typed.
 *   width      the material's own width (its properties, B-W2b-206) is the default; another width is a warning (the
 *              marker and the yield were made for the material's).
 */

export const ROLL_KINDS = ['TEXTILE', 'LINING', 'MEMBRANE', 'PADDING', 'TRIM'] as const satisfies readonly ItemKind[]

/** A line's rolls: whole rolls up to 9999, each up to 10 000 m long and 1000 cm wide, two decimals at most. */
export const ROLL_LIMITS = { rolls: 9999, lengthM: '10000', widthCm: '1000', places: 2 } as const

export interface RollsInput {
  readonly count: number
  readonly lengthM?: string | null | undefined
  readonly widthCm?: string | null | undefined
}

/** A line's rolls as stored: plain decimals (no trailing zeros), a length or width only with the count. */
export interface Rolls {
  readonly count: number
  readonly lengthM: string | null
  readonly widthCm: string | null
}

export const buysByRolls = (kind: string): boolean => (ROLL_KINDS as readonly string[]).includes(kind)

const blank = (value: string | null | undefined): boolean => value === undefined || value === null || value.trim() === ''

function measureProblem(value: string | null | undefined, max: string, path: string, what: string): Issue | null {
  if (blank(value)) return null
  const parsed = parseDecimal(value!.trim())
  if (parsed === null || !parsed.greaterThan(0) || parsed.decimalPlaces() > ROLL_LIMITS.places || parsed.greaterThan(max)) {
    return { path, message: `${what}: a number above 0 and at most ${max}, two decimals at most.` }
  }
  return null
}

/** Why these rolls are not a line's rolls (paths under `at`); empty when they are. */
export function rollsProblems(input: RollsInput, item: { readonly code: string; readonly kind: string }, at = 'body/rolls'): Issue[] {
  if (!buysByRolls(item.kind)) {
    return [{ path: at, message: `${item.code} is ${item.kind.toLowerCase()}: only fabrics (textile, lining, membrane, padding) and trims are bought by rolls.` }]
  }
  const problems: Issue[] = []
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > ROLL_LIMITS.rolls) problems.push({ path: `${at}/count`, message: `Whole rolls, from 1 to ${ROLL_LIMITS.rolls}.` })
  const length = measureProblem(input.lengthM, ROLL_LIMITS.lengthM, `${at}/lengthM`, "Each roll's length in metres")
  if (length) problems.push(length)
  const width = measureProblem(input.widthCm, ROLL_LIMITS.widthCm, `${at}/widthCm`, "Each roll's usable width in centimetres")
  if (width) problems.push(width)
  return problems
}

const plain = (value: string | null | undefined): string | null => (blank(value) ? null : new Dec(value!.trim()).toString())

/** The rolls as stored (call after rollsProblems found none). */
export const normalRolls = (input: RollsInput): Rolls => ({ count: input.count, lengthM: plain(input.lengthM), widthCm: plain(input.widthCm) })

/** The rolls of a stored line, or null when it is not bought by rolls. */
export const rollsOf = (line: { readonly rolls: number | null; readonly rollLengthM: { toString(): string } | null; readonly rollWidthCm: { toString(): string } | null }): Rolls | null =>
  line.rolls === null ? null : { count: line.rolls, lengthM: line.rollLengthM === null ? null : new Dec(line.rollLengthM.toString()).toString(), widthCm: line.rollWidthCm === null ? null : new Dec(line.rollWidthCm.toString()).toString() }

const rounded = (value: Decimal): string => value.toDecimalPlaces(QUANTITY_SCALE, Dec.ROUND_HALF_UP).toFixed(QUANTITY_SCALE)

/**
 * The line's quantity in `uom` that the rolls make (four places, half up), or null when its unit cannot say it from them
 * (a mass, a piece, a length without the roll's length, an area without its width).
 */
export function rollsQuantity(rolls: Rolls, uom: Uom): string | null {
  if (uom === 'ROLL') return rounded(new Dec(rolls.count))
  const dimension = dimensionOf(uom)
  if (dimension === 'LENGTH' && rolls.lengthM !== null) {
    const ratio = fixedRatio('M', uom)
    return ratio === null ? null : rounded(new Dec(rolls.count).times(rolls.lengthM).times(ratio.toString()))
  }
  if (dimension === 'AREA' && rolls.lengthM !== null && rolls.widthCm !== null) {
    const ratio = fixedRatio('M2', uom)
    return ratio === null ? null : rounded(new Dec(rolls.count).times(rolls.lengthM).times(new Dec(rolls.widthCm).div(100)).times(ratio.toString()))
  }
  return null
}

/** Do the rolls still make the line's quantity? True when they make none (another unit). */
export function rollsMatch(rolls: Rolls, line: { readonly quantity: string; readonly uom: Uom }): boolean {
  const made = rollsQuantity(rolls, line.uom)
  return made === null || new Dec(made).equals(line.quantity)
}

const WORDS = {
  it: { roll: (count: number) => (count === 1 ? '1 rotolo' : `${count} rotoli`) },
  en: { roll: (count: number) => (count === 1 ? '1 roll' : `${count} rolls`) },
} as const

/** "2 rolls × 50 m × 150 cm" / "2 rotoli × 50 m × 150 cm" (the length and width when known). */
export function rollsWords(rolls: Rolls, language: DocumentLanguage = 'en'): string {
  const parts = [WORDS[language].roll(rolls.count)]
  if (rolls.lengthM !== null) parts.push(`${formatDecimal(rolls.lengthM, language, 0, 2)} m`)
  if (rolls.widthCm !== null) parts.push(`${formatDecimal(rolls.widthCm, language, 0, 2)} cm`)
  return parts.join(' × ')
}

/** The material's width in cm from its properties ({ "widthCm": "145" }, B-W2b-206), or null. */
export function materialWidthOf(properties: unknown): string | null {
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return null
  const value = (properties as Record<string, unknown>).widthCm
  const parsed = typeof value === 'string' || typeof value === 'number' ? parseDecimal(String(value)) : null
  return parsed !== null && parsed.greaterThan(0) ? parsed.toString() : null
}

/** A warning when the rolls are another width than the material's (null when the same, or either is unknown). */
export function widthNote(rolls: Rolls | null, materialWidthCm: string | null): string | null {
  if (!rolls || rolls.widthCm === null || materialWidthCm === null || new Dec(rolls.widthCm).equals(materialWidthCm)) return null
  return `The rolls are ${rolls.widthCm} cm wide; the material is ${materialWidthCm} cm wide (its properties): the marker and the yield were made for ${materialWidthCm} cm.`
}
