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
import { computeStep, resolveActiveTargetKey, isRankLoss, type RankTargetSpec, type ScheduleWindow } from '../services/advertising/rank-controller.js'
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
// A schedule is goal-mode (owned by the rank-defend loop, NOT dayparting) once it
// carries a baseline targetKey or any window targetKey. Exported so the dayparting
// cron can skip these — otherwise both crons fight over the same campaign.
export const isGoalMode = (windows: unknown, defaultTargetKey: string | null): boolean =>
  !!defaultTargetKey || (Array.isArray(windows) && windows.some((w) => w && typeof w === 'object' && (w as { targetKey?: string }).targetKey))

export interface RankDefendDecision {
  campaignId: string; campaignName: string; targetKey: string; action: string; reason: string
  currentPct: number; nextPct: number; achievedISPct: number | null; achievedAcosPct: number | null; lossDetected: boolean; applied: boolean
  planId?: string | null
}
export interface RankPlanRunSummary { planId: string; productId: string; marketplace: string; campaigns: number; decisions: RankDefendDecision[] }
export interface RankDefendSummary { evaluated: number; applied: number; decisions: RankDefendDecision[]; plans?: RankPlanRunSummary[] }

const pctOf = (f: number | null): number | null => (f != null ? Math.round(f * 100) : null)
type SigMap = Map<string, { currentPct: number; topIS: number | null; topAcos: number | null }>
interface CampRow { id: string; name: string; status: string; dynamicBidding: unknown }

// RD.4 — one per-campaign decision body, shared by the schedule loop and the
// product-plan fan-out. `write` gates ALL actuation (pause / resume / placement
// bias); when false it is a pure decision (preview / plan dry-run). currentPct is
// always read from dynamicBidding (the bias WE control), never the sparse T+1
// placement report — else the loop is blind to its own prior changes.
async function decideAndMaybeApply(
  camp: CampRow, key: string, spec: RankTargetSpec, planId: string | null,
  ctx: { write: boolean; actor: string; sigByCampaign: SigMap; lossByCampaign: Map<string, boolean> },
): Promise<{ decision: RankDefendDecision; applied: number }> {
  const sigRaw = ctx.sigByCampaign.get(camp.id) ?? { currentPct: 0, topIS: null, topAcos: null }
  const cdb = (camp.dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }> }
  const currentPct = cdb.placementBidding?.find((x) => x.placement === 'PLACEMENT_TOP')?.percentage ?? 0
  const base = { campaignId: camp.id, campaignName: camp.name, targetKey: key, currentPct, achievedISPct: pctOf(sigRaw.topIS), achievedAcosPct: pctOf(sigRaw.topAcos), planId }
  let applied = 0
  // Pause target → ensure the campaign is paused.
  if (spec.pause) {
    const pausing = camp.status !== 'PAUSED' && camp.status !== 'ARCHIVED'
    if (ctx.write && pausing) {
      try { await updateCampaignWithSync({ campaignId: camp.id, patch: { status: 'PAUSED' }, actor: ctx.actor as AdsActor, reason: 'rank — pause target', applyImmediately: true } as never); applied++ } catch (e) { logger.warn('[rank-defend] pause failed', { campaignId: camp.id, error: (e as Error).message }) }
    }
    return { decision: { ...base, action: 'pause', reason: 'target = pause', nextPct: currentPct, lossDetected: false, applied: ctx.write && pausing }, applied }
  }
  // Defend semantics: a serve target must actually SERVE — resume if something left it paused. Never touch ARCHIVED.
  if (ctx.write && camp.status === 'PAUSED') {
    try { await updateCampaignWithSync({ campaignId: camp.id, patch: { status: 'ENABLED' }, actor: ctx.actor as AdsActor, reason: 'rank defend — resume to hold the slot', applyImmediately: true } as never); applied++ } catch (e) { logger.warn('[rank-defend] resume failed', { campaignId: camp.id, error: (e as Error).message }) }
  }
  const loss = ctx.lossByCampaign.get(camp.id) ?? false
  const d = computeStep(spec, { currentPct, achievedISFraction: sigRaw.topIS, achievedAcosFraction: sigRaw.topAcos, lossDetected: loss })
  const willApply = ctx.write && (d.action === 'raise' || d.action === 'lower') && d.nextPct !== currentPct
  if (willApply) {
    try { await applyTopOfSearch(camp.id, d.nextPct); applied++ } catch (e) { logger.warn('[rank-defend] apply failed', { campaignId: camp.id, error: (e as Error).message }) }
  }
  return { decision: { ...base, action: d.action, reason: d.reason, nextPct: d.nextPct, lossDetected: loss, applied: willApply }, applied }
}

