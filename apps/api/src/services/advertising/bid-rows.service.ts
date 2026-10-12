/**
 * Bid page (BAPI, 2026-10-10) — GET /api/advertising/bids: every live keyword and target bid with ONE owner, the night
 * floor, the highest a click can cost (effectiveMaxCpc), the bid brain's aim and what holds it, the last change and the changes of 7 days
 * (the night floor and its give-back folded away), 7 days of results and a 7-day line. Read only.
 *
 * Each owner fact is read where its writer reads it, so the owner is the writer that really moves the bid, and a second
 * writer of the same bid is said (`contested`, `alsoWrites`), never hidden (bid-owner.ts resolveBidOwner). Every writer
 * of the last 7 days in the action log (an Ask-me rule's approved ask included: it carries the rule's actor) is the owner
 * or named, so "who sets it" never contradicts "last change":
 *   pin, allowlist   Campaign.pinBids / liveBidWritesEnabled — the write gate (ads-write-gate.ts)
 *   brain            brainOwnedCampaignIds (bid-brain/live.ts, the gate's and every engine's read); the Owner's kill switch
 *                    on its bids (brain/kill-switch.ts campaignKills)
 *   person           an open PIN / PERSON / CLAUDE BidHold (the brain's read, bid-brain/facts.ts) or personBidTargetIds
 *                    (auto-bid's and the brain's read of a person's bid of the last 60 days), for the page's bids only
 *   rule             the enabled rules at Auto that write bids (not belted to manual), matched by the evaluator's own scope
 *                    matcher (ruleMatchesScope + resolveAssignedCampaignIds), by priority then age; a rank-defense raise
 *                    leaves a campaign Rank & Dayparting holds (rulesWritingOn)
 *   plan             an enabled schedule on the campaign (its group's name) or a product plan's campaign, when the engine
 *                    runs: a goal-mode schedule and a product plan need the hourly plans' switch (engineMode rank-defend)
 *   engine           a running autopilot plan at Auto naming the campaign; else auto-bid's own scope (planAutoBid /
 *                    autoBidHolders): Sponsored Products, no schedule, no product plan, no running autopilot plan, a target
 *                    ACoS the Owner set (configuredTargetAcos), and auto-bid's switch on (engineMode auto-bid)
 * The engines' switches are this business's, as each job reads them at the top of its tick; the server env that arms the
 * crons lives on the scheduler and is not read here. The account dial (Auto · Ask me · Off) is not an owner: under "Ask
 * me" the owner asks instead of writing.
 *
 * Scope: market, productId (its ad groups, the product line expanded), portfolioId (the campaign's), campaignId, adGroupId
 * — and since the scope filter (2026-10-12) their lists portfolioIds, productIds, campaignIds, adGroupIds (OR inside a
 * list, AND across; a singular is a list of one: bid-delivery.ts bidScopeWhere, the one where of the rows and the
 * cursor); `owner` narrows the rows (a kind or an owner's id) and never the totals, so a count reproduces its own rows.
 * `status=live` (default): the target, its ad group and its campaign ENABLED; `all`: everything not archived. Another
 * business's campaign, ad group, portfolio or product reads as not found. Money is in cents of the campaign's currency,
 * under the keys BID_ROWS_MONEY names.
 *
 * Each row says its market (Campaign.marketplace) and currency: the currency Amazon bills the market's ads account in
 * (ads-profile-facts.service.ts adsProfileCurrency, for the profile ads-profile-resolver.ts serves the market with), else
 * the campaign's own budget currency. The totals say the currency when every bid in scope shares one, else null (their
 * spend then adds up several currencies and is no amount in any one).
 *
 * KAPI-B — each row's `goal` (a person's own goal and max for the keyword, as the bid brain reads them: bid-brain/load.ts
 * loadKeywordOwn) and `auto` with `autoWhy` (loadKeywordAuto): AUTO where the bid brain runs the keyword, MANUAL where a
 * person holds it from the brain (his hold — no end once switched to Manual —, his bid of the last 60 days not handed back
 * since, the campaign's pinned bids, the Owner's lock of its bid), NONE where no engine runs it for a goal (the brain does
 * not own the campaign; `autoWhy` names who sets the bid instead, in one line).
 */
import { Prisma } from '@prisma/client'
import { FIELDS } from '@nexus/shared/permissions'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { microsToCents } from '../ads-core/metrics-math.js'
import { ruleMatchesScope } from '../automation-rule-scope.js'
import { engineMode } from '../automation/engine-switch.service.js'
import { classifyActor } from './ads-engine-actors.js'
import { bidScopeWhere, readBidDeliveries, type BidDelivery, type BidScopeQuery } from './bid-delivery.js'
import { resolveAssignedCampaignIds } from './ads-rule-scope-resolver.js'
import { expandProductScope } from './ads-scope-reach.js'
import { strategyBidReader, type StrategyTarget } from './ads-strategy/bids.js'
import { configuredTargetAcos, readOwnerTargets } from './ads-target-acos-resolver.js'
import { isPlanFloorMark } from './bid-brain/facts.js'
import { brainOwnedCampaignIds } from './bid-brain/live.js'
import { effectiveMaxCpc, labelFor, personBidTargetIds } from './bid-grid.service.js'
import { campaignKills } from './brain/kill-switch.js'
import { loadKeywordOwn, type KeywordOwnRead } from './bid-brain/load.js'
import { strategyMarket } from './ads-strategy/bids.js'
import { resolveCampaignOwnership } from './brain/ownership.js'
import {
  AUTO_BID_OWNER_ID, BID_OWNER_KINDS, authorOf, brainHeldBy, collapseBidChanges, NIGHT_FLOOR_MAX_CENTS, ownerMatches, resolveBidOwner,
  rulesWritingOn, sparkOf, withoutUndonePairs, writersOf, writesBids, type AuthorNames, type BidChange, type BidOwner, type BidOwnerFacts, type BidOwnerKind,
  type BidWriterRef, type ChangeAuthor, type HeldBy,
} from './bid-owner.js'
import { keywordRefTarget } from './brain/settings.js'

export interface Ref { id: string; name: string; href?: string }

