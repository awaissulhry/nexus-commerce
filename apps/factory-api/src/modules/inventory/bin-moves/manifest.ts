import { defineManifest } from '../../../core/manifest'

/**
 * Moves between bins by scan (B-W2b-292; SCM-218; design floor.move): the office and a floor device at its own site (can()
 * pins it, row-level security too) with inventory.transfer, the right of a move between two places of a site (the operator,
 * cutting operator, inspector and team leader floor templates hold it). Every write needs an Idempotency-Key from a tablet.
 */
export const manifest = defineManifest({
  'GET /inventory/bin-moves/scan': { audiences: ['office', 'floor'], permission: 'inventory.transfer', scope: 'record' },
  'POST /inventory/bin-moves': { audiences: ['office', 'floor'], permission: 'inventory.transfer', scope: 'record' },
  'POST /inventory/bin-moves/:moveId/undo': { audiences: ['office', 'floor'], permission: 'inventory.transfer', scope: 'record' },
})
