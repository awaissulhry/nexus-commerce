/**
 * ADS AUTONOMY W1-2 — the three reads of the Amazon Ads strategy, shared by Claude's `ads-strategy` tool and the GET
 * routes (advertising-strategy.routes.ts):
 *
 *   effective  for a market, a category, a product, a campaign or an ad group: every number in force with the row it
 *              came from (for one subject, every row consulted on the way), the older settings that also bind
 *              (`alsoInForce`, and which would be `stricter`), the campaigns whose own target ACoS wins over the
 *              strategy, and what Claude may do alone per kind of ad action
 *   rows       every strategy row of a market (rows whose category or product is gone flagged), and the older settings
 *              at the same grains (market and line bid policies and harvest policies, this month's budget plan)
 *   history    the versions of a market's rows, or of one category's or product's, newest first
 *
 * Honest by construction: every field carries its `readBy` from the registry (fields.ts) — what acts on it today
 * (W1-7: the search-term thresholds and protection; W1-8: Claude's door reads what Claude may do alone). Until an
 * engine reads a field, only the older settings under `alsoInForce` bind.
 *
 * Money (targets, bids, caps, spend thresholds) sits ONLY under the keys in STRATEGY_MONEY, alone, so the money filter
 * removes exactly the money and keeps where it comes from. Free text written by people beside an older setting (a bid
 * policy's label) is left out: it may quote an amount.
 */
import prisma from '../../../db.js'
import type { ClaudeTrust } from '../../agents/tool-types.js'
import { resolveBidPolicy } from '../ads-write-gate.js'
import { currentMonth } from '../ads-budget-manager.service.js'
import { resolveHarvestPolicy } from '../harvest-policy.service.js'
import { accountDefaultFraction, readOwnerTargets, targetFraction } from '../ads-target-acos-resolver.js'
import {
  CLAUDE_ACTION_TOOLS,
  CLAUDE_ACTION_TYPES,
  CLAUDE_LEVELS,
  STRATEGY_FIELDS,
  STRATEGY_LEVELS,
  fractionToPct,
  harvestStricter,
  notReadYet,
  type StrategyField,
} from './fields.js'
import { openStrategy } from './effective.js'
import {
  bidPolicies,
  campaignMarkets,
  findCategory,
  findLiveProduct,
  harvestPolicies,
  loadAdGroups,
  loadCampaigns,
  loadCatalog,
  loadIndex,
  marketBudgetPlan,
  marketCampaignTargets,
  productFamily,
  productsUnderCategory,
  strategyMarkets,
  strategyVersions,
  type AdGroupFacts,
  type CampaignFacts,
} from './load.js'
import { categoriesFor, type FieldValue, type ResolvedStrategy, type StrategySource } from './resolve.js'

export const STRATEGY_VIEWS = ['effective', 'rows', 'history'] as const
export type StrategyViewName = (typeof STRATEGY_VIEWS)[number]

export interface StrategyReadArgs {
  channel?: string
  market?: string
  view?: StrategyViewName
  productId?: string
  sku?: string
  categoryId?: string
  campaignId?: string
  adGroupId?: string
  limit?: number
}

/** Why a read cannot answer: the HTTP status a route returns, and the sentence. */
export interface StrategyReadFailure { status: 400 | 404; error: string }
export type StrategyReadResult = { data: Record<string, unknown> } | StrategyReadFailure

export const PRODUCT_NOT_FOUND = 'Product not found'
/** What acts on the strategy today, from the registry: true as each W1 reader adds itself to a field's readBy. */
const READ_BY_NOTE = (() => {
  const read = STRATEGY_FIELDS.filter((f) => f.readBy.length).map((f) => `${f.key} (${f.readBy.join(', ')})`)
  return `${read.length ? `Read today: ${read.join('; ')}.` : 'Nothing acts on the strategy yet.'} Every field in notReadYet is stored and shown `
    + 'only: no engine or rule reads it, and every engine works as before. Until an engine reads a field, only the older '
    + 'settings under alsoInForce bind; once it does, every limit binds and the stricter one wins.'
})()
const TARGET_ORDER =
  "a rule's or an autopilot plan's own target → the campaign's own target ACoS → this strategy (product, category, market) → "
  + 'the account default → profit data → 30 %'