export interface BidRow {
  targetId: string
  /** The keyword or target; a targeting group's name where Amazon stores no text (bid-grid.service.ts labelFor). */
  text: string
  match: string
  /** null: the campaign is in no portfolio. */
  portfolio: Ref | null
  campaign: Ref
  adGroup: Ref
  /** The campaign's market code (IT, DE, UK, SE…); null on a campaign that names none. */
  market: string | null
  /** ISO 4217 code of the money of this row (EUR, GBP, SEK, PLN…): the market's ads account's, else the campaign's own. */
  currency: string
  /**
   * The writer that writes it most; `contested` with `alsoWrites` when another writes it too or wrote it in the last 7
   * days (the last change's writer is always one of them).
   */
  owner: BidOwner
  /** The bid now, in cents (at the night floor while it is on). */
  bidNow: number
  /** The bid sits at the night floor now (an hourly plan's Min-bid hour, the brain's included). */
  nightFloor: boolean
  /**
   * The most a click can cost now: the bid through the highest placement % and, under "up and down", Amazon's own raise
   * (bid-grid.service.ts effectiveMaxCpc, as Claude's ad-targets says it); the bid itself when nothing lifts it.
   */
  maxCpc: number
  /** The bid the brain's goal asks (its newest decision of the last 48 hours); null without one. */
  brainAim: number | null
  heldBy: HeldBy | null
  /** The newest change of 30 days, the night floor folded away; `by` the writer of its last step, with the owner's id. */
  lastChange: { from: number; to: number; at: string; by: ChangeAuthor } | null
  /**
   * What became of the bid's newest change (bid-delivery.ts, the page's delivery.ts words): waiting · sent · live · failed ·
   * cancelled · replaced · undone; null with no change in 30 days. It can be newer than `lastChange`, which counts only
   * writes that reached Amazon or may still.
   */
  delivery: BidDelivery | null
  changes7d: number
  d7: { clicks: number; orders: number; spend: number; acosPct: number | null }
  /** The bid at this hour on each of the last 7 days, oldest first (the last is now), the night floor left out. */
  spark: number[]
  /**
   * KAPI-B — a person's own goal and max for this keyword (brain settings, ref target:<AdTarget.id>): its target ACoS %,
   * top-of-search share target % and max bid in cents, each null when not set; `by` who set the newest of them, `at` when.
   * Null with none of them.
   */
  goal: { acosPct: number | null; tosPct: number | null; maxCents: number | null; by: ChangeAuthor; at: string } | null
  /** KAPI-B — AUTO: the bid brain runs this keyword · MANUAL: a person holds it, the brain leaves it · NONE: no engine runs it for a goal. */
  auto: 'AUTO' | 'MANUAL' | 'NONE'
  /** KAPI-B — one plain line: why MANUAL or NONE, or what holds the brain back on an AUTO keyword; null when nothing does. */
  autoWhy: string | null
  /**
   * KAPI-B — the product whose brain runs this keyword's campaign: the one product family the campaign advertises alone
   * (brain/ownership.ts, as set-ads-brain reads a product's campaigns), enrolled in the brain in this market — the
   * `productId` a keyword goal or max is saved under (POST …/automation/brain/control set-value, ref target:<id>). Null when
   * none: a shared campaign (D2), a campaign Nexus ties to no product, or a product not enrolled there.
   */
  brainProductId: string | null
}

export interface BidRowsTotals {
  /** Bids in scope (every filter but `owner`). */
  bids: number
  /** Rows answered (`owner` applied). */
  shown: number
  owners: Record<BidOwnerKind, number>
  nightFloor: number
  /** Bids with at least one change in 7 days. */
  changed7d: number
  d7: { clicks: number; orders: number; spend: number; acosPct: number | null }
  /** The currency every bid in scope shares (one market, or several that bill in one), else null; null with no bid. */
  currency: string | null
  /** More than HARD_CAP bids in scope: the lowest bids were left out. */
  truncated: boolean
}

export interface BidRowsQuery extends BidScopeQuery {
  owner?: string | null
  /**
   * The rows' order: `spend` (what costs first, then the most clicked) for a person who sees ad spend; `name` (campaign,
   * ad group, words) for one who does not, so the order never gives the spend ranking away. The route decides it.
   */
  order?: 'spend' | 'name'
}

export type BidRowsAnswer = { ok: true; rows: BidRow[]; totals: BidRowsTotals } | { ok: false; status: 404; error: string }

/** The money keys of this answer: stripped for a person without financials.adspend.view (the route). */
export const BID_ROWS_MONEY: Readonly<Record<string, string>> = Object.fromEntries(
  // KAPI-B — `maxCents`: a keyword's own max bid (`goal.acosPct` is stripped as `acosPct` already is).
  ['bidNow', 'maxCpc', 'brainAim', 'from', 'to', 'spend', 'acosPct', 'spark', 'maxCents'].map((k) => [k, FIELDS.financialsAdspendView]),
)

export const HARD_CAP = 5000
const DAY = 86_400_000
/** The action log read for the last change. */
const CHANGES_DAYS = 30
/** A brain decision older than this is not the brain's view of today. */
const BRAIN_DECISION_HOURS = 48
/** The action-log types of a target's bid change (brain/read-map.ts leverOfAction 'bids'). */
const BID_CHANGE_TYPES = ['AD_BID_UPDATE', 'bid_set_by_engine', 'bid_down', 'bid_up']
/** The person holds the brain reads (bid-brain/facts.ts): every other kind is a stop, a freeze or a strategy hold. */
const PERSON_HOLD_KINDS = ['PIN', 'PERSON', 'CLAUDE']
/** Auto-undo's own pin on a bid it put back (bid-brain/facts.ts UNDO_PIN_KIND): the brain's pin layer, but no person's. */
const AUTO_UNDO_PIN_KIND = 'UNDO_PIN'

const round1 = (x: number) => Math.round(x * 10) / 10
const acosPctOf = (spend: number, sales: number) => (sales > 0 ? round1((spend / sales) * 100) : null)
/** A link into the ads pages; the web puts the business's prefix (/w/<id>) in front, as for every ads link the API gives. */
const href = (...parts: string[]) => `/marketing/ads/${parts.map(encodeURIComponent).join('/')}`

