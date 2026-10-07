/**
 * ADS AUTONOMY W4-1 (Owner 10-07: "Claude like an actual worker"; W3-7) — Claude reads and changes the hourly bid plans of
 * the Hourly Bids page: one rank-schedule GROUP per plan (`RankScheduleGroup`), its member campaigns as `AdSchedule` rows
 * (what the rank-defend engine runs), its week as windows `{ days, startHour, endHour, targetKey }` plus a baseline, the
 * values of its rank targets (`RankTarget`, a campaign's own values as `targetOverrides`). Until now Claude could only
 * switch the whole engine (turn-up / turn-down-automation), and nothing showed a plan's hours.
 *
 *   ad-hourly-plans      read: every plan (market, on/off, members, whose it is, the week in numbers), or ONE plan in
 *                        full — its week as a 7 × 24 summary per day, the targets' values, each campaign's own values,
 *                        its members, what switching it off would give back now, the next 24 hours, its versions.
 *   set-hourly-bid-plan  change ONE plan, through the screen's own services only (no write path of its own):
 *                          create             saveRankScheduleGroup, born SWITCHED OFF (a switch on is its own request)
 *                          update-windows     paint the week (replace it, or set the hours of given days), the baseline
 *                          set-campaigns      add / take out members (one campaign, one plan: one another plan holds is
 *                                             refused unless `move`; the playbook's never)
 *                          set-target-values  a campaign's own floor, placement %, base bid, CPC ceiling per target
 *                                             (the library's values stay in tune-ad-engine, setting rank-target)
 *                          rename, switch     patchRankScheduleGroup (the lightweight PATCH the list uses)
 *                          delete             deleteRankScheduleGroup
 *                        Switching off, deleting, taking a campaign out or saving a plan that is off gives back what the
 *                        plan floored, exactly as the screen does (rank-release.service.ts): the writes are the plan's
 *                        own schedule's (its caps, its brakes), each carrying this request as its change set.
 *
 * Every change is Nexus only, except that give-back (queued for Amazon at once); the rank engine applies the rest at
 * Amazon from its next run (every 15 minutes), each write through Amazon's write gate. Like every ad change tool
 * (ads-change-kit.ts): previewed first, run only as an approved request as the approver (the version row names them,
 * `changedBy`), re-checked in `execute` (stale: refused). Strategy-bound (its own kind, `hourly`): by default nothing runs
 * by rule (maxItems 0, no market). Anything that adds spend — a switch on, more hours out of the Min-bid floor, a higher
 * placement % or base bid, a campaign joining a plan that is on, a give-back — is listed in `raises` and needs the
 * approver's authenticator code (stepUp), or the business's rule where it allowed raises (allowRaise).
 *
 * THE OWNER'S PLANS: a plan a person made or last changed (planOwners: not the playbook's, and not exactly as Claude's
 * last request left it) changes only with a person's approval — it never runs by rule unless the business allowed it
 * (allowPeoplesPlans, off by default). A plan the ads playbook built is refused: apply-ads-playbook runs it.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { checkAdsWriteGate } from '../../advertising/ads-write-gate.js'
import { MARKET_TIME_ZONE } from '../../advertising/ads-market-time.js'
import { isKnownTimeZone } from '../../advertising/ads-local-day.js'
import {
  HOURLY_PLAN_TOOL, campaignHolders, planHistory, planNamedAlready, planOwners, planSchedules, productPlanCampaigns, rankEngineNow,
  readPlanStates, stateOnly, targetLibrary, versionSince,
  type PlanOwner, type PlanState, type TargetLibrary,
} from '../../advertising/rank-schedule-group.service.js'
import {
  dayLine, next24, paintDays, raiseWords, weekAddsSpend, weekRaise, weekSummary,
  type PaintWindow, type TargetValues, type WeekRaise, type WeekSummary,
} from '../../advertising/hourly-plan-week.js'
import { amountLabel, campaignCurrency, liveReachOf, type LiveReach } from './ads-tool-guards.js'
import { approvedRun, canonical, notRun, reachNote, reachRefusal, recheck, ruleFactsFor, ruleRefusal, spOnlyRefusal, type RuleWrite, type StoredReach } from './ads-change-kit.js'
import { adKitLimits, type KitItem } from './ads-autonomy-kit.js'
import { STEP_UP_NEEDS, stepUpApproval } from '../step-up-approval.js'
import { isRefused } from '../../automation/service-outcome.js'
import type { AgentTool, FieldPermission, ToolChange, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'

const TOOL = HOURLY_PLAN_TOOL
/** The most campaigns one request names (a plan may hold more: its own members are carried as they are). */
const MAX_CAMPAIGNS = 100
/** At most this many lines are listed in a preview; the rest are counted. */
const LINES_SHOWN = 20
const OPS = ['create', 'update-windows', 'set-campaigns', 'rename', 'switch', 'delete', 'set-target-values'] as const
type Op = (typeof OPS)[number]
/** The keys of a campaign's own target values this tool sets (any other key it holds is kept as it is). */
const VALUE_KEYS = ['floorBidCents', 'biasPct', 'bidMode', 'bidValueCents', 'maxCpcCents'] as const

type Obj = Record<string, unknown>
type Overrides = PlanState['overrides']
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const unique = (ids: readonly string[] | undefined) => [...new Set((ids ?? []).map((id) => id.trim()).filter(Boolean))]
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('base64url').slice(0, 32)
const quoted = (names: string[], shown = 3) => {
  const head = names.slice(0, shown).map((n) => `"${n}"`)
  return names.length > shown ? `${head.join(', ')} and ${names.length - shown} more` : head.join(', ')
}

// ── What a request names ──────────────────────────────────────────────────────────────────────────

const ID = z.string().trim().min(1).max(64)
const TARGET_KEY = z.string().trim().min(1).max(64)
const WINDOW = z.object({
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7).describe('the days it covers: 0 Sunday, 1 Monday … 6 Saturday'),
  startHour: z.number().int().min(0).max(23).describe('the first hour it covers, 0–23, in the plan\'s time zone'),
  endHour: z.number().int().min(1).max(24).describe('the hour it ends BEFORE, 1–24 (startHour 18, endHour 22 covers 18:00–21:59)'),
  targetKey: TARGET_KEY.describe('the rank target its hours hold (a key ad-hourly-plans lists: a Min-bid target floors every bid)'),
})
const VALUE = z.object({
  campaignId: ID.optional().describe('one member campaign (Nexus id); omit for every member of the plan'),
  targetKey: TARGET_KEY.describe('the rank target whose values this campaign holds differently'),
  floorBidCents: z.number().int().min(2).max(10_000).nullable().optional()
    .describe("a Min-bid target only: the floor its hours hold, in minor units of the campaign's currency; null = the library's"),
  placementPct: z.number().int().min(0).max(900).nullable().optional().describe("the placement % its hours hold; null = the library's"),
  baseBidCents: z.number().int().min(2).max(10_000).nullable().optional()
    .describe("the base bid its hours set on the campaign's ad groups, in minor units of the campaign's currency; null = the library's"),
  holdBaseBid: z.boolean().optional().describe('true: its hours leave the base bid as it is (instead of baseBidCents)'),
  maxCpcCents: z.number().int().min(2).max(10_000).nullable().optional()
    .describe("the cost per click its placement is held under, in minor units; null = the library's"),
  clear: z.boolean().optional().describe("true: drop this campaign's own values for the target (the library's apply again)"),
})

const input = z.object({
  op: z.enum(OPS).describe('create a plan (born switched off) · update-windows (paint its week) · set-campaigns (add or take out members) · '
    + 'rename · switch (on or off) · delete · set-target-values (a campaign\'s own floor, placement %, base bid, CPC ceiling per target)'),
  planId: ID.optional().describe('the plan (planId in ad-hourly-plans); every op but create'),
  name: z.string().trim().min(1).max(120).optional().describe('create, rename: its name, not used by another plan'),
  market: z.string().trim().toUpperCase().min(2).max(20).optional().describe('create: the Amazon market its campaigns are in (IT, DE, …)'),
  campaignIds: z.array(ID).max(MAX_CAMPAIGNS).optional().describe('create: its campaigns (Nexus ids, all in that market, Sponsored Products)'),
  add: z.array(ID).max(MAX_CAMPAIGNS).optional().describe('set-campaigns: campaigns to add (Nexus ids, the plan\'s market)'),
  remove: z.array(ID).max(MAX_CAMPAIGNS).optional().describe('set-campaigns: members to take out (what the plan floored on them comes back)'),
  move: z.boolean().optional().describe('create, set-campaigns: take a campaign out of the hourly plan (or schedule) that holds it now; without it such a campaign is refused. Never one of the playbook\'s plans'),
  windows: z.array(WINDOW).max(60).optional()
    .describe('create, update-windows: the hours, each window a target over some days; the first window covering an hour wins; hours no window covers hold the baseline'),
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional()
    .describe('update-windows: paint only these days (0 Sunday … 6 Saturday): their hours become exactly `windows` (which name only these days); omit to replace the whole week'),
  defaultTargetKey: TARGET_KEY.nullable().optional().describe('create, update-windows: the baseline target of every hour no window covers (null: none); omit to keep it'),
  timezone: z.string().trim().min(1).max(64).optional().describe('create: the plan\'s time zone (default: the market\'s own)'),
  portfolioId: z.string().trim().min(1).max(64).optional()
    .describe('create: bind the plan to an Amazon portfolio (its Amazon portfolio id): it takes in the portfolio\'s campaigns on every save, as the page\'s portfolio plans do'),
  on: z.boolean().optional().describe('switch: true switches it on, false off (off gives back the bids it floored)'),
  values: z.array(VALUE).min(1).max(50).optional().describe('set-target-values: per campaign (or every member) and target, the values its hours hold'),
  why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the plan\'s history'),
})
type Args = z.infer<typeof input>
type ValueArg = z.infer<typeof VALUE>

// ── What a plan will be ───────────────────────────────────────────────────────────────────────────

