import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { ESCALATION_LOOK_BACK_MINUTES, escalatedAtOf, escalationDue } from '@nexus/factory-domain/plant/requests/routing'
import { callerFor, COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSettings, type CommandTools, type CommandTx } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { activeTenants, systemContext } from '../../../platform/outbox/system'

/**
 * The escalation of machine requests nobody acknowledged (B-W2b-96; QHS-179; design plant.settings "escalate if not
 * acknowledged in N min → supervisor → maintenance lead", plant.requests "request.escalated → Age tone"). Every minute, per
 * tenant, as its system: each NEW request a rule routed (nobody acknowledged it, its rule still on, reported within the
 * longest escalation) whose escalation fell due by its rule (factory-domain plant/requests/routing escalationDue: level 1 at
 * the report + N minutes, level 2 at + M) is escalated in ONE system command keyed `plant-escalate:<request>:<level>` (a
 * second tick answers from its receipt): the machine row and the request locked (the plant's lock order), read again, the
 * level and the time (always later than the last; never down), the audit row and maintenance_request.escalated, whose
 * notice tells the person it escalated to (./notices.ts). A triaged or acknowledged request is never escalated.
 */

export interface EscalationOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

/** Nothing is due any more (seen inside the command): nothing written. */
class NothingDue extends Error {}

const CANDIDATE = {
  id: true,
  companyId: true,
  siteId: true,
  machineId: true,
  status: true,
  acknowledgedAt: true,
  reportedAt: true,
  escalationLevel: true,
  escalatedAt: true,
  routingRuleId: true,
  machine: { select: { assetNumber: true } },
  routingRule: { select: { active: true, escalateAfterMinutes: true, escalateToId: true, escalateAgainAfterMinutes: true, escalateAgainToId: true } },
} as const

async function candidates(db: CommandTx, now: Date) {
  return db.maintenanceRequest.findMany({
    where: { status: 'NEW', acknowledgedAt: null, routingRuleId: { not: null }, escalationLevel: { lt: 2 }, reportedAt: { gte: new Date(now.getTime() - ESCALATION_LOOK_BACK_MINUTES * 60_000) } },
    orderBy: [{ reportedAt: 'asc' }, { id: 'asc' }],
    take: 500,
    select: CANDIDATE,
  })
}

/** Escalates one request when it is due, in its own system command; false when nothing was due. */
async function escalateOne(caller: CommandCaller, requestId: string, machineId: string, level: number, settings: CommandSettings): Promise<boolean> {
  try {
    await runCommand(
      caller,
      { name: 'plant.escalateRequest', idempotencyKey: `plant-escalate:${requestId}:${level}`, input: { requestId, level } },
      async (tools: CommandTools) => {
        const { tx, now } = tools
        // The plant's lock order: the machine row, then the request.
        await tx.$queryRaw`SELECT "id" FROM "Machine" WHERE "id" = ${machineId}::uuid FOR UPDATE`
        await tx.$queryRaw`SELECT "id" FROM "MaintenanceRequest" WHERE "id" = ${requestId}::uuid FOR UPDATE`
        const row = await tx.maintenanceRequest.findUnique({ where: { id: requestId }, select: CANDIDATE })
        if (!row?.routingRule || !row.routingRuleId) throw new NothingDue()
        const due = escalationDue(row, row.routingRule, now)
        if (!due || due.level !== level || due.level <= row.escalationLevel) throw new NothingDue()
        const escalatedAt = escalatedAtOf(row.escalatedAt, now)
        await tx.maintenanceRequest.update({ where: { id: row.id }, data: { escalationLevel: due.level, escalatedAt, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
        const scope = { companyId: row.companyId, siteId: row.siteId }
        tools.audit({ action: 'plant.escalateRequest', recordType: 'MaintenanceRequest', recordId: row.id, ...scope, before: { escalationLevel: row.escalationLevel }, after: { escalationLevel: due.level, escalatedAt: escalatedAt.toISOString(), escalatedToId: due.toId, ruleId: row.routingRuleId, dueAt: due.dueAt.toISOString() } })
        tools.emit({ type: 'maintenance_request.escalated', subject: row.id, ...scope, payload: { requestId: row.id, machineId: row.machineId, assetNumber: row.machine.assetNumber, level: due.level, ruleId: row.routingRuleId, escalatedToId: due.toId } })
        return { requestId: row.id, level: due.level }
      },
      settings,
    )
    return true
  } catch (error) {
    if (error instanceof NothingDue) return false
    throw error
  }
}

/** One pass over every tenant (the cron's body; tests call it with a moved clock). */
export async function runEscalation(options: EscalationOptions): Promise<{ readonly tenants: number; readonly escalated: number; readonly failed: number }> {
  const settings: CommandSettings = { ...COMMAND_SETTINGS, clock: options.clock ?? serverClock }
  const requestId = `plant-escalate-${newId()}`
  let escalated = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    const caller = callerFor(options.database, systemContext(tenantId, requestId))
    const now = settings.clock.now()
    const rows = await caller.withClient((client) => candidates(client as CommandTx, now))
    for (const row of rows) {
      const due = row.routingRule ? escalationDue(row, row.routingRule, now) : null
      if (!due) continue
      try {
        if (await escalateOne(caller, row.id, row.machineId, due.level, settings)) escalated++
      } catch (error) {
        failed++
        options.log.error({ err: error, tenantId, requestId: row.id }, 'a machine request could not be escalated')
      }
    }
  }
  if (escalated + failed > 0) options.log.info({ tenants: tenants.length, escalated, failed }, 'machine requests escalated')
  return { tenants: tenants.length, escalated, failed }
}

/** The clustered cron (scheduler only; one replica per tick): every minute. */
export function escalationCron(options: EscalationOptions): CronJob {
  return defineCron({
    name: 'plant.escalateRequests',
    schedule: '* * * * *',
    async run() {
      await runEscalation(options)
    },
  })
}
