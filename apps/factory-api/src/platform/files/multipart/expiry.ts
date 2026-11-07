import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { callerFor } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { activeTenants, asSystem, systemContext } from '../../outbox/system'
import { readOffice } from '../files'
import { processFiles, type FilesRuntime } from '../service'
import { endLargeUpload, SESSION_SELECT } from './large'

/**
 * The expiry of uploads in parts (COL-052; B-W2b-160): the scheduler's clustered cron `files.expireLargeUploads`, every
 * hour, per ACTIVE tenant in its system context: each session still OPEN after its seven days (expiresAt) is aborted at the
 * store (best effort: R2 gives an unfinished upload up by itself after seven days) and ended EXPIRED, its file DELETED, in
 * one command (large.ts endLargeUpload), at most BATCH per tenant and tick, oldest first. A resume after that starts again.
 */

export interface ExpiryOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
  readonly files?: FilesRuntime
}

const BATCH = 50

export async function expireLargeUploads(options: ExpiryOptions): Promise<{ readonly expired: number; readonly failed: number }> {
  const now = (options.clock ?? serverClock).now()
  const requestId = `files-upload-expiry-${newId()}`
  let expired = 0
  let failed = 0
  for (const tenantId of await activeTenants(options.database)) {
    try {
      const sessions = await asSystem(options.database, tenantId, requestId, (client) =>
        client.fileUploadSession.findMany({ where: { status: 'OPEN', expiresAt: { lte: now } }, select: SESSION_SELECT, orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }], take: BATCH }),
      )
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      for (const session of sessions) {
        try {
          const file = await readOffice(caller, session.fileId)
          await (options.files ?? processFiles()).multipart.abort(caller, file.storeAccountId, file.storageKey, session.uploadId).catch(() => {})
          await endLargeUpload(caller, session, file, 'EXPIRED')
          expired++
        } catch (error) {
          failed++
          options.log.error({ err: error, tenantId, sessionId: session.id }, 'an upload in parts could not be expired')
        }
      }
    } catch (error) {
      failed++
      options.log.error({ err: error, tenantId }, 'the uploads in parts of a tenant could not be expired')
    }
  }
  if (expired + failed > 0) options.log.info({ expired, failed }, 'uploads in parts expired')
  return { expired, failed }
}

/** The scheduler's cron: every hour. */
export function largeUploadExpiryCron(options: ExpiryOptions): CronJob {
  return defineCron({
    name: 'files.expireLargeUploads',
    schedule: '23 * * * *',
    lockTtlMs: 600_000,
    async run() {
      await expireLargeUploads(options)
    },
  })
}
