import { defineManifest } from '../../../core/manifest'

/**
 * Operation scans (B-W1-42; MES-069, MES-090, MES-095, MES-096, MES-167, MES-308; A2 SCR-090, SCR-072, SCR-073,
 * SCR-023): the floor's reads and writes with production.scan at its own device's site (can() pins it, row-level
 * security too), the offline queue's batch, the office's corrections and refused scans (production.scan.correct) and
 * WIP and a work order's scans (workorders.view: part of the work order record). Handlers check each work order (or
 * request, or refusal) with can() and filter lists with scopeWhere() (`record`).
 */
export const manifest = defineManifest({
  'GET /production/scans/reasons': { audiences: ['office', 'floor'], permission: 'production.scan', scope: 'record' },
  'GET /production/scans/card': { audiences: ['office', 'floor'], permission: 'production.scan', scope: 'record' },
  'GET /production/scans/mine': { audiences: ['floor'], permission: 'production.scan', scope: 'record' },
  'POST /production/scans': { audiences: ['floor'], permission: 'production.scan', scope: 'record' },
  'POST /production/scans/:scanId/undo': { audiences: ['floor'], permission: 'production.scan', scope: 'record' },
  'POST /production/scans/:scanId/corrections': { audiences: ['floor'], permission: 'production.scan', scope: 'record' },
  'POST /production/scans/batch': { audiences: ['floor'], permission: 'production.scan', scope: 'record' },
  'POST /production/scans/mine/refusals/:refusalId/discard': { audiences: ['floor'], permission: 'production.scan', scope: 'record' },
  'GET /production/scans/corrections': { audiences: ['office'], permission: 'production.scan.correct', scope: 'record' },
  'GET /production/scans/corrections/:requestId': { audiences: ['office'], permission: 'production.scan.correct', scope: 'record' },
  'POST /production/scans/corrections/:requestId/approve': { audiences: ['office'], permission: 'production.scan.correct', scope: 'record' },
  'POST /production/scans/corrections/:requestId/refuse': { audiences: ['office'], permission: 'production.scan.correct', scope: 'record' },
  'GET /production/scans/refusals': { audiences: ['office'], permission: 'production.scan.correct', scope: 'record' },
  'GET /production/scans/refusals/:refusalId': { audiences: ['office'], permission: 'production.scan.correct', scope: 'record' },
  'POST /production/scans/refusals/:refusalId/discard': { audiences: ['office'], permission: 'production.scan.correct', scope: 'record' },
  'GET /production/scans/wip': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
  'GET /production/scans/work-orders/:workOrderId/wip': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
  'GET /production/scans/work-orders/:workOrderId/scans': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
})
