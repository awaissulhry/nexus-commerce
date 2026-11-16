import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { callerFor, command, type CommandCaller } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { processFiles, type FilesRuntime } from '../../files/service'
import { activeTenants, systemContext } from '../../outbox/system'

/**
 * B-W2b-GF1 (G274; GDPR art. 5(1)(e)): a person's data package is deleted on its date. The package (requests/package.ts) is
 * made with `StoredFile.deleteAfter` = PACKAGE_KEEP_DAYS after it was made; the scheduler's clustered cron
 * `privacy.purgePackages` (hourly at minute 41), per ACTIVE tenant in its system scope, DELETEs every package whose day came —
 * never one on legal hold or retained (the database refuses it too) — in ONE command with one audit row per file, then removes
 * its object from the store (best effort: a row DELETED is gone for every caller, an object left behind is removed again by the
 * store's own sweep). The request keeps its record of what was sent (the audit row of PACKAGE_READY: sections, files, checksum);
 * a download after the day answers PACKAGE_DELETED in words, and an open request may collect again.
 */

export const PURGE_PACKAGES_JOB = 'privacy.purgePackages'
export const PURGE_PACKAGES_SCHEDULE = '41 * * * *'

const BATCH = 500
const FILE_COLUMNS = { id: true, companyId: true, recordId: true, status: true, storeAccountId: true, storageKey: true, retainUntil: true, deleteAfter: true } as const

export interface PurgePackagesOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
  /** The file store (tests); by default the process's. */
  readonly files?: FilesRuntime
}

/** One tenant: the packages whose day came, deleted (the cron's work; tests call it). */
export async function purgePackagesOf(caller: CommandCaller, files: FilesRuntime | null, now: Date): Promise<number> {
  const due = await caller.withClient((db) =>
    db.storedFile.findMany({
      where: { recordType: 'DataRequest', deleteAfter: { lte: now }, status: { not: 'DELETED' }, legalHold: false, OR: [{ retainUntil: null }, { retainUntil: { lte: now } }] },
      select: FILE_COLUMNS,
      orderBy: { id: 'asc' },
      take: BATCH,
    }),
  )
  if (due.length === 0) return 0
  await command(caller, { name: 'privacy.purgePackages', input: { at: toUtcIso(now), files: due.length } }, async ({ tx, audit, now: at }) => {
    for (const row of due) {
      await tx.storedFile.update({ where: { id: row.id }, data: { status: 'DELETED', deletedAt: at }, select: { id: true } })
      audit({ action: 'files.delete', recordType: 'StoredFile', recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status: 'DELETED', requestId: row.recordId }, reason: "A person's data package: its delete date came (GDPR art. 5(1)(e))." })
    }
    return null
  })
  if (files) {
    for (const row of due) {
      // The row is DELETED: an object left behind is invisible, removed again by a later sweep.
      await files.storage.remove(caller, row.storeAccountId, { key: row.storageKey, legalHold: false, retainUntil: row.retainUntil }, now).catch(() => undefined)
    }
  }
  return due.length
}

/** One tick over every active tenant (the cron's; tests call it directly). */
export async function runPurgePackages(options: PurgePackagesOptions): Promise<{ deleted: number }> {
  const now = (options.clock ?? serverClock).now()
  const requestId = `purge-packages-${newId()}`
  let files: FilesRuntime | null = options.files ?? null
  if (!files) {
    try {
      files = processFiles()
    } catch {
      files = null
    }
  }
  let deleted = 0
  for (const tenantId of await activeTenants(options.database)) {
    const caller = callerFor(options.database, systemContext(tenantId, requestId))
    try {
      deleted += await purgePackagesOf(caller, files, now)
    } catch (error) {
      options.log.error({ err: error, tenantId }, 'the data packages of a tenant could not be purged; tried again next hour')
    }
  }
  if (deleted > 0) options.log.info({ deleted }, 'data packages purged on their date')
  return { deleted }
}

/** The scheduler's cron: every hour at minute 41. */
export function purgePackagesCron(options: PurgePackagesOptions): CronJob {
  return defineCron({
    name: PURGE_PACKAGES_JOB,
    schedule: PURGE_PACKAGES_SCHEDULE,
    lockTtlMs: 600_000,
    async run() {
      await runPurgePackages(options)
    },
  })
}
