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
import { suppressCampaignBids, restoreCampaignBids } from '../services/advertising/ads-bid-suppression.service.js'
import { detectSelfCompetition, type CampaignTargeting, type SelfCompetitionConflict } from '../services/advertising/rank-self-competition.js'

// RD.8 — leadMinutes shifts the evaluation clock forward so a plan starts converging
// BEFORE a window opens (Amazon bid changes propagate with lag → arrive at-rank, not late).
function nowInTz(tz: string, leadMinutes = 0): { day: number; hour: number } {
  const at = leadMinutes ? new Date(Date.now() + leadMinutes * 60_000) : new Date()
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(at)
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
export interface RankPlanRunSummary { planId: string; productId: string; marketplace: string; campaigns: number; decisions: RankDefendDecision[]; selfCompetition?: SelfCompetitionConflict[] }
export interface RankDefendSummary { evaluated: number; applied: number; decisions: RankDefendDecision[]; plans?: RankPlanRunSummary[] }

const pctOf = (f: number | null): number | null => (f != null ? Math.round(f * 100) : null)
type SigMap = Map<string, { currentPct: number; topIS: number | null; topAcos: number | null }>
interface CampRow { id: string; name: string; status: string; dynamicBidding: unknown; bidsSuppressedAt?: Date | null }

// RD.4 — one per-campaign decision body, shared by the schedule loop and the
// product-plan fan-out. `write` gates ALL actuation (pause / resume / placement
// bias); when false it is a pure decision (preview / plan dry-run). currentPct is
// always read from dynamicBidding (the bias WE control), never the sparse T+1
// placement report — else the loop is blind to its own prior changes.
async function decideAndMaybeApply(
  camp: CampRow, key: string, spec: RankTargetSpec, planId: string | null,
  ctx: { write: boolean; actor: string; sigByCampaign: SigMap; lossByCampaign: Map<string, boolean>; suppressRaise?: boolean },
): Promise<{ decision: RankDefendDecision; applied: number }> {
  const sigRaw = ctx.sigByCampaign.get(camp.id) ?? { currentPct: 0, topIS: null, topAcos: null }
  const cdb = (camp.dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }> }
  const currentPct = cdb.placementBidding?.find((x) => x.placement === 'PLACEMENT_TOP')?.percentage ?? 0
  const base = { campaignId: camp.id, campaignName: camp.name, targetKey: key, currentPct, achievedISPct: pctOf(sigRaw.topIS), achievedAcosPct: pctOf(sigRaw.topAcos), planId }
  let applied = 0
  // NP — no-pause: a Pause target (or OOS/lost-buybox via effectiveSpec) drops every
  // bid to the floor (~2¢) and keeps the campaign ENABLED — NEVER status=PAUSED, which
  // disrupts Amazon's algorithm. Prior bids are remembered for exact restore. Idempotent.
  if (spec.pause) {
    let suppressed = 0
    if (ctx.write && !camp.bidsSuppressedAt) {
      try { suppressed = await suppressCampaignBids(camp.id, { actor: ctx.actor as AdsActor, reason: 'rank — pause target → bids floored (no-pause)' }) } catch (e) { logger.warn('[rank-defend] bid-suppress failed', { campaignId: camp.id, error: (e as Error).message }) }
    }
    applied += suppressed
    return { decision: { ...base, action: 'pause', reason: 'target = Min bid → bids at floor ~2¢ (campaign live, restorable)', nextPct: currentPct, lossDetected: false, applied: suppressed > 0 || (ctx.write && !!camp.bidsSuppressedAt) }, applied }
  }
  // Serve target → first restore any no-pause bid suppression (exact prior bids).
  if (ctx.write && camp.bidsSuppressedAt) {
    try { applied += await restoreCampaignBids(camp.id, { actor: ctx.actor as AdsActor, reason: 'rank — serve target → restore prior bids' }) } catch (e) { logger.warn('[rank-defend] bid-restore failed', { campaignId: camp.id, error: (e as Error).message }) }
  }
  // Defend semantics: resume only if something ELSE left it paused (we never pause). Never touch ARCHIVED.
  if (ctx.write && camp.status === 'PAUSED') {
    try { await updateCampaignWithSync({ campaignId: camp.id, patch: { status: 'ENABLED' }, actor: ctx.actor as AdsActor, reason: 'rank defend — resume to hold the slot', applyImmediately: true } as never); applied++ } catch (e) { logger.warn('[rank-defend] resume failed', { campaignId: camp.id, error: (e as Error).message }) }
  }
  const loss = ctx.lossByCampaign.get(camp.id) ?? false
  const d = computeStep(spec, { currentPct, achievedISFraction: sigRaw.topIS, achievedAcosFraction: sigRaw.topAcos, lossDetected: loss })
  // RD.5 — family daily-budget cap: suppress raises (still allow holds/lowers) so a
  // must-win window can't push the whole family over its shared budget.
  let action = d.action, nextPct = d.nextPct, reason = d.reason
  if (ctx.suppressRaise && action === 'raise') { action = 'hold'; nextPct = currentPct; reason = 'family daily budget reached — holding (no raise)' }
  const willApply = ctx.write && (action === 'raise' || action === 'lower') && nextPct !== currentPct
  if (willApply) {
    try { await applyTopOfSearch(camp.id, nextPct); applied++ } catch (e) { logger.warn('[rank-defend] apply failed', { campaignId: camp.id, error: (e as Error).message }) }
  }
  return { decision: { ...base, action, reason, nextPct, lossDetected: loss, applied: willApply }, applied }
}

