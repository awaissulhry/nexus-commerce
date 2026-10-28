import { Decimal } from 'decimal.js'
import { ValidationError, type Issue } from '../../core/errors'

/**
 * Units of measure and their conversions (plan A1 §2.1 "Quantities", PLAN Q13; feature PRD-030), pure.
 *
 * The units are a closed list (the factory-db enum `Uom`; a unit is added, never renamed). Each belongs to a dimension:
 *
 *   COUNT    PCS 1, PAIR 2 (pieces)              AREA     M2 1, DM2 0.01, FT2 0.09290304 (square metres)
 *   LENGTH   M 1, CM 0.01, MM 0.001 (metres)     MASS     KG 1, G 0.001 (kilograms)
 *   VOLUME   L 1 (litres)                        ITEM     SET, HIDE, SIDE, ROLL, CONE, BOX: what the item says
 *
 * Inside one dimension the factors are fixed and the same for every tenant (1 ft² = 0.3048² m² = 0.09290304 m² exactly;
 * 1 dm² = 0.01 m²). A unit of the ITEM dimension holds what its item says: a hide's average area, a roll's length, a
 * cone's metres, a set's pieces.
 *
 * An item counts its stock, lots and standard cost in its BASE unit and is bought and consumed in its purchase and
 * consumption units, each with a FACTOR: how many base units one of it holds (A1 "factorToBase"). For a unit of the base
 * unit's own fixed dimension the factor is derived, never typed (base FT2, purchase M2: 10.76391042); for any other
 * unit the item gives it (base FT2, purchase HIDE: 52.5; base M2, purchase M of a 1.5 m wide fabric: 1.5).
 *
 * Exactness: quantities are decimals (decimal.js), never floats. A derived factor is stored rounded to FACTOR_SCALE
 * decimals (Decimal(18,8)), but conversions inside a dimension use the exact ratio, so 250 dm² is 26.9098 ft² whatever
 * the stored factor's last digit. Every conversion rounds ONCE, at the end, to the scale and the rounding its caller
 * names: HALF_UP for a measured quantity, UP when a need becomes a purchase (never buy less than the need), DOWN when
 * what is on hand becomes what can be issued.
 */

/** decimal.js, cloned: the precision and exponents set here never leak into another module's Decimal. */
const U = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -60, toExpPos: 60 })

export const UOMS = ['PCS', 'PAIR', 'SET', 'M', 'CM', 'MM', 'M2', 'DM2', 'FT2', 'KG', 'G', 'L', 'HIDE', 'SIDE', 'ROLL', 'CONE', 'BOX'] as const
export type Uom = (typeof UOMS)[number]

export const UOM_DIMENSIONS = ['COUNT', 'LENGTH', 'AREA', 'MASS', 'VOLUME', 'ITEM'] as const
export type UomDimension = (typeof UOM_DIMENSIONS)[number]

export interface UnitDefinition {
  readonly uom: Uom
  readonly dimension: UomDimension
  /** How many of its dimension's reference unit (PCS, M, M2, KG, L) one of it is; null in the ITEM dimension. */
  readonly reference: string | null
  /** As screens and documents write it. */
  readonly symbol: string
  readonly name: { readonly it: string; readonly en: string }
}

const unit = (uom: Uom, dimension: UomDimension, reference: string | null, symbol: string, it: string, en: string): UnitDefinition =>
  Object.freeze({ uom, dimension, reference, symbol, name: Object.freeze({ it, en }) })

export const UNITS: Readonly<Record<Uom, UnitDefinition>> = Object.freeze({
  PCS: unit('PCS', 'COUNT', '1', 'pz', 'pezzo', 'piece'),
  PAIR: unit('PAIR', 'COUNT', '2', 'paio', 'paio', 'pair'),
  SET: unit('SET', 'ITEM', null, 'set', 'set', 'set'),
  M: unit('M', 'LENGTH', '1', 'm', 'metro', 'metre'),
  CM: unit('CM', 'LENGTH', '0.01', 'cm', 'centimetro', 'centimetre'),
  MM: unit('MM', 'LENGTH', '0.001', 'mm', 'millimetro', 'millimetre'),
  M2: unit('M2', 'AREA', '1', 'm²', 'metro quadro', 'square metre'),
  DM2: unit('DM2', 'AREA', '0.01', 'dm²', 'decimetro quadro', 'square decimetre'),
  FT2: unit('FT2', 'AREA', '0.09290304', 'ft²', 'piede quadro', 'square foot'),
  KG: unit('KG', 'MASS', '1', 'kg', 'chilogrammo', 'kilogram'),
  G: unit('G', 'MASS', '0.001', 'g', 'grammo', 'gram'),
  L: unit('L', 'VOLUME', '1', 'l', 'litro', 'litre'),
  HIDE: unit('HIDE', 'ITEM', null, 'pelle', 'pelle', 'hide'),
  SIDE: unit('SIDE', 'ITEM', null, 'mezza pelle', 'mezza pelle', 'side'),
  ROLL: unit('ROLL', 'ITEM', null, 'rotolo', 'rotolo', 'roll'),
  CONE: unit('CONE', 'ITEM', null, 'cono', 'cono', 'cone'),
  BOX: unit('BOX', 'ITEM', null, 'scatola', 'scatola', 'box'),
})

