import { defineManifest } from '../../../core/manifest'

/**
 * The rework loop (B-W2a-13; MES-126): the floor (its own site: can() pins it, row-level security too) and the office
 * open, start, finish and cancel rework with production.rework (each write with an Idempotency-Key); the office also
 * reads it with production.scrap.view (the handlers check either). Handlers check each work order with can() and filter
 * lists with scopeWhere() (`record`).
 */
export const manifest = defineManifest({
  'GET /production/rework': { audiences: ['office', 'floor'], permission: 'production.rework', scope: 'record' },
  'GET /production/rework/:reworkId': { audiences: ['office', 'floor'], permission: 'production.rework', scope: 'record' },
  'POST /production/rework': { audiences: ['office', 'floor'], permission: 'production.rework', scope: 'record' },
  'POST /production/rework/:reworkId/start': { audiences: ['office', 'floor'], permission: 'production.rework', scope: 'record' },
  'POST /production/rework/:reworkId/done': { audiences: ['office', 'floor'], permission: 'production.rework', scope: 'record' },
  'POST /production/rework/:reworkId/cancel': { audiences: ['office', 'floor'], permission: 'production.rework', scope: 'record' },
})