// RD.5 — family guardrails. effectiveSpec transforms the window target before the
// controller sees it: OOS/lost-buybox → pause (stop wasting spend); family over
// its ACOS cap → drop all-out so even a must-win window respects a profit ceiling.
export function effectiveSpec(spec: RankTargetSpec, flags: { oos?: boolean; overAcos?: boolean; familyAcosCapPct?: number | null }): RankTargetSpec {
  if (flags.oos) return { ...spec, pause: true }
  if (flags.overAcos && spec.allOut) return { ...spec, allOut: false, acosCapPct: spec.acosCapPct ?? flags.familyAcosCapPct ?? null }
  return spec
}

// Family-aggregate spend (most recent day with data) + ACOS (window) over a set of
// campaigns. localEntityId = Campaign.id; costMicros → cents (÷10000).
async function familySpendRecentCents(campaignIds: string[]): Promise<number> {
  if (!campaignIds.length) return 0
  const latest = await prisma.amazonAdsDailyPerformance.findFirst({ where: { entityType: 'CAMPAIGN', localEntityId: { in: campaignIds } }, orderBy: { date: 'desc' }, select: { date: true } })
  if (!latest) return 0
  const agg = await prisma.amazonAdsDailyPerformance.aggregate({ where: { entityType: 'CAMPAIGN', localEntityId: { in: campaignIds }, date: latest.date }, _sum: { costMicros: true } })
  return Math.round(Number(agg._sum.costMicros ?? 0n) / 10000)
}
async function familyAcosFraction(campaignIds: string[], windowDays = 14): Promise<number | null> {
  if (!campaignIds.length) return null
  const since = new Date(Date.now() - windowDays * 86_400_000)
  const agg = await prisma.amazonAdsDailyPerformance.aggregate({ where: { entityType: 'CAMPAIGN', localEntityId: { in: campaignIds }, date: { gte: since } }, _sum: { costMicros: true, sales7dCents: true } })
  const spend = Math.round(Number(agg._sum.costMicros ?? 0n) / 10000)
  const sales = agg._sum.sales7dCents ?? 0
  return sales > 0 ? spend / sales : null
}

