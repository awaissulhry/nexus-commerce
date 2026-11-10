import { defineManifest } from '../../../core/manifest'

/**
 * Requirements (B-W2b-254; PRD-271, PRD-272; design compliance.settings › rm-gates). Office only. Reading needs the
 * certificate register's view permission in any grant (the requirements of the companies it reaches and every company's);
 * keeping one needs compliance.requirements.manage over its company (every company for a requirement of every company;
 * the handlers check it, 403 in words). Loosening one asks a fresh step-up (the handlers ask it, 403 `stepUp`).
 */
export const manifest = defineManifest({
  'GET /compliance/requirements': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'GET /compliance/requirements/gates': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'POST /compliance/requirements': { audiences: ['office'], permission: 'compliance.requirements.manage', scope: 'tenant' },
  'POST /compliance/requirements/w1': { audiences: ['office'], permission: 'compliance.requirements.manage', scope: 'tenant' },
  'GET /compliance/requirements/:code': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'PATCH /compliance/requirements/:code': { audiences: ['office'], permission: 'compliance.requirements.manage', scope: 'tenant' },
  'PUT /compliance/requirements/:code/switch': { audiences: ['office'], permission: 'compliance.requirements.manage', scope: 'tenant' },
})
