/**
 * ACR.7 — does this rule apply to this context? The one answer, used everywhere.
 *
 * Scoping existed before this file and was PARTIALLY DECORATIVE. The evaluators pre-filtered
 * rules by `scopeMarketplace` per context — but only as a skip-check: the actual call,
 * `evaluateAllRulesForTrigger`, re-queried every enabled rule for the trigger and evaluated
 * all of them. A DE-scoped rule therefore still fired on IT contexts whenever any other rule
 * passed the skip-check. Found 2026-08-05 while building drag-to-scope, whose entire premise
 * is that a dropped rule REALLY binds.
 *
 * Semantics, deliberately strict:
 *   · scopeMarketplace  — rule fires only on contexts of that marketplace.
 *   · scopePortfolioId  — rule fires only on contexts whose campaign belongs to that
 *     portfolio (external id, matching Campaign.portfolioId).
 *   · scopeCampaignId   — rule fires only on contexts of that exact campaign (local id).
 *   · A campaign/portfolio-scoped rule does NOT fire on contexts with no campaign identity
 *     (an FBA-age or account-level context): "only my campaign's events" cannot honestly
 *     match an event that belongs to no campaign.
 *
 * Pure; the caller supplies the resolved identity. Resolution helpers live with the caller
 * because they need Prisma.
 */

export interface RuleScope {
  scopeMarketplace: string | null
  scopePortfolioId: string | null
  scopeCampaignId: string | null
}

export interface ContextIdentity {
  marketplace: string | null
  /** Local Campaign.id, when the context concerns one campaign. */
  campaignId: string | null
  /** External portfolio id the campaign belongs to, when known. */
  portfolioId: string | null
}

export function ruleMatchesScope(rule: RuleScope, ctx: ContextIdentity): boolean {
  if (rule.scopeMarketplace != null && rule.scopeMarketplace !== ctx.marketplace) return false
  if (rule.scopeCampaignId != null && rule.scopeCampaignId !== ctx.campaignId) return false
  if (rule.scopePortfolioId != null && rule.scopePortfolioId !== ctx.portfolioId) return false
  return true
}

/**
 * Extract what a context knows about its own identity. Contexts are heterogeneous by design
 * (each trigger builds its own shape), so this reads the two conventions that exist:
 * `campaign: { id }` on campaign-grain contexts, and `searchTerm.externalCampaignId` on
 * search-term contexts (translated to a local id by the caller's map).
 */
export function contextIdentity(
  ctx: unknown,
  extToLocal: Map<string, string>,
  localToPortfolio: Map<string, string | null>,
): ContextIdentity {
  const c = ctx as {
    marketplace?: string | null
    campaign?: { id?: string | null }
    searchTerm?: { externalCampaignId?: string | null }
  }
  let campaignId: string | null = c.campaign?.id ?? null
  if (!campaignId && c.searchTerm?.externalCampaignId) {
    campaignId = extToLocal.get(c.searchTerm.externalCampaignId) ?? null
  }
  return {
    marketplace: c.marketplace ?? null,
    campaignId,
    portfolioId: campaignId ? (localToPortfolio.get(campaignId) ?? null) : null,
  }
}
