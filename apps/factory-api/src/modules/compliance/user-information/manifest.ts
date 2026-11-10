import { defineManifest } from '../../../core/manifest'

/**
 * The user information builder (B-W2b-258; PRD-350 to PRD-354; design compliance.declarations, the user-information kind).
 * Office only. Reading the leaflets, their sources, the language packs per market and the versions per batch needs the
 * certificate register's view permission in any grant (the handlers keep staff to the companies their grants reach);
 * generating, refreshing, typing, translating and withdrawing a draft needs compliance.userInformation.generate over the
 * leaflet's company (every company for a leaflet of every company), checking a translation compliance.userInformation.check.
 */
export const manifest = defineManifest({
  'GET /compliance/user-information/preview': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'POST /compliance/user-information': { audiences: ['office'], permission: 'compliance.userInformation.generate', scope: 'tenant' },
  'GET /compliance/user-information/packs': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'GET /compliance/user-information/batches': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'GET /compliance/user-information/:documentId': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'GET /compliance/user-information/:documentId/pdf': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'PATCH /compliance/user-information/:documentId': { audiences: ['office'], permission: 'compliance.userInformation.generate', scope: 'tenant' },
  'POST /compliance/user-information/:documentId/refresh': { audiences: ['office'], permission: 'compliance.userInformation.generate', scope: 'tenant' },
  'POST /compliance/user-information/:documentId/withdraw': { audiences: ['office'], permission: 'compliance.userInformation.generate', scope: 'tenant' },
  'POST /compliance/user-information/:documentId/translations': { audiences: ['office'], permission: 'compliance.userInformation.generate', scope: 'tenant' },
  'POST /compliance/user-information/:documentId/translation-state': { audiences: ['office'], permission: 'compliance.userInformation.generate', scope: 'tenant' },
  'POST /compliance/user-information/:documentId/check': { audiences: ['office'], permission: 'compliance.userInformation.check', scope: 'tenant' },
})
