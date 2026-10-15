/**
 * Google Ads changes, programme 2 G6 (2026-10-15) — assets of every type at every level, built from a request and the
 * live state (pure): the exact Google operations (new assets with temporary ids, their links at the account, campaigns and
 * ad groups), Google's rules per type and per place refused before anything is sent, a call / lead form link made PAUSED
 * where it would serve (enable: SPENDS MONEY), what is skipped, the record undo reads; and the live reads' queries and rows.
 */
import { describe, expect, it, vi } from 'vitest'

// Only liveAssetLinksView reads Google here; the builders are pure. Each query answers by the resource it reads.
const rows = vi.hoisted(() => ({ queries: [] as string[], answer: (_q: string): unknown[] => [] }))
vi.mock('./write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('./write-client.js')>()),
  liveRows: async (_t: unknown, query: string) => { rows.queries.push(query); return rows.answer(query) },
}))
import {
  assetLinksDraft, imageProblem, linksUndoItems, newAssetsDraft, newAssetsRecordAfterRun,
  type LinksLive, type NewAssetsLive, type NewAssetsRecord, type NewAssetsRequest,
} from './change-assets-all.js'
import {
  liveAccountLinksQuery, liveAdGroupLinksQuery, liveAssetDetailOf, liveAssetLinksView, liveCampaignLinksQuery, livePlaceLinkOf, LIVE_LEAD_FORM_TERMS_QUERY,
  type LiveAdGroupRef, type LiveAssetDetail, type LivePlaceLink,
} from './live-assets-all.js'
import type { PreparedImage } from './asset-images.js'
import type { LiveCampaign } from './live.js'

const C = 'customers/1234567890'

const campaign = (campaignId: string, name: string, status: string, type = 'SEARCH'): LiveCampaign => ({
  campaignId, name, status, servingStatus: null, primaryStatus: null, type, subType: null, bidding: 'MANUAL_CPC', start: null, end: null, shopping: null, budget: null,
})
const SEARCH_ON = campaign('21', 'Search A', 'ENABLED')
const SEARCH_OFF = campaign('22', 'Search B', 'PAUSED')
const PMAX = campaign('23', 'PMax A', 'ENABLED', 'PERFORMANCE_MAX')
const GROUP = (status = 'ENABLED'): LiveAdGroupRef => ({ adGroupId: '51', name: 'Jackets', status, campaignId: '21', campaignName: 'Search A', campaignStatus: 'ENABLED', campaignType: 'SEARCH' })
const detail = (assetId: string, type: string, details: Record<string, unknown>, label = 'x', source = 'ADVERTISER'): LiveAssetDetail =>
  ({ assetId, type, name: null, source, label, finalUrls: [], approval: null, review: null, details })
const link = (over: Partial<LivePlaceLink> & Pick<LivePlaceLink, 'level' | 'assetId' | 'fieldType' | 'asset'>): LivePlaceLink => ({
  campaignId: null, campaignName: null, campaignStatus: null, adGroupId: null, adGroupName: null, adGroupStatus: null, status: 'ENABLED', source: 'ADVERTISER', primaryStatus: null, ...over,
})
const image = (width: number, height: number, mimeType: PreparedImage['mimeType'] = 'image/png'): PreparedImage => ({
  source: 'https://cdn.example/a.png', label: 'a', mimeType, bytes: 1000, width, height, sha256: 'ab'.repeat(32), data: 'iVBORw0KGgo=',
})
const live = (over: Partial<NewAssetsLive> = {}): NewAssetsLive => ({ campaigns: [SEARCH_ON, SEARCH_OFF, PMAX], adGroups: [GROUP()], links: [], images: [], leadFormTerms: null, ...over })
const draft = (request: NewAssetsRequest, state: Partial<NewAssetsLive> = {}) => newAssetsDraft(C, 'EUR', request, live(state))
const ok = <T>(x: T | { refusal: string }): T => {
  if (x && typeof x === 'object' && 'refusal' in x) throw new Error(`refused: ${(x as { refusal: string }).refusal}`)
  return x as T
}

describe('imageProblem — Google\'s shape, size and file type per use', () => {
  it('a Search image is square (300×300 at least) or landscape 1.91:1 (600×314 at least), JPG or PNG', () => {
    expect(imageProblem('image 1', 'AD_IMAGE', image(1200, 1200))).toBeNull()
    expect(imageProblem('image 1', 'AD_IMAGE', image(1200, 628))).toBeNull()
    expect(imageProblem('image 1', 'AD_IMAGE', image(1200, 900))).toBe('image 1 is 1200×900 (ratio 1.33): an image is square (1:1) or landscape (1.91:1)')
    expect(imageProblem('image 1', 'AD_IMAGE', image(200, 200))).toBe('image 1 is 200×200: a square (1:1) image is at least 300×300')
    expect(imageProblem('image 1', 'AD_IMAGE', image(1200, 1200, 'image/gif'))).toBe('image 1 is GIF: an image is JPEG or PNG')
  })

  it('logos: square 128×128; landscape logo 4:1 512×128; marketing images 1.91:1, 1:1, 4:5', () => {
    expect(imageProblem('i', 'BUSINESS_LOGO', image(128, 128))).toBeNull()
    expect(imageProblem('i', 'LOGO', image(100, 100))).toMatch(/at least 128×128/)
    expect(imageProblem('i', 'LANDSCAPE_LOGO', image(1200, 300))).toBeNull()
    expect(imageProblem('i', 'LANDSCAPE_LOGO', image(400, 100))).toMatch(/at least 512×128/)
    expect(imageProblem('i', 'PORTRAIT_MARKETING_IMAGE', image(960, 1200))).toBeNull()
    expect(imageProblem('i', 'MARKETING_IMAGE', image(1200, 1200))).toMatch(/landscape \(1\.91:1\)/)
    expect(imageProblem('i', 'SQUARE_MARKETING_IMAGE', image(300, 300, 'image/gif'))).toBeNull()
  })
})

