import { defineManifest } from '../../../core/manifest'

/**
 * The stock ledger's routes (SCM-189, SCM-192, SCM-193, SCM-195; A2 SCR-064). Stock belongs to a site and its company,
 * so the handlers check each site with can() and filter the moves list with scopeWhere() (`record`). A floor device
 * transfers at its own site only (can() pins it, row-level security too) and needs an Idempotency-Key.
 */
export const manifest = defineManifest({
  'GET /inventory/moves': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'POST /inventory/adjustments': { audiences: ['office'], permission: 'inventory.adjust', scope: 'record' },
  'POST /inventory/counts': { audiences: ['office'], permission: 'inventory.adjust', scope: 'record' },
  'POST /inventory/transfers': { audiences: ['office', 'floor'], permission: 'inventory.transfer', scope: 'record' },
  'POST /inventory/scraps': { audiences: ['office'], permission: 'inventory.scrap', scope: 'record' },
  'POST /inventory/moves/:moveId/reverse': { audiences: ['office'], permission: 'inventory.reverse', scope: 'record' },
  // B-W2a-11 (SCM-193): write-off with a reason code, then its photos (files.upload is checked by the handler too).
  'POST /inventory/write-offs': { audiences: ['office'], permission: 'inventory.scrap', scope: 'record' },
  'GET /inventory/write-offs/:writeOffId': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'POST /inventory/write-offs/:writeOffId/photos': { audiences: ['office'], permission: 'inventory.scrap', scope: 'record' },
  'POST /inventory/write-offs/:writeOffId/photos/:fileId/complete': { audiences: ['office'], permission: 'inventory.scrap', scope: 'record' },
})