/** A plan as it will stand after the change (the fields saveRankScheduleGroup takes). */
interface Draft {
  name: string
  enabled: boolean
  timezone: string
  marketplace: string | null
  portfolioId: string | null
  windows: unknown[]
  defaultTargetKey: string | null
  members: string[]
  overrides: Overrides
}

interface CampaignFact {
  id: string
  name: string
  marketplace: string | null
  status: string
  currency: string
  liveWrites: boolean
  notSp: string | null
}

async function campaignFacts(ids: readonly string[]): Promise<Map<string, CampaignFact>> {
  const rows = ids.length
    ? await prisma.campaign.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, name: true, marketplace: true, status: true, type: true, adProduct: true, dailyBudgetCurrency: true, liveBidWritesEnabled: true },
    })
    : []
  return new Map(rows.map((c) => [c.id, {
    id: c.id, name: c.name, marketplace: c.marketplace ?? null, status: String(c.status), currency: campaignCurrency(c), liveWrites: !!c.liveBidWritesEnabled,
    notSp: spOnlyRefusal({ type: c.type == null ? null : String(c.type), adProduct: c.adProduct, name: c.name }),
  }]))
}

/**
 * A window covers whole hours of one day: `endHour` is exclusive and a window never crosses midnight, so one that ends
 * at or before it starts (22 → 2) covers nothing — refused, as the page's merge-windows refuses it.
 */
function windowRefusal(windows: Args['windows']): string | null {
  const bad = (windows ?? []).find((w) => w.endHour <= w.startHour)
  return bad
    ? `A window must end after it starts on the same day: ${bad.startHour} → ${bad.endHour} covers no hour. A window does not cross midnight — split it into two (${bad.startHour} → 24 on the first day and 0 → ${bad.endHour} on the next).`
    : null
}

/** The windows as the request paints them (each validated by the input schema). */
const paintOf = (windows: Args['windows']): PaintWindow[] =>
  (windows ?? []).map((w) => ({ days: [...new Set(w.days)].sort((a, b) => a - b), startHour: w.startHour, endHour: w.endHour, targetKey: w.targetKey }))

/** A campaign's own values for one target, with a request's value applied (null: none left). Other keys are kept. */
export function applyValue(current: Obj | undefined, v: ValueArg): Obj | null {
  if (v.clear) return null
  const out: Obj = { ...(current ?? {}) }
  const set = (key: string, value: unknown) => {
    if (value === null) delete out[key]
    else if (value !== undefined) out[key] = value
  }
  set('floorBidCents', v.floorBidCents)
  set('biasPct', v.placementPct)
  set('maxCpcCents', v.maxCpcCents)
  if (v.holdBaseBid) { out.bidMode = 'hold'; delete out.bidValueCents }
  else if (v.baseBidCents === null) { delete out.bidMode; delete out.bidValueCents }
  else if (typeof v.baseBidCents === 'number') { out.bidMode = 'absolute'; out.bidValueCents = v.baseBidCents }
  return Object.keys(out).length ? out : null
}

/** The highest placement % (outside the floor) and base bid any member's hours hold. */
function highestOf(draft: Draft, lib: TargetLibrary): { placementPct: number; baseBidCents: number | null } {
  const sets = draft.members.length ? draft.members.map((c) => lib.withOverrides(draft.overrides[c])) : [lib.values]
  let placementPct = 0
  let baseBidCents: number | null = null
  for (const values of sets) {
    const t = weekSummary(draft, values).totals
    placementPct = Math.max(placementPct, t.highestPlacementPct)
    if (t.highestBaseBidCents != null) baseBidCents = Math.max(baseBidCents ?? 0, t.highestBaseBidCents)
  }
  return { placementPct, baseBidCents }
}

/** Does any member's week (with its own values) hold Min-bid hours? */
function floorHoursOf(state: PlanState, lib: TargetLibrary): boolean {
  const sets = state.members.length ? state.members.map((c) => lib.withOverrides(state.overrides[c])) : [lib.values]
  return sets.some((values) => weekSummary(state, values).totals.hoursAtFloor > 0)
}

/** The week of each campaign before and after, aggregated: the most hours of each kind of raise, and the campaigns raised. */
function memberRaise(before: PlanState, after: Draft, lib: TargetLibrary): { worst: WeekRaise; campaigns: string[] } {
  const worst: WeekRaise = { leaveFloor: 0, higherPlacement: 0, higherBaseBid: 0, newlyPlanned: 0, changed: 0, toFloor: 0 }
  const campaigns: string[] = []
  for (const c of after.members.filter((id) => before.members.includes(id))) {
    const r = weekRaise(before, lib.withOverrides(before.overrides[c]), after, lib.withOverrides(after.overrides[c]))
    for (const k of Object.keys(worst) as Array<keyof WeekRaise>) worst[k] = Math.max(worst[k], r[k])
    if (r.leaveFloor || r.higherPlacement || r.higherBaseBid || r.newlyPlanned) campaigns.push(c)
  }
  return { worst, campaigns }
}

// ── The limits: what may run by the business's rule ───────────────────────────────────────────────

/**
 * Claude's limits for a plan change run by rule: the kit's (maxItems 0 — every request waits for a person until he types
 * a number) and the plan's own, each defaulting to what refuses: no market, no campaign, no raise, no placement % or base
 * bid above 0, never a person's plan, never a delete.
 */
const PLAN_LIMITS = adKitLimits({ maxItems: 0 }, {
  markets: z.array(z.string().trim().toUpperCase().min(2).max(20)).max(20).default([])
    .describe('the markets where a plan change may run by rule; empty = none (every request waits for a person)'),
  // Empty is none (as markets): a shorter list is a tighter one (claude-trust.service.ts limitsTighten), so "empty = any"
  // would let a person loosen it without their code.
  campaignIds: z.array(z.string().trim().min(1).max(64)).max(250).default([])
    .describe('the campaigns whose plan changes may run by rule (every campaign a change touches must be listed); empty = none'),
  allowRaise: z.boolean().default(false)
    .describe('let a change that adds spend run by rule (a switch on, hours out of the Min-bid floor, a higher placement % or base bid, a give-back); never by default'),
  maxPlacementPct: z.number().int().min(0).max(900).default(0)
    .describe('the highest placement % a plan changed by rule may hold in any hour; 0 = none above 0'),
  maxBaseBidCents: z.number().int().min(0).max(10_000).default(0)
    .describe('the highest base bid a plan changed by rule may set, in minor units of its campaigns\' currency; 0 = none'),
  allowPeoplesPlans: z.boolean().default(false)
    .describe('let a change of a plan a person made or last changed run by rule; off = such a request always waits for a person'),
  allowDelete: z.boolean().default(false).describe('let a plan be deleted by rule; never by default'),
})

/** set-hourly-bid-plan's own checks, before the kit's (C1–C7, the month): the Owner's plans first. Pure. */
function planRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = (preview ?? {}) as {
    op?: Op; markets?: string[]; campaignIds?: string[]; raises?: string[]; peoplesPlans?: string[]
    highest?: { placementPct?: number; baseBidCents?: number | null }; currency?: string
  }
  if (!p.op) return 'there is no preview of this plan change to check; a person decides'
  // The Owner's plans (W4-1): a person's plan changes only with a person's approval unless he allowed it.
  if (p.peoplesPlans?.length && limits.allowPeoplesPlans !== true) {
    return `it changes ${quoted(p.peoplesPlans)}, made or last changed by a person: a person's hourly plan changes only with a person's approval (allowPeoplesPlans is off)`
  }
  const markets = Array.isArray(limits.markets) ? (limits.markets as string[]) : []
  if (!markets.length) return 'this tool\'s limits name no market where a plan change may run by rule (markets is empty); a person decides'
  const outside = (p.markets ?? []).filter((m) => !markets.includes(m))
  if (outside.length || !p.markets?.length) return `this business lets a plan change run by rule only in ${markets.join(', ')}${outside.length ? `, not ${outside.join(', ')}` : ''}; a person decides`
  const allowed = Array.isArray(limits.campaignIds) ? (limits.campaignIds as string[]) : []
  if (!allowed.length) return 'this tool\'s limits name no campaign whose plan changes may run by rule (campaignIds is empty); a person decides'
  const off = (p.campaignIds ?? []).filter((id) => !allowed.includes(id))
  if (off.length) return `${plural(off.length, 'campaign')} it touches ${off.length === 1 ? 'is' : 'are'} not on this tool's list of campaigns (campaignIds); a person decides`
  if (p.op === 'delete' && limits.allowDelete !== true) return 'deleting a plan runs by rule only where this tool\'s limits allow it (allowDelete is off); a person decides'
  if (p.raises?.length && limits.allowRaise !== true) return `it adds spend (${p.raises[0]}${p.raises.length > 1 ? ` and ${plural(p.raises.length - 1, 'more')}` : ''}), and this tool's limits let no raise run by rule (allowRaise is off); a person decides with their code`
  const maxPct = typeof limits.maxPlacementPct === 'number' ? limits.maxPlacementPct : 0
  if ((p.highest?.placementPct ?? 0) > maxPct) return `the plan holds a placement of ${p.highest!.placementPct} % in some hour, above the ${maxPct} % this tool's limits allow by rule; a person decides`
  const maxBid = typeof limits.maxBaseBidCents === 'number' ? limits.maxBaseBidCents : 0
  const bid = p.highest?.baseBidCents ?? null
  if (bid != null && bid > maxBid) return `the plan sets a base bid of ${amountLabel(bid, p.currency ?? 'EUR')} in some hour, above the ${amountLabel(maxBid, p.currency ?? 'EUR')} this tool's limits allow by rule; a person decides`
  return null
}

// ── The decision, in the dry run and again in `execute` ───────────────────────────────────────────

interface Planned {
  op: Op
  before: PlanState | null
  after: Draft | null
  why: string
}

const START_HOW = 'A person with settings.security.manage approves it in Nexus with their authenticator code, or the person who asked confirms '
  + 'it in Claude with theirs when the business set this tool to confirm in Claude. By rule only where the business allowed raises (allowRaise) '
  + 'and the ads strategy lets hourly plans change alone.'

