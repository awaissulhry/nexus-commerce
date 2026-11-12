import { defineManifest } from '../../../core/manifest'

/**
 * Substitutes with a yes (B-W2b-298; MES-139). Asking for a substitute, reading the dialog and issuing an approved one are the
 * pickers' (inventory.issue: the office, and a floor device at its own site with an Idempotency-Key); the list and one
 * substitute are the office's (inventory.stock.view); the office withdraws one (inventory.issue). The yes and the no are the
 * approval engine's (Home › Approvals, approvals.decide), never the person who asked.
 */
export const manifest = defineManifest({
  'GET /inventory/substitutions/options': { audiences: ['office', 'floor'], permission: 'inventory.issue', scope: 'record' },
  'POST /inventory/substitutions': { audiences: ['office', 'floor'], permission: 'inventory.issue', scope: 'record' },
  'GET /inventory/substitutions': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'GET /inventory/substitutions/:substitutionId': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'POST /inventory/substitutions/:substitutionId/withdraw': { audiences: ['office'], permission: 'inventory.issue', scope: 'record' },
  'POST /inventory/substitutions/:substitutionId/issue': { audiences: ['office', 'floor'], permission: 'inventory.issue', scope: 'record' },
})
