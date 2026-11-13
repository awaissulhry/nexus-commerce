import type { CellFacts } from '@nexus/factory-domain/product/routing-depth/rules'
import { optionLabelsOf } from '../options/offers'
import type { Db } from './store'

/**
 * The routing preview of a work order keeps its cells' options (B-W2b-365; follow-up of B-W2b-F40). A DRAFT work order's
 * GET /production/work-orders/:workOrderId/routing (./work-order.ts) shows what its release would copy: a step only for
 * some options is in the copy when one of its cells chose one of them (B-W2b-340: WorkOrderSize.optionValueIds, the order
 * line's picks; B-W2b-365: a sample work order's configuration), so the preview reads the same cell facts as the release
 * (production/work-orders facts.ts) and says the options by name ("Only for option SEED-OG-PERF: FRONT").
 */

/** A cell of the work order as the release reads it: its colourway, size and chosen options. */
export const previewCellFacts = (cells: readonly { readonly colourwayId: string; readonly size: string; readonly optionValueIds?: readonly string[] | undefined }[]): CellFacts[] =>
  cells.map((cell) => ({ colourwayId: cell.colourwayId, size: cell.size, optionValueIds: [...(cell.optionValueIds ?? [])] }))

/** "GROUP: VALUE" of every option the steps name (unknown: "?"), for the variants' words. */
export async function optionLabelOf(db: Db, steps: readonly { readonly appliesToOptionValueIds: readonly string[] }[]): Promise<(valueId: string) => string> {
  const labels = await optionLabelsOf(db, steps.flatMap((step) => step.appliesToOptionValueIds))
  return (valueId) => labels.get(valueId) ?? '?'
}
