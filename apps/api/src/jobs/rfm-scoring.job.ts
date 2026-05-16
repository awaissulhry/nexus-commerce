/**
 * CI.1 — RFM Scoring cron.
 *
 * Runs nightly at 02:00 UTC. Computes Recency/Frequency/Monetary
 * quintile scores for all customers and writes rfmScore + rfmLabel
 * + rfmComputedAt back to the Customer table.
 *
 * No external dependencies — reads from existing Customer aggregates
 * (totalOrders, totalSpentCents, lastOrderAt). Always on.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { computeRFMForAll } from '../services/customer-rfm.service.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runRFMScoringOnce(): Promise<string> {
  const result = await computeRFMForAll(prisma)
  return `processed=${result.processed} errors=${result.errors}`
}

export async function runRFMScoringCron(): Promise<void> {
  try {
    await recordCronRun('rfm-scoring', async () => {
      const summary = await runRFMScoringOnce()
      logger.info('rfm-scoring cron: completed', { summary })
      return summary
    })
  } catch (err) {
    logger.error('rfm-scoring cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startRFMScoringCron(): void {
  if (scheduledTask) return
  const schedule = process.env.NEXUS_RFM_SCHEDULE ?? '0 2 * * *'
  scheduledTask = cron.schedule(schedule, () => {
    void runRFMScoringCron()
  })
  logger.info('rfm-scoring cron: scheduled', { schedule })
}
