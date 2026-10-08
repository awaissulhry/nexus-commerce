/**
 * ONE BRAIN AB-4 — Amazon's own rules on brain campaigns: a second brain inside Amazon (design
 * 2026-10-08-ads-one-brain/DESIGN.md §2.12, §3 point 6, §8 row AB-4). Read only: nothing here writes to Amazon, and
 * nothing edits or detaches an Amazon rule (detaching is a later PROPOSE).
 *
 *   kinds     Amazon runs four kinds of rule that can act on a campaign the brain runs. What Nexus can read of each was
 *             checked on 2026-10-08 against Amazon's published API reference, through mirrors of its OpenAPI (none of
 *             these reads has been made live yet) — NATIVE_RULE_CAPABILITY is the capability flag per kind:
 *               budget rules        amazon  GET /sp/campaigns/{campaignId}/budgetRules, once a day per brain campaign,
 *                                           through the channel gateway (ads-api-client.ts listCampaignBudgetRules).
 *                                           They raise a campaign's budget, never lower it.
 *               rule-based bidding  synced  the campaign's bidding strategy as the settings sync last read it from Amazon
 *                                           (Campaign.dynamicBidding.strategy, POST /sp/campaigns/list every 20 minutes):
 *                                           any strategy other than fixed, down only or up and down is a strategy Amazon
 *                                           runs (rule-based bidding's own enum value is not verified, so any other value
 *                                           counts). No extra call.
 *               optimization rules  none    could not read: Amazon documents creating, updating and attaching them
 *                                           (/sp/rules/optimization, /sp/rules/campaignOptimization, POST
 *                                           /sp/campaigns/{id}/optimizationRules), but no read of the rules on one
 *                                           campaign that Nexus could verify. No path is guessed.
 *               schedule bid rules  none    console only: no API read Nexus could verify.
 *   daily     readNativeRulesOnce — the brain campaigns (every campaign of an enrolled product, its own and shared ones, and
 *             every campaign the bid brain runs LIVE or HELD), one GET each, market by market, one at a time; one snapshot
 *             row per campaign (AdsNativeRuleSnapshot), replaced by each read; a campaign that left the brain loses its row.
 *             It runs only while NEXUS_BID_BRAIN_MODE is live or a product is enrolled; otherwise it asks Amazon nothing
 *             and writes nothing.
 *   act       the map shows each rule that acts on a campaign as a writer of its levers, and the clashes view lists each one
 *             on a brain campaign (brain/read-map.ts); a lever does not go AUTO on a campaign where one acts on it
 *             (brain/enrollment.ts, nativeAutoRefusal). "Could not read" is never "no rule": it refuses nothing, and it
 *             is always said.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { workspaceKey } from '@nexus/database/workspace-context'
import { logger } from '../../../utils/logger.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import type { AmazonBudgetRule, ClientContext } from '../ads-api-client.js'
import { brainLiveCeiling } from '../bid-brain/live.js'
import type { BrainLever } from './levers.js'
import { productCampaigns } from './ownership.js'

// ── Kinds and what Nexus can read of them (pure) ─────────────────────────────────────────────────────────────────

export const NATIVE_RULE_KINDS = ['budgetRules', 'ruleBasedBidding', 'optimizationRules', 'scheduleBidRules'] as const
export type NativeRuleKind = (typeof NATIVE_RULE_KINDS)[number]

export interface NativeRuleCapability {
  /** amazon: Nexus asks Amazon once a day · synced: from what the settings sync already reads · none: Nexus cannot read it */
  read: 'amazon' | 'synced' | 'none'
  /** The kind in the map's words. */
  label: string
  /** The levers a rule of this kind moves. */
  levers: readonly BrainLever[]
  /** Where the reading comes from, or why there is none. */
  how: string
}

