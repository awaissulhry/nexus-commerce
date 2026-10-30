import { defineRoutes } from '../../../core/manifest'
import { cuttingYieldContract, workOrderYieldContract } from './contract'
import { manifest } from './manifest'
import { cuttingYield, workOrderYield } from './views'

/**
 * Hide yield (B-W2a-13; MES-057, SCM-255; design production.cutting "Yield", the work order's Cutting tab "Yield"): per
 * hide the area in, the pattern area cut, the remnant and the waste; planned against actual per style and supplier lot.
 */
export default defineRoutes('production.yield', manifest, async (app) => {
  app.get('/production/yield', { schema: cuttingYieldContract }, async (request) => cuttingYield(request, request.query))
  app.get('/production/yield/work-orders/:workOrderId', { schema: workOrderYieldContract }, async (request) => workOrderYield(request, request.params.workOrderId))
})
