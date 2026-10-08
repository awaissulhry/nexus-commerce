/**
 * ONE BRAIN AB-13 — the brain's hourly plan, researched, painted and proposed (design 2026-10-08-ads-one-brain/DESIGN.md
 * §2.3, §4 weekly, §8 row AB-13, D3 = B+). The research is brain/hours-research.ts, the painting brain/hours-paint.ts;
 * this file reads what they need, stores each run (AdsBrainHourProposal) and asks for the approval.
 *
 *   which plan  the product's own: an hourly plan (Hourly Bids page) that is switched on and whose every member is one of
 *               the product's own campaigns in the market. Not a plan of the ads playbook (its phase sets its hours), not
 *               one holding another product's or a shared campaign (D2: the brain proposes a split), not one an enabled
 *               product rank plan overrides, not one whose time zone keeps another clock than the market's (the Owner's
 *               locked hours are in the market's time). Several: the one holding most of its campaigns.
 *   level       the hours lever (brain/settings.ts) of the product AND of every member campaign — the strictest wins:
 *               OFF / excluded → nothing; the Owner's lock of the whole lever → the painting is stored as a
 *               recommendation (HELD), nothing asked; OBSERVE → SHADOW (stored, nothing asked); PROPOSE → PROPOSED (one
 *               approval request) when the painting changes an hour, else NO_CHANGE. Never AUTO (D3).
 *   cadence     once per 7 ÷ hourProposalsPerWeek days per product × market (default weekly; 0 = never), never while
 *               an earlier request still waits for a person. The daily tick (jobs/ads-brain-hours.job.ts) only starts
 *               work when a product is enrolled: none enrolled → nothing read, nothing written.
 *   approval    the request is apply-brain-hourly-plan { planId } (services/agents/tools/ads-brain-hours.tools.ts), queued
 *               as "Nexus ads brain" through the normal approval gate, always for a person (never by rule). Its preview
 *               carries the research summary, the before / after grid, the expected effect and the locked hours. When
 *               a person approves it, it runs as that person: the plan's week is saved through the Hourly Bids page's
 *               own save (ads-create.service.ts saveRankScheduleGroup, set-hourly-bid-plan's write path) as a NEW
 *               version (RankScheduleVersion, changedBy the approver) — only if the plan, the lever and the locks are as
 *               they were. Rejected or expired: the plan stays exactly as it is.
 *   limits      hourPlanAsLimits: the Owner's own painted plan is the newest version of the plan that is not a painting
 *               the brain applied; it caps each hour.
 *
 * Production today: no product enrolled → the tick returns at once. Nothing here writes to Amazon.
 */
import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { MARKET_TIME_ZONE } from '../ads-market-time.js'
import { MANAGED_PLACEMENTS } from '../ads-placement-math.js'
import { laneOf } from '../bid-brain/plan-hour.js'
import type { LaneName } from '../bid-brain/recipe.js'
import { targetValuesOf, weekRaise, raiseWords, type TargetValues } from '../hourly-plan-week.js'
import { campaignHolders, planOwners, productPlanCampaigns, readPlanStates, type PlanState } from '../rank-schedule-group.service.js'
import { LANES, type BrainLevel } from './levers.js'
import { productCampaigns } from './ownership.js'
import { leverKillWhy } from './kill-switch.js'
import { describeProvenance, resolveBrainSettings, type BrainSettings, type OverrideRow } from './settings.js'
import { loadResearchFacts, localDayHour, researchDays, researchHours, type HoursResearch } from './hours-research.js'
import { gridLines, paintPlan, weekOf, type Goal, type PaintTarget, type PaintedPlan } from './hours-paint.js'

/** The approval tool that applies a painted plan (services/agents/tools/ads-brain-hours.tools.ts). */
export const HOURS_TOOL = 'apply-brain-hourly-plan'
/** Who asks: the brain, as a system principal (never a person). */
export const HOURS_ASKER = 'Nexus ads brain'
export const HOURS_STATUSES = ['SHADOW', 'PROPOSED', 'NO_CHANGE', 'HELD', 'APPLIED', 'REJECTED', 'EXPIRED', 'NOT_RUN'] as const
export type HoursStatus = (typeof HOURS_STATUSES)[number]
/** Rows other than PROPOSED and APPLIED older than this are deleted (Neon cost). */
export const HOURS_KEEP_DAYS = 90
const DAY_MS = 86_400_000
/** The daily tick runs a little before the same time each day: a week is due a few hours early, never a day late. */
const DUE_SLACK_MS = 6 * 3_600_000

const plural = (n: number, w: string, many = `${w}s`) => `${n} ${n === 1 ? w : many}`
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
/** The JSON of a value with its keys sorted (jsonb re-orders keys). */
export function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => (Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v)
  return JSON.stringify(sort(JSON.parse(JSON.stringify(value ?? null))))
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('base64url').slice(0, 32)

// ── The targets ──────────────────────────────────────────────────────────────────────────────────────────────────

/** A rank target as the painter reads it, from the engine's own spec (pure). */
export function paintTargetOf(spec: { key: string; placement?: string | null; biasPct?: number | null; lanes?: Array<{ placement: string; biasPct?: number | null }> | null; pause?: boolean | null; bidMode?: string | null; floorBidCents?: number | null; maxCpcCents?: number | null }, name: string): PaintTarget {
  const v = targetValuesOf(spec, name)
  const clamp = (x: number | null | undefined) => Math.max(0, Math.min(900, Math.round(x ?? 0)))
  const lanes: Partial<Record<LaneName, number>> = {}
  if (!v.floor) {
    if (spec.lanes?.length) {
      // A blended target owns all three lanes (undeclared → 0), as the bid brain carries it out (plan-hour.ts).
      const declared = new Map(spec.lanes.map((l) => [l.placement, l.biasPct ?? 0]))
      for (const p of MANAGED_PLACEMENTS) lanes[laneOf(p)] = clamp(declared.get(p))
    } else lanes[laneOf(spec.placement ?? 'PLACEMENT_TOP')] = clamp(spec.biasPct)
  }
  return { key: spec.key, name, floor: v.floor, placementPct: v.placementPct, lanes, maxCpcCents: v.maxCpcCents }
}

