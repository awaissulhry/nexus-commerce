import { defineManifest } from '../../../core/manifest'

/**
 * Put away by scan (B-W2b-292; SCM-202; design floor.move): the office and a floor device at its own site (can() pins it,
 * row-level security too) with inventory.transfer (a put-away is a move between two places of a site). Every write needs an
 * Idempotency-Key from a tablet.
 */
export const manifest = defineManifest({
  'GET /inventory/putaway/scan': { audiences: ['office', 'floor'], permission: 'inventory.transfer', scope: 'record' },
  'POST /inventory/putaway': { audiences: ['office', 'floor'], permission: 'inventory.transfer', scope: 'record' },
})