/** The capability flag per kind: a kind marked `none` is "could not read", never a guessed path. */
export const NATIVE_RULE_CAPABILITY: Record<NativeRuleKind, NativeRuleCapability> = {
  budgetRules: {
    read: 'amazon', label: 'Amazon budget rule', levers: ['budgets'],
    how: 'read once a day per brain campaign: GET /sp/campaigns/{campaignId}/budgetRules (Amazon Ads API, Sponsored Products budget rules), through the channel gateway',
  },
  ruleBasedBidding: {
    read: 'synced', label: 'Amazon-run bidding strategy', levers: ['bids', 'biddingStrategy'],
    how: 'the campaign\'s bidding strategy as the settings sync last read it from Amazon (POST /sp/campaigns/list, every 20 minutes); no extra call',
  },
  optimizationRules: {
    read: 'none', label: 'Amazon optimization rule', levers: ['bids', 'harvest'],
    how: 'could not read: Amazon\'s API documents creating, updating and attaching optimization rules (/sp/rules/optimization, /sp/rules/campaignOptimization) but no read of the rules on one campaign that Nexus could verify — check Campaign Manager, the campaign\'s Rules',
  },
  scheduleBidRules: {
    read: 'none', label: 'Amazon schedule bid rule', levers: ['bids', 'hours'],
    how: 'console only: Nexus found no read of schedule-based bid rules in Amazon\'s API — check Campaign Manager, the campaign\'s Rules',
  },
}

/** The kinds Nexus cannot read on any campaign, said once per view. */
export function notReadableKinds(): Array<{ kind: NativeRuleKind; label: string; levers: BrainLever[]; why: string }> {
  return NATIVE_RULE_KINDS.filter((k) => NATIVE_RULE_CAPABILITY[k].read === 'none')
    .map((k) => ({ kind: k, label: NATIVE_RULE_CAPABILITY[k].label, levers: [...NATIVE_RULE_CAPABILITY[k].levers], why: NATIVE_RULE_CAPABILITY[k].how }))
}

/** When the daily read runs (jobs/ads-native-rules.job.ts), in the words the views use. */
export const DAILY_READ_AT = '04:35 UTC'

/** A stored reading older than this is said as "could not read lately" (the daily read missed at least one day). */
export const STALE_AFTER_MS = 50 * 3_600_000

// ── Readings (pure) ──────────────────────────────────────────────────────────────────────────────────────────────

/** One Amazon rule on one campaign, in the map's words. */
export interface NativeRule {
  kind: NativeRuleKind
  id: string | null
  name: string
  /** It acts on the campaign (active, not ended; one that starts later counts); false: attached but paused or ended. */
  acts: boolean
  levers: BrainLever[]
  detail: string
}

/** One kind's reading on one campaign. `at`: when Amazon (or the settings sync) was read; `lastSeen`: the rules of the last good read. */
export type KindReading =
  | { state: 'read'; at: string | null; rules: NativeRule[] }
  | { state: 'could_not_read'; at: string | null; why: string; lastSeen?: { at: string; rules: NativeRule[] } }

/** What a snapshot row stores in `readings` (Amazon's own words, so `acts` is judged on the day it is shown). */
export type StoredBudgetRules =
  | { state: 'read'; rules: AmazonBudgetRule[] }
  | { state: 'could_not_read'; why: string; lastRead?: { at: string; rules: AmazonBudgetRule[] } }
export interface StoredReadings { budgetRules: StoredBudgetRules }

/** Every kind on one campaign. */
export interface CampaignNativeRules { campaignId: string; kinds: Record<NativeRuleKind, KindReading> }

