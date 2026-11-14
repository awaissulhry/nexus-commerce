import { Decimal } from 'decimal.js'
import type { RevisionStatus } from '../../product/styles/revisions'
import { MAX_BOM_LEVELS, outputBatches, subAssemblyColourway, subAssemblySize, type SubAssemblyTarget } from '../../product/bom-structure/rules'
import type { ItemUnits } from '../../product/units/units'
import { six } from '../sheet-components/rules'

/**
 * The multi-level cost roll-up (B-W2b-423; FIN-019, follow-up KS4:02 "the roll-up reads the multi-level BOM, not one level"),
 * pure. A BOM line that takes a sub-assembly (B-W2b-223: an armour insert, a removable liner, a hump, a kit sold as a SET) is
 * costed at what the sub-assembly itself costs: its own cost sheet components (B-W2b-418: its materials and leather, its
 * labour or piece rates, its outside operations, freight and duty, overhead; never the packaging master's: it ships inside
 * the garment), each of its own sub-assemblies rolled up the same way, down to MAX_BOM_LEVELS levels. W1's single level
 * costed such a line at the component's standard purchase price.
 *
 *   one output batch     the sub-assembly's components total for its size (the parent's size by the same code, else its
 *                        only size) in its colourway (the parent's colourway code, else its only active one): its BOM
 *                        quantities are per `outputQuantity` units of `outputUom` (B-W2b-211)
 *   per base unit        that total × the output batches one base unit of the component is (`outputBatches`), rounded once
 *                        to 6 places: the line is then an ordinary MATERIAL line of the component (quantity in its base unit
 *                        × this unit cost), so freight, duty and the overhead percent are never counted on it twice
 *
 * What cannot be rolled up (no size or colourway serves the parent, units that do not convert, an incomplete sub-assembly,
 * too many levels) is a missing input in words for that size, never a guess and never the standard price instead.
 */

export const ROLLUP_PROBLEMS = ['SIZE', 'COLOURWAY', 'UNIT', 'INCOMPLETE', 'TOO_DEEP', 'NOT_READ'] as const
export type RollupProblem = (typeof ROLLUP_PROBLEMS)[number]

/** One size of a sub-assembly as costed: its components' total for one output batch, by category. */
export interface SubSizeCost {
  readonly size: string
  readonly categories: readonly { readonly category: string; readonly amount: string }[]
  readonly knownTotal: string
  /** null while an input is missing. */
  readonly total: string | null
  /** The missing inputs of that size, in words. */
  readonly missing: readonly string[]
}

export type RolledSize =
  | { readonly ok: true; readonly subSize: string; readonly batchesPerBaseUnit: string; readonly perBatch: string; readonly perBaseUnit: string }
  | { readonly ok: false; readonly code: RollupProblem; readonly message: string }

/** A sub-assembly line of a revision, costed per size of the parent's range. */
export interface RolledLine {
  readonly lineId: string
  readonly seq: number
  readonly target: { readonly styleId: string; readonly code: string; readonly revisionId: string; readonly revision: number; readonly status: RevisionStatus }
  /** The sub-assembly colourway that serves the parent's (null: none). */
  readonly colourway: { readonly id: string; readonly code: string } | null
  /** Per parent size. */
  readonly bySize: ReadonlyMap<string, RolledSize>
  /** The words a sheet line of it carries (never a figure). */
  readonly note: string
}

export interface RolledLineInput {
  readonly line: { readonly id: string; readonly seq: number; readonly uom: string; readonly itemCode: string }
  /** The component's units (the line's material). */
  readonly units: ItemUnits
  readonly target: SubAssemblyTarget
  readonly parentSizes: readonly string[]
  readonly parentColourwayCode: string
  /** The sub-assembly's cost per its own size; null when it was not costed (`notCosted` says why). */
  readonly costs: ReadonlyMap<string, SubSizeCost> | null
  readonly notCosted?: { readonly code: RollupProblem; readonly message: string } | undefined
}

