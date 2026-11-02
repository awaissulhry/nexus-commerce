import { defineManifest } from '../../../core/manifest'

/**
 * Steps in an operation (B-W2b-47; MES-102; design floor.operation "Steps in this operation"). The floor: the scans'
 * permission at the device's own site (handlers check each work order with can(); row-level security keeps a device to its
 * site). The office: one bundle's steps with who and when, part of the work order record (workorders.view).
 */
export const manifest = defineManifest({
  'GET /production/checklists/state': { audiences: ['floor'], permission: 'production.scan', scope: 'record' },
  'POST /production/checklists/tick': { audiences: ['floor'], permission: 'production.scan', scope: 'record' },
  'GET /production/checklists/work-orders/:workOrderId': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
})
