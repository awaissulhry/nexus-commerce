/**
 * NAF.B — evidence for `amazon-keyword-harvester`: the deterministic
 * graduation candidates (previewHarvest — search terms with proven orders).
 * Caps counted; account-global stated; vintage = end of newest covered day.
 */
import prisma from '../../../db.js'
import { previewHarvest } from '../../advertising/ads-harvest.service.js'
import type { ObservationBuilder, ObservationNarrow } from '../observation-builder.js'
import { filterToCampaigns, filterToMarketplace } from './scope-filter.js'

interface HarvestCandidatesPayload {
  scope: string
  counts: Record<string, number>
  caveats: string[]
  graduations: { externalCampaignId?: string }[]
  productGraduations: { externalCampaignId?: string }[]
  [k: string]: unknown
}

const GRADUATIONS_CAP = 25
const PRODUCT_GRADUATIONS_CAP = 10

export const harvestCandidatesBuilder: ObservationBuilder = {
  key: 'harvest-candidates',
  ttlMinutes: 360,
  // CAMPAIGN via narrow() below; MARKETPLACE via filterToMarketplace in
  // build(scope). Both are exercised by assignment-narrowkinds.vitest.
  narrowKinds: ['CAMPAIGN', 'MARKETPLACE'] as const,
  label: 'search terms worth keeping',
  describeNarrowing(kind) {
    const where = kind === 'CAMPAIGN' ? 'this campaign' : 'this marketplace'
    return [`Search terms that actually converted, for ${where} only.`]
  },
  itemCount(payload) {
    const p = payload as HarvestCandidatesPayload
    return p.graduations.length + p.productGraduations.length
  },
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

  /** NAF.SB.AS — see negative-candidates.observation.ts for the full
   *  rationale. Pure in-memory: graduation candidates already carry
   *  `externalCampaignId`. */
  narrow(payload, narrow: ObservationNarrow) {
    const p = payload as HarvestCandidatesPayload
    const ids = narrow.campaignExternalIds
    const grad = filterToCampaigns(p.graduations, ids)
    const prodGrad = filterToCampaigns(p.productGraduations, ids)
    const label =
      narrow.campaignLabels && narrow.campaignLabels.length
        ? narrow.campaignLabels.join(', ')
        : `${ids?.length ?? 0} campaign(s)`

    return {
      ...p,
      scope: `campaigns:${ids?.length ?? 0}`,
      graduations: grad.kept,
      productGraduations: prodGrad.kept,
      counts: {
        ...p.counts,
        graduationsTotal: grad.kept.length,
        graduationsTrimmed: 0,
        productGraduationsTotal: prodGrad.kept.length,
        droppedOutOfScope:
          (p.counts.droppedOutOfScope ?? 0) + grad.droppedOutOfScope + prodGrad.droppedOutOfScope,
        unresolvedCampaign:
          (p.counts.unresolvedCampaign ?? 0) + grad.unresolved + prodGrad.unresolved,
      },
      caveats: [
        `This run is narrowed to ${label}. ${grad.droppedOutOfScope + prodGrad.droppedOutOfScope} candidate(s) from other campaigns were dropped. Finding fewer things than an account-wide run is the expected result, not a fault.`,
        ...p.caveats.slice(1),
      ],
    }
  },
}
