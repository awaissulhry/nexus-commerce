import { defineManifest } from '../../../core/manifest'

/**
 * Hide yield (B-W2a-13; MES-057): office reads only. A work order's yield with workorders.view (its Cutting tab), the
 * cutting room's across work orders with production.cutting.view (the Cutting page's Yield). Handlers check the work
 * order with can() and filter with scopeWhere() (`record`).
 */
export const manifest = defineManifest({
  'GET /production/yield': { audiences: ['office'], permission: 'production.cutting.view', scope: 'record' },
  'GET /production/yield/work-orders/:workOrderId': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
})
