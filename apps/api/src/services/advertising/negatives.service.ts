/**
 * NEG.1 — the Negative Targeting page's one read.
 *
 * Two questions: **what am I blocking, and what is it costing me?** NEG.1 answers the first one
 * over the whole account, which no screen in this product has ever done: 2,059 negatives exist and
 * the only surfaces that list one are the two per-campaign grids you can reach solely by already
 * knowing which campaign to open.
 *
 * Read-only. It creates no negative, retires none, and changes nothing at Amazon.
 *
 * Four things live here as functions rather than inline in the route, because each is a decision
 * that goes wrong silently:
 *
 *   1. `resolveNegScope`    — market → product line → portfolio → campaign → ad group. Cascading,
 *                             most specific wins. Pure.
 *   2. `normaliseMatchType` — READ-TIME ONLY. See the block below; this is the load-bearing one.
 *   3. `attributionOf`      — four values, never blank.
 *   4. `isBlockingNow`      — an intersection of three conditions, not a status check.
 *
 * ── 🔴 Why the match type is normalised at read time and the column is never migrated ──────────
 *
 * The study (2026-08-11) measured `EXACT 1,393 · PHRASE 579 · _EXACT 32 · _PHRASE 30 ·
 * NEGATIVE_EXACT 22 · PRODUCT_EXACT 3` and called the underscore forms "a 62-row fringe".
 *
 * Re-measured 2026-08-12 while building this service, three times in ten minutes:
 *
 *   00:47   EXACT 1,184 · PHRASE 491 · _EXACT 241 · _PHRASE 118
 *   00:52   EXACT   915 · PHRASE 413 · _EXACT 510 · _PHRASE 196
 *   00:56   EXACT   759 · PHRASE 368 · _EXACT 666 · _PHRASE 241
 *
 * **The column is being rewritten as you read it**, ~65 rows a minute, and the producer is one
 * line: `ads-keyword-list-sync.service.ts:157` does
 * `(k.matchType ?? '').toUpperCase().replace('NEGATIVE', '')`, which turns Amazon's
 * `NEGATIVE_EXACT` into `_EXACT`. (`advertising.routes.ts:4881` already carries a workaround
 * comment naming "334 negative rows" with that spelling — it was 334, it is now four figures.)
 *
 * So this is not a tidy-up: **a filter written against one spelling returns a different row set
 * every few minutes.** At 00:56, `WHERE expressionType = 'EXACT'` found 745 rows and
 * `IN (EXACT, _EXACT, NEGATIVE_EXACT)` found 1,447. Normalising at read time makes this page
 * immune to the churn whether or not the writer is ever fixed, and it is why the writes are left
 * alone: three services carry correct dual-spelling probes (`ads-negative-kw.service.ts:83-88`,
 * `ads-create.service.ts:1069-1074`, `ads-coverage.service.ts:290-292`) that a migration would
 * silently invalidate.
 *
 * The law that outranks all of it: **negativity is `isNegative`, NEVER `expressionType`.** 2,037 of
 * 2,059 negatives carry a positive-sounding match type.
 */

import prisma from '../../db.js'
import { WASTING_FLOOR } from '@nexus/shared/ads-rule-window'
// One normalisation for a term across the whole codebase — the same function NEG.0's protection
// compares with, so "the term this page shows" and "the term the gate protects" cannot drift.
import { normaliseNegTerm } from './ads-protect-converting.js'

export { normaliseNegTerm }

/** Markets with production Amazon Ads connections. IE/NL/PL/SE/UK are sandbox — no listings. */
export const NEG_MARKETS = ['IT', 'DE', 'ES', 'FR'] as const

/**
 * `all` is a legitimate scope HERE, unlike on the Keyword Tracker.
 *
 * That page refuses it because market volume, rank and share are per-marketplace quantities with no
 * honest sum. Everything this page counts is a count of rows: 2,059 = IT 1,542 + DE 282 + FR 170 +
 * ES 65, and "what am I blocking" is an account-wide question before it is a per-market one. Every
 * row carries its own market so the merged view still reads.
 */
export const NEG_MARKET_ALL = 'all'
const inScopeMarket = (m: string | null | undefined, market: string): boolean =>
  market === NEG_MARKET_ALL ? NEG_MARKETS.includes((m ?? '') as (typeof NEG_MARKETS)[number]) : m === market

export type NegGrain = 'market' | 'line' | 'portfolio' | 'campaign' | 'adGroup'
export type NegView = 'negations' | 'terms'
export type NegMatchType = 'EXACT' | 'PHRASE' | 'ASIN' | 'OTHER'
export type NegLevel = 'AD_GROUP' | 'CAMPAIGN'
export type NegSortKey = 'term' | 'match' | 'scope' | 'market' | 'state' | 'amazon' | 'added' | 'by' | 'spread'

/**
 * Six spellings of three concepts, collapsed. Strip one leading underscore and one leading
 * `NEGATIVE_`, then decide. Anything unrecognised keeps its raw value and is labelled OTHER rather
 * than being forced into a bucket — a spelling this function has not seen is a fact about the
 * ingest, and hiding it inside EXACT is how the 2026-08-12 churn stayed invisible for a day.
 */
export function normaliseMatchType(expressionType: string | null | undefined, kind?: string | null): { type: NegMatchType; raw: string } {
  const raw = String(expressionType ?? '')
  const bare = raw.trim().toUpperCase().replace(/^_+/, '').replace(/^NEGATIVE_/, '')
  if (bare === 'EXACT') return { type: 'EXACT', raw }
  if (bare === 'PHRASE') return { type: 'PHRASE', raw }
  if (bare === 'PRODUCT_EXACT' || bare === 'ASIN' || kind === 'PRODUCT') return { type: 'ASIN', raw }
  return { type: 'OTHER', raw }
}

/**
 * 🔴 "Blocking now" is an intersection, not a status.
 *
 * All three must hold. Measured 2026-08-12: **942** of 2,059, where the study's headline figure of
 * 1,045 is only the third condition. 62 ARCHIVED targets and 42 rows Amazon has never confirmed
 * fall out — a negative Amazon has not acknowledged blocks nothing, whatever our row says.
 */
