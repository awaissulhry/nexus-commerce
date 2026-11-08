import { defineManifest } from '../../../core/manifest'

/**
 * Lays at the table and the reconciliation of a cut order (B-W2b-116; MES-038, MES-039, MES-045, MES-046; design floor.fabriccut
 * "Spread the lay", "Count the plies at both ends", "Fabric used"; production.cutting pop "Reconcile cut"). The table (and the
 * office's production.cut holders) reads a lay, spreads it, counts it and confirms its fabric used with production.cut (a floor
 * device: its own site); the office reads the reconciliation with the cutting room's production.cutting.view and reconciles with
 * production.cutorders.manage. Handlers check each cut order with can() (`record`).
 */
export const manifest = defineManifest({
  'GET /production/lays/:layId': { audiences: ['office', 'floor'], permission: 'production.cut', scope: 'record' },
  'POST /production/lays/:layId/spread': { audiences: ['office', 'floor'], permission: 'production.cut', scope: 'record' },
  'POST /production/lays/:layId/rolls': { audiences: ['office', 'floor'], permission: 'production.cut', scope: 'record' },
  'POST /production/lays/:layId/rolls/undo': { audiences: ['office', 'floor'], permission: 'production.cut', scope: 'record' },
  'POST /production/lays/:layId/rolls/:layRollId': { audiences: ['office', 'floor'], permission: 'production.cut', scope: 'record' },
  'POST /production/lays/:layId/count': { audiences: ['office', 'floor'], permission: 'production.cut', scope: 'record' },
  'POST /production/lays/:layId/fabric-used': { audiences: ['office', 'floor'], permission: 'production.cut', scope: 'record' },
  'GET /production/cut-orders/:cutOrderId/reconciliation': { audiences: ['office'], permission: 'production.cutting.view', scope: 'record' },
  'POST /production/cut-orders/:cutOrderId/reconcile': { audiences: ['office'], permission: 'production.cutorders.manage', scope: 'record' },
})
