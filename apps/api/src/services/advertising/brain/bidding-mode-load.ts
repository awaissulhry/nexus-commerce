/**
 * ONE BRAIN AB-17 — the facts of the bidding-strategy lever (brain/bidding-mode.ts), read for one product in one market: a
 * fixed number of queries whatever the number of campaigns (no N+1). Read only: nothing here writes, in Nexus or at Amazon.
 *
 *   campaigns   the product's own and shared Sponsored Products campaigns of the market (brain/ownership.ts; archived left
 *               out), each with its resolved biddingStrategy lever and settings (brain/settings.ts)
 *   the rules   the product's phase and ACoS band (its ads strategy), its ad orders of 30 settled days; per campaign the
 *               placement report of LANE_WINDOW_DAYS settled days (top of search and every placement), the placement %
 *               live, its highest enabled bid, its hourly plan (whether it sets placement %, its lowest CPC ceiling of the
 *               week) and whether the brain writes the plan's placements
 *   stops       the stop recipe's memory (the saved strategy and lanes), a floor's mark, keywords holding a remembered bid,
 *               a declared STOP hold, and the pauses the product cycle's state step makes this cycle (`stopping`)
 *   holds       a person's own strategy (an open STRATEGY hold; his change on record, or Amazon's report of a change made
 *               outside Nexus, for HOLD_DAYS), the bids pin, Amazon's own strategy (brain/native-rules.ts), the kill switch
 *               and auto-undo's hold (brain/lever-holds.ts), the live-write allowlist
 *   switches    every strategy change on record of the campaigns (the action log, and Amazon's reports of changes made
 *               outside Nexus): the newest outside a stop is the spacing's; the stop recipe's down only and its give-back
 *               (the bid brain's writes under a stop layer) never count. The brain's own: its writer's, or a request it
 *               asked for that a person approved
 *   tests       each campaign's open test (AdsBrainStrategyTest) followed to now (bidding-mode.ts followTest): its request,
 *               the switch the request made, the switch's own row, auto-undo's judgement; the newest switch a person
 *               declined; the daily figures a verdict needs
 *   clock       the N4 clock (AdsBrainLeverClock) and the Owner's choice that made the lever the brain's
 */
import { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { EXCLUDE_AMS_DAILY } from '../../ads-core/ams-daily.js'
import { autoUndoThresholds } from '../ads-auto-undo-thresholds.js'
import { REPORT_LABEL_TO_PLACEMENT, PLACEMENT_TOP } from '../ads-placement-math.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { BRAIN_STRATEGY_ACTOR } from '../ads-write-gate.js'
import { BRAIN_ACTOR, brainOwnedCampaignIds } from '../bid-brain/live.js'
import { STOP_HOLD_KIND, STRATEGY_HOLD_KIND } from '../bid-brain/facts.js'
import { dayCeilingCents, isMinBidSpec } from '../bid-brain/plan-hour.js'
import type { Placement } from '../bid-brain/stop-recipe.js'
import type { RankTargetSpec, ScheduleWindow } from '../rank-controller.js'
import {
  DECLINE_DAYS, followTest, HOLD_DAYS, LANE_WINDOW_DAYS, NOT_LANDED, OPEN_TEST_STATUSES, testWeeksOf, EXTRA_TEST_WEEKS, words,
  type FollowedTest, type LaneFigures, type ModeFacts, type TestEvents, type TestRecord, type TestStatus,
} from './bidding-mode.js'
import { campaignHoldWhy, leverHolds } from './lever-holds.js'
import { isLevel, type BrainLevel } from './levers.js'
import { nativeRuleLines, loadNativeRules } from './native-rules.js'
import { productCampaigns } from './ownership.js'
import { resolveBrainSettings, describeProvenance, type OverrideRow } from './settings.js'
import { STOP_LAYERS, type Band, type Sums } from './undo-levers.js'

const DAY_MS = 86_400_000
const WATCHING: readonly BrainLevel[] = ['OBSERVE', 'PROPOSE', 'AUTO']
const LEVER = 'biddingStrategy' as const
const OVERRIDE_SELECT = { id: true, productId: true, marketplace: true, scope: true, campaignId: true, kind: true, key: true, ref: true, value: true, by: true, reason: true, createdAt: true, endedAt: true } as const
/** How far back the switches on record are read: the longest spacing the Owner may set, and a person's hold. */
const SWITCH_LOOKBACK_DAYS = 400
const day = (d: Date | string) => (typeof d === 'string' ? d : d.toISOString()).slice(0, 10)
const minDay = (a: string, b: string) => (a < b ? a : b)
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)

export interface ModeWatched { productId: string; market: string; level: BrainLevel }

