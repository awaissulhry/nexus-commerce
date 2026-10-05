/**
 * W2-C — what every campaign launch checks before it creates anything, and how it turns the builder's bid strategy into
 * rules. Pure (no database, no Amazon), so the SP Super Wizard route, the Single Campaign launch and the AI Goal share
 * one answer and the tests need no server.
 *
 *   · CC-29 — the launch market is required. A missing market used to become Italy, silently.
 *   · CC-5  — a portfolio created in Nexus while Amazon writes were closed (`local-pf-…`) has no Amazon id. Sent with a
 *             campaign create, Amazon refuses the whole campaign, so the launch refuses it first and says why.
 *   · CC-4  — the bid strategy. "Target ACoS" becomes one `bid_to_target_acos` rule PER CAMPAIGN, with the target as a
 *             fraction (30 % → 0.3) and the campaign in `campaignId` — the two things that handler reads. It used to
 *             store `targetAcos: 30` and a `campaignIds` list, and the handler refuses both, so every such rule was
 *             inert. "Max Impressions", "Max Orders" and "Custom" have no engine in Nexus: no rule is created and the
 *             answer says so ("not running yet"). They used to store `set_bid_strategy`, which nothing handles.
 */

export function launchMarketRefusal(market: unknown): string | null {
  const m = typeof market === 'string' ? market.trim() : ''
  return m ? null : 'No Amazon marketplace was given for this launch. Nexus does not guess one: pick the marketplace and launch again.'
}

/** A portfolio created in Nexus while Amazon writes were closed: no Amazon id (the same test the web pickers use). */
export const isLocalOnlyPortfolioId = (portfolioId: unknown): boolean =>
  typeof portfolioId === 'string' && portfolioId.startsWith('local-pf-')

export function localPortfolioRefusal(portfolioId: unknown): string | null {
  return isLocalOnlyPortfolioId(portfolioId)
    ? 'This portfolio exists only in Nexus (it was created while Amazon writes were closed), so Amazon does not know it and would refuse the campaign. Pick a portfolio that exists on Amazon, or no portfolio.'
    : null
}

export type BidStrategyKey = 'maxImpressions' | 'targetAcos' | 'maxOrders' | 'custom' | 'none'

export const BID_STRATEGY_LABEL: Record<Exclude<BidStrategyKey, 'none'>, string> = {
  maxImpressions: 'Max Impressions', targetAcos: 'Target ACoS', maxOrders: 'Max Orders', custom: 'Custom',
}

/** The strategies Nexus has an engine for. The others are kept on the screen and say "not running yet". */
export const RUNNING_BID_STRATEGIES: ReadonlySet<string> = new Set(['targetAcos'])

export interface BidStrategyInput { strategy?: string; targetAcos?: string | number; minBid?: string | number; maxBid?: string | number }

export interface BidRuleData {
  name: string
  description: string
  domain: 'advertising'
  trigger: 'SCHEDULE'
  scopeMarketplace: string
  conditions: never[]
  actions: Array<Record<string, unknown>>
  enabled: boolean
  dryRun: true
  maxExecutionsPerDay: number
  createdBy: string | null
}

const positive = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.replace(',', '.')) : NaN
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * The rules a launch creates for its bid strategy, and a sentence when it creates none.
 * `campaigns` are the campaigns this launch created; `source` names the builder in the rule's description.
 */
export function bidStrategyRules(args: {
  bidConfig: BidStrategyInput | null | undefined
  campaigns: Array<{ id: string; name: string }>
  market: string
  enabled: boolean
  createdBy: string | null
  source: string
}): { rules: BidRuleData[]; note: string | null } {
  const strategy = String(args.bidConfig?.strategy ?? 'none')
  if (strategy === 'none' || !args.campaigns.length) return { rules: [], note: null }
  const label = BID_STRATEGY_LABEL[strategy as keyof typeof BID_STRATEGY_LABEL] ?? strategy
  if (!RUNNING_BID_STRATEGIES.has(strategy)) {
    return { rules: [], note: `${label} is not running yet: Nexus has no engine for it, so no bid rule was created.` }
  }
  const pct = positive(args.bidConfig?.targetAcos)
  if (pct == null || pct > 100) {
    return { rules: [], note: `No Target ACoS bid rule was created: the target must be a percentage above 0 and at most 100 (it was ${JSON.stringify(args.bidConfig?.targetAcos ?? '')}).` }
  }
  const minBidEur = positive(args.bidConfig?.minBid)
  const maxBidEur = positive(args.bidConfig?.maxBid)
  const rules = args.campaigns.map((c) => ({
    name: `${c.name} — ${label} bidding`.slice(0, 120),
    description: `Bid strategy from ${args.source}`,
    domain: 'advertising' as const,
    trigger: 'SCHEDULE' as const,
    // One context per market reaches a SCHEDULE rule each tick; without a scope it would run once per market.
    scopeMarketplace: args.market,
    conditions: [] as never[],
    actions: [{
      type: 'bid_to_target_acos',
      targetAcos: Math.round(pct * 100) / 10_000, // 30 (%) → 0.3: the handler reads a fraction
      ...(minBidEur != null ? { minBidEur } : {}),
      ...(maxBidEur != null ? { maxBidEur } : {}),
      campaignId: c.id,
    }],
    enabled: args.enabled,
    dryRun: true as const,
    maxExecutionsPerDay: 4,
    createdBy: args.createdBy,
  }))
  return { rules, note: null }
}
