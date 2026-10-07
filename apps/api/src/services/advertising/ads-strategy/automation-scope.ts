/**
 * ADS AUTONOMY W2 (AA-W2-11) — where an Amazon ads automation lands in the ads strategy, for the `automation` kind of
 * "what Claude may do alone" (fields.ts CLAUDE_ACTION_TOOLS): Claude's door narrows turn-up-automation and
 * tune-ad-engine by it (claude.ts PLACES), and their limits judge the move in it (the kit, automation-limits.ts).
 *
 *   product scope   what the automation acts on: an ads rule's campaign or product, a plan's, a pool's or a schedule's
 *                   campaigns, a coverage set's portfolio campaigns in its market, a harvest policy's campaign or ad
 *                   group — each placed through the products it advertises (the safer value across them wins);
 *   market          only when it has no product scope: an ads rule for a market or a portfolio in it, a harvest policy
 *                   for a market, a coverage set whose portfolio has no campaign there;
 *   unplaced        an automation for the whole account (the ads dial, an engine's own switch, the account default
 *                   target ACoS, the breaker, a rank target every plan may use) or across several markets: Nexus cannot
 *                   tell which market's strategy covers it, so a person decides (the door takes the business's strictest);
 *   outside         not Amazon ads (eBay, marketing, operations, the fleet, repricing): the strategy says nothing.
 *
 * Read in the business of the call (row-level security). Advertising's own tables, so it lives in this context.
 */
import prisma from '../../../db.js'
import { strategyMarket } from './bids.js'

export type AutomationScope =
  | { outside: true; why: string }
  | { unplaced: string }
  /** `campaignIds`: the campaigns it acts on; `productIds`: a rule for products; both empty: the whole market. */
  | { market: string; campaignIds: string[]; productIds: string[]; label: string }

const WHOLE_ACCOUNT = (what: string): AutomationScope => ({ unplaced: `${what} reaches the whole account, so Nexus cannot tell which market's ads strategy covers it` })

/** Campaigns, placed in their one market; several markets, or none, cannot be placed. */
async function ofCampaigns(ids: Array<string | null | undefined>, label: string): Promise<AutomationScope> {
  const asked = [...new Set(ids.filter((id): id is string => !!id))]
  if (!asked.length) return { unplaced: `${label} acts on no campaign Nexus can find` }
  const rows = await prisma.campaign.findMany({ where: { id: { in: asked } }, select: { id: true, marketplace: true } })
  if (rows.length < asked.length) return { unplaced: `${label}: a campaign it acts on was not found in this business` }
  const markets = [...new Set(rows.map((r) => strategyMarket(r.marketplace)))]
  if (markets.some((m) => !m)) return { unplaced: `${label}: a campaign it acts on has no market in Nexus` }
  if (markets.length !== 1) return { unplaced: `${label} acts on campaigns in ${markets.join(', ')}: one market's ads strategy cannot cover it` }
  return { market: markets[0]!, campaignIds: rows.map((r) => r.id), productIds: [], label }
}

/** An Amazon ads rule's own scope (campaign, product, market or portfolio in it; else the whole account). */
async function ofRule(ruleId: string): Promise<AutomationScope> {
  const r = await prisma.automationRule.findFirst({ where: { id: ruleId, domain: 'advertising' }, select: { name: true, scopeCampaignId: true, scopeProductId: true, scopeMarketplace: true, scopePortfolioId: true } })
  if (!r) return { unplaced: 'the rule was not found in this business' }
  const label = `the rule "${r.name}"`
  if (r.scopeCampaignId) return ofCampaigns([r.scopeCampaignId], label)
  const market = strategyMarket(r.scopeMarketplace)
  if (r.scopeProductId) return market ? { market, campaignIds: [], productIds: [r.scopeProductId], label } : { unplaced: `${label} is for a product in no market` }
  if (market) return { market, campaignIds: [], productIds: [], label: r.scopePortfolioId ? `${label} (a portfolio in ${market})` : `${label} (the whole of ${market})` }
  return WHOLE_ACCOUNT(label)
}

/** A coverage set: its portfolio's campaigns in its market; the market itself when there are none. */
async function ofCoverageSet(setId: string): Promise<AutomationScope> {
  const set = await prisma.keywordCoverageSet.findUnique({ where: { id: setId }, select: { name: true, marketplace: true, portfolioId: true } })
  if (!set) return { unplaced: 'the coverage set was not found in this business' }
  const market = strategyMarket(set.marketplace)
  if (!market) return { unplaced: `the coverage set "${set.name}" has no market` }
  const campaigns = await prisma.campaign.findMany({ where: { portfolioId: set.portfolioId, marketplace: set.marketplace }, select: { id: true } })
  return { market, campaignIds: campaigns.map((c) => c.id), productIds: [], label: `the coverage set "${set.name}"` }
}

