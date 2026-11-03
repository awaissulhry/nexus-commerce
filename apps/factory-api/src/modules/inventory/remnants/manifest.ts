import { defineManifest } from '../../../core/manifest'

/**
 * Remnant stock (B-W2b-100; SCM-254; design warehouse.hides "Remnants", floor.pick, floor.scan "remnant"). The list and one
 * piece are the office's (inventory.stock.view); a scanned RM tag is looked up by the office and a floor device at its own
 * site (inventory.issue: the pick screen issues a remnant by its tag); tagging a W1 remnant is the office's
 * (inventory.issue: the warehouse that takes returns). Pieces get their tags and change state inside the issue, return,
 * cut, write-off and reversal commands themselves (lifecycle.ts). A remnant belongs to its site and the site's company:
 * the handlers check it with can() and filter the list with scopeWhere() (`record`).
 */
export const manifest = defineManifest({
  'GET /inventory/remnants': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'GET /inventory/remnants/lookup': { audiences: ['office', 'floor'], permission: 'inventory.issue', scope: 'record' },
  'GET /inventory/remnants/:remnantId': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'POST /inventory/remnants': { audiences: ['office'], permission: 'inventory.issue', scope: 'record' },
})
