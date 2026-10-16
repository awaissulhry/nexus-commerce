/**
 * Google Ads changes (2026-10-15) — PR 5, responsive search ads and campaign assets, built from a request and the live
 * state (pure): the exact Google operations, the status a new ad gets (and what spends money), every length / pin / path
 * / header problem refused before anything is sent, what is skipped, and the record undo reads (ids by operation index).
 */
import { describe, expect, it } from 'vitest'
import { adsChangeDraft, adsRecordAfterRun, displayWidth, tagWarning, uncountedTags, type AdsLiveState, type RsaAd } from './change-ads.js'
import { assetsChangeDraft, assetsRecordAfterRun, snippetHeader, type AssetsLiveState } from './change-assets.js'
import { liveAccountAssetOf, liveAdGroupPlaceOf, liveAdGroupPlaceQuery, liveAssetsByIdQuery } from './live-ads-assets.js'
import type { LiveAd, LiveAsset, LiveCampaign } from './live.js'

const C = 'customers/1234567890'

const place = (campaignStatus: string, adGroupStatus: string, type = 'SEARCH'): AdsLiveState['place'] => ({
  campaign: { campaignId: '21', name: 'Search A', status: campaignStatus, type },
  adGroup: { adGroupId: '51', name: 'Jackets', status: adGroupStatus, type: type === 'SEARCH' ? 'SEARCH_STANDARD' : 'SHOPPING_PRODUCT_ADS' },
})
const liveAd = (adId: string, status: string, adGroupId = '51'): LiveAd => ({
  adGroupId, adId, status, type: 'RESPONSIVE_SEARCH_AD', finalUrls: ['https://shop.example/a'], headlines: [{ text: `Old ${adId}`, pinned: null }],
  descriptions: [], path1: null, path2: null, strength: null, approval: null, review: null, policy: [],
})
const AD: RsaAd = {
  headlines: [{ text: 'Moto Jackets', pin: 'HEADLINE_1' }, { text: 'Free Returns' }, { text: 'Shop A Official' }],
  descriptions: [{ text: 'Leather and textile jackets for the road.', pin: 'DESCRIPTION_1' }, { text: 'Ships in 24 hours.' }],
  path1: 'jackets',
  path2: 'leather',
  finalUrl: 'https://shop.example/jackets',
}

describe('displayWidth — the length Google counts', () => {
  it('a character is 1 (an accented one too), a double-width one 2, an insertion tag its default text', () => {
    expect(displayWidth('Giacca')).toBe(6)
    expect(displayWidth('Perché')).toBe(6)
    expect(displayWidth('日本語')).toBe(6)
    expect(displayWidth('한국어 ok')).toBe(9)
    expect(displayWidth('Ｗ')).toBe(2)
    expect(displayWidth('{KeyWord:Moto jackets}')).toBe(12)
  })

  it('NFC first: a letter and its combining accent are one character', () => {
    expect(displayWidth(`Perche${String.fromCharCode(0x301)}`)).toBe(6)
  })

  it('a tag without default text counts 0 and is named: Google\'s check judges it', () => {
    expect(displayWidth('{LOCATION(City)} jackets')).toBe(8)
    expect(displayWidth('Sale ends {COUNTDOWN("2026/10/20 12:00:00")}')).toBe(10)
    expect(uncountedTags('{KeyWord:Moto} in {LOCATION(City)}')).toEqual(['{LOCATION(City)}'])
    expect(tagWarning('ad 1, headline 2', 'Moto in {LOCATION(City)}')).toBe('ad 1, headline 2: Nexus did not count {LOCATION(City)} (a tag without default text); Google\'s check judges its length.')
    expect(tagWarning('ad 1, headline 2', 'Moto')).toBeNull()
  })
})

