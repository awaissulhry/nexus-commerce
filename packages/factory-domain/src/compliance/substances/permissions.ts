import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'
import { CERTIFICATES_VIEW } from '../certificates/permissions'

/**
 * Restricted substances and their rules (B-W2b-250; PRD-318, PRD-320 … PRD-326, PRD-329; design compliance.tests ›
 * Substance list). Office only (area `compliance`). Reading the substance list, the rules, the Candidate List versions and
 * what the evaluator says of a material or a style reuses the certificate register's view permission, as Rules & markets,
 * the labels and the textile checks do: every compliance step reads them beside the certificates.
 *
 *   substances.manage   keep the substance list (add, edit, archive; load the starter list; import a sheet: an AFIRM RSL,
 *                       the ECHA Candidate List, a brand's RSL), keep the rules over it (add, edit, archive, switch on or
 *                       off with the reason: CMR and PFAS stay off until a style or a market needs them, Owner 11-09),
 *                       record a new Candidate List version, and run the evaluator into a material's compliance profile.
 *                       A tenant-wide row needs a grant over every company. The quality inspector; the owner from every().
 */
export const SUBSTANCES_DEFINITIONS = definePermissions('compliance', {
  'substances.manage': {
    risk: 'write',
    description:
      'Keep the restricted substance list (add, edit, archive, load the starter list, import a sheet), the rules over it (limits, scope, evidence, exemptions, switched on or off with the reason), the Candidate List versions, and run the evaluator into the materials\' compliance profiles.',
  },
})

export const SUBSTANCES_VIEW: Permission = CERTIFICATES_VIEW
export const SUBSTANCES_MANAGE = 'compliance.substances.manage' satisfies Permission

export const SUBSTANCES_PERMISSIONS: readonly Permission[] = Object.freeze([SUBSTANCES_MANAGE])

/** Who holds it (auth/roles/templates): the quality inspector, beside compliance.rules.manage. */
export const SUBSTANCES_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  quality_inspector: [SUBSTANCES_MANAGE],
})