describe('newAssetsDraft — make assets of every type and link them at every level', () => {
  it('a call, a callout and a business name at the account and an enabled campaign: one request, the call links PAUSED there', () => {
    const d = ok(draft({
      calls: [{ countryCode: 'it', phoneNumber: '000 111 2222', callConversion: 'OFF' }],
      callouts: ['Free returns'],
      businessNames: ['Shop A'],
      linkTo: [{ level: 'account' }, { level: 'campaign', campaignId: '21' }],
    }))
    expect(d.operations).toEqual([
      { assetOperation: { create: { resourceName: `${C}/assets/-1`, textAsset: { text: 'Shop A' } } } },
      { assetOperation: { create: { resourceName: `${C}/assets/-2`, callAsset: { countryCode: 'IT', phoneNumber: '000 111 2222', callConversionReportingState: 'DISABLED' } } } },
      { assetOperation: { create: { resourceName: `${C}/assets/-3`, calloutAsset: { calloutText: 'Free returns' } } } },
      { customerAssetOperation: { create: { asset: `${C}/assets/-1`, fieldType: 'BUSINESS_NAME' } } },
      { campaignAssetOperation: { create: { campaign: `${C}/campaigns/21`, asset: `${C}/assets/-1`, fieldType: 'BUSINESS_NAME' } } },
      { customerAssetOperation: { create: { asset: `${C}/assets/-2`, fieldType: 'CALL', status: 'PAUSED' } } },
      { campaignAssetOperation: { create: { campaign: `${C}/campaigns/21`, asset: `${C}/assets/-2`, fieldType: 'CALL', status: 'PAUSED' } } },
      { customerAssetOperation: { create: { asset: `${C}/assets/-3`, fieldType: 'CALLOUT' } } },
      { campaignAssetOperation: { create: { campaign: `${C}/campaigns/21`, asset: `${C}/assets/-3`, fieldType: 'CALLOUT' } } },
    ])
    expect(d.spendsMoney).toEqual([])
    expect(d.summary).toBe('Google Ads assets: make 1 business name, 1 call asset, 1 callout and link them at 2 places.')
    expect(d.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/^Made PAUSED where it would serve \(a call or a lead form brings new paid clicks\): call asset "000 111 2222 \(IT\)" at the account; call asset "000 111 2222 \(IT\)" at campaign "Search A"\./),
      expect.stringMatching(/Google never removes an asset: undo unlinks/),
    ]))
    expect(d.after).toMatchObject({
      created: [{ assetId: 'op:0', type: 'TEXT', fieldType: 'BUSINESS_NAME' }, { assetId: 'op:1', type: 'CALL' }, { assetId: 'op:2', type: 'CALLOUT' }],
      linked: expect.arrayContaining([{ level: 'campaign', campaignId: '21', adGroupId: null, assetId: 'op:1', fieldType: 'CALL', status: 'PAUSED', text: '000 111 2222 (IT)' }]),
    })
    expect(d.totals).toMatchObject({ operations: 9, assetsMade: 3, links: 6, linksPaused: 2 })
  })

  it('enable: true makes the call ENABLED where it serves: SPENDS MONEY, in words', () => {
    const d = ok(draft({ calls: [{ countryCode: 'IT', phoneNumber: '000 111 2222' }], linkTo: [{ level: 'campaign', campaignId: '21' }], enable: true }))
    expect(d.operations[1]).toEqual({ campaignAssetOperation: { create: { campaign: `${C}/campaigns/21`, asset: `${C}/assets/-1`, fieldType: 'CALL' } } })
    expect(d.spendsMoney).toEqual(['Links the call asset "000 111 2222 (IT)" ENABLED to campaign "Search A" (enabled): people can call from its ads at once (a call from the ad is charged like a click).'])
  })

  it('where nothing serves (a paused campaign; a paused ad group) a call links ENABLED, with a warning, no spend', () => {
    const d = ok(draft({ calls: [{ countryCode: 'IT', phoneNumber: '000 111 2222' }], linkTo: [{ level: 'campaign', campaignId: '22' }, { level: 'ad-group', adGroupId: '51' }] }, { adGroups: [GROUP('PAUSED')] }))
    expect(d.operations.slice(1)).toEqual([
      { campaignAssetOperation: { create: { campaign: `${C}/campaigns/22`, asset: `${C}/assets/-1`, fieldType: 'CALL' } } },
      { adGroupAssetOperation: { create: { adGroup: `${C}/adGroups/51`, asset: `${C}/assets/-1`, fieldType: 'CALL' } } },
    ])
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings.join(' ')).toMatch(/Linked ENABLED where nothing serves yet: call asset .* at campaign "Search B"; call asset .* at ad group "Jackets" \(campaign "Search A"\)/)
  })

  it('each type only where Google links it, all problems at once; nothing is sent', () => {
    const d = draft({
      businessNames: ['Shop A'],
      leadForms: [{ nameOnForm: 'Shop A', headline: 'Get a quote', description: 'Tell us your size', callToActionType: 'GET_QUOTE', callToActionDescription: 'Sizes in a day', privacyPolicyUrl: 'https://shop.example/privacy', finalUrl: 'https://shop.example', fields: [{ inputType: 'EMAIL' }] }],
      linkTo: [{ level: 'ad-group', adGroupId: '51' }, { level: 'campaign', campaignId: '99' }],
    }, { leadFormTerms: true })
    expect(d).toEqual({
      refusal: 'Not queued — the assets break Google\'s rules (nothing was sent): campaign 99 is not in this account (or it is removed); '
        + 'business name "Shop A": Google links a business name (BUSINESS_NAME) to the account or a campaign, not to ad group "Jackets" (campaign "Search A"); '
        + 'lead form "Get a quote (Shop A)": Google links a lead form (LEAD_FORM) to a campaign, not to ad group "Jackets" (campaign "Search A").',
    })
  })

  it('a logo goes to a Performance Max campaign only (Search uses BUSINESS_LOGO); a marketing image is made and linked nowhere', () => {
    expect(draft({ images: [{ fieldType: 'LOGO', imageUrl: 'https://cdn.example/a.png' }], linkTo: [{ level: 'campaign', campaignId: '21' }] }, { images: [image(512, 512)] }))
      .toEqual({ refusal: expect.stringContaining('is linked to a Performance Max campaign (with brand guidelines), not to campaign "Search A" (a SEARCH): Search uses BUSINESS_LOGO') })
    const d = ok(draft({
      images: [{ fieldType: 'LOGO', imageUrl: 'https://cdn.example/a.png', name: 'Logo A' }, { fieldType: 'MARKETING_IMAGE', imageUrl: 'https://cdn.example/b.png' }],
      linkTo: [{ level: 'campaign', campaignId: '23' }],
    }, { images: [image(512, 512), { ...image(1200, 628), sha256: 'cd'.repeat(32), label: 'b' }] }))
    expect(d.operations).toEqual([
      { assetOperation: { create: { resourceName: `${C}/assets/-1`, name: 'Logo A', type: 'IMAGE', imageAsset: { data: 'iVBORw0KGgo=' } } } },
      { assetOperation: { create: { resourceName: `${C}/assets/-2`, name: 'b cdcdcdcd', type: 'IMAGE', imageAsset: { data: 'iVBORw0KGgo=' } } } },
      { campaignAssetOperation: { create: { campaign: `${C}/campaigns/23`, asset: `${C}/assets/-1`, fieldType: 'LOGO' } } },
    ])
    // The record holds the image's fingerprint and size, never its bytes.
    expect(JSON.stringify(d.after)).not.toContain('iVBORw0KGgo=')
    expect((d.after as NewAssetsRecord).created[1]).toEqual({ assetId: 'op:1', type: 'IMAGE', fieldType: 'MARKETING_IMAGE', text: 'b cdcdcdcd (1200×628)', sha256: 'cd'.repeat(32), width: 1200, height: 628 })
    expect(d.changes['marketing image "b cdcdcdcd (1200×628)"']).toEqual({ from: '(none)', to: 'new — for Performance Max asset groups and display ads (linked nowhere here)' })
  })

  it('an image that cannot be one (its fetch said why, or its shape) is refused before anything is sent', () => {
    expect(draft({ images: [{ fieldType: 'AD_IMAGE', imageUrl: 'https://cdn.example/a.webp' }], linkTo: [{ level: 'campaign', campaignId: '21' }] }, { images: [{ problem: 'https://cdn.example/a.webp is image/webp: Google takes JPG, PNG or GIF images' }] }))
      .toEqual({ refusal: 'Not queued — the assets break Google\'s rules (nothing was sent): image 1: https://cdn.example/a.webp is image/webp: Google takes JPG, PNG or GIF images.' })
    expect(draft({ images: [{ fieldType: 'AD_IMAGE', imageUrl: 'https://cdn.example/a.png' }] }, { images: [image(800, 600)] }))
      .toEqual({ refusal: expect.stringContaining('image 1 is 800×600 (ratio 1.33)') })
  })

  it('the same content already linked at a place is not linked again there; linked everywhere = not made', () => {
    const there = link({ level: 'campaign', campaignId: '21', assetId: '9', fieldType: 'CALLOUT', asset: detail('9', 'CALLOUT', { calloutText: 'Free returns' }) })
    const d = ok(draft({ callouts: ['Free returns', 'Ships in 24h'], linkTo: [{ level: 'campaign', campaignId: '21' }, { level: 'account' }] }, { links: [there] }))
    expect(d.skipped).toEqual(['The callout "Free returns" is already linked to campaign "Search A" (asset 9).'])
    expect(d.operations.filter((o) => 'campaignAssetOperation' in o)).toHaveLength(1)
    expect(d.operations.filter((o) => 'customerAssetOperation' in o)).toHaveLength(2)
    expect(draft({ callouts: ['Free returns'], linkTo: [{ level: 'campaign', campaignId: '21' }] }, { links: [there] }))
      .toEqual({ refusal: 'Nothing to change: The callout "Free returns" is already linked to campaign "Search A" (asset 9).' })
  })

  it('a lead form: refused until the account accepted Google\'s lead form terms; at a campaign, PAUSED where it serves', () => {
    const form = {
      nameOnForm: 'Shop A', headline: 'Get a quote', description: 'Tell us your size', callToActionType: 'GET_QUOTE' as const, callToActionDescription: 'Sizes in a day',
      privacyPolicyUrl: 'https://shop.example/privacy', finalUrl: 'https://shop.example', fields: [{ inputType: 'FULL_NAME' }, { inputType: 'EMAIL' }], desiredIntent: 'HIGH_INTENT' as const,
    }
    expect(draft({ leadForms: [form], linkTo: [{ level: 'campaign', campaignId: '21' }] }, { leadFormTerms: false })).toEqual({ refusal: expect.stringContaining('LEAD_FORM_MISSING_AGREEMENT') })
    const d = ok(draft({ leadForms: [form], linkTo: [{ level: 'campaign', campaignId: '21' }] }, { leadFormTerms: true }))
    expect(d.operations).toEqual([
      { assetOperation: { create: { resourceName: `${C}/assets/-1`, finalUrls: ['https://shop.example'], leadFormAsset: {
        businessName: 'Shop A', headline: 'Get a quote', description: 'Tell us your size', callToActionType: 'GET_QUOTE', callToActionDescription: 'Sizes in a day',
        privacyPolicyUrl: 'https://shop.example/privacy', fields: [{ inputType: 'FULL_NAME' }, { inputType: 'EMAIL' }], desiredIntent: 'HIGH_INTENT',
      } } } },
      { campaignAssetOperation: { create: { campaign: `${C}/campaigns/21`, asset: `${C}/assets/-1`, fieldType: 'LEAD_FORM', status: 'PAUSED' } } },
    ])
    expect(d.warnings.join(' ')).toMatch(/Leads from the form stay in Google Ads/)
  })

  it('a price asset: 3 to 8 offerings, header ≠ description, https; prices in micros of the account currency', () => {
    const offering = (header: string, cents: number) => ({ header, description: `${header} line`, priceCents: cents, finalUrl: `https://shop.example/${header.toLowerCase()}` })
    expect(draft({ prices: [{ priceType: 'PRODUCT_CATEGORIES', languageCode: 'it', offerings: [offering('Gloves', 4990), { ...offering('Boots', 9990), description: 'Boots' }] }] }))
      .toEqual({ refusal: 'Not queued — the assets break Google\'s rules (nothing was sent): price asset 1: 2 offerings (Google needs 3 to 8); price asset 1, offering 2: the header and the description are the same (Google refuses that).' })
    const d = ok(draft({ prices: [{ priceType: 'PRODUCT_CATEGORIES', qualifier: 'FROM', languageCode: 'it', offerings: [offering('Gloves', 4990), offering('Boots', 9990), offering('Helmets', 12900)] }], linkTo: [{ level: 'ad-group', adGroupId: '51' }] }))
    expect(d.operations[0]).toEqual({ assetOperation: { create: { resourceName: `${C}/assets/-1`, priceAsset: {
      type: 'PRODUCT_CATEGORIES', priceQualifier: 'FROM', languageCode: 'it', priceOfferings: [
        { header: 'Gloves', description: 'Gloves line', price: { currencyCode: 'EUR', amountMicros: '49900000' }, finalUrl: 'https://shop.example/gloves' },
        { header: 'Boots', description: 'Boots line', price: { currencyCode: 'EUR', amountMicros: '99900000' }, finalUrl: 'https://shop.example/boots' },
        { header: 'Helmets', description: 'Helmets line', price: { currencyCode: 'EUR', amountMicros: '129000000' }, finalUrl: 'https://shop.example/helmets' },
      ] } } } })
    expect(d.operations[1]).toEqual({ adGroupAssetOperation: { create: { adGroup: `${C}/adGroups/51`, asset: `${C}/assets/-1`, fieldType: 'PRICE' } } })
  })

  it('a promotion: percent or money off (one), a code or a minimum order (one), real days in order', () => {
    const base = { target: 'Winter jackets', finalUrl: 'https://shop.example/winter' }
    expect(draft({ promotions: [{ ...base, percentOff: 10, amountOffCents: 500, promotionCode: 'A', ordersOverCents: 1000, startDate: '2026-12-10', endDate: '2026-12-01', redemptionStartDate: '2026-02-30' }] }))
      .toEqual({ refusal: 'Not queued — the assets break Google\'s rules (nothing was sent): promotion 1: give percentOff or amountOffCents (one of them, Google\'s rule); promotion 1: give promotionCode or ordersOverCents, not both (Google\'s rule); promotion 1, redemptionStartDate: "2026-02-30" is not a day (YYYY-MM-DD); promotion 1: it starts (2026-12-10) after it ends (2026-12-01).' })
    const d = ok(draft({ promotions: [{ ...base, percentOff: 12.5, upTo: true, promotionCode: 'WINTER', occasion: 'WINTER_SALE', startDate: '2026-12-01', endDate: '2026-12-31' }], linkTo: [{ level: 'account' }] }))
    expect(d.operations[0]).toEqual({ assetOperation: { create: { resourceName: `${C}/assets/-1`, finalUrls: ['https://shop.example/winter'], promotionAsset: {
      promotionTarget: 'Winter jackets', discountModifier: 'UP_TO', percentOff: '125000', promotionCode: 'WINTER', occasion: 'WINTER_SALE', startDate: '2026-12-01', endDate: '2026-12-31',
    } } } })
    const money = ok(draft({ promotions: [{ ...base, amountOffCents: 1500, ordersOverCents: 10000 }] }))
    expect((money.operations[0] as any).assetOperation.create.promotionAsset).toMatchObject({
      moneyAmountOff: { currencyCode: 'EUR', amountMicros: '15000000' }, ordersOverAmount: { currencyCode: 'EUR', amountMicros: '100000000' },
    })
  })

  it('an app link: an App Store id is digits, a Google Play id a package name; 25 characters of link text', () => {
    expect(draft({ mobileApps: [{ appStore: 'APPLE_APP_STORE', appId: 'com.example.app', linkText: 'Get the app' }] }))
      .toEqual({ refusal: expect.stringContaining('app link 1: "com.example.app" is not an App Store id (digits, e.g. 12345689)') })
    const d = ok(draft({ mobileApps: [{ appStore: 'GOOGLE_APP_STORE', appId: 'com.example.app', linkText: 'Get the app' }], linkTo: [{ level: 'campaign', campaignId: '21' }] }))
    expect(d.operations[0]).toEqual({ assetOperation: { create: { resourceName: `${C}/assets/-1`, mobileAppAsset: { appId: 'com.example.app', appStore: 'GOOGLE_APP_STORE', linkText: 'Get the app' } } } })
  })

  it('a call counted as a conversion action of the account; sitelinks and snippets at an ad group', () => {
    const d = ok(draft({
      calls: [{ countryCode: 'IT', phoneNumber: '000 111 2222', conversionActionId: '77' }],
      sitelinks: [{ linkText: 'Gloves', finalUrl: 'https://shop.example/gloves' }],
      structuredSnippets: [{ header: 'Brands', language: 'it', values: ['A', 'B', 'C'] }],
      linkTo: [{ level: 'ad-group', adGroupId: '51', campaignId: '21' }],
    }))
    expect((d.operations[0] as any).assetOperation.create.callAsset).toEqual({ countryCode: 'IT', phoneNumber: '000 111 2222', callConversionReportingState: 'USE_RESOURCE_LEVEL_CALL_CONVERSION_ACTION', callConversionAction: `${C}/conversionActions/77` })
    expect((d.operations[2] as any).assetOperation.create.structuredSnippetAsset).toEqual({ header: 'Brand', values: ['A', 'B', 'C'] })
    expect(draft({ calls: [{ countryCode: 'IT', phoneNumber: '000' }], linkTo: [{ level: 'ad-group', adGroupId: '51', campaignId: '22' }] }))
      .toEqual({ refusal: 'Not queued — the assets break Google\'s rules (nothing was sent): call 1: "000" is not a phone number (digits, spaces, + - ( ) .); ad group 51 is in campaign 21, not 22.' })
  })

  it('nothing asked, too many, and the record after a run (each new asset its id)', () => {
    expect(draft({ linkTo: [{ level: 'account' }] })).toEqual({ refusal: expect.stringContaining('Say what to make') })
    expect(draft({ callouts: Array.from({ length: 21 }, (_, i) => `Callout ${i}`) })).toEqual({ refusal: 'At most 20 new assets in one request (21 asked).' })
    const d = ok(draft({ callouts: ['A1', 'B1'], linkTo: [{ level: 'account' }] }))
    const after = newAssetsRecordAfterRun(d.after as NewAssetsRecord, [{ assetResult: { resourceName: `${C}/assets/301` } }, { assetResult: { resourceName: `${C}/assets/302` } }, {}, {}])
    expect(after.created.map((c) => c.assetId)).toEqual(['301', '302'])
    expect(after.linked.map((l) => l.assetId)).toEqual(['301', '302'])
  })
})

