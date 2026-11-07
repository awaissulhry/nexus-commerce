import type { TaskSource } from './index'

/**
 * B-W2b-176 (SCM-155, SCM-156; design portal.supplier.jobs, portal.frame "confirm a kit, report progress"): the workshop's
 * requests on a subcontract job — confirm the kit we sent (one per kit send) and report progress (once per job) — opened by
 * the kit send, done by the workshop's answer (portal, or the office for a workshop without e-mail), withdrawn when they no
 * longer apply (modules/purchasing/portal-jobs/tasks.ts). Each has its own answer, so the partner never marks it done by hand.
 */
export const SUBCONTRACT_JOBS_SOURCE: TaskSource = Object.freeze<TaskSource>({ name: 'purchasing.subcontractJobs', prefix: 'SubcontractJob', kinds: ['CONFIRM_KIT', 'REPORT_PROGRESS'], partnerDone: false })
