/**
 * EA6 — how many campaigns a rule can currently reach.
 *
 * 🔴 **The number an operator needs before arming anything.** Measured on prod 2026-08-19,
 * **43 of 51 rules carry no scope at all** — every one of them matches all 220 campaigns. Today
 * that is a fact in a document; this makes it a number on the row, beside the mode that lets the
 * rule write. The two readings that matter:
 *
 *   · `0`   — a DEAD rule. Its scope resolves to nothing, so it is armed and cannot act. Nothing
 *             on screen distinguishes that from a rule that simply had a quiet week.
 *   · `220` — the whole account, from a rule the operator may believe is narrow.
 *
 * Taken from Akeneo, which puts "impacted products" as a permanent sortable column on every rule
 * and recalculates it live in the builder — the cheapest automation-governance idea in the
 * nine-platform study, because it converts *"is it safe to turn this on?"* into something you can
 * read rather than something you find out afterwards.
 *
 * ── It must use the evaluator's own matcher ─────────────────────────────────────────────────────
 * `ruleMatchesScope` is the function the evaluator calls on every tick. Re-deriving reach with a
 * second query — "count campaigns where marketplace = …" — would drift from enforcement the first
 * time either side gained a grain, and a reach number that disagrees with what actually runs is
 * worse than none. So this builds one `ContextIdentity` per campaign and asks the same question
 * the engine asks.
 */
import prisma from '../../db.js'
import { ruleMatchesScope, type RuleScope } from '../automation-rule-scope.js'
import { resolveAssignedCampaignIds } from './ads-rule-scope-resolver.js'

export interface RuleReach {
  /** campaigns this rule's scope admits */
  campaigns: number
  /** of those, the ones Amazon is currently running */
  enabledCampaigns: number
  /** total campaigns considered — the denominator, so "220 of 220" is legible */
  total: number
}

/** One campaign's identity, as the evaluator would see it. */
interface CampaignIdentity {
  id: string
  marketplace: string | null
  portfolioId: string | null
  status: string
  productIds: string[]
}

/**
 * Load every campaign once, with the product ids it advertises.
 *
 * 🔴 The product link does NOT live on the ads tables you would expect. `AdTarget` has no ASIN
 * column and `Product` has no `asin` field. The path that exists is **`AdProductAd.productId` →
 * `adGroup.campaignId`** — the same join `GET /advertising/scope-options` already serves every
 * scope picker from, so reach and the picker can never disagree about what a product line covers.
 * Measured 2026-08-19: 13 lines, 224 links, 218 of 220 campaigns.
 *
 * ⚠ No fallback on this query. An earlier draft guessed a table name and swallowed the error,
 * which would have handed every product-scoped rule a confident reach of 0 — a wrong number
 * presented as a fact is worse than a failed request.
 */
async function loadCampaigns(): Promise<CampaignIdentity[]> {
  const [campaigns, ads] = await Promise.all([
    prisma.campaign.findMany({ select: { id: true, marketplace: true, portfolioId: true, status: true } }),
    prisma.adProductAd.findMany({
      where: { productId: { not: null } },
      select: { productId: true, adGroup: { select: { campaignId: true } } },
    }),
  ])
  const byCampaign = new Map<string, Set<string>>()
  for (const a of ads) {
    const cid = a.adGroup?.campaignId
    if (!cid || !a.productId) continue
    const s = byCampaign.get(cid) ?? new Set<string>()
    s.add(a.productId)
    byCampaign.set(cid, s)
  }
  return campaigns.map((c) => ({
    id: c.id,
    marketplace: c.marketplace ?? null,
    portfolioId: c.portfolioId ?? null,
    status: c.status,
    productIds: [...(byCampaign.get(c.id) ?? [])],
  }))
}

/**
 * Expand a rule's single `scopeProductId` to itself plus its children — the same expansion the
 * evaluator does, because the column may hold a parent (a whole product line).
 */
async function expandProducts(ids: string[]): Promise<Map<string, string[]>> {
  if (ids.length === 0) return new Map()
  const kids = await prisma.product.findMany({
    where: { parentId: { in: ids } },
    select: { id: true, parentId: true },
  })
  const out = new Map<string, string[]>()
  for (const id of ids) out.set(id, [id])
  for (const k of kids) {
    if (!k.parentId) continue
    out.get(k.parentId)?.push(k.id)
  }
  return out
}