describe('newAssetsDraft — review fixes (G6)', () => {
  it('no more links than one undo can take off (100): refused before anything is sent', () => {
    const many = Array.from({ length: 10 }, (_, i) => campaign(String(31 + i), `Search ${i}`, 'PAUSED'))
    const places = many.map((c) => ({ level: 'campaign' as const, campaignId: c.campaignId }))
    const callouts = Array.from({ length: 11 }, (_, i) => `Callout ${i}`)
    expect(newAssetsDraft(C, 'EUR', { callouts, linkTo: places }, live({ campaigns: many })))
      .toEqual({ refusal: 'This would make 110 links, and one request makes at most 100 (so that its undo can take them all off): ask in two requests (fewer assets or fewer places). Nothing was sent.' })
    expect(ok(newAssetsDraft(C, 'EUR', { callouts: callouts.slice(0, 10), linkTo: places }, live({ campaigns: many }))).totals).toMatchObject({ links: 100 })
  })

  it('linked nowhere: the same content the account already has is not made again, and what the change stands on shows it', () => {
    const had = detail('9', 'CALLOUT', { calloutText: 'Free returns' }, 'Free returns')
    const d = ok(draft({ callouts: ['Free returns', 'Ships in 24h'] }, { accountAssets: [had, detail('8', 'CALLOUT', { calloutText: 'Gift wrap' })] }))
    expect(d.skipped).toEqual(['The callout "Free returns" is already in the account (asset 9): link it where it should show with set-google-asset-links.'])
    expect(d.operations).toEqual([{ assetOperation: { create: { resourceName: `${C}/assets/-1`, calloutAsset: { calloutText: 'Ships in 24h' } } } }])
    // Only the content asked is in the basis: an unrelated callout does not move it; the one this change makes does.
    expect(d.stands.accountAssets).toEqual(['9~CALLOUT:Free returns'])
    const ran = draft({ callouts: ['Free returns', 'Ships in 24h'] }, { accountAssets: [had, detail('310', 'CALLOUT', { calloutText: 'Ships in 24h' })] })
    expect(ran).toEqual({ refusal: expect.stringMatching(/^Nothing to change: .*"Ships in 24h" is already in the account \(asset 310\)/) })
    // A business name is a TEXT asset of the account.
    expect(draft({ businessNames: ['Shop A'] }, { accountAssets: [detail('7', 'TEXT', { text: 'Shop A' })] })).toEqual({ refusal: expect.stringContaining('is already in the account (asset 7)') })
  })

  it('a link Google made itself (AUTOMATICALLY_CREATED) is never part of what the change stands on', () => {
    const own = link({ level: 'campaign', campaignId: '21', assetId: '9', fieldType: 'CALLOUT', asset: detail('9', 'CALLOUT', { calloutText: 'Free returns' }) })
    const google = link({ level: 'campaign', campaignId: '21', assetId: '77', fieldType: 'CALLOUT', source: 'AUTOMATICALLY_CREATED', asset: detail('77', 'CALLOUT', { calloutText: 'Fast delivery' }, 'x', 'AUTOMATICALLY_CREATED') })
    const ask = { callouts: ['Ships in 24h'], linkTo: [{ level: 'campaign' as const, campaignId: '21' }] }
    expect(ok(draft(ask, { links: [own, google] })).stands).toEqual(ok(draft(ask, { links: [own] })).stands)
  })
})

