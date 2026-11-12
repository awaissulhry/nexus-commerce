import { defineManifest } from '../../../core/manifest'

/**
 * Lots in depth (B-W2b-313; SCM-185, SCM-236, SCM-237, SCM-238, SCM-242; design warehouse.lots: the Lifecycle column and
 * the Depleted view, the attributes, the lot page's W2b facts, Split into shade groups, the Trace report). Office only. A
 * lot's scope is its company and site (the handlers check it with can(): `record`); a trace report's the start's. Reading
 * is inventory.stock.view (the Lots & traceability page's permission); sorting hides into lots and recording attributes
 * inventory.lots.manage; the dated report inventory.trace.report. Its handler (the lifecycle moved by the stock moves and
 * quality decisions) is listed in background.ts.
 */
export const manifest = defineManifest({
  'GET /inventory/lots-depth': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'GET /inventory/lots/:lotId/depth': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'POST /inventory/lots/:lotId/lifecycle/check': { audiences: ['office'], permission: 'inventory.lots.manage', scope: 'record' },
  'PATCH /inventory/lots/:lotId/attributes': { audiences: ['office'], permission: 'inventory.lots.manage', scope: 'record' },
  'GET /inventory/lots/:lotId/split': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'POST /inventory/lots/:lotId/split': { audiences: ['office'], permission: 'inventory.lots.manage', scope: 'record' },
  'POST /inventory/lots/:lotId/regroup': { audiences: ['office'], permission: 'inventory.lots.manage', scope: 'record' },
  // The dated trace report (inventory/trace/report.ts), beside B-W2a-27's trace routes.
  'POST /inventory/trace/report': { audiences: ['office'], permission: 'inventory.trace.report', scope: 'record' },
  'GET /inventory/trace/reports': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
})
