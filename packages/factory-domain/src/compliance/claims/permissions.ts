import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'
import { CERTIFICATES_VIEW } from '../certificates/permissions'

/**
 * Sourcing & claims (B-W2b-264; PRD-380; design compliance.sourcing, SCR-215; Dir. (EU) 2024/825). Office only (area
 * `compliance`). Reading the claims register — the words, what each claim covers, its evidence and expiry, where it is used
 * — reuses the compliance read (compliance.certificates.view: the people who read the certificates and the labels the claims
 * are printed on). Checked with can() against the claim's company.
 *
 *   claims.manage   draft a claim and change it while it is a draft (words per language, scope, evidence files, until
 *                   when the evidence holds), draft a replacement of an approved claim, record where an approved claim is
 *                   used (a label, a style, a catalogue, web shop texts) and end a use, withdraw a claim (its uses end
 *                   with it).
 *   claims.approve  approve a draft claim with a fresh code (step-up): the claim may be used from then on, and an approved
 *                   replacement withdraws the claim it replaces and takes over its uses.
 *
 * The quality inspector holds both; the owner from every().
 */
export const CLAIMS_DEFINITIONS = definePermissions('compliance', {
  'claims.manage': {
    risk: 'write',
    description:
      'Keep the sustainability claims register: draft a claim with its words per language, what it covers, its evidence files and until when the evidence holds; draft a replacement; record where an approved claim is used and end a use; withdraw a claim.',
  },
  'claims.approve': {
    risk: 'stepUp',
    description: 'Approve a sustainability claim with a fresh code, once its evidence is there and still holds (Dir. (EU) 2024/825): from then on it may be used on labels, styles, catalogues and web shop texts.',
  },
})

/** Reading: the compliance read. */
export const CLAIMS_VIEW: Permission = CERTIFICATES_VIEW
export const CLAIMS_MANAGE = 'compliance.claims.manage' satisfies Permission
export const CLAIMS_APPROVE = 'compliance.claims.approve' satisfies Permission

export const CLAIMS_PERMISSIONS: readonly Permission[] = Object.freeze([CLAIMS_MANAGE, CLAIMS_APPROVE])

/** Who holds them (auth/roles/templates): the quality inspector, beside the certificates and labels. */
export const CLAIMS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  quality_inspector: [CLAIMS_MANAGE, CLAIMS_APPROVE],
})