/**
 * Where a change lands: each market's write gate. `stored` is the kit's reach of the markets the gate lets through (live,
 * or sandbox); a market it refuses is listed in `refused` — a give-back there is refused and not queued, and a Nexus-only
 * change says the engine's writes there are refused now (the preview's `gateRefused`, re-checked at execute).
 */
async function reachOf(markets: string[]): Promise<{ stored: StoredReach; refused: Array<{ market: string; deniedAt: string; reason: string }>; first: Extract<LiveReach, { reach: 'refused' }> | null }> {
  const profiles = new Set<string>()
  const refused: Array<{ market: string; deniedAt: string; reason: string }> = []
  let first: Extract<LiveReach, { reach: 'refused' }> | null = null
  for (const marketplace of [...new Set(markets)].sort()) {
    const r = liveReachOf(await checkAdsWriteGate({ marketplace, payloadValueCents: 0 }))
    if (r.reach === 'refused') { first ??= r; refused.push({ market: marketplace, deniedAt: r.deniedAt, reason: r.reason }) }
    else if (r.reach === 'live') profiles.add(r.profileId)
  }
  // Some of it live, some in sandbox: it is live (that is what reaches Amazon), on every profile named.
  return { stored: profiles.size ? { reach: 'live', profileId: [...profiles].sort().join(',') } : { reach: 'sandbox' }, refused, first }
}

/** The plan a request changes, its draft after the change, and every refusal that stops it before anything is shown. */
async function draftOf(a: Args, lib: TargetLibrary): Promise<{ planned: Planned } | { refusal: string }> {
  const op = a.op
  const why = a.why?.trim() ?? ''
  if (op === 'create') {
    const name = a.name?.trim()
    if (!name) return { refusal: 'A new plan needs a name (name).' }
    if (!a.market) return { refusal: 'A new plan needs its market (market: IT, DE, …): its campaigns are all in it.' }
    const campaignIds = unique(a.campaignIds)
    if (!campaignIds.length) return { refusal: 'A new plan needs its campaigns (campaignIds).' }
    const tz = a.timezone?.trim() || MARKET_TIME_ZONE[a.market] || 'Europe/Rome'
    if (!isKnownTimeZone(tz)) return { refusal: `"${tz}" is not a time zone Nexus knows (timezone: e.g. Europe/Rome).` }
    if (!a.windows?.length && !a.defaultTargetKey) return { refusal: 'A plan holds a baseline, windows or both: name defaultTargetKey, windows, or both.' }
    const crossing = windowRefusal(a.windows)
    if (crossing) return { refusal: crossing }
    return {
      planned: {
        op, before: null, why,
        after: { name, enabled: false, timezone: tz, marketplace: a.market, portfolioId: a.portfolioId ?? null, windows: paintOf(a.windows), defaultTargetKey: a.defaultTargetKey ?? null, members: campaignIds.sort(), overrides: {} },
      },
    }
  }
  if (!a.planId) return { refusal: `Name the plan (planId: ad-hourly-plans lists them) for op ${op}.` }
  const [before] = await readPlanStates([a.planId])
  if (!before) return { refusal: `Hourly plan ${a.planId} was not found in this business (planId: ad-hourly-plans lists them).` }
  const same = (): Draft => ({
    name: before.name, enabled: before.enabled, timezone: before.timezone, marketplace: before.marketplace, portfolioId: before.portfolioId,
    windows: before.windows, defaultTargetKey: before.defaultTargetKey, members: [...before.members], overrides: { ...before.overrides },
  })
  const planned = (after: Draft | null): { planned: Planned } => ({ planned: { op, before, after, why } })
  switch (op) {
    case 'rename': {
      const name = a.name?.trim()
      if (!name) return { refusal: 'Name the new name (name).' }
      if (name === before.name) return { refusal: `Nothing would change: the plan is already called "${name}".` }
      return planned({ ...same(), name })
    }
    case 'switch': {
      if (typeof a.on !== 'boolean') return { refusal: 'Say which way to switch it (on: true or false).' }
      if (a.on === before.enabled) return { refusal: `Nothing would change: "${before.name}" is already ${a.on ? 'on' : 'off'}.` }
      if (a.on && !before.members.length) return { refusal: `"${before.name}" holds no campaign: add some first (op set-campaigns).` }
      return planned({ ...same(), enabled: a.on })
    }
    case 'delete':
      return planned(null)
    case 'update-windows': {
      if (!a.windows && a.defaultTargetKey === undefined) return { refusal: 'Name the new hours (windows), the baseline (defaultTargetKey), or both.' }
      const crossing = windowRefusal(a.windows)
      if (crossing) return { refusal: crossing }
      const painted = paintOf(a.windows)
      let windows: unknown[] = before.windows
      if (a.days?.length) {
        const days = new Set(a.days)
        const strays = painted.filter((w) => w.days.some((d) => !days.has(d)))
        if (strays.length) return { refusal: `With days, every window names only those days: a window names ${[...new Set(strays.flatMap((w) => w.days.filter((d) => !days.has(d))))].join(', ')}.` }
        windows = paintDays(before.windows, a.days, painted)
      } else if (a.windows) windows = painted
      const draft = { ...same(), windows, defaultTargetKey: a.defaultTargetKey === undefined ? before.defaultTargetKey : a.defaultTargetKey }
      if (!draft.windows.length && !draft.defaultTargetKey) return { refusal: 'A plan holds a baseline, windows or both: this would leave it holding nothing (delete it instead, op delete).' }
      if (canonical(draft.windows) === canonical(before.windows) && draft.defaultTargetKey === before.defaultTargetKey) return { refusal: `Nothing would change: "${before.name}" already holds these hours.` }
      return planned(draft)
    }
    case 'set-campaigns': {
      const add = unique(a.add).filter((id) => !before.members.includes(id))
      const remove = unique(a.remove)
      const notIn = remove.filter((id) => !before.members.includes(id))
      if (!unique(a.add).length && !remove.length) return { refusal: 'Name the campaigns to add (add) or to take out (remove).' }
      if (notIn.length) return { refusal: `Not queued: ${plural(notIn.length, 'campaign')} to take out ${notIn.length === 1 ? 'is' : 'are'} not in "${before.name}" (${notIn.slice(0, 3).join(', ')}).` }
      if (before.portfolioId && remove.length) {
        const { resolvePortfolioCampaignIds } = await import('../../advertising/ads-create.service.js')
        const covered = new Set(await resolvePortfolioCampaignIds(before.portfolioId))
        const stuck = remove.filter((id) => covered.has(id))
        if (stuck.length) return { refusal: `"${before.name}" covers a whole portfolio: its campaigns follow the portfolio, so ${plural(stuck.length, 'campaign')} of it cannot be taken out here. Move ${stuck.length === 1 ? 'it' : 'them'} out of the portfolio first, or delete the plan.` }
      }
      const members = [...before.members.filter((id) => !remove.includes(id)), ...add].sort()
      if (!members.length) return { refusal: `That would leave "${before.name}" holding no campaign: delete it instead (op delete).` }
      if (!add.length && !remove.length) return { refusal: `Nothing would change: every campaign named is in "${before.name}" already.` }
      const overrides = Object.fromEntries(Object.entries(before.overrides).filter(([c]) => members.includes(c)))
      return planned({ ...same(), members, overrides })
    }
    case 'set-target-values': {
      if (!a.values?.length) return { refusal: 'Name the values (values: per campaign or every member, per target).' }
      const overrides: Overrides = JSON.parse(JSON.stringify(before.overrides))
      for (const v of a.values) {
        const target = lib.values.get(v.targetKey)
        if (!target) return { refusal: `There is no rank target "${v.targetKey}" (ad-hourly-plans lists the targets a plan holds).` }
        if (v.floorBidCents != null && !target.floor) return { refusal: `"${v.targetKey}" is not a Min-bid target: a floor applies only to Min-bid hours.` }
        if (v.holdBaseBid && v.baseBidCents != null) return { refusal: `${v.targetKey}: name a base bid (baseBidCents) or holdBaseBid, not both.` }
        const asked = [v.floorBidCents, v.placementPct, v.baseBidCents, v.maxCpcCents].some((x) => x !== undefined) || v.holdBaseBid || v.clear
        if (!asked) return { refusal: `${v.targetKey}: name a value to set (floorBidCents, placementPct, baseBidCents, holdBaseBid, maxCpcCents) or clear.` }
        if (v.campaignId && !before.members.includes(v.campaignId)) return { refusal: `Campaign ${v.campaignId} is not in "${before.name}": its values are set only on a member (add it with op set-campaigns first).` }
        for (const c of v.campaignId ? [v.campaignId] : before.members) {
          const mine = { ...(overrides[c] ?? {}) }
          const next = applyValue(mine[v.targetKey] as Obj | undefined, v)
          if (next) mine[v.targetKey] = next
          else delete mine[v.targetKey]
          if (Object.keys(mine).length) overrides[c] = mine as Overrides[string]
          else delete overrides[c]
        }
      }
      if (canonical(overrides) === canonical(before.overrides)) return { refusal: `Nothing would change: the campaigns of "${before.name}" already hold these values.` }
      return planned({ ...same(), overrides })
    }
  }
  return { refusal: `Unknown op ${String(op)}.` }
}

