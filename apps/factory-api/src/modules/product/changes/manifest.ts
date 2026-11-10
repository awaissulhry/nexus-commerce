import { defineManifest } from '../../../core/manifest'

/**
 * Change requests and change orders (B-W2b-226; PRD-169, PRD-170, PRD-175, PRD-259, MES-006; design products.changes,
 * floor.instructions "Report a spec problem", production.workorders "Change request"). Office routes ask product.changes.*
 * and check each record with can() over its company (`record`); writes that start or release the redline revision also ask
 * W1's BOM permissions inside. The floor reports with floor.work at the device's own site (every floor role).
 */
const view = { audiences: ['office'], permission: 'product.changes.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'product.changes.manage', scope: 'record' } as const
const floor = { audiences: ['floor'], permission: 'floor.work', scope: 'site' } as const

export const manifest = defineManifest({
  'GET /product/change-requests': view,
  'GET /product/change-requests/:changeRequestId': view,
  'POST /product/change-requests': { audiences: ['office'], permission: 'product.changes.request', scope: 'record' },
  'PATCH /product/change-requests/:changeRequestId': { audiences: ['office'], permission: 'product.changes.request', scope: 'record' },
  'POST /product/change-requests/:changeRequestId/move': manage,
  'GET /product/change-requests/work-orders/:workOrderId': view,
  'POST /product/floor/change-requests': floor,
  'POST /product/floor/change-requests/:changeRequestId/photos': floor,
  'POST /product/floor/change-requests/:changeRequestId/photos/:fileId/complete': floor,
  'GET /product/change-orders': view,
  'GET /product/change-orders/:changeOrderId': view,
  'POST /product/change-orders': manage,
  'PATCH /product/change-orders/:changeOrderId': manage,
  'PUT /product/change-orders/:changeOrderId/requests': manage,
  'POST /product/change-orders/:changeOrderId/lines': manage,
  'PATCH /product/change-orders/:changeOrderId/lines/:lineId': manage,
  'DELETE /product/change-orders/:changeOrderId/lines/:lineId': manage,
  'PUT /product/change-orders/:changeOrderId/work-in-progress': manage,
  'PUT /product/change-orders/:changeOrderId/approvers': manage,
  'POST /product/change-orders/:changeOrderId/draft-revision': manage,
  'POST /product/change-orders/:changeOrderId/submit': manage,
  'POST /product/change-orders/:changeOrderId/decide': { audiences: ['office'], permission: 'product.changes.approve', scope: 'record' },
  'POST /product/change-orders/:changeOrderId/cancel': manage,
  'POST /product/change-orders/:changeOrderId/release': manage,
})
