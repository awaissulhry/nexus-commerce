/**
 * BID BRAIN BB-22 — the learned hour factors' reads and writes (hour-factors.ts is the maths, hour-factors-apply.ts what a
 * run does with them). Called inside a business (the bid brain's cron runs once per business; RLS keeps each to its own).
 *
 *   learn    one product × market: its OWN campaigns with an hourly plan (brain/ownership.ts — a shared campaign is no
 *            product's, D2), their goal-mode schedules (each plan's week as it stood each day — its RankScheduleVersion in
 *            force — with its targets and each campaign's own values), AB-13's research facts (brain/hours-research.ts: the
 *            product's, its category's and its market's hours over hourResearchWeeks, the daily level, the placement
 *            report) with the days a dated event replaced the week and the days BB-16's feed was capped left out, the
 *            product's own campaign hours (the plan's multiplier in force on each), the market's placement report (the
 *            top-of-search pool) and the product's ACoS goal → hour-factors.ts learnHourFactors → one row per product ×
 *            market, replaced (no history).
 *   when     in the bid brain's FULL runs only (never a 15-minute tick), for the products of the campaigns it owns whose
 *            plan holds an hour: a product not learned within LEARN_EVERY_HOURS, or one of whose plans changed since (the
 *            schedule's basis), or with a campaign the row does not cover, is learned again. A failure is logged and
 *            changes nothing: the plan's values run.
 *   run      hourFactorsForRun — NEXUS_BID_BRAIN_HOUR_FACTORS off: nothing read, the run as before; shadow (default):
 *            full runs only, the moves said in the why, nothing else; on: every run — the moves carried out where the
 *            product's brain owns the hours lever (PROPOSE, the Owner's switch per product) and its kill switch is off,
 *            said in the why elsewhere. The Owner's locks (an hour cell, the whole lever) and his hourCellMovePct are read
 *            each time (brain/settings.ts through hours-proposal.ts).
 */
import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { REPORT_LABEL_TO_PLACEMENT } from '../ads-placement-math.js'
import { grainCappedDays } from '../ams-grain.service.js'
import { resolveActiveTargetKey, type ScheduleWindow } from '../rank-controller.js'
import {
  cellRef, hourKey, loadCampaignHours, loadResearchFacts, localDayHour, researchDays, researchHours, researchTimeZone, weekdayOf,
  type HourCell,
} from '../brain/hours-research.js'
import type { PaintTarget } from '../brain/hours-paint.js'
import { productCampaigns, resolveCampaignOwnership } from '../brain/ownership.js'
import { leverKillWhy } from '../brain/kill-switch.js'
import {
  cappedLocalDays, hourFactorMode, laneShares, learnHourFactors, multiplierOf, planTargets,
  type HourFactorMode, type LaneEvidence, type LearnCampaign, type LearnedHourFactors,
} from './hour-factors.js'
import { runHourFactors, type CampaignHourInput, type RunHourFactors } from './hour-factors-apply.js'
import { laneOf } from './plan-hour.js'
import type { RunRows } from './facts.js'

/** A product's factors are learned again after this many hours (once a day; the full runs come every 6 hours). */
export const LEARN_EVERY_HOURS = 20
/** The most products one full run learns (each reads four weeks of a market's hours): the rest wait for the next run. */
export const LEARN_PER_RUN = 5

const DAY_MS = 86_400_000
const shiftDay = (day: string, by: number) => new Date(Date.parse(`${day}T00:00:00Z`) + by * DAY_MS).toISOString().slice(0, 10)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** One goal-mode schedule as the learning and the run read it. */
export interface ScheduleRow { id: string; campaignId: string; groupId: string | null; windows: unknown; defaultTargetKey: string | null; timezone: string; targetOverrides: unknown }

/** The JSON of a value with its keys sorted (jsonb re-orders keys). */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => (Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v)
  return JSON.stringify(sort(JSON.parse(JSON.stringify(value ?? null))))
}

/** What a learned plan stands on: the schedule's week, baseline, own values and time zone (a change makes it stale). Pure. */
export function scheduleBasis(s: Pick<ScheduleRow, 'windows' | 'defaultTargetKey' | 'timezone' | 'targetOverrides'>): string {
  return createHash('sha256').update(canonical({ windows: s.windows ?? [], defaultTargetKey: s.defaultTargetKey ?? null, timezone: s.timezone, targetOverrides: s.targetOverrides ?? {} })).digest('base64url').slice(0, 24)
}

