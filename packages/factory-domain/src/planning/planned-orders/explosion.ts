import type { Decimal } from 'decimal.js'
import { explodeExact, type ExplodeInput, type ExplodeLine, type ExplodeProblem, type ExplodeRevision } from '../../product/bom-structure/explode'
import { bomChanges, type EffectFacts } from '../../product/options/rules'
import { decimalOf, type ItemUnits, type Uom } from '../../product/units/units'
import type { GarmentNeed, PlanWarning } from '../explode'

/**
 * What one garment of an order line takes, for planning (B-W2b-293; follow-ups MR1:01, MR1:02; PLN-079), pure: B-W2b-223's
 * multi-level explosion (`explodeExact`: every sub-assembly walked to its materials) of the revision the order line plans
 * (its own, else the style's RELEASED one: PLN-089), configured by the options chosen on the line, in one size and the
 * line's colourway. W1 planned ONE level (a sub-assembly line was a part to make and nothing below it was bought).
 *
 *   options      a line only for an option value is taken when the line chose that value (none chosen: the garment
 *                without options); the chosen values' BOM effects then apply per size to the revision's own lines
 *                (B-W2b-229 `bomChanges`): BOM_REMOVE leaves the lines of its material out, BOM_REPLACE puts its material
 *                in their place (its quantity and unit when it has one, else the line's), BOM_ADD adds its material (its
 *                quantity for each size, else its one quantity)
 *   customer     a customer-supplied line (B-W2b-228) is never planned: no purchase, no cost (W1's rule, kept)
 *   phantom      a sub-assembly whose component is a PHANTOM at the site (ItemPlanning.phantom, PLN-079) is made and used
 *                at once, never stocked: it is no part to make, and its parts pass through to the garment's need. A kit
 *                (parts picked together, never assembled into stock) is a phantom too: mark its component phantom
 *   made parts   any other sub-assembly is a part we make (W1's MAKE line of its component, netted against its stock);
 *                what is below it is needed only for the pieces its own stock and supply do not cover: `shares` says, per
 *                order line, size and component, which share of the component is still to make (1 when none is known
 *                yet: ./multilevel finds them level by level)
 *
 * Exact (decimal.js), per garment, in each material's base unit; the run rounds once per order line and size (W1).
 */

/** The facts of one order line the explosion reads (./multilevel builds them per line). */
export interface GarmentSource {
  readonly top: ExplodeRevision
  readonly revisions: ReadonlyMap<string, ExplodeRevision>
  readonly unitsOf: (itemId: string) => ItemUnits | undefined
  readonly codeOf: (itemId: string) => string
  /** The option values chosen on the order line. */
  readonly chosen: ReadonlySet<string>
  /** The BOM effects of the chosen values (BOM_ADD, BOM_REPLACE, BOM_REMOVE; others are ignored here). */
  readonly effects: readonly EffectFacts[]
  /** A component that is a phantom at the site (its colour, null: any). */
  readonly isPhantom: (itemId: string, itemColourId: string | null) => boolean
  /** B-W2b-318 (PLN-081): a part's scrap and yield factor at the site (../lot-sizing/scrap); it multiplies what is below it. */
  readonly factorOf?: (itemId: string, itemColourId: string | null) => Decimal | null
}

/** Per order line, size and component (`shareKey`): the share of the component still to make, 0 to 1. */
export type Shares = ReadonlyMap<string, Decimal>

export const shareKey = (orderLineId: string, size: string, itemId: string, itemColourId: string | null): string => `${orderLineId}|${size}|${itemId}|${itemColourId ?? '-'}`

/** The id an effect-added line carries (never a BOM line's). */
export const effectLineId = (effectId: string): string => `option-effect:${effectId}`

/** The revision's own lines with the chosen values' BOM effects applied (the sub-assemblies below keep theirs). */
export function configuredRevision(top: ExplodeRevision, chosen: ReadonlySet<string>, effects: readonly EffectFacts[]): ExplodeRevision {
  const mine = effects.filter((effect) => chosen.has(effect.valueId) && (effect.kind === 'BOM_ADD' || effect.kind === 'BOM_REPLACE' || effect.kind === 'BOM_REMOVE'))
  if (mine.length === 0) return top
  const changes = bomChanges(
    top.lines.map((line) => ({ id: line.id, seq: line.seq, itemId: line.itemId, optionValueId: line.optionValueId })),
    chosen,
    mine,
  )
  const removed = new Set(changes.removed.map((entry) => entry.lineId))
  const replacedBy = new Map<string, EffectFacts>()
  for (const entry of changes.replaced) {
    const effect = mine.find((candidate) => candidate.id === entry.effectId)
    if (effect && !replacedBy.has(entry.lineId)) replacedBy.set(entry.lineId, effect)
  }
  const lines: ExplodeLine[] = []
  for (const line of top.lines) {
    if (removed.has(line.id)) continue
    const effect = replacedBy.get(line.id)
    if (!effect || effect.itemId === null) {
      lines.push(line)
      continue
    }
    // The material put in: its own quantity and unit when it has one, else the line's (per size as the line has it).
    lines.push({
      ...line,
      itemId: effect.itemId,
      colourDependent: false,
      itemColourId: effect.itemColourId,
      colours: [],
      subAssemblyRevisionId: null,
      ...(effect.qty !== null && effect.uom !== null ? { qty: effect.qty, uom: effect.uom as Uom, sizeDependent: false, sizes: [] } : {}),
    })
  }
  const lastSeq = top.lines.reduce((max, line) => Math.max(max, line.seq), 0)
  changes.added.forEach((effect, index) => {
    if (effect.itemId === null || effect.uom === null) return
    const perSize = effect.sizeQuantities
    const sizes = perSize === null ? [] : top.sizes.flatMap((size) => {
      const qty = perSize[size] ?? effect.qty
      return qty === null || qty === undefined ? [] : [{ size, qty }]
    })
    lines.push({
      id: effectLineId(effect.id),
      seq: lastSeq + 10 * (index + 1),
      itemId: effect.itemId,
      qty: effect.qty ?? '0',
      uom: effect.uom as Uom,
      wastagePct: '0',
      sizeDependent: perSize !== null,
      sizes,
      colourDependent: false,
      itemColourId: effect.itemColourId,
      colourwayId: null,
      colours: [],
      subAssemblyRevisionId: null,
      customerSupplied: false,
      issueToSubcontract: false,
      optionValueId: null,
    })
  })
  return { ...top, lines }
}