/** A day as Amazon writes it (YYYYMMDD), from any of its spellings. */
const amazonDay = (d: string | null): string | null => {
  const digits = String(d ?? '').replace(/\D/g, '')
  return digits.length === 8 ? digits : null
}
export const amazonDayOf = (at: Date): string => at.toISOString().slice(0, 10).replace(/-/g, '')
const shownDay = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`

const COMPARISON: Record<string, string> = {
  EQUAL_TO: '=', GREATER_THAN: '>', GREATER_THAN_OR_EQUAL_TO: '≥', LESS_THAN: '<', LESS_THAN_OR_EQUAL_TO: '≤',
}

/** One budget rule, as the map says it, judged on `today` (YYYYMMDD). */
export function budgetRuleOf(rule: AmazonBudgetRule, today: string): NativeRule {
  const paused = String(rule.ruleState ?? '').toUpperCase() === 'PAUSED'
  const end = amazonDay(rule.endDate)
  const start = amazonDay(rule.startDate)
  const ended = !!end && end < today
  const parts = [
    rule.increasePct != null ? `raises the daily budget by ${rule.increasePct} %` : 'raises the daily budget',
    String(rule.ruleType ?? '').toUpperCase() === 'PERFORMANCE' && rule.metric
      ? `when ${rule.metric} ${COMPARISON[String(rule.comparison ?? '').toUpperCase()] ?? rule.comparison ?? '?'} ${rule.threshold ?? '?'} (last 7 days)`
      : null,
    rule.eventName ? `during the event ${rule.eventName}` : null,
    start || end ? `${start ? `from ${shownDay(start)}` : ''}${start && end ? ' ' : ''}${end ? `to ${shownDay(end)}` : ''}` : null,
    rule.daysOfWeek.length ? `on ${rule.daysOfWeek.map((d) => d.slice(0, 3).toLowerCase()).join(', ')}` : null,
    paused ? 'paused' : ended ? `ended ${shownDay(end!)}` : start && start > today ? `starts ${shownDay(start)}` : null,
    rule.ruleStatus ? `Amazon's status: ${rule.ruleStatus}` : null,
  ].filter(Boolean)
  return {
    kind: 'budgetRules',
    id: rule.ruleId,
    name: rule.name ?? rule.ruleId ?? 'a rule with no name',
    acts: !paused && !ended,
    levers: [...NATIVE_RULE_CAPABILITY.budgetRules.levers],
    detail: parts.join('; '),
  }
}

const KNOWN_STRATEGIES = new Set(['LEGACYFORSALES', 'AUTOFORSALES', 'MANUAL'])

