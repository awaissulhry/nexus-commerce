import { defineManifest } from '../../../core/manifest'

/**
 * Market profiles (B-W2b-249; PRD-275; design compliance.settings › rm-markets). Office only. Reading needs the
 * certificate register's view permission in any grant (the markets of the companies it reaches and every company's);
 * keeping a market needs compliance.rules.manage over its company (every company for a market of every company; the
 * handlers check it, 403 in words).
 */
export const manifest = defineManifest({
  'GET /compliance/rules/markets': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'GET /compliance/rules/markets/languages': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'POST /compliance/rules/markets': { audiences: ['office'], permission: 'compliance.rules.manage', scope: 'tenant' },
  'GET /compliance/rules/markets/:code': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'PATCH /compliance/rules/markets/:code': { audiences: ['office'], permission: 'compliance.rules.manage', scope: 'tenant' },
  'PUT /compliance/rules/markets/:code/switch': { audiences: ['office'], permission: 'compliance.rules.manage', scope: 'tenant' },
})
