import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'
import { CERTIFICATES_VIEW } from '../certificates/permissions'

/**
 * Rules & markets (B-W2b-249; PRD-273, PRD-274, PRD-275, PRD-298; design compliance.settings). Office only (area
 * `compliance`). Reading the register of laws and standards, the change watch, the markets and the economic operators
 * reuses the certificate register's view permission, as the labels and the textile checks do: every later compliance
 * step (labels, DoCs, user information, the gates) reads them beside the certificates.
 *
 *   rules.manage   keep the register of laws and standards in use (editions, Official Journal citations, status), record
 *                  and assess changes to them (the harmonised-standard watch: impact, type-change reviews, the impact
 *                  task, closing), keep the markets (languages, marks, national rules, importer and GPSR needs, switched
 *                  on or off with the reason) and the economic operators per style, brand or default and market. A
 *                  tenant-wide row (the register, a market of every company, a tenant default operator) needs a grant
 *                  over every company. The quality inspector; the owner from every().
 *
 * The phrase library has its own two (phrases/permissions.ts).
 */
export const RULES_LIBRARY_DEFINITIONS = definePermissions('compliance', {
  'rules.manage': {
    risk: 'write',
    description:
      'Keep the register of laws and standards in use and the watch on their changes (assess the impact, open type-change reviews and the impact task, close), the markets (languages, marks, national rules, importer and GPSR needs, switched on or off with the reason) and the economic operators per style, brand and market.',
  },
})

export const RULES_LIBRARY_VIEW: Permission = CERTIFICATES_VIEW
export const RULES_MANAGE = 'compliance.rules.manage' satisfies Permission

export const RULES_LIBRARY_PERMISSIONS: readonly Permission[] = Object.freeze([RULES_MANAGE])

/** Who holds it (auth/roles/templates): the quality inspector, beside compliance.labels.manage. */
export const RULES_LIBRARY_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  quality_inspector: [RULES_MANAGE],
})
