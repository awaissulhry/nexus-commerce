/**
 * Negative Targeting page (NREAD, 2026-10-11) — GET /api/advertising/waste/rows (and /rows/ids): every keyword and
 * target of ours and every shopper's search term in one ad group, each with one owner, one verb, its waste test over the
 * late-order-safe window, its numbers, 90 days, 8 weeks of spend, the days out of stock left out, what waits and what
 * was skipped. Read only: nothing here writes, asks or sends.
 *
 * Facts, each read where its writer keeps it (one fixed number of reads per answer, whatever the number of rows):
 *   places       the market's Sponsored Products campaigns that are not archived (pooling, negatives, "still serves in");
 *                rows only from places that run (campaign and ad group ENABLED): a paused campaign's keywords "ENABLED"
 *                are noise (4-neg-live.md §5.1), archived duplicates never show
 *   products     the brain's campaign ownership (brain/ownership.ts): one family, several (shared), or none
 *   search terms AmazonAdsSearchTerm by EXTERNAL campaign and ad-group ids (a local id there joins nothing:
 *                negatives-attention.service.ts), summed in SQL per term, ad group and keyword that bought it (`via` =
 *                matchedKeywordId / matchedTargetId → our AdTarget.externalTargetId): the 30/60/90-day windows, 90 days
 *                and 8 weeks of spend — never shipped per day
 *   keywords     AmazonAdsDailyPerformance AD_TARGET summed in SQL per target; none at all → "no data" (d: null)
 *   memo         one market's facts per business, reused 45 s (marketWasteFacts); no market = every market with Amazon
 *                ads, one market's facts each, merged (money stays per row and per currency); one row's detail reads only
 *                its words and its ad group (a focus)
 *   stock        StockoutEvent of the place's advertised products (pure.ts outOfStockDays)
 *   target CPA   the product's pooled conversion rate and order value (product → market, bid-brain/estimator.ts) ×
 *                its target ACoS (the ads strategy per product, else the account default); the strategy's negate group
 *   owners       NWRITE's hold and negativeOrigin (waste/hold.ts), AdsBrainNegative, AdsBrainHarvest sources,
 *                the action log (state changes, negative creates and retires), approvals and rule cards that wait, the
 *                brain's enrollment (negatives lever), the rules at Ask me / Auto by the evaluator's own scope matcher
 * Totals come from the same rows the table pages (pure.ts totalsOf, Bid audit M1).
 */
import { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { ruleMatchesScope } from '../../automation-rule-scope.js'
import { labelFor } from '../bid-grid.service.js'
import { estimate } from '../bid-brain/estimator.js'
import { LEGACY_WORKSPACE_ID, workspaceContext } from '@nexus/database/workspace-context'
import { resolveAutonomy } from '../ads-autonomy.js'
import { producedActionTypes } from '../ads-rule-adapter.service.js'
import { resolveAssignedCampaignIds } from '../ads-rule-scope-resolver.js'
import { expandProductScope } from '../ads-scope-reach.js'
import { strategyMarket } from '../ads-strategy/bids.js'

/**
 * A market as this page compares it: Amazon's code (IT, DE — strategyMarket also reads SP-API ids and AMAZON_XX), else
 * the stored code itself in capitals, as every other ads read takes a market (a code Nexus does not know still names its
 * own campaigns). Null only for an empty value.
 */
export const marketCode = (value: string | null | undefined): string | null => strategyMarket(value) ?? (value?.trim() ? value.trim().toUpperCase() : null)
import { openStrategy, type EffectiveStrategy } from '../ads-strategy/effective.js'
import { sourceLabel } from '../ads-strategy/terms.js'
import { readOwnerTargets } from '../ads-target-acos-resolver.js'
import { protectedTermHit, type ProtectedTerm } from '../ads-negation-policy.js'
import { productFamily, resolveCampaignOwnership, type CampaignOwnership } from '../brain/ownership.js'
import { termsDue } from '../brain/terms-shadow.js'
import { keptLabel, negativeKeptBy, negativeOwner, NO_OWNER, ownerOfActor, refOfOwner, rowOwner, type OwnerNames } from './owner.js'
import {
  adGroupHref, campaignHref, compareRows, D90_DAYS, DAY_MS, dayIndex, isAsinText, isoDay, keywordRowId, kindMatches,
  LAST_CHANGE_DAYS, MAX_IDS, negativeBlocksTerm, negativeMatch, outOfStockDays, ownerMatches, pageOf, portfolioHref,
  productHref, READ_DAYS, showMatches, SPARK_WEEKS, targetMatch, termKeyOf, termRowId, textMatches, totalsOf, WASTE_WINDOW_DAYS,
  wasteWindow, CLASH_LABELS, negRowId, withAskCounts,
  type KindFilter, type Match, type Owner, type Verb, type Ref, type RowNumbers, type RowState, type ShowFilter, type WasteCriteria,
  type WasteRow, type WasteTotals,
} from './pure.js'
import { barFor, wasteTest, xCpaOf, type OwnerBar, type ProductFacts } from './test.js'
import { verbFor } from './verb.js'
import { HOLD_SELECT, holdOf } from './hold.js'
import { activeSkips } from './skip.js'
import { buildStoppedRows, filterStopped } from './stopped.js'
import { NEGATIVE_ORIGINS } from '../ads-negative-kw.service.js'

// ── The query ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface WasteScope {
  channel?: 'AMAZON'
  market?: string | null
  portfolioId?: string | null
  productId?: string | null
  campaignId?: string | null
  adGroupId?: string | null
}

export interface WasteQuery extends WasteScope {
  kind?: KindFilter
  show?: ShowFilter
  owner?: string | null
  q?: string | null
  sort?: string | null
  page?: number | null
  pageSize?: number | null
}

export interface WasteFreshness {
  /** The newest search-term day Nexus holds in scope; null: none. */
  searchTermsThrough: string | null
  /** The newest keyword day. */
  keywordsThrough: string | null
  readAt: string
}

export type WasteAnswer =
  | { ok: true; rows: WasteRow[]; total: number; page: number; pageSize: number; totals: WasteTotals; criteria: WasteCriteria; freshness: WasteFreshness }
  | { ok: false; status: 400 | 404; error: string }

export type WasteIdsAnswer = { ok: true; ids: string[]; total: number; truncated: boolean } | { ok: false; status: 400 | 404; error: string }

// ── The hold, the author, the skips (NWRITE's columns: waste/hold.ts, waste/skip.ts) ────────────────────────────

export interface HoldFacts { at: Date; by: string | null; until: Date | null; reason: string | null }
export interface SkipFacts { until: Date; by: string | null; at: Date | null }

/** Every skip written since `since` (ended ones too): the history's "skipped" rows. */
export async function readSkipRows(since: Date): Promise<Array<{ rowKey: string; until: Date; by: string | null; at: Date | null; reason: string | null; endedAt: Date | null; endedBy: string | null }>> {
  return prisma.adsWasteSkip.findMany({ where: { at: { gte: since } }, select: { rowKey: true, until: true, by: true, at: true, reason: true, endedAt: true, endedBy: true }, orderBy: { at: 'desc' }, take: 500 })
}

// ── The facts ───────────────────────────────────────────────────────────────────────────────────────────────────

interface CampaignFact {
  id: string; name: string; market: string; status: string; portfolioId: string | null; externalCampaignId: string | null
  dailyBudgetCurrency: string | null; live: boolean
}
interface AdGroupFact {
  id: string; name: string; campaignId: string; externalAdGroupId: string | null; status: string; live: boolean; productIds: string[]
  /**
   * The first day (day index) the place served: its first impression on record (the ad group's own row, its keywords' or
   * its product ads'), else its campaign's, else the campaign's start date; null: nothing known (never held as new).
   * Never AdGroup.createdAt: that is when Nexus first synced it, and a re-sync would make every place "0 days old".
   */
  firstDay: number | null
}
export interface TargetFact {
  id: string; adGroupId: string; kind: string; expressionType: string; expressionValue: string; status: string
  isNegative: boolean; negativeLevel: string | null; externalTargetId: string | null; createdAt: Date; retiredAt: Date | null
}

/** The windows a row's test may read (the page's 60 days; the ads strategy's negate group may name 30 or 90). */
export const WINDOWS = [30, 60, 90] as const
export type WindowDays = (typeof WINDOWS)[number]
export const windowOf = (days: number): WindowDays => (WINDOWS as readonly number[]).includes(days) ? days as WindowDays : 60

/**
 * One window's sums, summed in SQL (never shipped per day): clicks, impressions and spend from the window's first day to
 * `clicksThrough` with the place's days out of stock left out; orders and sales from its first day to today — the
 * days pure.ts wasteWindow and outOfStockDays name (passed to the query as numbers, so the rule stays theirs).
 */
export interface WindowSums { impressions: number; clicks: number; spendCents: number; orders: number; salesCents: number }
const NO_SUMS: WindowSums = Object.freeze({ impressions: 0, clicks: 0, spendCents: 0, orders: 0, salesCents: 0 })
const addSums = (a: WindowSums, b: WindowSums): WindowSums => ({ impressions: a.impressions + b.impressions, clicks: a.clicks + b.clicks, spendCents: a.spendCents + b.spendCents, orders: a.orders + b.orders, salesCents: a.salesCents + b.salesCents })

/** One search term in one ad group: its sums (all the ways it was bought), and per keyword that bought it. */
interface TermPlaceFacts {
  adGroupId: string; campaignId: string; key: string; text: string
  matchType: string | null
  /** Clicks over the whole read (93 days): a row needs one. */
  clicks93: number
  /** Clicks, and clicks + impressions, in the page's default window, every day (who still serves it; the campaign rule). */
  clicksDefault: number
  servedDefault: number
  win: Record<WindowDays, WindowSums>
  d90: { clicks: number; orders: number; spendCents: number }
  spark: number[]
  /** Per keyword or target that bought it (Amazon's external id): its 93-day clicks (who bought it most) and orders in the default window. */
  vias: Map<string, ViaSums>
}

/** One keyword's share of a search term in one place: who bought it most, what sold, and its own sums (a keyword with no
 *  keyword report of its own reads its numbers from the search terms it bought). */
interface ViaSums { clicks: number; orders: number; win60: WindowSums; d90: { clicks: number; orders: number; spendCents: number }; spark: number[] }

/** One keyword or target of ours, summed in SQL. */
interface KeywordAgg {
  win: WindowSums
  d90: { clicks: number; orders: number; spendCents: number }
  spark: number[]
  /** Spend in the 30 days before its stop (Stopped view); null: no stop, or those days are older than Nexus keeps. */
  spendBefore: number | null
}
export interface ChangeFact {
  id: string; entityId: string; actionType: string; actor: string | null; executionId: string | null; at: Date
  status: string | null; rolledBackAt: Date | null; before: Record<string, unknown>; after: Record<string, unknown>; evidence: unknown
}
interface WaitingFact { approvalId: string; by: Owner; at: Date; expiresAt: Date | null }
interface RuleFact { id: string; name: string; kind: 'pause' | 'negate'; scopeMarketplace: string | null; scopePortfolioId: string | null; scopeCampaignId: string | null; scopeProductId: string | null; scopeAdGroupId: string | null }