/**
 * The enrolled products whose biddingStrategy lever is OBSERVE or higher — for the product, or for one of its campaigns by
 * the Owner's campaign override (two reads). Production today: none, so nothing runs.
 */
export async function modeWatchProducts(): Promise<ModeWatched[]> {
  const enrollments = await prisma.adsBrainEnrollment.findMany({ select: { productId: true, marketplace: true } })
  if (!enrollments.length) return []
  const overrides = await prisma.adsBrainOverride.findMany({
    where: { endedAt: null, productId: { in: [...new Set(enrollments.map((e) => e.productId))] }, OR: [{ scope: 'PRODUCT' }, { scope: 'CAMPAIGN', kind: 'LEVEL', key: LEVER }] },
    select: OVERRIDE_SELECT,
  }) as OverrideRow[]
  return enrollments.flatMap((e) => {
    const level = resolveBrainSettings({ productId: e.productId, market: e.marketplace, enrolled: true, overrides }).levers[LEVER].effective
    const campaignWatch = overrides.some((o) => o.scope === 'CAMPAIGN' && o.productId === e.productId && o.marketplace === e.marketplace && WATCHING.includes(o.value as BrainLevel))
    if (isLevel(level) && WATCHING.includes(level)) return [{ productId: e.productId, market: e.marketplace, level }]
    return campaignWatch ? [{ productId: e.productId, market: e.marketplace, level: 'OBSERVE' as BrainLevel }] : []
  }).sort((a, b) => a.market.localeCompare(b.market) || a.productId.localeCompare(b.productId))
}

/** One campaign's newest decision in the lever's log. */
export interface PreviousModeRow { campaignId: string; decisionHash: string; createdAt: Date; action: string; outcome: string; mode: string; approvalId: string | null; testId: string | null; why: string }

/** Each campaign's newest decision in the lever's log (one statement). */
export async function newestModeDecisions(campaignIds: readonly string[]): Promise<Map<string, PreviousModeRow>> {
  if (!campaignIds.length) return new Map()
  const rows = await prisma.$queryRaw<PreviousModeRow[]>(Prisma.sql`
    SELECT DISTINCT ON ("campaignId") "campaignId", "decisionHash", "createdAt", "action", "outcome", "mode", "approvalId", "testId", "why"
      FROM "AdsBrainStrategyDecision"
     WHERE "campaignId" = ANY(${[...campaignIds]}::text[])
     ORDER BY "campaignId", "createdAt" DESC, "id" DESC`)
  return new Map(rows.map((r) => [r.campaignId, { ...r, createdAt: new Date(r.createdAt) }]))
}

/** One strategy change on record (the action log), as the lever reads it. */
interface StrategyChange { id: string; entityId: string; userId: string | null; executionId: string | null; from: string | null; to: string; layer: string | null; result: string | null; at: Date }

/** Every strategy change on record of these campaigns since `since`, newest first (one statement); a write never sent left out. */
async function strategyChanges(campaignIds: readonly string[], since: Date): Promise<StrategyChange[]> {
  if (!campaignIds.length) return []
  const rows = await prisma.$queryRaw<Array<Omit<StrategyChange, 'at'> & { at: Date }>>(Prisma.sql`
    SELECT "id", "entityId", "userId", "executionId", "payloadBefore"->>'biddingStrategy' AS "from", "payloadAfter"->>'biddingStrategy' AS "to",
           "evidence"->'brain'->>'layer' AS "layer", "amazonResponseStatus" AS "result", "createdAt" AS "at"
      FROM "AdvertisingActionLog"
     WHERE "entityType" = 'CAMPAIGN' AND "entityId" = ANY(${[...campaignIds]}::text[]) AND "rolledBackAt" IS NULL AND "createdAt" >= ${since}
       AND "payloadAfter"->>'biddingStrategy' IS NOT NULL AND ("payloadBefore"->>'biddingStrategy') IS DISTINCT FROM ("payloadAfter"->>'biddingStrategy')
     ORDER BY "createdAt" DESC, "id" DESC`)
  return rows.map((r) => ({ ...r, at: new Date(r.at) }))
}

/** The stop recipe's own switch (down only for a stop) or its give-back: never a switch the spacing counts (AB-2). */
const isStopSwitch = (c: Pick<StrategyChange, 'userId' | 'layer'>): boolean => c.userId === BRAIN_ACTOR && !!c.layer && STOP_LAYERS.has(c.layer)

/** Who made a strategy change, as the lever reads it: the brain (its writer, or a request it asked for), a person, or automation. */
export function strategyChanger(c: Pick<StrategyChange, 'userId' | 'executionId'>, brainApprovals: ReadonlySet<string>): { by: 'brain' | 'person' | 'automation'; who: string } {
  if (c.userId === BRAIN_STRATEGY_ACTOR) return { by: 'brain', who: 'the brain' }
  if (c.executionId && brainApprovals.has(c.executionId)) return { by: 'brain', who: `the brain (a request ${c.executionId} a person approved)` }
  // A request a person approved writes as that person (`user:`, its approval the execution); an engine writes as itself.
  if (c.userId?.startsWith('automation:')) return { by: 'automation', who: c.userId }
  return { by: 'person', who: c.userId ?? 'an unnamed writer' }
}

