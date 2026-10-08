/**
 * BID BRAIN BB-3 — the brain's cron. Every 6 hours (the :45 tick of 00, 06, 12 and 18 UTC, after auto-bid's `20 *\/6`, so
 * it sees what auto-bid just set) it decides the bids of the allowlisted Sponsored Products campaigns in IT and DE and
 * logs them (BidBrainDecision) next to what today's writers set.
 *
 * Keyword bids move at most once per new settled data day, so four full runs a day see every new day and every writer's
 * change of the day; a faster full cadence would only add database reads (Neon cost).
 *
 * BB-7 — the ticks in between (every 15 minutes) run only while the switch is live and a campaign is enrolled LIVE, and
 * decide only the campaigns the brain owns: their hourly plan's hours (placement %, Min-bid floors and the bids given
 * back after them) land on time, as rank-defend's 15-minute tick landed them before. The plan's hour is read on the
 * database clock (rank-defend's dbNow: a container clock once ran two hours late).
 *
 * Switch: NEXUS_BID_BRAIN_MODE = off | shadow (default) | live (BB-6: the campaigns enrolled LIVE are written; the rest
 * stay shadow).
 *
 * ONE BRAIN AB-7 — at the same full slots the money shadow plans the money of every product whose `budgets` lever is
 * OBSERVE or higher (brain/budget-shadow.ts) and logs it; it writes nothing else. Its own lever levels decide, not the
 * bid switch, so it runs with the bid brain off too. With no such product (production today) it reads one table, prunes
 * the plans older than 30 days and records no run. A failure there never touches the bid run.
 * AB-8 — at PROPOSE and AUTO, under a live switch, the same run asks or writes (brain/budget-live.ts); and the ticks in
 * between (every 15 minutes) carry the products whose budgets lever is AUTO — the intraday ladder and the next day's
 * give-back land on time. No such product (production today): one enrollment read, nothing recorded.
 * Cluster-safe through lib/cron/clustered.ts (hard rule 7); with business profiles on it runs once per business.
 */
import cron from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { bidBrainMode, runShadowOnce, shadowSummaryLine } from '../services/advertising/bid-brain/shadow.js'
import { brainOwnedCampaignIds } from '../services/advertising/bid-brain/live.js'

export const BID_BRAIN_CRON = '*/15 * * * *'
export const BID_BRAIN_JOB = 'ads-bid-brain-shadow'
/** BB-7 — the between-slots ticks for the campaigns the brain owns (recorded only when one is enrolled LIVE). */
export const BID_BRAIN_LIVE_JOB = 'ads-bid-brain-live'
/** AB-7 — the money shadow's run (recorded only when a product's budgets lever is OBSERVE or higher). */
export const BRAIN_MONEY_JOB = 'ads-brain-money-shadow'
/** AB-8 — the between-slots ticks of the money writer (recorded only when a product's budgets lever is AUTO, switch live). */
export const BRAIN_MONEY_LIVE_JOB = 'ads-brain-money-live'

/** BB-7 — the full run's tick: :45 of 00, 06, 12 and 18 UTC. */
export function isFullSlot(at: Date): boolean {
  return at.getUTCHours() % 6 === 0 && at.getUTCMinutes() >= 45
}

export async function runBidBrainCron(at: Date = new Date()): Promise<void> {
  const full = isFullSlot(at)
  await runBidLever(full)
  if (full) await runMoneyShadowTick()
  else await runMoneyLiveTick()
}

async function runBidLever(full: boolean): Promise<void> {
  const mode = bidBrainMode()
  if (mode === 'off') return
  try {
    if (!full && (mode !== 'live' || !(await brainOwnedCampaignIds()).size)) return
    const { dbNow } = await import('./ad-rank-defend.job.js')
    const clockNow = await dbNow()
    await recordCronRun(full ? BID_BRAIN_JOB : BID_BRAIN_LIVE_JOB, async () => shadowSummaryLine(await runShadowOnce({ onlyOwned: !full, clockNow })))
  } catch (err) { logger.error('ads-bid-brain cron failure', { error: err instanceof Error ? err.message : String(err) }) }
}

/**
 * AB-7 — the money shadow at a full slot: no product watching → nothing recorded; a failure is logged, never thrown. The
 * budget day and hour are read on the database clock (rank-defend's dbNow: a container clock once ran two hours late).
 */
export async function runMoneyShadowTick(at?: Date): Promise<void> {
  try {
    // Loaded at the tick, not when the scheduler boots (runtime/module-load-order.vitest.test.ts).
    const { moneyShadowProducts, moneySummaryLine, pruneMoneyDecisions, runMoneyShadowOnce } = await import('../services/advertising/brain/budget-shadow.js')
    const now = at ?? await (await import('./ad-rank-defend.job.js')).dbNow()
    const products = await moneyShadowProducts()
    // Nothing watched: the old plans still go after 30 days (a product that left the brain leaves none behind).
    if (!products.length) { await pruneMoneyDecisions(now); return }
    await recordCronRun(BRAIN_MONEY_JOB, async () => moneySummaryLine(await runMoneyShadowOnce({ now, products })))
  } catch (err) { logger.error('ads-brain money shadow failure', { error: err instanceof Error ? err.message : String(err) }) }
}

/**
 * AB-8 — a tick between the full slots: the products whose budgets lever is AUTO under a live switch get their money run
 * (the ladder's rungs and the give-back); none → nothing read beyond the enrollment, nothing recorded. Never throws.
 */
export async function runMoneyLiveTick(at?: Date): Promise<void> {
  try {
    const { moneyLiveProducts, moneySummaryLine, runMoneyShadowOnce } = await import('../services/advertising/brain/budget-shadow.js')
    const products = await moneyLiveProducts()
    if (!products.length) return
    const now = at ?? await (await import('./ad-rank-defend.job.js')).dbNow()
    await recordCronRun(BRAIN_MONEY_LIVE_JOB, async () => moneySummaryLine(await runMoneyShadowOnce({ now, products, between: true })))
  } catch (err) { logger.error('ads-brain money live tick failure', { error: err instanceof Error ? err.message : String(err) }) }
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
  logger.info(`ads-bid-brain cron scheduled (${BID_BRAIN_CRON}: full run at :45 of every 6th UTC hour, owned campaigns every tick while live; NEXUS_BID_BRAIN_MODE=${bidBrainMode()})`)
}
