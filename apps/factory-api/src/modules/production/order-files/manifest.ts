import { defineManifest } from '../../../core/manifest'

/**
 * B-PR-44 (production plan L16, N1 "every order already has all its details in the PDF files or in the thread"): the files of
 * the orders a work order makes, office only (a floor, portal or link session is refused by audience). The route asks
 * workorders.view; the handlers check the work order with its company, site and customer (the brand wall, B-PR-03), then
 * files.read over each file's company AND its order's customer, and sales.measurements.view for body data (`record`).
 */
export const manifest = defineManifest({
  'GET /production/work-orders/:workOrderId/order-files': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
  'POST /production/work-orders/:workOrderId/order-files/:fileId/open': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
})