const SHADOW_NOTE = "A campaign's own target ACoS wins over the strategy (Owner decision 2026-10-06): these campaigns keep their own."
const CLAUDE_NOTE =
  "Claude's door holds each ad change to the lower of the business's own level for its tool (`business`) and the strategy's "
  + 'level for its kind of action where the change lands (`effective` here, for this scope). The strategy only narrows, never '
  + 'widens; stop-automation, turn-down-automation and other brakes are never narrowed. A change Nexus cannot place exactly '
  + '(a selection by market, an id not found) takes the strictest row of its market, or of the business.'
const NOT_COMPARED = [
  "daily spend ceilings (they cap a day's budget increases: a different thing from a monthly cap)",
  'engine caps per run (code and server settings)',
  "a rule's or an autopilot plan's own numbers (they win over the strategy for targets)",
  'protected search terms (one list, AdKeywordProtection, unchanged)',
]
const MAX_LISTED = 50
const fail = (status: 400 | 404, error: string): StrategyReadFailure => ({ status, error })
const iso = (at: Date | null | undefined) => (at ? at.toISOString() : null)

// ── Formatting one value ──────────────────────────────────────────────────────────────────────────

/** A field's value under its own keys: one column → that column's key; a group → each of its columns. */
function valueKeys(spec: StrategyField, value: FieldValue | null): Record<string, unknown> {
  if (spec.derivedFrom || spec.columns.length === 1) return { [spec.derivedFrom ? spec.key : spec.columns[0]]: value ?? null }
  return Object.fromEntries(spec.columns.map((c) => [c, (value as Record<string, unknown> | null)?.[c] ?? null]))
}

const sourceOut = (s: StrategySource) => ({
  level: s.level, scopeId: s.scopeId, label: s.label, version: s.version, strategyId: s.strategyId,
  ...(s.via ? { via: s.via } : {}), ...(s.product ? { product: s.product } : {}),
})

// ── The scope ─────────────────────────────────────────────────────────────────────────────────────

type Scope =
  | { kind: 'market' }
  | { kind: 'category'; category: { id: string; name: string } }
  | { kind: 'product'; product: { id: string; sku: string; parentId: string | null } }
  | { kind: 'campaign'; campaign: CampaignFacts }
  | { kind: 'adGroup'; adGroup: AdGroupFacts; campaign: CampaignFacts }

async function scopeOf(a: StrategyReadArgs): Promise<Scope | StrategyReadFailure> {
  const named = [a.productId || a.sku ? 'product' : null, a.categoryId ? 'category' : null, a.campaignId ? 'campaign' : null, a.adGroupId ? 'ad group' : null].filter(Boolean)
  if (named.length > 1) return fail(400, `Name one scope: a product (productId or sku), a category, a campaign or an ad group — not ${named.join(' and ')}.`)
  if (a.productId && a.sku) return fail(400, 'Name the product once: productId or sku, not both.')
  if (a.productId || a.sku) {
    const product = await findLiveProduct({ productId: a.productId, sku: a.sku })
    return product ? { kind: 'product', product } : fail(404, PRODUCT_NOT_FOUND)
  }
  if (a.categoryId) {
    const category = await findCategory(a.categoryId)
    return category ? { kind: 'category', category } : fail(404, 'Category not found (categoryId from catalog-structure).')
  }
  if (a.campaignId) {
    const campaign = (await loadCampaigns([a.campaignId])).get(a.campaignId)
    return campaign ? { kind: 'campaign', campaign } : fail(404, 'Campaign not found (campaignId from ad-campaigns).')
  }
  if (a.adGroupId) {
    const adGroup = (await loadAdGroups([a.adGroupId])).get(a.adGroupId)
    const campaign = adGroup ? (await loadCampaigns([adGroup.campaignId])).get(adGroup.campaignId) : undefined
    return adGroup && campaign ? { kind: 'adGroup', adGroup, campaign } : fail(404, 'Ad group not found (adGroupId from ad-targets).')
  }
  return { kind: 'market' }
}


