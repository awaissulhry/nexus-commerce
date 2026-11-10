import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'
import { CERTIFICATES_VIEW } from '../certificates/permissions'

/**
 * Requirements and gates (B-W2b-254; PRD-271, PRD-272, PRD-277; design compliance.settings › rm-gates, compliance.status).
 * Office only (area `compliance`). Reading the requirements, the gate matrix, a gate's answer, the gate refusals and the
 * status board reuses the certificate register's view permission, as Rules & markets does.
 *
 *   requirements.manage  keep the requirements: what is needed per product type, PPE category and market, with its law,
 *                        which gates it blocks and who may override it for how long, switched on or off with the reason.
 *                        Loosening one (a gate no longer blocked, a role added, switched off …) asks the person's step-up;
 *                        the law's padlocks never open. A requirement of every company needs a grant over every company.
 *                        The quality inspector; the owner from every().
 *   gates.override       override a gate's refusal for one work order or shipment, with a written reason, a step-up and an
 *                        end at most the requirement's days away — and only when the requirement names one of the
 *                        person's roles (the requirement decides who; this permission opens the door). The quality
 *                        inspector; the owner from every().
 */
export const REQUIREMENTS_DEFINITIONS = definePermissions('compliance', {
  'requirements.manage': {
    risk: 'write',
    description:
      'Keep the compliance requirements: what is needed per product type, PPE category and market, with its legal reference, which gates it blocks (work-order release, label print, final release, shipment) and who may override it for how long; switch one on or off with the reason. Loosening asks for step-up; the gates the law locks never open.',
  },
  'gates.override': {
    risk: 'write',
    description:
      'Override a compliance gate\'s refusal for one work order or shipment, with a written reason, step-up and an end at most 7 days away — only where the requirement names one of your roles, never at a gate the law locks.',
  },
})

export const REQUIREMENTS_VIEW: Permission = CERTIFICATES_VIEW
export const REQUIREMENTS_MANAGE = 'compliance.requirements.manage' satisfies Permission
export const GATES_OVERRIDE = 'compliance.gates.override' satisfies Permission

export const REQUIREMENTS_PERMISSIONS: readonly Permission[] = Object.freeze([REQUIREMENTS_MANAGE, GATES_OVERRIDE])

/** Who holds them (auth/roles/templates): the quality inspector, beside compliance.rules.manage. */
export const REQUIREMENTS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  quality_inspector: [REQUIREMENTS_MANAGE, GATES_OVERRIDE],
})