/** The request decided: its preview, and what `execute` runs. */
async function decide(args: Record<string, unknown>, ctx: Pick<ToolContext, 'approvalId'>): Promise<{ result: ToolResult; planned?: Planned }> {
  const refuse = (error: string) => ({ result: { ok: false, error } as ToolResult })
  const a = args as Args
  const lib = await targetLibrary()
  const drafted = await draftOf(a, lib)
  if ('refusal' in drafted) return refuse(drafted.refusal)
  const { planned } = drafted
  const { op, before, after } = planned

  // A plan the playbook built is the playbook's: it starts, stops and re-syncs it.
  const owners = before ? await planOwners([before]) : new Map<string, PlanOwner>()
  const owner = before ? owners.get(before.planId) ?? null : null
  if (owner?.by === 'playbook') {
    return refuse(`"${before!.name}" is ${owner.words}: the playbook runs it. Change it with apply-ads-playbook (start, stop, phase, sync) or its template with set-ads-playbook, never here.`)
  }

  // The targets a week names must exist, or its hours would hold nothing.
  if (after && (op === 'create' || op === 'update-windows')) {
    const named = [...new Set([...(after.windows as Array<{ targetKey?: string }>).map((w) => w?.targetKey).filter((k): k is string => !!k), ...(after.defaultTargetKey ? [after.defaultTargetKey] : [])])]
    const missing = named.filter((k) => !lib.values.has(k))
    if (missing.length) return refuse(`There is no rank target ${missing.map((k) => `"${k}"`).join(', ')} (ad-hourly-plans lists the targets; new ones are made on the Hourly Bids page).`)
  }

  // The campaigns: those it adds must be live-able members; one another plan holds needs `move`, never the playbook's.
  const added = after ? after.members.filter((id) => !before?.members.includes(id)) : []
  const removed = before ? before.members.filter((id) => !after?.members.includes(id)) : []
  const touched = [...new Set([...(before?.members ?? []), ...(after?.members ?? [])])]
  const [facts, holders] = await Promise.all([campaignFacts(touched), campaignHolders(added)])
  const missingCampaigns = added.filter((id) => !facts.has(id))
  if (missingCampaigns.length) return refuse(`Not queued: ${plural(missingCampaigns.length, 'campaign')} ${missingCampaigns.length === 1 ? 'was' : 'were'} not found in this business (${missingCampaigns.slice(0, 3).join(', ')}).`)
  const badAdds = added.map((id) => facts.get(id)!).flatMap((c) => {
    if (c.notSp) return [`"${c.name}": ${c.notSp}`]
    if (c.status === 'ARCHIVED') return [`"${c.name}" is archived`]
    const market = after?.marketplace
    if (market && c.marketplace !== market) return [`"${c.name}" is in ${c.marketplace ?? 'no market'}, not ${market}`]
    return []
  })
  if (badAdds.length) return refuse(`Not queued: ${badAdds.slice(0, 3).join('; ')}${badAdds.length > 3 ? ` and ${badAdds.length - 3} more` : ''}. An hourly plan holds live-able Sponsored Products campaigns of one market.`)
  const heldElsewhere = added.map((id) => ({ id, held: holders.get(id) })).filter((x) => x.held && x.held.planId !== before?.planId)
  const fromPlans = [...new Set(heldElsewhere.map((x) => x.held!.planId).filter((id): id is string => !!id))]
  const fromStates = fromPlans.length ? await readPlanStates(fromPlans) : []
  const fromOwners = await planOwners(fromStates)
  const playbookHeld = heldElsewhere.filter((x) => x.held!.planId && fromOwners.get(x.held!.planId)?.by === 'playbook')
  if (playbookHeld.length) {
    return refuse(`Not queued: ${quoted(playbookHeld.map((x) => facts.get(x.id)!.name))} ${playbookHeld.length === 1 ? 'is' : 'are'} held by the ads playbook's hourly plan: one campaign, one plan, and the playbook's are never taken (apply-ads-playbook runs them).`)
  }
  if (heldElsewhere.length && a.move !== true) {
    const words = heldElsewhere.slice(0, 3).map((x) => `"${facts.get(x.id)!.name}" (${x.held!.planName ? `hourly plan "${x.held!.planName}"` : 'a schedule of its own'})`)
    return refuse(`Not queued: one campaign, one plan — ${words.join(', ')}${heldElsewhere.length > 3 ? ` and ${heldElsewhere.length - 3} more` : ''} ${heldElsewhere.length === 1 ? 'is' : 'are'} held already. Ask again with move: true to take ${heldElsewhere.length === 1 ? 'it' : 'them'} out of ${heldElsewhere.length === 1 ? 'it' : 'them'}, or leave ${heldElsewhere.length === 1 ? 'it' : 'them'} out.`)
  }
  // A campaign taken in keeps its own target values from the schedule that holds it now, as the page's builder does
  // (RankPlanBody reads them from the campaign's schedule): they are shown, and its raises are judged on them.
  const carried: Record<string, Overrides[string]> = {}
  for (const id of added) {
    const own = holders.get(id)?.targetOverrides
    if (after && own && Object.keys(own).length && !after.overrides[id]) {
      after.overrides = { ...after.overrides, [id]: own as Overrides[string] }
      carried[id] = own as Overrides[string]
    }
  }
  if (op === 'create') {
    const twin = await planNamedAlready(after!.name, after!.portfolioId)
    if (twin) return refuse(`A plan called "${after!.name}" exists already (${twin.id}): name the new one differently, or change that one.`)
  }
  if (op === 'rename') {
    const twin = await planNamedAlready(after!.name, before!.portfolioId, before!.planId)
    if (twin) return refuse(`Another plan in this scope is already called "${after!.name}": name it differently.`)
  }
  // A portfolio-scoped plan takes in its portfolio's campaigns on every save (saveRankScheduleGroup): the draft says so.
  if (after?.portfolioId && op !== 'rename' && op !== 'switch') {
    const { resolvePortfolioCampaignIds } = await import('../../advertising/ads-create.service.js')
    after.members = [...new Set([...after.members, ...(await resolvePortfolioCampaignIds(after.portfolioId))])].sort()
  }

  // What comes back at Amazon now: a switch-off or a delete gives back on every member; a save takes out what it removes,
  // and a plan saved switched off holds none of its members (saveRankScheduleGroup → rank-release.service.ts).
  const { previewRelease, describeOrphans, releaseSentence } = await import('../../advertising/rank-release.service.js')
  const released = op === 'delete' || (op === 'switch' && after && !after.enabled)
    ? before!.members
    : op === 'rename' || op === 'switch' ? [] : [...removed, ...(after && !after.enabled ? after.members : [])]
  const release = released.length ? await previewRelease([...new Set(released)]) : null
  const restoreIds = new Set((release?.items ?? []).filter((i) => i.outcome === 'restore').map((i) => i.campaignId))
  const bidLines = restoreIds.size ? (await describeOrphans([...restoreIds])).flatMap((o) => o.bids.map((b) => ({ campaign: o.name, kind: b.kind, label: b.label, currentCents: b.currentCents, backCents: b.backCents }))) : []
  const writesNow = restoreIds.size > 0

  // What adds spend.
  const raises: string[] = []
  const raisedCampaigns = new Set<string>()
  const memberCount = after?.members.length ?? 0
  if (op === 'switch' && after?.enabled) {
    raises.push(`switches the plan on: from the hourly bid engine's next run it holds its week on ${plural(memberCount, 'campaign')} (placements, base bids, Min-bid floors)`)
    for (const c of after.members) raisedCampaigns.add(c)
  }
  const valueLines = op === 'set-target-values' ? valueChanges(before!, after!, lib, facts) : []
  if (before?.enabled && after?.enabled && op === 'set-target-values') {
    // A campaign's own values add spend where its plan's hours hold that target (a CPC ceiling raised or lifted too).
    const used = new Set([...(after.windows as Array<{ targetKey?: string }>).map((w) => w?.targetKey), after.defaultTargetKey].filter((k): k is string => !!k))
    const up = valueLines.filter((l) => l.raises.length && used.has(l.targetKey))
    const campaigns = new Set(up.map((l) => l.campaignId))
    if (up.length) raises.push(`${plural(campaigns.size, 'campaign')} hold${campaigns.size === 1 ? 's' : ''} ${[...new Set(up.flatMap((l) => l.raises))].join(', ')} in the plan's hours`)
    for (const c of campaigns) raisedCampaigns.add(c)
  } else if (before?.enabled && after?.enabled && op !== 'switch') {
    const r = memberRaise(before, after, lib)
    const words = raiseWords(r.worst)
    if (words.length) raises.push(...words.map((w) => `${w} (on ${plural(r.campaigns.length, 'campaign')})`))
    for (const c of r.campaigns) raisedCampaigns.add(c)
  }
  if (after?.enabled && added.length) {
    const joining = added.filter((c) => weekAddsSpend(weekSummary(after, lib.withOverrides(after.overrides[c]))))
    if (joining.length) raises.push(`${plural(joining.length, 'campaign')} join${joining.length === 1 ? 's' : ''} a plan that is on: its placement % and base bids apply to ${joining.length === 1 ? 'it' : 'them'} from the engine's next run`)
    for (const c of joining) raisedCampaigns.add(c)
  }
  if (release?.restore) {
    raises.push(`gives back the bids it floored on ${plural(release.restore, 'campaign')} (${plural(release.bids, 'bid')} leave the Min-bid floor)`)
    for (const c of restoreIds) raisedCampaigns.add(c)
  }
  // Lead decision A (W4-1 review): letting go of campaigns of a plan that is ON and has Min-bid hours always asks for the
  // approver's code, whatever is floored at this moment: the engine floors at every Min-bid hour, so a give-back may come
  // with it by the time it runs (and a plain approve would then end "Not run: it raises").
  const lettingGo = op === 'delete' || (op === 'switch' && !!after && !after.enabled) || (op === 'set-campaigns' && removed.length > 0)
  const mayGiveBack = !!before?.enabled && lettingGo && !release?.restore && floorHoursOf(before, lib)
  if (mayGiveBack) {
    raises.push(`the plan is on and holds Min-bid hours: whatever it floors on ${plural(released.length, 'campaign')} it lets go comes back when this runs (nothing is floored right now), and a give-back adds spend`)
    for (const c of released) raisedCampaigns.add(c)
  }

  const markets = [...new Set([...touched.map((id) => facts.get(id)?.marketplace).filter((m): m is string => !!m), ...(op === 'create' && a.market ? [a.market] : [])])].sort()
  const reach = await reachOf(markets)
  if (reach.first && writesNow) return refuse(reachRefusal(reach.first))
  const gateWords = reach.refused.length
    ? ` Amazon's write gate refuses ${reach.refused.map((r) => `${r.market} now (${r.reason})`).join('; ')}: the engine's writes there are refused until that changes.`
    : ''

  // The owners of every plan it changes: this one, and those it takes campaigns from.
  const peoplesPlans = [
    ...(owner?.by === 'person' ? [before!.name] : []),
    ...fromStates.filter((s) => fromOwners.get(s.planId)?.by === 'person').map((s) => s.name),
  ]
  const engine = await rankEngineNow()

  // The kit's facts: one item per campaign it touches; a give-back reaches Amazon now, the rest is Nexus only.
  const items: KitItem[] = [...new Set([...touched, ...released])].map((id) => ({
    entity: { kind: 'campaign', id },
    change: { field: 'automation', raises: raisedCampaigns.has(id) },
    nexusOnly: !restoreIds.has(id),
  }))
  const writes: RuleWrite[] = [...restoreIds].map((id) => ({
    campaignId: id, marketplace: facts.get(id)?.marketplace ?? null, changes: [{ field: 'bid', valueCents: null }], isSuppression: true, label: `campaign "${facts.get(id)?.name ?? id}"`,
  }))
  const ownSchedules = before ? (await planSchedules(before.planId)).map((x) => x.id) : []
  const ruleFacts = await ruleFactsFor({ tool: TOOL, limits: PLAN_LIMITS, items, writes, approvalId: ctx.approvalId ?? null, projectMonth: raises.length > 0, exceptIds: [...ownSchedules, ...heldElsewhere.map((x) => x.held!.scheduleId)] })

  // The week, before and after (library values: a campaign's own values are listed apart).
  const letters = new Map<string, string>()
  const weekBefore = before ? weekSummary(before, lib.values, letters) : null
  const weekAfter = after ? weekSummary(after, lib.values, letters) : null
  const week = (op === 'create' || op === 'update-windows') && weekAfter
    ? weekAfter.days.map((d, i) => ({ day: d.day, ...(weekBefore ? { from: { hours: weekBefore.days[i].hours, ...dayLine(weekBefore.days[i]) } } : {}), to: { hours: d.hours, ...dayLine(d) } }))
    : null
  // One letter per target across both weeks (the later summary's legend names them all).
  const legend = weekAfter?.legend ?? weekBefore?.legend ?? {}
  const highest = after ? highestOf(after, lib) : { placementPct: 0, baseBidCents: null }
  const currency = [...facts.values()][0]?.currency ?? 'EUR'

  const alsoChangedBy = after ? await alsoChanged(after.members, ownSchedules, facts) : null
  const offAllowlist = (after?.members ?? []).map((id) => facts.get(id)).filter((c): c is CampaignFact => !!c && !c.liveWrites)
  const governed = alsoChangedBy?.productPlans ?? []

  const name = after?.name ?? before!.name
  const releaseWords = release ? releaseSentence(release) : null
  const nexusOnly = 'Nexus only: the plan is saved in Nexus, and this change sends nothing to Amazon itself'
  const later = after?.enabled ? `; ${engine.words}` : after ? '; the plan is off, so the hourly bid engine does not act on it until it is switched on (op switch)' : ''
  const consequences = writesNow
    ? `At Amazon now: the bids the plan floored on ${plural(restoreIds.size, 'campaign')} come back (${plural(bidLines.length, 'bid')}, queued for Amazon through its write gate${release?.waitWhy ? `; ${release.waitWhy}` : ''}). Placement percentages stay as last set. The rest is Nexus only${later}.`
    : `${nexusOnly}${later}.${gateWords}`
  const effect = effectOf(op, { before, after, name, added, removed, release, releaseWords, valueLines, weekBefore, weekAfter, engine, a }) + (raises.length ? ` It ADDS SPEND (${raises.join('; ')}): the approver's code is needed.` : '')

  // What the person approves: the plan as it stood, the plan after, the targets' values it holds, whose plans it changes.
  // Not what a give-back lifts: the engine floors and lifts bids at every Min-bid hour, so that would go stale by the hour
  // (execute's fresh dry run decides again whether it raises, and a raise then still needs the approver's code).
  const basis = hash({
    op, before: before ? stateOnly(before) : null, after,
    targets: [...lib.values.values()].filter((t) => JSON.stringify(after ?? before).includes(`"${t.key}"`)),
    holders: heldElsewhere.map((x) => [x.id, x.held!.planId, x.held!.scheduleId]),
    owner: owner?.by ?? null, from: fromStates.map((s) => [s.planId, s.updatedAt]),
  })
  const warnings = [
    ...(governed.length ? [`${quoted(governed)} ${governed.length === 1 ? 'is' : 'are'} also governed by an enabled product rank plan: the product plan wins there, so this hourly plan does not act on ${governed.length === 1 ? 'it' : 'them'} while it is on.`] : []),
    ...(offAllowlist.length && after?.enabled ? [`${plural(offAllowlist.length, 'campaign')} of the plan ${offAllowlist.length === 1 ? 'is' : 'are'} off the live-write allowlist (${quoted(offAllowlist.map((c) => c.name))}): the engine records ${offAllowlist.length === 1 ? 'its' : 'their'} changes in Nexus and sends nothing to Amazon.`] : []),
    ...(weekAfter?.missingTargets.length ? [`The week names ${weekAfter.missingTargets.map((k) => `"${k}"`).join(', ')}, which no longer exist: those hours hold nothing.`] : []),
    ...(!engine.on && after?.enabled ? [`Now ${engine.words}.`] : []),
    ...(heldElsewhere.length ? [`It takes ${quoted(heldElsewhere.map((x) => facts.get(x.id)!.name))} out of ${heldElsewhere.some((x) => x.held!.planName) ? `"${[...new Set(heldElsewhere.map((x) => x.held!.planName).filter(Boolean))].join('", "')}"` : 'a schedule of its own'} (move).`] : []),
  ]

  return {
    planned,
    result: {
      ok: true,
      preview: {
        action: TOOL,
        op,
        summary: effect,
        plan: {
          planId: before?.planId ?? null, name, market: after?.marketplace ?? before?.marketplace ?? null, timezone: after?.timezone ?? before?.timezone,
          enabled: { from: before?.enabled ?? null, to: after?.enabled ?? null }, ...(before?.portfolioId ? { portfolioId: before.portfolioId } : {}),
        },
        owner: owner ? { by: owner.by, words: owner.words } : { by: 'new', words: 'a new plan, made by this request' },
        peoplesPlans,
        members: {
          from: before?.members.length ?? 0, to: after?.members.length ?? 0,
          added: added.slice(0, LINES_SHOWN).map((id) => ({
            campaignId: id, name: facts.get(id)?.name ?? id, from: holders.get(id)?.planName ? `hourly plan "${holders.get(id)!.planName}"` : holders.get(id) ? 'a schedule of its own' : null,
            ...(carried[id] ? { ownTargetValues: carried[id] } : {}),
          })),
          removed: removed.slice(0, LINES_SHOWN).map((id) => ({ campaignId: id, name: facts.get(id)?.name ?? id })),
          ...(added.length + removed.length > 2 * LINES_SHOWN ? { more: added.length + removed.length - 2 * LINES_SHOWN } : {}),
        },
        ...(op === 'rename' ? { rename: { from: before!.name, to: after!.name } } : {}),
        ...(week ? { week, legend } : {}),
        ...(weekAfter ? { weekTotals: { ...(weekBefore ? { from: weekBefore.totals } : {}), to: weekAfter.totals } } : {}),
        ...(op === 'update-windows' || op === 'create' ? { defaultTargetKey: { from: before?.defaultTargetKey ?? null, to: after!.defaultTargetKey } } : {}),
        ...(valueLines.length ? { targetValues: valueLines.slice(0, LINES_SHOWN), ...(valueLines.length > LINES_SHOWN ? { moreTargetValues: valueLines.length - LINES_SHOWN } : {}) } : {}),
        ...(release ? {
          givesBack: {
            campaigns: release.campaigns, restore: release.restore, bids: release.bids, keptByOthers: release.keptByOthers, waitWhy: release.waitWhy,
            sentence: releaseWords,
            items: release.items.filter((i) => i.outcome !== 'nothing').slice(0, LINES_SHOWN).map((i) => ({ campaignId: i.campaignId, name: i.name, outcome: i.outcome, bids: i.bids, floorCents: i.floorCents, floorBy: i.floorBy })),
            bidLines: bidLines.slice(0, LINES_SHOWN),
            ...(bidLines.length > LINES_SHOWN ? { moreBidLines: bidLines.length - LINES_SHOWN } : {}),
          },
        } : {}),
        raises,
        ...(raises.length
          ? { stepUp: { what: op === 'switch' && after?.enabled ? 'switches an hourly bid plan on' : release?.restore || mayGiveBack ? 'gives back bids an hourly bid plan floored' : 'changes an hourly bid plan in a way that adds spend', raises: ['Hourly bid plans', ...(release?.restore || mayGiveBack ? ['Bids'] : [])], needs: STEP_UP_NEEDS, how: START_HOW } }
          : { noCode: 'It adds no spend: it needs no authenticator code.' }),
        highest: { placementPct: highest.placementPct, baseBidCents: highest.baseBidCents },
        currency,
        markets,
        // Every campaign it touches, before and after (where the ads strategy is read).
        campaignIds: [...new Set([...touched, ...released])].sort(),
        alsoChangedBy,
        ...(offAllowlist.length ? { offAllowlist: { campaigns: offAllowlist.length, names: offAllowlist.slice(0, 8).map((c) => c.name) } } : {}),
        engine,
        consequences,
        warnings,
        basis,
        reach: reach.stored,
        // Always present (empty: no market refused), so execute's re-check sees a market the gate starts or stops refusing.
        gateRefused: reach.refused,
        reachNote: writesNow ? reachNote(reach.stored) : `${nexusOnly}${later}.${gateWords}`,
        effect,
        undoNote: undoNoteOf(op),
        ...ruleFacts,
      },
    },
  }
}

