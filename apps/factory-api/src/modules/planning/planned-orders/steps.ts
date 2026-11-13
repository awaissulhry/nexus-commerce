import type { OpenCell, PeggedDemand } from '@nexus/factory-domain/planning/planned-orders/rules'
import { stepIsFor, type CellFacts } from '@nexus/factory-domain/product/routing-depth/rules'
import { variantsOf, type StepColumns } from '../capacity/steps'
import type { Reader } from '../store'

/**
 * Only the steps a cell is for, in planned work (B-W2b-365; follow-up of B-W2b-F40; B-W2b-225's PRD-128). A work order made
 * from a planned order keeps a routing step only for some sizes, colourways or options when one of its cells is one of them
 * (the release, production/work-orders routing-copy), so the plan reads the routing the same way:
 *
 *   pass      ./pass: the outside work a planned order sends (its workshop and steps) and its in-house lead time come from
 *             the steps its cells are for (each order line and size it pegs, with the options chosen on the line)
 *   convert   ./convert: the steps a planned subcontract order sends, as the preview lists them
 *   capacity  ../subcontract-capacity/store: a planned subcontract order books its workshop for the garments of the cells
 *             each step it sends is for
 *
 * A cell's options are the order line's chosen values (SalesOrderLineOption), as a work order's cell copies them
 * (sales/configurator copy `optionValueIdsOf`).
 */

/** The options chosen on each order line (its values, in the order chosen). */
export async function lineOptionsOf(db: Reader, orderLineIds: readonly string[]): Promise<Map<string, string[]>> {
  const ids = [...new Set(orderLineIds)]
  if (ids.length === 0) return new Map()
  const rows = await db.salesOrderLineOption.findMany({ where: { lineId: { in: ids } }, select: { lineId: true, valueId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const out = new Map<string, string[]>()
  for (const row of rows) {
    const values = out.get(row.lineId) ?? []
    if (!values.includes(row.valueId)) values.push(row.valueId)
    out.set(row.lineId, values)
  }
  return out
}

/** The cells of open demand (an order line's size), with the line's chosen options. */
export const cellsOfOpen = (cells: readonly OpenCell[], options: ReadonlyMap<string, readonly string[]>): CellFacts[] =>
  cells.map((cell) => ({ colourwayId: cell.line.colourwayId, size: cell.size, optionValueIds: options.get(cell.line.orderLineId) ?? [] }))

/** The cells a planned order pegs (its colourway; each order line's size), with the lines' chosen options. */
export const cellsOfDemand = (colourwayId: string, demand: readonly Pick<PeggedDemand, 'orderLineId' | 'size'>[], options: ReadonlyMap<string, readonly string[]>): CellFacts[] =>
  demand.map((entry) => ({ colourwayId, size: entry.size, optionValueIds: options.get(entry.orderLineId) ?? [] }))

/** The routing steps one of the cells is for (every step when no cell is known, as a work order's copy). */
export function stepsForCells<Step extends StepColumns>(steps: readonly Step[], cells: readonly CellFacts[]): Step[] {
  if (cells.length === 0) return [...steps]
  return steps.filter((step) => cells.some((cell) => stepIsFor(variantsOf(step)!, cell)))
}
