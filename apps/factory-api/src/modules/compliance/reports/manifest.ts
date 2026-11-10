import { defineManifest } from '../../../core/manifest'

/**
 * Compliance reports (B-W2b-272; ANA-025; design compliance.reports SCR-261). Office only, read only. The page's permission is
 * compliance.reports.view over the screen's company (checked in the handler with can(), `record`); each figure ALSO needs the
 * view permission of the records it is counted from (handler: `sightOf`), so a role sees the report of what it may see. No
 * write, no event: the figures are counts of what the earlier compliance steps recorded.
 */
const view = { audiences: ['office'], permission: 'compliance.reports.view', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /compliance/reports/kpis': view,
  'GET /compliance/reports/gaps': view,
  'GET /compliance/reports/expiries': view,
  'GET /compliance/reports/cr6': view,
  'GET /compliance/reports/register': view,
})