// RD.6 — load each family campaign's positive EXACT/PHRASE keywords + AUTO flag +
// efficiency (Campaign.acos / spendCents) for the self-competition detector.
async function loadFamilyTargeting(famCampIds: string[], campById: Map<string, { acos?: unknown; spend?: unknown }>): Promise<CampaignTargeting[]> {
  if (!famCampIds.length) return []
  const [autoGroups, kws] = await Promise.all([
    prisma.adGroup.findMany({ where: { campaignId: { in: famCampIds }, targetingType: 'AUTO' }, select: { campaignId: true } }),
    prisma.adTarget.findMany({ where: { adGroup: { campaignId: { in: famCampIds } }, kind: 'KEYWORD', isNegative: false, expressionType: { in: ['EXACT', 'PHRASE'] } }, select: { expressionValue: true, expressionType: true, adGroup: { select: { campaignId: true } } } }),
  ])
  const autoSet = new Set(autoGroups.map((g) => g.campaignId))
  const kwByCamp = new Map<string, Set<string>>()
  for (const k of kws) {
    const cid = k.adGroup?.campaignId; if (!cid) continue
    const s = kwByCamp.get(cid) ?? new Set<string>(); s.add(`${k.expressionValue.trim().toLowerCase()}|${k.expressionType}`); kwByCamp.set(cid, s)
  }
  return famCampIds.map((id) => {
    const camp = campById.get(id)
    const acosNum = camp?.acos != null ? Number(camp.acos) : NaN
    return { campaignId: id, keywords: [...(kwByCamp.get(id) ?? [])], isAuto: autoSet.has(id), acos: Number.isFinite(acosNum) ? acosNum : null, spendCents: Math.round(Number(camp?.spend ?? 0) * 100) }
  })
}

// RD.7 — plan actuation is LIVE, gated. Plans actuate via applyTopOfSearch through
// the same write-gate as schedules (sandbox-safe; live only when the gate is open).
// Auto-actuation (cron) skips manualOnly plans; an explicit run-now (force) actuates
// them too.
const PLAN_ALLOW_APPLY = true