/** The bidding strategy the settings sync read: a strategy Amazon runs is a rule; fixed, down only and up and down are not. */
export function strategyReading(raw: unknown, at: string | null): KindReading {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return { state: 'could_not_read', at, why: 'the settings sync has not read this campaign\'s bidding strategy from Amazon' }
  const key = value.replace(/[^a-z]/gi, '').toUpperCase()
  if (KNOWN_STRATEGIES.has(key)) return { state: 'read', at, rules: [] }
  return {
    state: 'read', at,
    rules: [{
      kind: 'ruleBasedBidding', id: null, name: value, acts: true, levers: [...NATIVE_RULE_CAPABILITY.ruleBasedBidding.levers],
      detail: key.includes('RULE')
        ? `Amazon's rule-based bidding (${value}): Amazon moves this campaign's bids toward its own ROAS guardrail, auction by auction`
        : `the bidding strategy ${value} is not fixed, down only or up and down: a strategy Amazon runs, unknown to Nexus`,
    }],
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** Stored rules, read back defensively (a row written by an older shape never breaks a view). */
const asRules = (v: unknown): AmazonBudgetRule[] | null => (Array.isArray(v)
  ? (v.filter(isRecord) as unknown as AmazonBudgetRule[]).map((r) => ({ ...r, daysOfWeek: Array.isArray(r.daysOfWeek) ? r.daysOfWeek.filter((d): d is string => typeof d === 'string') : [] }))
  : null)

export const NOT_READ_YET = `not read yet: Nexus reads Amazon's budget rules once a day (${DAILY_READ_AT}) on brain campaigns only — an enrolled product's, or one the bid brain runs LIVE or HELD`

/** The budget rules a snapshot row holds, as of `now`. */
export function storedBudgetReading(row: { fetchedAt: Date; readings: unknown } | null, now: Date): KindReading {
  if (!row) return { state: 'could_not_read', at: null, why: NOT_READ_YET }
  const at = row.fetchedAt.toISOString()
  const today = amazonDayOf(now)
  const stored = isRecord(row.readings) ? row.readings.budgetRules : null
  const stale = now.getTime() - row.fetchedAt.getTime() > STALE_AFTER_MS
  if (isRecord(stored) && stored.state === 'read') {
    const rules = asRules(stored.rules)
    if (!rules) return { state: 'could_not_read', at, why: 'the stored reading is not understood' }
    const shown = rules.map((r) => budgetRuleOf(r, today))
    return stale
      ? { state: 'could_not_read', at, why: `last read ${at}, more than two days ago: the daily read has not reached this campaign since`, lastSeen: { at, rules: shown } }
      : { state: 'read', at, rules: shown }
  }
  if (isRecord(stored) && stored.state === 'could_not_read') {
    const last = isRecord(stored.lastRead) && typeof stored.lastRead.at === 'string' ? { at: stored.lastRead.at, rules: asRules(stored.lastRead.rules) } : null
    return {
      state: 'could_not_read', at, why: typeof stored.why === 'string' ? stored.why : 'the read failed',
      ...(last?.rules ? { lastSeen: { at: last.at, rules: last.rules.map((r) => budgetRuleOf(r, today)) } } : {}),
    }
  }
  return { state: 'could_not_read', at, why: 'the stored reading is not understood' }
}

/** Every kind on one campaign, from its snapshot row (or none) and the strategy the settings sync read. */
export function campaignNativeRules(input: { campaignId: string; snapshot: { fetchedAt: Date; readings: unknown } | null; strategy: unknown; strategyAt: Date | null }, now: Date): CampaignNativeRules {
  const unreadable = (k: NativeRuleKind): KindReading => ({ state: 'could_not_read', at: null, why: NATIVE_RULE_CAPABILITY[k].how })
  return {
    campaignId: input.campaignId,
    kinds: {
      budgetRules: storedBudgetReading(input.snapshot, now),
      ruleBasedBidding: strategyReading(input.strategy, input.strategyAt ? input.strategyAt.toISOString() : null),
      optimizationRules: unreadable('optimizationRules'),
      scheduleBidRules: unreadable('scheduleBidRules'),
    },
  }
}

/** A rule that acts, with when it was seen and whether only an older read saw it. */
export type ActingRule = NativeRule & { seenAt: string | null; stale: boolean }

/**
 * The rules that act on the campaign: those read, and those the last good read saw when the newest read failed or is old
 * (a rule seen stays a rule until a read says it is gone).
 */
export function actingRules(c: CampaignNativeRules | undefined): ActingRule[] {
  if (!c) return []
  return NATIVE_RULE_KINDS.flatMap((k): ActingRule[] => {
    const r = c.kinds[k]
    if (r.state === 'read') return r.rules.filter((x) => x.acts).map((x) => ({ ...x, seenAt: r.at, stale: false }))
    return (r.lastSeen?.rules ?? []).filter((x) => x.acts).map((x) => ({ ...x, seenAt: r.lastSeen!.at, stale: true }))
  })
}

/** The writers Amazon's rules add to a campaign's levers, in the map's words. */
export function nativeRuleWriters(c: CampaignNativeRules | undefined): Array<{ lever: BrainLever; who: string; why: string }> {
  return actingRules(c).flatMap((r) => r.levers.map((lever) => ({
    lever,
    who: `${NATIVE_RULE_CAPABILITY[r.kind].label} "${r.name}"`,
    why: `Amazon's own rule (a second brain inside Amazon): ${r.detail}${r.stale ? `; last seen ${r.seenAt} — the newest read could not confirm it` : ''}`,
  })))
}

/** One campaign's Amazon rules for the map: what acts, what is attached but idle, and what could not be read there. */
export function campaignNativeView(c: CampaignNativeRules | undefined): {
  acting: Array<{ kind: NativeRuleKind; name: string; levers: BrainLever[]; detail: string; seenAt: string | null }>
  idle: Array<{ kind: NativeRuleKind; name: string; detail: string }>
  couldNotRead: Array<{ kind: NativeRuleKind; why: string; at: string | null }>
} {
  if (!c) return { acting: [], idle: [], couldNotRead: [{ kind: 'budgetRules', why: NOT_READ_YET, at: null }] }
  const acting = actingRules(c).map((r) => ({ kind: r.kind, name: r.name, levers: r.levers, detail: r.detail, seenAt: r.seenAt }))
  const idle = NATIVE_RULE_KINDS.flatMap((k) => {
    const r = c.kinds[k]
    return r.state === 'read' ? r.rules.filter((x) => !x.acts).map((x) => ({ kind: k, name: x.name, detail: x.detail })) : []
  })
  // The kinds Nexus cannot read on any campaign are said once per view (notReadableKinds), not on every campaign.
  const couldNotRead = NATIVE_RULE_KINDS.filter((k) => NATIVE_RULE_CAPABILITY[k].read !== 'none').flatMap((k) => {
    const r = c.kinds[k]
    return r.state === 'could_not_read' ? [{ kind: k, why: r.why, at: r.at }] : []
  })
  return { acting, idle, couldNotRead }
}

/**
 * Why these levers cannot go AUTO on these campaigns: an Amazon rule acts on that lever there (design §2.12: two brains on
 * one lever). Null when nothing read acts on them. "Could not read" refuses nothing.
 */
export function nativeAutoRefusal(asks: ReadonlyArray<{ campaignId: string; name: string; lever: BrainLever }>, readings: ReadonlyMap<string, CampaignNativeRules>): string | null {
  const byLever = new Map<BrainLever, string[]>()
  const seen = new Set<string>()
  for (const a of asks) {
    for (const r of actingRules(readings.get(a.campaignId)).filter((x) => x.levers.includes(a.lever))) {
      const key = `${a.lever}\u0000${a.campaignId}\u0000${r.kind}\u0000${r.name}`
      if (seen.has(key)) continue
      seen.add(key)
      byLever.set(a.lever, [...(byLever.get(a.lever) ?? []), `${NATIVE_RULE_CAPABILITY[r.kind].label} "${r.name}" on campaign ${a.name} (${r.detail}${r.seenAt ? `; read ${r.seenAt}` : ''})`])
    }
  }
  if (!byLever.size) return null
  const lines = [...byLever].map(([lever, hits]) => `the ${lever} lever cannot go AUTO while Amazon's own rule acts on it there — ${hits.slice(0, 5).join('; ')}${hits.length > 5 ? `; and ${hits.length - 5} more` : ''}`)
  return `${lines.join('. ')}. Two brains on one lever is what the brain refuses (design §2.12): detach the rule in Amazon's Campaign Manager — Nexus never edits Amazon's rules — and set the lever again after the next daily read (${DAILY_READ_AT}), or keep the lever at OBSERVE`
}

// ── Reads of the stored snapshots ────────────────────────────────────────────────────────────────────────────────

/** Every kind on each of these campaigns (2 queries, whatever the number of campaigns). */
export async function loadNativeRules(campaignIds: readonly string[], now: Date = new Date()): Promise<Map<string, CampaignNativeRules>> {
  const ids = [...new Set(campaignIds)]
  if (!ids.length) return new Map()
  const [campaigns, snapshots] = await Promise.all([
    prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, dynamicBidding: true, lastSyncedAt: true } }),
    prisma.adsNativeRuleSnapshot.findMany({ where: { campaignId: { in: ids } }, select: { campaignId: true, fetchedAt: true, readings: true } }),
  ])
  const snapshotOf = new Map(snapshots.map((s) => [s.campaignId, s]))
  return new Map(campaigns.map((c) => [c.id, campaignNativeRules({
    campaignId: c.id,
    snapshot: snapshotOf.get(c.id) ?? null,
    strategy: isRecord(c.dynamicBidding) ? c.dynamicBidding.strategy : null,
    strategyAt: c.lastSyncedAt,
  }, now)]))
}

