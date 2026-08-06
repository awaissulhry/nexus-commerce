/**
 * NAF.B — evidence for `amazon-bid-tuner`: the bid optimizer's own
 * proposals (profit-mode + bayesian, `source:'daily'` passed EXPLICITLY —
 * the env default `legacy` reads all-zero columns and yields nothing,
 * ads-bid-optimizer.service.ts:32-53) plus the fleet target-ACOS summary
 * with `basis` verbatim: only 'profit-data' is real; 'estimated-cost' and
 * 'fallback' are the 0.3 default and must not be treated as profit truth
 * (COGS is still unloaded on prod — ACR 0.5).
 */
import prisma from '../../../db.js'
import { previewBidOptimization } from '../../advertising/ads-bid-optimizer.service.js'
import { computeFleetTargetAcos } from '../../advertising/ads-target-acos.service.js'
import type { ObservationBuilder } from '../observation-builder.js'

const PROPOSALS_CAP = 25
const ACOS_ROWS_CAP = 10

export const bidProposalsBuilder: ObservationBuilder = {
  key: 'bid-proposals',
  ttlMinutes: 360,
  async build() {
    const [preview, acosRows, agg] = await Promise.all([
      previewBidOptimization({ profitMode: true, bayesian: true, source: 'daily' }),
      computeFleetTargetAcos({ mode: 'profit' }),
      prisma.amazonAdsDailyPerformance.aggregate({ _max: { date: true } }),
    ])
    const maxDate = agg._max.date ?? new Date(0)

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
        },
        caveats: [
          'Evidence is account-global; the account is IT-primary.',
          "targetAcosSummary.basis: only 'profit-data' reflects real profit; 'estimated-cost' and 'fallback' carry the 0.3 default because COGS is not loaded.",
        ],
        proposals: sorted.slice(0, PROPOSALS_CAP),
        targetAcosSummary: {
          byBasis,
          topByRevenue: acosRows.slice(0, ACOS_ROWS_CAP).map((r) => ({
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
