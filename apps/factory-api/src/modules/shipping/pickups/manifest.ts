import { defineManifest } from '../../../core/manifest'

/**
 * Carrier pickups (B-W2b-395; LOG-048): office only. A pickup belongs to a site of a company, so the handlers check it with
 * can() (`record`). Reading needs shipping.view; booking and every move after it shipping.pickups.book.
 */
export const manifest = defineManifest({
  'GET /shipping/pickups': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'GET /shipping/pickups/draft': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'GET /shipping/pickups/:pickupId': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'POST /shipping/pickups': { audiences: ['office'], permission: 'shipping.pickups.book', scope: 'record' },
  'POST /shipping/pickups/:pickupId/status': { audiences: ['office'], permission: 'shipping.pickups.book', scope: 'record' },
})