/** What the daily read holds for one market (or every market), for the setup view. */
export async function nativeReadStatus(market: string | null, now: Date = new Date()): Promise<{ campaigns: number; lastAt: string | null; couldNotRead: number; acting: number }> {
  const rows = (await prisma.adsNativeRuleSnapshot.findMany({ select: { campaignId: true, marketplace: true, fetchedAt: true, readings: true } }))
    .filter((r) => !market || strategyMarket(r.marketplace) === market)
  let couldNotRead = 0
  let acting = 0
  let lastAt: string | null = null
  for (const r of rows) {
    const reading = storedBudgetReading(r, now)
    if (reading.state === 'could_not_read') couldNotRead++
    acting += reading.state === 'read' ? reading.rules.filter((x) => x.acts).length : (reading.lastSeen?.rules ?? []).filter((x) => x.acts).length
    const at = r.fetchedAt.toISOString()
    if (!lastAt || at > lastAt) lastAt = at
  }
  return { campaigns: rows.length, lastAt, couldNotRead, acting }
}

// ── The daily read ───────────────────────────────────────────────────────────────────────────────────────────────

/** The brain campaigns: every campaign of an enrolled product (own and shared), and every one the bid brain runs LIVE or HELD. */
export async function brainCampaignIds(): Promise<string[]> {
  const [rows, enrollments] = await Promise.all([
    prisma.bidBrainEnrollment.findMany({ where: { mode: { in: ['LIVE', 'HELD'] } }, select: { campaignId: true } }),
    prisma.adsBrainEnrollment.findMany({ select: { productId: true, marketplace: true } }),
  ])
  const ids = new Set(rows.map((r) => r.campaignId))
  for (const e of enrollments) {
    const found = await productCampaigns(e.productId, e.marketplace)
    for (const c of [...(found?.owned ?? []), ...(found?.shared ?? [])]) ids.add(c.campaignId)
  }
  return [...ids].sort()
}