export async function readBidRows(q: BidRowsQuery, now: Date = new Date()): Promise<BidRowsAnswer> {
  // ── Scope: another business's ids read as not found (the workspace's own rows only). ──
  const scope = await bidScopeWhere(q)
  if ('error' in scope) return scope

  const found = await prisma.adTarget.findMany({
    where: scope.where,
    select: {
      id: true, expressionValue: true, expressionType: true, kind: true, bidCents: true, status: true, suppressedFromBidCents: true,
      adGroup: {
        select: {
          id: true, name: true, status: true, bidsSuppressedAt: true, bidsSuppressedBy: true, bidsSuppressedFloorCents: true,
          campaign: {
            select: {
              id: true, name: true, status: true, marketplace: true, portfolioId: true, adProduct: true, pinBids: true, dailyBudgetCurrency: true,
              liveBidWritesEnabled: true, dynamicBidding: true, bidsSuppressedAt: true, bidsSuppressedBy: true, bidsSuppressedFloorCents: true,
            },
          },
        },
      },
    },
    orderBy: [{ bidCents: 'desc' }, { id: 'asc' }],
    take: HARD_CAP + 1,
  })
  const truncated = found.length > HARD_CAP
  const targets = truncated ? found.slice(0, HARD_CAP) : found
  const ids = targets.map((t) => t.id)
  const campaigns = new Map(targets.map((t) => [t.adGroup.campaign.id, t.adGroup.campaign]))
  const campaignIds = [...campaigns.keys()]
  const adGroupIds = [...new Set(targets.map((t) => t.adGroup.id))]

  // KAPI-B — each keyword's own goal and max, and whether the bid brain runs it (Auto / Manual / none), beside the reads below.
  const keywordAuto = loadKeywordAuto(targets, campaignIds, now)
  const [facts, changes, perf, decisions, portfolios, currencies, deliveries] = await Promise.all([
    loadOwnerFacts(targets, campaignIds, adGroupIds, now),
    loadChanges(ids, now),
    ids.length ? prisma.amazonAdsDailyPerformance.groupBy({
      by: ['localEntityId'],
      where: { entityType: 'AD_TARGET', localEntityId: { in: ids }, date: { gte: new Date(now.getTime() - 7 * DAY) } },
      _sum: { costMicros: true, sales7dCents: true, clicks: true, orders7d: true },
    }) : Promise.resolve([]),
    loadBrainDecisions(ids, now),
    portfolioNames([...new Set(campaignIds.map((id) => campaigns.get(id)!.portfolioId).filter((p): p is string => !!p))]),
    marketCurrencies([...new Set(campaignIds.map((id) => campaigns.get(id)!.marketplace).filter((m): m is string => !!m))]),
    readBidDeliveries(ids, now),
  ])
  const perfOf = new Map(perf.map((p) => [p.localEntityId, p]))
  const kw = await keywordAuto

  const all: BidRow[] = targets.map((t) => {
    const g = t.adGroup
    const c = g.campaign
    const match = t.expressionType || 'UNKNOWN'
    const { net, openFloor } = collapseBidChanges(changes.byTarget.get(t.id) ?? [])
    const planMark = (c.bidsSuppressedAt && isPlanFloorMark(c.bidsSuppressedBy)) ? c.bidsSuppressedFloorCents
      : (g.bidsSuppressedAt && isPlanFloorMark(g.bidsSuppressedBy)) ? g.bidsSuppressedFloorCents : undefined
    const floorCents = planMark ?? NIGHT_FLOOR_MAX_CENTS
    const nightFloor = !!openFloor || (planMark !== undefined && (t.suppressedFromBidCents != null || t.bidCents <= floorCents))
    const baseCents = openFloor?.fromCents ?? (nightFloor && t.suppressedFromBidCents != null ? t.suppressedFromBidCents : t.bidCents)
    const last = net[net.length - 1]
    const p = perfOf.get(t.id)
    const spend = p ? microsToCents(p._sum.costMicros) : 0
    const sales = p?._sum.sales7dCents ?? 0
    const decision = decisions.get(t.id) ?? null
    const author = (actor: string | null) => authorOf(actor, changes.names)
    // KAPI-B — the Owner's lock of the keyword's bid (or its ad group's) is his hold: the bid brain leaves it (facts.ts).
    const ownerFacts = kw.own.get(t.id)?.lock ? { ...facts.of(t), personHold: true } : facts.of(t)
    const owner = resolveBidOwner(ownerFacts, writersOf(net, author, now))
    return {
      targetId: t.id,
      text: labelFor(t.expressionValue, t.kind || 'UNKNOWN', match).label,
      match,
      portfolio: c.portfolioId ? { id: c.portfolioId, name: portfolios.get(c.portfolioId) ?? c.portfolioId, href: href('portfolios', c.portfolioId) } : null,
      campaign: { id: c.id, name: c.name, href: href('campaigns', c.id) },
      adGroup: { id: g.id, name: g.name, href: href('campaigns', c.id, 'ad-groups', g.id) },
      market: c.marketplace,
      currency: (c.marketplace ? currencies.get(c.marketplace) : null) ?? campaignCurrency(c),
      owner,
      bidNow: t.bidCents,
      nightFloor,
      maxCpc: effectiveMaxCpc(t.bidCents, c.dynamicBidding).cents ?? t.bidCents,
      brainAim: decision?.goalBidCents ?? null,
      heldBy: brainHeldBy(decision, { autoUndoPin: facts.autoUndoPin(t) }),
      lastChange: last ? { from: last.from, to: last.to, at: last.at, by: author(last.actor) } : null,
      delivery: deliveries.byTarget.get(t.id) ?? null,
      changes7d: net.filter((n) => Date.parse(n.at) >= now.getTime() - 7 * DAY).length,
      d7: { clicks: p?._sum.clicks ?? 0, orders: p?._sum.orders7d ?? 0, spend, acosPct: acosPctOf(spend, sales) },
      spark: sparkOf(net, baseCents, now),
      goal: goalOf(kw.own.get(t.id), author),
      // R2 — the one line names the row's owner (the same answer as `owner`).
      ...kw.autoOf(t, facts.of(t), owner, facts.autoUndoPin(t)),
      brainProductId: kw.brainProductOf(c.id),
    }
  })

  const owners = Object.fromEntries(BID_OWNER_KINDS.map((k) => [k, 0])) as Record<BidOwnerKind, number>
  let clicks = 0
  let orders = 0
  let spend = 0
  let sales = 0
  for (const r of all) {
    owners[r.owner.kind]++
    clicks += r.d7.clicks
    orders += r.d7.orders
    spend += r.d7.spend
    sales += perfOf.get(r.targetId)?._sum.sales7dCents ?? 0
  }
  const byName = (a: BidRow, b: BidRow) => a.campaign.name.localeCompare(b.campaign.name) || a.adGroup.name.localeCompare(b.adGroup.name) || a.text.localeCompare(b.text) || a.targetId.localeCompare(b.targetId)
  const rows = all
    .filter((r) => ownerMatches(r.owner, q.owner))
    // What costs first, then the most clicked (only for a person who sees spend); then by words, so the order is stable.
    .sort(q.order === 'name' ? byName : (a, b) => b.d7.spend - a.d7.spend || b.d7.clicks - a.d7.clicks || byName(a, b))
  return {
    ok: true,
    rows,
    totals: {
      bids: all.length,
      shown: rows.length,
      owners,
      nightFloor: all.filter((r) => r.nightFloor).length,
      changed7d: all.filter((r) => r.changes7d > 0).length,
      d7: { clicks, orders, spend, acosPct: acosPctOf(spend, sales) },
      currency: new Set(all.map((r) => r.currency)).size === 1 ? all[0].currency : null,
      truncated,
    },
  }
}

