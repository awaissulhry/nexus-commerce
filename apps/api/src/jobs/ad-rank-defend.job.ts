/**
 * RS.5 — the continuous rank-defend loop. For each enabled GOAL-mode AdSchedule
 * (windows carry a targetKey and/or a defaultTargetKey baseline), resolve which
 * RankTarget governs right now, read the campaign's achieved Top-of-Search
 * impression share + ACOS, and converge the PLACEMENT_TOP bias toward the
 * target's IS — pushing to re-take the slot, easing off to respect the profit
 * ceiling (or ignoring ACOS in all-out mode). This is the engine behind "hold
 * rank these hours, the baseline the rest, and snap back when we lose it".
 *
 * Reuses the proven plumbing: analyzeTopOfSearch (signals) + applyTopOfSearch
 * (gated actuation) + the pure controller (rank-controller.ts). Sandbox-safe —
 * applyTopOfSearch writes locally and only pushes to Amazon when the write-gate
 * is open. Cron is OFF unless NEXUS_ENABLE_RANK_DEFEND=1; the run-now endpoint
 * (dryRun) previews decisions without writing.
 */

import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { computeStep, resolveActiveTargetKey, type RankTargetSpec, type ScheduleWindow } from '../services/advertising/rank-controller.js'
import { analyzeTopOfSearch, applyTopOfSearch } from '../services/advertising/ads-top-of-search.service.js'
import { updateCampaignWithSync, type AdsActor } from '../services/advertising/ads-mutation.service.js'

function nowInTz(tz: string): { day: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(new Date())
  const wk = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun'
  const hourStr = parts.find((p) => p.type === 'hour')?.value ?? '0'
  const dayIdx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wk)
  let hour = parseInt(hourStr, 10) % 24
  if (Number.isNaN(hour)) hour = 0
  return { day: dayIdx < 0 ? 0 : dayIdx, hour }
}

interface RankTargetRow { key: string; placement: string; targetISPct: number | null; acosCapPct: number | null; maxCpcCents: number | null; biasPct: number | null; pause: boolean; allOut: boolean }
const toSpec = (t: RankTargetRow): RankTargetSpec => ({ key: t.key, placement: t.placement, targetISPct: t.targetISPct, acosCapPct: t.acosCapPct, maxCpcCents: t.maxCpcCents, biasPct: t.biasPct, pause: t.pause, allOut: t.allOut })
const isGoalMode = (windows: unknown, defaultTargetKey: string | null): boolean =>
  !!defaultTargetKey || (Array.isArray(windows) && windows.some((w) => w && typeof w === 'object' && (w as { targetKey?: string }).targetKey))

export interface RankDefendDecision {
  campaignId: string; campaignName: string; targetKey: string; action: string; reason: string
  currentPct: number; nextPct: number; achievedISPct: number | null; achievedAcosPct: number | null; applied: boolean
}
export interface RankDefendSummary { evaluated: number; applied: number; decisions: RankDefendDecision[] }

