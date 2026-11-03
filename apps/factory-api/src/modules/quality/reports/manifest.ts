import { defineManifest } from '../../../core/manifest'

/**
 * Quality reports (B-W2b-138; QHS-147; design quality.reports SCR-147). Office only, read only. The page's permission is
 * quality.reports.view over the site's company and site (checked in the handler with can(), `record`); each figure ALSO
 * needs the view permission of the records it is counted from (handler: `sightOf`), so a role sees the report of what it
 * may see. No write, no event: the figures are counts of what the earlier steps signed.
 */
const view = { audiences: ['office'], permission: 'quality.reports.view', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /quality/reports/kpis': view,
  'GET /quality/reports/trend': view,
  'GET /quality/reports/compare': view,
  'GET /quality/reports/incoming': view,
})
