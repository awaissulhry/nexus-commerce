import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * Compliance reports (apps/factory-api modules/compliance/reports; B-W2b-272; ANA-025 "Certificate coverage"; design
 * compliance.reports SCR-261), in the compliance area, office only. Checked with can() against the screen's company. The page
 * needs this permission; each of its figures ALSO needs the view permission of the records it is counted from (certificates,
 * styles and gate refusals: compliance.certificates.view; register entries, recalls and authority requests:
 * compliance.register.view; lots and their chromium VI results: quality.lots.view; shipments: shipping.view), so every role
 * sees the report of what it may see and a figure it may not see says so in words.
 *
 * Read only: nothing here writes, so no command, audit row or event. No figure is per person; nothing here carries money.
 */
export const COMPLIANCE_REPORTS_DEFINITIONS = definePermissions('compliance', {
  'reports.view': {
    risk: 'read',
    description:
      'See the compliance reports of a company: certificate coverage of styles and markets (ANA-025), shipped styles covered, open gaps by type, gate refusals, the 12-month expiry calendar, chromium VI results per supplier against the limit, the register summary and the annual compliance review (each figure only from records you may see).',
  },
})

export const COMPLIANCE_REPORTS_VIEW = 'compliance.reports.view' satisfies Permission

export const COMPLIANCE_REPORTS_PERMISSIONS: readonly Permission[] = Object.freeze([COMPLIANCE_REPORTS_VIEW])

/**
 * Who holds it (auth/roles/templates): the quality inspector (who keeps compliance) and the production manager (who reads the
 * certificates and the register). Office only; the owner and read-only from every().
 */
export const COMPLIANCE_REPORTS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  quality_inspector: [COMPLIANCE_REPORTS_VIEW],
  production_manager: [COMPLIANCE_REPORTS_VIEW],
})
