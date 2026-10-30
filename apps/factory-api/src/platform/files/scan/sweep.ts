import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { callerFor } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { activeTenants, asSystem, systemContext } from '../../outbox/system'
import { processFiles, type FilesRuntime } from '../service'
import type { VirusScanner } from './port'
import { SCAN_REASONS } from './rules'
import { scanFile, type ScanOutcome } from './scan'
import { processScanner } from './service'

/**
 * The scan sweep (PLT-245; B-W2a-42): the scheduler's clustered cron `files.scanPending`, every 5 minutes, per ACTIVE
 * tenant in its system context: every upload still held for its scan (QUARANTINED `scan_pending`, scan PENDING) for
 * more than a minute — the scanner or the store did not answer when it was confirmed — is scanned again (scan.ts), at
 * most BATCH per tenant and tick, oldest first. While the scanner is still down the files stay held (nothing changes;
 * one log line). A FAILED scan is not retried here: the scanner could not judge the file, a person decides (Try again,
 * or delete it). Without a scanner (FACTORY_VIRUS_SCAN=off) the tick does nothing.
 */

export interface SweepOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
  readonly files?: FilesRuntime
  /** Default: the process's scanner (null: off). */
  readonly scanner?: VirusScanner | null
}

export type SweepResult = Readonly<Record<ScanOutcome | 'failed', number>>

const BATCH = 50
const WAIT_MS = 60_000

export async function sweepPendingScans(options: SweepOptions): Promise<SweepResult> {
  const counts: Record<ScanOutcome | 'failed', number> = { scanned: 0, scanner_unavailable: 0, store_unavailable: 0, not_waiting: 0, failed: 0 }
  const scanner = options.scanner === undefined ? processScanner() : options.scanner
  if (!scanner) return counts
  const now = (options.clock ?? serverClock).now()
  const requestId = `files-scan-sweep-${newId()}`
  for (const tenantId of await activeTenants(options.database)) {
    try {
      const pending = await asSystem(options.database, tenantId, requestId, (client) =>
        client.storedFile.findMany({
          where: { status: 'QUARANTINED', quarantineReason: SCAN_REASONS.pending, scanStatus: 'PENDING', updatedAt: { lt: new Date(now.getTime() - WAIT_MS) } },
          select: { id: true },
          orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
          take: BATCH,
        }),
      )
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      for (const file of pending) {
        try {
          const { outcome } = await scanFile(options.files ?? processFiles(), scanner, caller, file.id)
          counts[outcome]++
          // The scanner is still down: the rest of the tenant's files wait for the next tick.
          if (outcome === 'scanner_unavailable') break
        } catch (error) {
          counts.failed++
          options.log.error({ err: error, tenantId, fileId: file.id }, 'a held upload could not be scanned')
        }
      }
    } catch (error) {
      counts.failed++
      options.log.error({ err: error, tenantId }, 'the held uploads of a tenant could not be swept')
    }
  }
  if (counts.scanned + counts.failed + counts.scanner_unavailable + counts.store_unavailable > 0) options.log.info({ ...counts }, 'held uploads swept')
  if (counts.scanner_unavailable > 0) options.log.warn({ tenants: counts.scanner_unavailable }, 'the virus scanner is not answering: uploads stay held')
  return counts
}

/** The scheduler's cron: every 5 minutes. */
export function scanSweepCron(options: SweepOptions): CronJob {
  return defineCron({
    name: 'files.scanPending',
    schedule: '*/5 * * * *',
    lockTtlMs: 240_000,
    async run() {
      await sweepPendingScans(options)
    },
  })
}
