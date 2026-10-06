/**
 * ADS PLAYBOOK — made-up fixtures for the playbook suites (public repo: no real terms, names or numbers).
 *
 *   templateDoc()      a small valid template: Auto, Broad and Exact category, an optional Exact brand slot, PAT; two
 *                      rank roles; the default harvest edges, isolation and phase table for those slots
 *   liveCampaign()     one live campaign in the blueprint reader's shape (ads-blueprint.service.ts loadSourceCampaigns)
 */
import type { SourceCampaign, SourceTarget } from '../services/ads-core/ads-blueprint.js'
import { DEFAULT_ISOLATION, defaultHarvest, defaultPhases } from '../services/advertising/ads-playbook/defaults.js'
import { SLOT, type TemplateDoc } from '../services/advertising/ads-playbook/doc.js'

export function templateDoc(): TemplateDoc {
  const slots = [
    { key: 'auto', targeting: 'AUTO', intent: 'ANY', rankRole: 'research', nameParts: ['Auto'], autoGroups: { CLOSE_MATCH: { on: true, factor: 1 }, LOOSE_MATCH: { on: true, factor: 0.8 } } },
    { key: 'broad-category', targeting: 'KEYWORD', match: 'BROAD', intent: 'CATEGORY', rankRole: 'research', feeds: ['category'], nameParts: ['Broad', 'Category'] },
    { key: 'exact-category', targeting: 'KEYWORD', match: 'EXACT', intent: 'CATEGORY', rankRole: 'performance', feeds: ['categoryExactAtStart'], nameParts: ['Exact', 'Category'] },
    { key: 'exact-brand', targeting: 'KEYWORD', match: 'EXACT', intent: 'BRAND', rankRole: 'performance', feeds: ['brand'], nameParts: ['Exact', 'Brand'], optional: true },
    { key: 'pat', targeting: 'PRODUCT', intent: 'ANY', rankRole: 'none', feeds: ['competitorAsins'], nameParts: ['PAT'] },
  ].map((s) => SLOT.parse(s))
  const weights = { auto: 15, 'broad-category': 20, 'exact-category': 35, 'exact-brand': 10, pat: 20 }
  return {
    structure: {
      naming: { pattern: '{product} | {market} | {parts}', partSeparator: ' | ' },
      portfolio: { pattern: 'Test {product} {market}', mode: 'reuse-or-create' },
      productAds: { fulfilment: 'FBA' },
      sharedTerms: 'skip',
      slots,
    },
    budget: { weights, minPerSlotCents: 100 },
    bids: { ladder: { auto: 1, 'broad-category': 0.9, 'exact-category': 1.3, 'exact-brand': 1.2, pat: 1.1 }, launch: 'floor' },
    placements: { 'exact-category': { top: 25, productPage: 0, restOfSearch: 0 }, pat: { top: 10, productPage: 15, restOfSearch: 0 } },
    harvest: defaultHarvest(slots),
    isolation: DEFAULT_ISOLATION,
    rank: {
      roles: {
        performance: { windows: [{ days: [1, 2, 3, 4, 5], startHour: 8, endHour: 21, targetKey: 'test-own-top' }], baseline: 'test-rest' },
        research: { windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 7, targetKey: 'test-min-bid' }], baseline: null },
      },
    },
    phases: defaultPhases(slots, weights),
  }
}

const keyword = (text: string, match: string, bidCents: number | null, isNegative = false): SourceTarget => ({
  kind: 'KEYWORD', expressionType: isNegative ? `NEGATIVE_${match}` : match, expressionValue: text, bidCents, isNegative, negativeLevel: isNegative ? 'AD_GROUP' : null,
})
export const fixtureTargets = {
  keyword,
  negative: (text: string, match: 'EXACT' | 'PHRASE') => keyword(text, match, null, true),
  auto: (clause: string, bidCents: number | null): SourceTarget => ({ kind: 'AUTO', expressionType: clause, expressionValue: '', bidCents, isNegative: false, negativeLevel: null }),
  asin: (asin: string, bidCents: number | null): SourceTarget => ({ kind: 'PRODUCT', expressionType: 'ASIN_SAME_AS', expressionValue: asin, bidCents, isNegative: false, negativeLevel: null }),
}

export function liveCampaign(name: string, targets: SourceTarget[], extra: Partial<SourceCampaign> = {}): SourceCampaign {
  return {
    name,
    dailyBudget: 10,
    biddingStrategy: 'LEGACY_FOR_SALES',
    placementBidding: [],
    targetingType: 'MANUAL',
    adGroups: [{ name, defaultBidCents: 30, targets, asins: ['B0TESTAAA1', 'B0TESTAAA2'] }],
    ...extra,
  }
}
