/**
 * ACR.5 — put a € on every pending proposal, so 150 rows become a ranked decision.
 *
 * Measured 2026-08-05: 150 pending, 150 DISTINCT findings (no duplication — the rules are
 * working), 121 of them created in a single day. Nobody acts on them, and the reason is visible
 * the moment you look at the queue: every row is an undifferentiated "a rule would like to change
 * something". There is no way to tell the one covering €400 of dead spend from the one covering
 * 30 cents, so the rational response to the list is to ignore all of it.
 *
 * 113 of the 150 resolve to an AdTarget that now has 30 days of grain behind it (ACR.2.2), and
 * those targets carry **€3,604 of 30-day spend**. So the money is knowable.
 *
 * ── What the number means, and what it does not ─────────────────────────────────────────────
 * `spendAtStake` is the money the action would REDIRECT, not money it would save. That
 * distinction is the whole honesty of this file:
 *
 *   · A bid-down on a target with no sales redirects pure waste — `recoverable: true`.
 *   · A bid-down on a target that IS selling is a trade: less spend and less revenue. Calling
 *     that a saving would make every "cut the winner" proposal look like the best idea on the
 *     board, which is exactly backwards.
 *   · `promote_to_exact` and budget increases INCREASE spend. They are priced too, but as
 *     `direction: 'increase'`, because a board that only ever counts reductions teaches an
 *     operator that automation is a cost-cutting tool.
 *
 * Estimates are proportional and deliberately crude — a 25% bid cut is priced at 25% of trailing
 * spend. Bid changes move volume as well as price, so the true figure is unknowable in advance.
 * The point is ranking, not forecasting: it only has to get the ORDER right.
 */
import prisma from '../../db.js'

export type ProposalDirection = 'reduce' | 'increase' | 'structural'

export interface PricedProposal {
  id: string
  ruleName: string | null
  entityType: string
  entityId: string
  entityLabel: string | null
  proposedKey: string
  createdAt: string
  direction: ProposalDirection
  /** Trailing 30-day spend the action would redirect. null when it cannot be resolved. */
  spendAtStakeCents: number | null
  /** Sales that spend produced. 0 means the spend bought nothing. */
  salesAtStakeCents: number | null
  /** True only when the spend produced NO sales — the only case where "saving" is honest. */
  recoverable: boolean
}

export interface ProposalPricing {
  pending: number
  priced: number
  /** Total trailing spend covered by reduce-direction proposals. */
  spendAtStakeCents: number
  /** Of that, the part that produced no sales at all. */
  recoverableCents: number
  top: PricedProposal[]
}

/** How much of a target's trailing spend each action type puts in play. */
function stakeFraction(proposedKey: string, action: Record<string, unknown>): { frac: number; direction: ProposalDirection } {
  switch (proposedKey) {
    case 'lower_bid_to_floor':
      // Bid to ~5¢ stops the target serving in practice, so all of its spend is in play.
      return { frac: 1, direction: 'reduce' }
    case 'bid_down': {
      const pct = Number(action.percent ?? 0)
      return { frac: Math.min(1, Math.max(0, pct / 100)), direction: 'reduce' }
    }
    case 'add_negative_exact':
    case 'harvest_and_negate':
      return { frac: 1, direction: 'structural' }
    case 'promote_to_exact':
      return { frac: 1, direction: 'increase' }
    case 'adjust_ad_budget': {
      const pct = Number(action.percent ?? 0)
      return { frac: Math.min(1, Math.abs(pct) / 100), direction: pct >= 0 ? 'increase' : 'reduce' }
    }
    default: {
      const pct = Number(action.percent ?? action.value ?? 0)
      if (!Number.isFinite(pct) || pct === 0) return { frac: 0, direction: 'structural' }
      return { frac: Math.min(1, Math.abs(pct) / 100), direction: pct >= 0 ? 'increase' : 'reduce' }
    }
  }
}