/** The markets to answer for: the one asked (a campaign's own when it names one), else every market with a strategy or a campaign. */
async function marketsFor(a: StrategyReadArgs, scope: Scope, channel: string): Promise<string[] | StrategyReadFailure> {
  const asked = a.market?.trim().toUpperCase() || null
  if (scope.kind === 'campaign' || scope.kind === 'adGroup') {
    const own = scope.campaign.marketplace?.toUpperCase() ?? null
    if (asked && own && asked !== own) return fail(400, `Campaign "${scope.campaign.name}" advertises in ${own}, not ${asked}.`)
    if (asked || own) return [(asked ?? own)!]
    return fail(400, `Campaign "${scope.campaign.name}" has no market in Nexus: name one (market).`)
  }
  if (asked) return [asked]
  return [...new Set([...(await strategyMarkets(channel)), ...(await campaignMarkets())])].sort()
}

// ── Older settings that also bind ─────────────────────────────────────────────────────────────────

interface Older {
  maxBid: { cents: number; setting: string } | null
  minBid: { cents: number; setting: string } | null
  maxChange: { pct: number; setting: string } | null
  plan: { month: string; monthlyBudgetCents: number; stopOverSpend: boolean; autoPacing: boolean } | null
  harvest: { setting: string; minOrders: number; minClicks: number; maxAcosPct: number | null; windowDays: number }
  /** The campaign's own target ACoS (one campaign in scope) and the account default, as integer percents. */
  campaignTarget: { campaignId: string; name: string; pct: number } | null
  accountTargetPct: number | null
  /** The scope is one campaign (or one of its ad groups). */
  campaignOwnScope: boolean
}

/** The line a product belongs to for bid and harvest policies: its parent, or itself when it has none. */
const lineOf = (scope: Scope) => (scope.kind === 'product' ? scope.product.parentId ?? scope.product.id : null)