export const dimensionOf = (uom: Uom): UomDimension => UNITS[uom].dimension

/** A decimal as accepted here: a Decimal (of any decimal.js clone), or a plain decimal string ("52.5", "-0.001"). */
export type DecimalInput = Decimal | string

const PLAIN = /^-?\d{1,30}(\.\d{1,30})?$/

/** The value as an exact decimal, or a ValidationError naming `path`. */
export function decimalOf(value: DecimalInput, path = 'quantity'): Decimal {
  if (Decimal.isDecimal(value)) {
    const exact = new U(value as Decimal)
    if (exact.isFinite()) return exact
  } else if (typeof value === 'string' && PLAIN.test(value)) {
    return new U(value)
  }
  throw new ValidationError('The number is not valid.', [{ path, message: 'Expected a plain decimal such as 12.5.' }])
}

/**
 * How many `to` one `from` is, exactly, when both have a fixed factor in one dimension (or are the same unit); null
 * otherwise (another dimension, or a unit whose size its item says).
 */
export function fixedRatio(from: Uom, to: Uom): Decimal | null {
  if (from === to) return new U(1)
  const a = UNITS[from]
  const b = UNITS[to]
  if (a.reference === null || b.reference === null || a.dimension !== b.dimension) return null
  return new U(a.reference).div(b.reference)
}

// ---- rounding ---------------------------------------------------------------------------------------------------------

/** HALF_UP: to the nearest, a half away from zero. UP: away from zero (never less). DOWN: towards zero (never more). */
export const ROUNDINGS = ['HALF_UP', 'UP', 'DOWN'] as const
export type Rounding = (typeof ROUNDINGS)[number]

const MODE: Readonly<Record<Rounding, Decimal.Rounding>> = { HALF_UP: Decimal.ROUND_HALF_UP, UP: Decimal.ROUND_UP, DOWN: Decimal.ROUND_DOWN }

/** Where a conversion rounds: always said by its caller. */
export interface RoundTo {
  /** Decimal places: QUANTITY_SCALE for a stock or order quantity, COST_SCALE for a unit cost. */
  readonly scale: number
  readonly rounding: Rounding
}

/** Quantities are Decimal(18,4); unit costs Decimal(18,6); unit factors Decimal(18,8) (factory-db). */
export const QUANTITY_SCALE = 4
export const COST_SCALE = 6
export const FACTOR_SCALE = 8
/** A factor has at most this many digits before the decimal point (Decimal(18,8)). */
export const FACTOR_INTEGER_DIGITS = 10

export function roundTo(value: DecimalInput, { scale, rounding }: RoundTo): Decimal {
  if (!Number.isInteger(scale) || scale < 0 || scale > 20) throw new RangeError(`scale ${scale} is not 0 to 20`)
  if (!(ROUNDINGS as readonly string[]).includes(rounding)) throw new RangeError(`rounding ${String(rounding)} is not one of ${ROUNDINGS.join(', ')}`)
  return decimalOf(value).toDecimalPlaces(scale, MODE[rounding])
}

/** A decimal as plain text, without exponent or trailing zeros: "52.5", "0.09290304", "3". */
export function decimalText(value: DecimalInput): string {
  const text = decimalOf(value).toFixed()
  const trimmed = text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
  return trimmed === '-0' ? '0' : trimmed
}

// ---- an item's units --------------------------------------------------------------------------------------------------

/** An item's units, as stored: every factor is how many base units one of that unit holds. */
export interface ItemUnits {
  readonly baseUom: Uom
  readonly purchaseUom: Uom
  readonly purchaseFactor: DecimalInput
  readonly consumptionUom: Uom
  readonly consumptionFactor: DecimalInput
}

