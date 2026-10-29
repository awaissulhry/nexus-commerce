import type { FactoryClient } from '@nexus/factory-db'
import type { LabourRate, OverheadRule } from '@nexus/factory-domain/costing/inputs'
import type { CommandTx } from '../../core/command'

/**
 * Where the cost sheet's labour rates and overhead rules come from: one seam, so the sheet's math (factory-domain
 * costing) never knows where they are kept. `processCostingInputs()` is what the routes use; tests may swap it with
 * `useCostingInputs(source)` (and put the default back with `useCostingInputs(undefined)`).
 *
 * Until the costing tables exist, the default source has no rate and no overhead rule: every kind of work centre the
 * routing uses is listed as missing ("no cost per minute"), the sheet is not complete, and there is no overhead. Never a 0.
 */
export interface CostingInputSource {
  /** Every rate that may apply to a sheet for this company: the company's own and the tenant-wide ones (any day, any status). */
  labourRates(client: FactoryClient | CommandTx, companyId: string | null): Promise<LabourRate[]>
  /** The company's overhead rule and the tenant-wide one, when set. */
  overheadRules(client: FactoryClient | CommandTx, companyId: string | null): Promise<OverheadRule[]>
}

export const NO_COSTING_INPUTS: CostingInputSource = Object.freeze({
  labourRates: async () => [],
  overheadRules: async () => [],
})

let configured: CostingInputSource | undefined

export function useCostingInputs(source: CostingInputSource | undefined): void {
  configured = source
}

export function processCostingInputs(): CostingInputSource {
  return configured ?? NO_COSTING_INPUTS
}