/** The product's ads strategy as the rules read it: its phase, its ACoS band (fractions). */
async function phaseAndBand(root: string, market: string): Promise<{ phase: string | null; band: Band | null }> {
  const { openStrategy } = await import('../ads-strategy/effective.js')
  const { resolveGoal, isGoal, BRAIN_PHASES } = await import('../bid-brain/goal.js')
  const view = await openStrategy(market)
  const e = (await view.forEachProduct([root])).get(root) ?? view.forMarket()
  const t = e.resolved.fields.get('target')?.value as { targetKind?: unknown; targetPct?: unknown; targetLoPct?: unknown; targetHiPct?: unknown } | undefined
  const target = t && (t.targetKind === 'ACOS' || t.targetKind === 'TACOS') && typeof t.targetPct === 'number' ? { kind: t.targetKind, pct: t.targetPct } as const : null
  const side = (v: unknown) => (typeof v === 'number' ? v : null)
  const band = target && (side(t?.targetLoPct) != null || side(t?.targetHiPct) != null) ? { loPct: side(t?.targetLoPct), hiPct: side(t?.targetHiPct) } : null
  const raw = e.resolved.fields.get('goal')?.value
  const phase = (BRAIN_PHASES as readonly string[]).includes(raw as string) ? raw as string : null
  const g = resolveGoal({ target, acosFallbackPct: e.values.targetAcosPct, band, phase: phase as never })
  return { phase, band: isGoal(g) && g.kind === 'ACOS' ? { aim: g.aim, lo: g.lo, hi: g.hi } : null }
}

/** Each campaign's hourly plan: whether a serving hour sets a placement %, and the plan's lowest CPC ceiling of the week. */
async function planSteering(campaignIds: readonly string[]): Promise<Map<string, { name: string; steersPlacements: boolean; ceilingCents: number | null }>> {
  const out = new Map<string, { name: string; steersPlacements: boolean; ceilingCents: number | null }>()
  if (!campaignIds.length) return out
  const { applyTargetOverrides, isGoalMode, toSpec } = await import('../../../jobs/ad-rank-defend.job.js')
  const schedules = (await prisma.adSchedule.findMany({
    where: { campaignId: { in: [...campaignIds] }, enabled: true },
    select: { id: true, campaignId: true, name: true, windows: true, defaultTargetKey: true, targetOverrides: true, group: { select: { name: true } } },
    orderBy: { id: 'asc' },
  })).filter((s) => isGoalMode(s.windows, s.defaultTargetKey))
  if (!schedules.length) return out
  const keysOf = (s: (typeof schedules)[number]) => [...new Set([...((s.windows ?? []) as ScheduleWindow[]).map((w) => w?.targetKey).filter((k): k is string => !!k), ...(s.defaultTargetKey ? [s.defaultTargetKey] : [])])]
  const targets = await prisma.rankTarget.findMany({ where: { key: { in: [...new Set(schedules.flatMap(keysOf))] } } })
  const byKey = new Map(targets.map((t) => [t.key, t]))
  for (const s of schedules) {
    if (out.has(s.campaignId)) continue
    const specs = keysOf(s).map((k) => byKey.get(k)).filter((t): t is NonNullable<typeof t> => !!t).map((t) => applyTargetOverrides(toSpec(t as never), s.targetOverrides as never) as RankTargetSpec)
    const serving = specs.filter((sp) => !isMinBidSpec(sp))
    const steers = serving.some((sp) => (sp.biasPct ?? 0) > 0 || (Array.isArray(sp.lanes) && sp.lanes.some((l) => ((l as { biasPct?: number | null }).biasPct ?? 0) > 0)))
    out.set(s.campaignId, { name: s.group?.name ?? s.name, steersPlacements: steers, ceilingCents: dayCeilingCents(specs) })
  }
  return out
}

/** Campaign.dynamicBidding.placementBidding as stored. */
const lanesOf = (dynamicBidding: unknown): Placement[] => {
  const list = ((dynamicBidding ?? {}) as { placementBidding?: unknown }).placementBidding
  return (Array.isArray(list) ? list : []).flatMap((p) => (typeof (p as Placement)?.placement === 'string' && Number.isFinite(Number((p as Placement).percentage)) ? [{ placement: (p as Placement).placement, percentage: Number((p as Placement).percentage) }] : []))
}
const savedLanes = (raw: unknown): Placement[] | null => (Array.isArray(raw) ? lanesOf({ placementBidding: raw }) : null)

