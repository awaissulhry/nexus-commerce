import type { Prisma } from '@nexus/factory-db'
import { BUSINESS_TIME_ZONE } from '@nexus/factory-domain/core/time'
import type { RunNowPolicy } from '@nexus/factory-domain/integration-health/jobs'

/**
 * The scheduled jobs the jobs page knows (B-W2b-415; PLT-221): every clustered cron background.ts schedules, with its
 * schedule (for the next run) and how Run now may treat it. `catalogue.vitest.test.ts` builds every cron background.ts
 * imports and holds this list to them (name and schedule), so a new cron without its line here fails the test.
 *
 *   check      it checks or catches up: an early run changes nothing the next tick would not (Run now allowed)
 *   schedule   it sends mail or messages to people at their time, or deletes under a person's switch: it runs only on
 *              its schedule (Run now held with why)
 *   gate       Run now waits for an Owner switch: `ecbFeed` = the tenant's ECB connection is switched on (ACTIVE)
 *
 * Words (name, what it does) are the web's, by key (`admin-integration-health.json` aih.job.<key>).
 */

export type JobGate = 'ecbFeed'

export interface JobEntry {
  readonly key: string
  readonly schedule: string
  readonly timeZone: string
  readonly policy: RunNowPolicy
  readonly gate: JobGate | null
}

const job = (key: string, schedule: string, policy: RunNowPolicy, gate: JobGate | null = null): JobEntry => Object.freeze({ key, schedule, timeZone: BUSINESS_TIME_ZONE, policy, gate })

export const JOB_CATALOGUE: readonly JobEntry[] = Object.freeze([
  job('outbox.lag', '* * * * *', 'check'),
  job('roles.syncTemplates', '15 3 * * *', 'check'),
  job('compliance.certificateExpiry', '20 0 * * *', 'check'),
  job('invoicing.sdiPoll', '*/5 * * * *', 'check'),
  job('shipping.trackingPoll', '17 * * * *', 'check'),
  job('planning.nightlyRun', '*/5 * * * *', 'check'),
  job('exports.expire', '17 * * * *', 'check'),
  job('reasons.standardForNewTenants', '25 3 * * *', 'check'),
  job('notifications.digest', '*/15 * * * *', 'schedule'),
  job('alerts.evaluate', '*/5 * * * *', 'check'),
  job('timers.fire', '* * * * *', 'check'),
  job('production.dailyReport', '*/15 * * * *', 'schedule'),
  job('files.scanPending', '*/5 * * * *', 'check'),
  job('purchasing.confirmationReminders', '0 9 * * *', 'schedule'),
  job('purchasing.chaseReminders', '30 9 * * *', 'schedule'),
  job('receivables.ladder', '0 6 * * *', 'schedule'),
  job('payables.sdiPickup', '*/15 * * * *', 'check'),
  job('compliance.renewalStages', '7 * * * *', 'check'),
  job('inventory.reservationsCleanup', '40 2 * * *', 'check'),
  job('people.leaverSteps', '17 * * * *', 'check'),
  job('people.autoClockOut', '*/5 * * * *', 'check'),
  job('people.attendanceDays', '*/15 * * * *', 'check'),
  job('roles.twoFactorSince', '20 3 * * *', 'check'),
  job('email.liftCatchUp', '25 3 * * *', 'check'),
  job('imports.firstLoadCatchUp', '30 3 * * *', 'check'),
  job('costing.catchUp', '20 3 * * *', 'check'),
  job('accounting.integrityNightly', '10 4 * * *', 'check'),
  job('production.stuckBundles', '*/15 * * * *', 'check'),
  job('production.scanFindings', '25 * * * *', 'check'),
  job('plant.escalateRequests', '* * * * *', 'check'),
  job('quality.capaReminders', '*/15 * * * *', 'check'),
  job('plant.checkReminders', '7 * * * *', 'check'),
  job('quality.alertRules', '*/5 * * * *', 'check'),
  job('safety.healthDueList', '40 5 * * *', 'check'),
  job('portal.purgeCodes', '41 * * * *', 'check'),
  job('links.purgeDrafts', '47 * * * *', 'check'),
  job('files.expireLargeUploads', '23 * * * *', 'check'),
  job('partners.accessEnding', '20 7 * * *', 'schedule'),
  job('portalNotifications.digest', '*/15 * * * *', 'schedule'),
  job('portalTasks.remind', '25 * * * *', 'schedule'),
  job('files.remindExpiry', '40 6 * * *', 'schedule'),
  job('approvalsOut.sweep', '*/10 * * * *', 'check'),
  job('approvals.officeMail', '*/5 * * * *', 'schedule'),
  job('sales.measurementPhotos', '17 * * * *', 'check'),
  job('product.smvTakeEffect', '7 * * * *', 'check'),
  job('shipping.systemHolds', '*/30 * * * *', 'check'),
  job('compliance.supplierDeclarations', '35 * * * *', 'schedule'),
  job('compliance.profilesNightly', '50 3 * * *', 'check'),
  job('compliance.claimEvidenceExpiry', '25 0 * * *', 'check'),
  job('inventory.warehouseTaskTimed', '17 * * * *', 'check'),
  job('sales.quoteValidity', '15 6 * * *', 'schedule'),
  job('sales.fittingReminders', '23 * * * *', 'schedule'),
  job('notifications.viewFollow', '*/15 * * * *', 'check'),
  job('tasks.reminders', '* * * * *', 'check'),
  job('currency.ecbDaily', '30 16,18 * * 1-5', 'check', 'ecbFeed'),
  job('emailIn.followUps', '*/15 * * * *', 'check'),
  job('shipping.deliveryCheck', '10 7 * * *', 'check'),
  job('insights.factsHourly', '5 * * * *', 'check'),
  job('insights.factsNightly', '40 2 * * *', 'check'),
  job('privacy.retentionSweep', '50 2 * * *', 'schedule'),
  job('shipping.closeDays', '50 * * * *', 'check'),
  // B-W2b-415: the error queue's collector (platform/admin/errors/collect.ts).
  job('integrations.collectErrors', '* * * * *', 'check'),
])

export function jobEntryOf(key: string): JobEntry | null {
  return JOB_CATALOGUE.find((entry) => entry.key === key) ?? null
}

/** Whether the job's switch is on for this tenant (null: it waits for none). */
export async function switchedOn(client: Prisma.TransactionClient, entry: JobEntry): Promise<boolean | null> {
  if (entry.gate === 'ecbFeed') {
    const account = await client.integrationAccount.findFirst({ where: { provider: 'ECB', status: 'ACTIVE' }, select: { id: true } })
    return account !== null
  }
  return null
}
