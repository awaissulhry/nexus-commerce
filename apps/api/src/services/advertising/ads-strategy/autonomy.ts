/**
 * ADS AUTONOMY W2 (AA-W2-2) — what an ad change Claude asks for reads about where it lands, so a change that may run by
 * the business's rule carries the facts its limits are judged on (agents/tools/ads-autonomy-kit.ts holds the pure
 * checks). Reads only; nothing here writes.
 *
 *   scope      each entity's market, campaign, ad group and the strategy subject it resolves through: a target or a
 *              search term → its ad group (every product the ad group advertises: the SAFER value per field, W1's
 *              resolver); an ad group → itself; a campaign → every product of every ad group of it; a product ad → its
 *              own product; a new campaign → its products in its market. Each market is opened ONCE (openStrategy).
 *   limits     per subject, the strategy numbers a W2 tool is held to — the bid band and the largest change (W1-5's
 *              limitsOf), protection, the stop bid, the negate and harvest groups, and what Claude may do alone for the
 *              change's kind — each with the strategy row that gave it.
 *   engines    the enabled rules and schedules (hourly bid plans) bound to a campaign: they move it on their own.
 *   protected  a negative that meets a protected term or a protected product's ASIN (the one negation policy).
 *   month      an UPPER bound of a market's spend this month: what Amazon's daily reports hold (whole days, never today;
 *              they arrive about a day late) plus every enabled campaign's full daily budget for each day they do not
 *              cover yet — against the lower of the strategy's market cap and this month's budget plan.
 *
 * Every query goes through the business-scoped client: row-level security keeps each read in the business of the call.
 */
import { createHash } from 'node:crypto'
import { budgetDayStart } from '@nexus/shared/ads-budget-day'
import prisma from '../../../db.js'
import { marketplaceCodeToId } from '../../../utils/marketplace-code.js'
import type { ClaudeTrust } from '../../agents/tool-types.js'
import { EXCLUDE_AMS_DAILY } from '../../ads-core/ams-daily.js'
import { normaliseTerm, protectedNegativeRefusal } from '../ads-negation-policy.js'
import { automationsBoundToCampaign } from '../rule-campaign-binding.service.js'
import { limitsOf, strategyMarket, type StrategyBidLimits } from './bids.js'
import { openStrategy, type EffectiveStrategy, type StrategyView } from './effective.js'
import type { ClaudeActionType } from './fields.js'
import { marketBudgetPlan } from './load.js'
import type { StrategyIndex, StrategySource } from './resolve.js'
import { strategyWords } from './source-words.js'

// ── Entities and where they land ──────────────────────────────────────────────────────────────────

/**
 * An entity a change touches. A search term is named as Amazon names it (its campaign, its ad group, the query); a new
 * campaign, which does not exist yet, by its products in its market.
 */
export type AdEntityRef =
  | { kind: 'campaign' | 'adGroup' | 'target' | 'productAd'; id: string }
  | { kind: 'searchTerm'; query: string; externalCampaignId: string; externalAdGroupId?: string | null }
  | { kind: 'products'; market: string; productIds: readonly string[] }

/** One key per entity, the same in every preview: `target:<id>`, `searchTerm:<campaign>:<ad group|*>:<query>`. */
export function entityKey(ref: AdEntityRef): string {
  if (ref.kind === 'searchTerm') return `searchTerm:${ref.externalCampaignId}:${ref.externalAdGroupId || '*'}:${normaliseTerm(ref.query)}`
  if (ref.kind === 'products') return `products:${String(strategyMarket(ref.market) ?? ref.market)}:${[...new Set(ref.productIds)].sort().join(',')}`
  return `${ref.kind}:${ref.id}`
}

export interface EntityScope {
  key: string
  kind: AdEntityRef['kind']
  /** What a person reads: `target "race jacket"`, `campaign "Italy exact"`. */
  label: string
  /** The strategy's market code ('IT'); null when Nexus cannot place it (`unplaced` says why). */
  market: string | null
  campaignId: string | null
  adGroupId: string | null
  /** The campaign's own budget currency (minor units are never converted). */
  currency: string | null
  /** The strategy subject it resolves through, within its market: `adGroup:<id>`, `campaign:<id>`, `product:<id>`, `products:<ids>`. */
  subject: string | null
  unplaced?: string
}