// RD.4 — plan actuation is OFF until RD.7. Plans compute + persist decisions
// (so the UI can preview the fan-out) but do NOT touch campaigns yet.
const PLAN_ALLOW_APPLY = false

export async function runRankDefendOnce(opts: { dryRun?: boolean } = {}): Promise<RankDefendSummary> {
  const dryRun = !!opts.dryRun
  const schedules = (await prisma.adSchedule.findMany({ where: { enabled: true } }))
    .filter((s) => isGoalMode(s.windows, s.defaultTargetKey))
  const plans = await prisma.productRankPlan.findMany({ where: { enabled: true } })
  if (schedules.length === 0 && plans.length === 0) return { evaluated: 0, applied: 0, decisions: [], plans: [] }

  const targets = await prisma.rankTarget.findMany()
  const targetByKey = new Map(targets.map((t) => [t.key, t as unknown as RankTargetRow]))

  // Resolve each plan's family campaigns LIVE (RD.4) → the governed set, so the
  // schedule loop never fights a plan over the same campaign (precedence: plan wins).
  const { resolveProductFamily } = await import('../services/advertising/ads-dayparting-refresh.service.js')
  const planFamilies: Array<{ plan: (typeof plans)[number]; campaigns: Array<{ id: string }> }> = []
  const governed = new Set<string>()
  for (const plan of plans) {
    try {
      const fam = await resolveProductFamily({ parentProductId: plan.productId, marketplace: plan.marketplace })
      planFamilies.push({ plan, campaigns: fam.campaigns ?? [] })
      for (const c of fam.campaigns ?? []) governed.add(c.id)
    } catch (e) { logger.warn('[rank-defend] family resolve failed', { planId: plan.id, error: (e as Error).message }) }
  }

  // Union of schedule + plan campaigns → one campaign load + one signal pass.
  const unionIds = [...new Set([...schedules.map((s) => s.campaignId), ...governed])]
  const campaigns = await prisma.campaign.findMany({ where: { id: { in: unionIds } }, select: { id: true, name: true, marketplace: true, status: true, externalCampaignId: true, dynamicBidding: true } })
  const campById = new Map(campaigns.map((c) => [c.id, c]))

  // One analyzeTopOfSearch call per marketplace gives every campaign's topIS + topAcos signals.
  const markets = [...new Set(campaigns.map((c) => c.marketplace).filter(Boolean) as string[])]
  const sigByCampaign: SigMap = new Map()
  for (const mk of markets) {
    try {
      const { rows } = await analyzeTopOfSearch({ marketplace: mk, windowDays: 14 })
      for (const r of rows) sigByCampaign.set(r.campaignId, { currentPct: r.currentPct, topIS: r.topIS, topAcos: r.topAcos })
    } catch (e) { logger.warn('[rank-defend] signal read failed', { marketplace: mk, error: (e as Error).message }) }
  }

  // RS.6 — loss proxy: the latest hour's impressions cratering vs the campaign's
  // own ~2-day baseline is the fastest "we're slipping" signal. Conservative
  // threshold → sparse/low-volume campaigns never trip it (no false snap-backs).
  const lossByCampaign = new Map<string, boolean>()
  const extIds = campaigns.map((c) => c.externalCampaignId).filter(Boolean) as string[]
  if (extIds.length > 0) {
    try {
      const since = new Date(Date.now() - 2 * 24 * 3600 * 1000)
      const hourly = await prisma.amazonAdsHourlyPerformance.findMany({ where: { entityType: 'CAMPAIGN', entityId: { in: extIds }, date: { gte: since } }, select: { entityId: true, date: true, hour: true, impressions: true } })
      const byExt = new Map<string, { ts: number; impr: number }[]>()
      for (const h of hourly) { const ts = h.date.getTime() + (h.hour ?? 0) * 3600_000; const arr = byExt.get(h.entityId) ?? []; arr.push({ ts, impr: h.impressions ?? 0 }); byExt.set(h.entityId, arr) }
      for (const c of campaigns) {
        if (!c.externalCampaignId) continue
        const series = (byExt.get(c.externalCampaignId) ?? []).sort((a, b) => a.ts - b.ts)
        if (series.length < 3) continue
        const latest = series[series.length - 1].impr
        const prior = series.slice(0, -1)
        const baseline = prior.reduce((s, x) => s + x.impr, 0) / prior.length
        lossByCampaign.set(c.id, isRankLoss(latest, baseline))
      }
    } catch (e) { logger.warn('[rank-defend] loss-proxy read failed', { error: (e as Error).message }) }
  }

  const decisions: RankDefendDecision[] = []
  const planSummaries: RankPlanRunSummary[] = []
  let applied = 0

  // ── Plans first (governed). Dry-only actuation until RD.7. ──
  for (const { plan, campaigns: famCamps } of planFamilies) {
    const { day, hour } = nowInTz(plan.timezone || 'Europe/Rome')
    const key = resolveActiveTargetKey(plan.windows as ScheduleWindow[], plan.defaultTargetKey, day, hour)
    const planDecisions: RankDefendDecision[] = []
    if (key) {
      const target = targetByKey.get(key)
      if (target) {
        const spec = toSpec(target)
        const write = !dryRun && PLAN_ALLOW_APPLY && !plan.manualOnly
        for (const fc of famCamps) {
          const camp = campById.get(fc.id); if (!camp) continue
          const { decision, applied: a } = await decideAndMaybeApply(camp, key, spec, plan.id, { write, actor: `automation:rank-plan-${plan.id}`, sigByCampaign, lossByCampaign })
          planDecisions.push(decision); decisions.push(decision); applied += a
        }
      }
    }
    planSummaries.push({ planId: plan.id, productId: plan.productId, marketplace: plan.marketplace, campaigns: planDecisions.length, decisions: planDecisions })
    if (!dryRun) {
      try { await prisma.productRankPlan.update({ where: { id: plan.id }, data: { lastEvaluatedAt: new Date(), lastSummary: { at: new Date().toISOString(), activeTargetKey: key ?? null, campaigns: planDecisions.length, decisions: planDecisions } as never } }) } catch { /* best-effort */ }
    }
  }

  // ── Schedules (skip plan-governed campaigns). Existing behaviour preserved. ──
  for (const s of schedules) {
    if (governed.has(s.campaignId)) continue
    const camp = campById.get(s.campaignId); if (!camp) continue
    const { day, hour } = nowInTz(s.timezone || 'Europe/Rome')
    const key = resolveActiveTargetKey(s.windows as ScheduleWindow[], s.defaultTargetKey, day, hour)
    if (!key) continue
    const target = targetByKey.get(key); if (!target) continue
    const { decision, applied: a } = await decideAndMaybeApply(camp, key, toSpec(target), null, { write: !dryRun, actor: `automation:rank-defend-${s.id}`, sigByCampaign, lossByCampaign })
    decisions.push(decision); applied += a
  }

  return { evaluated: decisions.length, applied, decisions, plans: planSummaries }
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
