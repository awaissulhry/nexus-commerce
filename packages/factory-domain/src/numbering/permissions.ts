import type { Permission } from '../core/permissions'

/**
 * The numbering module's permissions (plan A1 §3.11). Issuing a number needs none of its own: it happens inside the
 * command that issues the document (invoices.issue, ddt.issue…), under that command's permission.
 */

/** See the company's series, their next numbers and their state. */
export const NUMBERING_VIEW = 'numbering.view' satisfies Permission
/** Create a series, set where it starts (a paper booklet's hand-over), move it past a number (after a restore). */
export const NUMBERING_MANAGE = 'numbering.manage' satisfies Permission

export const NUMBERING_PERMISSIONS = [NUMBERING_VIEW, NUMBERING_MANAGE] as const
