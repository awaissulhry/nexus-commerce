import { defineManifest } from '../../../core/manifest'

/**
 * Report finished to stock (B-W2a-12; GAP-003, MES-011): office only, on the work order record (a floor, portal or link
 * session is refused by audience). The handlers check the work order with can() (`record`): workorders.view to read the
 * pop-up, production.finish to report and to take a report back.
 */
export const manifest = defineManifest({
  'GET /production/work-orders/:workOrderId/finished': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
  'POST /production/work-orders/:workOrderId/finished': { audiences: ['office'], permission: 'production.finish', scope: 'record' },
  'POST /production/work-orders/:workOrderId/finished/:reportId/reverse': { audiences: ['office'], permission: 'production.finish', scope: 'record' },
})
