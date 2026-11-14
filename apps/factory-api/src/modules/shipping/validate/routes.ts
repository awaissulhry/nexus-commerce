import { defineRoutes } from '../../../core/manifest'
import { checkLabelsContract } from './contract'
import { manifest } from './manifest'
import { checkLabels } from './validate'

/**
 * Check every parcel before printing (B-W2b-390; LOG-045): the shipment's parcels without a label against their carrier's
 * rules, in words. A label buy refuses on the same rules (labels/labels.ts).
 */
export default defineRoutes('shipping.validate', manifest, async (app) => {
  app.get('/shipping/shipments/:shipmentId/labels/check', { schema: checkLabelsContract }, async (request) => checkLabels(request, request.params.shipmentId))
})
