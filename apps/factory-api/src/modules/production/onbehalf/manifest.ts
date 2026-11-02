import { defineManifest } from '../../../core/manifest'

/**
 * Scan on behalf (B-W2b-47; MES-099; design floor.supervisor "Scan on behalf"): the team leader's own right, on their
 * signed-in tablet at its own site (handlers check each record; row-level security keeps a device to its site); the override
 * of a held entry takes another team leader's PIN and right (modules/production/guards verifyOverride). Several bundles at
 * once (MES-100; design floor.operation): the scans' permission.
 */
export const manifest = defineManifest({
  'GET /production/on-behalf/options': { audiences: ['floor'], permission: 'production.scan.behalf', scope: 'record' },
  'POST /production/on-behalf/report': { audiences: ['floor'], permission: 'production.scan.behalf', scope: 'record' },
  'POST /production/on-behalf/override': { audiences: ['floor'], permission: 'production.scan.behalf', scope: 'record' },
  'POST /production/several-bundles/finish': { audiences: ['floor'], permission: 'production.scan', scope: 'record' },
})
