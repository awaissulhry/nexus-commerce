import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { arrivedContract, customerLabelContract, forwardContract, orderLegsContract, ourWarehousesContract, portalLabelContract } from './contract'
import { markArrived, officeLabel, orderLegs, ourWarehouses, sendOn } from './legs'
import { manifest } from './manifest'
import { portalLabel } from './portal'

/**
 * Our warehouse first (owb- order workflow, S3 ss1 steps 1.2 and 1.5): "It arrived at the warehouse", "Send on to the customer",
 * the customer's label (the office for it, or the customer in the portal), the legs of an order and the Our warehouses page.
 * Planning the leg is POST /shipping/shipments with `destination` (../shipments); its DDTs are ../ddt's.
 */
export default defineRoutes('shipping.warehouseLeg', manifest, async (app) => {
  app.get('/shipping/warehouse-legs', { schema: orderLegsContract }, async (request) => orderLegs(request, request.query))

  app.get('/shipping/our-warehouses', { schema: ourWarehousesContract }, async (request) => ourWarehouses(request))

  app.post('/shipping/shipments/:shipmentId/arrived', { schema: arrivedContract }, async (request) => markArrived(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)))

  app.post('/shipping/shipments/:shipmentId/forward', { schema: forwardContract }, async (request) => sendOn(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)))

  app.post('/shipping/shipments/:shipmentId/customer-label', { schema: customerLabelContract }, async (request) => officeLabel(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)))

  app.post('/portal/sales-orders/:orderId/shipments/:shipmentId/label', { schema: portalLabelContract }, async (request) =>
    portalLabel(app, request, request.params.orderId, request.params.shipmentId, request.body, idempotencyKeyFrom(request)),
  )
})
