/**
 * Meta step 34 — the catalog drafts (pure): what each request sends, what the preview says (no Meta check, nothing spends,
 * an empty set or a delete STOPS ads), what is refused in words, and what the record keeps for undo. Made-up ids only.
 */
import { describe, expect, it } from 'vitest'
import {
  catalogCategoriesDraft, catalogCreateDraft, catalogDeleteDraft, catalogSettingsDraft, eventSourcesDraft, feedDeleteDraft, filterInWords, itemDeleteDraft, itemsDeleteDraft,
  NO_META_CHECK, partnerAccessDraft, personAccessDraft, setChangeDraft, setCreateDraft, setDeleteDraft,
} from './change-catalog-admin.js'
import type { MetaChangeDraft } from './change-draft.js'
import { AUDIENCES_UNSEEN, type SetNow } from './live-catalog-admin.js'

const BUSINESS = '120000000000090'
const CATALOG = '120000000000100'
const SET = '120000000000110'
const PIXEL = '120000000000050'
const draft = (d: MetaChangeDraft | { refusal: string }): MetaChangeDraft => { if ('refusal' in d) throw new Error(d.refusal); return d }
const adSet = (id: string, status: string, uses = `product set ${SET}`, kind: 'campaign' | 'adset' | 'ad' = 'adset') => ({ kind, id, name: 'Ad set B', effectiveStatus: status, uses })
const use = (users: Array<ReturnType<typeof adSet>>, unseen: string[] = []) => ({ users, unseen })
const set: SetNow = { productSetId: SET, catalogId: CATALOG, name: 'Set A', filter: '{"brand":{"eq":"Shop A"}}', retailerId: null, productCount: 12, metadata: null }

describe('every catalog draft', () => {
  it('one request, no Meta check, nothing that spends; the preview says Meta has no check', () => {
    const drafts = [
      catalogCreateDraft({ name: 'Catalog A' }, { portfolioId: BUSINESS }),
      catalogSettingsDraft({ name: 'Catalog B' }, { catalogId: CATALOG, name: 'Catalog A', defaultImageUrl: null, fallbackImageUrls: [], displaySettings: null, productCount: 3 }, use([])),
      setCreateDraft({ name: 'Set A', filter: '{}' }, { catalogId: CATALOG, catalogName: 'Catalog A', count: { matching: 3, itemsNow: null, catalogItems: 3 }, usesInternalLabel: false }),
      catalogDeleteDraft({ catalogId: CATALOG, name: 'Catalog A', isSegment: false, productCount: 0, sets: [], setsMore: false, use: use([]) }, false, 'asked'),
    ]
    for (const d of drafts) {
      expect(d.requests).toHaveLength(1)
      expect(d.requests[0]).toMatchObject({ check: 'none', raisesSpend: false, budget: false })
      expect(d.spendsMoney).toEqual([])
      expect(d.warnings).toContain(NO_META_CHECK)
    }
  })
})

describe('create-meta-catalog', () => {
  it('a catalog: name + vertical commerce on the chosen portfolio; the terms and the portfolio said; D7', () => {
    const d = catalogCreateDraft({ name: 'Catalog A', imageSettings: { carouselAd: 'none', singleAd: 'background_padding' } }, { portfolioId: BUSINESS })
    expect(d.requests[0]).toMatchObject({ objectId: BUSINESS, objectKind: 'catalogbusiness', edge: 'owned_product_catalogs', operation: 'catalog.create', recordEvenIfNotAsAsked: true, expect: { name: 'Catalog A' } })
    expect(d.requests[0].params).toEqual({ name: 'Catalog A', vertical: 'commerce', da_display_settings: '{"carousel_ad":{"transformation_type":"none"},"single_ad":{"transformation_type":"background_padding"}}' })
    expect(d.warnings.join(' ')).toMatch(/accept its catalog terms.*for good.*Nexus writes no items \(D7\)/)
    expect(d.after).toMatchObject({ op: 'create', made: { id: null, name: 'Catalog A', segment: false } })
  })
  it('a segment: its parent and filter (an all-items segment says {}); an empty one warns that its ads would not deliver', () => {
    const d = catalogCreateDraft({ name: 'Seg A', segment: { parentId: CATALOG, parentName: 'Catalog A', filter: '', matching: 0, parentItems: 10 } }, { portfolioId: BUSINESS })
    expect(d.requests[0].params).toEqual({ name: 'Seg A', parent_catalog_id: CATALOG, catalog_segment_filter: '{}' })
    expect(d.warnings.join(' ')).toMatch(/2310019.*would be empty, and ads on it would not deliver/)
    const every = catalogCreateDraft({ name: 'Seg A', segment: { parentId: CATALOG, parentName: null, filter: '{"brand":{"eq":"A"}}', matching: 10, parentItems: 10 } }, { portfolioId: BUSINESS })
    expect(every.warnings.join(' ')).toMatch(/it matches every item/)
  })
})

