import type { Permission } from '../../core/permissions'

/**
 * The PPE register's permissions (B-W1-43; QHS-118; Reg. (EU) 2016/425 art. 8(4)). Declared with their descriptions in
 * `auth/permissions/catalogue.ts` (COMPLIANCE_DEFINITIONS), checked with can() against the entry's company and the party
 * that reported it (an entry nobody outside reported has no party: every party). Office only: the floor and the portal
 * read nothing of the register.
 */

/** See the register: its entries, what each concerns and where those garments went (the trace to shipments and customers). */
export const REGISTER_VIEW = 'compliance.register.view' satisfies Permission
/** Record complaints, non-conformities and recalls; edit an open entry; record the corrective action, the information to distributors and the notice to the authority; close it. */
export const REGISTER_MANAGE = 'compliance.register.manage' satisfies Permission

export const REGISTER_PERMISSIONS = [REGISTER_VIEW, REGISTER_MANAGE] as const