async function olderSettings(market: string, scope: Scope): Promise<Older> {
  const campaign = scope.kind === 'campaign' || scope.kind === 'adGroup' ? scope.campaign : null
  const line = lineOf(scope)
  // The bid bounds exactly as the write gate holds a campaign to them: its own column per side, else the bid
  // policies (LINE ?? PORTFOLIO ?? MARKET). Without a campaign: the line's and the market's policies.
  let maxBid: Older['maxBid'] = null
  let minBid: Older['minBid'] = null
  if (campaign) {
    if (campaign.maxBidCents != null) maxBid = { cents: campaign.maxBidCents, setting: "the campaign's own highest bid" }
    if (campaign.minBidCents != null) minBid = { cents: campaign.minBidCents, setting: "the campaign's own lowest bid" }
    if (!maxBid || !minBid) {
      const policy = await resolveBidPolicy(campaign.id, campaign.portfolioId, campaign.marketplace)
      // A policy's own label is left out: people write amounts into it.
      if (!maxBid && policy.max) maxBid = { cents: policy.max.cents, setting: "the bid policy the write gate holds this campaign to (its line's, portfolio's or market's)" }
      if (!minBid && policy.min) minBid = { cents: policy.min.cents, setting: "the bid policy the write gate holds this campaign to (its line's, portfolio's or market's)" }
    }
  } else {
    const rows = await bidPolicies(market, line ? [line] : [])
    const pick = (side: 'minBidCents' | 'maxBidCents') => ['LINE', 'MARKET'].map((g) => rows.find((r) => r.grain === g && r[side] != null)).find(Boolean)
    const max = pick('maxBidCents')
    const min = pick('minBidCents')
    if (max) maxBid = { cents: max.maxBidCents!, setting: `the ${max.grain === 'LINE' ? "product line's" : "market's"} bid policy` }
    if (min) minBid = { cents: min.minBidCents!, setting: `the ${min.grain === 'LINE' ? "product line's" : "market's"} bid policy` }
  }
  const guard = Number((campaign?.dynamicBidding as { maxBidChangePct?: unknown } | null)?.maxBidChangePct)
  const maxChange = campaign && Number.isFinite(guard) && guard > 0 ? { pct: guard, setting: "the campaign's largest bid change" } : null
  const [plan, policy, owner] = await Promise.all([
    marketBudgetPlan(market, currentMonth()),
    resolveHarvestPolicy({ market, line, portfolio: campaign?.portfolioId ?? null, campaign: campaign?.id ?? null, adGroup: scope.kind === 'adGroup' ? scope.adGroup.id : null }),
    readOwnerTargets(campaign ? [campaign.id] : []),
  ])
  const own = campaign ? targetFraction(owner.byCampaign.get(campaign.id)) : null
  const account = accountDefaultFraction(owner.accountDefaultPct)
  return {
    maxBid,
    minBid,
    maxChange,
    plan,
    harvest: {
      setting: policy.source === 'default' ? 'the harvest defaults (no harvest policy saved)' : `the ${policy.source} harvest policy`,
      minOrders: policy.criteria.minOrders, minClicks: policy.criteria.minClicks, maxAcosPct: policy.criteria.maxAcosPct, windowDays: policy.criteria.windowDays,
    },
    campaignTarget: campaign && typeof own === 'number' ? { campaignId: campaign.id, name: campaign.name, pct: fractionToPct(own) } : null,
    accountTargetPct: typeof account === 'number' ? fractionToPct(account) : null,
    campaignOwnScope: !!campaign,
  }
}

// ── effective ─────────────────────────────────────────────────────────────────────────────────────

/** The campaigns whose own target ACoS wins over the strategy for this scope, and stored targets Nexus does not read. */
async function shadowing(market: string, scope: Scope) {
  let campaigns: Array<{ id: string; name: string; targetAcos: unknown }>
  if (scope.kind === 'campaign' || scope.kind === 'adGroup') {
    const c = scope.campaign
    campaigns = [{ id: c.id, name: c.name, targetAcos: (c.dynamicBidding as { targetAcos?: unknown } | null)?.targetAcos }]
  } else if (scope.kind === 'market') campaigns = await marketCampaignTargets(market)
  else campaigns = await marketCampaignTargets(market, scope.kind === 'category' ? await productsUnderCategory(scope.category.id) : await productFamily(scope.product.id))
  const own = campaigns.map((c) => ({ ...c, read: targetFraction(c.targetAcos) }))
  const shadows = own.filter((c) => typeof c.read === 'number')
  const unread = own.filter((c) => c.read !== null && typeof c.read !== 'number')
  return {
    shadowedBy: shadows.slice(0, MAX_LISTED).map((c) => ({ campaignId: c.id, name: c.name, targetAcosPct: fractionToPct(c.read as number) })),
    shadowedCount: shadows.length,
    unread: unread.map((c) => `Campaign "${c.name}" stores a target ACoS that is not a fraction above 0 and at most 5 (500 %): Nexus skips it, so it shadows nothing.`),
  }
}

/** The business's own Claude level for every ad tool the strategy can narrow. */
async function businessLevels(): Promise<Map<string, ClaudeTrust>> {
  // Imported here: the tool registry imports the ads-strategy tool, which imports this file.
  const [{ ruleFrom }, { getTool }] = await Promise.all([import('../../agents/claude-trust.service.js'), import('../../agents/tool-registry.js')])
  const names = [...new Set(Object.values(CLAUDE_ACTION_TOOLS).flat())]
  const rows = await prisma.agentTool.findMany({ where: { name: { in: names } }, select: { name: true, claudeTrust: true, claudeLimits: true } })
  const byName = new Map(rows.map((r) => [r.name, r]))
  const levels = new Map<string, ClaudeTrust>()
  for (const name of names) {
    const tool = getTool(name)
    if (tool) levels.set(name, ruleFrom(tool, byName.get(name) ?? null).level)
  }
  return levels
}

