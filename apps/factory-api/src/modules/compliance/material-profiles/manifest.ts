import { defineManifest } from '../../../core/manifest'

/**
 * Material profiles (B-W2b-256; PRD-303, PRD-314; design compliance.tests › Material profiles and the material record's
 * Compliance tab). Office only. Reading needs the certificate register's view permission in any grant (`tenant`: the
 * handlers keep staff to the materials of their companies and the tenant-wide ones); a person's edit needs
 * compliance.substances.manage over the material's company, which the handler checks (403 in words).
 */
export const manifest = defineManifest({
  'GET /compliance/material-profiles': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'GET /compliance/material-profiles/:itemId': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'PATCH /compliance/material-profiles/:itemId': { audiences: ['office'], permission: 'compliance.substances.manage', scope: 'tenant' },
})
