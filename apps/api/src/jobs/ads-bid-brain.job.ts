/**
 * BID BRAIN BB-3 — the shadow cron: every 6 hours at :50 (half an hour after auto-bid's `20 *\/6`, so it sees what
 * auto-bid just set), decide the bids of the allowlisted Sponsored Products campaigns in IT and DE and log them
 * (BidBrainDecision) next to what today's writers set. It writes nothing to Amazon and calls no write path.
 *
 * Keyword bids move at most once per new settled data day, so four runs a day see every new day and every writer's
 * change of the day; a faster cadence would only add database reads (Neon cost).
 *
 * Switch: NEXUS_BID_BRAIN_MODE = off | shadow (default) | live (= shadow until BB-6 ships the writer).
 * Cluster-safe through lib/cron/clustered.ts (hard rule 7); with business profiles on it runs once per business.
 */
import cron from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { bidBrainMode, runShadowOnce, shadowSummaryLine } from '../services/advertising/bid-brain/shadow.js'

export const BID_BRAIN_CRON = '50 */6 * * *'
export const BID_BRAIN_JOB = 'ads-bid-brain-shadow'

export async function runBidBrainCron(): Promise<void> {
  if (bidBrainMode() === 'off') return
  try { await recordCronRun(BID_BRAIN_JOB, async () => shadowSummaryLine(await runShadowOnce())) }
  catch (err) { logger.error('ads-bid-brain cron failure', { error: err instanceof Error ? err.message : String(err) }) }
}

let task: ReturnType<typeof cron.schedule> | null = null
let running = false
export function startBidBrainCron(): void {
  if (task) return
  task = cron.schedule(BID_BRAIN_CRON, async () => {
    if (running) { logger.warn('[ads-bid-brain] previous tick still in flight — skipping'); return }
    running = true
    await runBidBrainCron().finally(() => { running = false })
  }, { lockTtlMs: 10 * 60_000 })
  logger.info(`ads-bid-brain shadow cron scheduled (${BID_BRAIN_CRON}, NEXUS_BID_BRAIN_MODE=${bidBrainMode()})`)
}
