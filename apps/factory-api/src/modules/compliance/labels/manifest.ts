import { defineManifest } from '../../../core/manifest'

/**
 * The garment label builder's routes (B-W1-19; PRD-331; A2 SCR-053). Office only: the floor prints garment labels through
 * its own final-operation route (B-W1-44), which renders a template with `garmentLabelFor`; portal and link sessions see no
 * label. A template belongs to its company (none: every company), so the handlers check each one with can() and filter
 * lists with scopeWhere() (`record`); naming a label on a style revision checks the style's company.
 */
export const manifest = defineManifest({
  'GET /compliance/labels': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'record' },
  'GET /compliance/labels/:templateId': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'record' },
  'GET /compliance/labels/:templateId/preview': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'record' },
  'GET /compliance/labels/:templateId/preview/pdf': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'record' },
  'POST /compliance/labels': { audiences: ['office'], permission: 'compliance.labels.manage', scope: 'record' },
  'PATCH /compliance/labels/:templateId': { audiences: ['office'], permission: 'compliance.labels.manage', scope: 'record' },
  'POST /compliance/labels/:templateId/activate': { audiences: ['office'], permission: 'compliance.labels.manage', scope: 'record' },
  'POST /compliance/labels/:templateId/retire': { audiences: ['office'], permission: 'compliance.labels.manage', scope: 'record' },
  'POST /compliance/labels/:templateId/revisions': { audiences: ['office'], permission: 'compliance.labels.manage', scope: 'record' },
  'POST /compliance/labels/:templateId/test-print': { audiences: ['office'], permission: 'compliance.labels.manage', scope: 'record' },
  'PUT /product/styles/:styleId/revisions/:revisionId/label': { audiences: ['office'], permission: 'compliance.labels.manage', scope: 'record' },
})
