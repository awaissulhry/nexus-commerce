/**
 * ONE BRAIN AB-4 — the daily read of Amazon's own rules on brain campaigns (services/advertising/brain/native-rules.ts,
 * design 2026-10-08-ads-one-brain/DESIGN.md §2.12).
 *
 * Daily at 04:35 UTC: after the night's ads report pulls (report creates 01:15–02:00, gap fill 02:05, the reconcile 03:30)
 * and away from the :00 / :15 / :20 / :45 ticks other ads jobs share, so its few reads never queue behind them. One GET
 * per brain campaign through the channel gateway. NEXUS_ADS_NATIVE_RULES_SCHEDULE moves it, as the other ads crons.
 *
 * It reads only while NEXUS_BID_BRAIN_MODE is live or a product is enrolled in the brain. Otherwise the tick asks Amazon
 * nothing, writes nothing and records no run.
 * Cluster-safe through lib/cron/clustered.ts (hard rule 7); with business profiles on it runs once per business, inside
 * that business.
 */
import cron from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import type { NativeReadSummary } from '../services/advertising/brain/native-rules.js'

export const NATIVE_RULES_SCHEDULE = '35 4 * * *'
export const NATIVE_RULES_JOB = 'ads-native-rules-read'

/** One tick in the business the caller is in. Null when it failed (logged). */
export async function runNativeRulesTick(now: Date = new Date()): Promise<NativeReadSummary | null> {
  try {
    // Loaded at the tick, not when the scheduler boots (runtime/module-load-order.vitest.test.ts).
    const { nativeReadDue, readNativeRulesOnce, nativeReadSummaryLine } = await import('../services/advertising/brain/native-rules.js')
    const due = await nativeReadDue()
    if (!due.due) return { ran: false, why: due.why, campaigns: 0, read: 0, couldNotRead: 0, calls: 0, acting: 0, dropped: 0 }
    let summary: NativeReadSummary | null = null
    await recordCronRun(NATIVE_RULES_JOB, async () => {
      summary = await readNativeRulesOnce({ now })
      return nativeReadSummaryLine(summary)
    })
    return summary
  } catch (error) {
    logger.error('[ads-native-rules] daily read failed', { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

let task: ReturnType<typeof cron.schedule> | null = null
export function startNativeRulesCron(): void {
  if (task) return
  const schedule = process.env.NEXUS_ADS_NATIVE_RULES_SCHEDULE ?? NATIVE_RULES_SCHEDULE
  task = cron.schedule(schedule, async () => { await runNativeRulesTick() }, { lockTtlMs: 10 * 60_000 })
  logger.info(`[ads-native-rules] cron scheduled (${schedule}, per business): reads Amazon's own rules on brain campaigns while the bid brain is live or a product is enrolled`)
}
