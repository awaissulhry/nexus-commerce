import type { FactoryDatabase } from '@nexus/factory-db'
import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { EXPORT_LIMITS } from '@nexus/factory-domain/views/exports'
import { callerFor, command } from '../../core/command'
import { defineCron, type CronJob } from '../../core/cron'
import type { Log } from '../../core/queue'
import { serverClock, type Clock } from '../../core/time'
import { processFiles, type FilesRuntime } from '../files/service'
import { activeTenants, asSystem, systemContext } from '../outbox/system'
import { moveJob } from './jobs'
import { failExport } from './worker'

/**
 * The exports' sweep (B-W2a-23; PLT-179): the scheduler's clustered cron `exports.expire`, every hour, per ACTIVE
 * tenant in its system context:
 *   - a DONE job past its expiresAt: ONE command exports.expire moves its file AVAILABLE → DELETED (the StoredFile row
 *     stays, as every deleted file's does) and the job DONE → EXPIRED (fileId kept); then the object is removed from the
 *     store (best effort: a left-over object is invisible, and the gateway's ledger records the failure);
 *   - a RUNNING job no worker touched for EXPORT_LIMITS.stuckMinutes: FAILED "stopped half way" (the person exports
 *     again; a worker that comes back finds it FAILED and stops).
 * At most 200 of each per tenant and tick; the next tick takes the rest.
 */

export interface ExpireOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
  readonly files?: FilesRuntime
}

export interface ExpireResult {
  readonly expired: number
  readonly stuck: number
  readonly failed: number
}

const BATCH = 200

/** One tick over every active tenant (the cron's; tests call it directly). */
export async function expireExports(options: ExpireOptions): Promise<ExpireResult> {
  const now = (options.clock ?? serverClock).now()
  const requestId = `exports-expire-${newId()}`
  let expired = 0
  let stuck = 0
  let failed = 0
  for (const tenantId of await activeTenants(options.database)) {
    try {
      const due = await asSystem(options.database, tenantId, requestId, async (client) => ({
        done: await client.exportJob.findMany({ where: { status: 'DONE', expiresAt: { lte: now } }, select: { id: true, companyId: true, fileId: true }, orderBy: { expiresAt: 'asc' }, take: BATCH }),
        running: await client.exportJob.findMany({
          where: { status: 'RUNNING', updatedAt: { lt: new Date(now.getTime() - EXPORT_LIMITS.stuckMinutes * 60_000) } },
          select: { id: true, companyId: true, listKey: true, requestedById: true },
          orderBy: { updatedAt: 'asc' },
          take: BATCH,
        }),
      }))
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      for (const job of due.done) {
        try {
          const { result } = await command(caller, { name: 'exports.expire', input: { jobId: job.id }, record: { type: 'ExportJob', id: job.id } }, async (tools) => {
            await moveJob(tools.tx, job.id, 'EXPIRED')
            const file = job.fileId ? await tools.tx.storedFile.findUnique({ where: { id: job.fileId }, select: { id: true, status: true, storeAccountId: true, storageKey: true, legalHold: true, retainUntil: true } }) : null
            if (file && file.status === 'AVAILABLE') {
              await tools.tx.storedFile.update({ where: { id: file.id }, data: { status: 'DELETED', deletedAt: tools.now, version: { increment: 1 } }, select: { id: true } })
              tools.audit({ action: 'files.delete', recordType: 'StoredFile', recordId: file.id, companyId: job.companyId, before: { status: 'AVAILABLE' }, after: { status: 'DELETED' }, reason: `The export's ${EXPORT_LIMITS.keepDays} days are over.` })
            }
            tools.audit({ recordType: 'ExportJob', recordId: job.id, companyId: job.companyId, before: { status: 'DONE' }, after: { status: 'EXPIRED' } })
            return { file: file && file.status === 'AVAILABLE' ? file : null }
          })
          expired++
          if (result.file) {
            try {
              const files = options.files ?? processFiles()
              await files.storage.remove(caller, result.file.storeAccountId, { key: result.file.storageKey, legalHold: result.file.legalHold, retainUntil: result.file.retainUntil }, now)
            } catch (error) {
              options.log.warn({ err: error, tenantId, jobId: job.id }, 'an expired export file could not be removed from the store')
            }
          }
        } catch (error) {
          if (error instanceof InvalidStateError) continue
          failed++
          options.log.error({ err: error, tenantId, jobId: job.id }, 'an export could not be expired')
        }
      }
      for (const job of due.running) {
        try {
          if ((await failExport(caller, job, 'The export stopped half way: export the list again.')) === 'failed') stuck++
        } catch (error) {
          failed++
          options.log.error({ err: error, tenantId, jobId: job.id }, 'a stopped export could not be failed')
        }
      }
    } catch (error) {
      failed++
      options.log.error({ err: error, tenantId }, 'the exports of a tenant could not be swept')
    }
  }
  const result = { expired, stuck, failed }
  if (expired + stuck + failed > 0) options.log.info({ ...result }, 'exports swept')
  return result
}

/** The scheduler's cron: every hour at minute 17. */
export function exportExpiryCron(options: ExpireOptions): CronJob {
  return defineCron({
    name: 'exports.expire',
    schedule: '17 * * * *',
    lockTtlMs: 600_000,
    async run() {
      await expireExports(options)
    },
  })
}