export async function runRankDefendOnce(opts: { dryRun?: boolean; onlyPlanId?: string; force?: boolean } = {}): Promise<RankDefendSummary> {
  const dryRun = !!opts.dryRun
  // onlyPlanId scopes a run to ONE plan (per-plan run-now / apply-now): skip schedules
  // and the enabled filter, so even a disabled plan can be previewed or manually applied.
  const schedules = opts.onlyPlanId ? [] : (await prisma.adSchedule.findMany({ where: { enabled: true } })).filter((s) => isGoalMode(s.windows, s.defaultTargetKey))
  const plans = await prisma.productRankPlan.findMany({ where: opts.onlyPlanId ? { id: opts.onlyPlanId } : { enabled: true } })
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
      // RD.12 — honour the operator's manual campaign scope: drop excluded campaigns
      // BEFORE governance + blast-radius, so they're neither held nor counted nor
      // marked governed (they stay free for schedules / manual control).
      const excluded = new Set<string>(Array.isArray(plan.excludeCampaignIds) ? (plan.excludeCampaignIds as string[]) : [])
      const camps = (fam.campaigns ?? []).filter((c) => !excluded.has(c.id))
      // RD.8 — blast-radius guard: a plan resolving to MORE than maxCampaigns is likely
      // mis-targeted (wrong product / runaway ASIN match). Refuse to actuate it, and on
      // a real run auto-pause it so it can't fan out to an unexpected fleet.
      if (plan.maxCampaigns != null && camps.length > plan.maxCampaigns) {
        logger.warn('[rank-defend] plan exceeds maxCampaigns — refusing', { planId: plan.id, resolved: camps.length, max: plan.maxCampaigns })
        if (!dryRun) { try { await prisma.productRankPlan.update({ where: { id: plan.id }, data: { enabled: false, pausedAt: new Date(), lastSummary: { at: new Date().toISOString(), autoPaused: true, reason: `family resolved to ${camps.length} campaigns > maxCampaigns ${plan.maxCampaigns}` } as never } }) } catch { /* best-effort */ } }
        continue
      }
      planFamilies.push({ plan, campaigns: camps })
      for (const c of camps) governed.add(c.id)
    } catch (e) { logger.warn('[rank-defend] family resolve failed', { planId: plan.id, error: (e as Error).message }) }
  }

  // Union of schedule + plan campaigns → one campaign load + one signal pass.
  const unionIds = [...new Set([...schedules.map((s) => s.campaignId), ...governed])]
  const campaigns = await prisma.campaign.findMany({ where: { id: { in: unionIds } }, select: { id: true, name: true, marketplace: true, status: true, externalCampaignId: true, dynamicBidding: true, acos: true, spend: true, bidsSuppressedAt: true } })
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

  // RD.5 — retail-readiness (OOS/lost-buybox) per market, memoised across plans.
  const { analyzeRetailReadiness } = await import('../services/advertising/ads-retail-readiness.service.js')
  const readinessMemo = new Map<string, Map<string, string>>()
  const getReadiness = async (mk: string): Promise<Map<string, string>> => {
    const hit = readinessMemo.get(mk); if (hit) return hit
    const map = new Map<string, string>()
    try { const rr = await analyzeRetailReadiness({ marketplace: mk }); for (const c of rr.campaigns) map.set(c.campaignId, c.verdict) } catch { /* best-effort */ }
    readinessMemo.set(mk, map); return map
  }

  // ── Plans first (governed). Dry-only actuation until RD.7. ──
  for (const { plan, campaigns: famCamps } of planFamilies) {
    const { day, hour } = nowInTz(plan.timezone || 'Europe/Rome', plan.leadTimeMinutes || 0)
    const key = resolveActiveTargetKey(plan.windows as ScheduleWindow[], plan.defaultTargetKey, day, hour)
    const planDecisions: RankDefendDecision[] = []
    let planConflicts: SelfCompetitionConflict[] = []
    if (key) {
      const target = targetByKey.get(key)
      if (target) {
        const write = !dryRun && PLAN_ALLOW_APPLY && (!plan.manualOnly || !!opts.force)
        // RD.5 — family pre-flight guards (once per plan, shared by every campaign):
        // retail-readiness (OOS/lost-buybox), family daily spend vs budget cap,
        // family ACOS vs cap.
        const famCampIds = famCamps.map((c) => c.id)
        const readinessByCamp = await getReadiness(plan.marketplace)
        const overBudget = plan.familyDailyBudgetCents != null && (await familySpendRecentCents(famCampIds)) >= plan.familyDailyBudgetCents
        const acosFrac = plan.familyAcosCapPct != null ? await familyAcosFraction(famCampIds) : null
        const overAcos = plan.familyAcosCapPct != null && acosFrac != null && acosFrac > plan.familyAcosCapPct / 100
        // RD.6 — self-competition: demote redundant family campaigns (lose a keyword/
        // auto contest and win none) to the plan baseline so we stop outbidding ourselves.
        const sc = detectSelfCompetition(await loadFamilyTargeting(famCampIds, campById))
        planConflicts = sc.conflicts
        const baselineTarget = plan.defaultTargetKey ? targetByKey.get(plan.defaultTargetKey) : undefined
        for (const fc of famCamps) {
          const camp = campById.get(fc.id); if (!camp) continue
          const oos = readinessByCamp.get(fc.id) === 'pause'
          const demote = sc.demoted.has(fc.id) && !!baselineTarget && plan.defaultTargetKey !== key
          const useKey = demote ? plan.defaultTargetKey! : key
          const eff = effectiveSpec(toSpec(demote ? baselineTarget! : target), { oos, overAcos, familyAcosCapPct: plan.familyAcosCapPct })
          const { decision, applied: a } = await decideAndMaybeApply(camp, useKey, eff, plan.id, { write, actor: `automation:rank-plan-${plan.id}`, sigByCampaign, lossByCampaign, suppressRaise: overBudget })
          planDecisions.push(decision); decisions.push(decision); applied += a
        }
      }
    }
    planSummaries.push({ planId: plan.id, productId: plan.productId, marketplace: plan.marketplace, campaigns: planDecisions.length, decisions: planDecisions, selfCompetition: planConflicts })
    if (!dryRun) {
      try { await prisma.productRankPlan.update({ where: { id: plan.id }, data: { lastEvaluatedAt: new Date(), lastSummary: { at: new Date().toISOString(), activeTargetKey: key ?? null, campaigns: planDecisions.length, decisions: planDecisions, selfCompetition: planConflicts } as never } }) } catch { /* best-effort */ }
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
