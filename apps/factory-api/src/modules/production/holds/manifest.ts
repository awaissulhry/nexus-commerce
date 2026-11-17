import { defineManifest } from '../../../core/manifest'

/**
 * B-PR-21 (production plan §5 "holds (one dialog)", 08-backend §4.5): the plain production hold on a work order, office only (a
 * floor, portal or link session is refused by audience; the floor sees a held work order through its status and reason, the
 * customer through its production state, B-PR-17/18). The handlers find each work order through the brand wall (B-PR-03) and
 * check the permission over its company, site and customer (`record`): workorders.view reads, workorders.hold places and lifts.
 */
export const manifest = defineManifest({
  'GET /production/work-orders/:workOrderId/holds': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
  'POST /production/work-orders/:workOrderId/holds': { audiences: ['office'], permission: 'workorders.hold', scope: 'record' },
  'POST /production/work-orders/:workOrderId/holds/:holdId/lift': { audiences: ['office'], permission: 'workorders.hold', scope: 'record' },
  // The list's Hold N with a production reason: one hold per work order, all or none.
  'POST /production/work-orders/holds': { audiences: ['office'], permission: 'workorders.hold', scope: 'record' },
})