/** The rank-target library, as the painter and the preview read it (the engine's own spec). */
export async function loadTargets(): Promise<{ paint: Map<string, PaintTarget>; values: Map<string, TargetValues> }> {
  const { toSpec } = await import('../../../jobs/ad-rank-defend.job.js')
  const rows = await prisma.rankTarget.findMany({ orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }] })
  const paint = new Map<string, PaintTarget>()
  const values = new Map<string, TargetValues>()
  for (const r of rows) {
    const spec = toSpec(r as never) as Parameters<typeof paintTargetOf>[0]
    paint.set(spec.key, paintTargetOf(spec, r.name))
    values.set(spec.key, targetValuesOf(spec as never, r.name))
  }
  return { paint, values }
}

// ── Which plan, and the lever on it ──────────────────────────────────────────────────────────────────────────────

/** Two time zones keep the same clock all year (sampled every 6 hours over a year). */
export function sameClock(a: string, b: string, from = new Date('2026-01-01T00:00:00Z')): boolean {
  if (a === b) return true
  for (let t = from.getTime(); t < from.getTime() + 366 * DAY_MS; t += 6 * 3_600_000) {
    const x = localDayHour(new Date(t), a), y = localDayHour(new Date(t), b)
    if (x.day !== y.day || x.hour !== y.hour) return false
  }
  return true
}

export interface PlanChoice {
  plan: PlanState | null
  /** Why no plan may be painted (null when one may). */
  held: string | null
  /** Other plans that hold the product's campaigns, and why the brain leaves each. */
  others: Array<{ planId: string; name: string; why: string }>
}

/** The plan the brain may paint for these own campaigns in this market, or why none. */
export async function choosePlan(ownIds: readonly string[], market: string): Promise<PlanChoice> {
  if (!ownIds.length) return { plan: null, held: 'the product has no campaign of its own in this market, so it has no hourly plan of its own', others: [] }
  const holders = await campaignHolders(ownIds)
  const planIds = [...new Set([...holders.values()].map((h) => h.planId).filter((id): id is string => !!id))]
  if (!planIds.length) return { plan: null, held: 'no hourly plan holds its campaigns: the brain paints only an existing plan (make one on the Hourly Bids page, or ask for one with set-hourly-bid-plan)', others: [] }
  const [states, governed] = await Promise.all([readPlanStates(planIds), productPlanCampaigns()])
  const owners = await planOwners(states)
  const own = new Set(ownIds)
  const marketZone = MARKET_TIME_ZONE[market] ?? 'Europe/Rome'
  const judged = states.map((s) => {
    const mine = s.members.filter((id) => own.has(id)).length
    const strangers = s.members.length - mine
    const owner = owners.get(s.planId)
    let why: string | null = null
    if (!s.enabled) why = 'it is switched off (the brain paints the plan the product runs)'
    else if (owner?.by === 'playbook') why = `it is ${owner.words}: its phase sets its hours (apply-ads-playbook), and two writers of one plan's hours would fight`
    else if (strangers) why = `it also holds ${plural(strangers, 'campaign')} that ${strangers === 1 ? 'is' : 'are'} not this product's own (another product's or shared): the brain paints only a plan of the product's own campaigns (D2: split it first)`
    else if (s.members.some((id) => governed.has(id))) why = 'an enabled product rank plan wins on its campaigns: the hourly plan does not act there'
    else if (!sameClock(s.timezone, marketZone)) why = `its time zone ${s.timezone} does not keep the market's clock (${marketZone}), in which the Owner's locked hours are named`
    return { s, mine, why }
  }).sort((a, b) => b.mine - a.mine || a.s.planId.localeCompare(b.s.planId))
  const eligible = judged.filter((j) => !j.why)
  const plan = eligible[0]?.s ?? null
  const others = judged.filter((j) => j.s !== plan).map((j) => ({ planId: j.s.planId, name: j.s.name, why: j.why ?? `"${plan?.name}" holds more of its campaigns: one plan per product` }))
  return { plan, held: plan ? null : `the hourly plan "${judged[0].s.name}" holding its campaigns cannot be painted: ${judged[0].why}`, others }
}

export type HoursLevel = 'OFF' | 'OBSERVE' | 'PROPOSE' | 'LOCKED' | 'EXCLUDED' | 'NOT_ENROLLED'

export interface HoursSettings {
  level: HoursLevel
  why: string
  cells: Set<string>
  lanes: Set<LaneName>
  hourCellMovePct: number
  minBidEntriesPerDay: number
  hourProposalsPerWeek: number
  hourResearchWeeks: number
  hourPlanAsLimits: boolean
}

const RANK: Record<HoursLevel, number> = { NOT_ENROLLED: 0, EXCLUDED: 0, OFF: 0, LOCKED: 1, OBSERVE: 2, PROPOSE: 3 }

