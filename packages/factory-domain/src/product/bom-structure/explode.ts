import type { Decimal } from 'decimal.js'
import type { BomLineFields } from '../bom/rules'
import { colourIn, lineNeed } from '../bom/requirements'
import { decimalOf, decimalText, roundTo, UNITS, type ItemUnits, type RoundTo, type Uom } from '../units/units'
import { MAX_BOM_LEVELS, outputBatches, subAssemblyColourway, subAssemblySize, type SubAssemblyTarget } from './rules'

/**
 * The multi-level BOM explosion (B-W2b-223; PRD-078), pure: what one output batch of a revision (its lines as written: per
 * `outputQuantity` units of `outputUom`, 1 PCS = one garment) takes in one size and one colourway, walking every
 * sub-assembly down to its materials. W1's per-line math (product/bom/requirements `lineNeed`, `colourIn`) at each level:
 *
 *   a line of a material      a MATERIAL row: the line's gross quantity (waste included) in the material's base unit, times
 *                             what the levels above ask for
 *   a sub-assembly line       a SUB_ASSEMBLY row (the component we make, in its base unit: planning makes it, a kit sends it
 *                             whole), and its own BOM exploded below it in the sub-assembly's size and colourway
 *                             (rules `subAssemblySize`, `subAssemblyColourway`) for `outputBatches` of its output per unit
 *   an option line            only when its option value is chosen (`options`); none chosen: the garment without options
 *
 * Planning (the component's own need), kits (`issueToSubcontract`, the customer's material) and cost (the leaves) read the
 * rows they need. A customer-supplied line is marked (no cost, no purchase). Everything stays exact (decimal.js) until the
 * caller's one rounding (`roundExplosion`). What cannot be walked (a size or colourway the sub-assembly lacks, units that
 * do not convert, a revision not read, a circle, more than MAX_BOM_LEVELS levels) is a problem in words, never a guess.
 */

export interface ExplodeLine
  extends Pick<BomLineFields, 'seq' | 'itemId' | 'qty' | 'uom' | 'wastagePct' | 'sizeDependent' | 'sizes' | 'colourDependent' | 'itemColourId' | 'colourwayId' | 'colours'> {
  readonly id: string
  readonly subAssemblyRevisionId: string | null
  readonly customerSupplied: boolean
  readonly issueToSubcontract: boolean
  readonly optionValueId: string | null
}

/** A revision as the explosion reads it: its style's range and colourways, its output and its lines. */
export interface ExplodeRevision extends SubAssemblyTarget {
  readonly lines: readonly ExplodeLine[]
}

/** One step down: the line that takes the sub-assembly, in the revision it belongs to, at that level's size and colourway. */
export interface ExplodeStep {
  readonly revisionId: string
  readonly lineId: string
  readonly seq: number
  readonly size: string
  readonly colourwayId: string
}

export interface ExplodedMaterial<Quantity> {
  /** 1: a line of the top revision; 2: a line of one of its sub-assemblies … */
  readonly level: number
  readonly revisionId: string
  readonly lineId: string
  readonly itemId: string
  readonly itemColourId: string | null
  /** The material's base unit. */
  readonly uom: Uom
  readonly quantity: Quantity
  readonly customerSupplied: boolean
  readonly issueToSubcontract: boolean
  /** The sub-assembly lines above it, top first (empty on level 1). */
  readonly via: readonly ExplodeStep[]
}

export interface ExplodedSubAssembly<Quantity> extends ExplodedMaterial<Quantity> {
  readonly styleId: string
  readonly code: string
  readonly subRevisionId: string
  readonly revision: number
  readonly status: SubAssemblyTarget['status']
  /** The sub-assembly's size and colourway that serve this one (null: none: a problem). */
  readonly size: string | null
  readonly colourwayId: string | null
  /** How many of its output batches are made for it (null: the units do not convert). */
  readonly batches: Quantity | null
}

export const EXPLODE_PROBLEMS = ['QUANTITY', 'NOT_READ', 'SIZE', 'COLOURWAY', 'UNIT', 'CIRCLE', 'TOO_DEEP'] as const
export type ExplodeProblemCode = (typeof EXPLODE_PROBLEMS)[number]

export interface ExplodeProblem {
  readonly code: ExplodeProblemCode
  readonly level: number
  readonly revisionId: string
  readonly lineId: string
  readonly message: string
}

export interface Explosion<Quantity> {
  readonly materials: readonly ExplodedMaterial<Quantity>[]
  readonly subAssemblies: readonly ExplodedSubAssembly<Quantity>[]
  readonly problems: readonly ExplodeProblem[]
}

export interface ExplodeInput {
  readonly top: ExplodeRevision
  /** Every sub-assembly revision below the top that was read, by id. */
  readonly revisions: ReadonlyMap<string, ExplodeRevision>
  readonly unitsOf: (itemId: string) => ItemUnits | undefined
  readonly codeOf: (itemId: string) => string
  /** The option values chosen (a line for another value is left out). */
  readonly options: ReadonlySet<string>
}

