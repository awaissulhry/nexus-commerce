import { defineManifest } from '../../../core/manifest'

/**
 * Checks before a scan counts (B-W2b-46; MES-070, MES-097, MES-098, MES-114; design floor.operation): the check of a
 * bundle at an operation (floor and office, production.scan), the team leader's override on the tablet (floor; the
 * operator's session holds production.scan, the team leader's own floor roles production.scan.override, checked in the
 * handler), the checks the floor met (office, production.scan.correct: the leads' and supervisors' right) and the traced
 * lots (office, workorders.view: part of the work order record). Handlers check each work order (or lot) with can().
 */
export const manifest = defineManifest({
  'GET /production/guards/check': { audiences: ['office', 'floor'], permission: 'production.scan', scope: 'record' },
  'POST /production/guards/override': { audiences: ['floor'], permission: 'production.scan', scope: 'record' },
  'GET /production/guards/flags': { audiences: ['office'], permission: 'production.scan.correct', scope: 'record' },
  'GET /production/guards/flags/:scanId': { audiences: ['office'], permission: 'production.scan.correct', scope: 'record' },
  'GET /production/guards/work-orders/:workOrderId/components': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
  'GET /production/guards/lots/:lotId/garments': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
})