/** The read runs only while the bid brain is live or a product is enrolled; otherwise it asks Amazon nothing. */
export async function nativeReadDue(env: string | undefined = process.env.NEXUS_BID_BRAIN_MODE): Promise<{ due: boolean; why: string }> {
  if (brainLiveCeiling(env)) return { due: true, why: 'NEXUS_BID_BRAIN_MODE is live' }
  const enrolled = await prisma.adsBrainEnrollment.count()
  return enrolled > 0
    ? { due: true, why: `${enrolled} product${enrolled === 1 ? ' is' : 's are'} enrolled in the brain` }
    : { due: false, why: 'the bid brain is not live and no product is enrolled: nothing to read, Amazon is not asked' }
}

export interface NativeReadSummary {
  ran: boolean
  why: string
  campaigns: number
  read: number
  couldNotRead: number
  /** Calls made to Amazon (one per campaign read; liveCall's own retries not counted). */
  calls: number
  /** Rules that act on a brain campaign after this read. */
  acting: number
  /** Snapshots of campaigns that are no longer brain campaigns (or are archived), removed. */
  dropped: number
}

type ListBudgetRules = (ctx: ClientContext, externalCampaignId: string) => Promise<AmazonBudgetRule[] | null>

export interface NativeReadDeps {
  listBudgetRules?: ListBudgetRules
  contextFor?: (marketplace: string | null) => Promise<ClientContext | null>
  mode?: () => 'sandbox' | 'live'
}

const errorText = (e: unknown): string => {
  const status = (e as { statusCode?: unknown })?.statusCode
  const message = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 240)
  return typeof status === 'number' ? `Amazon answered ${status}: ${message}` : message
}

/** A failure that says Amazon's quota is spent: the rest of that market waits for the next read. */
const quotaSpent = (e: unknown): boolean => (e as { name?: unknown })?.name === 'AmazonAdsQuotaError' || (e as { statusCode?: unknown })?.statusCode === 429

/**
 * The daily read: the budget rules of every brain campaign, one GET each through the gateway, market by market and one at
 * a time (the gateway's rate bucket and liveCall's quota and retries apply); one snapshot per campaign, replaced. A
 * campaign that cannot be read keeps what the last good read saw (`lastRead`), said with its date. Idempotent: a rerun
 * the same day replaces the same rows.
 */