// ── The owner facts ────────────────────────────────────────────────────────────────────────────────────────────────

type TargetRow = {
  id: string
  status: string
  adGroup: {
    id: string
    status: string
    campaign: { id: string; name: string; status: string; marketplace: string | null; portfolioId: string | null; adProduct: string | null; pinBids: boolean; dailyBudgetCurrency: string; liveBidWritesEnabled: boolean; dynamicBidding: unknown }
  }
}

interface ScheduleRow { id: string; campaignId: string; name: string; windows: unknown; defaultTargetKey: string | null; group: { id: string; name: string } | null }

interface RuleRow {
  id: string
  name: string
  actions: unknown
  conditions: unknown
  scopeMarketplace: string | null
  scopePortfolioId: string | null
  scopeCampaignId: string | null
  scopeProductId: string | null
}

async function loadOwnerFacts(targets: readonly TargetRow[], campaignIds: string[], adGroupIds: string[], now: Date): Promise<{ of: (t: TargetRow) => BidOwnerFacts; autoUndoPin: (t: TargetRow) => boolean }> {
  const { isGoalMode } = await import('../../jobs/ad-rank-defend.job.js')
  const { RUNNING_AUTOPILOT_PLANS } = await import('../../jobs/ad-autopilot.job.js')
  const none = !campaignIds.length
  const [brainOwned, holds, personBids, rulesRead, schedules, productPlans, autopilots, rankDefend, autoBid] = await Promise.all([
    brainOwnedCampaignIds(campaignIds),
    none ? [] : prisma.bidHold.findMany({
      where: { campaignId: { in: campaignIds }, endedAt: null, kind: { in: [...PERSON_HOLD_KINDS, AUTO_UNDO_PIN_KIND] }, OR: [{ until: null }, { until: { gt: now } }] },
      select: { campaignId: true, targetId: true, kind: true },
    }),
    none ? new Set<string>() : personBidTargetIds({ targetIds: targets.map((t) => t.id) }),
    none ? [] : prisma.automationRule.findMany({
      where: { domain: 'advertising', enabled: true, autonomyLevel: 'AUTO' },
      select: { id: true, name: true, actions: true, conditions: true, scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    }) as Promise<RuleRow[]>,
    none ? ([] as ScheduleRow[]) : prisma.adSchedule.findMany({
      where: { campaignId: { in: campaignIds }, enabled: true },
      select: { id: true, campaignId: true, name: true, windows: true, defaultTargetKey: true, group: { select: { id: true, name: true } } },
    }) as Promise<ScheduleRow[]>,
    none ? [] : prisma.productRankPlan.findMany({ where: { enabled: true }, select: { id: true, lastSummary: true } }),
    none ? [] : prisma.autopilotPlan.findMany({ where: RUNNING_AUTOPILOT_PLANS, select: { id: true, name: true, autonomy: true, campaignIds: true } }),
    none ? null : engineMode('rank-defend', 'AUTO'),
    none ? null : engineMode('auto-bid', 'AUTO'),
  ])
  const kills = brainOwned.size ? await campaignKills([...brainOwned], ['bids']) : new Map()

  const personHolds = holds.filter((h) => PERSON_HOLD_KINDS.includes(h.kind))
  const undoPins = holds.filter((h) => h.kind === AUTO_UNDO_PIN_KIND)
  const heldTargets = new Set(personHolds.filter((h) => h.targetId).map((h) => h.targetId!))
  const heldCampaigns = new Set(personHolds.filter((h) => !h.targetId).map((h) => h.campaignId))
  const undoPinned = new Set(undoPins.map((h) => h.targetId ?? `campaign:${h.campaignId}`))

  // Rules: the evaluator's own matcher, at the grain of a target's ad group (its products).
  const rules = rulesRead.filter((r) => writesBids(r))
  const assigned = rules.length ? await resolveAssignedCampaignIds(rules) : new Map<string, string[]>()
  const productRules = rules.filter((r) => r.scopeProductId)
  const [groupProducts, expanded] = productRules.length
    ? await Promise.all([
      prisma.adProductAd.findMany({ where: { adGroupId: { in: adGroupIds }, productId: { not: null } }, select: { adGroupId: true, productId: true } }),
      Promise.all(productRules.map(async (r) => [r.scopeProductId!, await expandProductScope(r.scopeProductId!)] as const)),
    ])
    : [[], []] as const
  const productsOf = new Map<string, string[]>()
  for (const a of groupProducts) productsOf.set(a.adGroupId, [...(productsOf.get(a.adGroupId) ?? []), a.productId!])
  const expandedOf = new Map(expanded)
  const rulesOfGroup = new Map<string, Array<{ id: string; name: string }>>()
  const rulesFor = (t: TargetRow) => {
    const g = t.adGroup
    if (rulesOfGroup.has(g.id)) return rulesOfGroup.get(g.id)!
    const c = g.campaign
    const reach = rules.filter((r) => ruleMatchesScope({
      scopeMarketplace: r.scopeMarketplace,
      scopePortfolioId: r.scopePortfolioId,
      scopeCampaignId: r.scopeCampaignId,
      scopeProductIds: r.scopeProductId ? expandedOf.get(r.scopeProductId) ?? [r.scopeProductId] : null,
      assignedCampaignIds: assigned.get(r.id) ?? null,
    }, { marketplace: c.marketplace, campaignId: c.id, portfolioId: c.portfolioId, productIds: productsOf.get(g.id) ?? [] }))
    const out = rulesWritingOn(reach, { rankHeld: rankHeld(c.id) }).map((r) => ({ id: r.id, name: r.name }))
    rulesOfGroup.set(g.id, out)
    return out
  }

  // Hourly plans: an enabled schedule (its group's name), or a product plan's campaign (rank-release.service.ts rankOwnedCampaignIds).
  const rankOn = rankDefend?.mode === 'AUTO'
  const scheduleOf = new Map<string, ScheduleRow>(schedules.map((s) => [s.campaignId, s] as const))
  const productPlanOf = new Map<string, string>()
  for (const p of productPlans) {
    for (const d of (p.lastSummary as { decisions?: Array<{ campaignId?: string }> } | null)?.decisions ?? []) if (d?.campaignId && !productPlanOf.has(d.campaignId)) productPlanOf.set(d.campaignId, p.id)
  }
  // Held by Rank & Dayparting whether or not its engine runs (rank-release.service.ts rankOwnedCampaignIds): a goal-mode
  // schedule or a product plan's campaign. A rank-defense raise leaves it.
  const rankHeld = (campaignId: string) => {
    const s = scheduleOf.get(campaignId)
    return (!!s && isGoalMode(s.windows, s.defaultTargetKey)) || productPlanOf.has(campaignId)
  }
  const planFor = (campaignId: string): { id: string; name: string } | null => {
    const s = scheduleOf.get(campaignId)
    if (s) return !isGoalMode(s.windows, s.defaultTargetKey) || rankOn ? { id: s.group?.id ?? s.id, name: s.group?.name ?? s.name } : null
    const planId = productPlanOf.get(campaignId)
    return planId && rankOn ? { id: planId, name: 'Hourly plan' } : null
  }

  // Engines: a running autopilot plan holds the campaign from auto-bid; at Auto it writes the bids itself.
  const autopilotOf = (campaignId: string) => autopilots.find((p) => Array.isArray(p.campaignIds) && (p.campaignIds as unknown[]).map(String).includes(campaignId)) ?? null
  // Auto-bid's reach without its target check, then the target the Owner set (campaign, ads strategy, account default).
  const autoBidOn = autoBid?.mode === 'AUTO'
  const autoBidReach = (t: TargetRow) => {
    const c = t.adGroup.campaign
    return autoBidOn && c.adProduct === 'SPONSORED_PRODUCTS' && !scheduleOf.has(c.id) && !productPlanOf.has(c.id) && !autopilotOf(c.id)
  }
  const candidates = targets.filter((t) => autoBidReach(t) && !brainOwned.has(t.adGroup.campaign.id))
  const withTarget = await ownerTargetGroups(candidates)

  return {
    // As the brain reads its pin (bid-brain/facts.ts): the campaign's pin, then a person's hold, then auto-undo's own.
    autoUndoPin: (t: TargetRow) => !t.adGroup.campaign.pinBids && !heldTargets.has(t.id) && !heldCampaigns.has(t.adGroup.campaign.id)
      && (undoPinned.has(t.id) || undoPinned.has(`campaign:${t.adGroup.campaign.id}`)),
    of: (t: TargetRow): BidOwnerFacts => {
      const g = t.adGroup
      const c = g.campaign
      const autopilot = autopilotOf(c.id)
      const engine = autopilot
        ? (autopilot.autonomy === 'AUTO' ? { id: autopilot.id, name: autopilot.name, leavesPersonBids: false } : null)
        : autoBidReach(t) && withTarget.has(g.id) ? { id: AUTO_BID_OWNER_ID, name: 'Auto-bid', leavesPersonBids: true } : null
      return {
        pinned: c.pinBids,
        personHold: heldTargets.has(t.id) || heldCampaigns.has(c.id) || personBids.has(t.id),
        allowlisted: c.liveBidWritesEnabled,
        running: t.status === 'ENABLED' && g.status === 'ENABLED' && c.status === 'ENABLED',
        brain: brainOwned.has(c.id) ? { stopped: !!kills.get(c.id)?.bids } : null,
        rules: rulesFor(t),
        plan: planFor(c.id),
        engine,
      }
    },
  }
}

/** The ad groups (of these targets) with a target ACoS the Owner set: the campaign's own, the ads strategy's, the account default. */
async function ownerTargetGroups(targets: readonly TargetRow[]): Promise<Set<string>> {
  if (!targets.length) return new Set()
  const { byCampaign, accountDefaultPct } = await readOwnerTargets([...new Set(targets.map((t) => t.adGroup.campaign.id))])
  const subject = (t: TargetRow) => ({ adGroupId: t.adGroup.id, campaignTargetAcos: byCampaign.get(t.adGroup.campaign.id) })
  const without = targets.filter((t) => !configuredTargetAcos(subject(t), { explicitTargetAcos: undefined, accountDefaultPct }))
  let strategyByAdGroup: Map<string, StrategyTarget> | null = null
  if (without.length) {
    const read = await strategyBidReader().forAdGroups([...new Map(without.map((t) => [t.adGroup.id, { adGroupId: t.adGroup.id, marketplace: t.adGroup.campaign.marketplace }])).values()])
    strategyByAdGroup = new Map([...read].flatMap(([id, e]) => (e.target ? [[id, e.target] as const] : [])))
  }
  return new Set(targets.filter((t) => configuredTargetAcos(subject(t), { explicitTargetAcos: undefined, accountDefaultPct, strategyByAdGroup })).map((t) => t.adGroup.id))
}

// ── Changes, decisions, names ──────────────────────────────────────────────────────────────────────────────────────

/** Each bid's changes of 30 days from the action log (oldest first), and the names its writers go by. */
async function loadChanges(ids: readonly string[], now: Date): Promise<{ byTarget: Map<string, BidChange[]>; names: AuthorNames }> {
  const byTarget = new Map<string, BidChange[]>()
  const names = { rules: new Map<string, string>(), plans: new Map<string, { id: string; name: string }>(), autopilots: new Map<string, string>() }
  if (!ids.length) return { byTarget, names }
  const since = new Date(now.getTime() - CHANGES_DAYS * DAY)
  // A write that never reached Amazon (refused, failed, cancelled, or superseded by a newer one before it was sent)
  // changed nothing there: left out (agents/tools/approval.tools.ts reads the same statuses as not sent).
  // R4 — a rule's approved ask that was undone is no change: its write and the undo (evidence.undoOf) fold away.
  const read = await prisma.$queryRaw<Array<{ id: string; targetId: string; at: Date; actor: string | null; fromCents: string | null; toCents: string | null; layer: string | null; undoOf: string | null }>>(Prisma.sql`
    SELECT l.id, l."entityId" AS "targetId", l."createdAt" AS at, l."userId" AS actor,
           l."payloadBefore" ->> 'bidCents' AS "fromCents", l."payloadAfter" ->> 'bidCents' AS "toCents",
           l.evidence -> 'brain' ->> 'layer' AS layer, l.evidence ->> 'undoOf' AS "undoOf"
      FROM "AdvertisingActionLog" l
     WHERE l."entityType" = 'AD_TARGET'
       AND l."entityId" = ANY(${[...ids]}::text[])
       AND l."actionType" = ANY(${BID_CHANGE_TYPES}::text[])
       AND l."createdAt" >= ${since}
       AND COALESCE(l."amazonResponseStatus", '') NOT IN ('FAILED', 'SKIPPED', 'CANCELLED', 'SUPERSEDED')
     ORDER BY l."entityId", l."createdAt", l.id`)
  const rows = withoutUndonePairs(read)
  const ruleIds = new Set<string>()
  const planIds = new Set<string>()
  const autopilotIds = new Set<string>()
  for (const r of rows) {
    const from = Number(r.fromCents)
    const to = Number(r.toCents)
    if (r.fromCents == null || r.toCents == null || !Number.isFinite(from) || !Number.isFinite(to) || Math.round(from) === Math.round(to)) continue
    const list = byTarget.get(r.targetId) ?? []
    list.push({ at: r.at.toISOString(), from: Math.round(from), to: Math.round(to), actor: r.actor, layer: r.layer })
    byTarget.set(r.targetId, list)
    const plan = /^automation:(?:automation:)*(?:rank-defend|rank-plan|dayparting)-(.+)$/.exec(r.actor ?? '')
    const autopilot = /^automation:(?:automation:)*autopilot-(.+)$/.exec(r.actor ?? '')
    const writer = classifyActor(r.actor)
    if (plan) planIds.add(plan[1])
    else if (autopilot) autopilotIds.add(autopilot[1])
    else if (writer.kind === 'rule-candidate') ruleIds.add(writer.ruleId)
  }
  const [rules, schedules, plans, autopilots] = await Promise.all([
    ruleIds.size ? prisma.automationRule.findMany({ where: { id: { in: [...ruleIds] } }, select: { id: true, name: true } }) : [],
    planIds.size ? prisma.adSchedule.findMany({ where: { id: { in: [...planIds] } }, select: { id: true, name: true, group: { select: { id: true, name: true } } } }) : [],
    planIds.size ? prisma.productRankPlan.findMany({ where: { id: { in: [...planIds] } }, select: { id: true } }) : [],
    autopilotIds.size ? prisma.autopilotPlan.findMany({ where: { id: { in: [...autopilotIds] } }, select: { id: true, name: true } }) : [],
  ])
  for (const r of rules) names.rules.set(r.id, r.name)
  // As the owner names a plan (loadOwnerFacts planFor): its group's id and name where it has one.
  for (const s of schedules) names.plans.set(s.id, { id: s.group?.id ?? s.id, name: s.group?.name ?? s.name })
  for (const p of plans) names.plans.set(p.id, { id: p.id, name: 'Hourly plan' })
  for (const a of autopilots) names.autopilots.set(a.id, a.name)
  return { byTarget, names }
}

/** Each bid's newest bid-brain decision of the last 48 hours. */
async function loadBrainDecisions(ids: readonly string[], now: Date): Promise<Map<string, { action: string; layer: string; goalBidCents: number | null }>> {
  if (!ids.length) return new Map()
  const since = new Date(now.getTime() - BRAIN_DECISION_HOURS * 3_600_000)
  const rows = await prisma.$queryRaw<Array<{ targetId: string; action: string; layer: string; goalBidCents: number | null }>>(Prisma.sql`
    SELECT DISTINCT ON (d."targetId") d."targetId", d.action, d.layer, d."goalBidCents"
      FROM "BidBrainDecision" d
     WHERE d."targetId" = ANY(${[...ids]}::text[]) AND d."createdAt" >= ${since}
     ORDER BY d."targetId", d."createdAt" DESC, d.id DESC`)
  return new Map(rows.map((r) => [r.targetId, { action: r.action, layer: r.layer, goalBidCents: r.goalBidCents == null ? null : Number(r.goalBidCents) }]))
}

/** Portfolio names by Amazon's portfolio id (Campaign.portfolioId), the newest row where a profile repeats one. */
async function portfolioNames(externalIds: readonly string[]): Promise<Map<string, string>> {
  if (!externalIds.length) return new Map()
  const rows = await prisma.amazonAdsPortfolio.findMany({ where: { externalPortfolioId: { in: [...externalIds] } }, select: { externalPortfolioId: true, name: true }, orderBy: { updatedAt: 'asc' } })
  return new Map(rows.map((r) => [r.externalPortfolioId, r.name]))
}

/** The campaign's own budget currency; the column's default is EUR (ads-tool-guards.ts campaignCurrency). */
const campaignCurrency = (c: { dailyBudgetCurrency: string | null }) => c.dailyBudgetCurrency?.trim().toUpperCase() || 'EUR'

/**
 * The currency Amazon bills each market's ads account in: the profile the write gate serves the market with
 * (adsProfilesForMarkets), its currency as every ads report reads it (adsProfileCurrency: the stored profile, discovery,
 * Amazon's checked market table). A market with no profile or no known currency is left out: the campaign's own answers.
 */
async function marketCurrencies(markets: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!markets.length) return out
  try {
    const [{ adsProfilesForMarkets }, { adsProfileCurrency }] = await Promise.all([import('./ads-profile-resolver.js'), import('./ads-profile-facts.service.js')])
    const profiles = await adsProfilesForMarkets(markets)
    await Promise.all(markets.map(async (market) => {
      const profileId = profiles.get(market)?.profileId
      const found = profileId ? await adsProfileCurrency(profileId, market).catch(() => null) : null
      if (found) out.set(market, found.currencyCode)
    }))
  } catch (err) {
    // The profile read failed: every row says its campaign's own currency.
    logger.warn('[bid-rows] the ads profiles\' currency could not be read; each bid says its campaign\'s own', { error: err instanceof Error ? err.message : String(err) })
  }
  return out
}

