import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * Quality reports (apps/factory-api modules/quality/reports; B-W2b-138; QHS-147 "Quality KPIs, with reports per role";
 * design quality.reports SCR-147), in the quality area, office only. Checked with can() against the site's company and
 * site. The page needs this permission; each of its figures ALSO needs the view permission of the records it is counted
 * from (in-process checks, final inspections, nonconformances, corrective actions, holds, incoming inspections, lots), so
 * every role sees the report of what it may see (QHS-147 "reports per role") and a figure it may not see says so in words.
 *
 * Never per worker (Statuto dei Lavoratori art. 4, L. 300/1970; Owner answers W1, F2): figures per site, line, operation,
 * supplier and style only, and a line, operation or style with fewer people behind it than the company's minimum group
 * (ANA-075, People settings) shows no figure. Nothing here carries money.
 */
export const QUALITY_REPORTS_DEFINITIONS = definePermissions('quality', {
  'reports.view': {
    risk: 'read',
    description:
      "See the quality reports of a site: first-pass yield, DHU, the final AQL pass rate, open nonconformances, corrective actions on time and old holds, their trend per week and line, a comparison by line, operation, supplier and style, and incoming quality per supplier (each figure only from records you may see; never per person).",
  },
})

export const QUALITY_REPORTS_VIEW = 'quality.reports.view' satisfies Permission

export const QUALITY_REPORTS_PERMISSIONS: readonly Permission[] = Object.freeze([QUALITY_REPORTS_VIEW])