describe('assetLinksDraft — link, pause, enable and unlink at every level', () => {
  const CALL = detail('302', 'CALL', { countryCode: 'IT', phoneNumber: '000 111 2222' }, '000 111 2222 (IT)')
  const CALLOUT = detail('9', 'CALLOUT', { calloutText: 'Free returns' }, 'Free returns')
  const state = (over: Partial<LinksLive> = {}): LinksLive => ({
    campaigns: [SEARCH_ON, SEARCH_OFF, PMAX],
    adGroups: [GROUP()],
    links: [
      link({ level: 'account', assetId: '302', fieldType: 'CALL', asset: CALL }),
      link({ level: 'campaign', campaignId: '21', campaignName: 'Search A', assetId: '302', fieldType: 'CALL', status: 'PAUSED', asset: CALL }),
      link({ level: 'campaign', campaignId: '21', campaignName: 'Search A', assetId: '9', fieldType: 'CALLOUT', asset: CALLOUT }),
    ],
    assets: [CALLOUT, CALL],
    ...over,
  })

  it('every kind of link change in one request; enabling a call where it serves is SPENDS MONEY; unlinking is a warning', () => {
    const d = ok(assetLinksDraft(C, { items: [
      { level: 'ad-group', adGroupId: '51', assetId: '9', fieldType: 'CALLOUT', action: 'link' },
      { level: 'account', assetId: '302', fieldType: 'CALL', action: 'pause' },
      { level: 'campaign', campaignId: '21', assetId: '302', fieldType: 'CALL', action: 'enable' },
      { level: 'campaign', campaignId: '21', assetId: '9', fieldType: 'CALLOUT', action: 'unlink' },
    ] }, state()))
    expect(d.operations).toEqual([
      { adGroupAssetOperation: { create: { adGroup: `${C}/adGroups/51`, asset: `${C}/assets/9`, fieldType: 'CALLOUT' } } },
      { customerAssetOperation: { update: { resourceName: `${C}/customerAssets/302~CALL`, status: 'PAUSED' }, updateMask: 'status' } },
      { campaignAssetOperation: { update: { resourceName: `${C}/campaignAssets/21~302~CALL`, status: 'ENABLED' }, updateMask: 'status' } },
      { campaignAssetOperation: { remove: `${C}/campaignAssets/21~9~CALLOUT` } },
    ])
    expect(d.spendsMoney).toEqual(['Enables the call asset "000 111 2222 (IT)" at campaign "Search A" (enabled): people can call from its ads at once (a call from the ad is charged like a click).'])
    expect(d.warnings).toEqual(expect.arrayContaining(['Unlinking 1 asset link: the ads there show without it (the assets stay in the account).']))
    expect(d.summary).toBe('Google Ads asset links: link 1 asset; enable 1 link; pause 1 link; unlink 1 asset.')
    expect(d.after).toEqual({ items: [
      { level: 'ad-group', campaignId: '21', adGroupId: '51', assetId: '9', fieldType: 'CALLOUT', text: 'Free returns', from: null, to: 'ENABLED' },
      { level: 'account', campaignId: null, adGroupId: null, assetId: '302', fieldType: 'CALL', text: '000 111 2222 (IT)', from: 'ENABLED', to: 'PAUSED' },
      { level: 'campaign', campaignId: '21', adGroupId: null, assetId: '302', fieldType: 'CALL', text: '000 111 2222 (IT)', from: 'PAUSED', to: 'ENABLED' },
      { level: 'campaign', campaignId: '21', adGroupId: null, assetId: '9', fieldType: 'CALLOUT', text: 'Free returns', from: 'ENABLED', to: null },
    ] })
    // Undo: each link back as it was.
    expect(linksUndoItems((d.after as { items: never[] }).items)).toEqual([
      { level: 'ad-group', adGroupId: '51', assetId: '9', fieldType: 'CALLOUT', action: 'unlink' },
      { level: 'account', assetId: '302', fieldType: 'CALL', action: 'enable' },
      { level: 'campaign', campaignId: '21', assetId: '302', fieldType: 'CALL', action: 'pause' },
      { level: 'campaign', campaignId: '21', assetId: '9', fieldType: 'CALLOUT', action: 'link', status: 'ENABLED' },
    ])
  })

  it('a call linked where it serves is PAUSED unless status ENABLED (then SPENDS MONEY)', () => {
    const quiet = ok(assetLinksDraft(C, { items: [{ level: 'ad-group', adGroupId: '51', assetId: '302', fieldType: 'CALL', action: 'link' }] }, state()))
    expect(quiet.operations).toEqual([{ adGroupAssetOperation: { create: { adGroup: `${C}/adGroups/51`, asset: `${C}/assets/302`, fieldType: 'CALL', status: 'PAUSED' } } }])
    expect(quiet.spendsMoney).toEqual([])
    const on = ok(assetLinksDraft(C, { items: [{ level: 'ad-group', adGroupId: '51', assetId: '302', fieldType: 'CALL', action: 'link', status: 'ENABLED' }] }, state()))
    expect(on.spendsMoney).toEqual(['Links the call asset "000 111 2222 (IT)" ENABLED to ad group "Jackets" (campaign "Search A") (enabled): people can call from its ads at once (a call from the ad is charged like a click).'])
  })

  it('refused: a wrong asset type, an asset Google made, a field type where Google does not link it, a twice-named link', () => {
    expect(assetLinksDraft(C, { items: [{ level: 'campaign', campaignId: '21', assetId: '9', fieldType: 'CALL', action: 'link' }] }, state()))
      .toEqual({ refusal: 'Asset 9 is a CALLOUT asset: a call asset (CALL) is a CALL asset.' })
    expect(assetLinksDraft(C, { items: [{ level: 'campaign', campaignId: '22', assetId: '9', fieldType: 'CALLOUT', action: 'link' }] }, state({ assets: [{ ...CALLOUT, source: 'AUTOMATICALLY_CREATED' }] })))
      .toEqual({ refusal: expect.stringContaining('was made by Google (text customization)') })
    expect(assetLinksDraft(C, { items: [
      { level: 'account', assetId: '9', fieldType: 'LEAD_FORM', action: 'link' },
      { level: 'account', assetId: '302', fieldType: 'CALL', action: 'pause' },
      { level: 'account', assetId: '302', fieldType: 'CALL', action: 'unlink' },
    ] }, state())).toEqual({
      refusal: 'Not queued (nothing was sent): item 1: Google links a lead form (LEAD_FORM) to a campaign, not to the account; item 3: asset 302 (CALL) at the account is named twice.',
    })
  })

  it('what is already so is skipped; nothing left = nothing to change', () => {
    const d = ok(assetLinksDraft(C, { items: [
      { level: 'campaign', campaignId: '21', assetId: '9', fieldType: 'CALLOUT', action: 'link' },
      { level: 'campaign', campaignId: '21', assetId: '302', fieldType: 'CALL', action: 'pause' },
      { level: 'campaign', campaignId: '22', assetId: '9', fieldType: 'CALLOUT', action: 'unlink' },
      { level: 'account', assetId: '302', fieldType: 'CALL', action: 'pause' },
    ] }, state()))
    expect(d.skipped).toEqual([
      'The callout "Free returns" (asset 9) is already linked to campaign "Search A" (enabled).',
      'The call asset "000 111 2222 (IT)" (asset 302) at campaign "Search A" is already paused.',
      'Asset 9 is not linked to campaign "Search B" as a callout (CALLOUT).',
    ])
    expect(d.operations).toHaveLength(1)
    expect(assetLinksDraft(C, { items: [{ level: 'campaign', campaignId: '21', assetId: '302', fieldType: 'CALL', action: 'pause' }] }, state()))
      .toEqual({ refusal: 'Nothing to change: The call asset "000 111 2222 (IT)" (asset 302) at campaign "Search A" is already paused.' })
  })
})