/** Each campaign's goal-mode schedule (the first by id, as rank-defend and the brain read it). */
export async function goalSchedules(campaignIds: readonly string[]): Promise<Map<string, ScheduleRow>> {
  const out = new Map<string, ScheduleRow>()
  if (!campaignIds.length) return out
  const { isGoalMode } = await import('../../../jobs/ad-rank-defend.job.js')
  const rows = await prisma.adSchedule.findMany({
    where: { campaignId: { in: [...campaignIds] }, enabled: true },
    select: { id: true, campaignId: true, groupId: true, windows: true, defaultTargetKey: true, timezone: true, targetOverrides: true },
    orderBy: { id: 'asc' },
  })
  for (const r of rows) if (isGoalMode(r.windows, r.defaultTargetKey) && !out.has(r.campaignId)) out.set(r.campaignId, { ...r, timezone: r.timezone || 'Europe/Rome' })
  return out
}

/** The rank-target library, read once; `of(overrides)` gives it with a campaign's own values, as the painter reads a target. */
async function targetLibrary(): Promise<{ of: (overrides: unknown) => Map<string, PaintTarget> }> {
  const [{ toSpec, applyTargetOverrides }, { paintTargetOf }] = await Promise.all([import('../../../jobs/ad-rank-defend.job.js'), import('../brain/hours-proposal.js')])
  const rows = await prisma.rankTarget.findMany({ orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }] })
  return {
    of: (overrides) => {
      const out = new Map<string, PaintTarget>()
      for (const r of rows) {
        const spec = applyTargetOverrides(toSpec(r as never), obj(overrides) as never)
        out.set(spec.key, paintTargetOf(spec as never, r.name))
      }
      return out
    },
  }
}

/** The market's placement report over the days, summed (the top-of-search pool); null with none. */
async function marketLanes(market: string, days: readonly string[]): Promise<LaneEvidence | null> {
  if (!days.length) return null
  const campaigns = (await prisma.campaign.findMany({ where: { adProduct: 'SPONSORED_PRODUCTS', status: { not: 'ARCHIVED' } }, select: { marketplace: true, externalCampaignId: true } }))
    .filter((c) => strategyMarket(c.marketplace) === market && c.externalCampaignId).map((c) => c.externalCampaignId!)
  if (!campaigns.length) return null
  const rows = await prisma.$queryRaw<Array<{ placement: string; clicks: bigint; orders: bigint }>>(Prisma.sql`
    SELECT "placement", sum("clicks")::bigint AS clicks, sum(COALESCE("orders7d", 0))::bigint AS orders
      FROM "AmazonAdsPlacementReport"
     WHERE "campaignId" IN (${Prisma.join(campaigns)}) AND "date" >= ${days[0]}::date AND "date" <= ${days[days.length - 1]}::date
     GROUP BY "placement"`)
  return laneEvidence(rows.map((r) => ({ lane: laneOf(REPORT_LABEL_TO_PLACEMENT[r.placement] ?? r.placement), clicks: Number(r.clicks), orders: Number(r.orders) })))
}

/** Lane totals as top-of-search evidence (null with no clicks at all). Pure. */
export function laneEvidence(lanes: ReadonlyArray<{ lane: string; clicks: number; orders: number }>): LaneEvidence | null {
  const clicks = lanes.reduce((s, l) => s + Math.max(0, l.clicks), 0)
  if (!(clicks > 0)) return null
  const tos = lanes.filter((l) => l.lane === 'TOP_OF_SEARCH')
  return { tosClicks: tos.reduce((s, l) => s + Math.max(0, l.clicks), 0), tosOrders: tos.reduce((s, l) => s + Math.max(0, l.orders), 0), clicks, orders: lanes.reduce((s, l) => s + Math.max(0, l.orders), 0) }
}

/**
 * Each local day's week of a schedule: the version of its plan in force at the day's noon (UTC), else the schedule's own
 * windows (a plan of one campaign keeps no versions). Pure.
 */
export function weeksByDay(days: readonly string[], schedule: Pick<ScheduleRow, 'windows' | 'defaultTargetKey'>, versions: ReadonlyArray<{ windows: unknown; defaultTargetKey: string | null; createdAt: Date }>): Map<string, { windows: unknown; defaultTargetKey: string | null }> {
  const sorted = [...versions].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  const out = new Map<string, { windows: unknown; defaultTargetKey: string | null }>()
  for (const day of days) {
    const noon = Date.parse(`${day}T12:00:00Z`)
    const v = [...sorted].reverse().find((x) => x.createdAt.getTime() <= noon)
    out.set(day, v ? { windows: v.windows, defaultTargetKey: v.defaultTargetKey } : { windows: schedule.windows, defaultTargetKey: schedule.defaultTargetKey })
  }
  return out
}

