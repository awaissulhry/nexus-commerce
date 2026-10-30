import { defineManifest } from '../../../core/manifest'

/**
 * Stock counts and the year-end physical inventory (B-W2a-15; SCM-224, SCM-230). Office only, scoped by record: a
 * count belongs to its site and company, so the handlers check each with can() and filter the list with scopeWhere().
 * Making, counting, submitting and cancelling are inventory.counts.manage; approving and sending back
 * inventory.counts.approve; applying the differences inventory.adjust; the year-end sign-off inventory.counts.signoff
 * (and the cost grain, checked by the handler). Writes take an Idempotency-Key.
 */
export const manifest = defineManifest({
  'GET /inventory/stock-counts': { audiences: ['office'], permission: 'inventory.counts.view', scope: 'record' },
  'GET /inventory/stock-counts/counts': { audiences: ['office'], permission: 'inventory.counts.view', scope: 'record' },
  'GET /inventory/stock-counts/reasons': { audiences: ['office'], permission: 'inventory.counts.view', scope: 'record' },
  'POST /inventory/stock-counts': { audiences: ['office'], permission: 'inventory.counts.manage', scope: 'record' },
  'GET /inventory/stock-counts/:countId': { audiences: ['office'], permission: 'inventory.counts.view', scope: 'record' },
  'PATCH /inventory/stock-counts/:countId': { audiences: ['office'], permission: 'inventory.counts.manage', scope: 'record' },
  'POST /inventory/stock-counts/:countId/start': { audiences: ['office'], permission: 'inventory.counts.manage', scope: 'record' },
  'GET /inventory/stock-counts/:countId/lines': { audiences: ['office'], permission: 'inventory.counts.view', scope: 'record' },
  'POST /inventory/stock-counts/:countId/lines': { audiences: ['office'], permission: 'inventory.counts.manage', scope: 'record' },
  'POST /inventory/stock-counts/:countId/lines/record': { audiences: ['office'], permission: 'inventory.counts.manage', scope: 'record' },
  'POST /inventory/stock-counts/:countId/lines/:lineId/remove': { audiences: ['office'], permission: 'inventory.counts.manage', scope: 'record' },
  'POST /inventory/stock-counts/:countId/recounts': { audiences: ['office'], permission: 'inventory.counts.manage', scope: 'record' },
  'POST /inventory/stock-counts/:countId/submit': { audiences: ['office'], permission: 'inventory.counts.manage', scope: 'record' },
  'POST /inventory/stock-counts/:countId/approve': { audiences: ['office'], permission: 'inventory.counts.approve', scope: 'record' },
  'POST /inventory/stock-counts/:countId/send-back': { audiences: ['office'], permission: 'inventory.counts.approve', scope: 'record' },
  'POST /inventory/stock-counts/:countId/apply': { audiences: ['office'], permission: 'inventory.adjust', scope: 'record' },
  'POST /inventory/stock-counts/:countId/sign-off': { audiences: ['office'], permission: 'inventory.counts.signoff', scope: 'record' },
  'POST /inventory/stock-counts/:countId/cancel': { audiences: ['office'], permission: 'inventory.counts.manage', scope: 'record' },
  'GET /inventory/stock-counts/:countId/sheets': { audiences: ['office'], permission: 'inventory.counts.view', scope: 'record' },
  'GET /inventory/stock-counts/:countId/valued-list': { audiences: ['office'], permission: 'inventory.counts.view', scope: 'record' },
})