describe('adsChangeDraft — make responsive search ads', () => {
  const paused: AdsLiveState = { place: place('PAUSED', 'ENABLED'), ads: [liveAd('700', 'ENABLED'), liveAd('800', 'ENABLED', '52')] }

  it('in a paused campaign: made ENABLED (nothing serves), the exact operation, nothing spends; ids from Google after the run', () => {
    const d = adsChangeDraft(C, { campaignId: '21', adGroupId: '51', ads: [AD] }, paused)
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([{
      adGroupAdOperation: {
        create: {
          adGroup: `${C}/adGroups/51`,
          status: 'ENABLED',
          ad: {
            finalUrls: ['https://shop.example/jackets'],
            responsiveSearchAd: {
              headlines: [{ text: 'Moto Jackets', pinnedField: 'HEADLINE_1' }, { text: 'Free Returns' }, { text: 'Shop A Official' }],
              descriptions: [{ text: 'Leather and textile jackets for the road.', pinnedField: 'DESCRIPTION_1' }, { text: 'Ships in 24 hours.' }],
              path1: 'jackets',
              path2: 'leather',
            },
          },
        },
      },
    }])
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings).toEqual(['The new ads are made ENABLED: campaign "Search A" is paused, so they show nothing until it is enabled (enabling it is a change of its own, and spends money).'])
    expect(d.changes['ad 1 headlines (3)']).toEqual({ from: '(none)', to: 'Moto Jackets [H1] | Free Returns | Shop A Official' })
    expect(d.changes['ad 1 descriptions and URL'].to).toBe('Leather and textile jackets for the road. [D1] | Ships in 24 hours. — https://shop.example/jackets (shown as shop.example/jackets/leather) — ENABLED')
    expect(d.summary).toBe('Google Ads: make 1 responsive search ad in ad group "Jackets" of campaign "Search A", enabled.')
    expect(d.after).toEqual({ campaignId: '21', adGroupId: '51', created: [{ adId: 'op:0', status: 'ENABLED' }], paused: [] })
    expect(d.before).toEqual({ campaignId: '21', adGroupId: '51', ads: [] })
    expect(d.stands).toEqual({
      campaign: { campaignId: '21', status: 'PAUSED', type: 'SEARCH' },
      adGroup: { adGroupId: '51', status: 'ENABLED', type: 'SEARCH_STANDARD' },
      ads: [{ adId: '700', status: 'ENABLED', type: 'RESPONSIVE_SEARCH_AD' }],
    })
    const two = adsChangeDraft(C, { campaignId: '21', adGroupId: '51', ads: [AD, { ...AD, path1: null, path2: null }] }, paused)
    if ('refusal' in two) throw new Error(two.refusal)
    expect((two.operations[1] as any).adGroupAdOperation.create.ad.responsiveSearchAd).not.toHaveProperty('path1')
    const after = adsRecordAfterRun(two.after as never, [{ adGroupAdResult: { resourceName: `${C}/adGroupAds/51~901` } }, { adGroupAdResult: { resourceName: `${C}/adGroupAds/51~902` } }])
    expect(after.created).toEqual([{ adId: '901', status: 'ENABLED' }, { adId: '902', status: 'ENABLED' }])
  })

  it('in an enabled ad group of an enabled campaign: PAUSED unless enable: true, which SPENDS MONEY; enable: false pauses anywhere', () => {
    const live: AdsLiveState = { place: place('ENABLED', 'ENABLED'), ads: [] }
    const d = adsChangeDraft(C, { campaignId: '21', adGroupId: '51', ads: [AD] }, live)
    if ('refusal' in d) throw new Error(d.refusal)
    expect((d.operations[0] as any).adGroupAdOperation.create.status).toBe('PAUSED')
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings[0]).toMatch(/^The new ads are made PAUSED: .*enable: true/)
    const on = adsChangeDraft(C, { campaignId: '21', adGroupId: '51', ads: [AD], enable: true }, live)
    if ('refusal' in on) throw new Error(on.refusal)
    expect((on.operations[0] as any).adGroupAdOperation.create.status).toBe('ENABLED')
    expect(on.spendsMoney).toEqual(['Makes 1 responsive search ad ENABLED in the enabled ad group "Jackets" of campaign "Search A": it shows (and spends) as soon as Google approves it.'])
    // An enabled campaign with a paused ad group: still PAUSED by default (enabling the ad group later switches on nothing
    // unseen); enable: true is SPENDS MONEY, with the note that nothing serves until the ad group is enabled.
    const groupOff: AdsLiveState = { place: place('ENABLED', 'PAUSED'), ads: [] }
    const quiet = adsChangeDraft(C, { campaignId: '21', adGroupId: '51', ads: [AD] }, groupOff)
    if ('refusal' in quiet) throw new Error(quiet.refusal)
    expect((quiet.operations[0] as any).adGroupAdOperation.create.status).toBe('PAUSED')
    expect(quiet.spendsMoney).toEqual([])
    expect(quiet.warnings).toEqual(['The new ads are made PAUSED: campaign "Search A" is enabled, so enabled ads would show as soon as ad group "Jackets" is enabled. Ask with enable: true to make them enabled (that spends money).'])
    const loud = adsChangeDraft(C, { campaignId: '21', adGroupId: '51', ads: [AD, AD], enable: true }, groupOff)
    if ('refusal' in loud) throw new Error(loud.refusal)
    expect((loud.operations[0] as any).adGroupAdOperation.create.status).toBe('ENABLED')
    expect(loud.spendsMoney).toEqual(['Makes 2 responsive search ads ENABLED in ad group "Jackets" of the enabled campaign "Search A": the ad group is paused, so nothing serves until it is enabled; then they show (and spend).'])
    const off = adsChangeDraft(C, { campaignId: '21', adGroupId: '51', ads: [AD], enable: false }, paused)
    if ('refusal' in off) throw new Error(off.refusal)
    expect((off.operations[0] as any).adGroupAdOperation.create.status).toBe('PAUSED')
    expect(off.warnings).toEqual([])
  })

  it('every length, duplicate, pin, path and URL problem is refused before anything is sent, all listed', () => {
    const bad: RsaAd = {
      headlines: [
        { text: 'A headline that is far too long!' }, // 32
        { text: 'Free returns', pin: 'DESCRIPTION_1' },
        { text: 'Free  returns' },
        { text: '日本語のとても長い見出しです日本語の' }, // 18 wide characters = 36
      ],
      descriptions: [{ text: 'x'.repeat(91) }],
      path2: 'leather',
      finalUrl: 'http://shop.example/jackets',
    }
    const d = adsChangeDraft(C, { campaignId: '21', adGroupId: '51', ads: [AD, bad] }, paused)
    if (!('refusal' in d)) throw new Error('expected a refusal')
    expect(d.refusal).toMatch(/^Not queued — the ads break Google's rules \(nothing was sent\): /)
    for (const part of [
      'ad 2: 1 description (Google needs at least 2)',
      'ad 2, headline 1 "A headline that is far too long!" is 32 characters long: Google allows 30',
      'ad 2, headline 4 "日本語のとても長い見出しです日本語の" is 36 characters long (a double-width character counts 2): Google allows 30',
      'ad 2, description 1 "' ,
      'is 91 characters long: Google allows 90',
      'ad 2, headline 3 "Free  returns" repeats headline 2 exactly (Google refuses duplicates)',
      'ad 2, headline 2: pin DESCRIPTION_1 is not a headline position (HEADLINE_1, HEADLINE_2, HEADLINE_3)',
      'ad 2: path2 needs path1',
      'ad 2: "http://shop.example/jackets" is not an https address',
    ]) expect(d.refusal).toContain(part)
    expect(d.refusal).not.toContain('ad 1')
  })

  it('only exact duplicates are refused (case counts: Google\'s check judges the rest); a tag without default text is a warning', () => {
    const cased: RsaAd = { ...AD, headlines: [{ text: '{LOCATION(City)} Jackets' }, { text: 'Moto jackets' }, { text: 'MOTO JACKETS' }] }
    const d = adsChangeDraft(C, { campaignId: '21', adGroupId: '51', ads: [cased] }, paused)
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.warnings).toContain('ad 1, headline 1: Nexus did not count {LOCATION(City)} (a tag without default text); Google\'s check judges its length.')
  })

  it('pins that leave headline 1, headline 2 or description 1 with nothing to show are refused', () => {
    const allOnOne: RsaAd = { ...AD, headlines: AD.headlines.map((h) => ({ text: h.text, pin: 'HEADLINE_1' as const })) }
    const d = adsChangeDraft(C, { campaignId: '21', adGroupId: '51', ads: [allOnOne] }, paused)
    expect(d).toEqual({ refusal: 'Not queued — the ads break Google\'s rules (nothing was sent): ad 1: the pins leave HEADLINE_2 with no headline to show (pin one there, or leave more headlines unpinned).' })
    const descs: RsaAd = { ...AD, descriptions: AD.descriptions.map((t) => ({ text: t.text, pin: 'DESCRIPTION_2' as const })) }
    expect(adsChangeDraft(C, { campaignId: '21', adGroupId: '51', ads: [descs] }, paused)).toMatchObject({ refusal: expect.stringContaining('leave DESCRIPTION_1 with no description') })
  })

  it('Google\'s 3 enabled responsive search ads per ad group, counted before it is sent', () => {
    const full: AdsLiveState = { place: place('PAUSED', 'ENABLED'), ads: [liveAd('700', 'ENABLED'), liveAd('701', 'ENABLED'), liveAd('702', 'PAUSED')] }
    expect(adsChangeDraft(C, { campaignId: '21', adGroupId: '51', ads: [AD, AD] }, full)).toMatchObject({ refusal: expect.stringContaining('"Jackets" has 2 enabled and this would add 2 more enabled') })
    expect('refusal' in adsChangeDraft(C, { campaignId: '21', adGroupId: '51', ads: [AD, AD], enable: false }, full)).toBe(false)
  })

  it('refused: another campaign type, an ad group not in the campaign, both forms at once, nothing asked', () => {
    expect(adsChangeDraft(C, { campaignId: '21', adGroupId: '51', ads: [AD] }, { place: place('PAUSED', 'ENABLED', 'SHOPPING'), ads: [] }))
      .toEqual({ refusal: 'Responsive search ads go in Search campaigns only: "Search A" is a SHOPPING campaign.' })
    expect(adsChangeDraft(C, { campaignId: '21', adGroupId: '59', ads: [AD] }, { place: null, ads: [] })).toMatchObject({ refusal: expect.stringContaining('Ad group 59 is not in campaign 21') })
    expect(adsChangeDraft(C, { campaignId: '21', adGroupId: '51', ads: [AD], pauseAdIds: ['700'] }, paused)).toEqual({ refusal: 'Give ads (to make) or pauseAdIds (to pause), not both.' })
    expect(adsChangeDraft(C, { campaignId: '21', adGroupId: '51' }, paused)).toMatchObject({ refusal: expect.stringContaining('Say what to do') })
  })
})