/** Where a turn-up of this automation (its number or key) and row lands. */
export async function automationScope(automation: string, rowId?: string | null): Promise<AutomationScope> {
  const { automationAdapter } = await import('../../automation/automation-catalog.service.js')
  const adapter = automationAdapter(automation)
  if (!adapter) return { unplaced: `there is no automation "${automation}"` }
  if (adapter.area !== 'amazon-ads') return { outside: true, why: `${adapter.name} is not Amazon ads` }
  const id = rowId?.trim() || null
  if (!id) return WHOLE_ACCOUNT(adapter.name) // the ads dial, or an engine's own switch for this business
  switch (adapter.id) {
    case 'A1': return ofRule(id)
    case 'A5': {
      const p = await prisma.autopilotPlan.findUnique({ where: { id }, select: { name: true, campaignIds: true } })
      return p ? ofCampaigns(Array.isArray(p.campaignIds) ? (p.campaignIds as string[]) : [], `the autopilot plan "${p.name}"`) : { unplaced: 'the plan was not found in this business' }
    }
    case 'A6': {
      const s = await prisma.adSchedule.findUnique({ where: { id }, select: { name: true, campaignId: true } })
      return s ? ofCampaigns([s.campaignId], `the schedule "${s.name}"`) : { unplaced: 'the schedule was not found in this business' }
    }
    case 'A7': {
      const s = await prisma.budgetSchedule.findUnique({ where: { id }, select: { name: true, campaigns: true } })
      const ids = Array.isArray(s?.campaigns) ? (s!.campaigns as Array<{ id?: string }>).map((c) => c?.id) : []
      return s ? ofCampaigns(ids, `the budget schedule "${s.name}"`) : { unplaced: 'the budget schedule was not found in this business' }
    }
    case 'A9': return ofPool(id)
    case 'A12': return ofCoverageSet(id)
    default: return WHOLE_ACCOUNT(adapter.name)
  }
}

async function ofPool(poolId: string): Promise<AutomationScope> {
  const pool = await prisma.budgetPool.findUnique({ where: { id: poolId }, select: { name: true, allocations: { select: { campaignId: true } } } })
  return pool ? ofCampaigns(pool.allocations.map((a) => a.campaignId), `the budget pool "${pool.name}"`) : { unplaced: 'the budget pool was not found in this business' }
}

/** Where a tune of this engine setting lands (tune-ad-engine's setting, subjectId and values). */
export async function tuneScope(setting: string, subjectId: string | null | undefined, values: Record<string, unknown>): Promise<AutomationScope> {
  const id = subjectId?.trim() || null
  switch (setting) {
    case 'budget-pool': return id ? ofPool(id) : { unplaced: 'it names no budget pool' }
    case 'coverage-set': return id ? ofCoverageSet(id) : { unplaced: 'it names no coverage set' }
    case 'budget-schedule': return id ? automationScope('A7', id) : { unplaced: 'it names no budget schedule' }
    case 'harvest-policy': {
      const grain = String(values.scopeGrain ?? '')
      const scopeId = typeof values.scopeId === 'string' ? values.scopeId.trim() : ''
      if (grain === 'market') {
        const market = strategyMarket(scopeId)
        return market ? { market, campaignIds: [], productIds: [], label: `the harvest policy of ${market}` } : { unplaced: 'the harvest policy names no market' }
      }
      if (grain === 'campaign') return ofCampaigns([scopeId], 'the harvest policy of a campaign')
      if (grain === 'adGroup') {
        const g = scopeId ? await prisma.adGroup.findUnique({ where: { id: scopeId }, select: { campaignId: true } }) : null
        return g ? ofCampaigns([g.campaignId], 'the harvest policy of an ad group') : { unplaced: 'the ad group of the harvest policy was not found' }
      }
      if (grain === 'portfolio') {
        const campaigns = scopeId ? await prisma.campaign.findMany({ where: { portfolioId: scopeId }, select: { id: true } }) : []
        return ofCampaigns(campaigns.map((c) => c.id), 'the harvest policy of a portfolio')
      }
      if (grain === 'line') return { unplaced: 'the harvest policy of a product line reaches every market it sells in' }
      return WHOLE_ACCOUNT('the account harvest policy')
    }
    case 'ebay-campaign-policy': return { outside: true, why: 'an eBay campaign policy is not Amazon ads' }
    case 'rank-target': return { unplaced: 'a rank target can be used by every hourly bid plan, in any market' }
    case 'account-target-acos': return WHOLE_ACCOUNT('the account default target ACoS')
    case 'breaker': return WHOLE_ACCOUNT('the anomaly breaker')
    default: return { unplaced: `there is no engine setting "${setting}"` }
  }
}

/**
 * AA-W2-11 — the one entity the kit judges an automation move on (ads-autonomy-kit.ts): one campaign as itself; several
 * through the products they advertise (the safer value across them wins); a product rule's products; else its market.
 * Null when it is outside the strategy or cannot be placed.
 */
export async function automationEntity(scope: AutomationScope): Promise<import('./autonomy.js').AdEntityRef | null> {
  if ('outside' in scope || 'unplaced' in scope) return null
  if (scope.campaignIds.length === 1) return { kind: 'campaign', id: scope.campaignIds[0] }
  const productIds = scope.productIds.length
    ? scope.productIds
    : scope.campaignIds.length
      ? [...new Set((await prisma.adProductAd.findMany({ where: { adGroup: { campaignId: { in: scope.campaignIds } }, productId: { not: null } }, select: { productId: true } })).map((a) => a.productId!))]
      : []
  return { kind: 'products', market: scope.market, productIds, label: productIds.length || !scope.campaignIds.length ? scope.label : `${scope.label} (its campaigns advertise no product Nexus knows: the market's strategy)` }
}

/**
 * ADS AUTONOMY W4-8 — where a coverage-set seed lands (set-coverage-set op seed): the portfolio's set when it has one,
 * else the portfolio's campaigns (the set the seed creates acts on them).
 */
export async function coverageSeedScope(portfolioId: string): Promise<AutomationScope> {
  const set = await prisma.keywordCoverageSet.findFirst({ where: { portfolioId }, select: { id: true } })
  if (set) return ofCoverageSet(set.id)
  const campaigns = await prisma.campaign.findMany({ where: { portfolioId }, select: { id: true } })
  return ofCampaigns(campaigns.map((c) => c.id), 'the coverage set a seed creates')
}
