import type { WorkOrderCost } from '../../../finance/costing/api'
import type { CostingCan } from '../../../finance/costing/model'
import type { OffStandardMinutes } from './api'

/**
 * B-W2a-72 — the work order's Labour & cost tab (design production.workorders rec:labour; W2a: its Cost section): the
 * cost of the work order from the cost ledger — planned · actual · variance · per garment per part, the bridge, the
 * materials issued (a line → its stock movements), labour per operation at the standard minutes earned × the cost per
 * minute. The whole section needs the cost grain; never wages, never a person (Statuto dei Lavoratori art. 4). The Minutes
 * chart (wo-minutes) is W2b; B-W2b-81: its off-standard minutes per state and code, which need no cost grain.
 */
export interface LabourModel {
  readonly can: CostingCan
  /** The cost read (null: not asked — no costing.view, a draft, or the tab is not open). */
  readonly part: { readonly value: WorkOrderCost | null; readonly problem: string | null } | null
  /** Off-standard minutes (B-W2b-81). `held`: the person does not hold production.offstandard.view; null: not asked (a draft, the tab not open). */
  readonly offStandard?: { readonly value: OffStandardMinutes | null; readonly problem: string | null; readonly held?: boolean } | null
}