/**
 * How many base units one `unit` holds for this item, exactly; null when the item cannot convert it (another
 * dimension, and neither its purchase nor its consumption unit). A unit of the base unit's fixed dimension uses the
 * exact ratio, never the stored (rounded) factor.
 */
export function baseFactor(unit: Uom, item: ItemUnits): Decimal | null {
  const fixed = fixedRatio(unit, item.baseUom)
  if (fixed) return fixed
  if (unit === item.purchaseUom) return decimalOf(item.purchaseFactor, 'purchaseFactor')
  if (unit === item.consumptionUom) return decimalOf(item.consumptionFactor, 'consumptionFactor')
  return null
}

/** Every unit this item converts to and from its base unit. */
export function convertibleUnits(item: ItemUnits): Uom[] {
  return UOMS.filter((uom) => baseFactor(uom, item) !== null)
}

/** The units of this list the item cannot convert (a BOM line's unit that its material no longer has). */
export function unconvertibleUnits(units: Iterable<Uom>, item: ItemUnits): Uom[] {
  const can = new Set(convertibleUnits(item))
  return [...new Set(units)].filter((uom) => !can.has(uom)).sort()
}

function factorOrThrow(unit: Uom, item: ItemUnits, path: string): Decimal {
  const factor = baseFactor(unit, item)
  if (factor === null) {
    throw new ValidationError(`This material does not convert ${unit} to its base unit ${item.baseUom}.`, [
      { path, message: `Use ${convertibleUnits(item).join(', ')}.` },
    ])
  }
  return factor
}

/** A quantity in `unit` as base units (quantity × factor), rounded as the caller says. */
export function toBase(quantity: DecimalInput, unit: Uom, item: ItemUnits, round: RoundTo): Decimal {
  return roundTo(decimalOf(quantity).times(factorOrThrow(unit, item, 'uom')), round)
}

/** A quantity in base units as `unit` (quantity ÷ factor), rounded as the caller says. */
export function fromBase(baseQuantity: DecimalInput, unit: Uom, item: ItemUnits, round: RoundTo): Decimal {
  return roundTo(decimalOf(baseQuantity).div(factorOrThrow(unit, item, 'uom')), round)
}

/** A quantity from one of the item's units to another, through the base unit exactly, rounded once at the end. */
export function convert(quantity: DecimalInput, from: Uom, to: Uom, item: ItemUnits, round: RoundTo): Decimal {
  const exact = decimalOf(quantity).times(factorOrThrow(from, item, 'from')).div(factorOrThrow(to, item, 'to'))
  return roundTo(exact, round)
}

/** The cost of one `unit` from the cost of one base unit (cost × factor): € per hide from € per ft². */
export function unitCostIn(costPerBase: DecimalInput, unit: Uom, item: ItemUnits, round: RoundTo): Decimal {
  return roundTo(decimalOf(costPerBase, 'standardCost').times(factorOrThrow(unit, item, 'uom')), round)
}

// ---- checking and resolving an item's units -----------------------------------------------------------------------------

/** An item's units as typed: the purchase and consumption units default to the base unit, their factors to derived. */
export interface ItemUnitsInput {
  readonly baseUom: Uom
  readonly purchaseUom?: Uom | null | undefined
  readonly purchaseFactor?: string | null | undefined
  readonly consumptionUom?: Uom | null | undefined
  readonly consumptionFactor?: string | null | undefined
}

/** The resolved units: every factor as stored (a plain decimal string, at most FACTOR_SCALE decimals). */
export interface ResolvedItemUnits {
  readonly baseUom: Uom
  readonly purchaseUom: Uom
  readonly purchaseFactor: string
  readonly consumptionUom: Uom
  readonly consumptionFactor: string
}

export type UnitsResolution =
  | { readonly ok: true; readonly units: ResolvedItemUnits }
  | { readonly ok: false; readonly issues: readonly Issue[] }

/** A typed factor: a plain decimal above 0, at most FACTOR_INTEGER_DIGITS digits and FACTOR_SCALE decimals. */
export function factorProblem(value: string): string | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value)
  if (!match) return 'Expected a number above 0 written like 52.5.'
  if (match[1]!.replace(/^0+(?=\d)/, '').length > FACTOR_INTEGER_DIGITS) return `At most ${FACTOR_INTEGER_DIGITS} digits before the decimal point.`
  if ((match[2]?.length ?? 0) > FACTOR_SCALE) return `At most ${FACTOR_SCALE} decimals.`
  if (new U(value).lte(0)) return 'The factor is above 0.'
  return null
}

