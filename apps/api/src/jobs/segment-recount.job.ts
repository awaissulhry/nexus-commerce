/**
 * CI.2 — Segment Recount cron.
 *
 * Runs weekly (Sunday 01:00 UTC). Recounts all CustomerSegment rows
 * so the count stays fresh. Operators can also trigger on-demand via
 * POST /api/customers/segments/:id/evaluate.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { recountAllSegments } from '../services/customer-segment.service.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runSegmentRecountOnce(): Promise<string> {
  const result = await recountAllSegments(prisma)
  return `recounted=${result.recounted}`
}

export async function runSegmentRecountCron(): Promise<void> {
  try {
    await recordCronRun('segment-recount', async () => {
      const summary = await runSegmentRecountOnce()
      logger.info('segment-recount cron: completed', { summary })
      return summary
    })
  } catch (err) {
    logger.error('segment-recount cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startSegmentRecountCron(): void {
  if (scheduledTask) return
  const schedule = process.env.NEXUS_SEGMENT_RECOUNT_SCHEDULE ?? '0 1 * * 0'
  scheduledTask = cron.schedule(schedule, () => {
    void runSegmentRecountCron()
  })
  logger.info('segment-recount cron: scheduled', { schedule })
}
