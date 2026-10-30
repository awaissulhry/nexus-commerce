import { defineManifest } from '../../../core/manifest'

/**
 * Scrap and its replacement (B-W2a-13; MES-129, MES-130): office only. Reads with production.scrap.view; asking a
 * replacement, marking a recut done, cancelling and posting scrapped stock by lot with production.scrap; approving or
 * refusing a lower order quantity with production.scrap.approve. Each write takes an Idempotency-Key. Handlers check each
 * work order with can() and filter lists with scopeWhere() (`record`).
 */
export const manifest = defineManifest({
  'GET /production/scrap': { audiences: ['office'], permission: 'production.scrap.view', scope: 'record' },
  'POST /production/scrap/stock': { audiences: ['office'], permission: 'production.scrap', scope: 'record' },
  'GET /production/replacements': { audiences: ['office'], permission: 'production.scrap.view', scope: 'record' },
  'GET /production/replacements/:replacementId': { audiences: ['office'], permission: 'production.scrap.view', scope: 'record' },
  'POST /production/replacements': { audiences: ['office'], permission: 'production.scrap', scope: 'record' },
  'POST /production/replacements/:replacementId/approve': { audiences: ['office'], permission: 'production.scrap.approve', scope: 'record' },
  'POST /production/replacements/:replacementId/refuse': { audiences: ['office'], permission: 'production.scrap.approve', scope: 'record' },
  'POST /production/replacements/:replacementId/done': { audiences: ['office'], permission: 'production.scrap', scope: 'record' },
  'POST /production/replacements/:replacementId/cancel': { audiences: ['office'], permission: 'production.scrap', scope: 'record' },
})