type CampaignBits = { name?: string; marketplace: string | null; dailyBudgetCurrency: string | null }
const currencyOf = (c: CampaignBits | null | undefined) => c?.dailyBudgetCurrency?.trim() || (c ? 'EUR' : null)

/** Where each entity lands, read in batches: one query per kind of entity. */
export async function resolveEntityScopes(refs: readonly AdEntityRef[]): Promise<Map<string, EntityScope>> {
  const out = new Map<string, EntityScope>()
  const idsOf = (kind: 'campaign' | 'adGroup' | 'target' | 'productAd') =>
    [...new Set(refs.filter((r): r is Extract<AdEntityRef, { id: string }> => r.kind === kind).map((r) => r.id))]
  const terms = refs.filter((r): r is Extract<AdEntityRef, { kind: 'searchTerm' }> => r.kind === 'searchTerm')
  const campaignSelect = { name: true, marketplace: true, dailyBudgetCurrency: true } as const
  const [targets, groups, campaigns, ads, termCampaigns, termGroups] = await Promise.all([
    idsOf('target').length
      ? prisma.adTarget.findMany({ where: { id: { in: idsOf('target') } }, select: { id: true, expressionValue: true, adGroupId: true, adGroup: { select: { campaignId: true, campaign: { select: campaignSelect } } } } })
      : [],
    idsOf('adGroup').length
      ? prisma.adGroup.findMany({ where: { id: { in: idsOf('adGroup') } }, select: { id: true, name: true, campaignId: true, campaign: { select: campaignSelect } } })
      : [],
    idsOf('campaign').length ? prisma.campaign.findMany({ where: { id: { in: idsOf('campaign') } }, select: { id: true, ...campaignSelect } }) : [],
    idsOf('productAd').length
      ? prisma.adProductAd.findMany({ where: { id: { in: idsOf('productAd') } }, select: { id: true, sku: true, asin: true, productId: true, adGroupId: true, adGroup: { select: { campaignId: true, campaign: { select: campaignSelect } } } } })
      : [],
    terms.length
      ? prisma.campaign.findMany({ where: { externalCampaignId: { in: [...new Set(terms.map((t) => t.externalCampaignId))] } }, select: { id: true, externalCampaignId: true, ...campaignSelect }, orderBy: { id: 'asc' } })
      : [],
    terms.some((t) => t.externalAdGroupId)
      ? prisma.adGroup.findMany({
        where: { externalAdGroupId: { in: [...new Set(terms.map((t) => t.externalAdGroupId).filter((id): id is string => !!id))] } },
        select: { id: true, externalAdGroupId: true, campaign: { select: { externalCampaignId: true } } },
      })
      : [],
  ])
  const place = (key: string, kind: EntityScope['kind'], label: string, campaign: CampaignBits | null, ids: { campaignId: string | null; adGroupId: string | null }, subject: string | null): EntityScope => {
    const market = strategyMarket(campaign?.marketplace)
    return {
      key, kind, label, market, ...ids, currency: currencyOf(campaign), subject: market ? subject : null,
      ...(market ? {} : { unplaced: `${label}: its campaign has no market in Nexus` }),
    }
  }
  const missing = (key: string, kind: EntityScope['kind'], label: string): EntityScope =>
    ({ key, kind, label, market: null, campaignId: null, adGroupId: null, currency: null, subject: null, unplaced: `${label} was not found in this business` })

  const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]))
  const targetRows = byId(targets), groupRows = byId(groups), campaignRows = byId(campaigns), adRows = byId(ads)
  for (const ref of refs) {
    const key = entityKey(ref)
    if (out.has(key)) continue
    switch (ref.kind) {
      case 'target': {
        const t = targetRows.get(ref.id)
        out.set(key, t
          ? place(key, 'target', `target "${t.expressionValue}"`, t.adGroup.campaign, { campaignId: t.adGroup.campaignId, adGroupId: t.adGroupId }, `adGroup:${t.adGroupId}`)
          : missing(key, 'target', `target ${ref.id}`))
        break
      }
      case 'adGroup': {
        const g = groupRows.get(ref.id)
        out.set(key, g ? place(key, 'adGroup', `ad group "${g.name}"`, g.campaign, { campaignId: g.campaignId, adGroupId: g.id }, `adGroup:${g.id}`) : missing(key, 'adGroup', `ad group ${ref.id}`))
        break
      }
      case 'campaign': {
        const c = campaignRows.get(ref.id)
        out.set(key, c ? place(key, 'campaign', `campaign "${c.name}"`, c, { campaignId: c.id, adGroupId: null }, `campaign:${c.id}`) : missing(key, 'campaign', `campaign ${ref.id}`))
        break
      }
      case 'productAd': {
        const a = adRows.get(ref.id)
        const label = `the ad of ${a?.sku ?? a?.asin ?? ref.id}`
        // An ad Nexus cannot tie to a product holds to its ad group (its products together), as an unknown ad does there.
        out.set(key, a
          ? place(key, 'productAd', label, a.adGroup.campaign, { campaignId: a.adGroup.campaignId, adGroupId: a.adGroupId }, a.productId ? `product:${a.productId}` : `adGroup:${a.adGroupId}`)
          : missing(key, 'productAd', label))
        break
      }
      case 'searchTerm': {
        const c = termCampaigns.find((row) => row.externalCampaignId === ref.externalCampaignId) ?? null
        const label = `search term "${ref.query.trim()}"`
        if (!c) { out.set(key, missing(key, 'searchTerm', label)); break }
        const g = ref.externalAdGroupId ? termGroups.find((row) => row.externalAdGroupId === ref.externalAdGroupId && row.campaign.externalCampaignId === ref.externalCampaignId) : undefined
        out.set(key, place(key, 'searchTerm', label, c, { campaignId: c.id, adGroupId: g?.id ?? null }, g ? `adGroup:${g.id}` : `campaign:${c.id}`))
        break
      }
      case 'products': {
        const market = strategyMarket(ref.market)
        const ids = [...new Set(ref.productIds)].sort()
        const label = `a new campaign for ${ids.length} product${ids.length === 1 ? '' : 's'}`
        out.set(key, {
          key, kind: 'products', label, market, campaignId: null, adGroupId: null, currency: null,
          subject: market && ids.length ? `products:${ids.join(',')}` : market ? 'market' : null,
          ...(market ? {} : { unplaced: `${label}: it names no market` }),
        })
        break
      }
    }
  }
  return out
}

