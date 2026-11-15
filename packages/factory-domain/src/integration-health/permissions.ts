import { definePermissions } from '../auth/permissions/registry'
import type { Permission } from '../core/permissions'

/**
 * Integration health (B-W2b-415; PLT-196, PLT-201, PLT-221; design admin.connections sec:errors, admin.security sec:jobs):
 *
 *   integrations.errors.manage   the error queue's actions: send a failed message again once (a dead outbox event back to
 *                                its relay, a failed webhook back to processing, a background job that ran out of tries run
 *                                again) or dismiss it with a reason (kept with who and why). Checked with can() against the
 *                                item's company; an item without a company needs a grant over every active company.
 *   security.jobs.run            Run now: a scheduled job that checks or catches up, once in the cluster, for your tenant
 *                                only, as the system (the same claim as its schedule's ticks).
 *
 * Reading: the error queue is integrations.view (Connections & API), the jobs and their runs security.view (Security &
 * health). Test and Reconnect of a connection are integrations.manage (one harmless call through the gateway; Reconnect
 * also forgets the failures in a row of its circuit). Not step-up: nothing here widens what anyone can see or do.
 * Declared in `auth/permissions/catalogue.ts`.
 */
export const INTEGRATION_ERRORS_DEFINITIONS = definePermissions('integrations', {
  'errors.manage': {
    risk: 'write',
    description:
      'Send a failed message again once (a dead event, a failed webhook, a background job that ran out of tries) or dismiss it with a reason; who dismissed it and why stay with it.',
  },
})

export const JOBS_RUN_DEFINITIONS = definePermissions('security', {
  'jobs.run': {
    risk: 'write',
    description: 'Run a scheduled job that checks or catches up now, once, for this business only; a job that sends at a set time or waits for a switch stays on its schedule.',
  },
})

export const INTEGRATIONS_ERRORS_MANAGE = 'integrations.errors.manage' satisfies Permission
export const SECURITY_JOBS_RUN = 'security.jobs.run' satisfies Permission

export const INTEGRATION_HEALTH_PERMISSIONS: readonly Permission[] = Object.freeze([INTEGRATIONS_ERRORS_MANAGE, SECURITY_JOBS_RUN])

/** Who holds them (auth/roles/templates; the owner from every(), the read-only role none: writes): the administrator. */
export const INTEGRATION_HEALTH_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: [INTEGRATIONS_ERRORS_MANAGE, SECURITY_JOBS_RUN],
})
