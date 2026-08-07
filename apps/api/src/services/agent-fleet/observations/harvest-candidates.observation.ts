/**
 * NAF.B — evidence for `amazon-keyword-harvester`: the deterministic
 * graduation candidates (previewHarvest — search terms with proven orders).
 * Caps counted; account-global stated; vintage = end of newest covered day.
 */
import prisma from '../../../db.js'
import { previewHarvest } from '../../advertising/ads-harvest.service.js'
import type { ObservationBuilder } from '../observation-builder.js'
import { filterToMarketplace } from './scope-filter.js'

const GRADUATIONS_CAP = 25
const PRODUCT_GRADUATIONS_CAP = 10

export const harvestCandidatesBuilder: ObservationBuilder = {
  key: 'harvest-candidates',
  ttlMinutes: 360,
  async build(scope) {
    const marketplace = scope.marketplace
    const [preview, agg] = await Promise.all([
      previewHarvest({}),
      prisma.amazonAdsSearchTerm.aggregate({ _max: { date: true } }),
    ])
    const maxDate = agg._max.date ?? new Date(0)
    // AC.4 — scope, enforced (see scope-filter.ts).
    const scopedGrad = await filterToMarketplace(preview.graduations, marketplace)
    const scopedProdGrad = await filterToMarketplace(preview.productGraduations, marketplace)

    return {
      payload: {
        scope: marketplace ? `marketplace:${marketplace}` : 'account',
        windowDays: preview.windowDays,
        thresholds: { minSpendCents: 1500, minOrders: 2 },
        counts: {
          graduationsTotal: scopedGrad.kept.length,
          graduationsTrimmed: Math.max(0, scopedGrad.kept.length - GRADUATIONS_CAP),
          productGraduationsTotal: scopedProdGrad.kept.length,
          droppedOutOfScope: scopedGrad.droppedOutOfScope + scopedProdGrad.droppedOutOfScope,
          unresolvedCampaign: scopedGrad.unresolved + scopedProdGrad.unresolved,
        },
        caveats: [
          marketplace
            ? `Evidence is filtered to marketplace ${marketplace}.`
            : 'Evidence is account-global (no marketplace filter on the engine); the account is IT-primary.',
          'Candidate ids are Amazon EXTERNAL campaign/ad-group ids.',
        ],
        graduations: scopedGrad.kept.slice(0, GRADUATIONS_CAP),
        productGraduations: scopedProdGrad.kept.slice(0, PRODUCT_GRADUATIONS_CAP),
      },
      dataVintage: new Date(maxDate.getTime() + 24 * 3600_000),
    }
  },
}