/** The parent's colourway and level a sub-assembly is costed at, or why it is not (before anything is read for it). */
export function subColourwayOf(target: Pick<SubAssemblyTarget, 'colourways'>, parentColourwayCode: string): { readonly id: string; readonly code: string } | null {
  return subAssemblyColourway(parentColourwayCode, target)
}

export const tooDeep = (level: number): boolean => level > MAX_BOM_LEVELS

/** The words of a sub-assembly that cannot be costed at a level (no figure). */
export function notCostedWords(code: RollupProblem, line: RolledLineInput['line'], target: Pick<SubAssemblyTarget, 'code' | 'revision'>, extra = ''): string {
  const part = `${target.code} revision ${target.revision}`
  const name = `BOM line ${line.seq} (${line.itemCode})`
  switch (code) {
    case 'SIZE':
      return `${name}: ${part} has no size for size ${extra}: it cannot be rolled up for that size.`
    case 'COLOURWAY':
      return `${name}: ${part} has no colourway for ${extra}: give it one of the same code, or only one active colourway.`
    case 'UNIT':
      return `${name}: its unit does not convert to what ${part} makes: it cannot be rolled up.`
    case 'INCOMPLETE':
      return `${name}: ${part} is not completely costed for size ${extra}: complete its own cost first.`
    case 'TOO_DEEP':
      return `${name}: ${part} is more than ${MAX_BOM_LEVELS} levels down: it is not rolled up.`
    case 'NOT_READ':
      return `${name}: ${part} could not be read.`
  }
}

/** The sub-assembly line costed in every size of the parent's range. */
export function rolledLineOf(input: RolledLineInput): RolledLine {
  const { line, target } = input
  const colourway = subColourwayOf(target, input.parentColourwayCode)
  const perUnit = outputBatches(line.uom as Parameters<typeof outputBatches>[0], input.units, target)
  const perBase = outputBatches(input.units.baseUom, input.units, target)
  const bySize = new Map<string, RolledSize>()
  for (const size of input.parentSizes) {
    if (input.notCosted) {
      bySize.set(size, { ok: false, code: input.notCosted.code, message: input.notCosted.message })
      continue
    }
    if (colourway === null) {
      bySize.set(size, { ok: false, code: 'COLOURWAY', message: notCostedWords('COLOURWAY', line, target, input.parentColourwayCode) })
      continue
    }
    if (perUnit === null || perBase === null) {
      bySize.set(size, { ok: false, code: 'UNIT', message: notCostedWords('UNIT', line, target) })
      continue
    }
    const subSize = subAssemblySize(size, target)
    if (subSize === null) {
      bySize.set(size, { ok: false, code: 'SIZE', message: notCostedWords('SIZE', line, target, size) })
      continue
    }
    const cost = input.costs?.get(subSize)
    if (!cost) {
      bySize.set(size, { ok: false, code: 'NOT_READ', message: notCostedWords('NOT_READ', line, target) })
      continue
    }
    if (cost.total === null) {
      bySize.set(size, { ok: false, code: 'INCOMPLETE', message: notCostedWords('INCOMPLETE', line, target, subSize) })
      continue
    }
    bySize.set(size, { ok: true, subSize, batchesPerBaseUnit: six(perBase), perBatch: cost.total, perBaseUnit: six(new Decimal(cost.total).times(perBase)) })
  }
  return {
    lineId: line.id,
    seq: line.seq,
    target: { styleId: target.styleId, code: target.code, revisionId: target.revisionId, revision: target.revision, status: target.status },
    colourway,
    bySize,
    note: `Rolled up from the sub-assembly ${target.code} revision ${target.revision}${colourway ? ` (colourway ${colourway.code})` : ''}: its own materials, labour, outside operations and overhead per output batch, its own sub-assemblies included.`,
  }
}

/** The parent's line quantity in base units for one size (the line's gross need), as the roll-up's tree shows it. */
export const batchesOf = (base: Decimal, size: RolledSize): string | null => (size.ok ? new Decimal(base).times(size.batchesPerBaseUnit).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toString() : null)
