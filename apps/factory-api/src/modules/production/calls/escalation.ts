import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { ESCALATING_STATUSES, ESCALATION_LOOK_BACK_MINUTES, escalationDue, minutesOpen } from '@nexus/factory-domain/production/baskets/signals'
import type { CallKind } from '@nexus/factory-domain/production/calls/rules'
import { callerFor, COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSettings, type CommandTools, type CommandTx } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { activeTenants, systemContext } from '../../../platform/outbox/system'

/**
 * The escalation of help calls nobody came to (owb- order workflow, S5 fl3 step 2; R53; design "after 10 min: It is at the office
 * now"; the plant's pattern, modules/plant/requests/escalation.ts). Every minute, per tenant, as its system: each OPEN call nobody
 * is on the way to (SENT, SEEN), not escalated yet, sent within the look-back, whose type names minutes that have passed
 * (factory-domain production/baskets/signals `escalationDue`), is escalated in ONE system command keyed `call-escalate:<call>`
 * (a second tick answers from its receipt): the call locked, read again, `escalatedAt` set ONCE (the …_floor_work_w2b_guards
 * trigger refuses a second time and any change of a SOLVED or CANCELLED call), the audit row and `help_call.escalated`, whose
 * notice tells the office (./notices.ts `calls.escalated`). ON_THE_WAY, SOLVED and CANCELLED never escalate.
 *
 * NOT REGISTERED YET: the scheduler's job list (apps/factory-api/src/background.ts) is not S5's file — the line
 * `crons.push(callEscalationCron({ database, log }))` beside `escalationCron` is asked for in LF/shared-asks.md (2026-11-28,
 * S5-server-B). Until then nothing runs it. Never run it locally against a shared database (Commerce hard rule 2).
 */

export interface CallEscalationOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

/** Nothing is due any more (seen inside the command): nothing written. */
class NothingDue extends Error {}

const CANDIDATE = {
  id: true,
  siteId: true,
  typeId: true,
  stationId: true,
  lineId: true,
  workOrderId: true,
  bundleId: true,
  status: true,
  sentAt: true,
  escalatedAt: true,
  station: { select: { companyId: true } },
  type: { select: { code: true, kind: true, responderTeamId: true, escalateAfterMinutes: true } },
} as const

async function candidates(db: CommandTx, now: Date) {
  return db.helpCall.findMany({
    where: { status: { in: [...ESCALATING_STATUSES] }, escalatedAt: null, type: { escalateAfterMinutes: { not: null } }, sentAt: { gte: new Date(now.getTime() - ESCALATION_LOOK_BACK_MINUTES * 60_000) } },
    orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
    take: 500,
    select: CANDIDATE,
  })
}

/** Escalates one call when it is due, in its own system command; false when nothing was due. */
async function escalateOne(caller: CommandCaller, callId: string, settings: CommandSettings): Promise<boolean> {
  try {
    await runCommand(
      caller,
      { name: 'production.escalateCall', idempotencyKey: `call-escalate:${callId}`, input: { callId } },
      async (tools: CommandTools) => {
        const { tx, now } = tools
        await tx.$queryRaw`SELECT "id" FROM "HelpCall" WHERE "id" = ${callId}::uuid FOR UPDATE`
        const row = await tx.helpCall.findUnique({ where: { id: callId }, select: CANDIDATE })
        if (!row || !escalationDue(row, row.type.escalateAfterMinutes, now)) throw new NothingDue()
        await tx.helpCall.update({ where: { id: row.id }, data: { escalatedAt: now, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
        const scope = { companyId: row.station.companyId, siteId: row.siteId }
        const minutes = minutesOpen(row.sentAt, now)
        tools.audit({ action: 'production.escalateCall', recordType: 'HelpCall', recordId: row.id, ...scope, before: { escalatedAt: null }, after: { escalatedAt: toUtcIso(now), status: row.status, minutes, escalateAfterMinutes: row.type.escalateAfterMinutes } })
        tools.emit({
          type: 'help_call.escalated',
          subject: row.id,
          ...scope,
          payload: { callId: row.id, typeId: row.typeId, code: row.type.code, kind: row.type.kind as CallKind, stationId: row.stationId, lineId: row.lineId, responderTeamId: row.type.responderTeamId, workOrderId: row.workOrderId, bundleId: row.bundleId, minutes },
        })
        return { callId: row.id, minutes }
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
export async function runCallEscalation(options: CallEscalationOptions): Promise<{ readonly tenants: number; readonly escalated: number; readonly failed: number }> {
  const settings: CommandSettings = { ...COMMAND_SETTINGS, clock: options.clock ?? serverClock }
  const requestId = `call-escalate-${newId()}`
  let escalated = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    const caller = callerFor(options.database, systemContext(tenantId, requestId))
    const now = settings.clock.now()
    const rows = await caller.withClient((client) => candidates(client as CommandTx, now))
    for (const row of rows) {
      if (!escalationDue(row, row.type.escalateAfterMinutes, now)) continue
      try {
        if (await escalateOne(caller, row.id, settings)) escalated++
      } catch (error) {
        failed++
        options.log.error({ err: error, tenantId, callId: row.id }, 'a help call could not be escalated')
      }
    }
  }
  if (escalated + failed > 0) options.log.info({ tenants: tenants.length, escalated, failed }, 'help calls escalated')
  return { tenants: tenants.length, escalated, failed }
}

/** The clustered cron (scheduler only; one replica per tick): every minute. Registered in background.ts by its owner (above). */
export function callEscalationCron(options: CallEscalationOptions): CronJob {
  return defineCron({
    name: 'production.escalateCalls',
    schedule: '* * * * *',
    async run() {
      await runCallEscalation(options)
    },
  })
}
