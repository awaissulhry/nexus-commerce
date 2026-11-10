import { defineManifest } from '../../../core/manifest'

/**
 * Restricted substances and their rules (B-W2b-250; PRD-318, PRD-320 … PRD-326, PRD-329; design compliance.tests ›
 * Substance list, Material profiles, the material record's Compliance tab). Office only. Reading the list, the rules and
 * the Candidate List versions needs the certificate register's view permission in any grant (`tenant`: the handlers keep
 * staff to tenant-wide rows and their companies' own); a material's or a style's evaluation needs it over the record's
 * company (`record`). Every write needs compliance.substances.manage over the row's company (a tenant-wide row, the
 * starter list and a new Candidate List version: every company), which the handlers check (403 in words).
 */
export const manifest = defineManifest({
  'GET /compliance/substances': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'POST /compliance/substances': { audiences: ['office'], permission: 'compliance.substances.manage', scope: 'tenant' },
  'POST /compliance/substances/starter': { audiences: ['office'], permission: 'compliance.substances.manage', scope: 'tenant' },
  'GET /compliance/substances/rules': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'POST /compliance/substances/rules': { audiences: ['office'], permission: 'compliance.substances.manage', scope: 'tenant' },
  'GET /compliance/substances/rules/:ruleId': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'PATCH /compliance/substances/rules/:ruleId': { audiences: ['office'], permission: 'compliance.substances.manage', scope: 'tenant' },
  'PUT /compliance/substances/rules/:ruleId/switch': { audiences: ['office'], permission: 'compliance.substances.manage', scope: 'tenant' },
  'GET /compliance/substances/svhc-versions': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'POST /compliance/substances/svhc-versions': { audiences: ['office'], permission: 'compliance.substances.manage', scope: 'tenant' },
  'PATCH /compliance/substances/svhc-versions/:versionId': { audiences: ['office'], permission: 'compliance.substances.manage', scope: 'tenant' },
  'GET /compliance/substances/materials/:materialId/evaluation': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'record' },
  'POST /compliance/substances/materials/evaluate': { audiences: ['office'], permission: 'compliance.substances.manage', scope: 'record' },
  'GET /compliance/substances/styles/:styleId/evaluation': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'record' },
  'GET /compliance/substances/:substanceId': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'PATCH /compliance/substances/:substanceId': { audiences: ['office'], permission: 'compliance.substances.manage', scope: 'tenant' },
})