// ── The strategy where it lands ───────────────────────────────────────────────────────────────────

/** The strategy numbers a W2 tool is held to at one subject; a key is absent when no row sets it there. */
export interface ScopeLimits {
  minBidCents?: number
  maxBidCents?: number
  maxChangePct?: number
  /** True: a product here is protected (one protected product protects its ad group). False: opted out. */
  protect?: boolean
  stopBidCents?: number
  negateMinClicks?: number
  negateMinSpendCents?: number
  negateMaxOrders?: number
  negateWindowDays?: number
  harvestMinOrders?: number
  harvestMinClicks?: number
  harvestMaxAcosPct?: number | null
  harvestWindowDays?: number
  /** What Claude may do alone for the change's kind of action here (W1-8): the strategy narrows, never widens. */
  claudeLevel?: ClaudeTrust
}

/** Which row gave a limit: per single limit, and per group (a stop, a negate and a harvest group come whole from one row). */
export type ScopeLimitSource = 'minBidCents' | 'maxBidCents' | 'maxChangePct' | 'protect' | 'stop' | 'negate' | 'harvest' | 'claudeLevel'

export interface ScopeStrategy {
  limits: ScopeLimits
  sources: Partial<Record<ScopeLimitSource, StrategySource>>
}

/**
 * Pure: the limits of one resolved subject. The resolver already took the SAFER value per field across the products of
 * an ad group or a campaign and named the product it came from (resolve.ts); this only picks the fields W2 reads.
 */
