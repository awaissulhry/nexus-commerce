/**
 * NAF.B — evidence for `amazon-negative-miner`: the deterministic negative
 * candidates (previewHarvest — spend with zero orders), the n-gram waste
 * table, and the account's EXISTING negatives so the analyst never proposes
 * a term that is already negated.
 *
 * Honesty contract (plan D4/D5): lists are capped with the trims counted;
 * evidence is account-global and says so; existing negatives are read via
 * the `isNegative` boolean ONLY — 1,068 prod negatives carry
 * expressionType='EXACT', so any match-type filter lies (the coverage
 * service at ads-coverage.service.ts:290 is the canonical pattern).
 *
 * dataVintage = end of the newest covered day (max(date) + 24h): search-term
 * rows are date-grained, so "Aug 5" data is complete at Aug 6 00:00. The
 * charter's 26h tolerance then trips exactly when ingest misses a night.
 */
import prisma from '../../../db.js'
import { previewHarvest } from '../../advertising/ads-harvest.service.js'
import { analyzeNgrams } from '../../advertising/ads-ngram.service.js'
import type { ObservationBuilder, ObservationNarrow } from '../observation-builder.js'
import { filterToCampaigns, filterToMarketplace } from './scope-filter.js'

/** The slice of this builder's payload that campaign narrowing rewrites. */
interface NegativeCandidatesPayload {
  scope: string
  counts: Record<string, number>
  caveats: string[]
  negatives: { externalCampaignId?: string; query: string }[]
  productNegatives: { externalCampaignId?: string; query: string }[]
  ngramWasteful: unknown[]
  [k: string]: unknown
}

const NEGATIVES_CAP = 25
const PRODUCT_NEGATIVES_CAP = 10
const NGRAM_CAP = 15
/** DB fetch bound for existing negatives — relevance-filtered before the
 *  payload (the first supervised run shipped 400 raw rows, blew the prompt
 *  to 15k tokens, and left no retry headroom under maxTokensPerRun). */
const EXISTING_NEGATIVES_FETCH_CAP = 1000
const EXISTING_NEGATIVES_PAYLOAD_CAP = 100

async function searchTermVintage(): Promise<Date> {
  const agg = await prisma.amazonAdsSearchTerm.aggregate({ _max: { date: true } })
  const maxDate = agg._max.date ?? new Date(0)
  return new Date(maxDate.getTime() + 24 * 3600_000)
}