describe('assetLinksDraft — review fixes (G6)', () => {
  const CALL_A = detail('302', 'CALL', { countryCode: 'IT', phoneNumber: '000 111 2222' }, '000 111 2222 (IT)')
  const CALL_C = detail('303', 'CALL', { countryCode: 'IT', phoneNumber: '000 333 4444' }, '000 333 4444 (IT)')
  const base = (over: Partial<LinksLive> = {}): LinksLive => ({ campaigns: [SEARCH_ON, SEARCH_OFF, PMAX], adGroups: [GROUP()], links: [], assets: [CALL_A, CALL_C], ...over })

  it('a call linked or enabled ENABLED where nothing serves yet: the same warning as add-google-assets, no spend', () => {
    const d = ok(assetLinksDraft(C, { items: [{ level: 'campaign', campaignId: '22', assetId: '302', fieldType: 'CALL', action: 'link' }] }, base()))
    expect(d.operations).toEqual([{ campaignAssetOperation: { create: { campaign: `${C}/campaigns/22`, asset: `${C}/assets/302`, fieldType: 'CALL' } } }])
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^Linked ENABLED where nothing serves yet: call asset "000 111 2222 \(IT\)" \(asset 302\) at campaign "Search B"\. When that campaign/)]))
    const paused = link({ level: 'campaign', campaignId: '22', assetId: '302', fieldType: 'CALL', status: 'PAUSED', asset: CALL_A })
    const e = ok(assetLinksDraft(C, { items: [{ level: 'campaign', campaignId: '22', assetId: '302', fieldType: 'CALL', action: 'enable' }] }, base({ links: [paused] })))
    expect(e.warnings.join(' ')).toMatch(/Linked ENABLED where nothing serves yet/)
  })

  it('unlinking or pausing the last call of a serving campaign or ad group says when one of a level above then shows there', () => {
    const atAccount = link({ level: 'account', assetId: '302', fieldType: 'CALL', asset: CALL_A })
    const atCampaign = link({ level: 'campaign', campaignId: '21', campaignName: 'Search A', assetId: '303', fieldType: 'CALL', asset: CALL_C })
    const unlink = { level: 'campaign' as const, campaignId: '21', assetId: '303', fieldType: 'CALL' as const, action: 'unlink' as const }
    const d = ok(assetLinksDraft(C, { items: [unlink] }, base({ links: [atCampaign], paidAround: [atAccount, atCampaign] })))
    expect(d.warnings).toContain('campaign "Search A" keeps no enabled call asset of its own: the account\'s call asset "000 111 2222 (IT)" can show in its ads instead (Google uses the most specific level that has one) — people may call from those ads (a call from the ad is charged like a click).')
    // Another enabled call of its own stays: no warning.
    const second = link({ level: 'campaign', campaignId: '21', assetId: '302', fieldType: 'CALL', asset: CALL_A })
    expect(ok(assetLinksDraft(C, { items: [unlink] }, base({ links: [atCampaign], paidAround: [atAccount, atCampaign, second] }))).warnings.join(' ')).not.toMatch(/keeps no enabled/)
    // An ad group: its campaign's call first.
    const atGroup = link({ level: 'ad-group', campaignId: '21', adGroupId: '51', assetId: '302', fieldType: 'CALL', asset: CALL_A })
    const g = ok(assetLinksDraft(C, { items: [{ level: 'ad-group', adGroupId: '51', assetId: '302', fieldType: 'CALL', action: 'pause' }] }, base({ links: [atGroup], paidAround: [atAccount, atCampaign, atGroup] })))
    expect(g.warnings.join(' ')).toContain('ad group "Jackets" (campaign "Search A") keeps no enabled call asset of its own: its campaign\'s call asset "000 333 4444 (IT)" can show in its ads instead')
    // Nothing above: no warning.
    expect(ok(assetLinksDraft(C, { items: [unlink] }, base({ links: [atCampaign], paidAround: [atCampaign] }))).warnings.join(' ')).not.toMatch(/keeps no enabled/)
  })
})