export function scopeLimitsOf(e: EffectiveStrategy, action: ClaudeActionType | null): ScopeStrategy {
  const limits: ScopeLimits = {}
  const sources: ScopeStrategy['sources'] = {}
  const bids = limitsOf(e)
  for (const key of ['minBidCents', 'maxBidCents', 'maxChangePct'] as const) {
    const limit = bids[key]
    if (limit) { limits[key] = limit.value; sources[key] = limit.source }
  }
  const sourceOf = (key: 'protect' | 'stop' | 'negate' | 'harvest') => e.resolved.fields.get(key)?.source ?? null
  const protect = sourceOf('protect')
  if (e.values.protect != null && protect) { limits.protect = e.values.protect; sources.protect = protect }
  const stop = sourceOf('stop')
  if (e.values.stop && stop) { limits.stopBidCents = e.values.stop.bidCents; sources.stop = stop }
  const negate = sourceOf('negate')
  if (e.values.negate && negate) {
    Object.assign(limits, { negateMinClicks: e.values.negate.minClicks, negateMinSpendCents: e.values.negate.minSpendCents, negateMaxOrders: e.values.negate.maxOrders, negateWindowDays: e.values.negate.windowDays })
    sources.negate = negate
  }
  const harvest = sourceOf('harvest')
  if (e.values.harvest && harvest) {
    Object.assign(limits, { harvestMinOrders: e.values.harvest.minOrders, harvestMinClicks: e.values.harvest.minClicks, harvestMaxAcosPct: e.values.harvest.maxAcosPct, harvestWindowDays: e.values.harvest.windowDays })
    sources.harvest = harvest
  }
  const level = action ? e.resolved.autonomy.get(action) : undefined
  if (typeof level?.value === 'string' && level.source) { limits.claudeLevel = level.value as ClaudeTrust; sources.claudeLevel = level.source }
  return { limits, sources }
}

/** A subject's bid limits back in W1-5's shape, for its band and step arithmetic (clampToStrategy, stepClamp). */
export function bidLimitsOfScope(s: Pick<ScopeStrategy, 'limits' | 'sources'>): StrategyBidLimits {
  const limit = (key: 'minBidCents' | 'maxBidCents' | 'maxChangePct') => {
    const value = s.limits[key]
    const source = s.sources[key]
    return value != null && source ? { value, source } : null
  }
  return { minBidCents: limit('minBidCents'), maxBidCents: limit('maxBidCents'), maxChangePct: limit('maxChangePct') }
}

/**
 * Claude's daily limits of changes run by rule in one market (design §5, Owner decision D-W2-3): writes, raises and
 * budget increases a day, each under its own key (a money value never sits under a generic key: the money filter strips
 * it by name). 🔴 The ads strategy holds no field for them yet (W1 did not add one), so each reads as not set: a raise
 * or a budget increase waits for a person, and writes have no daily number beyond the business's cap of runs by rule.
 * When the strategy gains them, this reads them from the market's row, with its source.
 */
export interface DailyLimits {
  maxWritesPerDay: number | null
  maxRaisesPerDay: number | null
  maxBudgetIncreasePerDayCents: number | null
  sources: Partial<Record<'maxWritesPerDay' | 'maxRaisesPerDay' | 'maxBudgetIncreasePerDayCents', StrategySource>>
}

export function dailyLimitsOf(_market: EffectiveStrategy): DailyLimits {
  return { maxWritesPerDay: null, maxRaisesPerDay: null, maxBudgetIncreasePerDayCents: null, sources: {} }
}

/** One market's strategy as W2 reads it. */
export interface MarketStrategy {
  market: string
  /** A fingerprint of every usable row of the market (id and version): it changes when any of them changes. Null: none. */
  version: string | null
  /** The most actions one run may take in this market (the market row only). */
  maxActionsPerRun: { value: number; source: StrategySource } | null
  daily: DailyLimits
  view: StrategyView
}

/** Pure: the fingerprint of a market's rows; null when the market has none. */
export function strategyVersionOf(index: Pick<StrategyIndex, 'rows'>): string | null {
  if (!index.rows.length) return null
  const rows = [...index.rows].sort((a, b) => (a.id < b.id ? -1 : 1)).map((r) => `${r.id}@${r.version}`)
  return createHash('sha256').update(rows.join('|')).digest('hex').slice(0, 12)
}