/** A campaign's own target values, before → after, one line per campaign and target that changed. */
function valueChanges(before: PlanState, after: Draft, lib: TargetLibrary, facts: Map<string, CampaignFact>) {
  const lines: Array<{ campaignId: string; campaign: string; targetKey: string; from: Obj; to: Obj; raises: string[] }> = []
  for (const c of after.members) {
    const keys = new Set([...Object.keys(before.overrides[c] ?? {}), ...Object.keys(after.overrides[c] ?? {})])
    for (const key of keys) {
      const b = (before.overrides[c] ?? {})[key]
      const n = (after.overrides[c] ?? {})[key]
      if (canonical(b ?? null) === canonical(n ?? null)) continue
      const from = lib.withOverrides(before.overrides[c]).get(key)
      const to = lib.withOverrides(after.overrides[c]).get(key)
      const shown = (t: TargetValues | undefined) => (t ? { floorBidCents: t.floor ? t.floorBidCents : null, placementPct: t.placementPct, bidValueCents: t.bidValueCents, maxCpcCents: t.maxCpcCents } : {})
      lines.push({ campaignId: c, campaign: facts.get(c)?.name ?? c, targetKey: key, from: shown(from), to: shown(to), raises: valueRaises(from, to) })
    }
  }
  return lines
}