export async function readNativeRulesOnce(opts: { now?: Date } & NativeReadDeps = {}): Promise<NativeReadSummary> {
  const due = await nativeReadDue()
  if (!due.due) return { ran: false, why: due.why, campaigns: 0, read: 0, couldNotRead: 0, calls: 0, acting: 0, dropped: 0 }
  const now = opts.now ?? new Date()
  const ids = await brainCampaignIds()
  const campaigns = ids.length
    ? await prisma.campaign.findMany({
      where: { id: { in: ids }, adProduct: 'SPONSORED_PRODUCTS', status: { not: 'ARCHIVED' } },
      select: { id: true, name: true, externalCampaignId: true, marketplace: true },
      orderBy: { id: 'asc' },
    })
    : []
  const previous = new Map((campaigns.length
    ? await prisma.adsNativeRuleSnapshot.findMany({ where: { campaignId: { in: campaigns.map((c) => c.id) } }, select: { campaignId: true, fetchedAt: true, readings: true } })
    : []).map((s) => [s.campaignId, s]))
  const client = await import('../ads-api-client.js')
  const listBudgetRules: ListBudgetRules = opts.listBudgetRules ?? client.listCampaignBudgetRules
  const mode = (opts.mode ?? client.adsMode)()
  const contextFor = opts.contextFor ?? (async (marketplace: string | null) => (await import('../ads-profile-resolver.js')).adsClientContextFor(marketplace))

  const byMarket = new Map<string, typeof campaigns>()
  for (const c of campaigns) {
    const key = strategyMarket(c.marketplace) ?? c.marketplace ?? ''
    byMarket.set(key, [...(byMarket.get(key) ?? []), c])
  }
  let read = 0, couldNotRead = 0, calls = 0, acting = 0
  const today = amazonDayOf(now)
  for (const [market, group] of byMarket) {
    let ctx: ClientContext | null = null
    let blocked: string | null = mode === 'sandbox' ? 'Amazon Ads runs in sandbox mode on this server (NEXUS_AMAZON_ADS_MODE): nothing was asked' : null
    if (!blocked) {
      try {
        ctx = await contextFor(group[0].marketplace)
        if (!ctx) blocked = `no advertising profile serves ${market || 'this campaign\'s market'}`
      } catch (e) {
        blocked = `the advertising profile for ${market || 'this market'} could not be resolved: ${errorText(e)}`
      }
    }
    for (const c of group) {
      let stored: StoredBudgetRules
      if (blocked) stored = { state: 'could_not_read', why: blocked }
      else if (!c.externalCampaignId) stored = { state: 'could_not_read', why: 'the campaign has no Amazon id in Nexus yet' }
      else {
        calls++
        try {
          const rules = await listBudgetRules(ctx!, c.externalCampaignId)
          stored = rules ? { state: 'read', rules } : { state: 'could_not_read', why: 'Amazon Ads runs in sandbox mode on this server: nothing was asked' }
        } catch (e) {
          stored = { state: 'could_not_read', why: `the read failed: ${errorText(e)}` }
          if (quotaSpent(e)) blocked = `not asked: Amazon's request quota was spent earlier in this read (${errorText(e)}); the next daily read asks again`
        }
      }
      // A failed read keeps what the last good read saw, with its date: a rule seen stays a rule until a read says otherwise.
      if (stored.state === 'could_not_read') {
        const before = previous.get(c.id)
        const old = before && isRecord(before.readings) && isRecord(before.readings.budgetRules) ? before.readings.budgetRules : null
        if (old?.state === 'read' && Array.isArray(old.rules)) stored = { ...stored, lastRead: { at: before!.fetchedAt.toISOString(), rules: asRules(old.rules) ?? [] } }
        else if (old?.state === 'could_not_read' && isRecord(old.lastRead)) stored = { ...stored, lastRead: old.lastRead as unknown as { at: string; rules: AmazonBudgetRule[] } }
        couldNotRead++
      } else read++
      const rulesNow = stored.state === 'read' ? stored.rules : stored.lastRead?.rules ?? []
      acting += rulesNow.map((r) => budgetRuleOf(r, today)).filter((r) => r.acts).length
      const data = { externalCampaignId: c.externalCampaignId ?? '', marketplace: strategyMarket(c.marketplace) ?? c.marketplace, fetchedAt: now, readings: { budgetRules: stored } as unknown as Prisma.InputJsonValue }
      await prisma.adsNativeRuleSnapshot.upsert({
        where: { campaign: workspaceKey({ campaignId: c.id }) },
        create: { campaignId: c.id, ...data },
        update: data,
      })
    }
  }
  // One row per brain campaign: a campaign that left the brain (or was archived) keeps no reading that would go stale.
  const dropped = (await prisma.adsNativeRuleSnapshot.deleteMany({ where: { campaignId: { notIn: campaigns.map((c) => c.id) } } })).count
  const summary: NativeReadSummary = { ran: true, why: due.why, campaigns: campaigns.length, read, couldNotRead, calls, acting, dropped }
  logger.info('[ads-native-rules] daily read', summary)
  return summary
}

/** The cron's one line for the run log. */
export const nativeReadSummaryLine = (s: NativeReadSummary): string =>
  `campaigns=${s.campaigns} read=${s.read} couldNotRead=${s.couldNotRead} calls=${s.calls} acting=${s.acting} dropped=${s.dropped}`
