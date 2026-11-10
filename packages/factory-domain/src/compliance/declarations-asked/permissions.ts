import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'
import { CERTIFICATES_VIEW } from '../certificates/permissions'

/**
 * Declarations asked of suppliers, material profiles and test plan rules (B-W2b-256; PRD-303, PRD-304, PRD-309, PRD-314;
 * design compliance.tests › Supplier declarations, Material profiles, Test plan rules). Office only (area `compliance`).
 * Reading reuses the certificate register's view permission, as the substance list does (B-W2b-250). A material profile's
 * confirmations and the test plan rules are kept with compliance.substances.manage (B-W2b-250: the keeper of the rules
 * over the substance list writes the profiles); a lab result of a substance test with W1's quality.lots.test.
 *
 *   supplierDeclarations.manage   ask suppliers for declarations (REACH SVHC above 0.1 % w/w, an RSL, PFAS-free, nickel
 *                                 release, Cr VI), remind them, record the answer and what it says per material, accept
 *                                 or refuse it (the supplier reads why), cancel a request and ask again (the Candidate
 *                                 List grew, a refusal, an expiry). The quality inspector; the owner from every().
 */
export const SUPPLIER_DECLARATIONS_DEFINITIONS = definePermissions('compliance', {
  'supplierDeclarations.manage': {
    risk: 'write',
    description:
      'Ask suppliers for declarations (REACH SVHC, RSL, PFAS-free, nickel release, chromium VI), remind them, record the answer per material, accept or refuse it with the reason the supplier reads, cancel a request and ask again.',
  },
})

export const SUPPLIER_DECLARATIONS_VIEW: Permission = CERTIFICATES_VIEW
export const SUPPLIER_DECLARATIONS_MANAGE = 'compliance.supplierDeclarations.manage' satisfies Permission

export const SUPPLIER_DECLARATIONS_PERMISSIONS: readonly Permission[] = Object.freeze([SUPPLIER_DECLARATIONS_MANAGE])

/** Who holds it (auth/roles/templates): the quality inspector, beside compliance.substances.manage. */
export const SUPPLIER_DECLARATIONS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  quality_inspector: [SUPPLIER_DECLARATIONS_MANAGE],
})