/** The hours lever of the product and of each member campaign, the strictest winning; the locks and values (pure). */
export function hoursSettingsOf(product: BrainSettings, members: ReadonlyArray<{ campaignId: string; name: string; settings: BrainSettings }>): HoursSettings {
  const levelOf = (s: BrainSettings): HoursLevel => {
    const e = s.levers.hours.effective as BrainLevel | 'LOCKED' | 'EXCLUDED' | 'NOT_ENROLLED'
    return e === 'AUTO' ? 'PROPOSE' : e
  }
  let level = levelOf(product)
  let why = `the product's hours lever: ${product.levers.hours.why}`
  for (const m of members) {
    const l = levelOf(m.settings)
    if (RANK[l] < RANK[level]) { level = l; why = `campaign "${m.name}" of the plan: ${m.settings.levers.hours.why}` }
  }
  const all = [product, ...members.map((m) => m.settings)]
  const cells = new Set<string>()
  const lanes = new Set<LaneName>()
  for (const s of all) {
    for (const l of s.levers.hours.locks) if (l.ref.startsWith('hourCell:')) cells.add(l.ref.slice('hourCell:'.length))
    for (const l of s.levers.placements.locks) if (l.ref.startsWith('lane:')) lanes.add(l.ref.slice('lane:'.length) as LaneName)
    const whole = s.levers.placements.lock
    if (whole) {
      const v = obj(whole.value)
      const named = Object.keys(v).filter((k) => (LANES as readonly string[]).includes(k)) as LaneName[]
      for (const lane of named.length ? named : [...LANES]) lanes.add(lane)
    }
  }
  const num = (s: BrainSettings, k: 'hourCellMovePct' | 'minBidEntriesPerDay' | 'hourProposalsPerWeek' | 'hourResearchWeeks') => Number(s.values[k].value)
  return {
    level, why, cells, lanes,
    hourCellMovePct: num(product, 'hourCellMovePct'),
    minBidEntriesPerDay: Math.min(...all.map((s) => num(s, 'minBidEntriesPerDay'))),
    hourProposalsPerWeek: num(product, 'hourProposalsPerWeek'),
    hourResearchWeeks: num(product, 'hourResearchWeeks'),
    hourPlanAsLimits: product.values.hourPlanAsLimits.value === true,
  }
}

const OVERRIDE_SELECT = { id: true, productId: true, marketplace: true, scope: true, campaignId: true, kind: true, key: true, ref: true, value: true, by: true, reason: true, createdAt: true, endedAt: true } as const

/** The brain's settings of the product and of each campaign named (one query for the overrides, one for the enrollment). */
export async function loadSettings(root: string, market: string, campaigns: ReadonlyArray<{ campaignId: string; name: string }>): Promise<{ product: BrainSettings; members: Array<{ campaignId: string; name: string; settings: BrainSettings }> }> {
  const ids = campaigns.map((c) => c.campaignId)
  const [enrollment, overrides] = await Promise.all([
    prisma.adsBrainEnrollment.findFirst({ where: { productId: root, marketplace: market }, select: { id: true } }),
    prisma.adsBrainOverride.findMany({ where: { endedAt: null, OR: [{ scope: 'PRODUCT', productId: root, marketplace: market }, ...(ids.length ? [{ scope: 'CAMPAIGN', campaignId: { in: ids } }] : [])] }, select: OVERRIDE_SELECT }),
  ])
  const resolve = (campaignId: string | null) => resolveBrainSettings({ productId: root, market, campaignId, enrolled: !!enrollment, overrides: overrides as OverrideRow[] })
  return { product: resolve(null), members: campaigns.map((c) => ({ ...c, settings: resolve(c.campaignId) })) }
}

/** The product's ACoS goal in the market from the ads strategy (bid-brain/goal.ts), or null when the strategy holds none. */
export async function goalOf(root: string, market: string): Promise<Goal | null> {
  const { openStrategy } = await import('../ads-strategy/effective.js')
  const { resolveGoal, isGoal, goalWords, BRAIN_PHASES } = await import('../bid-brain/goal.js')
  const view = await openStrategy(market)
  const e = (await view.forEachProduct([root])).get(root) ?? view.forMarket()
  const t = e.resolved.fields.get('target')?.value as { targetKind?: unknown; targetPct?: unknown; targetLoPct?: unknown; targetHiPct?: unknown } | undefined
  const target = t && (t.targetKind === 'ACOS' || t.targetKind === 'TACOS') && typeof t.targetPct === 'number' ? { kind: t.targetKind, pct: t.targetPct } as const : null
  const side = (v: unknown) => (typeof v === 'number' ? v : null)
  const band = target && (side(t?.targetLoPct) != null || side(t?.targetHiPct) != null) ? { loPct: side(t?.targetLoPct), hiPct: side(t?.targetHiPct) } : null
  const phase = e.resolved.fields.get('goal')?.value
  const g = resolveGoal({ target, acosFallbackPct: e.values.targetAcosPct, band, phase: (BRAIN_PHASES as readonly string[]).includes(phase as string) ? (phase as never) : null })
  return isGoal(g) && g.kind === 'ACOS' ? { aim: g.aim, lo: g.lo, hi: g.hi, words: goalWords(g) } : null
}

/** The Owner's own painted plan: the newest version of the plan that is not a painting the brain applied. */
export async function ownersPlanOf(planId: string): Promise<{ windows: unknown; defaultTargetKey: string | null; versionId: string; at: string; by: string | null } | null> {
  const applied = await prisma.adsBrainHourProposal.findMany({ where: { planId, status: 'APPLIED' }, select: { versionId: true, paint: true } })
  const appliedIds = applied.map((a) => a.versionId).filter((v): v is string => !!v)
  const painted = new Set(applied.map((a) => { const p = obj(a.paint); return canonical({ windows: p.windows ?? null, defaultTargetKey: p.defaultTargetKey ?? null }) }))
  const versions = await prisma.rankScheduleVersion.findMany({ where: { groupId: planId, ...(appliedIds.length ? { id: { notIn: appliedIds } } : {}) }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, windows: true, defaultTargetKey: true, createdAt: true, changedBy: true } })
  // A later save that only carried the brain's painting along (a rename, a switch) is not the Owner's painting.
  const v = versions.find((x) => !painted.has(canonical({ windows: x.windows ?? null, defaultTargetKey: x.defaultTargetKey ?? null })))
  return v ? { windows: v.windows, defaultTargetKey: v.defaultTargetKey ?? null, versionId: v.id, at: v.createdAt.toISOString(), by: v.changedBy ?? null } : null
}

