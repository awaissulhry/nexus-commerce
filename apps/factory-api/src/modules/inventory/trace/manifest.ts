import { defineManifest } from '../../../core/manifest'

/**
 * The trace both ways (B-W2a-27; SCM-240, SCM-241; design warehouse.lots lt-trace and lt-trace-tree): find what a
 * scanned or typed code names, and trace it backward to the supplier's lot and forward to the customer. Office only,
 * read only, inventory.stock.view: the Lots & traceability page's permission; the handlers check the start's company
 * and site with can() (`record`) and show a party's name only with parties.view on it.
 */
export const manifest = defineManifest({
  'GET /inventory/trace/find': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'GET /inventory/trace': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
})
