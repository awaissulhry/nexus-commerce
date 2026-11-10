import { defineManifest } from '../../../core/manifest'

/**
 * The phrase library (B-W2b-249; PRD-343; design compliance.settings › rm-phrases). Office only. Reading needs the
 * certificate register's view permission in any grant; a phrase is kept, and a translation proposed or withdrawn, with
 * compliance.phrases.manage over the phrase's company (every company for a phrase of every company); approving needs
 * compliance.phrases.approve likewise (the handlers check it, 403 in words) and a person other than the translator.
 */
export const manifest = defineManifest({
  'GET /compliance/rules/phrases': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'GET /compliance/rules/phrases/texts': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'POST /compliance/rules/phrases': { audiences: ['office'], permission: 'compliance.phrases.manage', scope: 'tenant' },
  'GET /compliance/rules/phrases/:key': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'PATCH /compliance/rules/phrases/:key': { audiences: ['office'], permission: 'compliance.phrases.manage', scope: 'tenant' },
  'POST /compliance/rules/phrases/:key/translations': { audiences: ['office'], permission: 'compliance.phrases.manage', scope: 'tenant' },
  'POST /compliance/rules/phrases/:key/translations/:translationId/approve': { audiences: ['office'], permission: 'compliance.phrases.approve', scope: 'tenant' },
  'DELETE /compliance/rules/phrases/:key/translations/:translationId': { audiences: ['office'], permission: 'compliance.phrases.manage', scope: 'tenant' },
})