function fieldEntries(resolved: ResolvedStrategy, older: Older): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const spec of STRATEGY_FIELDS) {
    if (spec.key === 'claudeAutonomy') continue
    if (spec.key === 'monthlySpendCapCents') {
      const caps = resolved.caps.map((c) => ({ ...sourceOut(c.source), monthlySpendCapCents: c.monthlySpendCapCents }))
      const market = resolved.caps.find((c) => c.source.level === 'market')
      out.push({
        field: spec.key, label: spec.label, caps,
        note: "Each cap binds on its own scope's spend (the market's on the whole market, a category's on its products, a product's on its own); none is inherited.",
        ...(older.plan ? {
          alsoInForce: [{ setting: `the budget plan ${older.plan.month}`, monthlyBudgetCents: older.plan.monthlyBudgetCents, stopOverSpend: older.plan.stopOverSpend, autoPacing: older.plan.autoPacing }],
          ...(market ? { stricter: { from: market.monthlySpendCapCents <= older.plan.monthlyBudgetCents ? 'the market strategy' : `the budget plan ${older.plan.month}` } } : {}),
        } : {}),
        readBy: spec.readBy,
      })
      continue
    }
    const r = resolved.fields.get(spec.key) ?? { value: null, source: null }
    const entry: Record<string, unknown> = { field: spec.key, label: spec.label, ...valueKeys(spec, r.value), source: r.source ? sourceOut(r.source) : null }
    if (r.mixed) entry.mixed = r.mixed.map((m) => ({ who: m.who, ...valueKeys(spec, m.value), source: m.source ? sourceOut(m.source) : null }))
    const chain = resolved.chains?.get(spec.key)
    if (chain) entry.chain = chain.map((c) => ({ ...sourceOut(c.source), ...valueKeys(spec, c.value) }))
    const mine = typeof r.value === 'number' ? r.value : null
    if (spec.key === 'maxBidCents' && older.maxBid) {
      entry.alsoInForce = [{ setting: older.maxBid.setting, maxBidCents: older.maxBid.cents }]
      if (mine != null) entry.stricter = { from: mine <= older.maxBid.cents ? 'the strategy' : older.maxBid.setting }
    }
    if (spec.key === 'minBidCents' && older.minBid) {
      entry.alsoInForce = [{ setting: older.minBid.setting, minBidCents: older.minBid.cents }]
      if (mine != null) entry.stricter = { from: mine >= older.minBid.cents ? 'the strategy' : older.minBid.setting }
    }
    if (spec.key === 'maxChangePct' && older.maxChange) {
      entry.alsoInForce = [{ setting: older.maxChange.setting, maxChangePct: older.maxChange.pct }]
      if (mine != null) entry.stricter = { from: mine <= older.maxChange.pct ? 'the strategy' : older.maxChange.setting }
    }
    if (spec.key === 'harvest') {
      const h = older.harvest
      entry.alsoInForce = [{ setting: h.setting, harvestMinOrders: h.minOrders, harvestMinClicks: h.minClicks, harvestMaxAcosPct: h.maxAcosPct, harvestWindowDays: h.windowDays }]
      const g = r.value as { harvestMinOrders: number; harvestMinClicks: number; harvestMaxAcosPct: number | null } | null
      if (g) {
        // The one order (fields.ts harvestStricter), as the Keyword Harvest page applies it: a tie goes to the strategy.
        const policyStricter = harvestStricter(h, { minOrders: g.harvestMinOrders, minClicks: g.harvestMinClicks, maxAcosPct: g.harvestMaxAcosPct })
        entry.stricter = { from: policyStricter ? h.setting : 'the strategy' }
      }
    }
    if (spec.key === 'targetAcosPct') {
      entry.order = TARGET_ORDER
      entry.campaignOwn = older.campaignTarget ? { campaignId: older.campaignTarget.campaignId, name: older.campaignTarget.name, targetAcosPct: older.campaignTarget.pct } : null
      entry.accountDefault = { targetAcosPct: older.accountTargetPct }
      // What Nexus's bid optimiser steers by today (the strategy is not read yet): for one campaign, its own target if
      // it has one; for every other campaign, the account default, else profit data, else a flat 30 %.
      const others = older.campaignOwnScope ? '' : ' (campaigns without their own target; shadowedBy lists the others)'
      entry.today = older.campaignTarget
        ? { from: "the campaign's own target", targetAcosPct: older.campaignTarget.pct }
        : older.accountTargetPct != null
          ? { from: `the account default${others}`, targetAcosPct: older.accountTargetPct }
          : { from: `profit data, else a flat 30 %${others}` }
    }
    entry.readBy = spec.readBy
    out.push(entry)
  }
  return out
}

