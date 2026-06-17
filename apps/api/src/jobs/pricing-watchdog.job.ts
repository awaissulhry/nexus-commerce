/**
 * ACP.4b — Pricing Watchdog cron.
 *
 * Schedule: '0 7 * * *' UTC (just after the Listing-Quality Keeper).
 * Runs the autonomous Pricing Watchdog once: it scans active products
 * priced below their floor or below cost and QUEUES set-price proposals
 * (always-ask) that RAISE them to a sane margin. Nothing changes price —
 * an operator approves each proposal.
 *
 * Default-on; opt out with NEXUS_ENABLE_PRICING_WATCHDOG=0. The per-run
 * cap + dedupe live in the agent.
 */

import cron from 'node-cron'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import {
  runAutonomousAgent,
  isAgentScheduleEnabled,
} from '../services/agents/autonomous-agent.service.js'

const JOB = 'pricing-watchdog'
const SCHEDULE = '0 7 * * *'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runPricingWatchdogCron(): Promise<void> {
  try {
    if (!(await isAgentScheduleEnabled('pricing-watchdog'))) {
      logger.info('pricing-watchdog cron: disabled in Control Center — skipping')
      return
    }
    await recordCronRun(JOB, async () => {
      const r = await runAutonomousAgent('pricing-watchdog', 'schedule')
      if (!r.ok) throw new Error(r.error ?? 'agent run failed')
      const s = r.result
      if (s && s.proposed > 0)
        logger.info('pricing-watchdog cron: proposals queued', {
          proposed: s.proposed,
          flagged: s.flagged,
          scanned: s.scanned,
        })
      return s
        ? `scanned=${s.scanned} flagged=${s.flagged} proposed=${s.proposed} skipped=${s.skippedExisting} errors=${s.errors}`
        : 'no result'
    })
  } catch (err) {
    logger.error('pricing-watchdog cron: failure', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function startPricingWatchdogCron(): void {
  if (process.env.NEXUS_ENABLE_PRICING_WATCHDOG === '0') {
    logger.info('pricing-watchdog cron: disabled via env')
    return
  }
  if (scheduledTask) return
  scheduledTask = cron.schedule(SCHEDULE, () => {
    void runPricingWatchdogCron()
  })
  logger.info(`pricing-watchdog cron: scheduled (${SCHEDULE} UTC)`)
}