/** The local days of the window an armed dated event of the plan covered (they replaced the week: not researched). */
export async function eventDaysOf(planId: string | null, days: readonly string[], timeZone: string): Promise<Array<{ day: string; why: string }>> {
  if (!planId || !days.length) return []
  const from = new Date(Date.parse(`${days[0]}T00:00:00Z`) - DAY_MS)
  const until = new Date(Date.parse(`${days[days.length - 1]}T00:00:00Z`) + 2 * DAY_MS)
  const events = await prisma.rankScheduleEvent.findMany({ where: { groupId: planId, enabled: true, startsAt: { lt: until }, endsAt: { gt: from } }, select: { name: true, startsAt: true, endsAt: true } })
  const inWindow = new Set(days)
  const out = new Map<string, string>()
  for (const e of events) {
    const end = Math.min(e.endsAt.getTime(), until.getTime())
    for (let t = Math.max(e.startsAt.getTime(), from.getTime()); t < end; t += 3_600_000) {
      const { day } = localDayHour(new Date(t), timeZone)
      if (inWindow.has(day) && !out.has(day)) out.set(day, `the dated event "${e.name}"`)
    }
  }
  return [...out].map(([day, why]) => ({ day, why })).sort((a, b) => a.day.localeCompare(b.day))
}

/** What the approval stands on: the plan's week, members, on/off, time zone, own values, and the ladder's target values. */
export function planBasisOf(plan: Pick<PlanState, 'windows' | 'defaultTargetKey' | 'enabled' | 'members' | 'timezone' | 'overrides'>, ladderTargets: ReadonlyArray<PaintTarget | undefined>): string {
  return hash({ windows: plan.windows, defaultTargetKey: plan.defaultTargetKey, enabled: plan.enabled, members: [...plan.members].sort(), timezone: plan.timezone, overrides: plan.overrides, targets: ladderTargets.filter(Boolean) })
}

// ── One product: research, paint, decide (no writes) ────────────────────────────────────────────────────────────

export interface HoursDecision {
  productId: string
  market: string
  level: HoursLevel
  status: Exclude<HoursStatus, 'APPLIED' | 'REJECTED' | 'EXPIRED' | 'NOT_RUN'> | 'OFF'
  why: string
  plan: PlanState | null
  others: PlanChoice['others']
  planBasis: string | null
  research: HoursResearch | null
  paint: PaintedPlan | null
  settings: HoursSettings | null
}

/**
 * Research and paint one product × market as the brain would now, and say what it would do with it. Reads only.
 * `research: 'always'` researches and paints a product whose hours lever is off too (the read view's dry run).
 */
export async function decideHours(productId: string, market: string, now: Date, opts: { research?: 'always' } = {}): Promise<HoursDecision | null> {
  const m = strategyMarket(market) ?? market
  const found = await productCampaigns(productId, m)
  if (!found) return null
  const own = found.owned
  const choice = await choosePlan(own.map((c) => c.campaignId), m)
  const memberRows = choice.plan ? own.filter((c) => choice.plan!.members.includes(c.campaignId)).map((c) => ({ campaignId: c.campaignId, name: c.name })) : []
  const loaded = await loadSettings(found.root, m, memberRows)
  const settings = hoursSettingsOf(loaded.product, loaded.members)
  const base = { productId: found.root, market: m, level: settings.level, plan: choice.plan, others: choice.others, settings }
  // The product's own OFF (or not enrolled, or excluded) means nothing to do; a member the Owner keeps out holds the plan.
  const productOff = RANK[hoursSettingsOf(loaded.product, []).level] === 0
  if (productOff && opts.research !== 'always') return { ...base, status: 'OFF', why: settings.why, planBasis: null, research: null, paint: null }
  const zone = choice.plan?.timezone ?? MARKET_TIME_ZONE[m] ?? 'Europe/Rome'
  const leftOut = await eventDaysOf(choice.plan?.planId ?? null, researchDays(now, zone, settings.hourResearchWeeks), zone)
  const facts = await loadResearchFacts({ productId: found.root, market: m, now, timeZone: zone, weeks: settings.hourResearchWeeks, leftOut })
  if (!facts) return null
  const research = researchHours(facts)
  if (!choice.plan) return { ...base, status: productOff ? 'OFF' : 'HELD', why: `Research only: ${choice.held}.`, planBasis: null, research, paint: null }
  if (RANK[settings.level] === 0 && !productOff) return { ...base, status: 'HELD', why: `Research only: ${settings.why} — the plan holds that campaign too, so the brain does not paint it.`, planBasis: null, research, paint: null }
  const [targets, goal, limits] = await Promise.all([loadTargets(), goalOf(found.root, m), settings.hourPlanAsLimits ? ownersPlanOf(choice.plan.planId) : Promise.resolve(null)])
  const paint = paintPlan({
    research, goal, plan: choice.plan, targets: targets.paint,
    locks: { cells: settings.cells, lanes: settings.lanes },
    limits: limits ? { windows: limits.windows, defaultTargetKey: limits.defaultTargetKey } : null,
    settings: { hourCellMovePct: settings.hourCellMovePct, minBidEntriesPerDay: settings.minBidEntriesPerDay },
  })
  if (settings.hourPlanAsLimits && !limits) paint.summary.push('hourPlanAsLimits is on, but the plan has no version the Owner painted: no limit applies.')
  const planBasis = planBasisOf(choice.plan, [...paint.ladder.serving, ...(paint.ladder.minBid ? [paint.ladder.minBid] : [])].map((k) => targets.paint.get(k)))
  const changed = paint.changes.length
  if (productOff) return { ...base, status: 'OFF', why: `${settings.why}: the brain would paint ${plural(changed, 'hour')} of "${choice.plan.name}" (decided now, nothing stored or asked).`, planBasis, research, paint }
  if (settings.level === 'LOCKED') return { ...base, status: 'HELD', why: `A recommendation only: ${settings.why}. ${changed ? `The brain would paint ${plural(changed, 'hour')}.` : 'The brain would paint nothing.'}`, planBasis, research, paint }
  // AB-15 — the Owner's kill switch on the hours lever: the painting stays a recommendation, nothing is asked.
  const killed = await leverKillWhy('hours', found.root, m)
  if (killed) return { ...base, status: 'HELD', why: `A recommendation only: the hours lever is ${killed}. ${changed ? `The brain would paint ${plural(changed, 'hour')}.` : 'The brain would paint nothing.'}`, planBasis, research, paint }
  if (paint.held) return { ...base, status: settings.level === 'OBSERVE' ? 'SHADOW' : 'HELD', why: paint.held, planBasis, research, paint }
  if (settings.level === 'OBSERVE') return { ...base, status: 'SHADOW', why: `Shadow (the hours lever is OBSERVE): the brain would paint ${plural(changed, 'hour')} of "${choice.plan.name}"; nothing is asked or written.`, planBasis, research, paint }
  if (!changed) return { ...base, status: 'NO_CHANGE', why: `"${choice.plan.name}" stays as it is: ${paint.summary[0]}`, planBasis, research, paint }
  return { ...base, status: 'PROPOSED', why: `Proposes ${plural(changed, 'hour')} of "${choice.plan.name}" for approval.`, planBasis, research, paint }
}

