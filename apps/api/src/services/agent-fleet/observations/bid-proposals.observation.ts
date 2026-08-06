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
import type { ObservationBuilder } from '../observation-builder.js'

const PROPOSALS_CAP = 25
const ACOS_ROWS_CAP = 10
const WINDOW_DAYS = 30

export const bidProposalsBuilder: ObservationBuilder = {
  key: 'bid-proposals',
  ttlMinutes: 360,
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
}
