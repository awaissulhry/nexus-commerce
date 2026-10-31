import type { FactoryDatabase, Prisma } from '@nexus/factory-db'
import { events as alertEvents } from '@nexus/factory-domain/alerts/events'
import { KINDS, thresholdOf } from '@nexus/factory-domain/alerts/kinds'
import { ADDED_STAGES } from '@nexus/factory-domain/compliance/renewals/rules'
import { newId } from '@nexus/factory-domain/core/ids'
import { eventFor } from '@nexus/factory-domain/events/define'
import { callerFor, COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSettings } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { activeTenants, systemContext } from '../../../platform/outbox/system'
import { tenantIdOf } from '../../../platform/alerts/store'

/**
 * The renewal stages (B-W2a-66; QHS-105: alerts 180, 90 and 30 days before a certificate's last valid day, through B-W2a-33's
 * exception rules and date timers). Every tenant has the built-in CERTIFICATE_EXPIRING rule (30 days, the alert engine
 * makes it); this pass adds the 180- and 90-day rules ONCE per tenant, telling the same system role (quality inspector)
 * by the bell, at most once a day per certificate. From then on they are the tenant's: edited or switched off in the
 * rules like any other, never made again (the pass's audit row marks the tenant done). A tenant that already has a
 * CERTIFICATE_EXPIRING rule with those days keeps it and gets no copy.
 *
 * The alert engine then keeps one timer per certificate and rule (`CERTIFICATE_EXPIRY:-180d` …) and the timers raise
 * the alerts (platform/alerts, platform/timers): one open alert per certificate at a time; when it was resolved, the
 * next stage raises a new one. Scheduler only: the clustered cron `compliance.renewalStages` (hourly, one replica).
 */

export const STAGES_COMMAND = 'compliance.renewals.stageRules'
const [, , , , , ruleChanged] = alertEvents

/** Whether the tenant had its stage rules made already (the pass's audit row). */
async function done(caller: CommandCaller): Promise<boolean> {
  return (await caller.withClient((db) => db.auditLog.findFirst({ where: { action: STAGES_COMMAND }, select: { id: true } }))) !== null
}

/** Makes the tenant's 180- and 90-day rules (once); how many were made. */
export async function ensureStageRules(caller: CommandCaller, settings: CommandSettings): Promise<number> {
  if (await done(caller)) return 0
  const spec = KINDS.CERTIFICATE_EXPIRING
  const { result } = await runCommand(
    caller,
    // One per tenant: a second pass answers from the receipt (and later from the audit row above).
    { name: STAGES_COMMAND, idempotencyKey: 'certificate-renewal-stage-rules', input: { stages: ADDED_STAGES.map((stage) => stage.daysBefore) } },
    async (tools) => {
      const { tx, now } = tools
      const existing = await tx.alertRule.findMany({ where: { ruleKind: 'CERTIFICATE_EXPIRING' }, select: { threshold: true } })
      const days = new Set(existing.map((rule) => (thresholdOf('CERTIFICATE_EXPIRING', rule.threshold) as { daysBefore: number }).daysBefore))
      const role = await tx.role.findFirst({ where: { system: true, audience: 'OFFICE', key: spec.builtIn.recipientRole }, select: { id: true } })
      let made = 0
      for (const stage of ADDED_STAGES) {
        if (days.has(stage.daysBefore)) continue
        const id = newId()
        const threshold = { daysBefore: stage.daysBefore, workingDays: false }
        await tx.alertRule.create({
          data: {
            id,
            ruleKind: 'CERTIFICATE_EXPIRING',
            trigger: 'DATE',
            name: stage.name.en,
            threshold: threshold as Prisma.InputJsonValue,
            severity: stage.severity,
            recipientRoleId: role?.id ?? null,
            channels: ['IN_APP'],
            cooldownMinutes: spec.builtIn.cooldownMinutes,
            enabled: true,
            builtIn: false,
            createdAt: now,
            updatedAt: now,
          },
          select: { id: true },
        })
        tools.audit({ action: 'compliance.renewals.stageRule', recordType: 'AlertRule', recordId: id, companyId: null, after: { ruleKind: 'CERTIFICATE_EXPIRING', threshold, recipientRole: spec.builtIn.recipientRole } })
        tools.emit(eventFor(ruleChanged, { subject: id, payload: { ruleId: id, ruleKind: 'CERTIFICATE_EXPIRING', enabled: true, fields: ['created'] } }))
        made++
      }
      tools.audit({ recordType: 'Tenant', recordId: tenantIdOf(tools.context), companyId: null, after: { made, stages: ADDED_STAGES.map((stage) => stage.daysBefore) } })
      return made
    },
    settings,
  )
  return result
}

export interface StagesOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

/** One pass over every active tenant (the cron's tick; tests call it directly). */
export async function runRenewalStages(options: StagesOptions): Promise<{ tenants: number; made: number; failed: number }> {
  const settings: CommandSettings = { ...COMMAND_SETTINGS, clock: options.clock ?? serverClock }
  const requestId = `renewal-stages-${newId()}`
  let made = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    try {
      made += await ensureStageRules(callerFor(options.database, systemContext(tenantId, requestId)), settings)
    } catch (error) {
      failed++
      options.log.error({ err: error, tenantId }, 'the renewal stage rules of a tenant could not be made')
    }
  }
  if (made + failed > 0) options.log.info({ tenants: tenants.length, made, failed }, 'certificate renewal stages made')
  return { tenants: tenants.length, made, failed }
}

/** The scheduler's cron: hourly (a new tenant gets its stages within the hour; the engine's next pass sets the timers). */
export function renewalStagesCron(options: StagesOptions): CronJob {
  return defineCron({
    name: 'compliance.renewalStages',
    schedule: '7 * * * *',
    async run() {
      await runRenewalStages(options)
    },
  })
}