/** The highest enabled bid per campaign: a keyword or target's, else an enabled ad group's default (one statement). */
async function maxBids(campaignIds: readonly string[]): Promise<Map<string, number>> {
  if (!campaignIds.length) return new Map()
  const rows = await prisma.$queryRaw<Array<{ campaignId: string; target: number | null; group: number | null }>>(Prisma.sql`
    SELECT g."campaignId",
           max(t."bidCents") FILTER (WHERE t."id" IS NOT NULL AND t."isNegative" = false AND t."status" = 'ENABLED')::int AS "target",
           max(g."defaultBidCents")::int AS "group"
      FROM "AdGroup" g LEFT JOIN "AdTarget" t ON t."adGroupId" = g."id"
     WHERE g."campaignId" = ANY(${[...campaignIds]}::text[]) AND g."status" = 'ENABLED'
     GROUP BY g."campaignId"`)
  return new Map(rows.flatMap((r) => { const v = r.target ?? r.group; return v != null ? [[r.campaignId, Number(v)] as [string, number]] : [] }))
}

/** Keywords holding a remembered bid (a stop's memory), per campaign — one statement. */
async function flooredKeywords(campaignIds: readonly string[]): Promise<Map<string, number>> {
  if (!campaignIds.length) return new Map()
  const rows = await prisma.$queryRaw<Array<{ campaignId: string; n: number }>>(Prisma.sql`
    SELECT g."campaignId", count(*)::int AS n FROM "AdTarget" t JOIN "AdGroup" g ON g."id" = t."adGroupId"
     WHERE g."campaignId" = ANY(${[...campaignIds]}::text[]) AND t."suppressedFromBidCents" IS NOT NULL
     GROUP BY g."campaignId"`)
  return new Map(rows.map((r) => [r.campaignId, Number(r.n)]))
}

/** The placement report over the window, per campaign (Amazon's id): top of search and every placement. */
async function laneFigures(externalIds: readonly string[], from: Date, until: Date): Promise<Map<string, { tos: LaneFigures; all: LaneFigures }>> {
  const out = new Map<string, { tos: LaneFigures; all: LaneFigures }>()
  if (!externalIds.length) return out
  const rows = await prisma.amazonAdsPlacementReport.groupBy({
    by: ['campaignId', 'placement'],
    where: { campaignId: { in: [...externalIds] }, adProduct: 'SPONSORED_PRODUCTS', date: { gte: from, lte: until } },
    _sum: { clicks: true, orders7d: true, sales7dCents: true },
  })
  for (const r of rows) {
    const into = out.get(r.campaignId) ?? { tos: { clicks: 0, orders: 0, salesCents: 0 }, all: { clicks: 0, orders: 0, salesCents: 0 } }
    const add = (l: LaneFigures) => { l.clicks += r._sum.clicks ?? 0; l.orders += r._sum.orders7d ?? 0; l.salesCents += r._sum.sales7dCents ?? 0 }
    add(into.all)
    if ((REPORT_LABEL_TO_PLACEMENT[r.placement] ?? r.placement) === PLACEMENT_TOP) add(into.tos)
    out.set(r.campaignId, into)
  }
  return out
}

/** The daily campaign figures over [from, to], per campaign and day (minor units). */
async function dailyFigures(campaignIds: readonly string[], from: string, to: string): Promise<Map<string, Map<string, Sums>>> {
  const out = new Map<string, Map<string, Sums>>()
  if (!campaignIds.length || to < from) return out
  const rows = await prisma.amazonAdsDailyPerformance.groupBy({
    by: ['localEntityId', 'date'],
    where: { entityType: 'CAMPAIGN', localEntityId: { in: [...campaignIds] }, date: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) }, ...EXCLUDE_AMS_DAILY },
    _sum: { costMicros: true, sales7dCents: true, clicks: true, orders7d: true },
  })
  for (const r of rows) {
    if (!r.localEntityId) continue
    const m = out.get(r.localEntityId) ?? new Map<string, Sums>()
    m.set(day(r.date), { spendCents: Math.round(Number(r._sum.costMicros ?? 0) / 10_000), salesCents: r._sum.sales7dCents ?? 0, clicks: r._sum.clicks ?? 0, orders: r._sum.orders7d ?? 0 })
    out.set(r.localEntityId, m)
  }
  return out
}

/**
 * The newest settled day of the market's daily report: AB-15's settled line, never past what the report holds. A market with
 * no report yet keeps the line: its sums are empty, so every verdict reads "too little data" and no product is more than thin.
 */
