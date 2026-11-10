import { defineManifest } from '../../../core/manifest'

/**
 * Sample rounds (B-W2b-246; SAL-311, SAL-316, MES-018; design products.samples SCR-110). Office only: each route asks
 * sales.samples.* and checks the round with can() over its company and customer (`record`). Making a sample work order also asks
 * W1's workorders.manage at the making site, inside W1's own create.
 */
const view = { audiences: ['office'], permission: 'sales.samples.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'sales.samples.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /sales/samples/rounds': view,
  'GET /sales/samples/rounds/:roundId': view,
  'POST /sales/samples/rounds': manage,
  'PATCH /sales/samples/rounds/:roundId': manage,
  'POST /sales/samples/rounds/:roundId/move': manage,
  'POST /sales/samples/rounds/:roundId/cancel': manage,
  'GET /sales/samples/rounds/:roundId/work-order-options': view,
  'POST /sales/samples/rounds/:roundId/work-orders': manage,
  'POST /sales/samples/rounds/:roundId/shipments': manage,
  'PATCH /sales/samples/shipments/:shipmentId': manage,
  'DELETE /sales/samples/shipments/:shipmentId': manage,
})