describe('remove-meta-catalog-items', () => {
  it('a catalog: FINAL, every set and ad set listed, the live flag only when asked (and then what stops is named)', () => {
    const live = { catalogId: CATALOG, name: 'Catalog A', isSegment: false, productCount: 40, sets: [{ id: SET, name: 'Set A', productCount: 12 }], setsMore: false, use: use([adSet('120000000000002', 'ACTIVE')]) }
    const plain = catalogDeleteDraft(live, false, 'asked')
    expect(plain.requests[0]).toMatchObject({ method: 'DELETE', params: {}, operation: 'catalog.delete', objectKind: 'catalog' })
    expect(plain.warnings.join(' ')).toMatch(/DELETING IS FINAL.*40 item\(s\), 1 product set.*1 campaign, ad set or ad of the chosen ad account shows.*1 delivering now.*Meta refuses this delete while ads use its product sets/)
    const live2 = catalogDeleteDraft(live, true, 'asked')
    expect(live2.requests[0]).toMatchObject({ params: { allow_delete_catalog_with_live_product_set: 'true' }, operation: 'catalog.delete.live' })
    expect(live2.warnings.join(' ')).toMatch(/1 delivering campaign, ad set or ad STOP: 120000000000002/)
    expect(live2.alsoDeleted).toMatchObject({ productSets: [{ id: SET }], adsThatStop: [{ id: '120000000000002' }] })
    expect(catalogDeleteDraft({ ...live, isSegment: true }, false, 'undo').warnings.join(' ')).toMatch(/A segment holds no items of its own/)
  })
  it('a set: its delete, the live flag only when asked', () => {
    expect(setDeleteDraft({ set, use: use([]) }, false, 'asked').requests[0]).toMatchObject({ method: 'DELETE', params: {}, objectKind: 'productset', objectId: SET })
    expect(setDeleteDraft({ set, use: use([adSet('120000000000002', 'ACTIVE')]) }, true, 'asked').requests[0].params).toEqual({ allow_live_product_set_deletion: 'true' })
  })
  it('items: one items_batch of DELETEs of the SKUs the catalog holds now (allow_upsert false); the rest skipped in words', () => {
    const found = new Map([['SKU-A', { itemId: '120000000000120', name: 'Jacket A' }]])
    const d = itemsDeleteDraft({ catalogId: CATALOG, catalogName: 'Catalog A', asked: ['SKU-A', 'SKU-B'], found, use: use([]) })
    expect(d.requests[0]).toMatchObject({ edge: 'items_batch', operation: 'catalog.items.delete', objectId: CATALOG })
    expect(d.requests[0].params).toEqual({ item_type: 'PRODUCT_ITEM', requests: '[{"method":"DELETE","data":{"id":"SKU-A"}}]', allow_upsert: 'false' })
    expect(d.skipped).toEqual(['SKU-B: not an item of this catalog now (Nexus read the catalog first): nothing to delete.'])
    expect(itemsDeleteDraft({ catalogId: CATALOG, catalogName: null, asked: ['SKU-B'], found: new Map(), use: use([]) }).requests).toEqual([])
  })
  it('an item by its id; a supplementary feed with its catalog named for the gateway', () => {
    expect(itemDeleteDraft({ itemId: '120000000000120', catalogId: CATALOG, sku: 'SKU-A', name: 'Jacket A', use: use([]) }).requests[0]).toMatchObject({ method: 'DELETE', objectKind: 'productitem', objectId: '120000000000120' })
    expect(feedDeleteDraft({ catalogId: CATALOG, feedId: '120000000000130', name: 'Labels' }).requests[0]).toMatchObject({ method: 'DELETE', objectKind: 'productfeed', parent: { kind: 'catalog', id: CATALOG } })
  })
})