export async function settledThroughOf(market: string, now: Date): Promise<string> {
  const t = autoUndoThresholds(market)
  const settled = day(new Date(now.getTime() - t.settleHours * 3_600_000 - DAY_MS))
  const newest = await prisma.amazonAdsDailyPerformance.findFirst({ where: { marketplace: market, entityType: 'CAMPAIGN', ...EXCLUDE_AMS_DAILY }, orderBy: { date: 'desc' }, select: { date: true } })
  return newest ? minDay(settled, day(newest.date)) : settled
}

const TEST_SELECT = { id: true, campaignId: true, status: true, fromStrategy: true, toStrategy: true, rule: true, level: true, approvalId: true, switchedAt: true, actionLogId: true, revertApprovalId: true, verdict: true, verdictAt: true, createdAt: true, updatedAt: true, why: true } as const
type TestRow = { id: string; campaignId: string; status: string; fromStrategy: string; toStrategy: string; rule: string; level: string; approvalId: string | null; switchedAt: Date | null; actionLogId: string | null; revertApprovalId: string | null; verdict: string | null; verdictAt: Date | null; createdAt: Date; updatedAt: Date; why: string }
export const testRecordOf = (r: TestRow): TestRecord => ({ id: r.id, status: r.status as TestStatus, from: r.fromStrategy, to: r.toStrategy, rule: r.rule, level: r.level, approvalId: r.approvalId, switchedAt: r.switchedAt, actionLogId: r.actionLogId, revertApprovalId: r.revertApprovalId, createdAt: r.createdAt, why: r.why })

export interface ProductModeFacts {
  productId: string
  market: string
  enrolled: boolean
  facts: ModeFacts[]
  previous: Map<string, PreviousModeRow>
  /** Each open test followed to now: the record as stored and what changed (for the runner to store). */
  followed: Map<string, { record: TestRecord; followed: FollowedTest }>
  /** The lever is the brain's (PROPOSE or AUTO) on the product or one of its own campaigns. */
  owned: boolean
  /** The Owner's choice that made it the brain's (the oldest open one of them), and the N4 clock as stored. */
  ownedBy: { at: Date; by: string } | null
  clock: { since: Date; by: string } | null
  /** The product's enrollment (the clock never starts before it). */
  enrolledAt: Date | null
  settledThrough: string
}

