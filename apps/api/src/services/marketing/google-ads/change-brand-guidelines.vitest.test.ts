/**
 * Google Ads programme 2 G14b leftovers (2026-10-16) — brand guidelines turned on for an existing Performance Max campaign
 * (EnablePMaxBrandGuidelines): ONE account call naming the business name and logos the asset groups hold (or the ones
 * named, or Google's pick), refused in words when the campaign has no business name or no square logo, already has brand
 * guidelines, or the request breaks Google's rules. It moves no money. Made-up ids only.
 */
import { describe, expect, it } from 'vitest'
import { brandGuidelinesDraft } from './change-brand-guidelines.js'
import type { GoogleChangeDraft } from './change-draft.js'
import type { PmaxAsset, PmaxAssetGroup, PmaxCampaignLive, PmaxLink } from './live-pmax.js'

const C = 'customers/1234567890'
const link = (assetId: string, fieldType: string, text: string | null = null): PmaxLink => ({
  assetId, fieldType, status: 'ENABLED', source: 'ADVERTISER', type: fieldType === 'BUSINESS_NAME' ? 'TEXT' : 'IMAGE', name: null, text, width: null, height: null, mimeType: null, youtubeId: null, callToAction: null,
})
const group = (assetGroupId: string, assets: PmaxLink[]): PmaxAssetGroup => ({
  assetGroupId, name: `Group ${assetGroupId}`, status: 'ENABLED', finalUrls: ['https://shop.example/'], finalMobileUrls: [], path1: null, path2: null,
  trackingTemplate: null, finalUrlSuffix: null, customParameters: [], adStrength: null, primaryStatus: null, assets, tree: [], signals: [],
})
const campaign = (over: Partial<PmaxCampaignLive> = {}): PmaxCampaignLive => ({
  campaignId: '21', name: 'PMax A', status: 'ENABLED', type: 'PERFORMANCE_MAX', biddingType: 'MAXIMIZE_CONVERSIONS', targetCpaCents: null, targetRoas: null,
  budget: null, start: null, end: null, retail: null, brandGuidelines: false, brandStyle: null, euPoliticalAds: null, locationOption: null,
  trackingTemplate: null, finalUrlSuffix: null, customParameters: [], ignoreBrandExclusionsForShopping: false, excludedParentAssetFieldTypes: [], excludedParentAssetSetTypes: [],
  textGuidelines: { termExclusions: [], messagingRestrictions: [] }, automation: {}, campaignAssets: [], criteria: [], pageFeeds: [], notRead: [],
  assetGroups: [
    group('41', [link('201', 'BUSINESS_NAME', 'Shop A'), link('202', 'LOGO'), link('203', 'LANDSCAPE_LOGO'), { ...link('299', 'LOGO'), source: 'AUTOMATICALLY_CREATED' }]),
    group('42', [link('201', 'BUSINESS_NAME', 'Shop A'), link('204', 'LOGO')]),
  ],
  ...over,
})
const draft = (d: GoogleChangeDraft | { refusal: string }): GoogleChangeDraft => { if ('refusal' in d) throw new Error(d.refusal); return d }
const refused = (d: GoogleChangeDraft | { refusal: string }): string => ('refusal' in d ? d.refusal : `not refused: ${d.summary}`)