export function isBlockingNow(row: { status: string; externalTargetId: string | null; campaignStatus: string | null }): boolean {
  return row.status === 'ENABLED' && row.campaignStatus === 'ENABLED' && row.externalTargetId != null
}

export type NegAttribution = 'user' | 'engine' | 'unattributed' | 'actor-not-recorded'

/**
 * Four values, never blank. Measured 2026-08-12 over the 2,059: unattributed 1,225 (59.5%) ·
 * `user:anonymous` 614 · actor-not-recorded 198 · `automation:auto-harvest` 22.
 *
 * The distinction that must survive: **"we have no record" and "we have a record with no actor"
 * are different facts.** Collapsing them into "unknown" invents a third one, and it is exactly the
 * pair a retirement path in NEG.3 will need to tell apart.
 */
export function attributionOf(log: { userId: string | null } | null | undefined): { kind: NegAttribution; actor: string | null; label: string } {
  if (log === null || log === undefined) return { kind: 'unattributed', actor: null, label: 'unattributed' }
  const u = log.userId
  if (!u) return { kind: 'actor-not-recorded', actor: null, label: 'actor not recorded' }
  if (u.startsWith('automation:')) return { kind: 'engine', actor: u, label: u }
  return { kind: 'user', actor: u, label: u.startsWith('user:') ? u.slice(5) : u }
}

// ── Scope ─────────────────────────────────────────────────────────────────────────────────────

export interface NegScopeGraph {
  campaigns: Array<{ id: string; name: string; marketplace: string | null; portfolioId: string | null }>
  /** one row per AdProductAd carrying a productId, joined up to its campaign */
  ads: Array<{ productId: string | null; campaignId: string }>
  /** every advertised product with its parent — a line is a parent id; a parentless product is its own line */
  products: Array<{ id: string; parentId: string | null }>
  /** ad groups that hold at least one negative, so the fifth picker cannot offer an empty one */
  adGroups: Array<{ id: string; name: string; campaignId: string }>
}

export interface NegScopeRequest {
  market: string
  line?: string | null
  portfolio?: string | null
  campaign?: string | null
  adGroup?: string | null
}

export interface NegResolvedScope {
  boundBy: NegGrain
  campaignIds: string[]
  /** set only when the ad-group grain bound; otherwise null = every ad group in `campaignIds` */
  adGroupIds: string[] | null
  campaignsInMarket: number
  campaignsWithoutPortfolio: number
}

/**
 * market → line → portfolio → campaign → ad group, cascading, most specific wins.
 *
 * Ad group is a fifth grain specific to this page: 2,037 of 2,059 negatives are ad-group-scoped, so
 * this page's object lives at that grain and nothing coarser can address one.
 *
 * A campaign id from another market resolves to NOTHING rather than quietly overriding the market
 * picker — two controls the operator set separately cannot both be honoured, and silently
 * preferring one is how a shared link shows a different thing to the person who opens it.
 */
export function resolveNegScope(graph: NegScopeGraph, req: NegScopeRequest): NegResolvedScope {
  const inMarket = graph.campaigns.filter((c) => inScopeMarket(c.marketplace, req.market))
  const base = {
    campaignsInMarket: inMarket.length,
    campaignsWithoutPortfolio: inMarket.filter((c) => !c.portfolioId).length,
  }
  const marketIds = new Set(inMarket.map((c) => c.id))

  // ad group — the most specific, and only meaningful inside a campaign that is itself in market.
  if (req.adGroup) {
    const ag = graph.adGroups.find((g) => g.id === req.adGroup && marketIds.has(g.campaignId))
    return ag
      ? { ...base, boundBy: 'adGroup', campaignIds: [ag.campaignId], adGroupIds: [ag.id] }
      : { ...base, boundBy: 'adGroup', campaignIds: [], adGroupIds: [] }
  }

  if (req.campaign) {
    const c = inMarket.find((x) => x.id === req.campaign)
    return { ...base, boundBy: 'campaign', campaignIds: c ? [c.id] : [], adGroupIds: null }
  }

  // portfolio — `Campaign.portfolioId` is Amazon's EXTERNAL portfolio id, not a local row id.
  if (req.portfolio) {
    return { ...base, boundBy: 'portfolio', campaignIds: inMarket.filter((c) => c.portfolioId === req.portfolio).map((c) => c.id), adGroupIds: null }
  }

  // line — a Product parent id; the campaigns advertising any of its children.
  if (req.line) {
    const lineOf = new Map(graph.products.map((p) => [p.id, p.parentId ?? p.id]))
    const ids = new Set<string>()
    for (const a of graph.ads) {
      if (!a.productId || !marketIds.has(a.campaignId)) continue
      if (lineOf.get(a.productId) === req.line) ids.add(a.campaignId)
    }
    return { ...base, boundBy: 'line', campaignIds: [...ids].sort(), adGroupIds: null }
  }

  return { ...base, boundBy: 'market', campaignIds: [...marketIds].sort(), adGroupIds: null }
}

// ── Rows ──────────────────────────────────────────────────────────────────────────────────────

export interface NegationRow {
  id: string
  term: string
  /** the normalised grouping key — the same one the terms view groups on */
  termKey: string
  match: NegMatchType
  /** the raw stored spelling, so a churning column is visible rather than laundered */
  matchRaw: string
  level: NegLevel
  campaignId: string
  campaignName: string
  campaignStatus: string
  adGroupId: string
  adGroupName: string
  market: string
  status: string
  atAmazon: boolean
  blockingNow: boolean
  addedAt: string
  attribution: NegAttribution
  attributionLabel: string
  /** how far this term reaches, so a row states its own blast radius */
  spread: { rows: number; adGroups: number; campaigns: number }
}

export interface TermRow {
  termKey: string
  term: string
  rows: number
  adGroups: number
  campaigns: number
  markets: string[]
  matches: NegMatchType[]
  blockingNow: number
  notAtAmazon: number
  campaignLevel: number
  firstAddedAt: string
  lastAddedAt: string
  /** every distinct attribution over this term's rows — a term rarely has one author */
  attributions: NegAttribution[]
}

export interface NegCensus {
  negations: number
  terms: number
  /** the intersection — see `isBlockingNow` */
  blockingNow: number
  notAtAmazon: number
  inInertCampaign: number
  archived: number
  campaignLevel: number
  addedInWindow: number
}

