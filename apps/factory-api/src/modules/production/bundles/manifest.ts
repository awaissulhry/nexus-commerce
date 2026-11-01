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
  // W2a B-W2a-13 (MES-071).
  'POST /production/bundles/:bundleId/split': { audiences: ['office', 'floor'], permission: 'production.bundles', scope: 'record' },
  // W2b B-W2b-41: where every bundle is and the stuck ones (MES-074, MES-168), the bundle record (SCR-259), office only.
  'GET /production/bundles': { audiences: ['office'], permission: 'production.bundles.view', scope: 'record' },
  'GET /production/bundles/tiles': { audiences: ['office'], permission: 'production.bundles.view', scope: 'record' },
  'GET /production/bundles/stuck': { audiences: ['office'], permission: 'production.bundles.view', scope: 'record' },
  'GET /production/bundles/:bundleId': { audiences: ['office'], permission: 'production.bundles.view', scope: 'record' },
  // W2b B-W2b-41: coupons per operation (MES-067), floor and office.
  'POST /production/bundles/work-orders/:workOrderId/coupons': { audiences: ['office', 'floor'], permission: 'production.bundles', scope: 'record' },
  'POST /production/bundles/coupons/:couponId/reprint': { audiences: ['office', 'floor'], permission: 'production.bundles', scope: 'record' },
  'POST /production/bundles/coupons/:couponId/void': { audiences: ['office', 'floor'], permission: 'production.bundles', scope: 'record' },
  // W2b B-W2b-41: a site's bundle code mode and stuck limit (the floor rules' permissions).
  'GET /production/bundles/sites/:siteId/rules': { audiences: ['office'], permission: 'production.settings.view', scope: 'record' },
  'POST /production/bundles/sites/:siteId/rules': { audiences: ['office'], permission: 'production.settings.manage', scope: 'record' },
  // W2b B-W2b-41: scan-pattern checks (MES-075): counts and bundles; a review; the names behind ONE finding.
  'GET /production/bundles/findings/summary': { audiences: ['office'], permission: 'production.bundles.view', scope: 'record' },
  'GET /production/bundles/findings': { audiences: ['office'], permission: 'production.bundles.view', scope: 'record' },
  'POST /production/bundles/findings/:findingId/review': { audiences: ['office'], permission: 'production.bundles.findings', scope: 'record' },
  'POST /production/bundles/findings/:findingId/who': { audiences: ['office'], permission: 'production.bundles.who', scope: 'record' },
  // W2b B-W2b-41: pair and set matching by shade (MES-078), floor and office.
  'GET /production/bundles/work-orders/:workOrderId/sets': { audiences: ['office', 'floor'], permission: 'production.bundles', scope: 'record' },
  'GET /production/bundles/sets/check': { audiences: ['office', 'floor'], permission: 'production.bundles', scope: 'record' },
})