export interface WasteFacts {
  now: Date
  markets: string[]
  /** null: the whole market was read; set: only what one row's detail needs (its words market-wide, its ad group). */
  focus: WasteFocus | null
  campaigns: Map<string, CampaignFact>
  adGroups: Map<string, AdGroupFact>
  adGroupOfExt: Map<string, string>
  ownership: Map<string, CampaignOwnership>
  products: Map<string, { id: string; name: string }>
  portfolioNames: Map<string, string>
  targets: TargetFact[]
  positivesByGroup: Map<string, TargetFact[]>
  /** Standing negatives (not archived, not retired) by ad group, and campaign-level ones by campaign. */
  negByGroup: Map<string, TargetFact[]>
  negByCampaign: Map<string, TargetFact[]>
  targetByExt: Map<string, TargetFact[]>
  targetById: Map<string, TargetFact>
  termPlaces: Map<string, TermPlaceFacts>
  /** The same places by the term's words, by ad group and by campaign (no scan of every place per row). */
  placesByKey: Map<string, TermPlaceFacts[]>
  placesByGroup: Map<string, TermPlaceFacts[]>
  placesByCampaign: Map<string, TermPlaceFacts[]>
  keywords: Map<string, KeywordAgg>
  /** Spend of the words a standing negative blocks, in the 30 days before it was made (null: older than Nexus keeps). */
  negativeSpendBefore: Map<string, number | null>
  stock: Map<string, Set<number>>
  productFacts: Map<string, ProductFacts>
  marketFacts: Map<string, ProductFacts>
  negateBar: Map<string, OwnerBar>
  marketNegateBar: Map<string, OwnerBar | null>
  protections: Array<ProtectedTerm & { marketplace: string | null; campaignId: string | null }>
  brainProducts: Set<string>
  rules: RuleFact[]
  ruleProductScope: Map<string, string[]>
  ruleAssigned: Map<string, string[]>
  stateChanges: Map<string, ChangeFact[]>
  /** The newest delivered state change of each paused target, whenever it was (who paused it and when). */
  lastPause: Map<string, ChangeFact>
  negativeCreates: Map<string, ChangeFact>
  retires: ChangeFact[]
  brainReasons: Map<string, string>
  harvestSources: Set<string>
  harvestedAt: Map<string, number>
  waitingKw: Map<string, WaitingFact>
  waitingTerm: Array<{ fact: WaitingFact; adGroupId: string | null; campaignId: string | null; key: string }>
  holds: Map<string, HoldFacts>
  origins: Map<string, string>
  skips: Map<string, SkipFacts>
  names: OwnerNames
  currencyOf: Map<string, string>
  freshness: WasteFreshness
}

/** One row's detail reads only its words (market-wide: where they run and are blocked) and its own ad group. */
export interface WasteFocus { key: string; adGroupId: string }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
/** A data day in words ("7 Oct 2026"): the report's own day (UTC midnight), never shifted by a time zone. */
const dayWords = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(d)
const cents = (micros: unknown) => Math.round(Number(micros ?? 0) / 10_000)
const num = (v: unknown) => Number(v ?? 0)
const jsonObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})

/** Scope ids that are not this business's read as not found, as on the Bid page. */
export async function checkScope(s: WasteScope): Promise<{ ok: true; market: string | null; root: string | null } | { ok: false; status: 400 | 404; error: string }> {
  if (s.channel && s.channel !== 'AMAZON') return { ok: false, status: 400, error: 'Only Amazon is read here yet; eBay comes later (PLAN step 4).' }
  const market = s.market ? marketCode(s.market) : null
  if (s.market && !market) return { ok: false, status: 400, error: `market: ${s.market} is not a market code` }
  if (s.campaignId && !(await prisma.campaign.findUnique({ where: { id: s.campaignId }, select: { id: true } }))) return { ok: false, status: 404, error: `No campaign ${s.campaignId} in this business.` }
  if (s.adGroupId) {
    const g = await prisma.adGroup.findUnique({ where: { id: s.adGroupId }, select: { campaignId: true } })
    if (!g || (s.campaignId && g.campaignId !== s.campaignId)) return { ok: false, status: 404, error: `No ad group ${s.adGroupId} in this business${s.campaignId ? ' and campaign' : ''}.` }
  }
  if (s.portfolioId && !(await prisma.campaign.findFirst({ where: { portfolioId: s.portfolioId }, select: { id: true } }))) return { ok: false, status: 404, error: `No portfolio ${s.portfolioId} in this business.` }
  let root: string | null = null
  if (s.productId) {
    if (!(await prisma.product.findUnique({ where: { id: s.productId }, select: { id: true } }))) return { ok: false, status: 404, error: `No product ${s.productId} in this business.` }
    root = (await productFamily(s.productId))?.root ?? s.productId
  }
  return { ok: true, market, root }
}

// ── The memo: one market's facts per business, a short while ───────────────────────────────────────────────────

/** How long one market's facts are reused (ms). NEXUS_WASTE_FACTS_TTL_MS overrides; 0 = never reused. */
const factsTtl = () => {
  const v = Number(process.env.NEXUS_WASTE_FACTS_TTL_MS)
  return Number.isFinite(v) && v >= 0 ? v : 45_000
}
const factsMemo = new Map<string, { at: number; stamp: string; facts: Promise<WasteFacts> }>()

/** Forget every market's facts (a write on the page, a test). */
export function invalidateWasteFacts(): void { factsMemo.clear() }

/**
 * The business's last change to what a waste row shows, read cheaply on every read: the newest action-log row (every ads
 * write, its undo and the hold's own rows land there), approval asked or decided, rule card made, seen or decided, skip
 * made or ended, rule saved (its mode, archive). A reused copy is served only while this stamp has not moved, so our
 * own writes — through the page, Claude, the Approvals page or the shared Undo, on any API replica — show at once.
 */
export async function wasteChangeStamp(): Promise<string> {
  const rows = await prisma.$queryRaw<Array<{ stamp: string | null }>>(Prisma.sql`
    SELECT concat_ws('|',
      (SELECT max("createdAt") FROM "AdvertisingActionLog")::text,
      (SELECT max(GREATEST("requestedAt", COALESCE("decidedAt", "requestedAt"))) FROM "AgentApproval")::text,
      (SELECT max(GREATEST("createdAt", "lastSeenAt", COALESCE("decidedAt", "createdAt"))) FROM "AdsRuleSuggestion")::text,
      (SELECT max(GREATEST("at", COALESCE("endedAt", "at"))) FROM "AdsWasteSkip")::text,
      (SELECT max("updatedAt") FROM "AutomationRule")::text,
      (SELECT count(*) FROM "AdsWasteSkip")::text
    ) AS stamp`)
  return rows[0]?.stamp ?? ''
}

/**
 * One market's facts for this business, reused for NEXUS_WASTE_FACTS_TTL_MS (45 s by default) while nothing changed
 * (wasteChangeStamp): the Wasting, Stopped and History views, the tiles and select-all read the same load; a decide, an
 * apply, a skip, a rule's mode or an undo moves the stamp and the next read loads fresh. A change Nexus does not log
 * (a sync mirroring Amazon) shows within the TTL. Requests that come together share one load.
 */
export async function marketWasteFacts(market: string, now: Date = new Date()): Promise<WasteFacts> {
  const ttl = factsTtl()
  if (ttl <= 0) return loadWasteFacts(market, now)
  const key = `${workspaceContext()?.workspaceId ?? LEGACY_WORKSPACE_ID}|${market}`
  const stamp = await wasteChangeStamp()
  const hit = factsMemo.get(key)
  if (hit && hit.stamp === stamp && Date.now() - hit.at < ttl) return hit.facts
  const facts = loadWasteFacts(market, now)
  for (const [k, v] of factsMemo) if (Date.now() - v.at >= ttl) factsMemo.delete(k)
  factsMemo.set(key, { at: Date.now(), stamp, facts })
  facts.catch(() => factsMemo.delete(key))
  return facts
}

// ── The load ────────────────────────────────────────────────────────────────────────────────────────────────────

const WEEK_INDEXES = Array.from({ length: SPARK_WEEKS }, (_, i) => i)

/**
 * Every fact of one market (or, with `focus`, of one row's words and ad group). Nothing is shipped per day: the windows,
 * 90 days and the 8 weeks of spend are summed in SQL. Rows are scoped afterwards (buildWasteRows).
 */
