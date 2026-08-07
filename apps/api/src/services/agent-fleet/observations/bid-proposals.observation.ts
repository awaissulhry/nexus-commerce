/**
 * NAF.B — evidence for `amazon-bid-tuner`: the bid optimizer's own
 * proposals (profit-mode + bayesian, `source:'daily'` passed EXPLICITLY —
 * the env default `legacy` reads all-zero columns and yields nothing,
 * ads-bid-optimizer.service.ts:32-53) plus a BOUNDED target-ACOS summary
 * with `basis` verbatim: only 'profit-data' is real; 'estimated-cost' and
 * 'fallback' are the 0.3 default and must not be treated as profit truth
 * (COGS is still unloaded on prod — ACR 0.5).
 *
 * Deliberately NOT computeFleetTargetAcos: that helper loops
 * computeProductTargetAcos sequentially over up to 1000 products (two
 * round-trips each over the pooler) — the first supervised run hung for
 * minutes inside it. The builder does its own top-N groupBy and calls the
 * per-product engine for exactly ACOS_ROWS_CAP products, preserving the
 * engine's math and `basis` semantics with a hard query bound.
 */
import prisma from '../../../db.js'
import { previewBidOptimization } from '../../advertising/ads-bid-optimizer.service.js'
import { computeProductTargetAcos } from '../../advertising/ads-target-acos.service.js'
import type { ObservationBuilder, ObservationNarrow } from '../observation-builder.js'

/** The slice of this builder's payload campaign narrowing rewrites. */
interface BidProposalsPayload {
  scope: string
  counts: Record<string, number>
  caveats: string[]
  proposals: { targetId: string }[]
  targetAcosSummary: unknown
  [k: string]: unknown
}

const PROPOSALS_CAP = 25
const ACOS_ROWS_CAP = 10
const WINDOW_DAYS = 30

