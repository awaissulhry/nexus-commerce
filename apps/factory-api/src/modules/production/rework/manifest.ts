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
  // B-W2b-117 (MES-044): recut tickets — replacement panels that join the original bundle (./recut.ts). The office reads them on the
  // Cutting page (production.cutting.view); sewing and quality ask for them (production.recuts: a tablet's ask is numbered by the
  // system); the cutting table lists, prints and scans them (production.cut); the office voids one (production.recuts).
  'GET /production/recut-tickets': { audiences: ['office'], permission: 'production.cutting.view', scope: 'record' },
  'GET /production/recut-tickets/waiting': { audiences: ['office', 'floor'], permission: 'production.cut', scope: 'record' },
  'GET /production/recut-tickets/scan': { audiences: ['office', 'floor'], permission: 'production.cut', scope: 'record' },
  'GET /production/recut-tickets/options': { audiences: ['office', 'floor'], permission: 'production.recuts', scope: 'record' },
  'POST /production/recut-tickets': { audiences: ['office', 'floor'], permission: 'production.recuts', scope: 'record' },
  'POST /production/recut-tickets/:ticketId/print': { audiences: ['office', 'floor'], permission: 'production.cut', scope: 'record' },
  'POST /production/recut-tickets/start': { audiences: ['floor'], permission: 'production.cut', scope: 'record' },
  'POST /production/recut-tickets/finish': { audiences: ['floor'], permission: 'production.cut', scope: 'record' },
  'POST /production/recut-tickets/:ticketId/void': { audiences: ['office'], permission: 'production.recuts', scope: 'record' },
})
