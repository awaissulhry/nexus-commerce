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
import type { ObservationBuilder } from '../observation-builder.js'

const NEGATIVES_CAP = 25
const PRODUCT_NEGATIVES_CAP = 10
const NGRAM_CAP = 15
const EXISTING_NEGATIVES_CAP = 400

async function searchTermVintage(): Promise<Date> {
  const agg = await prisma.amazonAdsSearchTerm.aggregate({ _max: { date: true } })
  const maxDate = agg._max.date ?? new Date(0)
  return new Date(maxDate.getTime() + 24 * 3600_000)
}

export const negativeCandidatesBuilder: ObservationBuilder = {
  key: 'negative-candidates',
  ttlMinutes: 360,
  async build() {
    const [preview, grams, existing, vintage] = await Promise.all([
      previewHarvest({}),
      analyzeNgrams({}),
      prisma.adTarget.findMany({
        where: { isNegative: true },
        select: { expressionValue: true, negativeLevel: true },
        take: EXISTING_NEGATIVES_CAP,
      }),
      searchTermVintage(),
    ])

    const negatives = preview.negatives.slice(0, NEGATIVES_CAP)
    const productNegatives = preview.productNegatives.slice(0, PRODUCT_NEGATIVES_CAP)
    const ngramWasteful = grams.wasteful.slice(0, NGRAM_CAP)
    const existingNegativeTerms = existing.map((e) => ({
      term: e.expressionValue.toLowerCase(),
      level: e.negativeLevel,
    }))

    return {
      payload: {
        scope: 'account',
        windowDays: preview.windowDays,
        thresholds: { minSpendCents: 1500, minOrders: 2, ngramMinCostCents: 300 },
        counts: {
          negativesTotal: preview.negatives.length,
          negativesTrimmed: Math.max(0, preview.negatives.length - NEGATIVES_CAP),
          productNegativesTotal: preview.productNegatives.length,
          ngramWastefulTotal: grams.wasteful.length,
          existingNegatives: existingNegativeTerms.length,
        },
        caveats: [
          'Evidence is account-global (the engines have no marketplace filter); the account is IT-primary.',
          'N-gram rows attribute whole-query metrics to every gram — grams overlap, so their spend must NOT be summed.',
          'existingNegativeTerms lists terms already negated: never propose one of these again.',
        ],
        negatives,
        productNegatives,
        ngramWasteful,
        existingNegativeTerms,
      },
      dataVintage: vintage,
    }
  },
}
