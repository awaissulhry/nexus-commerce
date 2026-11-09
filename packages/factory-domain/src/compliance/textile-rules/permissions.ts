import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'
import { CERTIFICATES_VIEW } from '../certificates/permissions'

/**
 * The textile, leather and origin checks (B-W2b-208; PRD-338 … PRD-345; design compliance.labels › lb-checks). Office
 * only (area `compliance`). Reading the checks of a style, the switches and the builder's vocabulary reuses the
 * certificate register's view permission, as the labels and the style compliance tab do: the checks are about the label
 * of a certified style. Switching a check on or off is its own permission: it decides which legal checks the factory runs
 * (the Owner's answers to OWNER-QUESTIONS Q10, Q22, Q23), tenant-wide, so it needs a grant over every company.
 *
 *   textileRules.manage   switch the 80 % textile threshold, the care label and the "Made in Italy" check on or off,
 *                         with the reason. The quality inspector (who keeps the labels); the owner from every().
 *
 * The customer's portal reads a style's fibres before buying with portal.catalogue.view (B-W2b-190).
 */
export const TEXTILE_RULES_DEFINITIONS = definePermissions('compliance', {
  'textileRules.manage': {
    risk: 'write',
    description: 'Switch the 80 % textile threshold, the care label and the "Made in Italy" checks on or off for the whole factory, with the reason.',
  },
})

export const TEXTILE_RULES_VIEW: Permission = CERTIFICATES_VIEW
export const TEXTILE_RULES_MANAGE = 'compliance.textileRules.manage' satisfies Permission

export const TEXTILE_RULES_PERMISSIONS: readonly Permission[] = Object.freeze([TEXTILE_RULES_MANAGE])

/** Who holds it (auth/roles/templates): the quality inspector, beside compliance.labels.manage. */
export const TEXTILE_RULES_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  quality_inspector: [TEXTILE_RULES_MANAGE],
})
