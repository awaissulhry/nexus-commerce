import type { Permission } from '../core/permissions'
import { definePermissions } from '../auth/permissions/registry'

/**
 * The numbering module's permissions (plan A1 §3.11). Issuing a number needs none of its own: it happens inside the
 * command that issues the document (invoices.issue, ddt.issue…), under that command's permission.
 */

/** See the company's series, their next numbers and their state. */
export const NUMBERING_VIEW = 'numbering.view' satisfies Permission
/** Create a series, set where it starts (a paper booklet's hand-over), move it past a number (after a restore). */
export const NUMBERING_MANAGE = 'numbering.manage' satisfies Permission

export const NUMBERING_PERMISSIONS = [NUMBERING_VIEW, NUMBERING_MANAGE] as const

/**
 * B-W2b-24 (PLT-125 "number preview and controlled override"; design admin.documents popup `override`): type the number a
 * MIGRATED document had in the old system (an open order or a lot carried over at go-live) instead of the series' next
 * one. Never a fiscal kind (invoices, credit notes, deposit invoices, DDTs keep their gapless series); a number that is
 * taken, or that the series would give later, is refused at once; the reason is kept in the audit row. Its own definition
 * block (the numbering area's W0 block stays as it was).
 */
export const NUMBERING_OVERRIDE_DEFINITIONS = definePermissions('numbering', {
  override: {
    risk: 'write',
    description: 'Give a migrated document (an open order, a work order or a lot carried over from the old system) the number it had there instead of the next number of its series; never an invoice, credit note or DDT, never a number in use or still to come; the reason is kept.',
  },
})
export const NUMBERING_OVERRIDE = 'numbering.override' satisfies Permission
export const NUMBERING_OVERRIDE_PERMISSIONS: readonly Permission[] = Object.freeze([NUMBERING_OVERRIDE])
