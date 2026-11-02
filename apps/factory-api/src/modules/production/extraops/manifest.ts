import { defineManifest } from '../../../core/manifest'

/**
 * An unplanned operation (B-W2b-47; MES-086): the team leader on the tablet (at its own site) or the production office adds
 * one with production.extraops.add; the office reads them as part of the work order record (workorders.view). Handlers
 * check each work order with can().
 */
export const manifest = defineManifest({
  'GET /production/extra-operations/work-orders/:workOrderId': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
  'GET /production/extra-operations/work-orders/:workOrderId/choices': { audiences: ['office', 'floor'], permission: 'production.extraops.add', scope: 'record' },
  'POST /production/extra-operations/work-orders/:workOrderId': { audiences: ['office', 'floor'], permission: 'production.extraops.add', scope: 'record' },
})
