import { defineManifest } from '../../../core/manifest'

/**
 * The repair station and second quality (B-W2b-126; MES-132, MES-133). The floor (its own site: can() pins it, row-level
 * security too) reads the repair queue and scans bundles in and out with production.repair (each write with an
 * Idempotency-Key). The office reads a rework's repair and the downgrades with production.scrap.view, and sends scrapped
 * garments to second quality or withdraws a downgrade with production.downgrade. Handlers check each work order with can()
 * and filter lists with scopeWhere() (`record`).
 */
export const manifest = defineManifest({
  'GET /production/repair/station': { audiences: ['floor'], permission: 'production.repair', scope: 'record' },
  'POST /production/repair/:reworkId/in': { audiences: ['floor'], permission: 'production.repair', scope: 'record' },
  'POST /production/repair/:reworkId/out': { audiences: ['floor'], permission: 'production.repair', scope: 'record' },
  'GET /production/repair/:reworkId': { audiences: ['office'], permission: 'production.scrap.view', scope: 'record' },
  'GET /production/downgrades': { audiences: ['office'], permission: 'production.scrap.view', scope: 'record' },
  'GET /production/downgrades/options': { audiences: ['office'], permission: 'production.scrap.view', scope: 'record' },
  'POST /production/downgrades': { audiences: ['office'], permission: 'production.downgrade', scope: 'record' },
  'POST /production/downgrades/:downgradeId/withdraw': { audiences: ['office'], permission: 'production.downgrade', scope: 'record' },
})