/** What a campaign's new values for one target add to spend (pure). */
function valueRaises(from: TargetValues | undefined, to: TargetValues | undefined): string[] {
  if (!from || !to) return []
  const out: string[] = []
  if (to.floor && (to.floorBidCents ?? 2) > (from.floorBidCents ?? 2)) out.push('a higher Min-bid floor')
  if (!to.floor && to.placementPct > from.placementPct) out.push('a higher placement %')
  if (to.bidValueCents != null && (from.bidValueCents == null || to.bidValueCents > from.bidValueCents)) out.push('a higher base bid')
  if (!to.floor && (to.maxCpcCents == null ? from.maxCpcCents != null : from.maxCpcCents != null && to.maxCpcCents > from.maxCpcCents)) out.push('a higher CPC ceiling')
  return out
}

/** The rules, product plans and playbook slots that also act on the plan's campaigns, and auto-bid's rule. */
async function alsoChanged(members: string[], ownSchedules: string[], facts: Map<string, CampaignFact>) {
  const { automationsBoundToCampaign } = await import('../../advertising/rule-campaign-binding.service.js')
  const rules: Array<{ campaign: string; rules: string[] }> = []
  for (const id of members.slice(0, 50)) {
    const bound = await automationsBoundToCampaign(id)
    const names = [...bound.rules.map((r) => `rule "${r.name}"`), ...bound.schedules.filter((s) => !ownSchedules.includes(s.id)).map((s) => `schedule "${s.name}"`)]
    if (names.length) rules.push({ campaign: facts.get(id)?.name ?? id, rules: names })
  }
  const governed = await productPlanCampaigns()
  const slots = await prisma.adsPlaybookLink.findMany({ where: { kind: 'slot', refId: { in: members } }, select: { refId: true } })
  return {
    rules: rules.slice(0, LINES_SHOWN),
    productPlans: members.filter((id) => governed.has(id)).map((id) => facts.get(id)?.name ?? id),
    playbookSlots: [...new Set(slots.map((s) => s.refId))].map((id) => facts.get(id)?.name ?? id),
    autoBid: 'auto-bid leaves the bids of a campaign an enabled hourly plan holds alone (it skips them): while the plan is on, its campaigns\' bids are the plan\'s and their rules\', not auto-bid\'s',
  }
}

function effectOf(op: Op, x: {
  before: PlanState | null; after: Draft | null; name: string; added: string[]; removed: string[]
  release: { restore: number } | null; releaseWords: string | null; valueLines: unknown[]
  weekBefore: WeekSummary | null; weekAfter: WeekSummary | null; engine: { words: string }; a: Args
}): string {
  const totals = (w: WeekSummary | null) => (w ? `${w.totals.hoursAtFloor} h at the Min-bid floor, ${w.totals.hoursPlanned - w.totals.hoursAtFloor} h on other targets, ${w.totals.hoursUnplanned} h with no target` : 'nothing')
  switch (op) {
    case 'create':
      return `Creates the hourly plan "${x.name}" in ${x.after!.marketplace} over ${plural(x.after!.members.length, 'campaign')}, switched OFF (time zone ${x.after!.timezone}): a week of ${totals(x.weekAfter)}.`
        + (x.release?.restore ? ` Saved switched off, it holds none of its campaigns: ${x.releaseWords}.` : '')
        + ' Nothing changes at Amazon until it is switched on (op switch, which needs the approver\'s code).'
    case 'update-windows':
      return `Paints the week of "${x.name}" (${x.after!.enabled ? 'on' : 'off'}${x.a.days?.length ? `, only ${x.a.days.map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', ')}` : ''}): from ${totals(x.weekBefore)} to ${totals(x.weekAfter)}.`
    case 'set-campaigns':
      return `${x.added.length ? `Adds ${plural(x.added.length, 'campaign')}` : ''}${x.added.length && x.removed.length ? ' and takes ' : x.removed.length ? 'Takes ' : ''}${x.removed.length ? `${plural(x.removed.length, 'campaign')} out of` : ' to'} the hourly plan "${x.name}" (${x.before!.members.length} → ${x.after!.members.length}).`
        + (x.release && x.releaseWords ? ` What it floored on the campaigns it lets go: ${x.releaseWords}.` : '')
    case 'rename':
      return `Renames the hourly plan "${x.before!.name}" to "${x.name}" (it changes no hour and no bid).`
    case 'switch':
      return x.after!.enabled
        ? `Switches the hourly plan "${x.name}" on: ${x.engine.words}, holding ${totals(x.weekAfter)} on ${plural(x.after!.members.length, 'campaign')}.`
        : `Switches the hourly plan "${x.name}" off: it holds its ${plural(x.before!.members.length, 'campaign')} no more, and ${x.releaseWords ?? 'nothing it floored is floored now'}; placement percentages stay as last set.`
    case 'delete':
      return `Deletes the hourly plan "${x.name}" and its ${plural(x.before!.members.length, 'member schedule')}${x.before!.enabled ? ' (it is on)' : ''}: ${x.releaseWords ?? 'nothing it floored is floored now'}; placement percentages stay as last set. Its version history and its dated events go with it, and so do its campaigns' own target values: an undo makes the plan again (born off) without them${x.before!.members.length > MAX_CAMPAIGNS ? `, and it cannot hold more than ${MAX_CAMPAIGNS} campaigns (this one holds ${x.before!.members.length}: an undo is refused, make it again on the Hourly Bids page)` : ''}.`
    case 'set-target-values':
      return `Sets the own target values of ${plural(new Set((x.valueLines as Array<{ campaignId: string }>).map((l) => l.campaignId)).size, 'campaign')} in the hourly plan "${x.name}" (${plural(x.valueLines.length, 'line')}; the library's values stay as they are — tune-ad-engine, setting rank-target, changes those).`
  }
}

function undoNoteOf(op: Op): string {
  switch (op) {
    case 'create': return 'Undo deletes the plan (what it floored by then comes back).'
    case 'delete': return `Undo asks for a new plan with the same name, market, campaigns (at most ${MAX_CAMPAIGNS}; above that the undo is refused), portfolio binding, week and time zone, born switched off. Its dated events, its version history and its campaigns' own target values do not come back; the switch comes back with a further request (switch, with the code). What came back at Amazon stays.`
    case 'update-windows': return 'Undo paints the week (and baseline) it had before.'
    case 'set-campaigns': return 'Undo adds back the campaigns it took out and takes out the ones it added (a campaign it took from another plan does not go back there by itself).'
    case 'rename': return 'Undo renames it back.'
    case 'switch': return 'Undo switches it back (a switch on needs the approver\'s code again).'
    case 'set-target-values': return 'Undo sets each campaign\'s values for those targets back.'
  }
}

// ── Running an approved request ───────────────────────────────────────────────────────────────────

/** PB-5b's gate: a raise is approved with the approver's fresh code, or runs by rule where the limits allowed it. */
async function spendGate(ctx: ToolContext, adds: boolean): Promise<{ stepUpAt: Date | null; byRule: boolean } | { refusal: string }> {
  if (!adds) return { stepUpAt: null, byRule: false }
  if (ctx.decidedVia === 'auto') return { stepUpAt: null, byRule: true }
  const coded = await stepUpApproval(ctx)
  return 'refusal' in coded ? { refusal: coded.refusal } : { stepUpAt: coded.at, byRule: false }
}

/** The business's own limits for this tool now (Settings › AI › Claude); the defaults (which refuse) when none are stored. */
async function limitsNow(): Promise<Record<string, unknown>> {
  const row = await prisma.agentTool.findFirst({ where: { name: TOOL }, select: { claudeLimits: true } })
  const parsed = row?.claudeLimits && typeof row.claudeLimits === 'object' ? PLAN_LIMITS.strict().safeParse(row.claudeLimits) : null
  return (parsed?.success ? parsed.data : PLAN_LIMITS.parse({})) as Record<string, unknown>
}

/** The material fields `execute` re-checks (MATERIAL_PREVIEW_FIELDS holds the same). */
const MATERIAL = ['op', 'basis', 'reach', 'gateRefused'] as const