export interface NegPayload {
  scope: {
    market: string
    boundBy: NegGrain
    line: { id: string; name: string } | null
    portfolio: { id: string; name: string } | null
    campaign: { id: string; name: string } | null
    adGroup: { id: string; name: string } | null
    resolved: { campaigns: number; adGroups: number }
    /** 🔴 what a portfolio-scoped view cannot see. null when the portfolio grain is not in play. */
    unreachable: { campaignsWithoutPortfolio: number; campaignsInMarket: number; negativesWithoutPortfolio: number; negativesTotal: number } | null
    /** the fifth picker's options — only the ad groups that actually hold a negative */
    adGroupOptions: Array<{ id: string; name: string; negatives: number }>
  }
  view: NegView
  window: { days: number; since: string }
  census: NegCensus
  /** option lists with counts, computed over the scope BEFORE the row filters — so a filter that
   *  would empty the grid says so on the control rather than by rendering nothing. */
  facets: {
    match: Array<{ value: NegMatchType; count: number }>
    level: Array<{ value: NegLevel; count: number }>
    state: Array<{ value: string; count: number }>
    amazon: Array<{ value: 'yes' | 'no'; count: number }>
    attribution: Array<{ value: NegAttribution; count: number }>
    /** every raw spelling seen, with its count — the churn, on screen */
    rawTypes: Array<{ value: string; count: number }>
  }
  rows: NegationRow[] | TermRow[]
  total: number
  truncated: boolean
  freshness: { newestAddedAt: string | null; oldestAddedAt: string | null; newestSyncedAt: string | null }
}

export interface NegRequest extends NegScopeRequest {
  view?: NegView
  q?: string | null
  match?: NegMatchType | 'all' | null
  level?: NegLevel | 'all' | null
  /**
   * Campaign state. `inert` is "anything that is not ENABLED" — paused OR archived — and it exists
   * because the census counts those together (`inInertCampaign`) and a strip cell has to be able to
   * apply the filter that reproduces its own number. Account-wide that is 1,013 paused + 1 archived;
   * a cell reading 1,014 that filtered to 1,013 would be off by one campaign nobody could find.
   */
  state?: 'live' | 'paused' | 'archived' | 'inert' | 'all' | null
  amazon?: 'yes' | 'no' | 'all' | null
  /**
   * 🔴 The three-condition intersection, as a filter.
   *
   * `state=live&amazon=yes` is NOT the same set: it checks the campaign and the Amazon id but not
   * the target's own status, so it returns 1,004 where `blockingNow` counts 942 — the 62 ARCHIVED
   * targets sitting in enabled campaigns. Measured on prod by clicking the census cell.
   *
   * The count and the filter must run the same predicate, which is why this exists rather than a
   * composition of the other two.
   */
  blocking?: 'yes' | 'no' | 'all' | null
  attribution?: NegAttribution | 'all' | null
  sort?: NegSortKey | null
  dir?: 'asc' | 'desc'
  window?: number | null
  page?: number | null
  pageSize?: number | null
}

const MAX_ROWS = 5000
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)
const tally = <T, K extends string>(xs: T[], f: (x: T) => K | null): Array<{ value: K; count: number }> => {
  const m = new Map<K, number>()
  for (const x of xs) { const k = f(x); if (k != null) m.set(k, (m.get(k) ?? 0) + 1) }
  return [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count)
}