describe('adsChangeDraft — the undo form: pause ads of the ad group', () => {
  it('a status update with its mask; an ad already paused is skipped; an ad of another ad group is refused', () => {
    const live: AdsLiveState = { place: place('ENABLED', 'ENABLED'), ads: [liveAd('700', 'ENABLED'), liveAd('701', 'PAUSED'), liveAd('800', 'ENABLED', '52')] }
    const d = adsChangeDraft(C, { campaignId: '21', adGroupId: '51', pauseAdIds: ['700', '701'] }, live)
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([{ adGroupAdOperation: { update: { resourceName: `${C}/adGroupAds/51~700`, status: 'PAUSED' }, updateMask: 'status' } }])
    expect(d.skipped).toEqual(['Ad 701 ("Old 701") is already paused.'])
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings).toEqual(['"Jackets" has no enabled ad left: it shows no ads until one is enabled.'])
    expect(d.before).toEqual({ campaignId: '21', adGroupId: '51', ads: [{ adId: '700', status: 'ENABLED' }] })
    expect(d.after).toEqual({ campaignId: '21', adGroupId: '51', created: [], paused: ['700'] })
    expect(adsChangeDraft(C, { campaignId: '21', adGroupId: '51', pauseAdIds: ['800'] }, live)).toMatchObject({ refusal: expect.stringContaining('Ad 800 is not in ad group "Jackets"') })
    expect(adsChangeDraft(C, { campaignId: '21', adGroupId: '51', pauseAdIds: ['701'] }, live)).toEqual({ refusal: 'Nothing to change: Ad 701 ("Old 701") is already paused.' })
    expect(adsChangeDraft(C, { campaignId: '21', adGroupId: '51', pauseAdIds: ['700'], enable: true }, live)).toMatchObject({ refusal: expect.stringContaining('enable is for ads to make') })
  })
})

