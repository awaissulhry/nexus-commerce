import type { Permission } from '../../core/permissions'
import { definePartnerPermissions } from '../../auth/partners/permissions'

/**
 * Subcontractor jobs in the portal (B-W2b-176; SCM-154 "Job list", SCM-155 "Confirm kit received", SCM-156 "Report progress
 * and finished quantity", SCM-157 "Announce return delivery"; design portal.supplier.jobs). The PARTNER's (area `portal`,
 * flagged `partner`: held only by partner roles; given to the workshop's Jobs role, its Admin follows):
 *
 *   jobs.view   see our jobs for your workshop: the operations with their pieces per size, the dates, the kit we sent you,
 *               your progress so far and what you sent back; never a fee, price, cost or amount (Owner answer C2: the
 *               partner role cannot read them). What the person may also DO follows the capabilities beside the role
 *               (B-W2b-162: a portal write checks its page's permission AND the capability its verb takes):
 *                 portal.approve  accept or decline a job (with another due date), confirm the kit received
 *                 portal.comment  report finished pieces, announce what comes back
 *                 portal.upload   a photo of a missing or damaged kit item
 *
 * The office's own acts (answer a proposed date, send the job link, act for a workshop without e-mail: Owner answer C3) take
 * the subcontracting permissions that already exist (purchasing.subcontract.manage, …receive): no new office permission.
 */
export const PORTAL_JOBS_DEFINITIONS = definePartnerPermissions('portal', {
  'jobs.view': {
    risk: 'read',
    description: 'See our jobs for your workshop: operations, pieces per size, dates, the kit we sent and your progress; accept, confirm the kit, report and announce the send-back when your access allows. Never a price.',
  },
})

export const PORTAL_JOBS_VIEW = 'portal.jobs.view' satisfies Permission
export const PORTAL_JOBS_PERMISSIONS: readonly Permission[] = Object.freeze([PORTAL_JOBS_VIEW])
