import { defineManifest } from '../../../core/manifest'

/**
 * The cutting room board and the cutting and yield report (B-W2b-130; MES-163, MES-302): office reads only, no new permission.
 * The board (Floor now's Cutting room) with the cutting room's production.cutting.view; the report (Production reports' Cutting
 * and yield) with the reports' production.reports.view; a work order's leather shade lots (its Materials tab) with
 * workorders.view. Handlers check the site or the work order with can() (`record`).
 */
export const manifest = defineManifest({
  'GET /production/cutboard': { audiences: ['office'], permission: 'production.cutting.view', scope: 'record' },
  'GET /production/cutboard/yield': { audiences: ['office'], permission: 'production.reports.view', scope: 'record' },
  'GET /production/cutboard/work-orders/:workOrderId/leather': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
})
