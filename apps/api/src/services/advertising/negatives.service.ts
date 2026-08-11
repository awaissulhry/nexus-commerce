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
// One normalisation for a term across the whole codebase — the same function NEG.0's protection
// compares with, so "the term this page shows" and "the term the gate protects" cannot drift.
import { normaliseNegTerm } from './ads-protect-converting.js'

export { normaliseNegTerm }

/** Markets with production Amazon Ads connections. IE/NL/PL/SE/UK are sandbox — no listings. */
export const NEG_MARKETS = ['IT', 'DE', 'ES', 'FR'] as const

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
  const inMarket = graph.campaigns.filter((c) => c.marketplace === req.market)
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
  /** campaign state */
  state?: 'live' | 'paused' | 'archived' | 'all' | null
  amazon?: 'yes' | 'no' | 'all' | null
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
    const marketCampaignIds = new Set(campaigns.filter((c) => c.marketplace === req.market).map((c) => c.id))
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
