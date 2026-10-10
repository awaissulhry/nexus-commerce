/**
 * Apex D.2 — Top-of-Search defense cron.
 *
 * Every 30 min, looks at the PLACEMENT_TOP bid multiplier of allowlisted campaigns and steps it (±STEP_PCT, ≤900%):
 * toward a target top-of-search impression share only when NEXUS_TOS_TARGET_IS is set (a fraction, 0.5 = 50 %), else on
 * top-of-search ACoS alone ("ACoS only: no target IS set"). The IS is the campaign's own, as Amazon reports it per day,
 * impression-weighted over the settled days of the window that carry one.
 *
 * A1 (2026-10-10) — its numbers are campaign × settled day, so they change once a day: a campaign is stepped only when
 * a settled day newer than the one its last step rested on exists (the other 47 runs of the day hold and say so), and
 * under a target IS only with ≥ 5 days carrying Amazon's IS, the newest ≤ 3 days before the window's end
 * (ads-top-of-search.service.ts). Held moves are counted on the run's line.
 *
 * SAFETY — triple-gated, because it writes live placement bids:
 *   1. NEXUS_ENABLE_TOS_DEFENSE_CRON (default OFF — operator opts in only when ready)
 *   2. allowlistedOnly: writes only to campaigns with Campaign.liveBidWritesEnabled
 *   3. the global ads write-gate (env live + connection production/writesEnabledAt)
 * 1d — and it honours the account dial and its own caps (ads-engine-guard.ts): SUGGEST and a halt / OFF
 * write nothing; at most N placement changes a run and a day.
 * Registered in CRON_REGISTRY for manual triggering; only auto-scheduled when on.
 */

import cron from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { envEnabled } from '../utils/env-flag.js'
import { engineGuardNote, openEngineGuard } from '../services/advertising/ads-engine-guard.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

/**
 * ACR.1.2d — the tick's work AND its summary, without the CronRun wrapper, so the
 * manual-trigger registry can call it and produce ONE honest row.
 *
 * It also matters that the ENV READS live here rather than in the registry: this engine's
 * behaviour is configured by NEXUS_TOS_TARGET_ACOS / _IS, and a hand-run that read those
 * somewhere else could act on different settings than the schedule does. A manual run must
 * be the same run.
 */
export async function runTosDefenseOnce(): Promise<string> {
  // 1e — every run here is live (the tick and Run now alike): this business's switch, the scheduler's arm flags and
  // the engine lock first (ads-engine-lock.ts).
  const { guardLiveRun } = await import('../services/advertising/ads-engine-lock.js')
  const run = await guardLiveRun('tos-defense', tosDefenseTick)
  return run.ran ? run.value : `skipped: ${run.reason}`
}

async function tosDefenseTick(): Promise<string> {
  const { leverHeldNote } = await import('../services/advertising/brain/engine-skips.js')
  const { defendTopOfSearch } = await import('../services/advertising/ads-top-of-search.service.js')
  const targetAcos = Number(process.env.NEXUS_TOS_TARGET_ACOS)
  const targetIS = Number(process.env.NEXUS_TOS_TARGET_IS) // a fraction 0–1; when set, the loop holds this top-of-search impression share (ACOS-bounded); unset or out of range = ACoS only
  // 1d — the account dial and this engine's caps, asked once per campaign before its one placement write. Under
  // SUGGEST and while stopped it writes nothing (it has no state of its own to give back, and a placement move is
  // never a suppression); the summary counts what it would move.
  const guard = await openEngineGuard('tos-defense')
  const r = await defendTopOfSearch({
    allowlistedOnly: true,
    dryRun: false,
    targetAcos: Number.isFinite(targetAcos) && targetAcos > 0 ? targetAcos : undefined,
    targetIS: Number.isFinite(targetIS) && targetIS > 0 && targetIS <= 1 ? targetIS : undefined,
    guard,
  })
  // 4m — campaigns Hourly Bids holds are left alone, and the run says so in words.
  const rankOwned = r.rankOwnedNote ? ` rank-owned=${r.skippedRankOwned} (${r.rankOwnedNote})` : ''
  // A1 — what it held, and why, in words (nothing extra on a run that held nothing).
  const held = tosHeldNote(r)
  return `evaluated=${r.evaluated} changed=${r.changed} applied=${r.applied} skipped=${r.skippedNotAllowlisted}${rankOwned}${held}${engineGuardNote(guard.report(), {
    suggest: 'nothing is written',
    stopped: 'nothing is written; placement moves wait for Resume',
  })}${leverHeldNote(r.brainSkips?.counts, !!r.brainSkips?.unread)}`
}

/** A1 — the run line's hold counts; '' when nothing was held. Pure. */
export function tosHeldNote(r: { heldNoNewDay?: number; heldNoUsableIS?: number }): string {
  const parts = [
    r.heldNoNewDay ? ` waiting-new-day=${r.heldNoNewDay} (no settled day newer than the one its last step rested on)` : '',
    r.heldNoUsableIS ? ` held-no-usable-IS=${r.heldNoUsableIS} (a target IS is set, but Amazon's top-of-search IS is missing, on fewer than 5 settled days, or too old)` : '',
  ]
  return parts.join('')
}

export async function runTosDefenseCron(): Promise<void> {
  try {
    await recordCronRun('top-of-search-defense', async () => {
      // R16 — this business's own switch, under the env that armed the cron.
      const { engineMode } = await import('../services/automation/engine-switch.service.js')
      const gate = await engineMode('tos-defense', 'AUTO')
      if (gate.mode === 'OFF') return `skipped: ${gate.note}`
      return runTosDefenseOnce()
    })
  } catch (err) {
    logger.error('top-of-search-defense cron: failure', { error: err instanceof Error ? err.message : String(err) })
  }
}

export function startTosDefenseCron(): void {
  if (scheduledTask) {
    logger.warn('top-of-search-defense cron already started')
    return
  }
  // Opt-in: only auto-schedule when explicitly enabled (it writes live bids).
  if (!envEnabled('NEXUS_ENABLE_TOS_DEFENSE_CRON')) {
    logger.info('top-of-search-defense cron NOT scheduled (NEXUS_ENABLE_TOS_DEFENSE_CRON off) — manual trigger still available')
    return
  }
  // Every 30 min; A1 — a campaign moves at most once per new settled day, so the runs in between only hold.
  scheduledTask = cron.schedule('*/30 * * * *', async () => { await runTosDefenseCron() })
  logger.info('top-of-search-defense cron scheduled (*/30 * * * *)')
}
