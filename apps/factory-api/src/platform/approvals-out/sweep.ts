import type { FactoryDatabase } from '@nexus/factory-db'
import type { ApprovalKind } from '@nexus/factory-domain/approvals-out/kinds'
import { newId } from '@nexus/factory-domain/core/ids'
import { callerFor, COMMAND_SETTINGS, runCommand } from '../../core/command'
import { defineCron, type CronJob } from '../../core/cron'
import type { Log } from '../../core/queue'
import { serverClock, type Clock } from '../../core/time'
import { activeTenants, systemContext } from '../outbox/system'
import { closeTasksInCommand } from '../portal/tasks/store'
import { SETTLE_ACTION, settleRequest } from './settle'
import { RECORD, revokeLinksInCommand, sourceKeyOf } from './store'

/**
 * The approvals' clock (B-W2b-184), scheduler cron `approvalsOut.sweep` (every 10 minutes), per ACTIVE tenant in its system
 * scope:
 *   expire   every OPEN request past its due time: EXPIRED (the database refuses it earlier), its live link revoked, its
 *            partner task cancelled, approval_request.expired — one command per request, so one that fails never holds
 *            the others
 *   settle   every request answered in the last 7 days whose settle never committed (no `approvalsOut.settle` audit row:
 *            the answer's own settle failed after the partner's command): settled now (./settle.ts, idempotent)
 */

const BATCH = 200
const SETTLE_WINDOW_MS = 7 * 86_400_000

export interface SweepOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

export async function sweepApprovals(options: SweepOptions): Promise<{ readonly expired: number; readonly settled: number; readonly failed: number }> {
  const clock = options.clock ?? serverClock
  const now = clock.now()
  const result = { expired: 0, settled: 0, failed: 0 }
  for (const tenantId of await activeTenants(options.database)) {
    const caller = callerFor(options.database, systemContext(tenantId, `approvals-sweep-${newId()}`))
    try {
      const due = await caller.withClient((client) => client.approvalRequest.findMany({ where: { status: 'OPEN', dueAt: { lte: now } }, orderBy: [{ dueAt: 'asc' }, { id: 'asc' }], take: BATCH, select: { id: true } }))
      for (const { id } of due) {
        try {
          const { result: expired } = await runCommand(
            caller,
            { name: 'approvalsOut.expire', input: { requestId: id } },
            async (tools) => {
              const row = await tools.tx.approvalRequest.findUnique({ where: { id }, select: { id: true, companyId: true, kind: true, recordType: true, recordId: true, partyId: true, status: true, dueAt: true, version: true } })
              if (!row || row.status !== 'OPEN' || row.dueAt.getTime() > tools.now.getTime()) return false
              await tools.tx.approvalRequest.update({ where: { id }, data: { status: 'EXPIRED', version: row.version + 1, updatedAt: tools.now }, select: { id: true } })
              const revoked = await revokeLinksInCommand(tools, row, null)
              await closeTasksInCommand(tools, { recordType: RECORD, recordId: id, sourceKey: sourceKeyOf(id), status: 'CANCELLED', doneById: null })
              tools.audit({ recordType: RECORD, recordId: id, companyId: row.companyId, before: { status: 'OPEN' }, after: { status: 'EXPIRED', linksRevoked: revoked.length } })
              tools.emit({ type: 'approval_request.expired', subject: id, companyId: row.companyId, payload: { requestId: id, kind: row.kind as ApprovalKind, recordType: row.recordType, recordId: row.recordId, partyId: row.partyId } })
              return true
            },
            { ...COMMAND_SETTINGS, clock },
          )
          if (expired) result.expired += 1
        } catch (error) {
          result.failed += 1
          options.log.error({ err: error, tenantId, requestId: id }, 'an approval request could not be expired')
        }
      }
      const answered = await caller.withClient(async (client) => {
        const rows = await client.approvalRequest.findMany({ where: { answeredAt: { gte: new Date(now.getTime() - SETTLE_WINDOW_MS) } }, orderBy: [{ answeredAt: 'asc' }, { id: 'asc' }], take: BATCH, select: { id: true } })
        if (rows.length === 0) return []
        const settled = new Set((await client.auditLog.findMany({ where: { action: SETTLE_ACTION, recordType: RECORD, recordId: { in: rows.map((row) => row.id) } }, select: { recordId: true } })).map((row) => row.recordId))
        return rows.filter((row) => !settled.has(row.id))
      })
      for (const { id } of answered) {
        try {
          if ((await settleRequest(caller, id, clock)).settled) result.settled += 1
        } catch (error) {
          result.failed += 1
          options.log.error({ err: error, tenantId, requestId: id }, 'an answered approval request could not be settled')
        }
      }
    } catch (error) {
      result.failed += 1
      options.log.error({ err: error, tenantId }, 'the approval requests of a tenant could not be swept')
    }
  }
  return result
}

export function approvalsSweepCron(options: SweepOptions): CronJob {
  return defineCron({
    name: 'approvalsOut.sweep',
    schedule: '*/10 * * * *',
    lockTtlMs: 540_000,
    async run() {
      const result = await sweepApprovals(options)
      if (result.expired + result.settled + result.failed > 0) options.log.info({ ...result }, 'approval requests swept')
    },
  })
}
