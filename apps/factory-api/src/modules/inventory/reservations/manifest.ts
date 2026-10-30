import { defineManifest } from '../../../core/manifest'

/**
 * The reservations' routes (B-W2a-11; SCM-205, SCM-209, SCM-210). Office only. A reservation belongs to a site and its
 * company: the handlers check the site with can() and filter the list with scopeWhere() (`record`). Reading is
 * inventory.stock.view; reserving and releasing inventory.reserve. The floor never reserves: its issues count against a
 * work order's reservations inside modules/inventory/issue.
 */
export const manifest = defineManifest({
  'GET /inventory/reservations': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'GET /inventory/reservations/availability': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'GET /inventory/reservations/:reservationId': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'POST /inventory/reservations': { audiences: ['office'], permission: 'inventory.reserve', scope: 'record' },
  'POST /inventory/reservations/release': { audiences: ['office'], permission: 'inventory.reserve', scope: 'record' },
})