export async function pricePendingProposals(
  limit = 15,
  opts: { campaignIds?: string[] } = {},
): Promise<ProposalPricing> {
  const pending = await prisma.adsRuleSuggestion.findMany({
    where: { status: 'pending' },
    select: {
      id: true, ruleName: true, entityType: true, entityId: true, entityName: true,
      proposedKey: true, proposedAction: true, createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
  })
  if (pending.length === 0) {
    return { pending: 0, priced: 0, spendAtStakeCents: 0, recoverableCents: 0, top: [] }
  }

  // One pass for the trailing spend of every target these proposals point at. Keyed by the
  // AMAZON id, because that is what the performance grain is keyed by — the local AdTarget.id
  // the proposal carries has to be translated first.
  const targetIds = [...new Set(pending.filter((p) => p.entityType === 'AD_TARGET').map((p) => p.entityId))]
  const targets = targetIds.length
    ? await prisma.adTarget.findMany({
      where: { id: { in: targetIds } },
      select: { id: true, externalTargetId: true, expressionValue: true, adGroup: { select: { campaignId: true } } },
    })
    : []
  const campByTarget = new Map(targets.map((t) => [t.id, t.adGroup.campaignId]))
  const extByLocal = new Map(targets.map((t) => [t.id, t.externalTargetId]))
  const labelByLocal = new Map(targets.map((t) => [t.id, t.expressionValue]))

  const externalIds = targets.map((t) => t.externalTargetId).filter((x): x is string => !!x)
  const perf = externalIds.length
    ? await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['entityId'],
      where: { entityType: 'AD_TARGET', entityId: { in: externalIds } },
      _sum: { costMicros: true, sales7dCents: true },
    })
    : []
  const spendByExt = new Map(perf.map((r) => [r.entityId, {
    spendCents: Math.round(Number(r._sum.costMicros ?? 0) / 10_000),
    salesCents: Number(r._sum.sales7dCents ?? 0),
  }]))

  // ACR.6 — the family lens: keep only proposals whose entity resolves into the given
  // campaigns. A proposal that cannot be resolved to a campaign is dropped rather than kept,
  // because "unknown scope" shown inside a family cockpit reads as "this family's".
  const scope = opts.campaignIds?.length ? new Set(opts.campaignIds) : null
  const inScope = scope
    ? pending.filter((p) =>
      p.entityType === 'CAMPAIGN'
        ? scope.has(p.entityId)
        : p.entityType === 'AD_TARGET' && scope.has(campByTarget.get(p.entityId) ?? ''))
    : pending

  const priced: PricedProposal[] = inScope.map((p) => {
    const action = (p.proposedAction ?? {}) as Record<string, unknown>
    const { frac, direction } = stakeFraction(p.proposedKey, action)
    const ext = extByLocal.get(p.entityId)
    const row = ext ? spendByExt.get(ext) : undefined
    const spend = row ? Math.round(row.spendCents * frac) : null
    const sales = row ? Math.round(row.salesCents * frac) : null
    return {
      id: p.id,
      ruleName: p.ruleName,
      entityType: p.entityType,
      entityId: p.entityId,
      entityLabel: p.entityName ?? labelByLocal.get(p.entityId) ?? null,
      proposedKey: p.proposedKey,
      createdAt: p.createdAt.toISOString(),
      direction,
      spendAtStakeCents: spend,
      salesAtStakeCents: sales,
      // "Recoverable" is reserved for spend that bought NOTHING. A bid-down on a selling
      // keyword is a trade-off, and dressing it as a saving would rank every proposal to cut
      // a winner above every proposal to cut a loser.
      recoverable: row != null && row.salesCents === 0 && direction === 'reduce' && (spend ?? 0) > 0,
    }
  })

  const reduce = priced.filter((p) => p.direction === 'reduce')
  return {
    pending: inScope.length,
    priced: priced.filter((p) => p.spendAtStakeCents != null).length,
    spendAtStakeCents: reduce.reduce((a, p) => a + (p.spendAtStakeCents ?? 0), 0),
    recoverableCents: reduce.filter((p) => p.recoverable).reduce((a, p) => a + (p.spendAtStakeCents ?? 0), 0),
    // Recoverable first, then by size. An operator working top-down should meet the decisions
    // that are pure upside before the ones that involve a trade.
    top: [...priced]
      .sort((a, b) =>
        Number(b.recoverable) - Number(a.recoverable)
        || (b.spendAtStakeCents ?? -1) - (a.spendAtStakeCents ?? -1))
      .slice(0, limit),
  }
}