async function effectiveIn(market: string, channel: string, scope: Scope, levels: Map<string, ClaudeTrust>): Promise<Record<string, unknown>> {
  const view = await openStrategy(market, channel)
  let resolved: ResolvedStrategy
  let scopeOut: Record<string, unknown>
  const productsOf = async (ids: string[], unknownAds: number) => {
    const { catalog } = await loadCatalog(ids)
    const list = ids.map((id) => catalog.products.get(id)).filter((p): p is NonNullable<typeof p> => !!p).map((p) => {
      const { ids: categoryIds } = categoriesFor(p, catalog)
      return {
        productId: p.id, sku: p.sku,
        ...(p.parentId ? { parentSku: catalog.products.get(p.parentId)?.sku ?? null } : {}),
        category: categoryIds.length === 1 ? catalog.categoryNames?.get(categoryIds[0]) ?? categoryIds[0] : categoryIds.length ? `${categoryIds.length} categories, none primary or several primary` : null,
      }
    })
    return { products: list.slice(0, MAX_LISTED), ...(list.length > MAX_LISTED ? { moreProducts: list.length - MAX_LISTED } : {}), ...(unknownAds ? { unknownProductAds: unknownAds } : {}) }
  }
  switch (scope.kind) {
    case 'market':
      resolved = view.forMarket().resolved
      scopeOut = { kind: 'market' }
      break
    case 'category':
      resolved = (await view.forCategory(scope.category.id)).resolved
      scopeOut = { kind: 'category', categoryId: scope.category.id, name: scope.category.name }
      break
    case 'product':
      resolved = (await view.forProducts([scope.product.id])).resolved
      scopeOut = { kind: 'product', ...(await productsOf([scope.product.id], 0)) }
      break
    case 'campaign': {
      resolved = (await view.forCampaigns([scope.campaign.id])).get(scope.campaign.id)!.resolved
      const ids = [...new Set(scope.campaign.adGroups.flatMap((g) => g.productIds))]
      scopeOut = { kind: 'campaign', campaignId: scope.campaign.id, name: scope.campaign.name, adGroups: scope.campaign.adGroups.length, ...(await productsOf(ids, scope.campaign.adGroups.reduce((n, g) => n + g.unknownAds, 0))) }
      break
    }
    case 'adGroup':
      resolved = (await view.forAdGroups([scope.adGroup.id])).get(scope.adGroup.id)!.resolved
      scopeOut = { kind: 'adGroup', adGroupId: scope.adGroup.id, name: scope.adGroup.name, campaign: { campaignId: scope.campaign.id, name: scope.campaign.name }, ...(await productsOf(scope.adGroup.productIds, scope.adGroup.unknownAds)) }
      break
  }
  const [older, shadows] = await Promise.all([olderSettings(market, scope), shadowing(market, scope)])
  const claude = CLAUDE_ACTION_TYPES.map((action) => {
    const r = resolved.autonomy.get(action) ?? { value: null, source: null }
    return {
      action,
      tools: CLAUDE_ACTION_TOOLS[action].map((tool) => {
        const business = levels.get(tool) ?? 'ask'
        const strategy = CLAUDE_LEVELS.includes(r.value as ClaudeTrust) ? (r.value as ClaudeTrust) : null
        return { tool, business, effective: strategy && CLAUDE_LEVELS.indexOf(strategy) < CLAUDE_LEVELS.indexOf(business) ? strategy : business }
      }),
      strategy: r.value ?? null,
      source: r.source ? sourceOut(r.source) : null,
      ...(r.mixed ? { mixed: r.mixed.map((m) => ({ who: m.who, strategy: m.value, source: m.source ? sourceOut(m.source) : null })) } : {}),
    }
  })
  return {
    market,
    scope: scopeOut,
    strategyRows: view.index.rows.length,
    ...(view.empty ? { note: `No strategy is set for ${market} yet: every engine works as it does today.` } : {}),
    fields: fieldEntries(resolved, older),
    claude,
    claudeNote: CLAUDE_NOTE,
    shadowedBy: shadows.shadowedBy,
    shadowedCount: shadows.shadowedCount,
    shadowNote: SHADOW_NOTE,
    warnings: [...new Set([...resolved.warnings, ...shadows.unread])],
    orphans: view.orphans,
  }
}