// ── assets ──────────────────────────────────────────────────────────────────────────────────────────────────────

const CAMPAIGN: LiveCampaign = {
  campaignId: '21', name: 'Search A', status: 'PAUSED', servingStatus: null, primaryStatus: null, type: 'SEARCH', subType: null, bidding: 'MANUAL_CPC',
  start: null, end: null, shopping: null, budget: null,
}
const link = (assetId: string, fieldType: string, extra: Partial<LiveAsset>): LiveAsset => ({
  campaignId: '21', assetId, fieldType, type: fieldType, status: 'ENABLED', primaryStatus: null, primaryStatusReasons: [], text: null, finalUrls: [],
  approval: null, review: null, policy: [], ...extra,
})
const ASSETS: AssetsLiveState = {
  campaign: CAMPAIGN,
  linked: [
    link('9', 'CALLOUT', { text: 'Free Returns' }),
    link('10', 'SITELINK', { text: 'Size guide', finalUrls: ['https://shop.example/size'] }),
    link('11', 'STRUCTURED_SNIPPET', { header: 'Tipi', values: ['Giacche', 'Guanti', 'Stivali'] }),
  ],
  assets: [],
}

describe('snippetHeader — Google\'s fixed headers, per language', () => {
  it('the language\'s own header (any case), or the English name translated; refused otherwise with the list', () => {
    expect(snippetHeader('tipi', 'it')).toEqual({ header: 'Tipi' })
    expect(snippetHeader('Types', 'it')).toEqual({ header: 'Tipi' })
    expect(snippetHeader('Brands', 'de')).toEqual({ header: 'Marken' })
    expect(snippetHeader('Services')).toEqual({ header: 'Service catalog' })
    expect(snippetHeader('Neighbourhoods', 'en-GB')).toEqual({ header: 'Neighbourhoods' })
    expect(snippetHeader('Neighborhoods', 'es')).toMatchObject({ problem: expect.stringContaining('is not one of Google\'s headers in Spanish (Spain)') })
    expect(snippetHeader('Colori', 'it')).toEqual({ problem: 'header "Colori" is not one of Google\'s headers in Italian (Brand, Servizi, Stili, Tipi, Destinazioni, Corsi, Quartieri, Programmi, Coperture assicurativa, Corsi di laurea, Hotel consigliati, Modelli)' })
    expect(snippetHeader('Types', 'xx')).toMatchObject({ problem: expect.stringContaining('language "xx" is not one Google has snippet headers for') })
  })
})

