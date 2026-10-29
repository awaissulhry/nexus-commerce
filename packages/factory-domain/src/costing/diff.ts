import type { Decimal } from 'decimal.js'
import { asMoney } from '../money/marked'
import { MINUTES_ROUND } from '../product/routing/minutes'
import { decimalOf, decimalText, QUANTITY_SCALE, roundTo } from '../product/units/units'
import type { CellDiffView } from './contracts'
import { shownCost, type ExactCell } from './sheet'

/**
 * Two revisions' cost sheets compared (FIN-014's compare, thin; the Cost tab's "change against the last released
 * revision"), pure: cell by cell (colourway × size), each side's figures and, when both sides are known, the change
 * (to − from), with the materials and kinds of work centre whose quantity, minutes or cost moved. Both sheets are
 * priced with the same inputs (today's standard prices and rates), so a change comes from the BOM or the routing.
 * Every change is computed from exact values and rounded once; a change is null when either side is not known.
 */

const QUANTITY_ROUND = { scale: QUANTITY_SCALE, rounding: 'HALF_UP' } as const
const sumKnown = (values: readonly (Decimal | null)[]): Decimal | null =>
  values.some((value) => value === null) ? null : values.reduce<Decimal>((sum, value) => sum.plus(value!), decimalOf('0'))
const cost = (value: Decimal | null) => asMoney('cost', value === null ? null : shownCost(value))
const change = (from: Decimal | null, to: Decimal | null) => cost(from === null || to === null ? null : to.minus(from))

function summary(cell: ExactCell) {
  const complete = cell.missing.length === 0
  return {
    complete,
    materialCost: asMoney('cost', shownCost(cell.material)),
    labourCost: asMoney('cost', shownCost(cell.labourCost)),
    overheadCost: cost(cell.overhead?.amount ?? null),
    knownTotal: asMoney('cost', shownCost(cell.knownTotal)),
    total: cost(complete ? cell.knownTotal : null),
  }
}

/** Per material of a cell: its base quantity and cost, summed over its lines (null when any line's is unknown). */
function materialsOf(cell: ExactCell): Map<string, { code: string; base: Decimal | null; amount: Decimal | null }> {
  const out = new Map<string, { code: string; parts: { base: Decimal | null; amount: Decimal | null }[] }>()
  for (const part of cell.materials) {
    const entry = out.get(part.material.id) ?? { code: part.material.code, parts: [] }
    entry.parts.push({ base: part.base, amount: part.amount })
    out.set(part.material.id, entry)
  }
  return new Map(
    [...out].map(([itemId, entry]) => [itemId, { code: entry.code, base: sumKnown(entry.parts.map((part) => part.base)), amount: sumKnown(entry.parts.map((part) => part.amount)) }]),
  )
}

const quantityText = (value: Decimal | null): string | null => (value === null ? null : decimalText(roundTo(value, QUANTITY_ROUND)))
const minutesText = (value: Decimal): string => decimalText(roundTo(value, MINUTES_ROUND))

const sameSummary = (a: ReturnType<typeof summary>, b: ReturnType<typeof summary>): boolean =>
  a.complete === b.complete && a.materialCost === b.materialCost && a.labourCost === b.labourCost && a.overheadCost === b.overheadCost && a.knownTotal === b.knownTotal

/** The cells that differ (in `to`'s order, then those only `from` has) and how many are the same. */
export function diffCostCells(fromCells: readonly ExactCell[], toCells: readonly ExactCell[]): { cells: CellDiffView[]; unchanged: number } {
  const key = (cell: ExactCell) => `${cell.colourwayId}\u0000${cell.size}`
  const fromBy = new Map(fromCells.map((cell) => [key(cell), cell]))
  const toKeys = new Set(toCells.map(key))
  const pairs: [ExactCell | undefined, ExactCell | undefined][] = [...toCells.map((cell): [ExactCell | undefined, ExactCell] => [fromBy.get(key(cell)), cell]), ...fromCells.filter((cell) => !toKeys.has(key(cell))).map((cell): [ExactCell, undefined] => [cell, undefined])]

  const cells: CellDiffView[] = []
  let unchanged = 0
  for (const [from, to] of pairs) {
    const cell = (to ?? from)!
    const fromSummary = from ? summary(from) : null
    const toSummary = to ? summary(to) : null

    const fromMaterials = from ? materialsOf(from) : new Map()
    const toMaterials = to ? materialsOf(to) : new Map()
    const materials = [...new Set([...toMaterials.keys(), ...fromMaterials.keys()])].flatMap((itemId) => {
      const a = fromMaterials.get(itemId)
      const b = toMaterials.get(itemId)
      const side = (entry: typeof a) => (entry ? { baseQuantity: quantityText(entry.base), materialCost: cost(entry.amount) } : null)
      const left = side(a)
      const right = side(b)
      if (left && right && left.baseQuantity === right.baseQuantity && left.materialCost === right.materialCost) return []
      return [{ itemId, code: (b ?? a)!.code, from: left, to: right }]
    })

    const kinds = [...new Set([...(to?.labour ?? []), ...(from?.labour ?? [])].map((part) => part.workCentreKind))]
    const labour = kinds.flatMap((workCentreKind) => {
      const side = (part: ExactCell['labour'][number] | undefined) => (part ? { minutes: minutesText(part.minutes), labourCost: cost(part.amount) } : null)
      const left = side(from?.labour.find((part) => part.workCentreKind === workCentreKind))
      const right = side(to?.labour.find((part) => part.workCentreKind === workCentreKind))
      if (left && right && left.minutes === right.minutes && left.labourCost === right.labourCost) return []
      return [{ workCentreKind, from: left, to: right }]
    })

    if (fromSummary && toSummary && sameSummary(fromSummary, toSummary) && materials.length === 0 && labour.length === 0) {
      unchanged += 1
      continue
    }
    const both = from !== undefined && to !== undefined
    cells.push({
      colourwayId: cell.colourwayId,
      size: cell.size,
      from: fromSummary,
      to: toSummary,
      materialCostChange: change(both && from.materialComplete ? from.material : null, both && to.materialComplete ? to.material : null),
      labourCostChange: change(both && from.labourComplete ? from.labourCost : null, both && to.labourComplete ? to.labourCost : null),
      overheadCostChange: change(both && fromSummary!.complete ? (from.overhead?.amount ?? null) : null, both && toSummary!.complete ? (to.overhead?.amount ?? null) : null),
      totalChange: change(both && fromSummary!.complete ? from.knownTotal : null, both && toSummary!.complete ? to.knownTotal : null),
      materials,
      labour,
    })
  }
  return { cells, unchanged }
}