// ── rows ──────────────────────────────────────────────────────────────────────────────────────────

const SETTING_KEYS = [...new Set(STRATEGY_FIELDS.filter((f) => !f.derivedFrom).flatMap((f) => f.columns))]

async function rowsIn(market: string, channel: string): Promise<Record<string, unknown>> {
  const { rows, orphans, index } = await loadIndex(market, channel)
  const orphanWhy = new Map(orphans.map((o) => [o.strategyId, o.why]))
  const lines = rows.filter((r) => r.level === 'PRODUCT').map((r) => r.scopeId)
  const [bids, harvests, plan, shadows] = await Promise.all([
    bidPolicies(market, lines),
    harvestPolicies(market, lines),
    marketBudgetPlan(market, currentMonth()),
    shadowing(market, { kind: 'market' }),
  ])
  const order = (level: string) => STRATEGY_LEVELS.indexOf(level as never)
  return {
    market,
    ...(rows.length ? {} : { note: `No strategy is set for ${market} yet: every engine works as it does today.` }),
    rows: [...rows].sort((a, b) => order(a.level) - order(b.level) || a.label.localeCompare(b.label)).map((r) => ({
      strategyId: r.id, level: r.level, scopeId: r.scopeId, label: r.label, version: r.version, updatedAt: iso(r.updatedAt), updatedBy: r.updatedBy,
      ...Object.fromEntries(SETTING_KEYS.map((k) => [k, r[k] ?? null])),
      ...(orphanWhy.has(r.id) ? { orphan: orphanWhy.get(r.id) } : {}),
    })),
    ignored: index.warnings,
    olderSettings: {
      note: 'Older settings at the same grains as strategy rows. They keep binding; nothing moved into the strategy.',
      bidPolicies: bids.map((b) => ({ grain: b.grain, scopeId: b.scopeId, minBidCents: b.minBidCents, maxBidCents: b.maxBidCents })),
      harvestPolicies: harvests.map((h) => ({ grain: h.scopeGrain, scopeId: h.scopeId, harvestMinOrders: h.minOrders, harvestMinClicks: h.minClicks, harvestMaxAcosPct: h.maxAcosPct, harvestWindowDays: h.windowDays })),
      budgetPlan: plan ? { month: plan.month, monthlyBudgetCents: plan.monthlyBudgetCents, stopOverSpend: plan.stopOverSpend, autoPacing: plan.autoPacing } : null,
    },
    shadowedBy: shadows.shadowedBy,
    shadowedCount: shadows.shadowedCount,
    shadowNote: SHADOW_NOTE,
    ...(shadows.unread.length ? { warnings: shadows.unread } : {}),
  }
}