export type LearnOutcome = { learned: LearnedHourFactors; campaignIds: string[] } | { held: string }

/** Read and learn one product × market's hour factors (stores nothing). */
export async function learnProduct(productId: string, market: string, now: Date): Promise<LearnOutcome> {
  const m = strategyMarket(market) ?? market
  const found = await productCampaigns(productId, m)
  if (!found) return { held: 'no such product (or it has no family root)' }
  const own = found.owned
  if (!own.length) return { held: 'the product has no campaign of its own in this market (a shared campaign is no product\'s: split it first, D2)' }
  const schedules = await goalSchedules(own.map((c) => c.campaignId))
  if (!schedules.size) return { held: 'no hourly plan runs on its own campaigns' }
  const { loadSettings, eventDaysOf, goalOf } = await import('../brain/hours-proposal.js')
  const first = [...schedules.values()].sort((a, b) => a.id.localeCompare(b.id))[0]
  const timeZone = researchTimeZone(m, first.timezone)
  const settings = await loadSettings(found.root, m, own.map((c) => ({ campaignId: c.campaignId, name: c.name })))
  const weeks = Number(settings.product.values.hourResearchWeeks.value) || 4
  const window = researchDays(now, timeZone, weeks)
  // Left out: the days a dated event of a plan replaced the week, and the days the hourly feed was capped (BB-16).
  const groupIds = [...new Set([...schedules.values()].map((s) => s.groupId).filter((g): g is string => !!g))]
  const events = (await Promise.all(groupIds.map((g) => eventDaysOf(g, window, timeZone)))).flat()
  const capped = cappedLocalDays(await grainCappedDays({ from: shiftDay(window[0], -1), to: shiftDay(window[window.length - 1], 1) }), (at) => localDayHour(at, timeZone).day)
  const leftOutMap = new Map<string, string>()
  for (const x of [...events, ...capped]) if (window.includes(x.day) && !leftOutMap.has(x.day)) leftOutMap.set(x.day, x.why)
  const leftOut = [...leftOutMap].map(([day, why]) => ({ day, why })).sort((a, b) => a.day.localeCompare(b.day))
  const facts = await loadResearchFacts({ productId: found.root, market: m, now, timeZone, weeks, leftOut })
  if (!facts) return { held: 'the product could not be researched' }
  const research = researchHours(facts)
  const shares = laneShares(research.lanes)
  // The product's own campaigns with a plan: their hours, each with the plan's multiplier in force that hour.
  const planned = own.filter((c) => schedules.has(c.campaignId))
  const refs = await prisma.campaign.findMany({ where: { id: { in: planned.map((c) => c.campaignId) } }, select: { id: true, externalCampaignId: true } })
  const hours = await loadCampaignHours(refs, facts.days, now, timeZone)
  const versions = groupIds.length
    ? await prisma.rankScheduleVersion.findMany({ where: { groupId: { in: groupIds }, createdAt: { lte: now } }, select: { groupId: true, windows: true, defaultTargetKey: true, createdAt: true }, orderBy: { createdAt: 'asc' } })
    : []
  const library = await targetLibrary()
  const campaigns: LearnCampaign[] = []
  for (const c of planned) {
    const s = schedules.get(c.campaignId)!
    const targets = library.of(s.targetOverrides)
    const byDay = weeksByDay(facts.days, s, s.groupId ? versions.filter((v) => v.groupId === s.groupId) : [])
    const cells: Array<HourCell & { m: number | null }> = [...(hours.cells.get(c.campaignId)?.values() ?? [])].map((cell) => {
      const week = byDay.get(cell.day)
      const key = week ? resolveActiveTargetKey((Array.isArray(week.windows) ? week.windows : []) as ScheduleWindow[], week.defaultTargetKey, weekdayOf(cell.day), cell.hour) : null
      return { ...cell, m: key ? multiplierOf(targets.get(key), shares) : 1 }
    })
    campaigns.push({ campaignId: c.campaignId, scheduleId: s.id, basis: scheduleBasis(s), cells, week: planTargets(s, targets) })
  }
  const tosLanes = facts.lanes.map((l) => ({ lane: l.lane, clicks: l.clicks, orders: l.orders }))
  const [goal, market$] = await Promise.all([goalOf(found.root, m), marketLanes(m, facts.days)])
  const learned = learnHourFactors({
    productId: found.root, market: m, timeZone, days: facts.days, leftOut,
    pools: { market: facts.hours.market, category: facts.hours.category }, categoryName: facts.categoryName,
    campaigns, shares, lanes: { product: laneEvidence(tosLanes), market: market$ },
    goal: goal ? { aim: goal.aim, hi: goal.hi } : null,
    confidence: { label: research.confidence.label, thin: research.confidence.thin, ordersPer30d: research.confidence.ordersPer30d, words: research.confidence.words },
  })
  return { learned, campaignIds: planned.map((c) => c.campaignId).sort() }
}

