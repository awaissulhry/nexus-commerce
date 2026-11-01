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
  // B-W2b-53 (MES-128): scrap above a site's limit — the office (production.scrap.view to read, production.scrap.overLimit to
  // decide) and the team leader on the tablet (floor.lead at the device's site; approving signs with the PIN).
  'GET /production/scrap/over-limit': { audiences: ['office'], permission: 'production.scrap.view', scope: 'record' },
  'POST /production/scrap/over-limit/approve': { audiences: ['office'], permission: 'production.scrap.overLimit', scope: 'record' },
  'POST /production/scrap/over-limit/:scanId/approve': { audiences: ['office'], permission: 'production.scrap.overLimit', scope: 'record' },
  'POST /production/scrap/over-limit/:scanId/refuse': { audiences: ['office'], permission: 'production.scrap.overLimit', scope: 'record' },
  'GET /production/scrap/floor/waiting': { audiences: ['floor'], permission: 'floor.lead', scope: 'site' },
  'POST /production/scrap/floor/waiting/:scanId/approve': { audiences: ['floor'], permission: 'floor.lead', scope: 'site' },
  'POST /production/scrap/floor/waiting/:scanId/refuse': { audiences: ['floor'], permission: 'floor.lead', scope: 'site' },
})