export async function getNegatives(req: NegRequest): Promise<NegPayload> {
  const view: NegView = req.view === 'terms' ? 'terms' : 'negations'
  const windowDays = req.window && req.window > 0 ? Math.min(Math.floor(req.window), 365) : 30
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)

  // ── the scope graph. Four small reads; the campaign/ad/product shape matches the one
  // `/advertising/scope-options` returns, so the pickers cannot offer something this resolves
  // differently. Ad groups are restricted to those holding a negative — the fifth grain is this
  // page's own, and an ad-group picker offering 143 empty options would be a worse control.
  // The product graph is read ONLY when the line grain is in play. It is the most expensive part
  // of this call (every product, every ad row) and it decides nothing at the other four grains —
  // reading it unconditionally cost ~1.2s of a ~2s page load for a scope that never used it.
  const wantsLine = !!req.line && !req.campaign && !req.adGroup && !req.portfolio
  const [campaigns, negAdGroups, portfolios, ads, products] = await Promise.all([
    prisma.campaign.findMany({ select: { id: true, name: true, marketplace: true, portfolioId: true, status: true }, orderBy: { name: 'asc' } }),
    prisma.adGroup.findMany({ where: { targets: { some: { isNegative: true } } }, select: { id: true, name: true, campaignId: true }, orderBy: { name: 'asc' } }),
    prisma.amazonAdsPortfolio.findMany({ select: { externalPortfolioId: true, name: true } }),
    wantsLine ? prisma.adProductAd.findMany({ where: { productId: { not: null } }, select: { productId: true, adGroup: { select: { campaignId: true } } } }) : Promise.resolve([]),
    req.line ? prisma.product.findMany({ select: { id: true, sku: true, name: true, parentId: true } }) : Promise.resolve([]),
  ])

  const graph: NegScopeGraph = {
    campaigns,
    ads: ads.map((a) => ({ productId: a.productId, campaignId: a.adGroup?.campaignId ?? '' })).filter((a) => a.campaignId),
    products,
    adGroups: negAdGroups,
  }
  const scope = resolveNegScope(graph, req)

  // ── the base. `isNegative` is the ONLY discriminator; the campaign grain travels through the ad
  // group because AdTarget carries no campaignId — a campaign-level negative is still stored
  // hanging off an ad group, discriminated by negativeLevel.
  const negs = await prisma.adTarget.findMany({
    where: {
      isNegative: true,
      ...(scope.adGroupIds ? { adGroupId: { in: scope.adGroupIds } } : { adGroup: { campaignId: { in: scope.campaignIds } } }),
    },
    select: {
      id: true, kind: true, expressionType: true, expressionValue: true, negativeLevel: true,
      status: true, externalTargetId: true, createdAt: true, lastSyncedAt: true,
      adGroup: { select: { id: true, name: true, campaign: { select: { id: true, name: true, marketplace: true, status: true } } } },
    },
  })

  // ── attribution. Oldest-first and never overwritten, so the FIRST log for a row is the one that
  // created it. 856 logs today; joined by entityId because AdTarget carries no author column.
  const logs = negs.length
    ? await prisma.advertisingActionLog.findMany({
      where: { entityId: { in: negs.map((n) => n.id) }, actionType: { in: ['create_negative_keyword', 'create_negative_product_target'] } },
      select: { entityId: true, userId: true },
      orderBy: { createdAt: 'asc' },
    })
    : []
  const logByEntity = new Map<string, { userId: string | null }>()
  for (const l of logs) if (l.entityId && !logByEntity.has(l.entityId)) logByEntity.set(l.entityId, { userId: l.userId })

  // ── spread, computed over the SCOPE, not the account. A term row inside one campaign should
  // report what it reaches inside that campaign; the account-wide figure belongs to NEG.2's drawer,
  // where it can be labelled as such. Reporting the account number under a campaign-scoped view
  // would be a fourth number in a section whose whole discipline is not collapsing three.
  const byTerm = new Map<string, typeof negs>()
  for (const n of negs) {
    const k = normaliseNegTerm(n.expressionValue)
    const arr = byTerm.get(k) ?? []
    arr.push(n)
    byTerm.set(k, arr)
  }
  const spreadOf = (k: string) => {
    const rows = byTerm.get(k) ?? []
    return {
      rows: rows.length,
      adGroups: new Set(rows.map((r) => r.adGroup?.id).filter(Boolean)).size,
      campaigns: new Set(rows.map((r) => r.adGroup?.campaign?.id).filter(Boolean)).size,
    }
  }

  const all: NegationRow[] = negs.map((n) => {
    const mt = normaliseMatchType(n.expressionType, n.kind)
    const attr = attributionOf(logByEntity.get(n.id) ?? null)
    const campaignStatus = n.adGroup?.campaign?.status ?? null
    const termKey = normaliseNegTerm(n.expressionValue)
    return {
      id: n.id,
      term: n.expressionValue,
      termKey,
      match: mt.type,
      matchRaw: mt.raw,
      level: n.negativeLevel === 'CAMPAIGN' ? 'CAMPAIGN' : 'AD_GROUP',
      campaignId: n.adGroup?.campaign?.id ?? '',
      campaignName: n.adGroup?.campaign?.name ?? '—',
      campaignStatus: String(campaignStatus ?? '—'),
      adGroupId: n.adGroup?.id ?? '',
      adGroupName: n.adGroup?.name ?? '—',
      market: n.adGroup?.campaign?.marketplace ?? '—',
      status: String(n.status),
      atAmazon: n.externalTargetId != null,
      blockingNow: isBlockingNow({ status: String(n.status), externalTargetId: n.externalTargetId, campaignStatus }),
      addedAt: n.createdAt.toISOString(),
      attribution: attr.kind,
      attributionLabel: attr.label,
      spread: spreadOf(termKey),
    }
  })

  // ── the census: over the FULL scoped set, before any row filter. Each count is a filter the
  // client can click, so it must not be computed from a page of rows.
  const census: NegCensus = {
    negations: all.length,
    terms: byTerm.size,
    blockingNow: all.filter((r) => r.blockingNow).length,
    notAtAmazon: all.filter((r) => !r.atAmazon).length,
    inInertCampaign: all.filter((r) => r.campaignStatus !== 'ENABLED').length,
    archived: all.filter((r) => r.status !== 'ENABLED').length,
    campaignLevel: all.filter((r) => r.level === 'CAMPAIGN').length,
    addedInWindow: all.filter((r) => new Date(r.addedAt) >= since).length,
  }

  const facets: NegPayload['facets'] = {
    match: tally(all, (r) => r.match),
    level: tally(all, (r) => r.level),
    state: tally(all, (r) => r.campaignStatus),
    amazon: tally(all, (r) => (r.atAmazon ? 'yes' : 'no')),
    attribution: tally(all, (r) => r.attribution),
    rawTypes: tally(all, (r) => r.matchRaw || '(empty)'),
  }

  // ── row filters
  const q = (req.q ?? '').trim().toLowerCase()
  const filtered = all.filter((r) => {
    if (q && !r.term.toLowerCase().includes(q) && !r.campaignName.toLowerCase().includes(q) && !r.adGroupName.toLowerCase().includes(q)) return false
    if (req.match && req.match !== 'all' && r.match !== req.match) return false
    if (req.level && req.level !== 'all' && r.level !== req.level) return false
    if (req.amazon === 'yes' && !r.atAmazon) return false
    if (req.amazon === 'no' && r.atAmazon) return false
    if (req.attribution && req.attribution !== 'all' && r.attribution !== req.attribution) return false
    if (req.state === 'live' && r.campaignStatus !== 'ENABLED') return false
    if (req.state === 'paused' && r.campaignStatus !== 'PAUSED') return false
    if (req.state === 'archived' && r.campaignStatus !== 'ARCHIVED') return false
    if (req.state === 'inert' && r.campaignStatus === 'ENABLED') return false
    // The same `blockingNow` the census counted — not a re-derivation of it.
    if (req.blocking === 'yes' && !r.blockingNow) return false
    if (req.blocking === 'no' && r.blockingNow) return false
    return true
  })

  const dir = req.dir === 'asc' ? 1 : -1
  let rows: NegationRow[] | TermRow[]
  let total: number

  if (view === 'terms') {
    // 🔴 A term is a VIEW, a fan-out and an audit grouping — never a stored Amazon object. Amazon
    // has no account-level negative list; every action on a term row is N real writes with N
    // outcomes, which is why a term row carries no write action in any later section either.
    const groups = new Map<string, NegationRow[]>()
    for (const r of filtered) {
      const arr = groups.get(r.termKey) ?? []
      arr.push(r)
      groups.set(r.termKey, arr)
    }
    const termRows: TermRow[] = [...groups.entries()].map(([termKey, rs]) => ({
      termKey,
      term: rs[0].term,
      rows: rs.length,
      adGroups: new Set(rs.map((r) => r.adGroupId).filter(Boolean)).size,
      campaigns: new Set(rs.map((r) => r.campaignId).filter(Boolean)).size,
      markets: [...new Set(rs.map((r) => r.market))].sort(),
      matches: [...new Set(rs.map((r) => r.match))].sort(),
      blockingNow: rs.filter((r) => r.blockingNow).length,
      notAtAmazon: rs.filter((r) => !r.atAmazon).length,
      campaignLevel: rs.filter((r) => r.level === 'CAMPAIGN').length,
      firstAddedAt: rs.map((r) => r.addedAt).sort()[0],
      lastAddedAt: rs.map((r) => r.addedAt).sort().slice(-1)[0],
      attributions: [...new Set(rs.map((r) => r.attribution))].sort(),
    }))
    const key = req.sort ?? 'spread'
    termRows.sort((a, b) => {
      switch (key) {
        case 'term': return dir * a.termKey.localeCompare(b.termKey)
        case 'added': return dir * a.lastAddedAt.localeCompare(b.lastAddedAt)
        case 'amazon': return dir * (a.notAtAmazon - b.notAtAmazon)
        default: return dir * (a.rows - b.rows) || a.termKey.localeCompare(b.termKey)
      }
    })
    total = termRows.length
    rows = termRows.slice(0, MAX_ROWS)
  } else {
    const key = req.sort ?? 'added'
    const sorted = [...filtered].sort((a, b) => {
      switch (key) {
        case 'term': return dir * a.termKey.localeCompare(b.termKey)
        case 'match': return dir * a.match.localeCompare(b.match)
        case 'scope': return dir * (a.level.localeCompare(b.level) || a.campaignName.localeCompare(b.campaignName))
        case 'market': return dir * a.market.localeCompare(b.market)
        case 'state': return dir * a.campaignStatus.localeCompare(b.campaignStatus)
        case 'amazon': return dir * (Number(a.atAmazon) - Number(b.atAmazon))
        case 'by': return dir * a.attributionLabel.localeCompare(b.attributionLabel)
        case 'spread': return dir * (a.spread.rows - b.spread.rows)
        default: return dir * a.addedAt.localeCompare(b.addedAt)
      }
    })
    total = sorted.length
    rows = sorted.slice(0, MAX_ROWS)
  }

  const added = all.map((r) => r.addedAt).sort()
  const synced = negs.map((n) => n.lastSyncedAt).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())
  const nameOf = (id: string | null | undefined) => campaigns.find((c) => c.id === id)?.name ?? null
  const agRow = req.adGroup ? negAdGroups.find((g) => g.id === req.adGroup) : null
  const lineHead = req.line ? products.find((p) => p.id === req.line) : null
  // The portfolio id in the URL is Amazon's EXTERNAL id. Resolve it to a name where we hold one and
  // fall back to the id rather than rendering an empty label — an unnamed portfolio is a gap in the
  // portfolio ingest, and a blank chip would read as "no portfolio selected".
  const pfRow = req.portfolio ? portfolios.find((p) => p.externalPortfolioId === req.portfolio) : null

  // 🔴 The portfolio grain has a hole in it and a portfolio view must not look complete. Measured
  // 2026-08-12 account-wide: 1,310 of 2,059 negatives (64%) sit in campaigns carrying no
  // portfolioId, so no portfolio-scoped view reaches them.
  let unreachable: NegPayload['scope']['unreachable'] = null
  if (scope.boundBy === 'portfolio') {
    const marketCampaignIds = new Set(campaigns.filter((c) => inScopeMarket(c.marketplace, req.market)).map((c) => c.id))
    const noPfIds = new Set(campaigns.filter((c) => marketCampaignIds.has(c.id) && !c.portfolioId).map((c) => c.id))
    const [negativesWithoutPortfolio, negativesTotal] = await Promise.all([
      prisma.adTarget.count({ where: { isNegative: true, adGroup: { campaignId: { in: [...noPfIds] } } } }),
      prisma.adTarget.count({ where: { isNegative: true, adGroup: { campaignId: { in: [...marketCampaignIds] } } } }),
    ])
    unreachable = { campaignsWithoutPortfolio: scope.campaignsWithoutPortfolio, campaignsInMarket: scope.campaignsInMarket, negativesWithoutPortfolio, negativesTotal }
  }

  // The fifth picker's options: ad groups holding a negative inside the resolved campaigns. Counted
  // from the base this call already read, so an option can never resolve to zero rows.
  const agCounts = new Map<string, number>()
  for (const r of all) if (r.adGroupId) agCounts.set(r.adGroupId, (agCounts.get(r.adGroupId) ?? 0) + 1)
  const campaignIdSet = new Set(scope.campaignIds)
  const adGroupOptions = negAdGroups
    .filter((g) => campaignIdSet.has(g.campaignId))
    .map((g) => ({ id: g.id, name: g.name, negatives: agCounts.get(g.id) ?? 0 }))
    .sort((a, b) => b.negatives - a.negatives || a.name.localeCompare(b.name))

  return {
    scope: {
      market: req.market,
      boundBy: scope.boundBy,
      line: lineHead ? { id: lineHead.id, name: `${lineHead.sku} — ${lineHead.name}` } : null,
      portfolio: req.portfolio ? { id: req.portfolio, name: pfRow?.name ?? req.portfolio } : null,
      campaign: req.campaign ? { id: req.campaign, name: nameOf(req.campaign) ?? req.campaign } : null,
      adGroup: agRow ? { id: agRow.id, name: agRow.name } : null,
      resolved: { campaigns: scope.campaignIds.length, adGroups: new Set(all.map((r) => r.adGroupId).filter(Boolean)).size },
      unreachable,
      adGroupOptions,
    },
    view,
    window: { days: windowDays, since: since.toISOString() },
    census,
    facets,
    rows,
    total,
    truncated: total > MAX_ROWS,
    freshness: {
      newestAddedAt: added.slice(-1)[0] ?? null,
      oldestAddedAt: added[0] ?? null,
      newestSyncedAt: iso(synced.slice(-1)[0] ?? null),
    },
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// NEG.2 — the term context: everywhere one term is blocked, and what it earns.
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// One derivation, four consumers. NEG.3's removal confirm needs `performance` and `remainder`;
// NEG.4's detectors need `overlap` and `history`; the Automations inbox card needs the same
// summary; the drawer needs all of it. Three separate derivations of "what does this term do"
// would disagree, and the one that disagreed would be the one on the confirm dialog.
//
// 🔴 IT RETURNS FACTS, NOT VERDICTS. There is no `isConflict` boolean and there will not be one:
// whether an overlap is a conflict, or a dark 120-day earner is a suppressed earner, is a
// threshold decision that belongs to NEG.4. Hard-coding a policy here would force that section
// to fight this one.
//
// ── 🔴 The join this section lives or dies on ────────────────────────────────────────────────
//
// `AmazonAdsSearchTerm.adGroupId` is an **external Amazon id** (`schema.prisma:3231`).
// `AdTarget` reaches its ad group through a **local cuid**, and carries the external id one hop
// away at `adGroup.externalAdGroupId`. Joining local-to-external yields `overlap = 0` for every
// term in the account, forever — and reads exactly like good news.
//
// Measured 2026-08-12 (`scripts/_neg2-probe.mts`), deliberately computing both:
//
//     term              overlap (external↔external)   the WRONG join (external↔local)
//     giacca moto                     0                            0
//     saponette moto                  1                            1  ← the only term that differs
//     xavia                           0                            0
//
// The wrong join returns 0 for **every** term including the one true live conflict in the
// account. That is why `_neg2-termcontext.mts` asserts `saponette moto → overlap.length === 1`:
// a fixture that would pass with the join broken is not a test.
//
// Campaign-level negations are excluded from the overlap set, and not because they are awkward:
// they hang off *an* ad group in our schema for FK reasons only, so their `externalAdGroupId` is
// not a place Amazon blocks anything. All 22 of them also carry no Amazon id at all.

/** 30 · 60 · 120 days. Anything else falls back to 30. */
const TERM_WINDOWS = [30, 60, 120] as const
/** The fixed long window for the suppressed-earner case. Matches `_neg-page-conflict.mts:108`. */
const HISTORY_DAYS = 120

export interface TermProtection {
  term: string
  mode: string
  /** EXACT · PREFIX · CONTAINS — the resolved semantics, after the isPrefix fallback */
  matchType: string
  /** null = every market / every campaign. All ten live rows are unrestricted. */
  marketplace: string | null
  campaignId: string | null
  reason: string | null
}

export interface TermNegation {
  id: string
  level: NegLevel
  campaignId: string
  campaignName: string
  campaignStatus: string
  adGroupId: string
  adGroupName: string
  /** the id Amazon knows this ad group by — the ONLY key `runsIn` can be compared against */
  externalAdGroupId: string | null
  market: string
  status: string
  atAmazon: boolean
  blockingNow: boolean
  addedAt: string
  attribution: NegAttribution
  attributionLabel: string
  match: NegMatchType
  matchRaw: string
  /** whether this negation falls inside the scope the page is currently showing */
  inScope: boolean
  /** true when this ad group also took impressions for the term in the window */
  overlaps: boolean
}

export interface TermTraffic {
  externalAdGroupId: string
  adGroupName: string | null
  campaignName: string | null
  impressions: number
  clicks: number
  spendCents: number
  orders: number
  salesCents: number
  /** true when this ad group ALSO carries a negation of the term — the actual finding */
  negated: boolean
}

export interface TermPerformance {
  impressions: number
  clicks: number
  spendCents: number
  orders: number
  salesCents: number
  /** spend ÷ sales, or null when there are no sales — never 0, which would read as "free" */
  acos: number | null
}

export interface TermContext {
  term: { key: string; display: string; protectedBy: TermProtection[] }
  /** the SAME numbers the grid's spread chip shows — local ad-group ids, every negation */
  spread: { rows: number; adGroups: number; campaigns: number; markets: string[] }
  /**
   * The ad groups a traffic comparison can actually be made against: ad-group-scoped negations
   * only, counted by EXTERNAL id. Differs from `spread.adGroups` whenever the term carries a
   * campaign-level negation, which is why both are returned rather than one being chosen.
   */
  comparable: { negatedAdGroups: number; campaignLevel: number; campaignLevelAtAmazon: number }
  negations: TermNegation[]
  window: { days: number; since: string }
  performance: TermPerformance
  runsIn: TermTraffic[]
  /**
   * The intersection, at the AD GROUP grain — one entry per ad group that both negates the term
   * and took impressions for it.
   *
   * 🔴 `overlap.length` is NOT the number of writes an operator would make to clear it.
   * `overlapRows` is. Measured 2026-08-12: `saponette moto` overlaps in ONE ad group which holds
   * TWO negation rows for it (`_PHRASE` and `_EXACT`), because a single ad group can negate the
   * same term at more than one match type. Reporting "1" over two writes is the defect class this
   * page exists to stop, so both numbers are returned and NEG.3's confirm must use `overlapRows`.
   */
  overlap: TermTraffic[]
  /** negation ROWS sitting in an overlapping ad group — always ≥ `overlap.length`. */
  overlapRows: number
  history: { days: number; impressions: number; clicks: number; spendCents: number; orders: number; salesCents: number }
  remainder: { inScope: number; total: number; remainderRows: number; remainderCampaigns: number; scopeIsWholeAccount: boolean }
}

/**
 * Does a protection cover this term? Mirrors `ads-write-gate.ts:322-327` exactly, including the
 * `matchType ?? (isPrefix ? 'PREFIX' : 'EXACT')` fallback.
 *
 * Exported so the badge cannot drift from the enforcement. A drawer that says "protected" about a
 * term the gate would happily negate is worse than no badge.
 */
export function protectionsCovering(
  term: string,
  protections: Array<{ term: string; mode: string; matchType: string | null; isPrefix: boolean; marketplace: string | null; campaignId: string | null; reason: string | null }>,
): TermProtection[] {
  const key = normaliseNegTerm(term)
  if (!key) return []
  return protections
    .filter((p) => p.mode === 'WHITELIST')
    .filter((p) => {
      const t = normaliseNegTerm(p.term)
      const mode = p.matchType ?? (p.isPrefix ? 'PREFIX' : 'EXACT')
      if (mode === 'CONTAINS') return key.includes(t)
      if (mode === 'PREFIX') return key.startsWith(t)
      return key === t
    })
    .map((p) => ({
      term: p.term,
      mode: p.mode,
      matchType: p.matchType ?? (p.isPrefix ? 'PREFIX' : 'EXACT'),
      marketplace: p.marketplace,
      campaignId: p.campaignId,
      reason: p.reason,
    }))
}

export interface TermContextRequest extends NegScopeRequest {
  term: string
  window?: number | null
}

export async function getTermContext(req: TermContextRequest): Promise<TermContext | null> {
  const key = normaliseNegTerm(req.term)
  if (!key) return null
  const windowDays = TERM_WINDOWS.includes(Number(req.window) as (typeof TERM_WINDOWS)[number]) ? Number(req.window) : 30
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
  const since120 = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000)

  // Every negation of this term, ACCOUNT-WIDE and regardless of market. The drawer's whole job is
  // to show everywhere it is blocked; the scope decides what is highlighted, never what is read.
  // Fetched by the normalised key rather than by `expressionValue`, because our negatives carry
  // mixed case (`AIRMESH pant`, `giacca MOSS`) and an equality filter would miss them.
  const candidates = await prisma.adTarget.findMany({
    where: { isNegative: true },
    select: {
      id: true, kind: true, expressionType: true, expressionValue: true, negativeLevel: true,
      status: true, externalTargetId: true, createdAt: true,
      adGroup: {
        select: {
          id: true, name: true, externalAdGroupId: true,
          campaign: { select: { id: true, name: true, marketplace: true, status: true, portfolioId: true } },
        },
      },
    },
  })
  const mine = candidates.filter((n) => normaliseNegTerm(n.expressionValue) === key)
  if (mine.length === 0) return null

  // The scope, resolved exactly as the grid resolves it, so `inScope` and the grid agree by
  // construction rather than by two implementations happening to match.
  const [campaigns, negAdGroups, products, ads, protections] = await Promise.all([
    prisma.campaign.findMany({ select: { id: true, name: true, marketplace: true, portfolioId: true }, orderBy: { name: 'asc' } }),
    prisma.adGroup.findMany({ where: { targets: { some: { isNegative: true } } }, select: { id: true, name: true, campaignId: true } }),
    req.line ? prisma.product.findMany({ select: { id: true, parentId: true } }) : Promise.resolve([]),
    req.line ? prisma.adProductAd.findMany({ where: { productId: { not: null } }, select: { productId: true, adGroup: { select: { campaignId: true } } } }) : Promise.resolve([]),
    prisma.adKeywordProtection.findMany({ select: { term: true, mode: true, matchType: true, isPrefix: true, marketplace: true, campaignId: true, reason: true } }),
  ])
  const scope = resolveNegScope(
    {
      campaigns,
      adGroups: negAdGroups,
      products,
      ads: ads.map((a) => ({ productId: a.productId, campaignId: a.adGroup?.campaignId ?? '' })).filter((a) => a.campaignId),
    },
    req,
  )
  const scopeCampaigns = new Set(scope.campaignIds)
  const scopeAdGroups = scope.adGroupIds ? new Set(scope.adGroupIds) : null
  // "The whole account" means the market grain over every production market with nothing narrower.
  const scopeIsWholeAccount = scope.boundBy === 'market' && req.market === NEG_MARKET_ALL

  // Attribution — oldest-first, first log wins, same rule the inventory uses.
  const logs = await prisma.advertisingActionLog.findMany({
    where: { entityId: { in: mine.map((n) => n.id) }, actionType: { in: ['create_negative_keyword', 'create_negative_product_target'] } },
    select: { entityId: true, userId: true },
    orderBy: { createdAt: 'asc' },
  })
  const logByEntity = new Map<string, { userId: string | null }>()
  for (const l of logs) if (l.entityId && !logByEntity.has(l.entityId)) logByEntity.set(l.entityId, { userId: l.userId })

  // ── traffic, at the (query, EXTERNAL adGroupId) grain ────────────────────────────────────────
  const perAg = await prisma.amazonAdsSearchTerm.groupBy({
    by: ['adGroupId'],
    where: { date: { gte: since }, query: key },
    _sum: { impressions: true, clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
  })
  // Name the external ad groups. A traffic row we cannot name is still a fact and is kept — the
  // name is missing because the ad group is not in our mirror, which is worth seeing, not hiding.
  const trafficExtIds = perAg.map((r) => r.adGroupId)
  const named = trafficExtIds.length
    ? await prisma.adGroup.findMany({
      where: { externalAdGroupId: { in: trafficExtIds } },
      select: { externalAdGroupId: true, name: true, campaign: { select: { name: true } } },
    })
    : []
  const nameByExt = new Map(named.map((g) => [g.externalAdGroupId ?? '', { adGroupName: g.name, campaignName: g.campaign?.name ?? null }]))

  // 🔴 The overlap set: EXTERNAL ids from ad-group-scoped negations only.
  const negatedExtIds = new Set(
    mine.filter((n) => n.negativeLevel !== 'CAMPAIGN').map((n) => n.adGroup?.externalAdGroupId).filter((x): x is string => !!x),
  )

  const runsIn: TermTraffic[] = perAg.map((r) => ({
    externalAdGroupId: r.adGroupId,
    adGroupName: nameByExt.get(r.adGroupId)?.adGroupName ?? null,
    campaignName: nameByExt.get(r.adGroupId)?.campaignName ?? null,
    impressions: r._sum.impressions ?? 0,
    clicks: r._sum.clicks ?? 0,
    spendCents: Math.round(Number(r._sum.costMicros ?? 0n) / 10000),
    orders: r._sum.orders7d ?? 0,
    salesCents: r._sum.sales7dCents ?? 0,
    negated: negatedExtIds.has(r.adGroupId),
  })).sort((a, b) => b.impressions - a.impressions)
  const overlap = runsIn.filter((r) => r.negated)
  const overlapExtIds = new Set(overlap.map((r) => r.externalAdGroupId))

  const performance: TermPerformance = runsIn.reduce((a, r) => ({
    impressions: a.impressions + r.impressions,
    clicks: a.clicks + r.clicks,
    spendCents: a.spendCents + r.spendCents,
    orders: a.orders + r.orders,
    salesCents: a.salesCents + r.salesCents,
    acos: null,
  }), { impressions: 0, clicks: 0, spendCents: 0, orders: 0, salesCents: 0, acos: null as number | null })
  performance.acos = performance.salesCents > 0 ? performance.spendCents / performance.salesCents : null

  const hist = await prisma.amazonAdsSearchTerm.aggregate({
    where: { date: { gte: since120 }, query: key },
    _sum: { impressions: true, clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
  })

  // ── the negations ────────────────────────────────────────────────────────────────────────────
  const negations: TermNegation[] = mine.map((n) => {
    const mt = normaliseMatchType(n.expressionType, n.kind)
    const attr = attributionOf(logByEntity.get(n.id) ?? null)
    const campaignStatus = n.adGroup?.campaign?.status ?? null
    const localAgId = n.adGroup?.id ?? ''
    const campaignId = n.adGroup?.campaign?.id ?? ''
    const inScope = scopeAdGroups ? scopeAdGroups.has(localAgId) : scopeCampaigns.has(campaignId)
    const level: NegLevel = n.negativeLevel === 'CAMPAIGN' ? 'CAMPAIGN' : 'AD_GROUP'
    return {
      id: n.id,
      level,
      campaignId,
      campaignName: n.adGroup?.campaign?.name ?? '—',
      campaignStatus: String(campaignStatus ?? '—'),
      adGroupId: localAgId,
      adGroupName: n.adGroup?.name ?? '—',
      externalAdGroupId: n.adGroup?.externalAdGroupId ?? null,
      market: n.adGroup?.campaign?.marketplace ?? '—',
      status: String(n.status),
      atAmazon: n.externalTargetId != null,
      blockingNow: isBlockingNow({ status: String(n.status), externalTargetId: n.externalTargetId, campaignStatus }),
      addedAt: n.createdAt.toISOString(),
      attribution: attr.kind,
      attributionLabel: attr.label,
      match: mt.type,
      matchRaw: mt.raw,
      inScope,
      // A campaign-level row can never overlap: its ad group is an FK convenience, not a place
      // Amazon blocks anything.
      overlaps: n.negativeLevel !== 'CAMPAIGN' && !!n.adGroup?.externalAdGroupId && overlapExtIds.has(n.adGroup.externalAdGroupId),
    }
  }).sort((a, b) => Number(b.inScope) - Number(a.inScope) || Number(b.blockingNow) - Number(a.blockingNow) || a.campaignName.localeCompare(b.campaignName))

  const inScopeCount = negations.filter((n) => n.inScope).length
  const outOfScope = negations.filter((n) => !n.inScope)
  const campLevel = mine.filter((n) => n.negativeLevel === 'CAMPAIGN')

  return {
    term: {
      key,
      // The stored spelling of the most recent row — what an operator will recognise.
      display: mine.map((n) => n.expressionValue).sort()[0] ?? key,
      protectedBy: protectionsCovering(key, protections),
    },
    spread: {
      rows: mine.length,
      // Local ad-group ids over EVERY negation — deliberately the same computation the grid's
      // spread chip uses, so the chip you clicked and the drawer it opened cannot disagree.
      adGroups: new Set(mine.map((n) => n.adGroup?.id).filter(Boolean)).size,
      campaigns: new Set(mine.map((n) => n.adGroup?.campaign?.id).filter(Boolean)).size,
      markets: [...new Set(mine.map((n) => n.adGroup?.campaign?.marketplace).filter((x): x is string => !!x))].sort(),
    },
    comparable: {
      negatedAdGroups: negatedExtIds.size,
      campaignLevel: campLevel.length,
      campaignLevelAtAmazon: campLevel.filter((n) => n.externalTargetId != null).length,
    },
    negations,
    window: { days: windowDays, since: since.toISOString() },
    performance,
    runsIn,
    overlap,
    overlapRows: negations.filter((n) => n.overlaps).length,
    history: {
      days: HISTORY_DAYS,
      impressions: hist._sum.impressions ?? 0,
      clicks: hist._sum.clicks ?? 0,
      spendCents: Math.round(Number(hist._sum.costMicros ?? 0n) / 10000),
      orders: hist._sum.orders7d ?? 0,
      salesCents: hist._sum.sales7dCents ?? 0,
    },
    remainder: {
      inScope: inScopeCount,
      total: negations.length,
      remainderRows: outOfScope.length,
      remainderCampaigns: new Set(outOfScope.map((n) => n.campaignId).filter(Boolean)).size,
      scopeIsWholeAccount,
    },
  }
}

/**
 * NEG-P3 — the Negative Targeting tab's strip: the account's negation posture in one line.
 * `candidates` counts terms at the SAME floor the SEARCH_TERM_WASTING emitter applies
 * (WASTING_FLOOR — one declaration, three readers), so the number the operator sees is exactly
 * the number a new rule could act on. Cheap by construction: two counts + one groupBy.
 */
export async function getNegativesStrip(): Promise<{ negatives: number; blocking: number; candidates: number; wastedCents: number }> {
  const since = new Date(Date.now() - 32 * 864e5)
  const until = new Date(Date.now() - 2 * 864e5)
  const [negatives, blocking, terms] = await Promise.all([
    prisma.adTarget.count({ where: { isNegative: true } }),
    // "blocking" = the intersection the census pinned: target ENABLED ∧ campaign ENABLED ∧ confirmed at Amazon.
    prisma.adTarget.count({ where: { isNegative: true, status: 'ENABLED', externalTargetId: { not: null }, adGroup: { campaign: { status: 'ENABLED' } } } }),
    prisma.amazonAdsSearchTerm.groupBy({
      by: ['query', 'campaignId', 'adGroupId', 'marketplace'],
      where: { date: { gte: since, lte: until } },
      _sum: { orders7d: true, clicks: true, costMicros: true },
      having: { orders7d: { _sum: { equals: 0 } } },
    }),
  ])
  const cands = terms
    .map((t) => ({ spend: Math.round(Number(t._sum.costMicros ?? 0) / 10000), clicks: t._sum.clicks ?? 0 }))
    .filter((x) => x.spend >= WASTING_FLOOR.minSpendCents && x.clicks >= WASTING_FLOOR.minClicks)
  return { negatives, blocking, candidates: cands.length, wastedCents: cands.reduce((s, c) => s + c.spend, 0) }
}