async function runApproved(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { result: fresh, planned } = await decide(args, ctx)
  const refusal = recheck(ctx, fresh, MATERIAL)
  if (refusal || !planned) return notRun(refusal ?? 'Not run: it is no longer a valid change.')
  const p = fresh.preview as { raises: string[]; reach: StoredReach; effect: string }
  // Never by rule beyond the business's own limits, at the moment it runs too: a person's plan (allowPeoplesPlans), a
  // raise (allowRaise), a delete (allowDelete) — judged on the fresh dry run, whatever the request was decided on.
  if (ctx.decidedVia === 'auto') {
    const why = planRefusal(fresh.preview, await limitsNow())
    if (why) return notRun(`Not run by the business's rule: ${why}.`)
  }
  const run = approvedRun(ctx, planned.why || p.effect)
  if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
  const gate = await spendGate(ctx, p.raises.length > 0)
  if ('refusal' in gate) return notRun(gate.refusal)
  const { op, before, after } = planned
  const started = new Date()
  let planId = before?.planId ?? ''
  let release: unknown = null
  const set = { changeSetId: run.changeSetId }
  if (op === 'rename' || op === 'switch') {
    const { patchRankScheduleGroup } = await import('../../advertising/rank-schedule-group.service.js')
    const out = await patchRankScheduleGroup(planId, op === 'rename' ? { name: after!.name } : { enabled: after!.enabled }, run.actor, set)
    if (isRefused(out)) return notRun(`Not run: ${String(out.body.error ?? 'the plan refused it')}.`)
    release = (out.value as { release?: unknown }).release ?? null
  } else if (op === 'delete') {
    const { deleteRankScheduleGroup } = await import('../../advertising/ads-create.service.js')
    release = (await deleteRankScheduleGroup(planId, set)).release
  } else {
    // The screen's own save, with the plan's own fields carried through (as merge-windows and apply-template do).
    const { saveRankScheduleGroup } = await import('../../advertising/ads-create.service.js')
    const saved = await saveRankScheduleGroup({
      ...(before ? { id: before.planId } : {}),
      name: after!.name, marketplace: after!.marketplace, timezone: after!.timezone,
      windows: after!.windows, defaultTargetKey: after!.defaultTargetKey, targetOverrides: after!.overrides,
      enabled: after!.enabled, campaignIds: after!.members, portfolioId: after!.portfolioId,
      userId: run.actor, changeSetId: run.changeSetId, alwaysVersion: true,
    })
    planId = saved.id
    release = saved.release ?? null
  }
  const [now] = op === 'delete' ? [] : await readPlanStates([planId])
  const version = op === 'delete' ? null : await versionSince(planId, started)
  const change: ToolChange = {
    before: { op, ...(before ? stateOnly(before) : { planId: null }), changeSetId: run.changeSetId },
    after: op === 'delete'
      ? { op, planId, deleted: true, name: before!.name, changeSetId: run.changeSetId }
      : { op, ...stateOnly(now), versionId: version?.id ?? null, changeSetId: run.changeSetId },
  }
  return {
    ok: true,
    change,
    data: {
      op, planId, name: after?.name ?? before?.name,
      ...(now ? { enabled: now.enabled, members: now.members.length } : { deleted: true }),
      versionId: version?.id ?? null,
      ...(release ? { givesBack: release } : {}),
      reach: p.reach,
      changeSetId: run.changeSetId,
      ...(gate.stepUpAt ? { approvedWithCode: gate.stepUpAt.toISOString() } : {}),
      note: release
        ? 'The plan is saved in Nexus; the bids it gave back are queued for Amazon (each after the 5-minute cancel window). approval-status follows them.'
        : 'The plan is saved in Nexus; the hourly bid engine applies it from its next run.',
    },
  }
}

// ── Undo: the inverse request, through this tool ──────────────────────────────────────────────────

/** A stored week as windows this tool takes (a legacy window with no target is left out). */
function windowsArg(windows: unknown): PaintWindow[] {
  return (Array.isArray(windows) ? windows : []).flatMap((w) => {
    const x = obj(w)
    if (typeof x.targetKey !== 'string' || !x.targetKey) return []
    const days = Array.isArray(x.days) && x.days.length ? (x.days as number[]) : [0, 1, 2, 3, 4, 5, 6]
    return [{ days, startHour: typeof x.startHour === 'number' ? x.startHour : 0, endHour: typeof x.endHour === 'number' ? x.endHour : 24, targetKey: x.targetKey }]
  })
}

/** The request that sets one campaign's values for one target back to `b` (null: it had none). */
function valueBack(campaignId: string, targetKey: string, b: Obj | undefined): ValueArg | { refusal: string } {
  if (!b) return { campaignId, targetKey, clear: true }
  const other = Object.keys(b).filter((k) => !(VALUE_KEYS as readonly string[]).includes(k))
  if (other.length) return { refusal: `campaign ${campaignId} held its own ${other.join(', ')} for "${targetKey}", which set-hourly-bid-plan cannot set again: set it back on the Hourly Bids page` }
  return {
    campaignId, targetKey,
    floorBidCents: typeof b.floorBidCents === 'number' ? b.floorBidCents : null,
    placementPct: typeof b.biasPct === 'number' ? b.biasPct : null,
    maxCpcCents: typeof b.maxCpcCents === 'number' ? b.maxCpcCents : null,
    ...(b.bidMode === 'hold' ? { holdBaseBid: true } : { baseBidCents: b.bidMode === 'absolute' && typeof b.bidValueCents === 'number' ? b.bidValueCents : null }),
  }
}

export const HOURLY_PLAN_UNDO: ToolUndo = {
  async current(change) {
    const after = obj(change.after)
    const planId = typeof after.planId === 'string' ? after.planId : ''
    const [now] = planId ? await readPlanStates([planId]) : []
    if (after.deleted === true) return now ? { ...after, deleted: false } : change.after
    return now ? { ...after, ...stateOnly(now) } : { ...after, deleted: true }
  },
  request(change) {
    const before = obj(change.before)
    const after = obj(change.after)
    const op = after.op as Op
    const planId = typeof after.planId === 'string' ? after.planId : null
    const why = `undo of an hourly plan change (${op})`
    const members = (v: unknown) => (Array.isArray(v) ? (v as string[]) : [])
    switch (op) {
      case 'create':
        return planId ? { tool: TOOL, args: { op: 'delete', planId, why } } : { refusal: 'This change does not name the plan it created.' }
      case 'delete': {
        const ids = members(before.members)
        if (!ids.length || typeof before.name !== 'string' || typeof before.marketplace !== 'string') return { refusal: 'The deleted plan held no campaign or had no single market, so it cannot be made again here: make it on the Hourly Bids page.' }
        if (ids.length > MAX_CAMPAIGNS) return { refusal: `The deleted plan held ${ids.length} campaigns, more than the ${MAX_CAMPAIGNS} one request makes a plan with: make it again on the Hourly Bids page.` }
        const windows = windowsArg(before.windows)
        if (windows.length > 60) return { refusal: 'The deleted plan held more than 60 windows: make it again on the Hourly Bids page.' }
        return {
          tool: TOOL,
          args: {
            op: 'create', name: before.name, market: before.marketplace, campaignIds: ids, windows, defaultTargetKey: (before.defaultTargetKey as string | null) ?? null, timezone: before.timezone,
            ...(typeof before.portfolioId === 'string' && before.portfolioId ? { portfolioId: before.portfolioId } : {}), why,
          },
        }
      }
      case 'update-windows': {
        const windows = windowsArg(before.windows)
        if (windows.length > 60) return { refusal: 'The week it replaced held more than 60 windows: restore it from the plan\'s versions on the Hourly Bids page.' }
        return { tool: TOOL, args: { op: 'update-windows', planId, windows, defaultTargetKey: (before.defaultTargetKey as string | null) ?? null, why } }
      }
      case 'set-campaigns': {
        const was = members(before.members), now = members(after.members)
        return { tool: TOOL, args: { op: 'set-campaigns', planId, add: was.filter((id) => !now.includes(id)), remove: now.filter((id) => !was.includes(id)), why } }
      }
      case 'rename':
        return { tool: TOOL, args: { op: 'rename', planId, name: before.name, why } }
      case 'switch':
        return { tool: TOOL, args: { op: 'switch', planId, on: before.enabled === true, why } }
      case 'set-target-values': {
        const was = obj(before.overrides) as Overrides, now = obj(after.overrides) as Overrides
        const values: ValueArg[] = []
        for (const c of new Set([...Object.keys(was), ...Object.keys(now)])) {
          for (const key of new Set([...Object.keys(was[c] ?? {}), ...Object.keys(now[c] ?? {})])) {
            const b = (was[c] ?? {})[key] as Obj | undefined
            if (canonical(b ?? null) === canonical(((now[c] ?? {})[key] as Obj | undefined) ?? null)) continue
            const back = valueBack(c, key, b)
            if ('refusal' in back) return { refusal: `Not undone here: ${back.refusal}.` }
            values.push(back)
          }
        }
        if (!values.length) return { refusal: 'This change does not record the values it replaced.' }
        if (values.length > 50) return { refusal: 'It changed more than 50 values: set them back in two requests, or on the Hourly Bids page.' }
        return { tool: TOOL, args: { op: 'set-target-values', planId, values, why } }
      }
    }
    return { refusal: 'This change does not say what it did.' }
  },
}

// ── The read ──────────────────────────────────────────────────────────────────────────────────────

const ADSPEND = FIELDS.financialsAdspendView
/** Money in the plans' output the shared registry does not name (bidValueCents, maxCpcCents it does). */
const PLAN_MONEY: Readonly<Record<string, FieldPermission>> = {
  placementPct: ADSPEND, highestPlacementPct: ADSPEND, highestBaseBidCents: ADSPEND, floorBidCents: ADSPEND,
  currentCents: ADSPEND, backCents: ADSPEND, floorCents: ADSPEND,
}

const readInput = z.object({
  planId: ID.optional().describe('one plan in full (planId from this list)'),
  campaignId: ID.optional().describe('the plan that holds this campaign (Nexus id), in full'),
  market: z.string().trim().toUpperCase().min(2).max(20).optional().describe('only plans in this Amazon market (IT, DE, …)'),
  status: z.enum(['on', 'off', 'all']).default('all').describe('only plans switched on, off, or all'),
})

async function planList(a: z.infer<typeof readInput>) {
  const [states, lib, engine] = await Promise.all([readPlanStates(), targetLibrary(), rankEngineNow()])
  const owners = await planOwners(states)
  const facts = await campaignFacts([...new Set(states.flatMap((s) => s.members))])
  const items = states
    .map((s) => {
      const markets = [...new Set(s.members.map((id) => facts.get(id)?.marketplace).filter((m): m is string => !!m))].sort()
      return { s, markets: markets.length ? markets : s.marketplace ? [s.marketplace] : [] }
    })
    .filter(({ s, markets }) => (!a.market || markets.includes(a.market)) && (a.status === 'all' || (a.status === 'on') === s.enabled))
    .map(({ s, markets }) => {
      const w = weekSummary(s, lib.values).totals
      const owner = owners.get(s.planId)
      return {
        planId: s.planId, name: s.name, market: markets.length === 1 ? markets[0] : null, markets, on: s.enabled, timezone: s.timezone,
        members: s.members.length, ...(s.portfolioId ? { portfolioId: s.portfolioId } : {}),
        owner: owner ? { by: owner.by, words: owner.words } : null,
        week: { hoursAtFloor: w.hoursAtFloor, hoursPlanned: w.hoursPlanned, highestPlacementPct: w.highestPlacementPct, highestBaseBidCents: w.highestBaseBidCents },
        campaignsWithOwnValues: Object.keys(s.overrides).length,
      }
    })
  return {
    items, total: items.length, engine,
    note: 'One plan in full: ad-hourly-plans {"planId": …}. Change one: set-hourly-bid-plan (create, update-windows, set-campaigns, rename, switch, delete, set-target-values); a person approves it, and a plan a person made or last changed never changes by rule unless the business allowed it.',
  }
}