export interface GarmentNeeds {
  /** Every material and part to make one garment takes (per material and colour, summed; base unit; exact). */
  readonly needs: readonly GarmentNeed[]
  /** The made (not phantom) sub-assemblies of the garment, per component: their share keys come from these. */
  readonly components: readonly { readonly itemId: string; readonly itemColourId: string | null; readonly level: number }[]
  /** What could not be walked below the revision's own lines, in words (level 2 and deeper, or a sub-assembly line). */
  readonly problems: readonly ExplodeProblem[]
}

/** One garment of an order line in one size and its colourway, for the plan. */
export function garmentNeeds(source: GarmentSource, at: { readonly orderLineId: string; readonly size: string; readonly colourwayId: string; readonly colourwayCode: string }, shares: Shares): GarmentNeeds {
  const top = configuredRevision(source.top, source.chosen, source.effects)
  const input: ExplodeInput = { top, revisions: source.revisions, unitsOf: source.unitsOf, codeOf: source.codeOf, options: source.chosen }
  const explosion = explodeExact(input, { size: at.size, colourwayId: at.colourwayId, colourwayCode: at.colourwayCode })
  // The component each sub-assembly line of the walk names (a line of a revision names one material).
  const componentOf = new Map(explosion.subAssemblies.map((row) => [`${row.revisionId}|${row.lineId}`, { itemId: row.itemId, itemColourId: row.itemColourId }]))
  /** The product of the shares still to make of the made sub-assemblies above a row (phantoms pass everything through). */
  const multiplier = (via: readonly { readonly revisionId: string; readonly lineId: string }[]): Decimal => {
    let value = decimalOf('1')
    for (const step of via) {
      const component = componentOf.get(`${step.revisionId}|${step.lineId}`)
      // B-W2b-318 (PLN-081): a made part's (or a phantom's) scrap and yield take more of what is below it.
      const factor = component ? source.factorOf?.(component.itemId, component.itemColourId) : null
      if (factor) value = value.times(factor)
      if (!component || source.isPhantom(component.itemId, component.itemColourId)) continue
      const share = shares.get(shareKey(at.orderLineId, at.size, component.itemId, component.itemColourId))
      if (share) value = value.times(share)
    }
    return value
  }
  const totals = new Map<string, { itemId: string; itemColourId: string | null; quantity: Decimal; lineIds: string[] }>()
  const add = (row: { readonly itemId: string; readonly itemColourId: string | null; readonly quantity: Decimal; readonly lineId: string }, factor: Decimal) => {
    const quantity = row.quantity.times(factor)
    if (quantity.isZero()) return
    const key = `${row.itemId}|${row.itemColourId ?? '-'}`
    const entry = totals.get(key)
    if (entry) {
      entry.quantity = entry.quantity.plus(quantity)
      if (!entry.lineIds.includes(row.lineId)) entry.lineIds.push(row.lineId)
    } else {
      totals.set(key, { itemId: row.itemId, itemColourId: row.itemColourId, quantity, lineIds: [row.lineId] })
    }
  }
  // Rows in the walk's order (depth first): a made part before what is below it.
  for (const row of explosion.materials) if (!row.customerSupplied) add(row, multiplier(row.via))
  const components: { itemId: string; itemColourId: string | null; level: number }[] = []
  for (const row of explosion.subAssemblies) {
    if (row.customerSupplied || source.isPhantom(row.itemId, row.itemColourId)) continue
    add(row, multiplier(row.via))
    if (!components.some((entry) => entry.itemId === row.itemId && entry.itemColourId === row.itemColourId)) components.push({ itemId: row.itemId, itemColourId: row.itemColourId, level: row.level })
  }
  const problems = explosion.problems.filter((problem) => problem.level > 1 || (problem.code !== 'QUANTITY' && problem.code !== 'UNIT'))
  return { needs: [...totals.values()].map((entry) => ({ itemId: entry.itemId, itemColourId: entry.itemColourId, quantity: entry.quantity, lineIds: entry.lineIds })), components, problems }
}

/** An explosion problem as the run's warning (one per order line and problem). */
export function problemWarning(problem: ExplodeProblem, line: { readonly orderId: string; readonly orderNumber: string; readonly orderLineId: string; readonly lineSeq: number }, size: string): PlanWarning {
  return {
    code: 'SUB_ASSEMBLY',
    message: `${line.orderNumber} line ${line.lineSeq}, size ${size}: ${problem.message} What is below it is not planned.`,
    orderId: line.orderId,
    orderLineId: line.orderLineId,
    size,
  }
}