export async function runRankDefendOnce(opts: { dryRun?: boolean } = {}): Promise<RankDefendSummary> {
  const dryRun = !!opts.dryRun
  const schedules = (await prisma.adSchedule.findMany({ where: { enabled: true } }))
    .filter((s) => isGoalMode(s.windows, s.defaultTargetKey))
  if (schedules.length === 0) return { evaluated: 0, applied: 0, decisions: [] }

  const targets = await prisma.rankTarget.findMany()
  const targetByKey = new Map(targets.map((t) => [t.key, t as unknown as RankTargetRow]))

  const campaignIds = [...new Set(schedules.map((s) => s.campaignId))]
  const campaigns = await prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true, name: true, marketplace: true, status: true } })
  const campById = new Map(campaigns.map((c) => [c.id, c]))

  // One analyzeTopOfSearch call per marketplace gives every campaign's currentPct + topIS + topAcos.
  const markets = [...new Set(campaigns.map((c) => c.marketplace).filter(Boolean) as string[])]
  const sigByCampaign = new Map<string, { currentPct: number; topIS: number | null; topAcos: number | null }>()
  for (const mk of markets) {
    try {
      const { rows } = await analyzeTopOfSearch({ marketplace: mk, windowDays: 14 })
      for (const r of rows) sigByCampaign.set(r.campaignId, { currentPct: r.currentPct, topIS: r.topIS, topAcos: r.topAcos })
    } catch (e) { logger.warn('[rank-defend] signal read failed', { marketplace: mk, error: (e as Error).message }) }
  }

  const decisions: RankDefendDecision[] = []
  let applied = 0
  for (const s of schedules) {
    const camp = campById.get(s.campaignId); if (!camp) continue
    const { day, hour } = nowInTz(s.timezone || 'Europe/Rome')
    const key = resolveActiveTargetKey(s.windows as ScheduleWindow[], s.defaultTargetKey, day, hour)
    if (!key) continue
    const target = targetByKey.get(key); if (!target) continue
    const spec = toSpec(target)
    const sig = sigByCampaign.get(s.campaignId) ?? { currentPct: 0, topIS: null, topAcos: null }

    // Pause target → ensure the campaign is paused.
    if (spec.pause) {
      const pausing = camp.status !== 'PAUSED' && camp.status !== 'ARCHIVED'
      decisions.push({ campaignId: s.campaignId, campaignName: camp.name, targetKey: key, action: 'pause', reason: 'target = pause', currentPct: sig.currentPct, nextPct: sig.currentPct, achievedISPct: sig.topIS != null ? Math.round(sig.topIS * 100) : null, achievedAcosPct: sig.topAcos != null ? Math.round(sig.topAcos * 100) : null, applied: !dryRun && pausing })
      if (!dryRun && pausing) {
        try { await updateCampaignWithSync({ campaignId: s.campaignId, patch: { status: 'PAUSED' }, actor: `automation:rank-defend-${s.id}` as AdsActor, reason: 'rank schedule — pause target', applyImmediately: true } as never); applied++ } catch (e) { logger.warn('[rank-defend] pause failed', { scheduleId: s.id, error: (e as Error).message }) }
      }
      continue
    }

    const decision = computeStep(spec, { currentPct: sig.currentPct, achievedISFraction: sig.topIS, achievedAcosFraction: sig.topAcos, lossDetected: false })
    const willApply = !dryRun && (decision.action === 'raise' || decision.action === 'lower') && decision.nextPct !== sig.currentPct
    decisions.push({ campaignId: s.campaignId, campaignName: camp.name, targetKey: key, action: decision.action, reason: decision.reason, currentPct: sig.currentPct, nextPct: decision.nextPct, achievedISPct: sig.topIS != null ? Math.round(sig.topIS * 100) : null, achievedAcosPct: sig.topAcos != null ? Math.round(sig.topAcos * 100) : null, applied: willApply })
    if (willApply) {
      try { await applyTopOfSearch(s.campaignId, decision.nextPct); applied++ } catch (e) { logger.warn('[rank-defend] apply failed', { scheduleId: s.id, error: (e as Error).message }) }
    }
  }
  return { evaluated: schedules.length, applied, decisions }
}

export async function runRankDefendCron(): Promise<void> {
  try { await recordCronRun('ad-rank-defend', async () => { const r = await runRankDefendOnce(); return `evaluated=${r.evaluated} applied=${r.applied}` }) }
  catch (err) { logger.error('ad-rank-defend cron failure', { error: err instanceof Error ? err.message : String(err) }) }
}

let task: ReturnType<typeof cron.schedule> | null = null
export function startRankDefendCron(): void {
  if (task) return
  // OFF by default — operator opts in (and the write-gate still governs live pushes).
  if (process.env.NEXUS_ENABLE_RANK_DEFEND !== '1') { logger.info('ad-rank-defend cron disabled (set NEXUS_ENABLE_RANK_DEFEND=1)'); return }
  const schedule = process.env.NEXUS_RANK_DEFEND_SCHEDULE ?? '*/15 * * * *'
  task = cron.schedule(schedule, () => void runRankDefendCron())
  logger.info(`ad-rank-defend cron scheduled (${schedule})`)
}