type ReachRule = { id: string } & RuleScope & { scopeProductId?: string | null; actions?: unknown }

/**
 * The campaigns each rule's scope admits, by the evaluator's own matcher. One campaign load for the whole set — this is
 * called on a list endpoint, so a per-rule query would be 51 round trips.
 */
async function campaignsReachedBy(rules: ReachRule[]): Promise<{ total: number; byRule: Map<string, CampaignIdentity[]> }> {
  const campaigns = await loadCampaigns()
  const productScoped = [...new Set(rules.map((r) => r.scopeProductId).filter((x): x is string => !!x))]
  const expanded = await expandProducts(productScoped)

  /**
   * D1 · BUD-P2 · 4a — assignment, read by the evaluator's OWN resolver.
   *
   * 🔴 This file's own header states the law: *"a reach number that disagrees with what actually
   * runs is worse than none"*. The tick refuses a bound rule on any campaign it is not bound to —
   * an engine budget rule by `CampaignRuleAssignment`, a builder Budget/Bid/SOV/Keyword Tracker/
   * Placement rule by its picker list — so a reach computed from the scope columns alone would
   * over-report: "220" for a Placement rule with one pick (live, review 4.2). Callers that do not
   * select `actions` pass `undefined` and keep the scope-column answer.
   */
  const assignedByRule = await resolveAssignedCampaignIds(rules)

  const byRule = new Map<string, CampaignIdentity[]>()
  for (const r of rules) {
    const scope: RuleScope = {
      scopeMarketplace: r.scopeMarketplace,
      scopePortfolioId: r.scopePortfolioId,
      scopeCampaignId: r.scopeCampaignId,
      scopeProductIds: r.scopeProductId ? expanded.get(r.scopeProductId) ?? [r.scopeProductId] : null,
      assignedCampaignIds: assignedByRule.get(r.id) ?? null,
    }
    byRule.set(r.id, campaigns.filter((c) => ruleMatchesScope(scope, {
      marketplace: c.marketplace,
      campaignId: c.id,
      portfolioId: c.portfolioId,
      productIds: c.productIds,
    })))
  }
  return { total: campaigns.length, byRule }
}

/** Reach for many rules at once (one campaign load for the whole set). */
export async function reachForRules(rules: ReachRule[]): Promise<Map<string, RuleReach>> {
  const { total, byRule } = await campaignsReachedBy(rules)
  const out = new Map<string, RuleReach>()
  for (const r of rules) {
    const reached = byRule.get(r.id) ?? []
    out.set(r.id, { campaigns: reached.length, enabledCampaigns: reached.filter((c) => c.status === 'ENABLED').length, total })
  }
  return out
}

/** The markets one rule's scope reaches (see `ruleReachedMarkets`). */
export interface RuleReachedMarkets {
  /** Campaigns the rule's scope admits, by the evaluator's own matcher. */
  campaigns: number
  /** The distinct market codes of those campaigns, sorted. */
  markets: string[]
  /** Of those campaigns, the ones that carry no market (the write gate resolves no profile for them). */
  withoutMarket: number
}

/**
 * The markets a rule's scope reaches: the market codes of exactly the campaigns `reachForRules` counts for it (the same
 * matcher, the same product expansion, the same assignment resolver). The graduation gate reads it to judge a rule that
 * is scoped to a campaign, a portfolio, a product or its picked campaigns, but names no market, on the market(s) its
 * writes really go to.
 */
export async function ruleReachedMarkets(rule: ReachRule): Promise<RuleReachedMarkets> {
  const { adsMarketCode } = await import('./ads-markets.service.js')
  const reached = (await campaignsReachedBy([rule])).byRule.get(rule.id) ?? []
  const codes = reached.map((c) => adsMarketCode(c.marketplace))
  return {
    campaigns: reached.length,
    markets: [...new Set(codes.filter(Boolean))].sort(),
    withoutMarket: codes.filter((c) => !c).length,
  }
}