export async function loadWasteFacts(market: string, now: Date = new Date(), focus: WasteFocus | null = null): Promise<WasteFacts> {
  const today = dayIndex(now)
  const readFromDay = today - (READ_DAYS - 1)
  const readFrom = new Date(readFromDay * DAY_MS)
  const markets = [market]
  const wins = Object.fromEntries(WINDOWS.map((d) => [d, wasteWindow(now, d)])) as Record<WindowDays, ReturnType<typeof wasteWindow>>
  const clicksThrough = dayIndex(wins[60].clicksThrough)
  const since = Object.fromEntries(WINDOWS.map((d) => [d, dayIndex(wins[d].since)])) as Record<WindowDays, number>
  const d90From = today - (D90_DAYS - 1)

  const campaignRows = await prisma.campaign.findMany({
    // Sponsored Products: the v1 discriminator, or a legacy row that names only its type (adProduct null, type SP).
    where: { status: { not: 'ARCHIVED' }, OR: [{ adProduct: 'SPONSORED_PRODUCTS' }, { adProduct: null, type: 'SP' }] },
    select: { id: true, name: true, marketplace: true, status: true, portfolioId: true, externalCampaignId: true, dailyBudgetCurrency: true, startDate: true },
  })
  const campaigns = new Map<string, CampaignFact>()
  for (const c of campaignRows) {
    const m = marketCode(c.marketplace)
    if (m !== market) continue
    campaigns.set(c.id, { id: c.id, name: c.name, market: m, status: String(c.status), portfolioId: c.portfolioId, externalCampaignId: c.externalCampaignId, dailyBudgetCurrency: c.dailyBudgetCurrency, live: String(c.status) === 'ENABLED' })
  }
  const campaignIds = [...campaigns.keys()]
  const [groupRows, ownership] = await Promise.all([
    campaignIds.length ? prisma.adGroup.findMany({
      where: { campaignId: { in: campaignIds }, status: { not: 'ARCHIVED' } },
      select: { id: true, name: true, campaignId: true, externalAdGroupId: true, status: true, productAds: { where: { status: { not: 'ARCHIVED' } }, select: { id: true, productId: true } } },
    }) : Promise.resolve([]),
    resolveCampaignOwnership(campaignIds),
  ])
  const adGroups = new Map<string, AdGroupFact>()
  const adGroupOfExt = new Map<string, string>()
  for (const g of groupRows) {
    const c = campaigns.get(g.campaignId)!
    adGroups.set(g.id, { id: g.id, name: g.name, campaignId: g.campaignId, externalAdGroupId: g.externalAdGroupId, status: String(g.status), live: c.live && String(g.status) === 'ENABLED', productIds: [...new Set<string>(g.productAds.filter((a) => a.productId).map((a) => String(a.productId)))], firstDay: null })
    if (g.externalAdGroupId) adGroupOfExt.set(`${c.externalCampaignId ?? ''}|${g.externalAdGroupId}`, g.id)
  }
  const groupIds = [...adGroups.keys()]
  const focusGroup = focus ? adGroups.get(focus.adGroupId) ?? null : null
  const retiredSince = new Date(now.getTime() - LAST_CHANGE_DAYS * DAY_MS)
  const targetRows = groupIds.length ? await prisma.adTarget.findMany({
    where: { adGroupId: { in: groupIds }, OR: [{ status: { not: 'ARCHIVED' }, retiredAt: null }, { isNegative: true, retiredAt: { gte: retiredSince } }] },
    select: { id: true, adGroupId: true, kind: true, expressionType: true, expressionValue: true, status: true, isNegative: true, negativeLevel: true, externalTargetId: true, createdAt: true, retiredAt: true, negativeOrigin: true, ...HOLD_SELECT },
  }) : []
  const targets: TargetFact[] = targetRows.map((t) => ({
    id: t.id, adGroupId: t.adGroupId, kind: t.kind, expressionType: t.expressionType, expressionValue: t.expressionValue, status: String(t.status),
    isNegative: t.isNegative, negativeLevel: t.negativeLevel, externalTargetId: t.externalTargetId, createdAt: t.createdAt, retiredAt: t.retiredAt,
  }))
  // NWRITE's hold (only one that holds now: holdOf) and each negative's stored author.
  const holds = new Map<string, HoldFacts>()
  const origins = new Map<string, string>()
  for (const t of targetRows) {
    const h = t.isNegative ? null : holdOf(t, now)
    if (h) holds.set(t.id, { at: h.at, by: t.keptPausedBy ?? null, until: h.until, reason: h.reason })
    if (t.negativeOrigin && (NEGATIVE_ORIGINS as readonly string[]).includes(t.negativeOrigin)) origins.set(t.id, t.negativeOrigin)
  }
  const targetById = new Map(targets.map((t) => [t.id, t]))
  const positivesByGroup = new Map<string, TargetFact[]>()
  const negByGroup = new Map<string, TargetFact[]>()
  const negByCampaign = new Map<string, TargetFact[]>()
  const targetByExt = new Map<string, TargetFact[]>()
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]) }
  for (const t of targets) {
    if (t.externalTargetId) push(targetByExt, t.externalTargetId, t)
    if (!t.isNegative) { push(positivesByGroup, t.adGroupId, t); continue }
    if (t.status === 'ARCHIVED' || t.retiredAt) continue
    if (t.negativeLevel === 'CAMPAIGN') push(negByCampaign, adGroups.get(t.adGroupId)!.campaignId, t)
    else push(negByGroup, t.adGroupId, t)
  }
  // With a focus: the keywords of its ad group and those with its words; the negatives of its place and those of its words.
  const negMatchOf = (t: TargetFact) => negativeMatch(t.kind, t.expressionType)
  const blocksFocus = (t: TargetFact) => !!focus && !!negMatchOf(t) && negativeBlocksTerm(focus.key, { text: t.expressionValue, match: negMatchOf(t)! })
  const inFocus = (t: TargetFact) => !focus || t.adGroupId === focus.adGroupId || (t.isNegative
    ? blocksFocus(t) || (t.negativeLevel === 'CAMPAIGN' && adGroups.get(t.adGroupId)?.campaignId === focusGroup?.campaignId)
    : termKeyOf(t.expressionValue) === focus.key)

  // Stock: the days each place counts as out of stock (pure.ts outOfStockDays), passed to the sums as (ad group, day).
  const adProductIds = [...new Set([...adGroups.values()].flatMap((g) => g.productIds))]
  const stockRows = adProductIds.length ? await prisma.stockoutEvent.findMany({
    where: { productId: { in: adProductIds }, startedAt: { lte: now }, OR: [{ endedAt: null }, { endedAt: { gte: readFrom } }] },
    select: { productId: true, startedAt: true, endedAt: true, marketplace: true },
  }) : []
  const stockEvents = stockRows.filter((e) => !e.marketplace || marketCode(e.marketplace) === market)
  const stock = new Map<string, Set<number>>()
  for (const g of adGroups.values()) if (g.productIds.length) {
    const days = outOfStockDays(g.productIds, stockEvents, readFromDay, today)
    if (days.size) stock.set(g.id, days)
  }
  const oosLocal: string[] = [], oosExt: string[] = [], oosDay: number[] = []
  for (const [groupId, days] of stock) for (const d of days) {
    oosLocal.push(groupId); oosExt.push(adGroups.get(groupId)!.externalAdGroupId ?? ''); oosDay.push(d)
  }

  // ── Search terms, summed per (campaign, ad group, query, keyword that bought it): EXTERNAL ids ──
  const extCampaigns = [...campaigns.values()].map((c) => c.externalCampaignId).filter((x): x is string => !!x)
  const campaignOfExt = new Map([...campaigns.values()].filter((c) => c.externalCampaignId).map((c) => [c.externalCampaignId!, c.id]))
  const sumCols = (dayFrom: number, alias: string, oos: boolean) => Prisma.sql`
           SUM(CASE WHEN x.d BETWEEN ${dayFrom} AND ${clicksThrough}${oos ? Prisma.sql` AND NOT x.oos` : Prisma.empty} THEN x.i ELSE 0 END)::int AS ${Prisma.raw(`"i${alias}"`)},
           SUM(CASE WHEN x.d BETWEEN ${dayFrom} AND ${clicksThrough}${oos ? Prisma.sql` AND NOT x.oos` : Prisma.empty} THEN x.k ELSE 0 END)::int AS ${Prisma.raw(`"k${alias}"`)},
           SUM(CASE WHEN x.d BETWEEN ${dayFrom} AND ${clicksThrough}${oos ? Prisma.sql` AND NOT x.oos` : Prisma.empty} THEN x.m ELSE 0 END)::bigint AS ${Prisma.raw(`"m${alias}"`)},
           SUM(CASE WHEN x.d BETWEEN ${dayFrom} AND ${today} THEN x.o ELSE 0 END)::int AS ${Prisma.raw(`"o${alias}"`)},
           SUM(CASE WHEN x.d BETWEEN ${dayFrom} AND ${today} THEN x.sa ELSE 0 END)::bigint AS ${Prisma.raw(`"s${alias}"`)}`
  const tailCols = Prisma.sql`
           SUM(CASE WHEN x.d BETWEEN ${d90From} AND ${today} THEN x.k ELSE 0 END)::int AS "k90d",
           SUM(CASE WHEN x.d BETWEEN ${d90From} AND ${today} THEN x.o ELSE 0 END)::int AS "o90d",
           SUM(CASE WHEN x.d BETWEEN ${d90From} AND ${today} THEN x.m ELSE 0 END)::bigint AS "m90d",
           ${Prisma.join(WEEK_INDEXES.map((w) => Prisma.sql`SUM(CASE WHEN ${today} - x.d BETWEEN ${w * 7} AND ${w * 7 + 6} THEN x.m ELSE 0 END)::bigint AS ${Prisma.raw(`"w${w}"`)}`), ',\n           ')}`
  const focusWhere = focus
    ? Prisma.sql`AND (lower(regexp_replace(btrim(s.query), '[[:space:]]+', ' ', 'g')) = lower(${focus.key}) OR upper(regexp_replace(btrim(s.query), '[[:space:]]+', ' ', 'g')) = upper(${focus.key})${focusGroup?.externalAdGroupId ? Prisma.sql` OR s."adGroupId" = ${focusGroup.externalAdGroupId}` : Prisma.empty})`
    : Prisma.empty
  type SumRow = Record<string, unknown>
  const termRows = extCampaigns.length ? await prisma.$queryRaw<SumRow[]>(Prisma.sql`
    WITH x AS (
      SELECT s."campaignId" AS c, s."adGroupId" AS g, s.query AS q, COALESCE(s."matchedKeywordId", s."matchedTargetId") AS via, s."matchType" AS mt,
             (s.date - DATE '1970-01-01')::int AS d, s.impressions AS i, s.clicks AS k, s."costMicros" AS m,
             COALESCE(s."orders7d", 0) AS o, COALESCE(s."sales7dCents", 0) AS sa,
             EXISTS (SELECT 1 FROM unnest(${oosExt}::text[], ${oosDay}::int[]) AS z(g, d) WHERE z.g = s."adGroupId" AND z.d = (s.date - DATE '1970-01-01')::int) AS oos
        FROM "AmazonAdsSearchTerm" s
       WHERE s."campaignId" = ANY(${extCampaigns}::text[]) AND s.date >= ${readFrom}::date ${focusWhere}
    )
    SELECT x.c, x.g, x.q, x.via, MAX(x.mt) AS mt, SUM(x.k)::int AS k93,
           SUM(CASE WHEN x.d BETWEEN ${since[60]} AND ${clicksThrough} THEN x.k ELSE 0 END)::int AS "kDef",
           SUM(CASE WHEN x.d BETWEEN ${since[60]} AND ${clicksThrough} THEN x.k + x.i ELSE 0 END)::int AS "servedDef",
           ${sumCols(since[30], '30', true)},
           ${sumCols(since[60], '60', true)},
           ${sumCols(since[90], '90', true)},
           ${tailCols}
      FROM x
     GROUP BY x.c, x.g, x.q, x.via
    HAVING SUM(x.k) > 0 OR SUM(x.o) > 0 OR SUM(CASE WHEN x.d BETWEEN ${since[60]} AND ${clicksThrough} THEN x.i ELSE 0 END) > 0`) : []
  const sumsOf = (r: SumRow, alias: string): WindowSums => ({ impressions: num(r[`i${alias}`]), clicks: num(r[`k${alias}`]), spendCents: cents(r[`m${alias}`]), orders: num(r[`o${alias}`]), salesCents: num(r[`s${alias}`]) })
  const sparkOfRow = (r: SumRow) => WEEK_INDEXES.map((w) => cents(r[`w${SPARK_WEEKS - 1 - w}`]))
  const termPlaces = new Map<string, TermPlaceFacts>()
  for (const r of termRows) {
    const campaignId = campaignOfExt.get(String(r.c))
    const adGroupId = adGroupOfExt.get(`${r.c}|${r.g}`)
    if (!campaignId || !adGroupId) continue
    const query = String(r.q)
    const key = termKeyOf(query)
    if (!key) continue
    if (focus && key !== focus.key && adGroupId !== focus.adGroupId) continue
    const k = `${adGroupId}|${key}`
    let p = termPlaces.get(k)
    if (!p) {
      p = {
        adGroupId, campaignId, key, text: query.trim().replace(/\s+/g, ' '), matchType: null, clicks93: 0, clicksDefault: 0, servedDefault: 0,
        win: { 30: NO_SUMS, 60: NO_SUMS, 90: NO_SUMS }, d90: { clicks: 0, orders: 0, spendCents: 0 }, spark: new Array<number>(SPARK_WEEKS).fill(0), vias: new Map(),
      }
      termPlaces.set(k, p)
    }
    p.matchType = p.matchType ?? (r.mt == null ? null : String(r.mt))
    p.clicks93 += num(r.k93)
    p.clicksDefault += num(r.kDef)
    p.servedDefault += num(r.servedDef)
    for (const d of WINDOWS) p.win[d] = addSums(p.win[d], sumsOf(r, String(d)))
    p.d90 = { clicks: p.d90.clicks + num(r.k90d), orders: p.d90.orders + num(r.o90d), spendCents: p.d90.spendCents + cents(r.m90d) }
    const spark = sparkOfRow(r)
    p.spark = p.spark.map((v, i) => v + spark[i])
    if (r.via != null) {
      const via = String(r.via)
      const v = p.vias.get(via) ?? { clicks: 0, orders: 0, win60: NO_SUMS, d90: { clicks: 0, orders: 0, spendCents: 0 }, spark: new Array<number>(SPARK_WEEKS).fill(0) }
      p.vias.set(via, {
        clicks: v.clicks + num(r.k93), orders: v.orders + num(r.o60), win60: addSums(v.win60, sumsOf(r, '60')),
        d90: { clicks: v.d90.clicks + num(r.k90d), orders: v.d90.orders + num(r.o90d), spendCents: v.d90.spendCents + cents(r.m90d) },
        spark: v.spark.map((x, i) => x + spark[i]),
      })
    }
  }
  const placesByKey = new Map<string, TermPlaceFacts[]>()
  const placesByGroup = new Map<string, TermPlaceFacts[]>()
  const placesByCampaign = new Map<string, TermPlaceFacts[]>()
  for (const p of termPlaces.values()) { push(placesByKey, p.key, p); push(placesByGroup, p.adGroupId, p); push(placesByCampaign, p.campaignId, p) }

  // The pooled nodes (product → market) over the default window, per campaign: every term, whatever the focus.
  const poolRows = extCampaigns.length ? await prisma.$queryRaw<SumRow[]>(Prisma.sql`
    SELECT s."campaignId" AS c, MAX(s."currencyCode") AS cur, MAX(s.date - DATE '1970-01-01')::int AS last,
           SUM(CASE WHEN s.date <= ${wins[60].clicksThrough}::date THEN s.clicks ELSE 0 END)::int AS k,
           SUM(CASE WHEN s.date <= ${wins[60].clicksThrough}::date THEN s."costMicros" ELSE 0 END)::bigint AS m,
           SUM(COALESCE(s."orders7d", 0))::int AS o, SUM(COALESCE(s."sales7dCents", 0))::bigint AS sa
      FROM "AmazonAdsSearchTerm" s
     WHERE s."campaignId" = ANY(${extCampaigns}::text[]) AND s.date >= ${wins[60].since}::date AND s.date <= ${wins[60].ordersThrough}::date
     GROUP BY s."campaignId"`) : []
  const currencyOf = new Map<string, string>()
  let termsThrough = -1
  const node = () => ({ clicks: 0, orders: 0, salesCents: 0, costCents: 0 })
  const productNode = new Map<string, ReturnType<typeof node>>()
  const marketNode = node()
  for (const r of poolRows) {
    const campaignId = campaignOfExt.get(String(r.c))
    if (!campaignId) continue
    if (r.cur) currencyOf.set(campaignId, String(r.cur))
    termsThrough = Math.max(termsThrough, num(r.last))
    const e = { clicks: num(r.k), costCents: cents(r.m), orders: num(r.o), salesCents: num(r.sa) }
    const add = (n: ReturnType<typeof node>) => { n.clicks += e.clicks; n.costCents += e.costCents; n.orders += e.orders; n.salesCents += e.salesCents }
    add(marketNode)
    const own = ownership.get(campaignId)
    if (own?.owner.kind === 'product') add(productNode.get(own.owner.productId) ?? (productNode.set(own.owner.productId, node()), productNode.get(own.owner.productId)!))
  }

  // When each place first served (the "new place" guard): the first impression of the ad group, its keywords or its
  // product ads; else its campaign's; else the campaign's start date.
  const firstGroups = focus ? groupIds.filter((id) => id === focus.adGroupId || [...termPlaces.values()].some((p) => p.adGroupId === id) || (positivesByGroup.get(id) ?? []).some(inFocus)) : groupIds
  const firstSet = new Set(firstGroups)
  const adOfGroup = new Map<string, string>(groupRows.filter((g) => firstSet.has(g.id)).flatMap((g) => g.productAds.map((a) => [String(a.id), String(g.id)] as [string, string])))
  const positives = targets.filter((t) => !t.isNegative)
  const firstIds = [...firstGroups, ...new Set(firstGroups.map((id) => adGroups.get(id)!.campaignId)), ...positives.filter((t) => firstSet.has(t.adGroupId)).map((t) => t.id), ...adOfGroup.keys()]
  const firstRows = firstIds.length ? await prisma.$queryRaw<Array<{ type: string; id: string; first: number }>>(Prisma.sql`
    SELECT p."entityType" AS type, p."localEntityId" AS id, MIN(p.date - DATE '1970-01-01')::int AS first
      FROM "AmazonAdsDailyPerformance" p
     WHERE p.impressions > 0 AND p."localEntityId" = ANY(${firstIds}::text[]) AND p."entityType" IN ('AD_GROUP', 'AD_TARGET', 'PRODUCT_AD', 'CAMPAIGN')
     GROUP BY p."entityType", p."localEntityId"`) : []
  const groupFirst = new Map<string, number>()
  const campaignFirst = new Map<string, number>()
  const earliest = (m: Map<string, number>, k: string | undefined, day: number) => { if (k) m.set(k, Math.min(m.get(k) ?? day, day)) }
  for (const r of firstRows) {
    const day = Number(r.first)
    if (r.type === 'CAMPAIGN') earliest(campaignFirst, r.id, day)
    else if (r.type === 'AD_GROUP') earliest(groupFirst, r.id, day)
    else if (r.type === 'AD_TARGET') earliest(groupFirst, targetById.get(r.id)?.adGroupId, day)
    else earliest(groupFirst, adOfGroup.get(r.id), day)
  }
  const startOf = new Map(campaignRows.map((c) => [c.id, c.startDate]))
  for (const g of adGroups.values()) {
    const start = startOf.get(g.campaignId)
    g.firstDay = groupFirst.get(g.id) ?? campaignFirst.get(g.campaignId) ?? (start ? dayIndex(start) : null)
  }

  // ── The action log: our targets' state changes of 30 days and each paused one's pause; negatives' creates, retires ──
  const positiveIds = positives.filter(inFocus).map((t) => t.id)
  const negativeIds = targets.filter((t) => t.isNegative && inFocus(t)).map((t) => t.id)
  const changeSelect = { id: true, entityId: true, actionType: true, userId: true, executionId: true, createdAt: true, amazonResponseStatus: true, rolledBackAt: true, payloadBefore: true, payloadAfter: true, evidence: true } as const
  const pausedIds = positives.filter((t) => t.status === 'PAUSED' && inFocus(t)).map((t) => t.id)
  const [stateRows, createRows, retireRows, pauseRows] = await Promise.all([
    positiveIds.length ? prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT l.id FROM "AdvertisingActionLog" l
       WHERE l."entityType" = 'AD_TARGET' AND l."entityId" = ANY(${positiveIds}::text[]) AND l."createdAt" >= ${retiredSince}
         AND l."payloadAfter" ? 'status' AND (l."payloadBefore" ->> 'status') IS DISTINCT FROM (l."payloadAfter" ->> 'status')`)
      .then((ids) => ids.length ? prisma.advertisingActionLog.findMany({ where: { id: { in: ids.map((x) => x.id) } }, select: changeSelect }) : []) : Promise.resolve([]),
    negativeIds.length ? prisma.advertisingActionLog.findMany({ where: { entityType: 'AD_TARGET', entityId: { in: negativeIds }, actionType: { in: ['create_negative_keyword', 'create_negative_product_target'] } }, select: changeSelect, orderBy: { createdAt: 'asc' } }) : Promise.resolve([]),
    negativeIds.length ? prisma.advertisingActionLog.findMany({ where: { entityType: 'AD_TARGET', entityId: { in: negativeIds }, createdAt: { gte: retiredSince }, actionType: 'retire_negative' }, select: changeSelect }) : Promise.resolve([]),
    pausedIds.length ? prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT DISTINCT ON (l."entityId") l.id FROM "AdvertisingActionLog" l
       WHERE l."entityType" = 'AD_TARGET' AND l."entityId" = ANY(${pausedIds}::text[])
         AND l."payloadAfter" ->> 'status' = 'PAUSED' AND (l."payloadBefore" ->> 'status') IS DISTINCT FROM 'PAUSED'
         AND l."rolledBackAt" IS NULL AND COALESCE(l."amazonResponseStatus", '') NOT IN ('FAILED', 'SKIPPED', 'CANCELLED', 'SUPERSEDED', 'REFUSED')
       ORDER BY l."entityId", l."createdAt" DESC, l.id DESC`)
      .then((ids) => ids.length ? prisma.advertisingActionLog.findMany({ where: { id: { in: ids.map((x) => x.id) } }, select: changeSelect }) : []) : Promise.resolve([]),
  ])
  const asChange = (l: (typeof createRows)[number]): ChangeFact => ({
    id: l.id, entityId: l.entityId, actionType: l.actionType, actor: l.userId, executionId: l.executionId, at: l.createdAt, status: l.amazonResponseStatus,
    rolledBackAt: l.rolledBackAt, before: jsonObj(l.payloadBefore), after: jsonObj(l.payloadAfter), evidence: l.evidence,
  })
  const stateChanges = new Map<string, ChangeFact[]>()
  for (const l of [...stateRows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) push(stateChanges, l.entityId, asChange(l))
  const negativeCreates = new Map<string, ChangeFact>()
  for (const l of createRows) if (!negativeCreates.has(l.entityId)) negativeCreates.set(l.entityId, asChange(l))
  const retires = retireRows.map(asChange)
  const lastPause = new Map(pauseRows.map((l) => [l.entityId, asChange(l)]))

  // ── Our keywords and targets, summed per target (rows come from places that run; a focus reads its own) ──
  const kwIds = positives.filter((t) => t.status !== 'ARCHIVED' && (focus ? inFocus(t) : adGroups.get(t.adGroupId)?.live || holds.has(t.id) || t.status === 'PAUSED')).map((t) => t.id)
  // The day each stopped keyword was stopped (its hold, else its pause on record): the 30 days before it are its "before".
  const stopDay = new Map<string, number>()
  for (const id of kwIds) {
    const at = holds.get(id)?.at ?? lastPause.get(id)?.at ?? null
    if (at) stopDay.set(id, dayIndex(at))
  }
  const kwRows = kwIds.length ? await prisma.$queryRaw<SumRow[]>(Prisma.sql`
    WITH x AS (
      SELECT p."localEntityId" AS id, (p.date - DATE '1970-01-01')::int AS d, p.impressions AS i, p.clicks AS k, p."costMicros" AS m,
             COALESCE(p."orders7d", 0) AS o, COALESCE(p."sales7dCents", 0) AS sa, p."currencyCode" AS cur,
             EXISTS (SELECT 1 FROM unnest(${oosLocal}::text[], ${oosDay}::int[]) AS z(g, d) WHERE z.g = t."adGroupId" AND z.d = (p.date - DATE '1970-01-01')::int) AS oos
        FROM "AmazonAdsDailyPerformance" p JOIN "AdTarget" t ON t.id = p."localEntityId"
       WHERE p."entityType" = 'AD_TARGET' AND p."localEntityId" = ANY(${kwIds}::text[]) AND p.date >= ${readFrom}::date
    ), b AS (SELECT * FROM unnest(${[...stopDay.keys()]}::text[], ${[...stopDay.values()]}::int[]) AS b(id, since))
    SELECT x.id, MAX(x.cur) AS cur, MAX(x.d) AS last,
           ${sumCols(since[60], '60', true)},
           ${tailCols},
           SUM(CASE WHEN b.since IS NOT NULL AND x.d BETWEEN b.since - 30 AND b.since - 1 THEN x.m ELSE 0 END)::bigint AS before
      FROM x LEFT JOIN b ON b.id = x.id
     GROUP BY x.id`) : []
  const keywords = new Map<string, KeywordAgg>()
  let keywordsThrough = -1
  for (const r of kwRows) {
    const id = String(r.id)
    keywordsThrough = Math.max(keywordsThrough, num(r.last))
    const stopped = stopDay.get(id)
    keywords.set(id, {
      win: sumsOf(r, '60'),
      d90: { clicks: num(r.k90d), orders: num(r.o90d), spendCents: cents(r.m90d) },
      spark: sparkOfRow(r),
      spendBefore: stopped == null || stopped - 30 < readFromDay ? null : cents(r.before),
    })
    const c = adGroups.get(targetById.get(id)?.adGroupId ?? '')?.campaignId
    if (c && r.cur && !currencyOf.has(c)) currencyOf.set(c, String(r.cur))
  }

  // ── A standing negative's "spend before": the words it blocks, in its place, the 30 days before it was made ──
  const negBefore = targets.filter((t) => t.isNegative && !t.retiredAt && t.status !== 'ARCHIVED' && inFocus(t)).flatMap((t) => {
    const made = dayIndex(negativeCreates.get(t.id)?.at ?? t.createdAt)
    const g = adGroups.get(t.adGroupId)!
    const c = campaigns.get(g.campaignId)!
    if (made - 30 < readFromDay || !c.externalCampaignId) return []
    return [{ id: t.id, c: c.externalCampaignId, g: t.negativeLevel === 'CAMPAIGN' ? '' : g.externalAdGroupId ?? '', from: made - 30, to: made - 1 }]
  })
  const negativeSpendBefore = new Map<string, number | null>(targets.filter((t) => t.isNegative).map((t) => [t.id, null]))
  if (negBefore.length) {
    const rows = await prisma.$queryRaw<Array<{ id: string; q: string; m: bigint | number }>>(Prisma.sql`
      SELECT v.id, s.query AS q, SUM(s."costMicros")::bigint AS m
        FROM unnest(${negBefore.map((n) => n.id)}::text[], ${negBefore.map((n) => n.c)}::text[], ${negBefore.map((n) => n.g)}::text[], ${negBefore.map((n) => n.from)}::int[], ${negBefore.map((n) => n.to)}::int[]) AS v(id, c, g, f, t)
        JOIN "AmazonAdsSearchTerm" s ON s."campaignId" = v.c AND (v.g = '' OR s."adGroupId" = v.g)
                                     AND (s.date - DATE '1970-01-01') BETWEEN v.f AND v.t
       GROUP BY v.id, s.query`)
    for (const n of negBefore) negativeSpendBefore.set(n.id, 0)
    for (const r of rows) {
      const t = targetById.get(r.id)!
      const m = negMatchOf(t)
      if (m && negativeBlocksTerm(termKeyOf(r.q), { text: t.expressionValue, match: m })) negativeSpendBefore.set(r.id, (negativeSpendBefore.get(r.id) ?? 0) + cents(r.m))
    }
  }

  // ── Products, strategy, protections, the brain, rules ──
  const roots = [...new Set([...ownership.values()].flatMap((o) => o.productIds))]
  const allNegativeIds = targets.filter((t) => t.isNegative).map((t) => t.id)
  const [productRows, protectionRows, ownerTargets, due, ruleRows, harvestRows, brainNegRows, portfolioRows] = await Promise.all([
    roots.length ? prisma.product.findMany({ where: { id: { in: roots } }, select: { id: true, sku: true, name: true, basePrice: true } }) : Promise.resolve([]),
    prisma.adKeywordProtection.findMany({ where: { mode: 'WHITELIST' }, select: { term: true, isPrefix: true, matchType: true, reason: true, marketplace: true, campaignId: true } }),
    readOwnerTargets([]),
    termsDue({ includeOrchestrated: true }).catch(() => ({ due: false, why: '', products: [] })),
    prisma.automationRule.findMany({
      where: { domain: 'advertising', enabled: true },
      select: { id: true, name: true, enabled: true, dryRun: true, autonomyLevel: true, actions: true, conditions: true, scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true, scopeAdGroupId: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.adsBrainHarvest.findMany({ where: { marketplace: { in: markets } }, select: { term: true, landedAt: true, sources: true } }),
    allNegativeIds.length ? prisma.adsBrainNegative.findMany({ where: { adTargetId: { in: allNegativeIds }, action: 'ADD' }, select: { adTargetId: true, reason: true } }) : Promise.resolve([]),
    (() => {
      const ids = [...new Set([...campaigns.values()].map((c) => c.portfolioId).filter((x): x is string => !!x))]
      return ids.length ? prisma.amazonAdsPortfolio.findMany({ where: { externalPortfolioId: { in: ids } }, select: { externalPortfolioId: true, name: true }, orderBy: { updatedAt: 'asc' } }) : Promise.resolve([])
    })(),
  ])
  const products = new Map(productRows.map((p) => [p.id, { id: p.id, name: p.sku || p.name }]))
  const portfolioNames = new Map(portfolioRows.map((r) => [r.externalPortfolioId, r.name]))

  // The product's facts: pooled CR and order value (product → market) over the default window, × its target ACoS.
  const strategies = new Map<string, { view: Awaited<ReturnType<typeof openStrategy>> | null; byProduct: Map<string, EffectiveStrategy> }>()
  try {
    const view = await openStrategy(market)
    strategies.set(market, { view, byProduct: view.empty || !roots.length ? new Map() : await view.forEachProduct(roots) })
  } catch (err) {
    logger.warn('[waste] the ads strategy could not be read; the default test applies', { market, error: err instanceof Error ? err.message : String(err) })
    strategies.set(market, { view: null, byProduct: new Map() })
  }
  const accountPct = typeof ownerTargets.accountDefaultPct === 'number' && ownerTargets.accountDefaultPct > 0 ? ownerTargets.accountDefaultPct : null
  const listPrice = new Map(productRows.map((p) => [p.id, Math.round(Number(p.basePrice ?? 0) * 100)]))
  const strategySource = (e: EffectiveStrategy | null | undefined, key: string) => {
    const s = e?.resolved.fields.get(key as never)?.source
    return s ? `the ads strategy: ${sourceLabel(s)}` : 'the ads strategy'
  }
  const marketView = strategies.get(market)?.view && !strategies.get(market)!.view!.empty ? strategies.get(market)!.view!.forMarket() : null
  const factsOf = (root: string | null): ProductFacts => {
    const e = root ? strategies.get(market)?.byProduct.get(root) : marketView
    const pct = e?.values.targetAcosPct ?? null
    const target = pct != null && pct > 0 ? { value: pct / 100, source: strategySource(e, 'targetAcosPct') } : accountPct != null ? { value: accountPct / 100, source: 'the account\'s default target ACoS' } : null
    const chain = [...(root ? [{ level: 'product' as const, evidence: productNode.get(root) ?? node() }] : []), { level: 'market' as const, evidence: marketNode }]
    const est = estimate(chain, { listPriceCents: root ? listPrice.get(root) ?? null : null }).node
    const cr = marketNode.clicks > 0 || (root && (productNode.get(root)?.clicks ?? 0) > 0) ? est.cr : null
    const cpa = target && est.aovCents != null && est.aovCents > 0 ? Math.round(est.aovCents * target.value) : null
    return { cr, targetCpaCents: cpa, targetSource: target?.source ?? null }
  }
  const productFacts = new Map<string, ProductFacts>()
  const negateBar = new Map<string, OwnerBar>()
  const marketFacts = new Map<string, ProductFacts>([[market, factsOf(null)]])
  const marketNegateBar = new Map<string, OwnerBar | null>([[market, marketView?.values.negate ? { source: 'strategy', by: { id: 'strategy', name: strategySource(marketView, 'negate') }, ...marketView.values.negate } : null]])
  for (const o of ownership.values()) {
    if (o.owner.kind !== 'product') continue
    const root = o.owner.productId
    const key = `${market}|${root}`
    if (productFacts.has(key)) continue
    productFacts.set(key, factsOf(root))
    const e = strategies.get(market)?.byProduct.get(root)
    if (e?.values.negate) negateBar.set(key, { source: 'strategy', by: { id: 'strategy', name: strategySource(e, 'negate') }, ...e.values.negate })
  }

  const brainProducts = new Set(due.products.filter((p) => ['OBSERVE', 'PROPOSE', 'AUTO'].includes(String(p.settings.levers.negatives.effective))).map((p) => `${marketCode(p.market)}|${p.productId}`))

  // Rules that act (Ask me or Auto, resolved as the evaluator resolves them) with what they really produce: pause_target
  // (our keyword) or add_negative_* (a search term) — a builder Bid rule with THEN Pause included (producedActionTypes).
  const ruleKind = (r: { id: string; actions: unknown; conditions: unknown }): RuleFact['kind'] | null => {
    const types = producedActionTypes(r)
    if (types.includes('pause_target')) return 'pause'
    if (types.some((t) => t === 'add_negative_exact' || t === 'add_negative_phrase')) return 'negate'
    return null
  }
  const acting = ruleRows.filter((r) => ['PROPOSE', 'AUTO'].includes(resolveAutonomy(r)))
  const rules: RuleFact[] = acting.flatMap((r) => {
    const kind = ruleKind(r)
    return kind ? [{ id: r.id, name: r.name, kind, scopeMarketplace: r.scopeMarketplace, scopePortfolioId: r.scopePortfolioId, scopeCampaignId: r.scopeCampaignId, scopeProductId: r.scopeProductId, scopeAdGroupId: r.scopeAdGroupId }] : []
  })
  const [ruleAssigned, ruleProductScope] = await Promise.all([
    rules.length ? resolveAssignedCampaignIds(acting.filter((r) => rules.some((x) => x.id === r.id))) : Promise.resolve(new Map<string, string[]>()),
    Promise.all(rules.filter((r) => r.scopeProductId).map(async (r) => [r.scopeProductId!, await expandProductScope(r.scopeProductId!)] as const)).then((l) => new Map(l)),
  ])

  // Harvest: each source negative's id, and when each term landed as a keyword.
  const harvestSources = new Set<string>()
  const harvestedAt = new Map<string, number>()
  for (const h of harvestRows) {
    for (const s of Array.isArray(h.sources) ? h.sources as Array<{ negativeTargetId?: unknown }> : []) if (typeof s?.negativeTargetId === 'string') harvestSources.add(s.negativeTargetId)
    if (h.landedAt) harvestedAt.set(termKeyOf(h.term), Math.max(harvestedAt.get(termKeyOf(h.term)) ?? 0, h.landedAt.getTime()))
  }
  const brainReasons = new Map(brainNegRows.filter((r) => r.adTargetId).map((r) => [r.adTargetId!, r.reason]))

  // What waits: approvals (pending, not expired) and rules' Ask-me cards.
  const pending = await prisma.agentApproval.findMany({
    where: { status: 'pending', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], toolName: { in: ['pause-ads', 'add-negative-targets', 'create-negative-keyword', 'submit-change-plan'] } },
    select: { id: true, toolName: true, args: true, requestedAt: true, expiresAt: true, agentRun: { select: { via: true, userId: true } }, planSteps: { where: { status: 'pending' }, select: { toolName: true, args: true } } },
  })
  const brainAsks = new Set((pending.length ? await prisma.adsBrainNegative.findMany({ where: { approvalId: { in: pending.map((p) => p.id) } }, select: { approvalId: true } }) : []).map((r) => r.approvalId!))
  const cards = await prisma.adsRuleSuggestion.findMany({ where: { status: 'pending', entityType: { in: ['AD_TARGET', 'SEARCH_TERM'] } }, select: { id: true, ruleId: true, ruleName: true, entityType: true, entityId: true, proposedAction: true, createdAt: true } })

  // Names: rules (every one a change or a card names), Claude's change sets.
  const executionIds = [...new Set([...stateRows, ...createRows, ...retireRows, ...pauseRows].map((l) => l.executionId).filter((x): x is string => !!x))]
  const ruleIdsSeen = new Set<string>([...rules.map((r) => r.id), ...cards.map((c) => c.ruleId)])
  for (const l of [...stateRows, ...createRows, ...retireRows, ...pauseRows]) {
    const a = l.userId?.replace(/^automation:(automation:)*/, '')
    if (l.userId?.startsWith('automation:') && a) ruleIdsSeen.add(a.replace(/^rule-/, ''))
  }
  const [ruleNames, claudeSets] = await Promise.all([
    prisma.automationRule.findMany({ where: { id: { in: [...ruleIdsSeen] } }, select: { id: true, name: true } }),
    executionIds.length ? prisma.agentApproval.findMany({ where: { id: { in: executionIds }, agentRun: { via: 'claude' } }, select: { id: true } }) : Promise.resolve([]),
  ])
  const names: OwnerNames = {
    rules: new Map([...ruleNames.map((r) => [r.id, r.name] as const), ...cards.filter((c) => c.ruleName).map((c) => [c.ruleId, c.ruleName!] as const)]),
    claudeChangeSets: new Set([...claudeSets.map((a) => a.id), ...pending.filter((p) => p.agentRun?.via === 'claude').map((p) => p.id)]),
  }

  const waitingKw = new Map<string, WaitingFact>()
  const waitingTerm: WasteFacts['waitingTerm'] = []
  for (const a of pending) {
    const by: Owner = brainAsks.has(a.id) ? { kind: 'BRAIN', name: 'Brain', id: 'brain' }
      : a.agentRun?.via === 'claude' ? { kind: 'CLAUDE', name: 'Claude', id: a.id }
        : { kind: 'PERSON', name: 'You', id: a.agentRun?.userId ?? null }
    const fact: WaitingFact = { approvalId: a.id, by, at: a.requestedAt, expiresAt: a.expiresAt }
    const steps = a.toolName === 'submit-change-plan' ? a.planSteps : [{ toolName: a.toolName, args: a.args }]
    for (const s of steps) {
      const args = jsonObj(s.args)
      if (s.toolName === 'pause-ads') {
        for (const id of Array.isArray(args.targetIds) ? args.targetIds : []) if (typeof id === 'string' && !waitingKw.has(id)) waitingKw.set(id, fact)
      } else if (s.toolName === 'add-negative-targets') {
        for (const n of Array.isArray(args.negatives) ? args.negatives as Array<Record<string, unknown>> : []) {
          const text = typeof n.text === 'string' ? n.text : typeof n.asin === 'string' ? n.asin : null
          if (text) waitingTerm.push({ fact, adGroupId: typeof n.adGroupId === 'string' ? n.adGroupId : null, campaignId: typeof n.campaignId === 'string' ? n.campaignId : null, key: termKeyOf(text) })
        }
        const texts = [...(Array.isArray(args.keywords) ? (args.keywords as Array<{ text?: unknown }>).map((k) => k?.text) : []), ...(Array.isArray(args.asins) ? args.asins : [])].filter((t): t is string => typeof t === 'string')
        const campaignScope = args.scope === 'CAMPAIGN'
        for (const text of texts) {
          for (const g of campaignScope ? [] : (Array.isArray(args.adGroupIds) ? args.adGroupIds : [])) if (typeof g === 'string') waitingTerm.push({ fact, adGroupId: g, campaignId: null, key: termKeyOf(text) })
          for (const c of campaignScope ? (Array.isArray(args.campaignIds) ? args.campaignIds : []) : []) if (typeof c === 'string') waitingTerm.push({ fact, adGroupId: null, campaignId: c, key: termKeyOf(text) })
        }
      } else if (s.toolName === 'create-negative-keyword') {
        const text = typeof args.keywordText === 'string' ? args.keywordText : null
        const ext = typeof args.externalAdGroupId === 'string' ? args.externalAdGroupId : null
        const extC = typeof args.externalCampaignId === 'string' ? args.externalCampaignId : null
        const g = ext ? [...adGroups.values()].find((x) => x.externalAdGroupId === ext && (!extC || campaigns.get(x.campaignId)?.externalCampaignId === extC)) : undefined
        if (text && g) waitingTerm.push({ fact, adGroupId: g.id, campaignId: null, key: termKeyOf(text) })
      }
    }
  }
  for (const c of cards) {
    const type = String(jsonObj(c.proposedAction).type ?? '')
    const by: Owner = { kind: 'RULE', name: c.ruleName ?? names.rules.get(c.ruleId) ?? 'Rule', id: c.ruleId }
    const fact: WaitingFact = { approvalId: `suggestion:${c.id}`, by, at: c.createdAt, expiresAt: null }
    if (c.entityType === 'AD_TARGET' && type === 'pause_target' && !waitingKw.has(c.entityId)) waitingKw.set(c.entityId, fact)
    if (c.entityType === 'SEARCH_TERM' && (type === 'add_negative_exact' || type === 'add_negative_phrase')) {
      const at = c.entityId.indexOf(':')
      if (at <= 0) continue
      const ext = c.entityId.slice(0, at)
      const campaignId = campaignOfExt.get(ext) ?? null
      const adGroupId = typeof jsonObj(c.proposedAction).adGroupId === 'string' ? String(jsonObj(c.proposedAction).adGroupId) : null
      if (campaignId) waitingTerm.push({ fact, adGroupId, campaignId: adGroupId ? null : campaignId, key: termKeyOf(c.entityId.slice(at + 1)) })
    }
  }

  const skips = new Map<string, SkipFacts>([...(await activeSkips(undefined, now))].map(([k, v]) => [k, { until: v.until, by: v.by, at: v.at }]))

  return {
    now, markets, focus, campaigns, adGroups, adGroupOfExt, ownership, products, portfolioNames, targets, positivesByGroup, negByGroup, negByCampaign, targetByExt, targetById,
    termPlaces, placesByKey, placesByGroup, placesByCampaign, keywords, negativeSpendBefore, stock, productFacts, marketFacts, negateBar, marketNegateBar,
    protections: protectionRows.map((p) => ({ term: p.term, isPrefix: p.isPrefix, matchType: p.matchType, reason: p.reason, marketplace: p.marketplace, campaignId: p.campaignId })),
    brainProducts, rules, ruleProductScope, ruleAssigned, stateChanges, lastPause, negativeCreates, retires, brainReasons, harvestSources, harvestedAt,
    waitingKw, waitingTerm, holds, origins, skips, names, currencyOf,
    freshness: { searchTermsThrough: termsThrough >= 0 ? isoDay(termsThrough * DAY_MS) : null, keywordsThrough: keywordsThrough >= 0 ? isoDay(keywordsThrough * DAY_MS) : null, readAt: now.toISOString() },
  }
}

// ── From facts to rows ──────────────────────────────────────────────────────────────────────────────────────────

/** Refs of a place. */
export function placeRefs(f: WasteFacts, adGroupId: string, focus?: { tab: 'targets' | 'search-terms' | 'ad-group-negative-keywords'; value: string }): { portfolio: Ref | null; campaign: Ref; adGroup: Ref; product: Ref | null; productCount: number; market: string; currency: string } {
  const g = f.adGroups.get(adGroupId)!
  const c = f.campaigns.get(g.campaignId)!
  const own = f.ownership.get(c.id)
  const roots = own?.productIds ?? []
  const root = own?.owner.kind === 'product' ? own.owner.productId : null
  const p = root ? f.products.get(root) : undefined
  return {
    portfolio: c.portfolioId ? { id: c.portfolioId, name: portfolioName(f, c.portfolioId), href: portfolioHref(c.portfolioId) } : null,
    campaign: { id: c.id, name: c.name, href: campaignHref(c.id) },
    adGroup: { id: g.id, name: g.name, href: adGroupHref(c.id, g.id, focus?.tab, focus?.value) },
    product: root ? { id: root, name: p?.name ?? root, href: productHref(root) } : null,
    productCount: roots.length + (own?.unresolved.length ?? 0),
    market: c.market,
    currency: f.currencyOf.get(c.id) ?? (c.dailyBudgetCurrency?.trim().toUpperCase() || 'EUR'),
  }
}

function portfolioName(f: WasteFacts, id: string): string {
  return f.portfolioNames.get(id) ?? id
}

/**
 * A window's numbers from its SQL sums (the same arithmetic as pure.ts windowNumbers), and the days out of stock its
 * clicks and spend left out (the place's days inside the window's click days).
 */
function numbersOf(f: WasteFacts, sums: WindowSums, adGroupId: string, windowDays: number): { n: Omit<RowNumbers, 'xCpa'>; stockOutDays: number } {
  const w = wasteWindow(f.now, windowDays)
  const from = dayIndex(w.since), to = dayIndex(w.clicksThrough)
  let stockOutDays = 0
  for (const d of f.stock.get(adGroupId) ?? []) if (d >= from && d <= to) stockOutDays++
  return {
    n: {
      impressions: sums.impressions, clicks: sums.clicks, orders: sums.orders, spendCents: sums.spendCents, salesCents: sums.salesCents,
      acosPct: sums.salesCents > 0 ? Math.round((sums.spendCents / sums.salesCents) * 1000) / 10 : null,
      cpcCents: sums.clicks > 0 ? Math.round(sums.spendCents / sums.clicks) : null,
    },
    stockOutDays,
  }
}

/** The protected term that hits this text in this campaign, or null. */
export function protectedBy(f: WasteFacts, campaignId: string, text: string, asNegative: boolean): string | null {
  const c = f.campaigns.get(campaignId)
  const list = f.protections.filter((p) => (!p.marketplace || marketCode(p.marketplace) === c?.market) && (!p.campaignId || p.campaignId === campaignId))
  const hit = protectedTermHit(text, asNegative ? 'NEGATIVE_EXACT' : 'EXACT', list)
  return hit ? hit.protection.term : null
}

/** The standing negatives that block a term in an ad group (its own and its campaign's). */
export function blockersOf(f: WasteFacts, adGroupId: string, key: string): TargetFact[] {
  const g = f.adGroups.get(adGroupId)
  if (!g) return []
  return [...(f.negByGroup.get(adGroupId) ?? []), ...(f.negByCampaign.get(g.campaignId) ?? [])].filter((n) => {
    const m = negativeMatch(n.kind, n.expressionType)
    if (!m) return false
    if (m === 'ASIN' && !isAsinText(key)) return false
    return negativeBlocksTerm(key, { text: n.expressionValue, match: m })
  })
}

/** Who made this standing negative. */
export function ownerOfNegative(f: WasteFacts, n: TargetFact): Owner {
  return negativeOwner({ origin: f.origins.get(n.id) ?? null, harvestSource: f.harvestSources.has(n.id), brainReason: f.brainReasons.get(n.id) ?? null, create: f.negativeCreates.get(n.id) ?? null }, f.names)
}

const stateWord = (to: unknown, c: ChangeFact) => {
  if (c.after.keptPausedAt != null && c.before.keptPausedAt == null) return 'kept'
  if (c.after.keptPausedAt == null && c.before.keptPausedAt != null && String(to) !== 'ENABLED') return 'released'
  return String(to) === 'PAUSED' ? 'paused' : String(to) === 'ENABLED' ? 'turned_on' : String(to) === 'ARCHIVED' ? 'archived' : String(to).toLowerCase()
}
/** A delivered (or still sending) change: one that changed or may change something at Amazon. */
const changed = (c: ChangeFact) => !c.rolledBackAt && !['FAILED', 'SKIPPED', 'CANCELLED', 'SUPERSEDED', 'REFUSED'].includes(String(c.status ?? '').toUpperCase())

const rulesMemo = new WeakMap<WasteFacts, Map<string, Array<{ id: string; name: string }>>>()
/** The rules whose scope and action reach this ad group, by priority (once per ad group and kind). */
function rulesOn(f: WasteFacts, adGroupId: string, kind: 'pause' | 'negate'): Array<{ id: string; name: string }> {
  let memo = rulesMemo.get(f)
  if (!memo) { memo = new Map(); rulesMemo.set(f, memo) }
  const key = `${adGroupId}|${kind}`
  if (!memo.has(key)) memo.set(key, rulesReaching(f, adGroupId, kind))
  return memo.get(key)!
}
function rulesReaching(f: WasteFacts, adGroupId: string, kind: 'pause' | 'negate'): Array<{ id: string; name: string }> {
  const g = f.adGroups.get(adGroupId)!
  const c = f.campaigns.get(g.campaignId)!
  return f.rules.filter((r) => r.kind === kind && (!r.scopeAdGroupId || r.scopeAdGroupId === adGroupId) && ruleMatchesScope({
    scopeMarketplace: r.scopeMarketplace ? marketCode(r.scopeMarketplace) : null,
    scopePortfolioId: r.scopePortfolioId,
    scopeCampaignId: r.scopeCampaignId,
    scopeProductIds: r.scopeProductId ? f.ruleProductScope.get(r.scopeProductId) ?? [r.scopeProductId] : null,
    assignedCampaignIds: f.ruleAssigned.get(r.id) ?? null,
  }, { marketplace: c.market, campaignId: c.id, portfolioId: c.portfolioId, productIds: g.productIds })).map((r) => ({ id: r.id, name: r.name }))
}

/** The scope filter on one place: a place that runs (unless `idle`: one row's detail and the history read every place). */
export function inScope(f: WasteFacts, adGroupId: string, s: WasteScope & { root?: string | null; idle?: boolean }): boolean {
  const g = f.adGroups.get(adGroupId)
  if (!g || (!g.live && !s.idle)) return false
  const c = f.campaigns.get(g.campaignId)!
  if (s.adGroupId && s.adGroupId !== g.id) return false
  if (s.campaignId && s.campaignId !== c.id) return false
  if (s.portfolioId && s.portfolioId !== c.portfolioId) return false
  if (s.root && !(f.ownership.get(c.id)?.productIds ?? []).includes(s.root)) return false
  return true
}

/** Live ad groups (other than `except`) where this term had clicks or impressions in the window and nothing blocks it. */
export function servingPlaces(f: WasteFacts, key: string, except: string | null): string[] {
  const out: string[] = []
  for (const p of f.placesByKey.get(key) ?? []) {
    if (p.adGroupId === except || !f.adGroups.get(p.adGroupId)?.live) continue
    if (!(p.servedDefault > 0)) continue
    if (blockersOf(f, p.adGroupId, key).length) continue
    out.push(p.adGroupId)
  }
  return out
}

/** Every row the facts hold for places that run inside the scope (no show, kind, owner or text filter yet). */
export function buildWasteRows(f: WasteFacts, s: WasteScope & { root?: string | null; idle?: boolean }): WasteRow[] {
  const now = f.now.getTime()
  const rows: WasteRow[] = []
  const factsFor = (adGroupId: string) => {
    const g = f.adGroups.get(adGroupId)!
    const c = f.campaigns.get(g.campaignId)!
    const own = f.ownership.get(c.id)
    const root = own?.owner.kind === 'product' ? own.owner.productId : null
    const key = root ? `${c.market}|${root}` : null
    return {
      g, c, root,
      facts: (key && f.productFacts.get(key)) || f.marketFacts.get(c.market) || { cr: null, targetCpaCents: null, targetSource: null },
      negateBar: (key && f.negateBar.get(key)) || f.marketNegateBar.get(c.market) || null,
      shared: own?.owner.kind !== 'product',
      brain: !!root && f.brainProducts.has(`${c.market}|${root}`),
      ageDays: g.firstDay == null ? null : dayIndex(f.now) - g.firstDay,
    }
  }
  const waitingFor = (adGroupId: string, campaignId: string, key: string) => f.waitingTerm.find((x) => x.key === key && (x.adGroupId === adGroupId || x.campaignId === campaignId))?.fact ?? null
  const harvestedDaysAgo = (key: string) => (f.harvestedAt.has(key) ? (now - f.harvestedAt.get(key)!) / DAY_MS : null)

  // ── Our keywords and targets ──
  for (const [adGroupId, list] of f.positivesByGroup) {
    if (!inScope(f, adGroupId, s)) continue
    const x = factsFor(adGroupId)
    for (const t of list) {
      if (t.status === 'ARCHIVED') continue
      // A focused load holds only its words' keywords and its own ad group's.
      if (f.focus && adGroupId !== f.focus.adGroupId && termKeyOf(t.expressionValue) !== f.focus.key) continue
      const tm = targetMatch(t.kind, t.expressionType)
      if (!tm) continue
      const text = labelFor(t.expressionValue, t.kind || 'UNKNOWN', t.expressionType).label
      const key = termKeyOf(t.expressionValue || text)
      // Its keyword report; else the search terms it bought here (a keyword switched on outside Nexus spends again even
      // before its own report arrives); nothing in either: no data (never "0 orders").
      const agg = f.keywords.get(t.id) ?? keywordFromTerms(f, adGroupId, t.externalTargetId)
      const bar = barFor('KEYWORD', x.facts, WASTE_WINDOW_DAYS)
      const win = agg ? numbersOf(f, agg.win, adGroupId, WASTE_WINDOW_DAYS) : null
      // Its search terms that sold in the window (orders to today), through this keyword in this ad group.
      let termsSold = 0
      if (t.externalTargetId) for (const p of f.placesByGroup.get(adGroupId) ?? []) if ((p.vias.get(t.externalTargetId)?.orders ?? 0) > 0) termsSold++
      const test = wasteTest('KEYWORD', win?.n ?? null, bar, { termsSold, stockOutDays: win?.stockOutDays ?? 0 })
      const hold = f.holds.get(t.id) ?? null
      const prot = tm.rowKind === 'KEYWORD' ? protectedBy(f, x.c.id, t.expressionValue, false) : null
      // S8 — kept paused, but Amazon serves it: someone switched it on outside Nexus. The holder still owns it.
      const state: RowState = hold ? (t.status === 'PAUSED' ? 'KEPT_PAUSED' : 'TURNED_ON_ELSEWHERE') : t.status === 'PAUSED' ? 'PAUSED' : prot ? 'PROTECTED' : 'RUNNING'
      const changes = (f.stateChanges.get(t.id) ?? []).filter(changed)
      const last = changes[changes.length - 1] ?? null
      const lastOwner = last ? ownerOfActor(last.actor, f.names, last.executionId) : null
      const waiting = f.waitingKw.get(t.id) ?? null
      const owner = rowOwner({
        hold: hold ? { by: hold.by } : null,
        waitingBy: waiting?.by ?? null,
        waitingAt: waiting?.at.getTime() ?? null,
        lastWriter: last ? { owner: lastOwner!, at: last.at.getTime() } : null,
        pausedBy: t.status === 'PAUSED' && f.lastPause.has(t.id) ? ownerOfActor(f.lastPause.get(t.id)!.actor, f.names, f.lastPause.get(t.id)!.executionId) : null,
        brainCovers: false,
        rule: rulesOn(f, adGroupId, 'pause')[0] ?? null,
      }, now, f.names)
      const refs = placeRefs(f, adGroupId, { tab: 'targets', value: t.id })
      const skip = f.skips.get(keywordRowId(t.id)) ?? null
      // A negative over our own live keyword: the fix is to remove that negative (held when Harvest or the Brain keep it).
      const blockers = state === 'TURNED_ON_ELSEWHERE' || t.status !== 'ENABLED' ? [] : ownPlaceBlockers(f, t)
      const blocker = blockers.find((n) => !negativeKeptBy(ownerOfNegative(f, n))) ?? blockers[0] ?? null
      const clash: WasteRow['clash'] = state === 'TURNED_ON_ELSEWHERE' ? { kind: 'TURNED_ON', label: CLASH_LABELS.TURNED_ON }
        : blocker ? { kind: 'NEG_OVER_OWN_KEYWORD', label: CLASH_LABELS.NEG_OVER_OWN_KEYWORD, negative: negativeRef(f, blocker) } : null
      const kept = blocker ? negativeKeptBy(clash!.negative!.owner) : null
      // A keyword that wastes keeps Pause (the Owner's job), its clash beside it (Remove negative as a second action); only
      // a keyword that does not waste gets the clash's fix — remove the negative — as its verb.
      const verb: Verb = blocker && !test.met
        ? { action: 'REMOVE_NEGATIVE', targetRowId: negRowId(blocker.id), where: blocker.negativeLevel === 'CAMPAIGN' ? 'campaign' : 'adGroup', held: kept ? { label: keptLabel(clash!.negative!.owner), reason: kept } : null }
        : verbFor({ kind: tm.rowKind, match: tm.match, text, protectedBy: prot, harvestedDaysAgo: harvestedDaysAgo(key), placeAgeDays: x.ageDays, sharedCampaign: x.shared, termsSold })
      rows.push({
        id: keywordRowId(t.id), kind: tm.rowKind, text, match: tm.match, channel: 'AMAZON', market: refs.market, currency: refs.currency,
        portfolio: refs.portfolio, campaign: refs.campaign, adGroup: refs.adGroup, product: refs.product, productCount: refs.productCount, via: null,
        state, owner,
        verb,
        test,
        d: win ? { ...win.n, xCpa: xCpaOf(win.n.spendCents, x.facts.targetCpaCents) } : null,
        d90: agg ? agg.d90 : null,
        spark: agg ? agg.spark : new Array<number>(SPARK_WEEKS).fill(0),
        stockOutDays: win?.stockOutDays ?? 0,
        waiting: waiting ? { approvalId: waiting.approvalId, by: refOfOwner(waiting.by), at: waiting.at.toISOString(), expiresAt: waiting.expiresAt?.toISOString() ?? null, rows: 1 } : null,
        skipped: skip ? { until: skip.until.toISOString(), by: skip.by, at: skip.at?.toISOString() ?? null } : null,
        stillServesIn: tm.rowKind === 'KEYWORD' ? servingPlaces(f, key, adGroupId).length : 0,
        lastChange: last ? { action: stateWord(last.after.status, last), at: last.at.toISOString(), by: refOfOwner(lastOwner!), changeId: last.id } : null,
        clash,
      })
    }
  }

  // ── Shoppers' search terms, per ad group ──
  const groupsOfTermInCampaign = new Map<string, Set<string>>()
  for (const p of f.termPlaces.values()) {
    if (!f.adGroups.get(p.adGroupId)?.live) continue
    if (!(p.clicksDefault > 0)) continue
    const k = `${p.campaignId}|${p.key}`
    groupsOfTermInCampaign.set(k, (groupsOfTermInCampaign.get(k) ?? new Set()).add(p.adGroupId))
  }
  for (const p of f.termPlaces.values()) {
    if (!inScope(f, p.adGroupId, s)) continue
    if (!(p.clicks93 > 0)) continue
    // A focused load (one row's detail) holds its words market-wide: only its own place's other terms are rows.
    if (f.focus && p.key !== f.focus.key && p.adGroupId !== f.focus.adGroupId) continue
    const x = factsFor(p.adGroupId)
    // The keyword or target that bought it: most clicks.
    const viaExt = [...p.vias].sort((a, b) => b[1].clicks - a[1].clicks || a[0].localeCompare(b[0]))[0]?.[0] ?? null
    const viaTarget = viaExt ? (f.targetByExt.get(viaExt) ?? []).find((t) => t.adGroupId === p.adGroupId && !t.isNegative) ?? null : null
    const viaMatch = viaTarget ? targetMatch(viaTarget.kind, viaTarget.expressionType)?.match ?? null : null
    // Our exact keyword's own words, bought through it: the keyword's row is this traffic (Pause, never a negative over
    // it: PLAN §2). Its close variants (other words) stay rows of their own.
    if (viaTarget && viaMatch === 'EXACT' && termKeyOf(viaTarget.expressionValue) === p.key) continue
    const rawMatch = String(p.matchType ?? '').toUpperCase()
    const match: Match = viaMatch ?? (rawMatch === 'EXACT' || rawMatch === 'PHRASE' || rawMatch === 'BROAD' ? rawMatch : 'AUTO')
    const bar = barFor('TERM', x.facts, x.negateBar?.windowDays ?? WASTE_WINDOW_DAYS, x.negateBar)
    const win = numbersOf(f, p.win[windowOf(bar.windowDays)], p.adGroupId, bar.windowDays)
    const test = wasteTest('TERM', win.n, bar, { stockOutDays: win.stockOutDays })
    const blockers = blockersOf(f, p.adGroupId, p.key)
    const prot = protectedBy(f, x.c.id, p.text, true)
    const state: RowState = blockers.length ? 'NEGATED' : prot ? 'PROTECTED' : 'RUNNING'
    const ownHere = (f.positivesByGroup.get(p.adGroupId) ?? []).some((t) => t.status !== 'ARCHIVED' && termKeyOf(t.expressionValue) === p.key)
    const waiting = blockers.length ? null : waitingFor(p.adGroupId, x.c.id, p.key)
    // A negative of this text removed here (or in its campaign) in the last 30 days.
    const retire = f.retires.filter((r) => {
      const t = f.targetById.get(r.entityId)
      return changed(r) && !!t && termKeyOf(t.expressionValue) === p.key
        && (t.adGroupId === p.adGroupId || (t.negativeLevel === 'CAMPAIGN' && f.adGroups.get(t.adGroupId)?.campaignId === x.c.id))
    }).sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? null
    const create = blockers.map((b) => f.negativeCreates.get(b.id)).filter((c): c is ChangeFact => !!c).sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? null
    const lastLog = [retire, create].filter((c): c is ChangeFact => !!c).sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? null
    const lastOwner = lastLog ? ownerOfActor(lastLog.actor, f.names, lastLog.executionId) : null
    const owner = blockers.length ? ownerOfNegative(f, blockers[0]) : rowOwner({
      waitingBy: waiting?.by ?? null,
      waitingAt: waiting?.at.getTime() ?? null,
      lastWriter: retire ? { owner: ownerOfActor(retire.actor, f.names, retire.executionId), at: retire.at.getTime() } : null,
      brainCovers: x.brain && !x.shared,
      rule: rulesOn(f, p.adGroupId, 'negate')[0] ?? null,
    }, now, f.names)
    const g = f.adGroups.get(p.adGroupId)!
    const refs = placeRefs(f, p.adGroupId, { tab: blockers.length ? 'ad-group-negative-keywords' : 'search-terms', value: p.text })
    const id = termRowId(refs.market, g.externalAdGroupId ?? g.id, p.key)
    const skip = f.skips.get(id) ?? null
    const isAsinTerm = isAsinText(p.key)
    rows.push({
      id, kind: 'TERM', text: isAsinTerm ? p.key.toUpperCase() : p.text, match, channel: 'AMAZON', market: refs.market, currency: refs.currency,
      portfolio: refs.portfolio, campaign: refs.campaign, adGroup: refs.adGroup, product: refs.product, productCount: refs.productCount,
      via: viaTarget ? { id: viaTarget.id, name: labelFor(viaTarget.expressionValue, viaTarget.kind || 'UNKNOWN', viaTarget.expressionType).label, href: adGroupHref(x.c.id, p.adGroupId, 'targets', viaTarget.id) } : null,
      state, owner,
      verb: verbFor({ kind: 'TERM', match, text: p.text, isAsinTerm, adGroupsInCampaign: groupsOfTermInCampaign.get(`${x.c.id}|${p.key}`)?.size ?? 1, protectedBy: prot, ownKeywordHere: ownHere, harvestedDaysAgo: harvestedDaysAgo(p.key), placeAgeDays: x.ageDays, sharedCampaign: x.shared }),
      test,
      d: { ...win.n, xCpa: xCpaOf(win.n.spendCents, x.facts.targetCpaCents) },
      d90: p.d90,
      spark: p.spark,
      stockOutDays: win.stockOutDays,
      waiting: waiting ? { approvalId: waiting.approvalId, by: refOfOwner(waiting.by), at: waiting.at.toISOString(), expiresAt: waiting.expiresAt?.toISOString() ?? null, rows: 1 } : null,
      skipped: skip ? { until: skip.until.toISOString(), by: skip.by, at: skip.at?.toISOString() ?? null } : null,
      stillServesIn: servingPlaces(f, p.key, p.adGroupId).length,
      lastChange: lastLog ? { action: lastLog.actionType === 'retire_negative' ? 'removed' : 'negated', at: lastLog.at.toISOString(), by: refOfOwner(lastOwner!), changeId: lastLog.id } : null,
      clash: state === 'NEGATED' && win.n.orders > 0 ? { kind: 'BLOCKS_SOLD', label: CLASH_LABELS.BLOCKS_SOLD } : null,
    })
  }
  return rows
}

/**
 * The standing negatives of the scope: an ad group's own where the ad group runs inside the scope, a campaign's where
 * one of its running ad groups is inside it. The Stopped view and the Wasting view's "negated" tile read this one list.
 */
export function negativesInScope(f: WasteFacts, s: WasteScope & { root?: string | null; idle?: boolean }): TargetFact[] {
  const out: TargetFact[] = []
  for (const [adGroupId, list] of f.negByGroup) if (inScope(f, adGroupId, s)) out.push(...list)
  const campaignsIn = new Set([...f.adGroups.values()].filter((g) => inScope(f, g.id, s)).map((g) => g.campaignId))
  for (const [campaignId, list] of f.negByCampaign) if (campaignsIn.has(campaignId)) out.push(...list)
  return out
}

/** A standing negative that blocks now: Amazon holds it (an id), it is on, and its campaign runs. */
export const blocksNow = (f: WasteFacts, n: TargetFact) => n.status === 'ENABLED' && !!n.externalTargetId && !!f.campaigns.get(f.adGroups.get(n.adGroupId)!.campaignId)?.live

/** The standing negatives that block this keyword (or product target) of ours in its own place (its ad group or campaign). */
export function ownPlaceBlockers(f: WasteFacts, t: TargetFact): TargetFact[] {
  const tm = targetMatch(t.kind, t.expressionType)
  if (!tm || (tm.rowKind === 'TARGET' && tm.match !== 'ASIN')) return []
  return blockersOf(f, t.adGroupId, termKeyOf(t.expressionValue)).filter((n) => (negativeMatch(n.kind, n.expressionType) === 'ASIN') === (tm.match === 'ASIN'))
}

/** A standing negative as a clash names it: its row, words, match, level, place and who made it. */
function negativeRef(f: WasteFacts, n: TargetFact): NonNullable<NonNullable<WasteRow['clash']>['negative']> {
  const m = negativeMatch(n.kind, n.expressionType) ?? 'EXACT'
  const refs = placeRefs(f, n.adGroupId, { tab: 'ad-group-negative-keywords', value: n.expressionValue })
  const campaignLevel = n.negativeLevel === 'CAMPAIGN'
  return {
    rowId: negRowId(n.id), text: m === 'ASIN' ? n.expressionValue.toUpperCase() : n.expressionValue, match: m,
    level: campaignLevel ? 'CAMPAIGN' : 'AD_GROUP', campaign: refs.campaign, adGroup: campaignLevel ? null : refs.adGroup, owner: ownerOfNegative(f, n),
  }
}

/** A keyword's sums from the search terms it bought in its ad group, when it has no keyword report of its own; else null. */
function keywordFromTerms(f: WasteFacts, adGroupId: string, externalTargetId: string | null): KeywordAgg | null {
  if (!externalTargetId) return null
  let found = false
  let win = NO_SUMS
  const d90 = { clicks: 0, orders: 0, spendCents: 0 }
  const spark = new Array<number>(SPARK_WEEKS).fill(0)
  for (const p of f.placesByGroup.get(adGroupId) ?? []) {
    const v = p.vias.get(externalTargetId)
    if (!v) continue
    found = true
    win = addSums(win, v.win60)
    d90.clicks += v.d90.clicks; d90.orders += v.d90.orders; d90.spendCents += v.d90.spendCents
    v.spark.forEach((x, i) => { spark[i] += x })
  }
  return found ? { win, d90, spark, spendBefore: null } : null
}

/** The criteria line: the bar in force for the scope's market, with its source and the window's days. */
export function criteriaOf(f: WasteFacts, market: string | null): WasteCriteria {
  const w = wasteWindow(f.now)
  const m = market ?? (f.markets.length === 1 ? f.markets[0] : null)
  const strategy = m ? f.marketNegateBar.get(m) ?? null : null
  const stock = 'days half or more of a place\'s advertised products were out of stock are left out of clicks and spend'
  const late = `clicks and spend to ${dayWords(w.clicksThrough)}, orders to ${dayWords(w.ordersThrough)} (a late order can only save a row)`
  return {
    source: strategy ? 'strategy' : 'default',
    windowDays: strategy?.windowDays ?? WASTE_WINDOW_DAYS,
    settledThrough: isoDay(w.clicksThrough),
    ordersThrough: isoDay(w.ordersThrough),
    sentence: strategy
      ? `Search terms follow ${strategy.by.name}: ${plural(strategy.minClicks, 'click')} or more, spend at its minimum, at most ${plural(strategy.maxOrders, 'order')}, ${strategy.windowDays} days; a product's own group wins. Keywords: 0 orders, clicks at least max(20, 3 ÷ the product's conversion rate), spend at least 2 × its target cost per order, and no search term under it sold, ${WASTE_WINDOW_DAYS} days. ${late}; ${stock}.`
      : `Search terms: 0 orders, clicks at least max(20, 3 ÷ the product's conversion rate), spend at least 1.5 × its target cost per order. Keywords: the same with 2 × and no search term under it sold. ${WASTE_WINDOW_DAYS} days; ${late}; ${stock}. No target ACoS set: a fixed bar.`,
  }
}

// ── The answers ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The markets with Sponsored Products campaigns (not archived) in this business, narrowed by a campaign, ad group or portfolio scope. */
async function adsMarkets(s: WasteScope): Promise<string[]> {
  const rows = await prisma.campaign.findMany({
    where: {
      status: { not: 'ARCHIVED' }, OR: [{ adProduct: 'SPONSORED_PRODUCTS' }, { adProduct: null, type: 'SP' }],
      ...(s.campaignId ? { id: s.campaignId } : {}), ...(s.portfolioId ? { portfolioId: s.portfolioId } : {}), ...(s.adGroupId ? { adGroups: { some: { id: s.adGroupId } } } : {}),
    },
    select: { marketplace: true }, distinct: ['marketplace'],
  })
  return [...new Set(rows.map((r) => marketCode(r.marketplace)).filter((m): m is string => !!m))].sort()
}

/**
 * The scope checked, and each market's facts (one market's are reused a short while: marketWasteFacts). No market: every
 * market with Amazon ads in this business, one market's facts each (rows keep their own market and currency).
 */
export async function scopedFacts(q: WasteScope, now: Date): Promise<{ ok: true; facts: WasteFacts[]; market: string | null; root: string | null } | { ok: false; status: 400 | 404; error: string }> {
  const scope = await checkScope(q)
  if ('error' in scope) return scope
  const markets = scope.market ? [scope.market] : await adsMarkets(q)
  const facts = await Promise.all(markets.map((m) => marketWasteFacts(m, now)))
  return { ok: true, facts, market: scope.market, root: scope.root }
}

async function scopedRows(q: WasteQuery, now: Date): Promise<{ ok: true; facts: WasteFacts[]; all: WasteRow[]; market: string | null; root: string | null } | { ok: false; status: 400 | 404; error: string }> {
  const out = await scopedFacts(q, now)
  if ('error' in out) return out
  return { ...out, all: out.facts.flatMap((f) => buildWasteRows(f, { ...q, root: out.root })) }
}

/** Several markets' criteria in one: the shared window; the bar of each market (a strategy where one names it). */
function criteriaOfAll(facts: readonly WasteFacts[], market: string | null): WasteCriteria {
  if (facts.length === 1) return criteriaOf(facts[0], market ?? facts[0].markets[0])
  const each = facts.map((f) => criteriaOf(f, f.markets[0]))
  const w = wasteWindow(facts[0]?.now ?? new Date())
  const base = criteriaOf(facts[0] ?? ({ now: new Date(), markets: [], marketNegateBar: new Map() } as unknown as WasteFacts), null)
  const strategyMarkets = facts.filter((f, i) => each[i].source === 'strategy').map((f) => f.markets[0])
  return {
    ...base,
    source: strategyMarkets.length ? 'strategy' : 'default',
    settledThrough: isoDay(w.clicksThrough),
    ordersThrough: isoDay(w.ordersThrough),
    sentence: `Every market (${facts.map((f) => f.markets[0]).join(', ') || 'none'}): each row is judged by its own market's bar. ${strategyMarkets.length ? `The ads strategy names the search-term bar in ${strategyMarkets.join(', ')}; elsewhere: ` : ''}${base.sentence}`,
  }
}

/** Freshness over several markets: the newest day of each kind any market holds, the oldest read. */
function freshnessOfAll(facts: readonly WasteFacts[]): WasteFreshness {
  const newest = (xs: Array<string | null>) => xs.filter((x): x is string => !!x).sort().at(-1) ?? null
  return {
    searchTermsThrough: newest(facts.map((f) => f.freshness.searchTermsThrough)),
    keywordsThrough: newest(facts.map((f) => f.freshness.keywordsThrough)),
    readAt: facts.map((f) => f.freshness.readAt).sort()[0] ?? new Date().toISOString(),
  }
}

/** GET /advertising/waste/rows. */
export async function readWasteRows(q: WasteQuery, now: Date = new Date()): Promise<WasteAnswer> {
  const out = await scopedRows(q, now)
  if ('error' in out) return out
  const show = q.show ?? 'wasting'
  const kind = q.kind ?? 'all'
  const filtered = out.all.filter((r) => ownerMatches(r.owner, q.owner) && textMatches(r, q.q))
  // The negated tile under the same owner and text filters as the rows: the Stopped view's own predicate (its NEGATED
  // rows), each market's added up (counts, never money). Clashes are rows (their `clash`), counted by totalsOf.
  const scope = { ...q, root: out.root }
  const negated = out.facts.reduce((n, f) => n + filterStopped(buildStoppedRows(f, scope).rows, q.owner, q.q).filter((r) => r.state === 'NEGATED').length, 0)
  const totals = totalsOf(filtered, show, { negated })
  const matching = withAskCounts(filtered).filter((r) => showMatches(r, show) && kindMatches(r, kind)).sort(compareRows(q.sort))
  const page = pageOf(matching, q.page, q.pageSize)
  return { ok: true, rows: page.rows, total: matching.length, page: page.page, pageSize: page.pageSize, totals, criteria: criteriaOfAll(out.facts, out.market), freshness: freshnessOfAll(out.facts) }
}

/** GET /advertising/waste/rows/ids — every id the same filters match (select all N). */
export async function readWasteRowIds(q: WasteQuery, now: Date = new Date()): Promise<WasteIdsAnswer> {
  const out = await scopedRows(q, now)
  if ('error' in out) return out
  const matching = out.all.filter((r) => ownerMatches(r.owner, q.owner) && textMatches(r, q.q) && showMatches(r, q.show ?? 'wasting') && kindMatches(r, q.kind ?? 'all')).sort(compareRows(q.sort))
  return { ok: true, ids: matching.slice(0, MAX_IDS).map((r) => r.id), total: matching.length, truncated: matching.length > MAX_IDS }
}

export { NO_OWNER }
