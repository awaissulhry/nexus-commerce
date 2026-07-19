/**
 * RT.2 — instant-lane enqueue helper for OutboundSyncQueue creators.
 *
 * Before RT.2, a dozen row-creation sites (flat-file saves, listing
 * activation, bulk actions, catalog routes…) inserted PENDING rows and relied
 * solely on the 60s autopilot drain — even with the BullMQ lane live, their
 * pushes waited for the next cron tick. This helper pairs every created row
 * with an instant-lane job whose delay honors the row's OWN holdUntil (so
 * each site's grace-window semantics are preserved exactly), falling back to
 * the drain cron when workers are off or Redis is unreachable (addJobSafely
 * is bounded + circuit-broken and never hangs the caller).
 *
 * Two shapes:
 *   - enqueueOutboundRowsInstant(db, rows)  — createMany + fire (non-tx callers)
 *   - fireOutboundJobs(entries)             — fire-only, for callers that
 *     already created rows (and hold their ids), or that must fire post-commit.
 *
 * createMany cannot return ids, so rows are stamped with a per-call
 * payload.enqueueBatch tag and re-read by it. Batch-tag re-read is exact
 * (unique uuid per call), unlike ordering heuristics.
 */

import { randomUUID } from 'crypto'
import { outboundSyncQueue, addJobSafely } from '../lib/queue.js'
import { logger } from '../utils/logger.js'

export interface OutboundJobEntry {
  id: string
  productId?: string | null
  syncType?: string | null
  holdUntil?: Date | null
}

// Structural typing matching the repo's SharedFanoutDeps precedent — accepts
// PrismaClient or a TransactionClient without fighting Prisma's generics.
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
interface OutboundEnqueueDb {
  outboundSyncQueue: { createMany: Function; findMany: Function }
}

/** Fire an instant-lane job per entry; delay = max(0, holdUntil − now). */
export async function fireOutboundJobs(
  entries: OutboundJobEntry[],
  opts?: { source?: string },
): Promise<void> {
  const now = Date.now()
  for (const e of entries) {
    try {
      await addJobSafely(
        outboundSyncQueue,
        'sync-job',
        {
          queueId: e.id,
          productId: e.productId ?? undefined,
          syncType: e.syncType ?? 'QUANTITY_UPDATE',
          source: opts?.source ?? 'INSTANT_ENQUEUE',
        },
        {
          delay: Math.max(0, (e.holdUntil?.getTime() ?? now) - now),
          jobId: e.id,
        },
      )
    } catch (err) {
      // addJobSafely never throws by contract; belt anyway — the PENDING row
      // is drained by the cron regardless.
      logger.warn('fireOutboundJobs: enqueue failed (cron will drain)', {
        queueId: e.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

/**
 * createMany the rows + fire instant-lane jobs for them. Returns the created
 * entries. `rows` are OutboundSyncQueue create-inputs (payload may be absent).
 */
export async function enqueueOutboundRowsInstant(
  db: OutboundEnqueueDb,
  rows: Array<Record<string, unknown> & { payload?: Record<string, unknown> | null }>,
  opts?: { source?: string; skipDuplicates?: boolean },
): Promise<OutboundJobEntry[]> {
  if (rows.length === 0) return []
  const tag = randomUUID()
  const tagged = rows.map((r) => ({
    ...r,
    payload: { ...((r.payload as Record<string, unknown> | null) ?? {}), enqueueBatch: tag },
  }))
  await db.outboundSyncQueue.createMany({
    data: tagged,
    ...(opts?.skipDuplicates ? { skipDuplicates: true } : {}),
  } as { data: unknown[] })
  const entries = (await db.outboundSyncQueue.findMany({
    where: { payload: { path: ['enqueueBatch'], equals: tag } },
    select: { id: true, productId: true, syncType: true, holdUntil: true },
  })) as OutboundJobEntry[]
  await fireOutboundJobs(entries, { source: opts?.source })
  return entries
}
