import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { callerFor, command } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { activeTenants, asSystem, systemContext } from '../../outbox/system'
import { emitWorked } from './store'

/**
 * Follow-ups that came with no answer (B-W2b-394; COL-027 "a follow-up that cancels itself when the partner replies"): the
 * scheduler's clustered cron `emailIn.followUps`, every 15 minutes. A team-inbox mail whose follow-up time passed — the partner
 * did not answer in its thread meanwhile, else the database would have cleared it (B-W2b-366) — comes back: open again (not
 * closed, not snoozed), the follow-up done. ONE command per mail, re-checked under its lock (an answer that arrived at the same
 * moment wins), with its audit row and email.inbound_worked FOLLOW_UP_DUE (its assignee, else the inbox's members, are told).
 * At most 500 mails a tenant a run, the oldest first.
 */

export interface FollowUpOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

const RUN_LIMIT = 500

export async function runFollowUps(options: FollowUpOptions): Promise<{ readonly tenants: number; readonly due: number; readonly failed: number }> {
  const clock = options.clock ?? serverClock
  const requestId = `mail-follow-ups-${newId()}`
  let due = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    try {
      const now = clock.now()
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      const mails = await asSystem(options.database, tenantId, requestId, (client) =>
        client.inboundEmail.findMany({ where: { followUpUntil: { lte: now }, status: { not: 'REJECTED' } }, select: { id: true }, orderBy: [{ followUpUntil: 'asc' }, { id: 'asc' }], take: RUN_LIMIT }),
      )
      for (const { id } of mails) {
        try {
          const { result } = await command(caller, { name: 'emailIn.followUpDue', input: { inboundEmailId: id } }, async (tools) => {
            const { tx } = tools
            await tx.$queryRaw`SELECT id FROM "InboundEmail" WHERE id = ${id}::uuid FOR UPDATE`
            const mail = await tx.inboundEmail.findUniqueOrThrow({ where: { id }, select: { id: true, companyId: true, status: true, teamInboxId: true, assigneeId: true, closedAt: true, snoozedUntil: true, followUpUntil: true } })
            if (mail.status === 'REJECTED' || mail.followUpUntil === null || mail.followUpUntil.getTime() > tools.now.getTime()) {
              tools.audit({ action: 'emailIn.followUpSkipped', recordType: 'InboundEmail', recordId: id, companyId: mail.companyId })
              return false
            }
            await tx.inboundEmail.update({ where: { id }, data: { followUpUntil: null, closedAt: null, closedById: null, snoozedUntil: null, version: { increment: 1 } }, select: { id: true } })
            tools.audit({
              recordType: 'InboundEmail',
              recordId: id,
              companyId: mail.companyId,
              before: { followUpUntil: toUtcIso(mail.followUpUntil), closedAt: mail.closedAt ? toUtcIso(mail.closedAt) : null, snoozedUntil: mail.snoozedUntil ? toUtcIso(mail.snoozedUntil) : null },
              after: { followUpUntil: null, closedAt: null, snoozedUntil: null, change: 'FOLLOW_UP_DUE' },
            })
            emitWorked(tools, mail, mail.teamInboxId, 'FOLLOW_UP_DUE', mail.assigneeId, null)
            return true
          })
          if (result) due++
        } catch (error) {
          failed++
          options.log.error({ err: error, tenantId, inboundEmailId: id }, 'a follow-up that came could not bring its mail back')
        }
      }
    } catch (error) {
      failed++
      options.log.error({ err: error, tenantId }, 'the follow-ups of a tenant could not be read')
    }
  }
  return { tenants: tenants.length, due, failed }
}

/** The scheduler's cron (every 15 minutes). */
export function followUpsCron(options: Omit<FollowUpOptions, 'clock'>): CronJob {
  return defineCron({
    name: 'emailIn.followUps',
    schedule: '*/15 * * * *',
    async run() {
      const result = await runFollowUps(options)
      if (result.due + result.failed > 0) options.log.info({ ...result }, 'mail follow-ups that came')
    },
  })
}
