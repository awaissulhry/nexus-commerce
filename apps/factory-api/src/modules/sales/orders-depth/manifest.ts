import { defineManifest } from '../../../core/manifest'

/**
 * Orders in depth (B-W2b-303; SAL-201, SAL-205, SAL-207, SAL-208). Office only; each handler checks the order with can() over
 * its company and customer (`record`). The yes on a waiting order is the approval engine's (POST /approvals/tasks/:id/approve,
 * kind SALES_ORDER); the sheet import is the imports engine's (importer `sales.orders`).
 */
const view = { audiences: ['office'], permission: 'orders.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'orders.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /sales/orders/depth': view,
  'GET /sales/orders/:orderId/depth': view,
  'PUT /sales/orders/:orderId/priority': manage,
  'POST /sales/orders/priority': manage,
  'POST /sales/orders/:orderId/split': manage,
  'GET /sales/orders/:orderId/approval': view,
  'POST /sales/orders/:orderId/approval': manage,
  'POST /sales/orders/:orderId/approval/withdraw': manage,
  'GET /sales/orders/:orderId/confirmation': view,
  'POST /sales/orders/:orderId/confirmation': manage,
  'POST /sales/orders/:orderId/confirmation/send': manage,
})