// ── KAPI-B — a keyword's own goal and max, and whether the bid brain runs it ────────────────────────────────────────

/** The row's `goal` from what the keyword holds of its own: null with no goal, share target or max of its own. Pure. */
export function goalOf(own: KeywordOwnRead | undefined, author: (actor: string | null) => ChangeAuthor): BidRow['goal'] {
  if (!own || (!own.acos && !own.tos && !own.max)) return null
  const newest = [own.provenance.acos, own.provenance.tos, own.provenance.max]
    .filter((p): p is NonNullable<typeof p> => !!p && !!p.at)
    .sort((a, b) => b.at!.localeCompare(a.at!))[0]
  return { acosPct: own.acos?.pct ?? null, tosPct: own.tos?.pct ?? null, maxCents: own.max?.cents ?? null, by: author(newest?.by ?? null), at: newest?.at ?? '' }
}

/** What decides a row's Auto / Manual beyond its owner facts (loadKeywordAuto). */
export interface KeywordAutoFacts {
  /** The bid brain owns the campaign now (bid-brain/live.ts); `stopped`: the Owner's kill switch on its bids. */
  brain: { stopped: boolean } | null
  /** The campaign's BidBrainEnrollment mode (SHADOW, LIVE, HELD); null: not under the bid brain. */
  enrollment: string | null
  pinned: boolean
  /** The Owner's lock of the keyword's bid or its ad group's, as its one line (keywordLockWhy), else null. */
  lock: string | null
  /** A person's hold on the whole campaign. */
  campaignHold: boolean
  /** A person's hold on this keyword: `until` null = Manual (no end). */
  targetHold: { until: Date | null } | null
  /** A person's bid of the last 60 days the brain still leaves (not handed back since). */
  personBid: boolean
  running: boolean
}

