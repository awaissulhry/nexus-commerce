import { defineManifest } from '../../../core/manifest'

/**
 * The register of laws and standards and the harmonised-standard watch (B-W2b-249; PRD-273, PRD-274; design
 * compliance.settings › rm-regs). Office only. Reading needs the certificate register's view permission in any grant
 * (`tenant`: the register is the factory's); every write needs compliance.rules.manage over every company (the handlers
 * check it, 403 in words).
 */
export const manifest = defineManifest({
  'GET /compliance/rules/standards': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'POST /compliance/rules/standards': { audiences: ['office'], permission: 'compliance.rules.manage', scope: 'tenant' },
  'GET /compliance/rules/standards/:standardId': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'PATCH /compliance/rules/standards/:standardId': { audiences: ['office'], permission: 'compliance.rules.manage', scope: 'tenant' },
  'DELETE /compliance/rules/standards/:standardId': { audiences: ['office'], permission: 'compliance.rules.manage', scope: 'tenant' },
  'POST /compliance/rules/standards/:standardId/changes': { audiences: ['office'], permission: 'compliance.rules.manage', scope: 'tenant' },
  'GET /compliance/rules/standard-changes': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'GET /compliance/rules/standard-changes/:changeId': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'POST /compliance/rules/standard-changes/:changeId/assess': { audiences: ['office'], permission: 'compliance.rules.manage', scope: 'tenant' },
  'POST /compliance/rules/standard-changes/:changeId/certificates': { audiences: ['office'], permission: 'compliance.rules.manage', scope: 'tenant' },
  'POST /compliance/rules/standard-changes/:changeId/task': { audiences: ['office'], permission: 'compliance.rules.manage', scope: 'tenant' },
  'POST /compliance/rules/standard-changes/:changeId/close': { audiences: ['office'], permission: 'compliance.rules.manage', scope: 'tenant' },
})
