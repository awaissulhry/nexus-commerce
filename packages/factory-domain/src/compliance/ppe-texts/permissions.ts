import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'
import { CERTIFICATES_VIEW } from '../certificates/permissions'

/**
 * The PPE text approvals (B-W2b-288, follow-up FU2:01; GATE-PPE-TEXTS; factory-db PpeTextApproval of B-W2b-275). Office only
 * (area `compliance`). Reading the approvals and the templates they are about reuses the certificate register's view
 * permission (as Rules & markets does). One write:
 *
 *   ppeTexts.manage   record a PPE consultant's yes to one template of generated PPE texts (the DoC, the user information, a
 *                     label template's class warnings) in the languages checked, with the consultant's file; withdraw it once
 *                     with a reason. Recording opens the issue of generated texts of that template (the database's gate), so
 *                     it asks a fresh code (step-up); a withdrawal closes it again at once (no code). The gate itself stays
 *                     the Owner's decision (W2b-4 question 2): no role template holds it but the owner (from every()).
 */
export const PPE_TEXTS_DEFINITIONS = definePermissions('compliance', {
  'ppeTexts.manage': {
    risk: 'stepUp',
    description:
      "Record a PPE consultant's yes to a template of generated PPE texts (the declaration of conformity, the user information, a label's class warnings) in the languages checked, with the consultant's file (asks a fresh code), and withdraw it with a reason.",
  },
})

/** Read the approvals and their templates (the certificate register's view). */
export const PPE_TEXTS_VIEW: Permission = CERTIFICATES_VIEW
export const PPE_TEXTS_MANAGE = 'compliance.ppeTexts.manage' satisfies Permission

export const PPE_TEXTS_PERMISSIONS: readonly Permission[] = Object.freeze([PPE_TEXTS_MANAGE])