const day = (d: Date) => d.toISOString().slice(0, 10)

/**
 * R2 — who sets a bid the brain does not run, in one line: the row's own owner (resolveBidOwner, the same answer as `owner`),
 * never another writer of it. An engine is "an engine" (never its old name), and a campaign the brain is enrolled on but does
 * not run says the brain only watches it. Pure.
 */
export function ownerWhy(owner: Pick<BidWriterRef, 'kind' | 'name'>, f: { allowlisted: boolean; enrolled: boolean }): string {
  const watches = f.enrolled ? ': the brain only watches this campaign' : ''
  switch (owner.kind) {
    case 'PERSON': return `You set this bid${watches || ', not the brain'}`
    case 'RULE': return `The rule "${owner.name}" sets it${watches}`
    case 'PLAN': return `${owner.name && owner.name.toLowerCase() !== 'hourly plan' ? `The hourly plan "${owner.name}"` : 'The hourly plan'} sets it${watches}`
    case 'ENGINE': return `An engine sets it${watches}`
    case 'BRAIN': return 'The brain sets it'
    default: return !f.allowlisted ? 'Live bid writes are off for this campaign: no engine changes its bids'
      : f.enrolled ? 'Nobody sets this bid: the brain only watches this campaign' : 'No engine runs this campaign'
  }
}