describe('assetsChangeDraft', () => {
  it('new sitelink, callout and snippet: assets first with temporary ids, then their campaign links; ids from Google after the run', () => {
    const d = assetsChangeDraft(C, {
      campaignId: '21',
      sitelinks: [{ linkText: 'Contact', description1: 'Write to us', description2: 'We answer in a day', finalUrl: 'https://shop.example/contact' }],
      callouts: ['Ships in 24h'],
      structuredSnippets: [{ header: 'Styles', language: 'it', values: ['Racing', 'Touring', 'Urban'] }],
    }, ASSETS)
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([
      { assetOperation: { create: { resourceName: `${C}/assets/-1`, finalUrls: ['https://shop.example/contact'], sitelinkAsset: { linkText: 'Contact', description1: 'Write to us', description2: 'We answer in a day' } } } },
      { assetOperation: { create: { resourceName: `${C}/assets/-2`, calloutAsset: { calloutText: 'Ships in 24h' } } } },
      { assetOperation: { create: { resourceName: `${C}/assets/-3`, structuredSnippetAsset: { header: 'Stili', values: ['Racing', 'Touring', 'Urban'] } } } },
      { campaignAssetOperation: { create: { campaign: `${C}/campaigns/21`, asset: `${C}/assets/-1`, fieldType: 'SITELINK' } } },
      { campaignAssetOperation: { create: { campaign: `${C}/campaigns/21`, asset: `${C}/assets/-2`, fieldType: 'CALLOUT' } } },
      { campaignAssetOperation: { create: { campaign: `${C}/campaigns/21`, asset: `${C}/assets/-3`, fieldType: 'STRUCTURED_SNIPPET' } } },
    ])
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings).toEqual([])
    expect(d.summary).toBe('Google Ads assets of campaign "Search A": make and link 1 new sitelink, 1 new callout, 1 new structured snippet.')
    expect(d.changes['structured snippet "Stili: Racing, Touring, Urban"']).toEqual({ from: '(none)', to: 'new, linked — Racing, Touring, Urban' })
    expect(d.after).toEqual({
      campaignId: '21',
      linked: [
        { assetId: 'op:0', fieldType: 'SITELINK', text: 'Contact', status: 'ENABLED' },
        { assetId: 'op:1', fieldType: 'CALLOUT', text: 'Ships in 24h', status: 'ENABLED' },
        { assetId: 'op:2', fieldType: 'STRUCTURED_SNIPPET', text: 'Stili: Racing, Touring, Urban', status: 'ENABLED' },
      ],
      unlinked: [],
    })
    const after = assetsRecordAfterRun(d.after as never, [
      { assetResult: { resourceName: `${C}/assets/301` } }, { assetResult: { resourceName: `${C}/assets/302` } }, { assetResult: { resourceName: `${C}/assets/303` } }, {}, {}, {},
    ])
    expect(after.linked.map((l) => l.assetId)).toEqual(['301', '302', '303'])
  })

  it('already linked with the same text, or named twice in the request: skipped, not made twice (case counts)', () => {
    const live: AssetsLiveState = { ...ASSETS, linked: ASSETS.linked.map((a) => (a.assetId === '9' ? { ...a, status: 'PAUSED' } : a)) }
    const d = assetsChangeDraft(C, {
      campaignId: '21',
      callouts: ['Free Returns', 'Gift wrap', 'Gift  wrap', 'free returns'],
      sitelinks: [{ linkText: 'Size guide', finalUrl: 'https://shop.example/other' }],
      structuredSnippets: [{ header: 'Tipi', language: 'it', values: ['Stivali', 'Giacche', 'Guanti'] }],
    }, live)
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toHaveLength(4)
    expect(d.skipped).toEqual([
      'Sitelink "Size guide": the same link text is already linked to "Search A" (URL https://shop.example/size).',
      'Callout "Free Returns" is already linked to "Search A" (its link is paused).',
      'Callout "Gift  wrap" is named twice in this request.',
      'Structured snippet "Tipi: Stivali, Giacche, Guanti" is already linked to "Search A".',
    ])
    expect((d.after as { linked: Array<{ text: string }> }).linked.map((l) => l.text)).toEqual(['Gift wrap', 'free returns'])
  })

  it('unlink removes the campaign link (not the asset) and says the ads show without it; link again an existing asset', () => {
    const live: AssetsLiveState = { ...ASSETS, linked: ASSETS.linked.map((a) => (a.assetId === '9' ? { ...a, status: 'PAUSED' } : a)), assets: [{ assetId: '12', type: 'CALLOUT', text: 'Made in Italy', finalUrls: [] }] }
    const d = assetsChangeDraft(C, { campaignId: '21', unlinkAssets: [{ assetId: '9', fieldType: 'CALLOUT' }, { assetId: '10', fieldType: 'CALLOUT' }], linkAssets: [{ assetId: '12', fieldType: 'CALLOUT' }] }, live)
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([
      { campaignAssetOperation: { create: { campaign: `${C}/campaigns/21`, asset: `${C}/assets/12`, fieldType: 'CALLOUT' } } },
      { campaignAssetOperation: { remove: `${C}/campaignAssets/21~9~CALLOUT` } },
    ])
    expect(d.skipped).toEqual(['Asset 10 is not linked to "Search A" as a callout.'])
    expect(d.warnings).toEqual([
      'Unlinking 1 asset from "Search A": its ads show without it (the asset stays in the account).',
      '1 link taken off is paused now (it shows nothing today); undo links it again paused.',
    ])
    expect(d.changes['callout "Free Returns" (asset 9)']).toEqual({ from: 'linked, paused (it shows nothing now)', to: 'unlinked (the ads show without it)' })
    expect(d.before).toEqual({ campaignId: '21', links: [{ assetId: '9', fieldType: 'CALLOUT', text: 'Free Returns', status: 'PAUSED' }] })
    expect(d.after).toEqual({ campaignId: '21', linked: [{ assetId: '12', fieldType: 'CALLOUT', text: 'Made in Italy', status: 'ENABLED' }], unlinked: [{ assetId: '9', fieldType: 'CALLOUT', text: 'Free Returns', status: 'PAUSED' }] })
    // Undo's relink of a link that was paused: it goes back paused.
    const back = assetsChangeDraft(C, { campaignId: '21', linkAssets: [{ assetId: '12', fieldType: 'CALLOUT', status: 'PAUSED' }] }, live)
    if ('refusal' in back) throw new Error(back.refusal)
    expect(back.operations).toEqual([{ campaignAssetOperation: { create: { campaign: `${C}/campaigns/21`, asset: `${C}/assets/12`, fieldType: 'CALLOUT', status: 'PAUSED' } } }])
    expect(back.changes['callout "Made in Italy" (asset 12)']).toEqual({ from: 'not linked', to: 'linked, paused (it shows nothing)' })
    expect(d.summary).toBe('Google Ads assets of campaign "Search A": link 1 existing asset; unlink 1 asset.')
    expect(assetsChangeDraft(C, { campaignId: '21', linkAssets: [{ assetId: '12', fieldType: 'SITELINK' }] }, live)).toEqual({ refusal: 'Asset 12 is a CALLOUT, not a sitelink.' })
    expect(assetsChangeDraft(C, { campaignId: '21', linkAssets: [{ assetId: '9', fieldType: 'CALLOUT' }] }, { ...live, assets: [{ assetId: '9', type: 'CALLOUT', text: 'Free Returns', finalUrls: [] }] }))
      .toEqual({ refusal: 'Nothing to change: The callout "Free Returns" (asset 9) is already linked to "Search A" (its link is paused).' })
  })

  it('every length, description, URL, header and value problem is refused before anything is sent, all listed', () => {
    const d = assetsChangeDraft(C, {
      campaignId: '21',
      sitelinks: [{ linkText: 'A sitelink text that is long', description1: 'Only one line', finalUrl: 'http://shop.example' }, { linkText: 'Ok', description1: 'x'.repeat(36), description2: 'fine', finalUrl: 'https://shop.example/ok' }],
      callouts: ['A callout that is too long!'],
      structuredSnippets: [{ header: 'Colours', values: ['Red', 'Blue'] }, { header: 'Tipi', language: 'it', values: ['Rosso', 'Red', 'A value that is far too long'] }],
    }, ASSETS)
    if (!('refusal' in d)) throw new Error('expected a refusal')
    expect(d.refusal).toMatch(/^Not queued — the assets break Google's rules \(nothing was sent\): /)
    for (const part of [
      'sitelink 1, link text "A sitelink text that is long" is 28 characters long: Google allows 25',
      'sitelink 1: give description1 and description2 both, or neither',
      'sitelink 1: "http://shop.example" is not an https address',
      'sitelink 2, description1 "',
      'is 36 characters long: Google allows 35',
      'callout 1 "A callout that is too long!" is 27 characters long: Google allows 25',
      'structured snippet 1: header "Colours" is not one of Google\'s headers in English',
      'structured snippet 1: 2 values (Google needs 3 to 10)',
      'structured snippet 2, value 2 "Red" repeats structured snippet 1, value 1 exactly',
      'structured snippet 2, value 3 "A value that is far too long" is 28 characters long: Google allows 25',
    ]) expect(d.refusal).toContain(part)
  })

  it('refused: a campaign not in the account, nothing asked, a link both made and taken', () => {
    expect(assetsChangeDraft(C, { campaignId: '29', callouts: ['x'] }, { ...ASSETS, campaign: null })).toMatchObject({ refusal: expect.stringContaining('Campaign 29 is not in this account') })
    expect(assetsChangeDraft(C, { campaignId: '21' }, ASSETS)).toMatchObject({ refusal: expect.stringContaining('Say what to change') })
    expect(assetsChangeDraft(C, { campaignId: '21', linkAssets: [{ assetId: '9', fieldType: 'CALLOUT' }], unlinkAssets: [{ assetId: '9', fieldType: 'CALLOUT' }] }, ASSETS))
      .toMatchObject({ refusal: expect.stringContaining('asset 9 (CALLOUT) is both linked and unlinked') })
  })
})

