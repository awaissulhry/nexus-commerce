/**
 * Sheet publish parity, step 5 — resume publication batches that lost their sender.
 *
 * A batch header keeps a heartbeat (`nextCheckAt`) while it is QUEUED or sending. When a worker, or the API process
 * running a batch inline, stops mid-way, the heartbeat goes stale and this job queues the batch again. The run that
 * follows claims the header and sends only reviews still in PREVIEW, so nothing is ever sent twice; a review left
 * PUBLISHING by the crash is the result sweep's (its 30-minute rule).
 *
 * - Clustered (hard rule 7): one tick per business per schedule, on one replica.
 * - A queued batch is pushed back by one heartbeat when it is re-queued, so a busy queue is not flooded.
 *
 * Schedule: NEXUS_PUBLICATION_BATCH_RESUME_SCHEDULE (default every minute). NEXUS_PUBLICATION_BATCH_RESUME=0 turns it off.
 */
import cron from '../lib/cron/clustered.js'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { BATCH_HEARTBEAT_MS, BATCH_KIND } from '../services/pim/publication-batch.processor.js'
import { dispatchPublicationBatch } from '../services/pim/publication-batch.service.js'

const PER_TICK = 20
let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export interface PublicationBatchResumeTick { stale: number; requeued: number }

/** One look in the current business. Exported for tests and for a manual run. */
export async function runPublicationBatchResumeTick(now = new Date()): Promise<PublicationBatchResumeTick> {
  const stale = await prisma.bulkOperation.findMany({
    where: { kind: BATCH_KIND, status: { in: ['QUEUED', 'RUNNING', 'CANCELLING'] }, nextCheckAt: { lte: now } },
    orderBy: [{ nextCheckAt: 'asc' }, { createdAt: 'asc' }],
    take: PER_TICK,
    select: { id: true, status: true, nextCheckAt: true },
  })
  const tick: PublicationBatchResumeTick = { stale: stale.length, requeued: 0 }
  for (const row of stale) {
    // A QUEUED batch is pushed back one heartbeat (the run claims it). A RUNNING one keeps its stale heartbeat, which
    // is what lets the next run claim it; a second tick before that run starts queues it again, harmlessly.
    if (row.status === 'QUEUED') {
      const moved = await prisma.bulkOperation.updateMany({ where: { id: row.id, status: 'QUEUED', nextCheckAt: row.nextCheckAt },
        data: { nextCheckAt: new Date(now.getTime() + BATCH_HEARTBEAT_MS) } })
      if (!moved.count) continue
    }
    try {
      await dispatchPublicationBatch(row.id)
      tick.requeued += 1
    } catch (error) {
      logger.warn('[publication-batch-resume] could not queue a batch; the next tick tries again', { batchId: row.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  if (tick.stale) logger.info('[publication-batch-resume] tick', { ...tick })
  return tick
}

export function startPublicationBatchResumeCron(): void {
  if (process.env.NEXUS_PUBLICATION_BATCH_RESUME === '0') {
    logger.info('publication-batch-resume cron: off (NEXUS_PUBLICATION_BATCH_RESUME=0)')
    return
  }
  if (scheduledTask) {
    logger.warn('publication-batch-resume cron already started')
    return
  }
  const schedule = process.env.NEXUS_PUBLICATION_BATCH_RESUME_SCHEDULE ?? '* * * * *'
  if (!cron.validate(schedule)) {
    logger.error('publication-batch-resume cron: invalid schedule', { schedule })
    return
  }
  scheduledTask = cron.schedule(schedule, async () => {
    await recordCronRun('publication-batch-resume', async () => {
      const r = await runPublicationBatchResumeTick()
      return `stale=${r.stale} requeued=${r.requeued}`
    })
  })
  logger.info('publication-batch-resume cron: scheduled', { schedule })
}

export function stopPublicationBatchResumeCron(): void {
  if (scheduledTask) {
    scheduledTask.stop()
    scheduledTask = null
  }
}