describe('brand guidelines turned on for an existing Performance Max campaign', () => {
  it('ONE account call with the business name and the logos its asset groups hold (Google\'s own links left out); no money; it says it cannot be undone', () => {
    const d = draft(brandGuidelinesDraft(C, { campaignId: '21', mainColor: '#112233', accentColor: '#445566', font: 'Lato' }, campaign(), []))
    expect(d.operations).toEqual([{ accountCall: { path: 'campaigns:enablePMaxBrandGuidelines', body: { operations: [{
      campaign: `${C}/campaigns/21`, autoPopulateBrandAssets: false,
      brandAssets: { businessNameAsset: `${C}/assets/201`, logoAsset: [`${C}/assets/202`, `${C}/assets/204`], landscapeLogoAsset: [`${C}/assets/203`] },
      mainColor: '#112233', accentColor: '#445566', fontFamily: 'Lato',
    }] } } }])
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings[0]).toMatch(/cannot be undone/)
    expect(d.after).toEqual({ campaignId: '21', brandGuidelines: true, businessNameAssetId: '201', logoAssetIds: ['202', '204'], landscapeLogoAssetIds: ['203'] })
    expect(d.before).toEqual({ campaignId: '21', brandGuidelines: false })
  })

  it('Google\'s pick (autoPopulate) names no asset; named assets are checked (type, in the account)', () => {
    const auto = draft(brandGuidelinesDraft(C, { campaignId: '21', autoPopulate: true }, campaign(), []))
    expect(auto.operations).toEqual([{ accountCall: { path: 'campaigns:enablePMaxBrandGuidelines', body: { operations: [{ campaign: `${C}/campaigns/21`, autoPopulateBrandAssets: true }] } } }])
    const named: PmaxAsset[] = [{ assetId: '301', type: 'TEXT', name: null, text: 'Shop B', width: null, height: null, mimeType: null, youtubeId: null, callToAction: null }]
    const n = draft(brandGuidelinesDraft(C, { campaignId: '21', businessNameAssetId: '301', logoAssetIds: ['202'], landscapeLogoAssetIds: [] }, campaign(), named))
    expect((n.operations[0] as any).accountCall.body.operations[0].brandAssets).toEqual({ businessNameAsset: `${C}/assets/301`, logoAsset: [`${C}/assets/202`] })
    expect(refused(brandGuidelinesDraft(C, { campaignId: '21', businessNameAssetId: '302' }, campaign(), named))).toMatch(/asset 302 is not in this account/)
    expect(refused(brandGuidelinesDraft(C, { campaignId: '21', logoAssetIds: ['301'] }, campaign(), named))).toMatch(/asset 301 is TEXT: a logo is an image asset/)
  })

  it('refuses in words: no business name or no square logo, already on, two business names unnamed, six logos, one color, a font Google does not take, another type', () => {
    expect(refused(brandGuidelinesDraft(C, { campaignId: '21' }, campaign({ assetGroups: [group('41', [link('202', 'LOGO')])] }), []))).toMatch(/has no business name in its asset groups: brand guidelines need a business name and at least one square logo/)
    expect(refused(brandGuidelinesDraft(C, { campaignId: '21' }, campaign({ assetGroups: [group('41', [link('201', 'BUSINESS_NAME', 'Shop A'), link('203', 'LANDSCAPE_LOGO')])] }), []))).toMatch(/no square logo/)
    // Named assets of the account stand in for what the asset groups lack; Google's own pick needs them in the campaign.
    const bare = campaign({ assetGroups: [group('41', [])] })
    const named: PmaxAsset[] = [
      { assetId: '301', type: 'TEXT', name: null, text: 'Shop B', width: null, height: null, mimeType: null, youtubeId: null, callToAction: null },
      { assetId: '302', type: 'IMAGE', name: null, text: null, width: 1200, height: 1200, mimeType: 'image/png', youtubeId: null, callToAction: null },
    ]
    const own = draft(brandGuidelinesDraft(C, { campaignId: '21', businessNameAssetId: '301', logoAssetIds: ['302'] }, bare, named))
    expect((own.operations[0] as any).accountCall.body.operations[0].brandAssets).toEqual({ businessNameAsset: `${C}/assets/301`, logoAsset: [`${C}/assets/302`] })
    expect(refused(brandGuidelinesDraft(C, { campaignId: '21', businessNameAssetId: '301' }, bare, named))).toMatch(/has no square logo in its asset groups.*Name assets of this account \(businessNameAssetId, logoAssetIds\)/)
    expect(refused(brandGuidelinesDraft(C, { campaignId: '21', autoPopulate: true }, bare, []))).toMatch(/no business name and no square logo/)
    expect(refused(brandGuidelinesDraft(C, { campaignId: '21', businessNameAssetId: '309', logoAssetIds: ['302'] }, bare, named))).toMatch(/asset 309 is not in this account/)
    expect(refused(brandGuidelinesDraft(C, { campaignId: '21' }, campaign({ brandGuidelines: true }), []))).toMatch(/has brand guidelines on already/)
    const two = campaign({ assetGroups: [group('41', [link('201', 'BUSINESS_NAME', 'Shop A'), link('202', 'LOGO')]), group('42', [link('205', 'BUSINESS_NAME', 'Shop B')])] })
    expect(refused(brandGuidelinesDraft(C, { campaignId: '21' }, two, []))).toMatch(/hold 2 business names \(assets 201, 205\): name one/)
    expect(draft(brandGuidelinesDraft(C, { campaignId: '21', businessNameAssetId: '205' }, two, [])).after).toMatchObject({ businessNameAssetId: '205' })
    const many = campaign({ assetGroups: [group('41', [link('201', 'BUSINESS_NAME'), ...['211', '212', '213', '214', '215', '216'].map((id) => link(id, 'LOGO'))])] })
    expect(refused(brandGuidelinesDraft(C, { campaignId: '21', logoAssetIds: ['211', '212', '213', '214', '215', '216'] }, many, []))).toMatch(/6 logos: brand guidelines take at most 5/)
    expect(refused(brandGuidelinesDraft(C, { campaignId: '21', mainColor: '#112233' }, campaign(), []))).toMatch(/main and the accent color together/)
    expect(refused(brandGuidelinesDraft(C, { campaignId: '21', font: 'Comic Sans' }, campaign(), []))).toMatch(/not a font Google takes/)
    expect(refused(brandGuidelinesDraft(C, { campaignId: '21' }, campaign({ type: 'SEARCH' }), []))).toMatch(/for Performance Max campaigns/)
    expect(refused(brandGuidelinesDraft(C, { campaignId: '21' }, null, []))).toMatch(/not in this account/)
  })
})