/**
 * KAPI-B — a row's Auto / Manual and its one line. AUTO / MANUAL only where the bid brain owns the campaign: a person's hold
 * of any kind makes it MANUAL (the brain leaves it), else AUTO (the line then names a kill switch, auto-undo's pin or a
 * pause that holds the brain back). Elsewhere NONE, the line naming who sets the bid instead: R2 — the row's `owner`
 * (ownerWhy), so the line and the owner chip never give two answers. Pure.
 */
export function autoOf(k: KeywordAutoFacts, f: { allowlisted: boolean; owner: Pick<BidWriterRef, 'kind' | 'name'> }, autoUndoPin = false): Pick<BidRow, 'auto' | 'autoWhy'> {
  if (!k.brain || !f.allowlisted) return { auto: 'NONE', autoWhy: ownerWhy(f.owner, { allowlisted: f.allowlisted, enrolled: !!k.enrollment }) }
  if (k.pinned) return { auto: 'MANUAL', autoWhy: 'Every bid of this campaign is locked (pinned bids)' }
  if (k.lock) return { auto: 'MANUAL', autoWhy: k.lock }
  if (k.campaignHold) return { auto: 'MANUAL', autoWhy: 'You hold every bid of this campaign' }
  if (k.targetHold) return { auto: 'MANUAL', autoWhy: k.targetHold.until ? `You hold this bid until ${day(k.targetHold.until)}` : 'You hold this bid (Manual)' }
  if (k.personBid) return { auto: 'MANUAL', autoWhy: 'You set this bid in the last 60 days: the brain leaves it' }
  // R2 — a paused keyword before the brain's own holds, as resolveBidOwner reads it (nobody sets a bid that enters no auction).
  if (!k.running) return { auto: 'AUTO', autoWhy: 'Paused: the brain moves no bid that enters no auction' }
  if (k.brain.stopped) return { auto: 'AUTO', autoWhy: 'The bid brain is stopped on this campaign\'s bids (kill switch)' }
  if (autoUndoPin) return { auto: 'AUTO', autoWhy: 'Auto-undo holds this bid for now: it put back a change of the brain' }
  return { auto: 'AUTO', autoWhy: null }
}

