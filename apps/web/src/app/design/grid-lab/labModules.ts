/**
 * The feature lab's module set: everything.
 *
 * The engine (`engine/modules.ts`) registers only what production surfaces use, so no shipped
 * route carries the 85-module wildcard or the AG Charts runtime. The lab exists to show every
 * feature, so it adds the wildcard on top — registration is additive and idempotent, and this
 * file is imported only by `/design/grid-lab`, which the import-boundary script allows.
 *
 * Sparklines and integrated charts are the two features that are NOT self-contained: both refuse
 * to initialise without an AG Charts runtime, and `AllEnterpriseModule` alone does not carry one.
 * `ag-charts-community` covers line/bar/area sparklines and the standard chart types.
 */
import { ModuleRegistry } from 'ag-grid-community'
import { AllEnterpriseModule } from 'ag-grid-enterprise'
import { AgChartsCommunityModule } from 'ag-charts-community'

import { registerGridModules } from '@/design-system/grid/modules'

let registered = false

export function registerLabModules(): void {
  if (registered) return
  registered = true
  registerGridModules()
  ModuleRegistry.registerModules([AllEnterpriseModule.with(AgChartsCommunityModule)])
}