/** The facts of every campaign of one product in one market (`productId` may be a variation: its family root is used). */
export async function loadProductModeFacts(productId: string, marketIn: string, opts: { now: Date; stopping?: ReadonlyMap<string, string> }): Promise<ProductModeFacts | null> {
  const now = opts.now
  const market = strategyMarket(marketIn)
  if (!market || !/^[A-Z]{2}$/.test(market)) return null
  const camps = await productCampaigns(productId, market)
  if (!camps) return null
  const root = camps.root
  const all = [...camps.owned.map((c) => ({ ...c, side: 'product' as const })), ...camps.shared.map((c) => ({ ...c, side: 'shared' as const }))]
  const ids = all.map((c) => c.campaignId)
  const ownIds = camps.owned.map((c) => c.campaignId)
  const settledThrough = await settledThroughOf(market, now)
  const windowFrom = new Date(`${plusDays(settledThrough, -(LANE_WINDOW_DAYS - 1))}T00:00:00Z`)
  const windowTo = new Date(`${settledThrough}T00:00:00Z`)
  const [enrollment, overrides, rows, holds, changes, drift, tests, previous, floored, bids, plans, owned, strategy, nativeRules, leverHeld, clock] = await Promise.all([
    prisma.adsBrainEnrollment.findFirst({ where: { productId: root, marketplace: market }, select: { id: true, createdAt: true } }),
    prisma.adsBrainOverride.findMany({ where: { endedAt: null, OR: [{ scope: 'PRODUCT', productId: root, marketplace: market }, ...(ids.length ? [{ scope: 'CAMPAIGN', campaignId: { in: ids } }] : [])] }, select: OVERRIDE_SELECT }) as Promise<OverrideRow[]>,
    ids.length ? prisma.campaign.findMany({
      where: { id: { in: ids } },
      select: {
        id: true, name: true, status: true, startDate: true, createdAt: true, externalCampaignId: true, biddingStrategy: true, dynamicBidding: true, liveBidWritesEnabled: true,
        pinBids: true, pinnedBy: true, bidsSuppressedAt: true, bidsSuppressedBy: true, suppressedFromPlacements: true, suppressedFromBiddingStrategy: true,
      },
    }) : Promise.resolve([]),
    ids.length ? prisma.bidHold.findMany({ where: { campaignId: { in: ids }, targetId: null, kind: { in: [STOP_HOLD_KIND, STRATEGY_HOLD_KIND] }, endedAt: null }, select: { campaignId: true, kind: true, by: true, until: true } }) : Promise.resolve([]),
    strategyChanges(ids, new Date(now.getTime() - SWITCH_LOOKBACK_DAYS * DAY_MS)),
    ids.length ? prisma.adDrift.findMany({ where: { entityType: 'CAMPAIGN', entityId: { in: ids }, field: 'biddingStrategy', classification: 'EXTERNAL_CHANGE' }, select: { entityId: true, lastDetectedAt: true, amazonValue: true } }) : Promise.resolve([]),
    ids.length ? prisma.adsBrainStrategyTest.findMany({ where: { campaignId: { in: ids }, createdAt: { gte: new Date(now.getTime() - SWITCH_LOOKBACK_DAYS * DAY_MS) } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: TEST_SELECT }) as Promise<TestRow[]> : Promise.resolve([] as TestRow[]),
    newestModeDecisions(ids),
    flooredKeywords(ids),
    maxBids(ownIds),
    planSteering(ownIds),
    ownIds.length ? brainOwnedCampaignIds(ownIds) : Promise.resolve(new Set<string>()),
    ownIds.length ? phaseAndBand(root, market) : Promise.resolve({ phase: null, band: null }),
    loadNativeRules(ids, now),
    leverHolds(LEVER, root, market, now),
    prisma.adsBrainLeverClock.findFirst({ where: { productId: root, marketplace: market, lever: LEVER }, select: { since: true, by: true } }),
  ])
  const rowOf = new Map(rows.map((r) => [r.id, r]))
  const enrolled = !!enrollment
  const productSettings = resolveBrainSettings({ productId: root, market, campaignId: null, enrolled, overrides })
  const settingsOf = new Map(all.map((c) => [c.campaignId, resolveBrainSettings({ productId: root, market, campaignId: c.campaignId, enrolled, overrides })]))

  // The tests: the brain's own requests (their approvals make a change on record the brain's), the open ones followed.
  const brainApprovals = new Set(tests.flatMap((t) => [t.approvalId, t.revertApprovalId]).filter((x): x is string => !!x))
  const open = tests.filter((t) => (OPEN_TEST_STATUSES as readonly string[]).includes(t.status))
  const openOf = new Map<string, TestRow>()
  for (const t of open) if (!openOf.has(t.campaignId)) openOf.set(t.campaignId, t)
  const requestOf = (t: TestRow) => (t.status === 'REVERT_ASKED' ? t.revertApprovalId : t.status === 'ASKED' ? t.approvalId : null)
  const askedIds = [...openOf.values()].map(requestOf).filter((x): x is string => !!x)
  const switchRows = [...openOf.values()].map((t) => t.actionLogId).filter((x): x is string => !!x)
  const [approvals, switchResults, undos] = await Promise.all([
    askedIds.length ? prisma.agentApproval.findMany({ where: { id: { in: askedIds } }, select: { id: true, status: true, decidedAt: true } }) : Promise.resolve([]),
    switchRows.length ? prisma.advertisingActionLog.findMany({ where: { id: { in: switchRows } }, select: { id: true, amazonResponseStatus: true } }) : Promise.resolve([]),
    switchRows.length ? prisma.adsAutoUndoJudgement.findMany({ where: { actionLogId: { in: switchRows } }, select: { actionLogId: true, action: true, final: true } }) : Promise.resolve([]),
  ])
  const approvalOf = new Map(approvals.map((a) => [a.id, a]))
  const resultOf = new Map(switchResults.map((r) => [r.id, r.amazonResponseStatus]))
  const undoOf = new Map(undos.map((u) => [u.actionLogId, u]))
  const followed = new Map<string, { record: TestRecord; followed: FollowedTest }>()
  for (const [campaignId, t] of openOf) {
    const row = rowOf.get(campaignId)
    if (!row) continue
    const reqId = requestOf(t)
    const a = reqId ? approvalOf.get(reqId) : undefined
    const landedRow = reqId ? changes.find((c) => c.entityId === campaignId && c.executionId === reqId && !(c.result && NOT_LANDED.includes(c.result))) : undefined
    const events: TestEvents = {
      approval: a ? { status: a.status, decidedAt: a.decidedAt } : null,
      landed: landedRow ? { at: landedRow.at, actionLogId: landedRow.id, to: landedRow.to } : null,
      switchResult: t.actionLogId ? resultOf.get(t.actionLogId) ?? null : null,
      undo: t.actionLogId && undoOf.get(t.actionLogId) ? { action: undoOf.get(t.actionLogId)!.action, final: undoOf.get(t.actionLogId)!.final } : null,
    }
    const record = testRecordOf(t)
    followed.set(campaignId, { record, followed: followTest(record, events, { current: String(row.biddingStrategy), savedStrategy: row.suppressedFromBiddingStrategy ? String(row.suppressedFromBiddingStrategy) : null }) })
  }

  // The daily figures the verdicts need: the open tests' campaigns, from the earliest baseline to the settled day.
  const testing = [...followed.entries()].filter(([, f]) => f.followed.status === 'TESTING' && f.followed.switchedAt)
  const earliest = testing.length ? Math.min(...testing.map(([cid, f]) => {
    const weeks = testWeeksOf(Number(settingsOf.get(cid)?.values.biddingStrategySwitchDays.value ?? 14)) + EXTRA_TEST_WEEKS
    return Date.parse(`${day(f.followed.switchedAt!)}T00:00:00Z`) - weeks * 7 * DAY_MS
  })) : null
  // The product's ad orders of 30 settled days, and its own campaigns' placement report of the window.
  const externalOf = new Map(rows.filter((r) => r.externalCampaignId).map((r) => [r.id, r.externalCampaignId!]))
  const [figures, orders30, lanes] = await Promise.all([
    earliest != null ? dailyFigures(testing.map(([cid]) => cid), day(new Date(earliest)), settledThrough) : Promise.resolve(new Map<string, Map<string, Sums>>()),
    ownIds.length
      ? prisma.amazonAdsDailyPerformance.aggregate({ where: { entityType: 'CAMPAIGN', localEntityId: { in: ownIds }, date: { gte: new Date(`${plusDays(settledThrough, -29)}T00:00:00Z`), lte: windowTo }, ...EXCLUDE_AMS_DAILY }, _sum: { orders7d: true }, _count: { _all: true } })
      : Promise.resolve(null),
    laneFigures(ownIds.map((id) => externalOf.get(id)).filter((x): x is string => !!x), windowFrom, windowTo),
  ])
  const productOrders30d = orders30 && orders30._count._all > 0 ? orders30._sum.orders7d ?? 0 : null

  const facts: ModeFacts[] = []
  for (const c of all) {
    const row = rowOf.get(c.campaignId)
    if (!row) continue
    const s = settingsOf.get(c.campaignId)!
    const lever = s.levers[LEVER]
    const lock = lever.lock ? { words: `locked by ${describeProvenance(lever.lock)}${lever.lock.value ? ` at ${words(String(lever.lock.value))}` : ' as it is'}${lever.lock.reason ? `: "${lever.lock.reason}"` : ''}`, value: typeof lever.lock.value === 'string' ? lever.lock.value : null } : null
    const current = String(row.biddingStrategy)
    const saved = row.suppressedFromBiddingStrategy ? String(row.suppressedFromBiddingStrategy) : null
    const savedPlacements = savedLanes(row.suppressedFromPlacements)
    // A stop holding the campaign: the stop recipe owns the strategy while it lasts.
    const stopHold = holds.find((h) => h.campaignId === c.campaignId && h.kind === STOP_HOLD_KIND)
    const stop = saved ? `a stop holds it at down only (the stop recipe saved its ${words(saved)})`
      : row.bidsSuppressedAt ? `a stop floors it since ${day(row.bidsSuppressedAt)} (${row.bidsSuppressedBy ?? 'an engine'})`
        : stopHold ? `a declared stop by ${stopHold.by}`
          : savedPlacements ? 'a stop holds its placements at 0 % (the stop recipe saved them)'
            : (floored.get(c.campaignId) ?? 0) > 0 ? `a stop floors ${floored.get(c.campaignId)} of its keywords (their bids remembered)`
              : opts.stopping?.get(c.campaignId) ?? null
    // A person's own strategy: an open STRATEGY hold, else his newest change on record (Nexus or outside it) for HOLD_DAYS.
    const mine = changes.filter((x) => x.entityId === c.campaignId && !(x.result && NOT_LANDED.includes(x.result)))
    const strategyHold = holds.find((h) => h.campaignId === c.campaignId && h.kind === STRATEGY_HOLD_KIND && (!h.until || h.until.getTime() > now.getTime()))
    const newestPerson = mine.map((x) => ({ x, who: strategyChanger(x, brainApprovals) })).find((p) => p.who.by === 'person' && !isStopSwitch(p.x))
    const outside = drift.filter((d) => d.entityId === c.campaignId).sort((a, b) => b.lastDetectedAt.getTime() - a.lastDetectedAt.getTime())[0]
    const personAt = [newestPerson ? { at: newestPerson.x.at, who: newestPerson.who.who } : null, outside ? { at: outside.lastDetectedAt, who: 'a change outside Nexus (Amazon, Seller Central)' } : null]
      .filter((p): p is { at: Date; who: string } => !!p && now.getTime() - p.at.getTime() < HOLD_DAYS * DAY_MS)
      .sort((a, b) => b.at.getTime() - a.at.getTime())[0]
    const newestBrain = mine.find((x) => strategyChanger(x, brainApprovals).by === 'brain')
    // A person's change older than the brain's own newest switch is not his strategy any more: the brain's switch replaced it.
    const personHold = strategyHold ? `held by ${strategyHold.by}${strategyHold.until ? ` until ${day(strategyHold.until)}` : ''}`
      : personAt && (!newestBrain || personAt.at.getTime() > newestBrain.at.getTime()) ? `${personAt.who} set it on ${day(personAt.at)}: a hold until ${day(new Date(personAt.at.getTime() + HOLD_DAYS * DAY_MS))}` : null
    // The newest switch outside a stop, for the spacing (anyone's: the brain, a person, auto-undo, outside Nexus).
    const lastLogged = mine.find((x) => !isStopSwitch(x))
    const lastSwitch = [lastLogged ? { at: lastLogged.at, to: lastLogged.to, by: strategyChanger(lastLogged, brainApprovals).who } : null, outside ? { at: outside.lastDetectedAt, to: String(outside.amazonValue ?? current), by: 'a change outside Nexus' } : null]
      .filter((x): x is { at: Date; to: string; by: string } => !!x)
      .sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? null
    const f = followed.get(c.campaignId)
    const openTest = f && (OPEN_TEST_STATUSES as readonly string[]).includes(f.followed.status) ? { ...f.record, status: f.followed.status, switchedAt: f.followed.switchedAt, actionLogId: f.followed.actionLogId } : null
    // The newest switch a person declined: one stored so, or the open request this run found declined.
    const declinedRow = f?.followed.status === 'DECLINED'
      ? { toStrategy: f.record.to, updatedAt: approvalOf.get(f.record.approvalId ?? '')?.decidedAt ?? now }
      : tests.find((t) => t.campaignId === c.campaignId && t.status === 'DECLINED' && now.getTime() - t.updatedAt.getTime() < DECLINE_DAYS * DAY_MS)
    const nativeLine = nativeRuleLines(nativeRules.get(c.campaignId), LEVER)[0] ?? null
    const revertedRow = tests.find((t) => t.campaignId === c.campaignId && t.verdict === 'revert')
    const started = row.startDate && row.startDate.getTime() < row.createdAt.getTime() ? row.startDate : row.createdAt
    const lanesNow = lanesOf(row.dynamicBidding)
    facts.push({
      campaignId: c.campaignId, name: row.name, productId: root, market, status: String(row.status), owner: c.side,
      lever: { effective: lever.effective, why: lever.why, lock },
      current, native: nativeLine,
      ageDays: Math.floor((now.getTime() - started.getTime()) / DAY_MS),
      phase: strategy.phase, band: strategy.band, productOrders30d,
      lanes: externalOf.has(c.campaignId) ? lanes.get(externalOf.get(c.campaignId)!) ?? null : null,
      placements: savedPlacements ?? lanesNow,
      maxBidCents: bids.get(c.campaignId) ?? null,
      plan: plans.get(c.campaignId) ?? null,
      brainRunsPlacements: owned.has(c.campaignId) || s.levers.hours.owned || s.levers.placements.owned,
      stop, savedStrategy: saved, personHold,
      pinned: row.pinBids ? `held by its bids pin${row.pinnedBy ? ` (${row.pinnedBy})` : ''}` : null,
      allowlisted: !!row.liveBidWritesEnabled,
      held: campaignHoldWhy(leverHeld, c.campaignId),
      lastSwitch,
      test: openTest,
      days: figures.get(c.campaignId) ?? null,
      declined: declinedRow ? { to: declinedRow.toStrategy, at: declinedRow.updatedAt } : null,
      lastReverted: revertedRow ? { to: revertedRow.toStrategy, at: revertedRow.verdictAt ?? revertedRow.updatedAt } : null,
      switchDays: Number(s.values.biddingStrategySwitchDays.value),
      switchMode: String(s.values.strategySwitchMode.value),
      approvalDays: Number(productSettings.values.strategyApprovalDays.value),
      clockSince: clock?.since ?? null,
    })
  }

  // Is the lever the brain's anywhere in the product, and since which of the Owner's choices (the oldest open one).
  const ownedHere = productSettings.levers[LEVER].owned || camps.owned.some((c) => settingsOf.get(c.campaignId)?.levers[LEVER].owned)
  const owning = overrides.filter((o) => !o.endedAt && o.kind === 'LEVEL' && o.key === LEVER && (o.value === 'PROPOSE' || o.value === 'AUTO'))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0]
  return {
    productId: root, market, enrolled, facts, previous, followed, owned: ownedHere,
    ownedBy: owning ? { at: new Date(owning.createdAt), by: owning.by } : null,
    clock: clock ? { since: clock.since, by: clock.by } : null,
    enrolledAt: enrollment?.createdAt ?? null,
    settledThrough,
  }
}
