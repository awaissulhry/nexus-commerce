import { defineManifest } from '../../../core/manifest'

/**
 * Opening stock (B-W1-35; SCM-288, QHS-029; A2 SCR-017, SCR-060): the office only. The template needs
 * inventory.opening.import in any grant; the reports need it over their company (uploading also quality.lots.test and
 * files.upload); the summary inventory.stock.view over the site. Handlers check each record with can() (`record`). The
 * import itself is the imports platform's routes with importer `inventory.opening`.
 */
export const manifest = defineManifest({
  'GET /inventory/opening/template': { audiences: ['office'], permission: 'inventory.opening.import', scope: 'tenant' },
  'POST /inventory/opening/reports': { audiences: ['office'], permission: 'inventory.opening.import', scope: 'record' },
  'POST /inventory/opening/reports/:fileId/complete': { audiences: ['office'], permission: 'inventory.opening.import', scope: 'record' },
  'GET /inventory/opening/reports': { audiences: ['office'], permission: 'inventory.opening.import', scope: 'record' },
  'GET /inventory/opening/summary': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
})
