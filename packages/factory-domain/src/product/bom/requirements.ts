import type { Decimal } from 'decimal.js'
import { baseFactor, decimalOf, decimalText, roundTo, type DecimalInput, type ItemUnits, type RoundTo, type Uom } from '../units/units'
import type { BomLineData, BomLineFields } from './rules'

/**
 * What a BOM asks for (features PRD-079, PRD-082, PRD-100), pure: per garment of one size in one colourway, in each
 * material's base (stock) unit. The cost sheet (B-W1-16) prices it, material planning multiplies it by the order's
 * size grid.
 *
 *   net     the line's quantity for the size (its one quantity, or the size's when size-dependent), in its unit
 *   gross   net × (1 + wastage ÷ 100): what is cut or issued, waste and the hide's yield included
 *   base    gross in the material's base unit (units module: the exact ratio inside a dimension, else the material's
 *           own factor)
 *
 * Everything is exact (decimal.js) until the one rounding the caller names: a screen rounds each figure HALF_UP to
 * QUANTITY_SCALE, a purchase need rounds UP; sums are taken exactly and rounded once at the end. A line without a
 * quantity for a size, or without a colour for a colourway of a colour-dependent line, asks for nothing there: the
 * release check (./rules bomIssues) reports it, never this math.
 */

/** Before wastage, in the line's unit: null when a size-dependent line has no quantity for the size. */
export function netQuantity(line: Pick<BomLineFields, 'sizeDependent' | 'qty' | 'sizes'>, size: string): Decimal | null {
  if (!line.sizeDependent) return decimalOf(line.qty)
  const row = line.sizes.find((entry) => entry.size === size)
  return row ? decimalOf(row.qty) : null
}

/** quantity × (1 + wastage ÷ 100), exact. */
export function withWastage(quantity: DecimalInput, wastagePct: DecimalInput): Decimal {
  return decimalOf(quantity).times(decimalOf(wastagePct, 'wastagePct').div(100).plus(1))
}

export interface LineNeed {
  readonly net: Decimal
  readonly gross: Decimal
  /** In the material's base unit. */
  readonly base: Decimal
}

/** What one garment of this size takes of the line, exact; null without a quantity for the size or a unit the material converts. */
export function lineNeed(line: Pick<BomLineFields, 'sizeDependent' | 'qty' | 'sizes' | 'wastagePct' | 'uom'>, size: string, units: ItemUnits): LineNeed | null {
  const net = netQuantity(line, size)
  const factor = baseFactor(line.uom, units)
  if (net === null || factor === null) return null
  const gross = withWastage(net, line.wastagePct)
  return { net, gross, base: gross.times(factor) }
}

/** The line's figures for each size of the range, rounded as the caller says (decimal text; null where it has none). */
export function lineBySize(
  line: Pick<BomLineFields, 'sizeDependent' | 'qty' | 'sizes' | 'wastagePct' | 'uom'>,
  sizes: readonly string[],
  units: ItemUnits,
  round: RoundTo,
): { size: string; qty: string | null; gross: string | null; base: string | null }[] {
  return sizes.map((size) => {
    const need = lineNeed(line, size, units)
    const net = netQuantity(line, size)
    return {
      size,
      qty: net === null ? null : decimalText(net),
      gross: need === null ? null : decimalText(roundTo(need.gross, round)),
      base: need === null ? null : decimalText(roundTo(need.base, round)),
    }
  })
}

/**
 * The material colour the line uses in a colourway: undefined when the line is not used there (another colourway's
 * line, or no grid cell); null when the material has no colour on the line.
 */
export function colourIn(line: Pick<BomLineFields, 'colourwayId' | 'colourDependent' | 'itemColourId' | 'colours'>, colourwayId: string): string | null | undefined {
  if (line.colourwayId !== null && line.colourwayId !== colourwayId) return undefined
  if (!line.colourDependent) return line.itemColourId
  return line.colours.find((cell) => cell.colourwayId === colourwayId)?.itemColourId
}

export interface Requirement<Quantity> {
  readonly colourwayId: string
  readonly size: string
  readonly itemId: string
  readonly itemColourId: string | null
  /** The material's base unit. */
  readonly uom: Uom
  /** Per garment, in `uom`, waste included: every line of the material in that colour, summed. */
  readonly quantity: Quantity
  readonly lineIds: readonly string[]
}

/**
 * Every material (in its colour) one garment of each size in each colourway needs, exact: colourways and sizes in the
 * order given, materials in the order their first line comes in the BOM. A size of 0 asks for nothing, so it is left out.
 */
export function exactRequirements(
  lines: readonly BomLineData[],
  style: { readonly sizes: readonly string[]; readonly colourwayIds: readonly string[] },
  unitsOf: (itemId: string) => ItemUnits | undefined,
): Requirement<Decimal>[] {
  const ordered = [...lines].sort((a, b) => a.seq - b.seq)
  const materialOrder = new Map<string, number>()
  for (const line of ordered) if (!materialOrder.has(line.itemId)) materialOrder.set(line.itemId, materialOrder.size)
  const out: { key: string; colourway: number; material: number; size: number; row: { -readonly [K in keyof Requirement<Decimal>]: Requirement<Decimal>[K] } }[] = []
  const byKey = new Map<string, (typeof out)[number]>()
  style.colourwayIds.forEach((colourwayId, colourwayIndex) => {
    style.sizes.forEach((size, sizeIndex) => {
      for (const line of ordered) {
        const units = unitsOf(line.itemId)
        const itemColourId = colourIn(line, colourwayId)
        if (!units || itemColourId === undefined) continue
        const need = lineNeed(line, size, units)
        if (need === null || need.base.isZero()) continue
        const key = `${colourwayId}\u0000${size}\u0000${line.itemId}\u0000${itemColourId ?? ''}`
        const entry = byKey.get(key)
        if (entry) {
          entry.row.quantity = entry.row.quantity.plus(need.base)
          entry.row.lineIds = [...entry.row.lineIds, line.id]
        } else {
          const created = {
            key,
            colourway: colourwayIndex,
            material: materialOrder.get(line.itemId) ?? 0,
            size: sizeIndex,
            row: { colourwayId, size, itemId: line.itemId, itemColourId, uom: units.baseUom, quantity: need.base, lineIds: [line.id] },
          }
          byKey.set(key, created)
          out.push(created)
        }
      }
    })
  })
  return out.sort((a, b) => a.colourway - b.colourway || a.material - b.material || a.size - b.size).map((entry) => entry.row)
}

/** The same, each quantity rounded once as the caller says (decimal text). */
export function requirements(
  lines: readonly BomLineData[],
  style: { readonly sizes: readonly string[]; readonly colourwayIds: readonly string[] },
  unitsOf: (itemId: string) => ItemUnits | undefined,
  round: RoundTo,
): Requirement<string>[] {
  return exactRequirements(lines, style, unitsOf).map((row) => ({ ...row, quantity: decimalText(roundTo(row.quantity, round)) }))
}
