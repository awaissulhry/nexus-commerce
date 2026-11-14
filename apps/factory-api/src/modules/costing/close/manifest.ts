import { defineManifest } from '../../../core/manifest'

/**
 * The work order close (B-W2b-411; MES-012, MES-013, FIN-029, FIN-030, FIN-034; design production.workorders pop "Close
 * work order", record tab "Labour & cost"). Office only: the floor, partner and link sessions never see a cost (A1 §2.6).
 * Each handler checks the work order's company and site with can() (`record`). The close check is workorders.view (its
 * amounts need the cost grain, its split costing.view too); the closer's Undo is workorders.manage, a later reopen
 * workorders.reopen with a reason; the closes with their variance split and the scrap and rework cost are costing.view.
 * The close itself is POST /production/work-orders/:workOrderId/close (workorders.manage, modules/production/work-orders).
 */
export const manifest = defineManifest({
  'GET /production/work-orders/:workOrderId/close-check': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
  'POST /production/work-orders/:workOrderId/close/undo': { audiences: ['office'], permission: 'workorders.manage', scope: 'record' },
  'POST /production/work-orders/:workOrderId/reopen': { audiences: ['office'], permission: 'workorders.reopen', scope: 'record' },
  'GET /costing/work-orders/:workOrderId/close': { audiences: ['office'], permission: 'costing.view', scope: 'record' },
  'GET /costing/work-orders/:workOrderId/scrap-rework': { audiences: ['office'], permission: 'costing.view', scope: 'record' },
})
