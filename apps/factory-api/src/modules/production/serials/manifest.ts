import { defineManifest } from '../../../core/manifest'

/**
 * Batch or serial at the final operation and the garment labels behind the certificate gate (B-W1-44; MES-076,
 * PRD-348, QHS-051, PRD-331; A2 SCR-096 floor.labels, SCR-072): a work order's label state and a scanned code for a
 * floor device (its own site only: can() pins it, row-level security too) and the office with production.serials; the
 * floor's print (with an Idempotency-Key); the reprint (a BATCH cell, or one serial) and the void of a serial for the
 * floor and the office; the office's serials and label log of a work order (workorders.view). Handlers check each work
 * order with can() (`record`).
 */
export const manifest = defineManifest({
  'GET /production/serials/work-orders/:workOrderId': { audiences: ['office', 'floor'], permission: 'production.serials', scope: 'record' },
  'GET /production/serials/scan': { audiences: ['office', 'floor'], permission: 'production.serials', scope: 'record' },
  'POST /production/serials/work-orders/:workOrderId/labels': { audiences: ['floor'], permission: 'production.serials', scope: 'record' },
  'POST /production/serials/work-orders/:workOrderId/reprint': { audiences: ['office', 'floor'], permission: 'production.serials', scope: 'record' },
  'POST /production/serials/:serialId/reprint': { audiences: ['office', 'floor'], permission: 'production.serials', scope: 'record' },
  'POST /production/serials/:serialId/void': { audiences: ['office', 'floor'], permission: 'production.serials', scope: 'record' },
  'GET /production/serials/work-orders/:workOrderId/serials': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
})
