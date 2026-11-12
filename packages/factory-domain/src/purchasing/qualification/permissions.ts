import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Supplier qualification, the document vault and the compliance gate on a PO (B-W2b-315; SCM-020, SCM-022, SCM-027; design
 * purchasing.suppliers › Documents & qualification, purchasing.orders › "Send without a valid document?"). Office only
 * (area `purchasing`). Reading the vault and the qualifications is parties.view (the supplier record is the party record),
 * checked with can() over the supplier's company AND the supplier; asking to send an order without its documents is
 * purchasing.send (whoever may send it). Two permissions of their own:
 *
 *   qualification.manage  qualify a supplier or workshop for kinds of work, operations or kinds of material on its
 *                         evidence (the accepted questionnaire, accepted documents, a visit report): decide it once
 *                         (approved, with conditions, refused), suspend it with why, lift it, withdraw it. The buyer and
 *                         the quality inspector.
 *   compliance.override   say yes or no to a colleague's request to send a purchase order without a valid document (a
 *                         chromium VI test report, a protector's certificate, a document a company rule asks), as the
 *                         second person (with step-up for a yes): never one's own request, the Owner included. The quality
 *                         inspector.
 */
export const QUALIFICATION_DEFINITIONS = definePermissions('purchasing', {
  'qualification.manage': {
    risk: 'write',
    description: 'Qualify a supplier or workshop for kinds of work, operations or kinds of material on its evidence (accepted questionnaire, documents, a visit report); decide, suspend, lift or withdraw it.',
  },
  'compliance.override': {
    risk: 'stepUp',
    description: "Say yes (with step-up) or no to a colleague's request to send a purchase order without a valid document it needs; never your own request.",
  },
})

export const PURCHASING_QUALIFICATION_MANAGE = 'purchasing.qualification.manage' satisfies Permission
export const PURCHASING_COMPLIANCE_OVERRIDE = 'purchasing.compliance.override' satisfies Permission

export const QUALIFICATION_PERMISSIONS: readonly Permission[] = Object.freeze([PURCHASING_QUALIFICATION_MANAGE, PURCHASING_COMPLIANCE_OVERRIDE])

/** The role templates that hold them (the owner holds every office permission). */
export const QUALIFICATION_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  buyer: [PURCHASING_QUALIFICATION_MANAGE],
  quality_inspector: [PURCHASING_QUALIFICATION_MANAGE, PURCHASING_COMPLIANCE_OVERRIDE],
})