/** The stored learning of one product × market, or null. */
export interface StoredHourFactors { productId: string; market: string; campaignIds: string[]; learnedAt: Date; factors: LearnedHourFactors }

const toStored = (r: { productId: string; marketplace: string; campaignIds: string[]; learnedAt: Date; factors: unknown }): StoredHourFactors | null => {
  const f = r.factors as LearnedHourFactors | null
  return f && f.version === 1 && Array.isArray(f.curves?.f) && f.curves.f.length === 168 ? { productId: r.productId, market: r.marketplace, campaignIds: r.campaignIds, learnedAt: r.learnedAt, factors: f } : null
}

/** Stored learnings of a market (optionally only those covering one of `campaignIds`, or of one product). */
export async function storedHourFactors(market: string, opts: { campaignIds?: readonly string[]; productId?: string } = {}): Promise<StoredHourFactors[]> {
  const rows = await prisma.bidBrainHourFactor.findMany({
    where: { marketplace: market, ...(opts.campaignIds ? { campaignIds: { hasSome: [...opts.campaignIds] } } : {}), ...(opts.productId ? { productId: opts.productId } : {}) },
    select: { productId: true, marketplace: true, campaignIds: true, learnedAt: true, factors: true },
    orderBy: { productId: 'asc' },
  })
  return rows.map(toStored).filter((x): x is StoredHourFactors => !!x)
}

/** Store one learning (replaces the product × market's row). */
export async function storeHourFactors(out: { learned: LearnedHourFactors; campaignIds: string[] }, now: Date): Promise<void> {
  const data = {
    campaignIds: out.campaignIds, windowFrom: out.learned.window.from, windowTo: out.learned.window.to,
    factors: out.learned as unknown as Prisma.InputJsonObject, learnedAt: now,
  }
  await prisma.bidBrainHourFactor.upsert({
    where: { hour_factor_product: workspaceKey({ productId: out.learned.productId, marketplace: out.learned.market }) },
    create: { productId: out.learned.productId, marketplace: out.learned.market, ...data },
    update: data,
  })
}

/** Why a product is due for learning again (null: not due). Pure. */
export function learnDue(stored: StoredHourFactors | null, campaigns: ReadonlyArray<{ campaignId: string; basis: string }>, now: Date): string | null {
  if (!stored) return 'never learned'
  if (now.getTime() - stored.learnedAt.getTime() >= LEARN_EVERY_HOURS * 3_600_000) return `learned more than ${LEARN_EVERY_HOURS} hours ago`
  for (const c of campaigns) {
    const plan = stored.factors.plans.find((p) => p.campaignId === c.campaignId)
    if (!plan) return `campaign ${c.campaignId} is not covered`
    if (plan.basis !== c.basis) return `the plan of campaign ${c.campaignId} changed since`
  }
  return null
}

/**
 * The full run's learning: the products of these owned campaigns (with a plan hour) learned again where due, at most
 * LEARN_PER_RUN, each failure logged and left (the plan's values run). Returns how many were learned.
 */
