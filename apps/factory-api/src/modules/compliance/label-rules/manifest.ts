import { defineManifest } from '../../../core/manifest'

/**
 * What a PPE label must say (B-W2b-253; PRD-333, PRD-335, PRD-336, PRD-346, PRD-349; design compliance.labels › Rule checks).
 * The office reads a label's marking checks with the certificate register's view over the label's and the style's company
 * (`record`: W1's label rule); setting a draft label's kind, GPSR contact and QR target needs compliance.labels.manage
 * over the label's company (a tenant-wide label: over every company; the handler checks it). The floor's label print
 * reads the checks through B-W2b-254's gate (gate.ts labelRulesFor), not through a route.
 */
export const manifest = defineManifest({
  'GET /compliance/label-rules/templates/:templateId': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'record' },
  'PUT /compliance/label-rules/templates/:templateId/marking': { audiences: ['office'], permission: 'compliance.labels.manage', scope: 'record' },
})
