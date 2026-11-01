import { defineManifest } from '../../../core/manifest'

/**
 * The office's work orders (B-W1-38; A2 SCR-069, SCR-070): office only (a floor, portal or link session is refused by
 * audience; the floor reads its own site's work orders through its own screens, B-W1-39, 40, 42). A work order belongs
 * to a company and a site, so the handlers check each record with can() and filter the list with scopeWhere()
 * (`record`).
 */
export const manifest = defineManifest({
  'GET /production/work-orders': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
  'GET /production/work-orders/counts': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
  'GET /production/work-orders/open-lines': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
  // B-W2a-46: the readiness word of many work orders (the list's column), each checked on its company and site.
  'GET /production/work-orders/readiness': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
  'GET /production/work-orders/:workOrderId': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
  'GET /production/work-orders/:workOrderId/release-check': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
  'GET /production/work-orders/:workOrderId/spec/compare': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
  'POST /production/work-orders': { audiences: ['office'], permission: 'workorders.manage', scope: 'record' },
  'PATCH /production/work-orders/:workOrderId': { audiences: ['office'], permission: 'workorders.manage', scope: 'record' },
  'PUT /production/work-orders/:workOrderId/cells': { audiences: ['office'], permission: 'workorders.manage', scope: 'record' },
  'POST /production/work-orders/:workOrderId/release': { audiences: ['office'], permission: 'workorders.release', scope: 'record' },
  'POST /production/work-orders/:workOrderId/start': { audiences: ['office'], permission: 'workorders.manage', scope: 'record' },
  'POST /production/work-orders/:workOrderId/complete': { audiences: ['office'], permission: 'workorders.manage', scope: 'record' },
  'POST /production/work-orders/:workOrderId/close': { audiences: ['office'], permission: 'workorders.manage', scope: 'record' },
  'POST /production/work-orders/:workOrderId/cancel': { audiences: ['office'], permission: 'workorders.manage', scope: 'record' },
  // B-W2a-12 (MES-019): repair work orders, checked on the repair order's company and site.
  'GET /production/work-orders/repair-options': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
  'POST /production/work-orders/repairs': { audiences: ['office'], permission: 'workorders.manage', scope: 'record' },
  'PUT /production/work-orders/:workOrderId/repair-steps': { audiences: ['office'], permission: 'workorders.manage', scope: 'record' },
  // B-W2b-51 (MES-010, MES-014): split a DRAFT (preview and split), and the travellers (PDF).
  'POST /production/work-orders/:workOrderId/split/preview': { audiences: ['office'], permission: 'workorders.manage', scope: 'record' },
  'POST /production/work-orders/:workOrderId/split': { audiences: ['office'], permission: 'workorders.manage', scope: 'record' },
  'GET /production/work-orders/travellers': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
  'GET /production/work-orders/:workOrderId/traveller': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
})
