import type { WorkOrderCost } from '../../../finance/costing/api'
import type { CostingCan } from '../../../finance/costing/model'

/**
 * B-W2a-72 — the work order's Labour & cost tab (design production.workorders rec:labour; W2a: its Cost section): the
 * cost of the work order from the cost ledger — planned · actual · variance · per garment per part, the bridge, the
 * materials issued (a line → its stock movements), labour per operation at the standard minutes earned × the cost per
 * minute. The whole section needs the cost grain; never wages, never a person (Statuto dei Lavoratori art. 4). The Minutes
 * chart (wo-minutes) is W2b.
 */
export interface LabourModel {
  readonly can: CostingCan
  /** The cost read (null: not asked — no costing.view, a draft, or the tab is not open). */
  readonly part: { readonly value: WorkOrderCost | null; readonly problem: string | null } | null
}
