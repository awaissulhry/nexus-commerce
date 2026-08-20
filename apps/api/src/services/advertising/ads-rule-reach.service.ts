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

/**
 * Reach for many rules at once. One campaign load for the whole set — this is called on a list
 * endpoint, so a per-rule query would be 51 round trips.
 */
export async function reachForRules(
  rules: Array<{ id: string } & RuleScope & { scopeProductId?: string | null; actions?: unknown }>,
): Promise<Map<string, RuleReach>> {
  const campaigns = await loadCampaigns()
  const productScoped = [...new Set(rules.map((r) => r.scopeProductId).filter((x): x is string => !!x))]
  const expanded = await expandProducts(productScoped)

  /**
   * D1 (2026-08-20) — assignment, read the same way the evaluator reads it.
   *
   * 🔴 This file's own header states the law: *"a reach number that disagrees with what actually
   * runs is worse than none"*. The evaluator now refuses a budget rule on any campaign it is not
   * assigned to, so a reach number computed from the scope columns alone would over-report — it
   * would still say 220 for a rule assigned to three. Callers that do not select `actions` pass
   * `undefined` and keep the old answer, which is correct for every non-budget rule.
   */
  const isBudgetRule = (actions: unknown): boolean =>
    Array.isArray(actions) && actions.some((a) => String((a as { type?: unknown })?.type ?? '') === 'adjust_ad_budget')
  const assignedByRule = new Map<string, string[]>()
  const budgetRuleIds = rules.filter((r) => isBudgetRule(r.actions)).map((r) => r.id)
  if (budgetRuleIds.length > 0) {
    for (const id of budgetRuleIds) assignedByRule.set(id, [])
    const links = await prisma.campaignRuleAssignment.findMany({
      where: { ruleId: { in: budgetRuleIds }, kind: 'budget' },
      select: { ruleId: true, campaignId: true },
    })
    for (const l of links) assignedByRule.get(l.ruleId)?.push(l.campaignId)
  }

  const out = new Map<string, RuleReach>()
  for (const r of rules) {
    const scope: RuleScope = {
      scopeMarketplace: r.scopeMarketplace,
      scopePortfolioId: r.scopePortfolioId,
      scopeCampaignId: r.scopeCampaignId,
      scopeProductIds: r.scopeProductId ? expanded.get(r.scopeProductId) ?? [r.scopeProductId] : null,
      assignedCampaignIds: assignedByRule.get(r.id) ?? null,
    }
    let n = 0
    let live = 0
    for (const c of campaigns) {
      if (!ruleMatchesScope(scope, {
        marketplace: c.marketplace,
        campaignId: c.id,
        portfolioId: c.portfolioId,
        productIds: c.productIds,
      })) continue
      n++
      if (c.status === 'ENABLED') live++
    }
    out.set(r.id, { campaigns: n, enabledCampaigns: live, total: campaigns.length })
  }
  return out
}