// ── history ───────────────────────────────────────────────────────────────────────────────────────

/**
 * A recorded change, its numbers under the field's own key (so a money field's from → to is money). W1-3 — a protected
 * term or a campaign's own target names which one (`term`, `campaignId`), never an amount.
 */
function changeOut(change: unknown): Record<string, unknown> {
  const c = (change ?? {}) as Record<string, unknown>
  const name = typeof c.field === 'string' && /^[A-Za-z][A-Za-z0-9]*$/.test(c.field) ? c.field : 'value'
  return {
    field: c.field ?? null,
    direction: c.direction ?? null,
    ...(typeof c.term === 'string' ? { term: c.term } : {}),
    ...(typeof c.campaignId === 'string' ? { campaignId: c.campaignId, campaign: typeof c.campaign === 'string' ? c.campaign : null } : {}),
    [name]: { from: c.from ?? null, to: c.to ?? null, effectiveFrom: c.effectiveFrom ?? null, effectiveTo: c.effectiveTo ?? null },
  }
}

async function historyIn(market: string, channel: string, scope: Scope, limit: number): Promise<Record<string, unknown>> {
  const at = scope.kind === 'product' ? { level: 'PRODUCT', scopeId: scope.product.id } : scope.kind === 'category' ? { level: 'CATEGORY', scopeId: scope.category.id } : null
  const versions = await strategyVersions(market, channel, at, limit)
  return {
    market,
    scope: at ? { level: at.level, scopeId: at.scopeId } : { level: 'all rows of the market' },
    versions: versions.map((v) => ({
      strategyId: v.strategyId, level: v.level, scopeId: v.scopeId, version: v.version, op: v.op, direction: v.direction, via: v.via,
      approvalId: v.approvalId, actor: v.actor, stepUpAt: iso(v.stepUpAt), reason: v.reason, at: iso(v.createdAt),
      values: v.values ?? null,
      changes: Array.isArray(v.changes) ? v.changes.map(changeOut) : [],
    })),
    ...(versions.length ? {} : { note: 'No change recorded yet.' }),
  }
}

// ── The read ──────────────────────────────────────────────────────────────────────────────────────

export async function readStrategy(args: StrategyReadArgs): Promise<StrategyReadResult> {
  const channel = (args.channel ?? 'AMAZON').toUpperCase()
  if (channel !== 'AMAZON') return fail(400, 'The ads strategy covers Amazon in this release (eBay comes later, in the same place).')
  const view: StrategyViewName = args.view ?? 'effective'
  const scope = await scopeOf(args)
  if ('error' in scope) return scope
  if (view === 'rows' && scope.kind !== 'market') return fail(400, 'The rows view lists a whole market: name no product, category, campaign or ad group (or use view effective).')
  if (view === 'history' && (scope.kind === 'campaign' || scope.kind === 'adGroup')) {
    return fail(400, 'The history is kept per market, category or product: name one of those (or none for the whole market).')
  }
  const markets = await marketsFor(args, scope, channel)
  if (!Array.isArray(markets)) return markets
  const limit = Math.min(Math.max(Math.trunc(args.limit ?? 20), 1), 100)
  const levels = view === 'effective' ? await businessLevels() : new Map<string, ClaudeTrust>()
  const perMarket: Array<Record<string, unknown>> = []
  for (const market of markets) {
    perMarket.push(view === 'effective' ? await effectiveIn(market, channel, scope, levels) : view === 'rows' ? await rowsIn(market, channel) : await historyIn(market, channel, scope, limit))
  }
  return {
    data: {
      channel,
      view,
      markets: perMarket,
      ...(markets.length ? {} : { note: 'This business has no ads strategy and no Amazon campaign yet.' }),
      ...(view === 'effective' ? { notCompared: NOT_COMPARED } : {}),
      notReadYet: notReadYet(),
      readByNote: READ_BY_NOTE,
    },
  }
}