export const negativeCandidatesBuilder: ObservationBuilder = {
  key: 'negative-candidates',
  ttlMinutes: 360,
  async build(scope) {
    const marketplace = scope.marketplace
    const [preview, grams, existing, vintage] = await Promise.all([
      previewHarvest({}),
      analyzeNgrams({}),
      prisma.adTarget.findMany({
        where: { isNegative: true },
        select: { expressionValue: true, negativeLevel: true },
        take: EXISTING_NEGATIVES_FETCH_CAP,
      }),
      searchTermVintage(),
    ])

    // AC.4 — scope, enforced: a worker scoped to one marketplace never
    // sees another market's candidates. Drops are counted, never silent.
    const scopedNeg = await filterToMarketplace(preview.negatives, marketplace)
    const scopedProd = await filterToMarketplace(preview.productNegatives, marketplace)
    const negatives = scopedNeg.kept.slice(0, NEGATIVES_CAP)
    const productNegatives = scopedProd.kept.slice(0, PRODUCT_NEGATIVES_CAP)
    // n-grams are cross-campaign aggregates with no campaign of their own,
    // so they cannot be scoped — they are withheld entirely under a scope
    // rather than shown misleadingly.
    const ngramWasteful = marketplace ? [] : grams.wasteful.slice(0, NGRAM_CAP)

    // Relevance filter: the analyst only needs the existing negatives that
    // could collide with what it might propose — those sharing a word with
    // a shown candidate query or gram. 400 raw rows was prompt bloat.
    const candidateTokens = new Set<string>()
    for (const c of [...negatives, ...productNegatives]) {
      for (const t of c.query.toLowerCase().split(/\s+/)) {
        if (t.length > 1) candidateTokens.add(t)
      }
    }
    for (const g of ngramWasteful) {
      for (const t of g.gram.toLowerCase().split(/\s+/)) {
        if (t.length > 1) candidateTokens.add(t)
      }
    }
    const existingNegativeTerms = existing
      .map((e) => ({ term: e.expressionValue.toLowerCase(), level: e.negativeLevel }))
      .filter((e) =>
        e.term.split(/\s+/).some((t) => candidateTokens.has(t)),
      )
      .slice(0, EXISTING_NEGATIVES_PAYLOAD_CAP)

    return {
      payload: {
        scope: marketplace ? `marketplace:${marketplace}` : 'account',
        windowDays: preview.windowDays,
        thresholds: { minSpendCents: 1500, minOrders: 2, ngramMinCostCents: 300 },
        counts: {
          negativesTotal: preview.negatives.length,
          negativesTrimmed: Math.max(0, preview.negatives.length - NEGATIVES_CAP),
          productNegativesTotal: preview.productNegatives.length,
          ngramWastefulTotal: grams.wasteful.length,
          existingNegatives: existingNegativeTerms.length,
          droppedOutOfScope: scopedNeg.droppedOutOfScope + scopedProd.droppedOutOfScope,
          unresolvedCampaign: scopedNeg.unresolved + scopedProd.unresolved,
          ngramsWithheldUnderScope: marketplace ? grams.wasteful.length : 0,
        },
        caveats: [
          marketplace
            ? `Evidence is filtered to marketplace ${marketplace}; n-gram themes are account-wide and are withheld under a scope rather than shown misleadingly.`
            : 'Evidence is account-global (the engines have no marketplace filter); the account is IT-primary.',
          'N-gram rows attribute whole-query metrics to every gram — grams overlap, so their spend must NOT be summed.',
          'existingNegativeTerms lists already-negated terms RELEVANT to the shown candidates (relevance-filtered): never propose one of these again.',
        ],
        negatives,
        productNegatives,
        ngramWasteful,
        existingNegativeTerms,
      },
      dataVintage: vintage,
    }
  },

  /**
   * NAF.SB.AS — narrow the account-wide payload to named campaigns, in
   * memory. Pure: no database read, because candidates already carry
   * `externalCampaignId`.
   *
   * n-grams are withheld entirely, exactly as they already are under a
   * marketplace scope — they are cross-campaign aggregates with no campaign
   * of their own, so showing them under a one-campaign assignment would
   * attribute other campaigns' waste to this one. Withheld and COUNTED, per
   * the no-silent-caps rule.
   *
   * `existingNegativeTerms` is deliberately left as computed. It is the
   * "never propose these again" list, so a superset is safe — narrowing it
   * could only let the analyst re-propose a term that is already negated.
   */
  narrow(payload, narrow: ObservationNarrow) {
    const p = payload as NegativeCandidatesPayload
    const ids = narrow.campaignExternalIds
    const neg = filterToCampaigns(p.negatives, ids)
    const prod = filterToCampaigns(p.productNegatives, ids)
    const withheldNgrams = p.ngramWasteful.length
    const label =
      narrow.campaignLabels && narrow.campaignLabels.length
        ? narrow.campaignLabels.join(', ')
        : `${ids?.length ?? 0} campaign(s)`

    return {
      ...p,
      scope: `campaigns:${ids?.length ?? 0}`,
      negatives: neg.kept,
      productNegatives: prod.kept,
      ngramWasteful: [],
      counts: {
        ...p.counts,
        negativesTotal: neg.kept.length,
        negativesTrimmed: 0,
        productNegativesTotal: prod.kept.length,
        droppedOutOfScope:
          (p.counts.droppedOutOfScope ?? 0) + neg.droppedOutOfScope + prod.droppedOutOfScope,
        unresolvedCampaign:
          (p.counts.unresolvedCampaign ?? 0) + neg.unresolved + prod.unresolved,
        ngramsWithheldUnderScope: withheldNgrams,
      },
      caveats: [
        `This run is narrowed to ${label}. Every candidate below belongs to it; ${neg.droppedOutOfScope + prod.droppedOutOfScope} candidate(s) from other campaigns were dropped.`,
        'N-gram waste themes are account-wide totals with no campaign of their own, so they are withheld under a campaign scope rather than shown misleadingly. Finding fewer things than an account-wide run is the expected result, not a fault.',
        ...p.caveats.slice(1),
      ],
    }
  },
}