describe('set-meta-catalog', () => {
  const now = { catalogId: CATALOG, name: 'Catalog A', defaultImageUrl: null, fallbackImageUrls: ['https://example.com/a.jpg', 'https://example.com/b.jpg'], displaySettings: { carouselAd: 'none', singleAd: 'none' }, productCount: 3 }
  it('settings: only what moves is sent; what cannot be cleared again is said; the record keeps the earlier values', () => {
    const d = catalogSettingsDraft({ name: 'Catalog A', defaultImageUrl: 'https://example.com/d.jpg', fallbackImageUrl: 'https://example.com/c.jpg', imageSettings: { carouselAd: 'background_padding', singleAd: 'none' } }, now, use([]))
    expect(d.requests[0].params).toEqual({ default_image_url: 'https://example.com/d.jpg', fallback_image_url: 'https://example.com/c.jpg', da_display_settings: '{"carousel_ad":{"transformation_type":"background_padding"},"single_ad":{"transformation_type":"none"}}' })
    expect(d.skipped).toEqual(['The catalog is named "Catalog A" already.'])
    expect(d.before).toMatchObject({ op: 'settings', fields: { defaultImageUrl: null, fallbackImageUrl: 'https://example.com/a.jpg', displaySettings: { carouselAd: 'none', singleAd: 'none' } }, noUndo: [expect.stringMatching(/no default image before/), expect.stringMatching(/2 fallback images/)] })
    expect(d.warnings.join(' ')).toMatch(/every Advantage\+ catalog ad of this catalog/)
    expect(catalogSettingsDraft({ name: 'Catalog A' }, now, use([])).requests).toEqual([])
  })
  it('categories: the landing page is needed the first time; an empty one skips; Meta cannot delete one (said)', () => {
    const byCriteria = new Map([['BRAND', { byValue: new Map([['Brand A', { criteria: 'BRAND', value: 'Brand A', name: 'Old', description: null, destinationUri: 'https://example.com/a', imageUrl: null }]]), more: false }]])
    expect(catalogCategoriesDraft([{ criteria: 'BRAND', value: 'Brand B', name: 'B' }], { catalogId: CATALOG, catalogName: null, byCriteria, use: use([]) })).toEqual({ refusal: expect.stringMatching(/needs destinationUrl the first time/) })
    const d = draft(catalogCategoriesDraft([{ criteria: 'BRAND', value: 'Brand A', name: 'New', destinationUrl: '' }, { criteria: 'BRAND', value: 'Brand B', name: 'B', destinationUrl: 'https://example.com/b' }], { catalogId: CATALOG, catalogName: null, byCriteria, use: use([]) }))
    expect(JSON.parse(d.requests[0].params.data)).toEqual([
      { categorization_criteria: 'BRAND', criteria_value: 'Brand A', name: 'New', destination_uri: '' },
      { categorization_criteria: 'BRAND', criteria_value: 'Brand B', name: 'B', destination_uri: 'https://example.com/b' },
    ])
    expect(d.warnings.join(' ')).toMatch(/Meta cannot delete a category.*Not among the catalog's top 1,000 categories Meta lists now: BRAND "Brand B"/)
    expect((d.before as { noUndo?: string[] }).noUndo).toEqual([expect.stringMatching(/"Brand B" had no name before/)])
  })
  it('pixels: only the chosen ad account\'s are connected; a disconnect warns about retargeting and names the ad sets', () => {
    const live = { catalogId: CATALOG, catalogName: 'Catalog A', sources: new Map([[PIXEL, { id: PIXEL, name: 'Pixel A', sourceType: 'PIXEL' }]]), sourcesMore: false, pixels: new Map([[PIXEL, 'Pixel A']]), use: use([adSet('120000000000002', 'ACTIVE', `catalog ${CATALOG}`)]) }
    expect(eventSourcesDraft('connect', ['120000000000059'], live)).toEqual({ refusal: expect.stringMatching(/only pixels of the chosen ad account/) })
    expect(draft(eventSourcesDraft('connect', [PIXEL], live)).requests).toEqual([])
    const connect = draft(eventSourcesDraft('connect', [PIXEL], { ...live, sources: new Map() }))
    expect(connect.spendsMoney).toEqual([expect.stringMatching(/1 campaign, ad set or ad delivering now \(ad set 120000000000002\) uses catalog/)])
    expect(connect.requests[0].raisesSpend).toBe(true)
    expect(draft(eventSourcesDraft('connect', [PIXEL], { ...live, sources: new Map(), use: use([]) })).spendsMoney).toEqual([])
    const d = draft(eventSourcesDraft('disconnect', [PIXEL, '120000000000059'], live))
    expect(d.requests[0]).toMatchObject({ method: 'DELETE', params: { external_event_sources: `["${PIXEL}"]` } })
    expect(d.skipped).toEqual(['120000000000059 is not connected to this catalog: nothing to disconnect.'])
    expect(d.warnings.join(' ')).toMatch(/breaks retargeting catalog ads.*120000000000002.*LIVE-PROBES CA34-02/)
  })
})

describe('set-meta-catalog-access', () => {
  const people = new Map([['100000000000009', { id: '100000000000009', name: 'Nexus', userType: 'system_user', tasks: ['MANAGE'] }]])
  it('a person: of the portfolio only; never Nexus\'s own system user off; tasks sent sorted, the earlier ones kept', () => {
    const base = { catalogId: CATALOG, catalogName: null, people, nexusSystemUserId: '100000000000009' }
    expect(personAccessDraft('remove', { userId: '100000000000009' }, { ...base, who: null })).toEqual({ refusal: expect.stringMatching(/Nexus's own system user/) })
    // Review A2 — ANY change of Nexus's own system user is refused (an assign with fewer tasks too); unknown = refused.
    expect(personAccessDraft('assign', { userId: '100000000000009', tasks: ['ADVERTISE'] }, { ...base, who: { name: 'Nexus', kind: 'system user' } })).toEqual({ refusal: expect.stringMatching(/never changes its own access/) })
    expect(personAccessDraft('assign', { userId: '100000000000001', tasks: ['ADVERTISE'] }, { ...base, who: { name: 'Person A', kind: 'person' }, nexusSystemUserId: null })).toEqual({ refusal: expect.stringMatching(/could not read which system user it is/) })
    expect(personAccessDraft('remove', { userId: '100000000000002' }, { ...base, who: null })).toEqual({ refusal: expect.stringMatching(/not assigned/) })
    expect(personAccessDraft('assign', { userId: '100000000000002', tasks: ['ADVERTISE'] }, { ...base, who: null })).toEqual({ refusal: expect.stringMatching(/not a person or system user of the chosen business portfolio/) })
    const d = draft(personAccessDraft('assign', { userId: '100000000000001', tasks: ['MANAGE', 'ADVERTISE'] }, { ...base, who: { name: 'Person A', kind: 'person' } }))
    expect(d.requests[0]).toMatchObject({ edge: 'assigned_users', params: { user: '100000000000001', tasks: '["ADVERTISE","MANAGE"]' } })
    expect(d.before).toMatchObject({ op: 'assign', assigned: false, tasks: null })
  })
  it('a partner: never its own portfolio or another Nexus business\'s; collab terms and UTM only for a segment; tasks always sent', () => {
    const base = { catalogId: CATALOG, catalogName: null, isSegment: false, portfolioId: BUSINESS, agencies: new Map(), agenciesMore: false, partnerTaken: false }
    expect(partnerAccessDraft('share', { businessId: BUSINESS, permittedTasks: ['ADVERTISE'] }, base)).toEqual({ refusal: expect.stringMatching(/own business portfolio/) })
    expect(partnerAccessDraft('share', { businessId: '120000000000091', permittedTasks: ['ADVERTISE'] }, { ...base, partnerTaken: true })).toEqual({ refusal: expect.stringMatching(/used by another business in Nexus/) })
    expect(partnerAccessDraft('share', { businessId: '120000000000091', permittedTasks: ['ADVERTISE'], collabTerms: ['ENFORCE_CREATE_NEW_AD_ACCOUNT'] }, base)).toEqual({ refusal: expect.stringMatching(/only with the share of a catalog segment/) })
    expect(partnerAccessDraft('unshare', { businessId: '120000000000091' }, base)).toEqual({ refusal: expect.stringMatching(/not shared/) })
    const d = draft(partnerAccessDraft('share', { businessId: '120000000000091', permittedTasks: ['ADVERTISE'], utm: { campaign_source: 'fb' } }, { ...base, isSegment: true }))
    expect(d.requests[0].params).toEqual({ business: '120000000000091', permitted_tasks: '["ADVERTISE"]', utm_settings: '{"campaign_source":"fb"}' })
    expect(d.warnings.join(' ')).toMatch(/LIVE-PROBES CA34-03/)
  })
})

describe('set-meta-product-set', () => {
  it('create: the count, "matches every item", an empty set STOPS ads (never "nothing changes")', () => {
    const empty = setCreateDraft({ name: 'Set A', filter: '{"brand":{"eq":"Shop B"}}' }, { catalogId: CATALOG, catalogName: null, count: { matching: 0, itemsNow: null, catalogItems: 10 }, usesInternalLabel: true })
    expect(empty.warnings.join(' ')).toMatch(/EMPTY.*stop delivering.*internal_label.*10803/)
    expect(empty.requests[0]).toMatchObject({ edge: 'product_sets', params: { name: 'Set A', filter: '{"brand":{"eq":"Shop B"}}' } })
    const every = setCreateDraft({ name: 'All', filter: '{}' }, { catalogId: CATALOG, catalogName: null, count: { matching: 10, itemsNow: null, catalogItems: 10 }, usesInternalLabel: false })
    expect(every.warnings.join(' ')).toMatch(/matches every item of the catalog \(10\)/)
    expect(setCreateDraft({ name: 'X', filter: '{"brand":{"eq":"A"}}' }, { catalogId: CATALOG, catalogName: null, count: null, usesInternalLabel: false }).warnings.join(' ')).toMatch(/could not count/)
  })
  it('change: items before → after, the live ads named; shops as a list; the record keeps the earlier name, filter and id', () => {
    const d = setChangeDraft({ name: 'Set B', filter: '{"brand":{"eq":"Shop B"}}', shops: [{ shop_id: '120000000000140', ordering_index: 0 }] }, { set, count: { matching: 5, itemsNow: 12, catalogItems: 40 }, use: use([adSet('120000000000002', 'ACTIVE')]), usesInternalLabel: false })
    expect(d.requests[0]).toMatchObject({ objectKind: 'productset', objectId: SET, params: { name: 'Set B', filter: '{"brand":{"eq":"Shop B"}}', publish_to_shops: '[{"shop_id":"120000000000140","ordering_index":0}]' } })
    expect(d.changes['Items in the set']).toEqual({ from: 12, to: 5 })
    expect(d.warnings.join(' ')).toMatch(/changes what every live catalog ad on this set shows.*1 delivering now/)
    expect(d.before).toEqual({ op: 'change', catalogId: CATALOG, productSetId: SET, set: { name: 'Set A', filter: '{"brand":{"eq":"Shop A"}}', retailerId: null }, noUndo: [expect.stringMatching(/cannot read which shops/)] })
    expect(setChangeDraft({ name: 'Set A' }, { set, count: null, use: use([]), usesInternalLabel: false }).requests).toEqual([])
  })
  it('a filter that grows a set a delivering ad set uses is SPENDS MONEY (an empty set that fills restarts its ads); a shrink is not', () => {
    const active = [adSet('120000000000002', 'ACTIVE')]
    const empty = setChangeDraft({ filter: '{"brand":{"eq":"Shop B"}}' }, { set: { ...set, productCount: 0 }, count: { matching: 5, itemsNow: 0, catalogItems: 40 }, use: use(active), usesInternalLabel: false })
    expect(empty.spendsMoney).toEqual([expect.stringMatching(/from 0 to 5 items, the empty set fills and its ads start delivering again/)])
    expect(empty.requests[0].raisesSpend).toBe(true)
    expect(setChangeDraft({ filter: '{"brand":{"eq":"Shop B"}}' }, { set, count: null, use: use(active), usesInternalLabel: false }).spendsMoney).toEqual([expect.stringMatching(/could not count/)])
    expect(setChangeDraft({ filter: '{"brand":{"eq":"Shop B"}}' }, { set, count: { matching: 3, itemsNow: 12, catalogItems: 40 }, use: use(active), usesInternalLabel: false }).spendsMoney).toEqual([])
    expect(setChangeDraft({ filter: '{"brand":{"eq":"Shop B"}}' }, { set, count: { matching: 30, itemsNow: 12, catalogItems: 40 }, use: use([adSet('120000000000003', 'PAUSED')]), usesInternalLabel: false }).spendsMoney).toEqual([])
    expect(setChangeDraft({ name: 'Set Z' }, { set, count: null, use: use(active), usesInternalLabel: false }).spendsMoney).toEqual([])
  })
  it('review B1 — a campaign or an ad (its creative) that names the set counts; what Nexus could not see counts as spending, in words', () => {
    const grow = { matching: 30, itemsNow: 12, catalogItems: 40 }
    const byAd = setChangeDraft({ filter: '{"brand":{"eq":"Shop B"}}' }, { set, count: grow, use: use([adSet('120000000000020', 'ACTIVE', `product set ${SET}`, 'ad')]), usesInternalLabel: false })
    expect(byAd.spendsMoney).toEqual([expect.stringMatching(/delivering now \(ad 120000000000020\) uses this set: from 12 to 30 items/)])
    const byCampaign = setChangeDraft({ filter: '{"brand":{"eq":"Shop B"}}' }, { set, count: grow, use: use([adSet('120000000000010', 'ACTIVE', `product set ${SET}`, 'campaign')]), usesInternalLabel: false })
    expect(byCampaign.spendsMoney).toEqual([expect.stringMatching(/campaign 120000000000010/)])
    const unseen = setChangeDraft({ filter: '{"brand":{"eq":"Shop B"}}' }, { set, count: grow, use: use([], ['more than 500 ads of the ad account (Nexus read the first 500)']), usesInternalLabel: false })
    expect(unseen.spendsMoney).toEqual([expect.stringMatching(/Nexus could not see everything that may deliver on this set.*Not seen by Nexus, so counted as spending: more than 500 ads/)])
    expect(unseen.requests[0].raisesSpend).toBe(true)
    expect(unseen.warnings.join(' ')).toMatch(/Nexus could not see everything: more than 500 ads/)
    // Review N1 — custom or dynamic audiences Nexus does not trace: SPENDS MONEY with that sentence.
    const audiences = setChangeDraft({ filter: '{"brand":{"eq":"Shop B"}}' }, { set, count: grow, use: use([], [AUDIENCES_UNSEEN]), usesInternalLabel: false })
    expect(audiences.spendsMoney).toEqual([expect.stringMatching(/counted as spending: ad sets of the ad account delivering now use custom or dynamic audiences/)])
  })
  it('review A1 — the spend premise is in stands: what delivers now and whether Nexus saw everything (a paused preview does not stand for an active run)', () => {
    const paused = setChangeDraft({ filter: '{"brand":{"eq":"Shop B"}}' }, { set, count: { matching: 30, itemsNow: 12, catalogItems: 40 }, use: use([adSet('120000000000002', 'PAUSED')]), usesInternalLabel: false })
    const active = setChangeDraft({ filter: '{"brand":{"eq":"Shop B"}}' }, { set, count: { matching: 30, itemsNow: 12, catalogItems: 40 }, use: use([adSet('120000000000002', 'ACTIVE')]), usesInternalLabel: false })
    expect(paused.stands).toMatchObject({ uses: { delivering: [], unseen: false }, grows: true })
    expect(active.stands).toMatchObject({ uses: { delivering: ['adset:120000000000002'], unseen: false } })
    expect(JSON.stringify(paused.stands)).not.toBe(JSON.stringify(active.stands))
    const live = { catalogId: CATALOG, catalogName: null, sources: new Map(), sourcesMore: false, pixels: new Map([[PIXEL, 'Pixel A']]), use: use([], ['the ad account\'s ads (Meta refused)']) }
    expect(draft(eventSourcesDraft('connect', [PIXEL], live)).stands).toMatchObject({ uses: { delivering: [], unseen: true } })
    expect(draft(eventSourcesDraft('connect', [PIXEL], live)).spendsMoney).toEqual([expect.stringMatching(/counted as spending: the ad account's ads/)])
  })
  it('review A5 — a default / fallback image and a category\'s first landing page spend when something delivers from the catalog', () => {
    const now = { catalogId: CATALOG, name: 'Catalog A', defaultImageUrl: null, fallbackImageUrls: [], displaySettings: null, productCount: 3 }
    const delivering = use([adSet('120000000000002', 'ACTIVE', `catalog ${CATALOG}`)])
    expect(catalogSettingsDraft({ defaultImageUrl: 'https://example.com/d.jpg' }, now, delivering).spendsMoney).toEqual([expect.stringMatching(/items without a usable image/)])
    expect(catalogSettingsDraft({ defaultImageUrl: 'https://example.com/d.jpg' }, now, use([])).spendsMoney).toEqual([])
    expect(catalogSettingsDraft({ name: 'Catalog B' }, now, delivering).spendsMoney).toEqual([])
    expect(catalogSettingsDraft({ defaultImageUrl: 'https://example.com/d.jpg' }, now, delivering).stands).toMatchObject({ uses: { delivering: ['adset:120000000000002'] } })
    const byCriteria = new Map([['BRAND', { byValue: new Map(), more: false }]])
    const first = draft(catalogCategoriesDraft([{ criteria: 'BRAND', value: 'Brand B', name: 'B', destinationUrl: 'https://example.com/b' }], { catalogId: CATALOG, catalogName: null, byCriteria, use: delivering }))
    expect(first.spendsMoney).toEqual([expect.stringMatching(/BRAND "Brand B" starts showing in its category ads/)])
    expect(first.stands).toMatchObject({ uses: { delivering: ['adset:120000000000002'] } })
  })
  it('a filter that names a price is shown without its amounts', () => {
    expect(filterInWords('{"price_amount":{"gte":4990}}')).toMatch(/names a price/)
    expect(filterInWords('{"price_amount":{"gte":4990}}')).not.toMatch(/4990/)
    expect(filterInWords('')).toBe('every item of the catalog')
    expect(filterInWords('{"brand":{"eq":"Shop A"}}')).toBe('brand is "Shop A"')
  })
})