/**
 * The strategy of every market the scopes land in (each opened once) and the limits of every subject, keyed
 * `<market>|<subject>`. A scope without a market is left out (the kit refuses it as unplaced).
 */
export async function strategyForScopes(scopes: Iterable<EntityScope>, action: ClaudeActionType | null): Promise<{ markets: Map<string, MarketStrategy>; subjects: Map<string, ScopeStrategy> }> {
  const bySubject = new Map<string, Set<string>>()
  for (const s of scopes) if (s.market && s.subject) bySubject.set(s.market, (bySubject.get(s.market) ?? new Set()).add(s.subject))
  const markets = new Map<string, MarketStrategy>()
  const subjects = new Map<string, ScopeStrategy>()
  for (const [market, wanted] of bySubject) {
    const view = await openStrategy(market)
    const atMarket = view.forMarket()
    const runs = atMarket.resolved.fields.get('maxActionsPerRun')
    markets.set(market, {
      market,
      version: strategyVersionOf(view.index),
      maxActionsPerRun: typeof runs?.value === 'number' && runs.source ? { value: runs.value, source: runs.source } : null,
      daily: dailyLimitsOf(atMarket),
      view,
    })
    const of = (prefix: string) => [...wanted].filter((s) => s.startsWith(prefix)).map((s) => s.slice(prefix.length))
    const resolved = new Map<string, EffectiveStrategy>()
    const [adGroups, campaigns, products] = [of('adGroup:'), of('campaign:'), of('product:')]
    if (adGroups.length) for (const [id, e] of await view.forAdGroups(adGroups)) resolved.set(`adGroup:${id}`, e)
    if (campaigns.length) for (const [id, e] of await view.forCampaigns(campaigns)) resolved.set(`campaign:${id}`, e)
    if (products.length) for (const [id, e] of await view.forEachProduct(products)) resolved.set(`product:${id}`, e)
    for (const ids of of('products:')) resolved.set(`products:${ids}`, await view.forProducts(ids.split(',')))
    // A subject the market cannot resolve (an ad group or a product since removed) holds to the market's own row.
    for (const subject of wanted) subjects.set(`${market}|${subject}`, scopeLimitsOf(resolved.get(subject) ?? atMarket, action))
  }
  return { markets, subjects }
}

// ── Engines and protection ───────────────────────────────────────────────────────────────────────

/** The enabled rules and schedules (hourly bid plans, dayparting) bound to each campaign, by name; campaigns without any left out. */
export async function enginesOnCampaigns(campaignIds: Iterable<string>): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  await Promise.all([...new Set(campaignIds)].map(async (id) => {
    const { rules, schedules } = await automationsBoundToCampaign(id)
    const names = [...rules.map((r) => `rule "${r.name}"`), ...schedules.map((s) => `schedule "${s.name}"`)]
    if (names.length) out.set(id, names)
  }))
  return out
}

/**
 * Why a negative meets a protected term or a protected product's ASIN here, or null — the one negation policy, judged as
 * a machine's write (a change run by rule never confirms past the Owner's protection).
 */
export async function protectedNegativeWhy(args: { term: string; matchType?: string | null; market: string | null; campaignId: string | null }): Promise<string | null> {
  const hit = await protectedNegativeRefusal({ text: args.term, matchType: args.matchType, marketplace: args.market, campaignId: args.campaignId })
  return hit?.reason ?? null
}

// ── The month ────────────────────────────────────────────────────────────────────────────────────

export interface MonthProjection {
  month: string
  currency: string
  /** Spend this month in Amazon's daily reports, whole days through `spendThrough` (null: no report this month yet). */
  spentCents: number
  spendThrough: string | null
  /** Days of the month the reports do not cover yet, today included. */
  uncoveredDays: number
  /** Days from today to the month's last day, today included: what a new or higher daily budget can still spend. */
  daysLeft: number
  /** The daily budgets of the market's enabled campaigns, together. */
  budgetsCents: number
  /** The upper bound now: spent + budgets × uncovered days. */
  projectedCents: number
  /** The daily budget this change adds (negative: removes). */
  addedDailyCents: number
  /** The upper bound with this change: projected + added × days left (never below what is spent). */
  afterCents: number
  /** The cap in force (the lower of the strategy's market cap and this month's budget plan; 0 is no cap), and which. */
  capCents: number | null
  capFrom: string | null
}

