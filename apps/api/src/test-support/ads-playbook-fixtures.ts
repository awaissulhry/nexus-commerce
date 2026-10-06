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
    isolation: { ...DEFAULT_ISOLATION },
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

/**
 * PB-5a — one enrolled product playbook in one market, ready to build (the build, adopt and apply-ads-playbook suites):
 * a parent with two FBA children listed on Amazon there, the template above, the market row naming it, the product row
 * (enrolled, DRAFT, name token, daily budget, base bid, terms), a market strategy and a production Amazon Ads connection
 * with writes enabled (so the gate lets a build through). Written through the caller's client inside the caller's
 * business. Values are made up.
 */
export async function seedProductPlaybook(db: Record<string, any>, opts: { token: string; market?: string; asinPrefix: string; profileId?: string; connection?: boolean }) {
  const market = opts.market ?? 'IT'
  const sku = (s: string) => `TEST-${opts.token}-${s}`
  const parent = (await db.product.create({ data: { sku: sku('PARENT'), name: `${opts.token} parent`, basePrice: '10.00', isParent: true, amazonAsin: `${opts.asinPrefix}P0` } })).id
  const v1 = (await db.product.create({ data: { sku: sku('V1'), name: `${opts.token} v1`, basePrice: '10.00', parentId: parent, amazonAsin: `${opts.asinPrefix}01`, fulfillmentMethod: 'FBA' } })).id
  const v2 = (await db.product.create({ data: { sku: sku('V2'), name: `${opts.token} v2`, basePrice: '10.00', parentId: parent, amazonAsin: `${opts.asinPrefix}02`, fulfillmentMethod: 'FBA' } })).id
  for (const productId of [parent, v1, v2]) {
    await db.channelListing.create({ data: { productId, channel: 'AMAZON', marketplace: market, region: market, channelMarket: `AMAZON_${market}`, listingStatus: 'ACTIVE' } })
  }
  const template = await db.adsPlaybookTemplate.create({ data: { name: `Test funnel ${opts.token}`, doc: templateDoc() as never, updatedBy: 'user:test' } })
  if (!(await db.adsPlaybook.findFirst({ where: { market, level: 'MARKET' } }))) {
    await db.adsPlaybook.create({ data: { market, level: 'MARKET', label: `Amazon ${market}`, templateId: template.id, updatedBy: 'user:test' } })
  }
  const row = await db.adsPlaybook.create({ data: {
    market, level: 'PRODUCT', scopeId: parent, label: `${sku('PARENT')} (${market})`, templateId: template.id, enrolled: true, state: 'DRAFT', nameToken: opts.token,
    dailyBudgetCents: 2000, baseBidCents: 40,
    terms: { brand: [`${opts.token.toLowerCase()} jacket`], category: [{ text: 'test jacket', exactAtStart: true }, { text: 'test coat' }], competitor: [], competitorAsins: ['B0TESTRIV1'], negatives: [{ text: 'test kids', match: 'PHRASE' }] },
    updatedBy: 'user:test',
  } })
  if (!(await db.adsStrategy.findFirst({ where: { market, level: 'MARKET' } }))) {
    await db.adsStrategy.create({ data: { market, level: 'MARKET', label: `Test strategy (${market})`, maxBidCents: 100, monthlySpendCapCents: 10_000_000, updatedBy: 'user:test' } })
  }
  if (opts.connection !== false && !(await db.amazonAdsConnection.findFirst({ where: { marketplace: market } }))) {
    await db.amazonAdsConnection.create({ data: { profileId: opts.profileId ?? `P-${market}-PB`, marketplace: market, region: 'EU', mode: 'production', writesEnabledAt: new Date(), isActive: true } })
  }
  if (!(await db.marketplace.findFirst({ where: { channel: 'AMAZON', code: market } }))) {
    await db.marketplace.create({ data: { channel: 'AMAZON', code: market, name: `Amazon ${market}`, region: 'EU', currency: 'EUR', language: 'it' } })
  }
  return { parent, v1, v2, rowId: row.id, templateId: template.id, skus: { parent: sku('PARENT'), v1: sku('V1'), v2: sku('V2') } }
}