// ── The run ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface HoursRunSummary {
  ran: boolean
  why?: string
  products: number
  stored: number
  proposed: number
  shadow: number
  noChange: number
  held: number
  notDue: number
  off: number
  failed: number
  synced: number
  pruned: number
}

/** What a run answers with no product enrolled: nothing read, nothing stored, nothing asked. */
export const NOTHING_ENROLLED: HoursRunSummary = Object.freeze({ ran: false, why: 'no product is enrolled in the brain: nothing to research', products: 0, stored: 0, proposed: 0, shadow: 0, noChange: 0, held: 0, notDue: 0, off: 0, failed: 0, synced: 0, pruned: 0 })

/** Is any product enrolled in the brain in this business? (one count: production has none today) */
export async function anyProductEnrolled(): Promise<boolean> {
  return (await prisma.adsBrainEnrollment.count()) > 0
}

/** PROPOSED rows whose request a person decided (or that expired) take that outcome; returns how many moved. */
export async function syncProposalStatuses(now: Date): Promise<number> {
  const open = await prisma.adsBrainHourProposal.findMany({ where: { status: 'PROPOSED', approvalId: { not: null } }, select: { id: true, approvalId: true } })
  if (!open.length) return 0
  const approvals = await prisma.agentApproval.findMany({ where: { id: { in: open.map((o) => o.approvalId!) } }, select: { id: true, status: true, decidedBy: true, decidedAt: true, expiresAt: true } })
  const byId = new Map(approvals.map((a) => [a.id, a]))
  let moved = 0
  for (const o of open) {
    const a = byId.get(o.approvalId!)
    const outcome: HoursStatus | null = !a ? 'EXPIRED'
      : a.status === 'rejected' ? 'REJECTED'
        : a.status === 'expired' || (a.status === 'pending' && a.expiresAt && a.expiresAt < now) ? 'EXPIRED' : null
    if (!outcome) continue
    const r = await prisma.adsBrainHourProposal.updateMany({ where: { id: o.id, status: 'PROPOSED' }, data: { status: outcome, decidedBy: a?.decidedBy ?? null, decidedAt: a?.decidedAt ?? now } })
    moved += r.count
  }
  return moved
}

/** Is a new proposal due for this product × market? (pure over its last row) */
export function proposalDue(last: { createdAt: Date; status: string } | null, perWeek: number, now: Date, waiting: boolean): { due: boolean; why: string } {
  if (perWeek <= 0) return { due: false, why: 'hourProposalsPerWeek is 0: no painted plan is asked for' }
  if (waiting) return { due: false, why: 'its last painted plan still waits for a person' }
  if (!last) return { due: true, why: 'no research yet' }
  const every = (7 * DAY_MS) / perWeek
  const next = last.createdAt.getTime() + every - DUE_SLACK_MS
  return now.getTime() >= next
    ? { due: true, why: `its last research is ${Math.floor((now.getTime() - last.createdAt.getTime()) / DAY_MS)} days old (${perWeek} a week)` }
    : { due: false, why: `the next research is due after ${new Date(next).toISOString().slice(0, 16)} UTC (${perWeek} a week)` }
}

/** The request for a person, through the normal approval gate (never by rule). */
async function askForApproval(planId: string, proposalId: string): Promise<{ approvalId: string } | { error: string }> {
  const { runOrQueueTool } = await import('../../agents/approval-gate.service.js')
  const { systemPrincipal } = await import('../../agents/call-tool.js')
  const args = { planId }
  const run = await prisma.agentRun.create({ data: { agentKey: 'ads-brain-hours', trigger: 'schedule', status: 'running', input: { tool: HOURS_TOOL, args, proposalId } as Prisma.InputJsonValue } })
  const asked = await runOrQueueTool(HOURS_TOOL, args, systemPrincipal(HOURS_ASKER), run.id, { forceAsk: true })
  const queued = asked.mode === 'queued' && !!asked.approvalId
  await prisma.agentRun.update({
    where: { id: run.id },
    data: queued ? { status: 'done', ok: true, endedAt: new Date(), output: { mode: 'queued', approvalId: asked.approvalId ?? null } } : { status: 'failed', ok: false, endedAt: new Date(), errorMessage: asked.error ?? null },
  })
  return queued ? { approvalId: asked.approvalId! } : { error: asked.error ?? 'the request was not queued' }
}