describe('live reads (G6)', () => {
  it('a WHERE on a segmenting resource\'s field selects it too; ids and field types are checked before sending', () => {
    expect(liveCampaignLinksQuery(['21'], { fieldTypes: ['CALL'] })).toMatch(/^SELECT campaign\.id, campaign\.name, campaign\.status, campaign_asset\.field_type/)
    expect(liveCampaignLinksQuery(['21'], { fieldTypes: ['CALL'] })).toContain("WHERE campaign_asset.status != 'REMOVED' AND campaign.status != 'REMOVED' AND campaign.id IN (21) AND campaign_asset.field_type IN ('CALL')")
    const groups = liveAdGroupLinksQuery({ adGroupIds: ['51'] }, { assetIds: ['9', '9', '302'] })
    expect(groups).toMatch(/^SELECT campaign\.id, campaign\.name, campaign\.status, ad_group\.id, ad_group\.name, ad_group\.status, ad_group_asset\.field_type/)
    expect(groups).toContain("AND ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED' AND ad_group.id IN (51) AND asset.id IN (9, 302)")
    expect(liveAccountLinksQuery()).toMatch(/FROM customer_asset WHERE customer_asset.status != 'REMOVED'$/)
    expect(() => liveAccountLinksQuery({ fieldTypes: ["CALL' OR 1=1"] })).toThrow(/Nothing was sent/)
    expect(() => liveCampaignLinksQuery(['21 OR 1=1'])).toThrow(/Nothing was sent/)
    expect(LIVE_LEAD_FORM_TERMS_QUERY).toBe('SELECT customer.customer_agreement_setting.accepted_lead_form_terms FROM customer')
  })

  it('an asset of every type reads as a person reads it', () => {
    expect(liveAssetDetailOf({ id: '1', type: 'IMAGE', name: 'Logo A', imageAsset: { fileSize: '2000', mimeType: 'IMAGE_PNG', fullSize: { widthPixels: '1200', heightPixels: '1200', url: 'https://img.example/1' } } }))
      .toMatchObject({ assetId: '1', label: 'Logo A (1200×1200)', details: { width: 1200, height: 1200, fileSize: 2000, mimeType: 'IMAGE_PNG' } })
    expect(liveAssetDetailOf({ id: '2', type: 'CALL', callAsset: { countryCode: 'IT', phoneNumber: '000 111 2222', callConversionReportingState: 'USE_RESOURCE_LEVEL_CALL_CONVERSION_ACTION', callConversionAction: `${C}/conversionActions/77` } }))
      .toMatchObject({ label: '000 111 2222 (IT)', details: { conversionActionId: '77' } })
    expect(liveAssetDetailOf({ id: '3', type: 'PROMOTION', promotionAsset: { promotionTarget: 'Gloves', percentOff: '125000' } }))
      .toMatchObject({ label: 'Gloves: 12.5% off', details: { percentOff: 12.5, amountOff: null } })
    expect(liveAssetDetailOf({ id: '4', type: 'PRICE', priceAsset: { type: 'BRANDS', languageCode: 'it', priceOfferings: [{ header: 'A', description: 'B', price: { amountMicros: '49900000', currencyCode: 'EUR' } }] } }))
      .toMatchObject({ label: 'BRANDS: A', details: { offerings: [{ header: 'A', price: { cents: 4990, currency: 'EUR' } }] } })
    expect(liveAssetDetailOf({ id: '5', type: 'TEXT', textAsset: { text: 'Shop A' } })).toMatchObject({ label: 'Shop A', details: { text: 'Shop A' } })
    const row = { campaign: { id: '21', name: 'Search A', status: 'ENABLED' }, adGroup: { id: '51', name: 'Jackets', status: 'PAUSED' }, adGroupAsset: { fieldType: 'CALLOUT', status: 'ENABLED', source: 'ADVERTISER' }, asset: { id: '9', type: 'CALLOUT', calloutAsset: { calloutText: 'Free returns' } } }
    expect(livePlaceLinkOf('ad-group', row)).toMatchObject({ level: 'ad-group', campaignId: '21', adGroupId: '51', adGroupStatus: 'PAUSED', assetId: '9', fieldType: 'CALLOUT', status: 'ENABLED', asset: { label: 'Free returns' } })
    expect(livePlaceLinkOf('account', { customerAsset: { fieldType: 'CALL', status: 'PAUSED' }, asset: { id: '2', type: 'CALL' } })).toMatchObject({ level: 'account', campaignId: null, adGroupId: null, status: 'PAUSED' })
  })

  it('view asset-links: every level and the location sets; a part Google refuses is named, the rest still read', async () => {
    rows.queries.length = 0
    rows.answer = (q) => {
      if (q.includes('FROM customer_asset')) return [{ customerAsset: { fieldType: 'CALL', status: 'PAUSED' }, asset: { id: '302', type: 'CALL', callAsset: { countryCode: 'IT', phoneNumber: '000 111 2222' } } }]
      if (q.includes('FROM campaign_asset ')) return [{ campaign: { id: '21', name: 'Search A', status: 'ENABLED' }, campaignAsset: { fieldType: 'CALLOUT', status: 'ENABLED' }, asset: { id: '9', type: 'CALLOUT', calloutAsset: { calloutText: 'Free returns' } } }]
      if (q.includes('FROM ad_group_asset')) throw new Error('Google Ads refused the read')
      if (q.includes('FROM asset_set ')) return [{ assetSet: { id: '81', name: 'Shops', type: 'LOCATION_SYNC', locationSet: { locationOwnershipType: 'BUSINESS_OWNER' } } }]
      if (q.includes('FROM campaign_asset_set')) return [{ campaign: { id: '21', name: 'Search A' }, assetSet: { id: '81' } }]
      return []
    }
    const view = await liveAssetLinksView({ connectionId: 'g-1', customerId: '1234567890', loginCustomerId: null } as never, '21')
    expect(view.accountLinks).toMatchObject([{ level: 'account', assetId: '302', fieldType: 'CALL', status: 'PAUSED', asset: { label: '000 111 2222 (IT)' } }])
    expect(view.campaigns).toMatchObject([{ level: 'campaign', campaignId: '21', assetId: '9', asset: { label: 'Free returns' } }])
    expect(view.adGroups).toEqual([])
    expect(view.locationSets).toEqual([{ assetSetId: '81', name: 'Shops', type: 'LOCATION_SYNC', parentAssetSetId: null, ownership: 'BUSINESS_OWNER', campaigns: [{ campaignId: '21', name: 'Search A' }] }])
    expect(view.totals).toEqual({ accountLinks: 1, campaigns: 1, adGroups: 0 })
    expect(view).not.toHaveProperty('account')
    expect(view.notRead).toEqual([{ part: 'ad-groups', why: 'Google Ads refused the read' }])
    // campaignId narrows the campaign and ad group reads (the account's own links are always read).
    expect(rows.queries.find((q) => q.includes('FROM campaign_asset '))).toContain('AND campaign.id IN (21)')
    expect(rows.queries.find((q) => q.includes('FROM ad_group_asset'))).toContain('AND campaign.id = 21')
  })
})
