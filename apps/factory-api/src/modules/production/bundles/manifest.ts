import { defineManifest } from '../../../core/manifest'

/**
 * Bundles and bundle tickets from a cut (B-W1-41; MES-065, MES-066, MES-068, MES-073, MES-184; A2 SCR-095, SCR-072): the
 * bundles step's reads for a floor device (its own site only: can() pins it, row-level security too) and the office
 * with production.bundles; the floor's make (with an Idempotency-Key), the reprint and void of a bundle for the floor
 * and the office; the office's bundles of a work order (workorders.view). Handlers check each work order with can() and
 * filter lists with scopeWhere() (`record`).
 */
export const manifest = defineManifest({
  'GET /production/bundles/work-orders': { audiences: ['office', 'floor'], permission: 'production.bundles', scope: 'record' },
  'GET /production/bundles/work-orders/:workOrderId': { audiences: ['office', 'floor'], permission: 'production.bundles', scope: 'record' },
  'POST /production/bundles/work-orders/:workOrderId/bundles': { audiences: ['floor'], permission: 'production.bundles', scope: 'record' },
  'GET /production/bundles/scan': { audiences: ['office', 'floor'], permission: 'production.bundles', scope: 'record' },
  'POST /production/bundles/:bundleId/reprint': { audiences: ['office', 'floor'], permission: 'production.bundles', scope: 'record' },
  'POST /production/bundles/:bundleId/void': { audiences: ['office', 'floor'], permission: 'production.bundles', scope: 'record' },
  'GET /production/bundles/work-orders/:workOrderId/bundles': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
})