export const bidProposalsBuilder: ObservationBuilder = {
  key: 'bid-proposals',
  ttlMinutes: 360,
  /**
   * NAF.SB.AS.2 — CAMPAIGN only, and the omission of MARKETPLACE is
   * deliberate rather than an oversight: `build()` below takes no scope
   * argument at all, so a marketplace target would bind nothing here.
   * Declaring it would be exactly the `scopeCampaignIds` defect again.
   */
  narrowKinds: ['CAMPAIGN'] as const,
  label: 'bids that look wrong',
  describeNarrowing() {
    return [
      'Bid changes the optimiser suggests, for this campaign only.',
      'The profit summary beside them stays ACCOUNT-WIDE and is labelled so: a product sells through many campaigns, so it has no campaign of its own. It is background for the bids, not a total for this campaign.',
    ]
  },
  itemCount(payload) {
    return (payload as BidProposalsPayload).proposals.length
  },
  async build() {
    const since = new Date()
    since.setUTCDate(since.getUTCDate() - WINDOW_DAYS)
    since.setUTCHours(0, 0, 0, 0)

    const [preview, topProducts, agg] = await Promise.all([
      previewBidOptimization({ profitMode: true, bayesian: true, source: 'daily' }),
      prisma.productProfitDaily.groupBy({
        by: ['productId'],
        where: { date: { gte: since }, grossRevenueCents: { gt: 0 } },
        _sum: { grossRevenueCents: true },
        orderBy: { _sum: { grossRevenueCents: 'desc' } },
        take: ACOS_ROWS_CAP,
      }),
      prisma.amazonAdsDailyPerformance.aggregate({ _max: { date: true } }),
    ])
    const maxDate = agg._max.date ?? new Date(0)

    // Bounded: exactly ACOS_ROWS_CAP per-product engine calls, sequential
    // is fine at this size.
    const acosRows = []
    for (const g of topProducts) {
      acosRows.push(
        await computeProductTargetAcos({
          productId: g.productId,
          windowDays: WINDOW_DAYS,
          mode: 'profit',
        }),
      )
    }

    const sorted = [...preview.proposals].sort(
      (a, b) => Math.abs(b.deltaCents) - Math.abs(a.deltaCents),
    )
    const byBasis: Record<string, number> = {}
    for (const r of acosRows) byBasis[r.basis] = (byBasis[r.basis] ?? 0) + 1

    return {
      payload: {
        scope: 'account',
        engineTargetAcos: preview.targetAcos,
        counts: {
          proposalsTotal: preview.proposals.length,
          proposalsTrimmed: Math.max(0, preview.proposals.length - PROPOSALS_CAP),
          acosProductsShown: acosRows.length,
        },
        caveats: [
          'Evidence is account-global; the account is IT-primary.',
          "targetAcosSummary.basis: only 'profit-data' reflects real profit; 'estimated-cost' and 'fallback' carry the 0.3 default because COGS is not loaded.",
          `targetAcosSummary covers only the top ${ACOS_ROWS_CAP} products by revenue.`,
        ],
        proposals: sorted.slice(0, PROPOSALS_CAP),
        targetAcosSummary: {
          byBasis,
          topByRevenue: acosRows.map((r) => ({
            productId: r.productId,
            marketplace: r.marketplace,
            basis: r.basis,
            breakevenAcos: r.breakevenAcos,
            targetAcos: r.targetAcos,
            grossRevenueCents: r.grossRevenueCents,
            adSpendCents: r.adSpendCents,
          })),
        },
      },
      dataVintage: new Date(maxDate.getTime() + 24 * 3600_000),
    }
  },

  /**
   * NAF.SB.AS.2 — narrow the bid proposals to named campaigns.
   *
   * This is the one builder whose narrowing needs a database read, and the
   * reason is an id-dialect mismatch worth stating: a `BidProposal` carries
   * `targetId` — an `AdTarget.id` cuid — and no campaign at all, while every
   * fleet-facing id (plan-item args, finding entityIds, harvest candidates)
   * is the Amazon EXTERNAL campaign id. So the join is
   * `AdTarget → AdGroup → Campaign.externalCampaignId`.
   *
   * Why not the cheaper-looking route: `previewBidOptimization` accepts a
   * `campaignId` and would narrow the query itself — but it takes the
   * INTERNAL `Campaign.id`, and using it would key the observation cache per
   * campaign, so twenty-five assignments would run the account-wide engine
   * twenty-five times. One shared scan plus one indexed join is cheaper and
   * keeps `evidenceRefs` pointing at a row every assignment can cite.
   *
   * `targetAcosSummary` is left as computed: it is a per-PRODUCT profit
   * summary with no campaign dimension, so it cannot be narrowed — and,
   * unlike the miner's n-grams, it is context rather than a candidate list,
   * so withholding it would remove the numbers that justify the bids without
   * removing any proposal. It is relabelled account-wide in the caveats
   * instead, which is the honest treatment for evidence that is background.
   */
  async narrow(payload, narrow: ObservationNarrow) {
    const p = payload as BidProposalsPayload
    const ids = narrow.campaignExternalIds
    const label =
      narrow.campaignLabels && narrow.campaignLabels.length
        ? narrow.campaignLabels.join(', ')
        : `${ids?.length ?? 0} campaign(s)`

    if (ids === undefined) return p
    // Fail closed: an empty scope narrows to nothing, never to everything.
    if (ids.length === 0 || p.proposals.length === 0) {
      return {
        ...p,
        scope: `campaigns:${ids.length}`,
        proposals: [],
        counts: { ...p.counts, proposalsTotal: 0, proposalsTrimmed: 0 },
        caveats: [`This run is narrowed to ${label}. No bid proposals fall inside it.`, ...p.caveats.slice(1)],
      }
    }

    const rows = await prisma.adTarget.findMany({
      where: { id: { in: p.proposals.map((x) => x.targetId) } },
      select: { id: true, adGroup: { select: { campaign: { select: { externalCampaignId: true } } } } },
    })
    const campaignByTarget = new Map(
      rows.map((r) => [r.id, r.adGroup?.campaign?.externalCampaignId ?? null]),
    )

    const allow = new Set(ids)
    const kept: { targetId: string }[] = []
    let droppedOutOfScope = 0
    let unresolved = 0
    for (const prop of p.proposals) {
      const ext = campaignByTarget.get(prop.targetId)
      // A target whose campaign cannot be resolved is DROPPED and counted —
      // we cannot prove it belongs, and keeping it would silently widen.
      if (!ext) unresolved++
      else if (allow.has(ext)) kept.push(prop)
      else droppedOutOfScope++
    }

    return {
      ...p,
      scope: `campaigns:${ids.length}`,
      proposals: kept,
      counts: {
        ...p.counts,
        proposalsTotal: kept.length,
        proposalsTrimmed: 0,
        droppedOutOfScope: (p.counts.droppedOutOfScope ?? 0) + droppedOutOfScope,
        unresolvedCampaign: (p.counts.unresolvedCampaign ?? 0) + unresolved,
      },
      caveats: [
        `This run is narrowed to ${label}. ${droppedOutOfScope} proposal(s) for other campaigns were dropped. Finding fewer things than an account-wide run is the expected result, not a fault.`,
        'targetAcosSummary below is per-PRODUCT and stays ACCOUNT-WIDE — a product sells through many campaigns, so it has no campaign of its own. Use it as background for the bids above, not as a total for this campaign.',
        ...p.caveats.slice(1),
      ],
    }
  },
}
