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
  /**
   * RA.GRAIN — the product grain, ALREADY EXPANDED by the caller.
   *
   * The column stores one `Product.id`, which may be a parent (a whole product line). Expanding
   * a parent to its children needs the database, and this function is pure — so the caller
   * expands once per tick and passes the resulting ids here. Empty or absent = not product-scoped.
   *
   * Deliberately a set of ids rather than the raw column: it keeps the matcher a plain
   * intersection, and it means the parent-vs-child distinction is resolved in exactly one place
   * instead of being re-derived at every comparison.
   */
  scopeProductIds?: string[] | null
  /**
   * D1 (2026-08-20) — the campaigns this rule is ASSIGNED to, from `CampaignRuleAssignment`.
   *
   * 🔴 Three states, and the difference between the last two is the whole feature:
   *   · **absent / `undefined`** — this rule is not assignment-governed. Every caller that
   *     predates D1 passes nothing and behaves exactly as before.
   *   · **`[]`** — assignment-governed and assigned to nothing, so it matches NO campaign.
   *     "A budget rule does nothing until it is assigned" is this line.
   *   · **`[ids]`** — matches only those campaigns.
   *
   * A set, like `scopeProductIds`, and for the same reason: the caller resolves it once per tick
   * and the matcher stays a pure intersection.
   *
   * ⚠️ This is NOT a narrowing of `scopeCampaignId` — it is a different mechanism pointing the
   * other way (campaign → rule, many-to-many). Both apply, and both must pass.
   */
  assignedCampaignIds?: string[] | null
}

export interface ContextIdentity {
  marketplace: string | null
  /** Local Campaign.id, when the context concerns one campaign. */
  campaignId: string | null
  /** External portfolio id the campaign belongs to, when known. */
  portfolioId: string | null
  /**
   * RA.GRAIN — `Product.id`s this context advertises. Resolved at the finest grain the context
   * offers: an ad-group-grain context (a target, say) resolves to that ad group's products; a
   * campaign-grain context resolves to the whole campaign's. Empty for contexts with no campaign
   * identity at all, which is why a product-scoped rule does not fire on them — the same rule
   * campaign- and portfolio-scoped rules already follow.
   */
  productIds?: string[]
}

export function ruleMatchesScope(rule: RuleScope, ctx: ContextIdentity): boolean {
  if (rule.scopeMarketplace != null && rule.scopeMarketplace !== ctx.marketplace) return false
  if (rule.scopeCampaignId != null && rule.scopeCampaignId !== ctx.campaignId) return false
  if (rule.scopePortfolioId != null && rule.scopePortfolioId !== ctx.portfolioId) return false
  // Product: the context must advertise at least one of the scoped products. A context that
  // knows of no products cannot satisfy "only this product's events", so it does not match —
  // consistent with the campaign/portfolio rule above rather than a new exception.
  if (rule.scopeProductIds != null && rule.scopeProductIds.length > 0) {
    const want = rule.scopeProductIds
    const have = ctx.productIds
    if (!have || have.length === 0) return false
    if (!have.some((p) => want.includes(p))) return false
  }
  // D1 — assignment. Present (even empty) means this rule reaches ONLY campaigns assigned to it,
  // so an empty list matches nothing and a context with no campaign identity cannot match either:
  // "only my assigned campaigns' events" cannot honestly match an event belonging to no campaign,
  // which is the rule the campaign/portfolio branches above already follow.
  if (rule.assignedCampaignIds != null) {
    if (ctx.campaignId == null) return false
    if (!rule.assignedCampaignIds.includes(ctx.campaignId)) return false
  }
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
  /**
   * RA.GRAIN — product lookups, supplied only when some rule is product-scoped. Both are
   * optional so every existing caller keeps working unchanged and pays nothing when no rule
   * uses the grain.
   */
  productsByAdGroup?: Map<string, string[]>,
  productsByCampaign?: Map<string, string[]>,
): ContextIdentity {
  const c = ctx as {
    marketplace?: string | null
    campaign?: { id?: string | null }
    adGroup?: { id?: string | null }
    searchTerm?: { externalCampaignId?: string | null }
  }
  let campaignId: string | null = c.campaign?.id ?? null
  if (!campaignId && c.searchTerm?.externalCampaignId) {
    campaignId = extToLocal.get(c.searchTerm.externalCampaignId) ?? null
  }
  // Finest grain first. A target-grain context carries `adGroup: { id }` (see
  // UnderperformContext), and an ad group advertises far fewer products than its campaign — so
  // resolving there makes a product-scoped rule genuinely narrower rather than campaign-wide.
  let productIds: string[] | undefined
  const adGroupId = c.adGroup?.id ?? null
  if (adGroupId && productsByAdGroup) productIds = productsByAdGroup.get(adGroupId)
  if (!productIds && campaignId && productsByCampaign) productIds = productsByCampaign.get(campaignId)

  const base = {
    marketplace: c.marketplace ?? null,
    campaignId,
    portfolioId: campaignId ? (localToPortfolio.get(campaignId) ?? null) : null,
  }
  /**
   * `productIds` is present only when a lookup was actually attempted, and the distinction is
   * deliberate: ABSENT means "no rule asked, so nothing was resolved", while `[]` means "resolved,
   * and this context advertises nothing". Emitting `[]` unconditionally would collapse those two
   * into one and would silently change the returned shape for every caller that predates this
   * grain — three existing tests pin that shape, and they were right to.
   */
  const attempted = !!productsByAdGroup || !!productsByCampaign
  return attempted ? { ...base, productIds: productIds ?? [] } : base
}
