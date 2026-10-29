import { defineManifest } from '../../../core/manifest'

/**
 * The cutting log per hide (B-W1-40; MES-051, MES-056, MES-058, SCM-194; A2 SCR-094, SCR-071): the cutting table's
 * reads for a floor device (its own site only: can() pins it, row-level security too) and the office with
 * production.cut; the floor's writes (a cut, Hide done with the remnant, the undo of one's own last cut) with an
 * Idempotency-Key and the device's client event id; the office's cut log of a work order (workorders.view) and its
 * correction of an entry (production.cut.correct). Handlers check each work order with can() and filter lists with
 * scopeWhere() (`record`).
 */
export const manifest = defineManifest({
  'GET /production/cutting/work-orders': { audiences: ['office', 'floor'], permission: 'production.cut', scope: 'record' },
  'GET /production/cutting/work-orders/:workOrderId': { audiences: ['office', 'floor'], permission: 'production.cut', scope: 'record' },
  'GET /production/cutting/hides': { audiences: ['office', 'floor'], permission: 'production.cut', scope: 'record' },
  'POST /production/cutting/work-orders/:workOrderId/cuts': { audiences: ['floor'], permission: 'production.cut', scope: 'record' },
  'POST /production/cutting/work-orders/:workOrderId/hides/:hideId/remnant': { audiences: ['floor'], permission: 'production.cut', scope: 'record' },
  'POST /production/cutting/cuts/:cutLogId/undo': { audiences: ['floor'], permission: 'production.cut', scope: 'record' },
  'GET /production/cutting/work-orders/:workOrderId/cut-log': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
  'POST /production/cutting/cuts/:cutLogId/correct': { audiences: ['office'], permission: 'production.cut.correct', scope: 'record' },
})