const MONTH = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`

/** Pure: the month's upper bound from what the reports hold and the budgets that can still spend. */
export function projectMonth(input: {
  today: Date
  spentCents: number
  spendThrough: string | null
  budgetsCents: number
  addedDailyCents: number
  cap: { cents: number; from: string } | null
  currency: string
}): MonthProjection {
  const day = budgetDayStart(input.today)
  const month = MONTH(day)
  const daysInMonth = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0)).getUTCDate()
  const through = input.spendThrough && input.spendThrough.slice(0, 7) === month ? Number(input.spendThrough.slice(8, 10)) : 0
  const uncoveredDays = Math.max(0, daysInMonth - through)
  const daysLeft = daysInMonth - day.getUTCDate() + 1
  const projectedCents = input.spentCents + input.budgetsCents * uncoveredDays
  return {
    month,
    currency: input.currency,
    spentCents: input.spentCents,
    spendThrough: through ? input.spendThrough!.slice(0, 10) : null,
    uncoveredDays,
    daysLeft,
    budgetsCents: input.budgetsCents,
    projectedCents,
    addedDailyCents: input.addedDailyCents,
    afterCents: Math.max(input.spentCents, projectedCents + input.addedDailyCents * daysLeft),
    capCents: input.cap?.cents ?? null,
    capFrom: input.cap?.from ?? null,
  }
}

/** The market codes a market's rows may be stored under: the code, and Amazon's marketplace id (older rows). */
const marketForms = (market: string) => [market, marketplaceCodeToId(market)].filter((m): m is string => !!m)

/**
 * Each market's month (pure arithmetic in projectMonth): this month's report spend, the enabled campaigns' budgets, and
 * the cap — the strategy's market cap (the market row; a cap of 0 is no cap) and this month's budget plan, the lower.
 */
export async function monthProjections(
  markets: ReadonlyArray<{ market: string; view: StrategyView | null; addedDailyCents: number }>,
  now = new Date(),
): Promise<Map<string, MonthProjection>> {
  const out = new Map<string, MonthProjection>()
  const day = budgetDayStart(now)
  const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1))
  const end = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 1))
  for (const { market, view, addedDailyCents } of markets) {
    const forms = marketForms(market)
    const [spend, campaigns, plan] = await Promise.all([
      prisma.amazonAdsDailyPerformance.aggregate({
        where: { entityType: 'CAMPAIGN', marketplace: { in: forms }, date: { gte: start, lt: end }, ...EXCLUDE_AMS_DAILY },
        _sum: { costMicros: true },
        _max: { date: true },
      }),
      prisma.campaign.findMany({ where: { marketplace: { in: forms }, status: 'ENABLED' }, select: { dailyBudget: true, dailyBudgetCurrency: true } }),
      marketBudgetPlan(market, MONTH(day)),
    ])
    const strategyCap = view && !view.empty
      ? view.forMarket().values.monthlyCaps.find((c) => c.source.level === 'market' && c.monthlySpendCapCents > 0) ?? null
      : null
    const planCap = plan && plan.monthlyBudgetCents > 0 ? plan.monthlyBudgetCents : null
    const cap = strategyCap && (planCap == null || strategyCap.monthlySpendCapCents <= planCap)
      ? { cents: strategyCap.monthlySpendCapCents, from: strategyWords(strategyCap.source) }
      : planCap != null ? { cents: planCap, from: `the budget plan ${plan!.month}` } : null
    out.set(market, projectMonth({
      today: now,
      spentCents: Math.round(Number(spend._sum.costMicros ?? 0) / 10_000),
      spendThrough: spend._max.date ? new Date(spend._max.date).toISOString().slice(0, 10) : null,
      budgetsCents: campaigns.reduce((sum, c) => sum + Math.round(Number(c.dailyBudget ?? 0) * 100), 0),
      addedDailyCents,
      cap,
      currency: campaigns[0]?.dailyBudgetCurrency?.trim() || 'EUR',
    }))
  }
  return out
}
