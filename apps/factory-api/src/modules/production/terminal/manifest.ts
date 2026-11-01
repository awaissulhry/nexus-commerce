import { defineManifest } from '../../../core/manifest'

/**
 * Operation timing on the tablet (B-W2b-40; MES-087 … MES-094, MES-117). The floor: the scans' permission
 * (production.scan) at the device's own site — handlers check each work order with can() (scans' mayScan) and row-level
 * security keeps a device to its site (`record`); the team leader's override of a qualification hold takes their PIN and
 * their own right (production.scan.override, checked by modules/production/guards verifyOverride). The office: the
 * minutes per operation of a work order, part of the work order record (workorders.view, can() on its company and site).
 */
export const manifest = defineManifest({
  'GET /production/terminal/open': { audiences: ['floor'], permission: 'production.scan', scope: 'record' },
  'GET /production/terminal/state': { audiences: ['floor'], permission: 'production.scan', scope: 'record' },
  'POST /production/terminal/start': { audiences: ['floor'], permission: 'production.scan', scope: 'record' },
  'POST /production/terminal/start/override': { audiences: ['floor'], permission: 'production.scan', scope: 'record' },
  'POST /production/terminal/pause': { audiences: ['floor'], permission: 'production.scan', scope: 'record' },
  'POST /production/terminal/resume': { audiences: ['floor'], permission: 'production.scan', scope: 'record' },
  'POST /production/terminal/hand-back': { audiences: ['floor'], permission: 'production.scan', scope: 'record' },
  'POST /production/terminal/partial': { audiences: ['floor'], permission: 'production.scan', scope: 'record' },
  'GET /production/terminal/work-orders/:workOrderId/timing': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
})