export async function refreshHourFactors(campaignIds: readonly string[], market: string, now: Date): Promise<{ learned: number; failed: number; due: number }> {
  const result = { learned: 0, failed: 0, due: 0 }
  if (!campaignIds.length) return result
  const owners = await resolveCampaignOwnership(campaignIds)
  const schedules = await goalSchedules(campaignIds)
  const byProduct = new Map<string, Array<{ campaignId: string; basis: string }>>()
  for (const id of campaignIds) {
    const o = owners.get(id)?.owner
    const s = schedules.get(id)
    if (o?.kind !== 'product' || !s) continue
    byProduct.set(o.productId, [...(byProduct.get(o.productId) ?? []), { campaignId: id, basis: scheduleBasis(s) }])
  }
  if (!byProduct.size) return result
  const stored = new Map((await storedHourFactors(market, { campaignIds })).map((s) => [s.productId, s]))
  const due = [...byProduct].filter(([productId, cs]) => learnDue(stored.get(productId) ?? null, cs, now) != null).map(([productId]) => productId).sort()
  result.due = due.length
  for (const productId of due.slice(0, LEARN_PER_RUN)) {
    try {
      const out = await learnProduct(productId, market, now)
      if ('held' in out) continue
      await storeHourFactors(out, now)
      result.learned++
    } catch (err) {
      result.failed++
      logger.warn('[bid-brain] hour factors: learning failed — the plan\'s values run', { productId, market, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return result
}

/** The hours lever of one product as the run reads it: the Owner's locks, his hourCellMovePct, and whether 'on' acts. */
interface ProductHours { cells: Set<string>; lockedLever: boolean; movePct: number; applies: boolean; whyNot: string | null }

async function productHours(productId: string, market: string, members: ReadonlyArray<{ campaignId: string; name: string }>): Promise<ProductHours> {
  const { loadSettings, hoursSettingsOf } = await import('../brain/hours-proposal.js')
  const loaded = await loadSettings(productId, market, members)
  const s = hoursSettingsOf(loaded.product, loaded.members)
  const killed = s.level === 'PROPOSE' ? await leverKillWhy('hours', productId, market) : null
  const applies = s.level === 'PROPOSE' && !killed
  const whyNot = applies ? null
    : killed ? `the hours lever is ${killed}`
      : s.level === 'LOCKED' ? `the Owner locked the hours lever (${s.why})`
        : `the product's hours lever is ${s.level} (${s.why}) — 'on' acts where the product's brain owns it (PROPOSE)`
  return { cells: s.cells, lockedLever: s.level === 'LOCKED', movePct: s.hourCellMovePct, applies, whyNot }
}

const EMPTY: RunHourFactors = Object.freeze({ planHours: new Map(), notes: new Map(), moves: new Map() }) as RunHourFactors

/**
 * BB-22 — the learned hour factors for one run of the bid brain: the run (its plan hours moved under 'on') and the words
 * for the why. Off, no plan hour, or shadow on a light tick: the run exactly as given, nothing read. Never throws: a
 * failure is logged and the run decides with the plan's values.
 */
export async function hourFactorsForRun(market: string, run: RunRows, ctx: { now: Date; clockNow: Date; light: boolean; mode?: HourFactorMode }): Promise<{ run: RunRows; notes: ReadonlyMap<string, string> }> {
  const mode = ctx.mode ?? hourFactorMode()
  const hours = run.planHours
  if (mode === 'off' || !hours?.size || (mode === 'shadow' && ctx.light)) return { run, notes: EMPTY.notes }
  try {
    const ids = [...hours.keys()]
    if (!ctx.light) await refreshHourFactors(ids, market, ctx.now)
    const stored = await storedHourFactors(market, { campaignIds: ids })
    if (!stored.length) return { run, notes: EMPTY.notes }
    const schedules = await goalSchedules(ids)
    const { nowInTz } = await import('../../../jobs/ad-rank-defend.job.js')
    const inputs: CampaignHourInput[] = []
    for (const row of stored) {
      const covered = ids.filter((id) => row.campaignIds.includes(id))
      if (!covered.length) continue
      const lever = await productHours(row.productId, market, covered.map((campaignId) => ({ campaignId, name: hours.get(campaignId)?.name ?? campaignId })))
      const f = row.factors
      for (const campaignId of covered) {
        const hour = hours.get(campaignId)!
        const s = schedules.get(campaignId)
        const plan = f.plans.find((p) => p.campaignId === campaignId) ?? null
        const { day: d, hour: h } = nowInTz(s?.timezone || f.timeZone || 'Europe/Rome', 0, ctx.clockNow)
        const k = hourKey(d, h)
        const stale = !plan || !s ? 'no learned plan for this campaign yet — the plan\'s values run'
          : plan.scheduleId !== hour.scheduleId || plan.basis !== scheduleBasis(s) ? 'the plan changed since the factors were learned — its values run until the next learning' : null
        inputs.push({
          campaignId, hour, d, h,
          rho: plan?.rho[k] ?? null, rhoLo: plan?.rhoLo[k] ?? null, rhoHi: plan?.rhoHi[k] ?? null,
          learned: f.curves.f[k] ?? null, painted: plan?.painted[k] ?? null, stale,
          locked: lever.lockedLever || lever.cells.has(cellRef(d, h)), movePct: lever.movePct,
          tosCapPct: f.tos?.capPct ?? null, tosRatio: f.tos?.ratio ?? null,
          applies: lever.applies, whyNot: lever.whyNot,
        })
      }
    }
    const out = runHourFactors(hours, inputs, mode, { wantNotes: !ctx.light })
    const moved = [...out.planHours].some(([id, h]) => h !== hours.get(id))
    return { run: moved ? { ...run, planHours: out.planHours } : run, notes: out.notes }
  } catch (err) {
    logger.warn('[bid-brain] hour factors could not be read — the plan\'s values run', { market, error: err instanceof Error ? err.message : String(err) })
    return { run, notes: EMPTY.notes }
  }
}