/** Store one decision; at PROPOSE ask for the approval. Returns the stored status. */
async function storeDecision(d: HoursDecision): Promise<HoursStatus | null> {
  if (d.status === 'OFF' || !d.research) return null
  const row = await prisma.adsBrainHourProposal.create({
    data: {
      productId: d.productId, marketplace: d.market, planId: d.plan?.planId ?? null, level: d.level, status: d.status, why: d.why,
      planBasis: d.planBasis, research: d.research as unknown as Prisma.InputJsonValue, paint: d.paint ? (d.paint as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
    },
  })
  if (d.status !== 'PROPOSED') return d.status
  const asked = await askForApproval(d.plan!.planId, row.id)
  if ('approvalId' in asked) {
    await prisma.adsBrainHourProposal.update({ where: { id: row.id }, data: { approvalId: asked.approvalId } })
    return 'PROPOSED'
  }
  await prisma.adsBrainHourProposal.update({ where: { id: row.id }, data: { status: 'NOT_RUN', why: `${d.why} The request could not be stored: ${asked.error}` } })
  return 'NOT_RUN'
}

/**
 * One run in this business: every enrolled product × market whose hours lever is OBSERVE or higher and that is due is
 * researched and painted; OBSERVE is stored in shadow, PROPOSE asks a person. With no product enrolled it reads and writes
 * nothing. `productId`/`market` narrow it to one product (the cadence still applies unless `force`).
 */
export async function runHoursOnce(opts: { now?: Date; productId?: string; market?: string; force?: boolean } = {}): Promise<HoursRunSummary> {
  const now = opts.now ?? new Date()
  const summary: HoursRunSummary = { ran: false, products: 0, stored: 0, proposed: 0, shadow: 0, noChange: 0, held: 0, notDue: 0, off: 0, failed: 0, synced: 0, pruned: 0 }
  const enrolled = await prisma.adsBrainEnrollment.findMany({
    where: { ...(opts.productId ? { productId: opts.productId } : {}), ...(opts.market ? { marketplace: strategyMarket(opts.market) ?? opts.market } : {}) },
    select: { productId: true, marketplace: true }, orderBy: [{ marketplace: 'asc' }, { productId: 'asc' }],
  })
  if (!enrolled.length) return { ...NOTHING_ENROLLED }
  summary.ran = true
  summary.synced = await syncProposalStatuses(now)
  summary.pruned = (await prisma.adsBrainHourProposal.deleteMany({ where: { status: { notIn: ['PROPOSED', 'APPLIED'] }, createdAt: { lt: new Date(now.getTime() - HOURS_KEEP_DAYS * DAY_MS) } } })).count
  for (const e of enrolled) {
    summary.products++
    try {
      const last = await prisma.adsBrainHourProposal.findFirst({ where: { productId: e.productId, marketplace: e.marketplace }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, status: true } })
      const waiting = last?.status === 'PROPOSED'
      // The cadence needs only the product's own settings; the full decision reads the hours.
      const loaded = await loadSettings(e.productId, e.marketplace, [])
      const own = hoursSettingsOf(loaded.product, [])
      if (RANK[own.level] === 0) { summary.off++; continue }
      const due = proposalDue(last, own.hourProposalsPerWeek, now, waiting)
      if (!due.due && !opts.force) { summary.notDue++; continue }
      if (waiting && opts.force) { summary.notDue++; continue }
      const d = await decideHours(e.productId, e.marketplace, now)
      if (!d || d.status === 'OFF') { summary.off++; continue }
      const stored = await storeDecision(d)
      if (!stored) continue
      summary.stored++
      if (stored === 'PROPOSED') summary.proposed++
      else if (stored === 'SHADOW') summary.shadow++
      else if (stored === 'NO_CHANGE') summary.noChange++
      else if (stored === 'HELD') summary.held++
      else summary.failed++
    } catch (error) {
      summary.failed++
      logger.error('[ads-brain-hours] one product failed; the others go on', { productId: e.productId, market: e.marketplace, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return summary
}

export function hoursSummaryLine(s: HoursRunSummary): string {
  if (!s.ran) return `hours: ${s.why}`
  return `hours: ${s.products} product(s) — proposed=${s.proposed} shadow=${s.shadow} noChange=${s.noChange} held=${s.held} notDue=${s.notDue} off=${s.off} failed=${s.failed}; synced=${s.synced} pruned=${s.pruned}`
}

// ── The approval: its preview, and applying it ──────────────────────────────────────────────────────────────────

export interface ApplyPreview {
  proposalId: string
  productId: string
  market: string
  plan: { planId: string; name: string; timezone: string; members: number; enabled: boolean }
  research: HoursResearch
  paint: PaintedPlan
  grid: ReturnType<typeof gridLines>
  raises: string[]
  basis: string
  createdAt: string
}

/**
 * The approval's facts, read fresh: the newest proposal of the plan must still be PROPOSED (and, when run, carried out
 * by this approval), the plan as it was painted, the hours lever still PROPOSE on the product and every member, and no
 * hour it changes locked since. A refusal says what moved.
 */
export async function previewApply(planId: string, approvalId: string | null): Promise<{ preview: ApplyPreview } | { refusal: string }> {
  const [plan] = await readPlanStates([planId])
  if (!plan) return { refusal: `Hourly plan ${planId} was not found in this business (ad-hourly-plans lists them).` }
  const row = await prisma.adsBrainHourProposal.findFirst({ where: { planId }, orderBy: { createdAt: 'desc' } })
  if (!row) return { refusal: `The brain has painted no proposal for the hourly plan "${plan.name}" (ads-brain view hours shows a product's research and painting).` }
  if (row.status !== 'PROPOSED') return { refusal: `The brain's newest painting of this plan is ${row.status}, not a proposal waiting for approval: ${row.why}` }
  if (approvalId && row.approvalId && row.approvalId !== approvalId) return { refusal: `This approval is not the brain's request for its painting (that is ${row.approvalId}).` }
  if (!approvalId && row.approvalId) {
    const a = await prisma.agentApproval.findFirst({ where: { id: row.approvalId }, select: { status: true, expiresAt: true } })
    const live = a && (['scheduled', 'executing'].includes(a.status) || (a.status === 'pending' && !(a.expiresAt && a.expiresAt < new Date())))
    if (live) return { refusal: `The brain's request ${row.approvalId} for this painting already waits for a person: approve or reject that one.` }
  }
  const paint = row.paint as unknown as PaintedPlan | null
  if (!paint?.windows || !paint.changes?.length) return { refusal: 'This proposal holds no painted week to apply.' }
  const targets = await loadTargets()
  const ladder = [...paint.ladder.serving, ...(paint.ladder.minBid ? [paint.ladder.minBid] : [])]
  if (planBasisOf(plan, ladder.map((k) => targets.paint.get(k))) !== row.planBasis) {
    return { refusal: `"${plan.name}" changed after the brain painted it (its week, campaigns, on/off, time zone, a campaign's own values or a target's values): the plan stays as it is; the brain paints it again on its next research.` }
  }
  // The lever and the locks, as they are now.
  const found = await productCampaigns(row.productId, row.marketplace)
  const own = found?.owned ?? []
  const members = own.filter((c) => plan.members.includes(c.campaignId)).map((c) => ({ campaignId: c.campaignId, name: c.name }))
  if (members.length !== plan.members.length) return { refusal: `"${plan.name}" now holds a campaign that is not the product's own: the brain does not paint it.` }
  const loaded = await loadSettings(row.productId, row.marketplace, members)
  const s = hoursSettingsOf(loaded.product, loaded.members)
  if (s.level !== 'PROPOSE') return { refusal: `The hours lever is ${s.level} now, not PROPOSE (${s.why}): the plan stays as it is.` }
  const lockedNow = paint.changes.filter((c) => s.cells.has(c.cell))
  if (lockedNow.length) return { refusal: `The Owner locked ${plural(lockedNow.length, 'hour')} the painting changes since (${lockedNow.slice(0, 5).map((c) => c.cell).join(', ')}): the plan stays as it is; the brain paints it again around the locks.` }
  // A lane locked now: no changed hour may move it (the painter already kept the lanes locked when it painted).
  const laneOf2 = (k: string | null, l: LaneName) => { const t = k ? targets.paint.get(k) : undefined; return t?.floor ? 0 : t?.lanes[l] }
  const lanesMoved = [...s.lanes].filter((l) => paint.changes.some((c) => laneOf2(c.from, l) !== laneOf2(c.to, l)))
  if (lanesMoved.length) return { refusal: `The Owner locked the lane${lanesMoved.length === 1 ? '' : 's'} ${lanesMoved.join(', ')} since, and the painting moves ${lanesMoved.length === 1 ? 'it' : 'them'}: the plan stays as it is.` }
  const after = { windows: paint.windows, defaultTargetKey: paint.defaultTargetKey }
  const raise = weekRaise(plan, targets.values, after, targets.values)
  const research = row.research as unknown as HoursResearch
  return {
    preview: {
      proposalId: row.id, productId: row.productId, market: row.marketplace,
      plan: { planId: plan.planId, name: plan.name, timezone: plan.timezone, members: plan.members.length, enabled: plan.enabled },
      research, paint, grid: gridLines(paint, targets.paint), raises: raiseWords(raise),
      basis: hash({ proposalId: row.id, planBasis: row.planBasis, windows: paint.windows, defaultTargetKey: paint.defaultTargetKey }),
      createdAt: row.createdAt.toISOString(),
    },
  }
}

/**
 * Apply an approved proposal as the approver: the plan's own fields with the painted week, through the Hourly Bids page's
 * own save, as a new version. Call it only from the approval tool's `execute`, after previewApply passed on a fresh read.
 */
export async function applyProposal(p: ApplyPreview, run: { actor: string; changeSetId: string }): Promise<{ versionId: string | null; before: PlanState; after: PlanState }> {
  const [before] = await readPlanStates([p.plan.planId])
  const { saveRankScheduleGroup } = await import('../ads-create.service.js')
  const { versionSince } = await import('../rank-schedule-group.service.js')
  const started = new Date(Date.now() - 1000)
  await saveRankScheduleGroup({
    id: before.planId, name: before.name, marketplace: before.marketplace, timezone: before.timezone,
    windows: p.paint.windows as never, defaultTargetKey: p.paint.defaultTargetKey, targetOverrides: before.overrides,
    enabled: before.enabled, campaignIds: before.members, portfolioId: before.portfolioId,
    userId: run.actor, changeSetId: run.changeSetId, alwaysVersion: true,
  })
  const [after] = await readPlanStates([p.plan.planId])
  const version = await versionSince(p.plan.planId, started)
  await prisma.adsBrainHourProposal.updateMany({
    where: { id: p.proposalId, status: 'PROPOSED' },
    data: { status: 'APPLIED', versionId: version?.id ?? null, decidedBy: run.actor, decidedAt: new Date(), approvalId: run.changeSetId },
  })
  return { versionId: version?.id ?? null, before, after }
}

// ── The read (ads-brain view hours) ──────────────────────────────────────────────────────────────────────────────

/** The approval's state in words: waiting, approved and applied, rejected, expired. */
async function approvalState(approvalId: string | null, now: Date) {
  if (!approvalId) return null
  const a = await prisma.agentApproval.findFirst({ where: { id: approvalId }, select: { id: true, status: true, expiresAt: true, decidedBy: true, decidedAt: true, reason: true } })
  if (!a) return { approvalId, status: 'gone' }
  const expired = a.status === 'pending' && a.expiresAt != null && a.expiresAt < now
  return { approvalId: a.id, status: expired ? 'expired' : a.status, expiresAt: a.expiresAt?.toISOString() ?? null, decidedBy: a.decidedBy ?? null, decidedAt: a.decidedAt?.toISOString() ?? null, ...(a.reason ? { note: a.reason } : {}) }
}

const MAX_CHANGES_SHOWN = 60

/** The research, the painted grid and the status of one product × market, as the ads-brain tool shows them. */
export async function brainHours(a: { market?: string; productId?: string }, now: Date = new Date()): Promise<{ data: Record<string, unknown> } | { error: string }> {
  if (!a.productId || !a.market) return { error: 'view hours names one product and its market (productId and market): the brain researches and paints one product\'s plan at a time.' }
  const m = strategyMarket(a.market) ?? a.market
  const found = await productCampaigns(a.productId, m)
  if (!found) return { error: `Product ${a.productId} was not found in this business (or Nexus cannot tell whose product it is).` }
  const rows = await prisma.adsBrainHourProposal.findMany({ where: { productId: found.root, marketplace: m }, orderBy: { createdAt: 'desc' }, take: 6 })
  const latest = rows[0] ?? null
  let research: HoursResearch | null = latest ? (latest.research as unknown as HoursResearch) : null
  let paint: PaintedPlan | null = latest ? (latest.paint as unknown as PaintedPlan | null) : null
  let status: string = latest?.status ?? 'NONE'
  let why = latest?.why ?? null
  let planId = latest?.planId ?? null
  let level = latest?.level ?? null
  let decidedNow = false
  if (!latest) {
    // Nothing stored yet (the product is not enrolled, or not due): the brain's research and painting decided now, stored nowhere.
    const d = await decideHours(found.root, m, now, { research: 'always' })
    if (d) { research = d.research; paint = d.paint; status = d.status; why = d.why; planId = d.plan?.planId ?? null; level = d.level; decidedNow = true }
  }
  const approval = latest ? await approvalState(latest.approvalId, now) : null
  if (latest?.status === 'PROPOSED' && approval && approval.status !== 'pending' && approval.status !== 'scheduled' && approval.status !== 'executing') status = approval.status === 'rejected' ? 'REJECTED' : approval.status === 'expired' || approval.status === 'gone' ? 'EXPIRED' : status
  const [plan] = planId ? await readPlanStates([planId]) : []
  const targets = paint ? (await loadTargets()).paint : new Map<string, PaintTarget>()
  const grid = paint ? gridLines(paint, targets) : null
  const settings = await loadSettings(found.root, m, [])
  const perWeek = Number(settings.product.values.hourProposalsPerWeek.value)
  const due = proposalDue(latest ? { createdAt: latest.createdAt, status: latest.status } : null, perWeek, now, status === 'PROPOSED')
  return {
    data: {
      view: 'hours',
      productId: found.root, market: m,
      status, why, level,
      decidedNow,
      ...(decidedNow ? { decidedNowNote: 'Nothing is stored for this product yet: this is the research and painting decided now (stored nowhere, nothing asked). The brain stores and asks only for an enrolled product whose hours lever is OBSERVE or PROPOSE.' } : {}),
      at: latest?.createdAt.toISOString() ?? now.toISOString(),
      plan: plan ? { planId: plan.planId, name: plan.name, timezone: plan.timezone, on: plan.enabled, members: plan.members.length } : null,
      approval,
      ...(latest?.status === 'APPLIED' ? { applied: { versionId: latest.versionId, by: latest.decidedBy, at: latest.decidedAt?.toISOString() ?? null } } : {}),
      hoursLever: { level: settings.product.levers.hours.effective, why: settings.product.levers.hours.why, source: describeProvenance(settings.product.levers.hours.level) },
      next: due,
      research: research ? {
        window: research.window, timeZone: research.timeZone, leftOut: research.leftOut,
        confidence: research.confidence,
        summary: research.summary,
        dayParts: research.dayParts, weekdays: research.weekdays, weekend: research.weekend,
        trend: { span: research.trend.span, clicks: research.trend.clicks, cr: research.trend.cr },
        marketDay: research.marketDay,
        lanes: research.lanes.map((l) => ({ lane: l.lane, clicksShare: l.clicksShare, cr: l.cr, topOfSearchSharePct: l.topOfSearchSharePct })),
        sources: research.sources,
        money: {
          lines: research.money,
          level: research.level, expected: research.expected,
          trendCpc: research.trend.cpc, marketCpc: research.trend.marketCpc,
          lanes: research.lanes.map((l) => ({ lane: l.lane, spendShare: l.spendShare, cpcCents: l.cpcCents, acos: l.acos })),
        },
      } : null,
      painted: paint ? {
        held: paint.held,
        ladder: paint.ladder,
        grid,
        // Each hour's why names its expected ACoS: it sits under money (hidden without ad-spend money).
        changes: paint.changes.slice(0, MAX_CHANGES_SHOWN).map((c) => ({ cell: c.cell, d: c.d, h: c.h, from: c.from, to: c.to })),
        ...(paint.changes.length > MAX_CHANGES_SHOWN ? { moreChanges: paint.changes.length - MAX_CHANGES_SHOWN } : {}),
        locked: paint.locked, limited: paint.limited, antiFlap: paint.antiFlap,
        windows: paint.windows, defaultTargetKey: paint.defaultTargetKey,
        summary: paint.summary,
        blocks: paint.blocks.filter((b) => b.dir !== 'keep').map((b) => ({ d: b.d, part: b.part, dir: b.dir })),
        money: {
          lines: paint.money, effect: paint.effect,
          blocks: paint.blocks.filter((b) => b.dir !== 'keep').map((b) => ({ d: b.d, part: b.part, why: b.why, expectedAcos: b.expectedAcos, acosLo: b.acosLo, acosHi: b.acosHi })),
          changes: paint.changes.slice(0, MAX_CHANGES_SHOWN).map((c) => ({ cell: c.cell, why: c.why })),
        },
      } : null,
      history: rows.slice(1).map((r) => ({ at: r.createdAt.toISOString(), status: r.status, planId: r.planId, changes: ((r.paint as unknown as PaintedPlan | null)?.changes ?? []).length, why: r.why })),
      note: 'The grid reads Monday first, one letter per hour 00–23 (the legend names each target; `.` no target); `^` marks an hour the painting changes, `#` one the Owner locked. A PROPOSED painting waits in the Approvals page as apply-brain-hourly-plan; approved, it is saved as a new version of the plan, run as the person who approved it; rejected or expired, the plan stays as it is.',
    },
  }
}

/** For the plan of a stored proposal: the week before → after as windows (the undo shape set-hourly-bid-plan takes). */
export function weekOfState(p: Pick<PlanState, 'windows' | 'defaultTargetKey'>): Array<Array<string | null>> {
  return weekOf(p)
}