/** The explosion of one output batch of the top revision in one size and one of its colourways, exact. */
export function explodeExact(input: ExplodeInput, at: { readonly size: string; readonly colourwayId: string; readonly colourwayCode: string }): Explosion<Decimal> {
  const materials: ExplodedMaterial<Decimal>[] = []
  const subAssemblies: ExplodedSubAssembly<Decimal>[] = []
  const problems: ExplodeProblem[] = []

  const walk = (revision: ExplodeRevision, size: string, colourway: { id: string; code: string }, multiplier: Decimal, via: readonly ExplodeStep[], level: number): void => {
    for (const line of [...revision.lines].sort((a, b) => a.seq - b.seq)) {
      if (line.optionValueId !== null && !input.options.has(line.optionValueId)) continue
      const itemColourId = colourIn(line, colourway.id)
      if (itemColourId === undefined) continue
      const problem = (code: ExplodeProblemCode, message: string) => problems.push({ code, level, revisionId: revision.revisionId, lineId: line.id, message })
      const name = `${revision.code} line ${line.seq} (${input.codeOf(line.itemId)})`
      const units = input.unitsOf(line.itemId)
      if (!units) {
        problem('NOT_READ', `${name}: its material was not read.`)
        continue
      }
      const need = lineNeed(line, size, units)
      if (need === null) {
        if (line.sizeDependent && !line.sizes.some((row) => row.size === size)) problem('QUANTITY', `${name}: no quantity for size ${size}.`)
        else problem('UNIT', `${name}: ${input.codeOf(line.itemId)} does not convert ${UNITS[line.uom].symbol} to its base unit.`)
        continue
      }
      if (need.base.isZero()) continue
      const row = {
        level,
        revisionId: revision.revisionId,
        lineId: line.id,
        itemId: line.itemId,
        itemColourId,
        uom: units.baseUom,
        quantity: need.base.times(multiplier),
        customerSupplied: line.customerSupplied,
        issueToSubcontract: line.issueToSubcontract,
        via,
      }
      if (line.subAssemblyRevisionId === null) {
        materials.push(row)
        continue
      }
      const target = input.revisions.get(line.subAssemblyRevisionId)
      if (!target) {
        problem('NOT_READ', `${name}: its sub-assembly revision was not read.`)
        continue
      }
      const subSize = subAssemblySize(size, target)
      const subColourway = subAssemblyColourway(colourway.code, target)
      const perUnit = outputBatches(line.uom, units, target)
      const batches = perUnit === null ? null : need.gross.times(multiplier).times(perUnit)
      subAssemblies.push({
        ...row,
        styleId: target.styleId,
        code: target.code,
        subRevisionId: target.revisionId,
        revision: target.revision,
        status: target.status,
        size: subSize,
        colourwayId: subColourway?.id ?? null,
        batches,
      })
      const part = `${target.code} revision ${target.revision}`
      if (subSize === null) problem('SIZE', `${name}: ${part} has no size ${size}.`)
      if (subColourway === null) problem('COLOURWAY', `${name}: ${part} has no colourway for ${colourway.code}.`)
      if (batches === null) problem('UNIT', `${name}: ${UNITS[line.uom].symbol} does not convert to what ${part} makes (${target.outputQuantity} ${UNITS[target.outputUom].symbol}).`)
      if (subSize === null || subColourway === null || batches === null) continue
      if (target.revisionId === input.top.revisionId || via.some((step) => step.revisionId === target.revisionId)) {
        problem('CIRCLE', `${name}: ${part} is inside itself (a circle).`)
        continue
      }
      if (level + 1 > MAX_BOM_LEVELS) {
        problem('TOO_DEEP', `${name}: more than ${MAX_BOM_LEVELS} levels.`)
        continue
      }
      walk(target, subSize, subColourway, batches, [...via, { revisionId: revision.revisionId, lineId: line.id, seq: line.seq, size, colourwayId: colourway.id }], level + 1)
    }
  }

  walk(input.top, at.size, { id: at.colourwayId, code: at.colourwayCode }, decimalOf('1'), [], 1)
  return { materials, subAssemblies, problems }
}

export interface MaterialTotal<Quantity> {
  readonly itemId: string
  readonly itemColourId: string | null
  readonly uom: Uom
  readonly quantity: Quantity
  readonly customerSupplied: boolean
  /** The lowest and highest level it comes from. */
  readonly levels: readonly [number, number]
  readonly lineIds: readonly string[]
}

/** The materials of an explosion summed per material, colour and who supplies it (the order of their first row). */
export function materialTotals(explosion: Explosion<Decimal>): MaterialTotal<Decimal>[] {
  const totals = new Map<string, { -readonly [K in keyof MaterialTotal<Decimal>]: MaterialTotal<Decimal>[K] }>()
  for (const row of explosion.materials) {
    const key = `${row.itemId}\u0000${row.itemColourId ?? ''}\u0000${row.customerSupplied ? 'C' : 'O'}`
    const total = totals.get(key)
    if (total) {
      total.quantity = total.quantity.plus(row.quantity)
      total.levels = [Math.min(total.levels[0], row.level), Math.max(total.levels[1], row.level)]
      if (!total.lineIds.includes(row.lineId)) total.lineIds = [...total.lineIds, row.lineId]
    } else {
      totals.set(key, { itemId: row.itemId, itemColourId: row.itemColourId, uom: row.uom, quantity: row.quantity, customerSupplied: row.customerSupplied, levels: [row.level, row.level], lineIds: [row.lineId] })
    }
  }
  return [...totals.values()]
}

/** Each quantity rounded once, as the caller says (decimal text). */
export function roundExplosion(explosion: Explosion<Decimal>, round: RoundTo): Explosion<string> {
  const text = (value: Decimal) => decimalText(roundTo(value, round))
  return {
    materials: explosion.materials.map((row) => ({ ...row, quantity: text(row.quantity) })),
    subAssemblies: explosion.subAssemblies.map((row) => ({ ...row, quantity: text(row.quantity), batches: row.batches === null ? null : text(row.batches) })),
    problems: explosion.problems,
  }
}