describe('live reads of PR 5', () => {
  it('queries: ids are digits or nothing is sent; one ad group with its campaign; assets by id', () => {
    expect(liveAdGroupPlaceQuery('21', '51')).toBe(
      'SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, ad_group.id, ad_group.name, ad_group.status, ' +
      // G13: Google's drafts too (an experiment's in-design campaign is changed like any campaign).
      "ad_group.type FROM ad_group WHERE campaign.id = 21 AND ad_group.id = 51 AND ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED' PARAMETERS include_drafts=true",
    )
    expect(() => liveAdGroupPlaceQuery('21', '5 OR 1=1')).toThrow(/Nothing was sent/)
    expect(liveAssetsByIdQuery(['9', '12', '9'])).toMatch(/FROM asset WHERE asset\.id IN \(9, 12\)$/)
    expect(() => liveAssetsByIdQuery([])).toThrow(/Nothing was sent/)
  })

  it('rows: the ad group and its campaign; an asset of the account', () => {
    expect(liveAdGroupPlaceOf({ campaign: { id: '21', name: 'Search A', status: 'PAUSED', advertisingChannelType: 'SEARCH' }, adGroup: { id: '51', name: 'Jackets', status: 'ENABLED', type: 'SEARCH_STANDARD' } }))
      .toEqual({ campaign: { campaignId: '21', name: 'Search A', status: 'PAUSED', type: 'SEARCH' }, adGroup: { adGroupId: '51', name: 'Jackets', status: 'ENABLED', type: 'SEARCH_STANDARD' } })
    expect(liveAccountAssetOf({ asset: { id: '11', type: 'STRUCTURED_SNIPPET', structuredSnippetAsset: { header: 'Tipi', values: ['A', 'B', 'C'] } } }))
      .toEqual({ assetId: '11', type: 'STRUCTURED_SNIPPET', text: null, finalUrls: [], header: 'Tipi', values: ['A', 'B', 'C'] })
  })
})