/** The person holds the brain reads (bid-brain/facts.ts) — what makes a keyword Manual. */
const MANUAL_HOLD_KINDS = ['PIN', 'PERSON', 'CLAUDE']

/**
 * R2 — the Owner's lock of a keyword's bid (ref target:<id>) or its ad group's (adGroup:<id>) in the page's words: it is the
 * person's ("You", as the owner chip says), never a raw actor or the override's own terms. Null without a lock. Pure.
 */
export function keywordLockWhy(lock: { ref: string } | null | undefined): string | null {
  if (!lock) return null
  return keywordRefTarget(lock.ref) ? 'You locked this keyword\'s bid: the brain leaves it' : 'You locked the bids of its ad group: the brain leaves them'
}

/**
 * KAPI-B — each keyword's own goal and max (bid-brain/load.ts loadKeywordOwn, the brain's own read) and the facts of its
 * Auto / Manual: the brain's ownership and kill switch, the enrollment, a person's holds (a no-end one is Manual), his bid
 * of the last 60 days not handed back since (bid-grid.service.ts personBidTargetIds, the brain's own read), the Owner's lock.
 */
async function loadKeywordAuto(targets: readonly KeywordAutoTarget[], campaignIds: string[], now: Date): Promise<{
  own: Map<string, KeywordOwnRead>
  autoOf: (t: KeywordAutoTarget, facts: BidOwnerFacts, owner: BidWriterRef, autoUndoPin: boolean) => Pick<BidRow, 'auto' | 'autoWhy'>
  brainProductOf: (campaignId: string) => string | null
}> {
  const none = !campaignIds.length
  const ids = targets.map((t) => t.id)
  const [own, brainOwned, enrollments, holds, personBids, brainProducts] = await Promise.all([
    loadKeywordOwn(targets.map((t) => ({ id: t.id, adGroupId: t.adGroup.id, campaignId: t.adGroup.campaign.id, market: strategyMarket(t.adGroup.campaign.marketplace) })), { productsOf: campaignFamilies }),
    brainOwnedCampaignIds(campaignIds),
    none ? [] : prisma.bidBrainEnrollment.findMany({ where: { campaignId: { in: campaignIds } }, select: { campaignId: true, mode: true } }),
    none ? [] : prisma.bidHold.findMany({
      where: { campaignId: { in: campaignIds }, endedAt: null, kind: { in: MANUAL_HOLD_KINDS }, OR: [{ until: null }, { until: { gt: now } }] },
      select: { campaignId: true, targetId: true, until: true },
    }),
    none ? new Set<string>() : personBidTargetIds({ targetIds: ids, now }),
    none ? new Map<string, string>() : brainProductsOf(campaignIds),
  ])
  const kills = brainOwned.size ? await campaignKills([...brainOwned], ['bids']) : new Map()
  const modeOf = new Map<string, string>(enrollments.map((e: { campaignId: string; mode: unknown }) => [e.campaignId, String(e.mode)] as const))
  const campaignHeld = new Set(holds.filter((h) => !h.targetId).map((h) => h.campaignId))
  // A no-end hold (Manual) before a dated one: the keyword is Manual until handed back.
  const targetHold = new Map<string, { until: Date | null }>()
  for (const h of holds) {
    if (!h.targetId) continue
    const seen = targetHold.get(h.targetId)
    if (!seen || h.until == null || (seen.until != null && h.until > seen.until)) targetHold.set(h.targetId, { until: h.until })
  }
  return {
    own,
    brainProductOf: (campaignId) => brainProducts.get(campaignId) ?? null,
    autoOf: (t, facts, owner, autoUndoPin) => {
      const c = t.adGroup.campaign
      return autoOf({
        brain: brainOwned.has(c.id) ? { stopped: !!kills.get(c.id)?.bids } : null,
        enrollment: modeOf.get(c.id) ?? null,
        pinned: c.pinBids,
        lock: keywordLockWhy(own.get(t.id)?.provenance.lock ?? null),
        campaignHold: campaignHeld.has(c.id),
        targetHold: targetHold.get(t.id) ?? null,
        personBid: personBids.has(t.id),
        running: facts.running,
      }, { allowlisted: facts.allowlisted, owner }, autoUndoPin)
    },
  }
}

type KeywordAutoTarget = TargetRow

/**
 * KAPI-B — campaignId → the product whose brain runs it: the one family the campaign advertises alone (brain/ownership.ts
 * resolveCampaignOwnership, set-ads-brain's own read) with an AdsBrainEnrollment in the campaign's market. Campaigns with
 * none are left out.
 */
async function brainProductsOf(campaignIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const owners = await resolveCampaignOwnership(campaignIds)
  const own = [...owners.values()].flatMap((o) => (o.owner.kind === 'product' && o.market ? [{ campaignId: o.campaignId, productId: o.owner.productId, market: o.market }] : []))
  if (!own.length) return out
  const enrolled = await prisma.adsBrainEnrollment.findMany({
    where: { productId: { in: [...new Set(own.map((o) => o.productId))] }, marketplace: { in: [...new Set(own.map((o) => o.market))] } },
    select: { productId: true, marketplace: true },
  })
  const key = new Set(enrolled.map((e) => `${e.productId}|${e.marketplace}`))
  for (const o of own) if (key.has(`${o.productId}|${o.market}`)) out.set(o.campaignId, o.productId)
  return out
}

/** The one product family each campaign advertises (Product.parentId ?? Product.id), null when several or none (D2). */
async function campaignFamilies(campaignIds: string[]): Promise<Map<string, string | null>> {
  const ads = await prisma.adProductAd.findMany({
    where: { adGroup: { campaignId: { in: campaignIds } }, productId: { not: null } },
    select: { productId: true, product: { select: { parentId: true } }, adGroup: { select: { campaignId: true } } },
  })
  const families = new Map<string, Set<string>>()
  for (const a of ads) families.set(a.adGroup.campaignId, (families.get(a.adGroup.campaignId) ?? new Set()).add(a.product?.parentId ?? a.productId!))
  return new Map(campaignIds.map((id) => { const f = families.get(id); return [id, f && f.size === 1 ? [...f][0] : null] }))
}