async function planDetail(planId: string) {
  const [[s], lib, engine] = await Promise.all([readPlanStates([planId]), targetLibrary(), rankEngineNow()])
  if (!s) return null
  const owner = (await planOwners([s])).get(s.planId)
  const facts = await campaignFacts(s.members)
  const week = weekSummary(s, lib.values)
  const used = [...new Set([...(s.windows as Array<{ targetKey?: string }>).map((w) => w?.targetKey).filter((k): k is string => !!k), ...(s.defaultTargetKey ? [s.defaultTargetKey] : [])])]
  const target = (t: TargetValues) => ({ key: t.key, name: t.name, minBid: t.floor, floorBidCents: t.floor ? t.floorBidCents : null, placementPct: t.placementPct, bidMode: t.bidMode, bidValueCents: t.bidValueCents, maxCpcCents: t.maxCpcCents })
  const schedules = await planSchedules(s.planId)
  const floors = await prisma.campaign.findMany({ where: { id: { in: s.members } }, select: { id: true, bidsSuppressedAt: true, bidsSuppressedBy: true } })
  const { previewGroupRelease, describeOrphans, releaseSentence, floorOwnerWords } = await import('../../advertising/rank-release.service.js')
  const release = await previewGroupRelease(s.planId)
  const restoreIds = (release?.items ?? []).filter((i) => i.outcome === 'restore').map((i) => i.campaignId)
  const bidLines = restoreIds.length ? (await describeOrphans(restoreIds)).flatMap((o) => o.bids.map((b) => ({ campaign: o.name, label: b.label, currentCents: b.currentCents, backCents: b.backCents }))) : []
  const now = new Date()
  const { events, versions } = await planHistory(s.planId, now)
  const ownSchedules = schedules.map((x) => x.id)
  return {
    plan: { planId: s.planId, name: s.name, on: s.enabled, market: s.marketplace, timezone: s.timezone, ...(s.portfolioId ? { portfolioId: s.portfolioId } : {}), updatedAt: s.updatedAt },
    owner: owner ? { by: owner.by, words: owner.words } : null,
    week: { days: week.days, legend: week.legend, totals: week.totals, ...(week.missingTargets.length ? { missingTargets: week.missingTargets } : {}) },
    baseline: s.defaultTargetKey,
    targets: used.map((k) => lib.values.get(k)).filter((t): t is TargetValues => !!t).map(target),
    campaignValues: Object.entries(s.overrides).flatMap(([c, map]) => Object.keys(map).map((key) => {
      const t = lib.withOverrides(map).get(key)
      return { campaignId: c, campaign: facts.get(c)?.name ?? c, ...(t ? target(t) : { key }) }
    })).slice(0, 50),
    members: s.members.map((id) => {
      const c = facts.get(id)
      const sch = schedules.find((x) => x.campaignId === id)
      const f = floors.find((x) => x.id === id)
      return {
        campaignId: id, name: c?.name ?? id, market: c?.marketplace ?? null, status: c?.status ?? 'NOT_FOUND', liveWrites: c?.liveWrites ?? false,
        scheduleOn: sch?.enabled ?? false, holdsNow: sch?.lastApplied ?? null, lastRun: sch?.lastEvaluatedAt?.toISOString() ?? null,
        floored: f?.bidsSuppressedAt ? { by: floorOwnerWords(f.bidsSuppressedBy), since: f.bidsSuppressedAt.toISOString() } : null,
      }
    }),
    // What switching it off (or deleting it) would give back now: the bids it floored, bid by bid.
    ifSwitchedOffOrDeleted: release
      ? { sentence: releaseSentence(release), restore: release.restore, bids: release.bids, keptByOthers: release.keptByOthers, waitWhy: release.waitWhy, bidLines: bidLines.slice(0, LINES_SHOWN), ...(bidLines.length > LINES_SHOWN ? { moreBidLines: bidLines.length - LINES_SHOWN } : {}) }
      : null,
    next24h: next24(s, lib.values, s.timezone, now),
    events: events.map((e) => ({ name: e.name, startsAt: e.startsAt.toISOString(), endsAt: e.endsAt.toISOString(), armed: e.enabled })),
    ...(events.length ? { eventsNote: 'An armed dated event replaces the weekly plan while it runs (the next 24 hours above show the week only).' } : {}),
    versions: versions.map((v) => ({ versionId: v.id, at: v.createdAt.toISOString(), changedBy: v.changedBy, name: v.name, on: v.enabled, campaigns: v.campaignCount })),
    alsoChangedBy: await alsoChanged(s.members, ownSchedules, facts),
    engine,
    change: 'set-hourly-bid-plan changes it (a person approves; a switch on or a raise needs their code). The library\'s target values are tune-ad-engine\'s (setting rank-target).',
  }
}

const adHourlyPlans: AgentTool = {
  name: 'ad-hourly-plans',
  title: 'Hourly bid plans',
  category: 'advertising',
  riskTier: 'low',
  readOnly: true,
  openWorld: false,
  requires: [F.adsView],
  restrictedFields: PLAN_MONEY,
  input: readInput,
  description:
    'The hourly bid plans of the Hourly Bids page (Amazon Sponsored Products): what each plan holds hour by hour on its '
    + 'campaigns — Min-bid hours (every bid floored, the campaign stays live), placement percentages and base bids per '
    + 'rank target. Without planId: every plan with its market, on or off, campaigns, whose it is (the ads playbook\'s, a '
    + 'Claude request\'s, or a person\'s) and its week in numbers. With planId (or a campaignId it holds): ONE plan in full — '
    + 'its week as a 7 × 24 summary per day (a letter per hour, the legend names each target), hours at the floor and per '
    + 'target, the targets\' values (floor, placement %, base bid, CPC ceiling) and each campaign\'s own values, its members '
    + '(status, live writes, what each holds now, its floor), what switching it off or deleting it would give back now (bid by bid), the '
    + 'next 24 hours in its time zone, armed dated events, its last versions, the rules and plans that also act on its '
    + 'campaigns, and whether the hourly bid engine runs. Read-only; set-hourly-bid-plan changes a plan.',
  async handler(args) {
    const a = args as z.infer<typeof readInput>
    let planId = a.planId ?? null
    if (!planId && a.campaignId) {
      const held = (await campaignHolders([a.campaignId])).get(a.campaignId)
      if (!held?.planId) return { ok: false, error: `No hourly plan holds campaign ${a.campaignId} in this business${held ? ' (it has a schedule of its own, not a plan)' : ''}.` }
      planId = held.planId
    }
    if (planId) {
      const detail = await planDetail(planId)
      return detail ? { ok: true, data: detail } : { ok: false, error: `Hourly plan ${planId} was not found in this business.` }
    }
    return { ok: true, data: await planList(a) }
  },
}

// ── The change tool ───────────────────────────────────────────────────────────────────────────────

const setHourlyBidPlan: AgentTool = {
  name: TOOL,
  title: 'Change an hourly bid plan',
  input,
  // What the Hourly Bids page's own writes ask for (permissions-manifest: changing a rank schedule is ads.campaigns.manage).
  requires: [F.adsCampaignsManage, FIELDS.financialsAdspendView],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  strategyBound: 'amazon-ads',
  requiresApprovalDefault: true,
  // A switch-off, a delete or a removal gives back floored bids at Amazon at once; the engine writes the rest there.
  openWorld: true,
  // Undo asks for the opposite change; a delete comes back as a new plan (born off), and bids given back stay given.
  reversibility: 'partial',
  maxClaudeTrust: 'auto',
  limits: PLAN_LIMITS,
  // The plan's own checks first (the Owner's plans are his: that is the reason a person reads), then the kit's.
  withinLimits: (preview, limits) => planRefusal(preview, limits) ?? ruleRefusal(preview, limits),
  undo: HOURLY_PLAN_UNDO,
  description:
    'Change ONE hourly bid plan of the Hourly Bids page (Amazon Sponsored Products), through the page\'s own services: '
    + 'create one over campaigns of one market (born switched off), paint its week (update-windows: replace the week, or '
    + 'set the hours of given days; the baseline), add or take out campaigns (set-campaigns: a campaign another plan holds '
    + 'only with move; never one of the playbook\'s), rename it, switch it on or off, delete it, or set a campaign\'s own '
    + 'floor, placement %, base bid or CPC ceiling per target (set-target-values; the library\'s values are tune-ad-engine\'s). '
    + 'Switching off, deleting or taking a campaign out gives back the bids the plan floored, as the page does. A person '
    + 'approves it in Nexus — unless the business lets it run by its rule inside its limits and the ads strategy (by '
    + 'default nothing runs by rule). Anything that adds spend (a switch on, hours out of the Min-bid floor, a higher '
    + 'placement % or base bid, a campaign joining a plan that is on, a give-back) is listed in raises and needs the '
    + 'approver\'s authenticator code. A plan a person made or last changed changes by rule only where the business '
    + 'allowed it (allowPeoplesPlans); one the ads playbook built is refused (apply-ads-playbook runs it). The preview '
    + 'shows the week per day from → to, the members from → to, what comes back bid by bid, whose plan it is, what also '
    + 'acts on its campaigns, and where it lands: Nexus only, the hourly bid engine applying it from its next run. '
    + 'undo-change asks for the opposite change.',
  async handler(args, ctx) {
    return (await decide(args, ctx)).result
  },
  async execute(args, ctx) {
    return runApproved(args, ctx)
  },
}

export const ADS_HOURLY_PLAN_TOOLS: AgentTool[] = [adHourlyPlans, setHourlyBidPlan]