/** The factor a unit has for this base unit: '1', the derived fixed one, or the typed one (checked). */
function resolveFactor(unit: Uom, base: Uom, given: string | null | undefined, path: string, issues: Issue[]): string {
  const name = (uom: Uom) => UNITS[uom].symbol
  if (unit === base) {
    if (given !== null && given !== undefined && !(factorProblem(given) === null && new U(given).eq(1))) {
      issues.push({ path, message: `One ${name(unit)} is one ${name(base)}: the factor is 1.` })
    }
    return '1'
  }
  const fixed = fixedRatio(unit, base)
  if (fixed) {
    const derived = decimalText(roundTo(fixed, { scale: FACTOR_SCALE, rounding: 'HALF_UP' }))
    if (new U(derived).lte(0)) {
      issues.push({ path, message: `One ${name(unit)} is too small a part of one ${name(base)}; choose a smaller base unit.` })
    } else if (given !== null && given !== undefined && (factorProblem(given) !== null || !new U(given).eq(derived))) {
      issues.push({ path, message: `One ${name(unit)} is ${derived} ${name(base)}: the factor is fixed; leave it out.` })
    }
    return derived
  }
  if (given === null || given === undefined) {
    const hint = unit === 'HIDE' || unit === 'SIDE' ? ' (its average area)' : ''
    issues.push({ path, message: `Say how many ${name(base)} one ${name(unit)} holds${hint}.` })
    return ''
  }
  const problem = factorProblem(given)
  if (problem) issues.push({ path, message: problem })
  return problem ? '' : decimalText(given)
}

/**
 * Checks an item's units and resolves their factors (PRD-030): the same unit → 1; a unit of the base unit's fixed
 * dimension → the derived factor (a typed one must equal it); any other unit → its typed factor, required, above 0.
 * When the purchase and consumption units are the same unit, they have one factor.
 */
export function resolveItemUnits(input: ItemUnitsInput): UnitsResolution {
  const issues: Issue[] = []
  const baseUom = input.baseUom
  const purchaseUom = input.purchaseUom ?? baseUom
  const consumptionUom = input.consumptionUom ?? baseUom
  const purchaseFactor = resolveFactor(purchaseUom, baseUom, input.purchaseFactor, 'purchaseFactor', issues)
  const consumptionFactor = resolveFactor(consumptionUom, baseUom, input.consumptionFactor, 'consumptionFactor', issues)
  if (
    issues.length === 0 &&
    purchaseUom === consumptionUom &&
    fixedRatio(purchaseUom, baseUom) === null &&
    !new U(purchaseFactor).eq(consumptionFactor)
  ) {
    issues.push({ path: 'consumptionFactor', message: `The purchase and consumption units are both ${UNITS[purchaseUom].symbol}: they hold the same number of ${UNITS[baseUom].symbol}.` })
  }
  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, units: { baseUom, purchaseUom, purchaseFactor, consumptionUom, consumptionFactor } }
}

/**
 * The factor of a purchase or consumption unit when the item's base unit moves from `oldBase` to `newBase` and the
 * factor is not typed again: undefined when the new base derives it (or the unit is the new base), the old factor
 * carried over by the fixed ratio of the two bases when they share a dimension (a hide of 52.5 ft² is 4.8774096 m²),
 * and undefined otherwise (then it must be typed again; resolveItemUnits says so).
 */
export function carriedFactor(unit: Uom, oldFactor: DecimalInput, oldBase: Uom, newBase: Uom): string | undefined {
  if (fixedRatio(unit, newBase)) return undefined
  const ratio = fixedRatio(oldBase, newBase)
  if (!ratio) return undefined
  return decimalText(roundTo(decimalOf(oldFactor).times(ratio), { scale: FACTOR_SCALE, rounding: 'HALF_UP' }))
}

/**
 * A cost per base unit when the base unit moves from `oldBase` to `newBase`: the cost of one new base unit (rounded
 * half up to COST_SCALE), or null when the two bases share no fixed ratio (a cost per kg says nothing per metre).
 */
export function carriedCost(costPerOldBase: DecimalInput, oldBase: Uom, newBase: Uom): string | null {
  const ratio = fixedRatio(newBase, oldBase)
  if (!ratio) return null
  return decimalText(roundTo(decimalOf(costPerOldBase, 'standardCost').times(ratio), { scale: COST_SCALE, rounding: 'HALF_UP' }))
}
