import { defineManifest } from '../../../core/manifest'

/**
 * The compliance status board's reads (B-W2b-254; PRD-277; design compliance.status SCR-119). Office only; the
 * certificate register's view permission (the styles and certificates of the companies it reaches).
 */
export const manifest = defineManifest({
  'GET /compliance/status/board': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'GET /compliance/status/actions': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'GET /compliance/status/cell': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'GET /compliance/status/expiries': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
})
