/**
 * Meta step 22 — remove-meta-ads-items as a draft (pure): every ad set and ad that goes with a campaign or ad set listed;
 * what delivers now said; an ad set's share of a campaign budget said to move; what Meta refuses refused in words (a
 * sequenced ad set's ad, a dynamic creative ad, a creative or image still used); already deleted skipped; a child of a
 * parent deleted in the same change not sent twice; the order and the `needs` of each request; no money, no undo. Made-up ids.
 */
import { describe, expect, it } from 'vitest'
import { MAX_LIBRARY_ITEMS, metaRemoveDraft, type RemoveItem, type RemoveLive } from './change-remove.js'
import type { RemoveObject } from './live-remove.js'
import type { MetaChangeDraft } from './change-draft.js'

const C = '120000000000001'
const S1 = '120000000000002'
const S2 = '120000000000012'
const A1 = '120000000000003'
const A2 = '120000000000013'
const CR = '120000000000040'
const HASH = '0d500843a1d4699a0b41e99f4137a5c3'
const VIDEO = '120000000000060'
const PART = '120000000000070'

const object = (o: Partial<RemoveObject> & Pick<RemoveObject, 'kind' | 'id'>): RemoveObject => ({
  name: null, status: 'PAUSED', effectiveStatus: 'PAUSED', campaignId: null, adSetId: null, creativeId: null, undeletable: null, children: [], childrenMore: false, campaignBudget: null, ...o,
})
const live = (o: Partial<RemoveLive> = {}): RemoveLive => ({
  adAccountId: '1234567890', objects: new Map(), creatives: new Map(), adsByCreative: null, images: new Map(), imageCreatives: new Map(), library: null, captions: new Map(), page: null, problems: [], ...o,
})
const objects = (...list: RemoveObject[]) => new Map(list.map((x) => [`${x.kind}:${x.id}`, x]))
const draft = (items: RemoveItem[], l: RemoveLive) => metaRemoveDraft({ items }, l) as MetaChangeDraft
const refusal = (items: RemoveItem[], l: RemoveLive) => (metaRemoveDraft({ items }, l) as { refusal: string }).refusal

const CAMPAIGN = object({
  kind: 'campaign', id: C, name: 'Campaign A', status: 'ACTIVE', effectiveStatus: 'ACTIVE',
  children: [
    { kind: 'adset', id: S1, name: 'Ad set B', status: 'ACTIVE', effectiveStatus: 'ACTIVE', creativeId: null },
    { kind: 'adset', id: S2, name: 'Ad set old', status: 'ARCHIVED', effectiveStatus: 'ARCHIVED', creativeId: null },
    { kind: 'ad', id: A1, name: 'Ad 1', status: 'ACTIVE', effectiveStatus: 'ACTIVE', creativeId: CR },
    { kind: 'ad', id: A2, name: 'Ad 2', status: 'ARCHIVED', effectiveStatus: 'ARCHIVED', creativeId: null },
  ],
})

describe('campaigns, ad sets and ads', () => {
  it('a campaign: one DELETE, every ad set and ad that goes with it listed (archived too), what delivers now said', () => {
    const d = draft([{ kind: 'campaign', id: C }], live({ objects: objects(CAMPAIGN) }))
    expect(d.requests).toEqual([expect.objectContaining({ step: 1, kind: 'campaign', objectId: C, params: {}, method: 'DELETE', check: 'none', raisesSpend: false, undoable: false, operation: 'campaign.delete' })])
    expect(d.requests[0].label).toBe(`Delete campaign "Campaign A" (${C}) with its 2 ad sets and 2 ads`)
    expect(d.alsoDeleted).toEqual([{ deleting: `campaign "Campaign A" (${C})`, adSets: [expect.objectContaining({ id: S1 }), expect.objectContaining({ id: S2, status: 'ARCHIVED' })], ads: [expect.objectContaining({ id: A1 }), expect.objectContaining({ id: A2, status: 'ARCHIVED' })] }])
    expect(d.warnings.join(' ')).toMatch(/Stops delivering at once: campaign "Campaign A" \(120000000000001\) \(it delivers now\) and 2 ad sets and ads under it that deliver now/)
    expect(d.warnings[0]).toMatch(/^DELETING IS FINAL — there is no undo: .*only its name can still be changed\. Its details and numbers stay readable by its own id/)
    expect(d.warnings[0]).toMatch(/A deleted ad may still record results up to 28 days after its last delivery/)
    expect(d.warnings[0]).toMatch(/lower its bids \(set-meta-ad-set\) or pause it \(set-meta-status\); archive only what is meant for good/)
    expect(d.spendsMoney).toEqual([])
    expect(d.totals).toMatchObject({ requests: 1, campaigns: 1, adSetsThatGoWithThem: 2, adsThatGoWithThem: 2 })
    expect(d.summary).toMatch(/delete 1 campaign for good \(with 2 ad sets and 2 ads under them\) — asked explicitly; no undo/)
  })
  it('an ad set or ad whose campaign or ad set is deleted in the same change goes with it (said, not sent twice)', () => {
    const set = object({ kind: 'adset', id: S1, campaignId: C, children: [{ kind: 'ad', id: A1, name: null, status: 'PAUSED', effectiveStatus: 'PAUSED', creativeId: null }] })
    const ad = object({ kind: 'ad', id: A1, campaignId: C, adSetId: S1 })
    const d = draft([{ kind: 'ad', id: A1 }, { kind: 'adset', id: S1 }, { kind: 'campaign', id: C }], live({ objects: objects(CAMPAIGN, set, ad) }))
    expect(d.requests.map((r) => r.objectId)).toEqual([C])
    expect(d.skipped).toEqual([`Ad set (${S1}) goes with its campaign (${C}), deleted in this change.`, `Ad (${A1}) goes with its campaign (${C}), deleted in this change.`])
    const only = draft([{ kind: 'ad', id: A1 }, { kind: 'adset', id: S1 }], live({ objects: objects(set, ad) }))
    expect(only.requests.map((r) => r.objectId)).toEqual([S1])
    expect(only.skipped[0]).toMatch(/goes with its ad set/)
  })
  it('the order: ads, then ad sets, then campaigns', () => {
    const other = object({ kind: 'campaign', id: '120000000000101' })
    const set = object({ kind: 'adset', id: '120000000000102', campaignId: '120000000000199' })
    const ad = object({ kind: 'ad', id: '120000000000103', campaignId: '120000000000198', adSetId: '120000000000197' })
    const d = draft([{ kind: 'campaign', id: other.id }, { kind: 'adset', id: set.id }, { kind: 'ad', id: ad.id }], live({ objects: objects(other, set, ad) }))
    expect(d.requests.map((r) => [r.step, r.kind])).toEqual([[1, 'ad'], [2, 'adset'], [3, 'campaign']])
  })
  it('already deleted: skipped; nothing left: no request', () => {
    const d = draft([{ kind: 'campaign', id: C }], live({ objects: objects({ ...CAMPAIGN, status: 'DELETED', children: [] }) }))
    expect(d.requests).toEqual([])
    expect(d.skipped).toEqual([`Campaign "Campaign A" (${C}) is deleted already.`])
  })
  it('Meta refuses an ad of a sequenced ad set and a dynamic creative ad alone: the whole change is refused in words', () => {
    const seq = object({ kind: 'ad', id: A1, adSetId: S1, campaignId: C, undeletable: 'Meta refuses to delete an ad of an ad set that shows its ads in a sequence.' })
    const fine = object({ kind: 'ad', id: A2, adSetId: S2, campaignId: '120000000000199' })
    expect(refusal([{ kind: 'ad', id: A1 }, { kind: 'ad', id: A2 }], live({ objects: objects(seq, fine) }))).toMatch(/^Nothing is deleted: Ad \(120000000000003\): Meta refuses to delete an ad of an ad set that shows its ads in a sequence/)
    // Named with its ad set, the ad goes with it: no refusal.
    const set = object({ kind: 'adset', id: S1, campaignId: C, children: [{ kind: 'ad', id: A1, name: null, status: 'PAUSED', effectiveStatus: 'PAUSED', creativeId: null }] })
    expect(draft([{ kind: 'ad', id: A1 }, { kind: 'adset', id: S1 }], live({ objects: objects(seq, set) })).requests.map((r) => r.objectId)).toEqual([S1])
  })
  it('more under a campaign than Nexus lists at once: refused (every child is listed before a delete)', () => {
    expect(refusal([{ kind: 'campaign', id: C }], live({ objects: objects({ ...CAMPAIGN, childrenMore: true }) }))).toMatch(/more ad sets or ads than Nexus lists at once/)
  })
  it('an ad set under a campaign budget: its share moves to the other ad sets, the total stays; the last one: nothing to deliver', () => {
    const set = object({ kind: 'adset', id: S1, campaignId: C, campaignBudget: { campaignId: C, name: 'Campaign A', otherAdSets: [{ id: S2, effectiveStatus: 'ACTIVE' }, { id: '120000000000022', effectiveStatus: 'PAUSED' }], more: false } })
    expect(draft([{ kind: 'adset', id: S1 }], live({ objects: objects(set) })).warnings.join(' ')).toMatch(/Meta spreads that budget over the campaign's 2 ad sets that stay \(1 delivers now\) — the campaign's total budget stays the same, its share moves to them/)
    const last = object({ ...set, campaignBudget: { ...set.campaignBudget!, otherAdSets: [] } })
    expect(draft([{ kind: 'adset', id: S1 }], live({ objects: objects(last) })).warnings.join(' ')).toMatch(/is the last ad set of its campaign .*after this change the campaign has no ad set left to deliver/)
  })
  it('review A4 — ad sets of one campaign budget deleted together: the share moves only to the ad sets that stay; the last ones say so', () => {
    const budget = (others: string[]) => ({ campaignId: C, name: 'Campaign A', otherAdSets: others.map((id) => ({ id, effectiveStatus: 'ACTIVE' })), more: false })
    const one = object({ kind: 'adset', id: S1, campaignId: C, campaignBudget: budget([S2, '120000000000022']) })
    const two = object({ kind: 'adset', id: S2, campaignId: C, campaignBudget: budget([S1, '120000000000022']) })
    const d = draft([{ kind: 'adset', id: S1 }, { kind: 'adset', id: S2 }], live({ objects: objects(one, two) }))
    expect(d.warnings.filter((w) => /campaign's budget/.test(w))).toEqual([
      expect.stringMatching(/over the campaign's 1 ad set that stays \(1 delivers now\) \(1 other ad set of it goes in this change too\)/),
      expect.stringMatching(/over the campaign's 1 ad set that stays/),
    ])
    const three = object({ kind: 'adset', id: '120000000000022', campaignId: C, campaignBudget: budget([S1, S2]) })
    const all = draft([{ kind: 'adset', id: S1 }, { kind: 'adset', id: S2 }, { kind: 'adset', id: three.id }], live({ objects: objects({ ...one, campaignBudget: budget([S2, three.id]) }, { ...two, campaignBudget: budget([S1, three.id]) }, three) }))
    const lastWords = all.warnings.filter((w) => /no ad set left to deliver/.test(w))
    expect(lastWords).toHaveLength(3)
    expect(lastWords[0]).toMatch(/and the other ad sets this change deletes are the last of its campaign .*after this change the campaign has no ad set left to deliver/)
  })
  it('review B6 — a legacy Advantage+ shopping or app campaign: Meta\'s v26 block of edits is said (whether a delete counts is Meta\'s answer)', () => {
    const legacy = draft([{ kind: 'campaign', id: C }], live({ objects: objects({ ...CAMPAIGN, legacy: 'AUTOMATED_SHOPPING_ADS' }) }))
    expect(legacy.warnings.join(' ')).toMatch(/legacy Advantage\+ shopping campaign \(AUTOMATED_SHOPPING_ADS\): Meta blocks edits of these through its API in v26; whether a delete counts as one is not documented — Meta's answer will say/)
    expect(draft([{ kind: 'campaign', id: C }], live({ objects: objects(CAMPAIGN) })).warnings.join(' ')).not.toMatch(/legacy/)
  })
  it('read problems refuse the whole change', () => {
    expect(refusal([{ kind: 'campaign', id: C }], live({ problems: ['campaign 120000000000001 is not of the Meta ad account this business chose: Nexus deletes nothing in another account.'] }))).toMatch(/^Nothing is deleted: campaign 120000000000001 is not of the Meta ad account/)
  })
})

describe('creatives and images', () => {
  const creative = { id: CR, name: 'Creative C', status: 'ACTIVE', objectType: 'SHARE' }
  it('a creative an ad uses that this change does not delete: refused; with that ad deleted first: needs its step', () => {
    const users = { byCreative: new Map([[CR, [{ id: A1, name: 'Ad 1', effectiveStatus: 'PAUSED' }]]]), byVideo: null, more: false }
    expect(refusal([{ kind: 'creative', id: CR }], live({ creatives: new Map([[CR, creative]]), adsByCreative: users }))).toMatch(/Creative "Creative C" \(120000000000040\) is used by 1 ad this change does not delete \(120000000000003 PAUSED\)/)
    const ad = object({ kind: 'ad', id: A1, creativeId: CR, adSetId: S1, campaignId: C })
    const d = draft([{ kind: 'creative', id: CR }, { kind: 'ad', id: A1 }], live({ objects: objects(ad), creatives: new Map([[CR, creative]]), adsByCreative: users }))
    expect(d.requests.map((r) => [r.step, r.operation, r.objectKind ?? null, r.needs ?? null])).toEqual([[1, 'ad.delete', null, null], [2, 'creative.delete', 'creative', [1]]])
    expect(d.requests[1]).toMatchObject({ objectId: CR, params: {}, method: 'DELETE' })
  })
  it('an ad that goes with a campaign deleted here frees its creative (needs the campaign\'s step)', () => {
    const users = { byCreative: new Map([[CR, [{ id: A1, name: 'Ad 1', effectiveStatus: 'ACTIVE' }]]]), byVideo: null, more: false }
    const d = draft([{ kind: 'creative', id: CR }, { kind: 'campaign', id: C }], live({ objects: objects(CAMPAIGN), creatives: new Map([[CR, creative]]), adsByCreative: users }))
    expect(d.requests.map((r) => [r.step, r.operation, r.needs ?? null])).toEqual([[1, 'campaign.delete', null], [2, 'creative.delete', [1]]])
  })
  it('more ads than Nexus looks at: a creative is refused (it cannot confirm no ad uses it); a deleted creative is skipped', () => {
    expect(refusal([{ kind: 'creative', id: CR }], live({ creatives: new Map([[CR, creative]]), adsByCreative: { byCreative: new Map(), byVideo: null, more: true } }))).toMatch(/more than 500 ads/)
    expect(draft([{ kind: 'creative', id: CR }], live({ creatives: new Map([[CR, { ...creative, status: 'DELETED' }]]) })).skipped).toEqual([`Creative "Creative C" (${CR}) is deleted already.`])
  })
  it('an image: out of the chosen account\'s library by its hash; refused while a creative uses it; a deleted creative is no user', () => {
    const image = { hash: HASH, name: 'photo.jpg', status: 'ACTIVE', creatives: ['120000000000041'] }
    expect(refusal([{ kind: 'image', hash: HASH }], live({ images: new Map([[HASH, image]]), imageCreatives: new Map([['120000000000041', { status: 'ACTIVE', ours: true }]]) })))
      .toMatch(/Image "photo.jpg" \(0d500843a1d4699a0b41e99f4137a5c3\) is used by 1 creative this change does not delete \(120000000000041\)/)
    expect(refusal([{ kind: 'image', hash: HASH }], live({ images: new Map([[HASH, image]]), imageCreatives: new Map([['120000000000041', null]]) }))).toMatch(/could not read some of them/)
    const d = draft([{ kind: 'image', hash: HASH }], live({ images: new Map([[HASH, image]]), imageCreatives: new Map([['120000000000041', { status: 'DELETED', ours: true }]]) }))
    expect(d.requests).toEqual([expect.objectContaining({ objectId: 'act_1234567890', objectKind: 'adaccount', edge: 'adimages', params: { hash: HASH }, method: 'DELETE', operation: 'image.delete' })])
  })
  it('an image whose creative is deleted in the same change: after it (needs); an image not in the library: skipped', () => {
    const image = { hash: HASH, name: null, status: 'ACTIVE', creatives: [CR] }
    const d = draft([{ kind: 'image', hash: HASH }, { kind: 'creative', id: CR }], live({ images: new Map([[HASH, image]]), creatives: new Map([[CR, creative]]), adsByCreative: { byCreative: new Map(), byVideo: null, more: false } }))
    expect(d.requests.map((r) => [r.step, r.operation, r.needs ?? null])).toEqual([[1, 'creative.delete', null], [2, 'image.delete', [1]]])
    expect(draft([{ kind: 'image', hash: HASH }], live()).skipped).toEqual([`Image ${HASH} is not in the chosen ad account's library (deleted already, or never there): nothing to delete.`])
  })
})

describe('videos, captions, Instant Experience parts', () => {
  const noAds = { byCreative: new Map(), byVideo: new Map(), more: false }
  it('a video of the library no ad shows: removed (Meta\'s silence about a creative with no ad said); not there: skipped; past 500: refused', () => {
    const d = draft([{ kind: 'video', id: VIDEO }], live({ library: { has: new Set([VIDEO]), more: false }, adsByCreative: noAds }))
    expect(d.requests).toEqual([expect.objectContaining({ objectId: 'act_1234567890', edge: 'advideos', params: { video_id: VIDEO }, method: 'DELETE', operation: 'video.remove' })])
    expect(d.warnings.join(' ')).toMatch(/Nexus checked the account's ads .*no ad left after this change names it\. A creative no ad uses may still name it; Meta does not say whether it then refuses — its answer decides/)
    expect(d.warnings.join(' ')).not.toMatch(/cannot tell which creatives use/)
    expect(draft([{ kind: 'video', id: VIDEO }], live({ library: { has: new Set(), more: false }, adsByCreative: noAds })).skipped[0]).toMatch(/not in the chosen ad account's library/)
    expect(refusal([{ kind: 'video', id: VIDEO }], live({ library: { has: new Set(), more: true }, adsByCreative: noAds }))).toMatch(/not among the first 500 videos/)
  })
  it('review B1 — a video an ad shows that this change does not delete: refused; with that ad deleted first: after it (needs)', () => {
    const shows = { byCreative: new Map(), byVideo: new Map([[VIDEO, [{ id: A1, name: 'Ad 1', effectiveStatus: 'ACTIVE' }]]]), more: false }
    expect(refusal([{ kind: 'video', id: VIDEO }], live({ library: { has: new Set([VIDEO]), more: false }, adsByCreative: shows })))
      .toMatch(/Video 120000000000060 is named by the creative of 1 ad this change does not delete \(120000000000003 ACTIVE\): an ad on, paused or archived still names it \(Meta may refuse, or the ad may break\), so Nexus removes it only when those ads are deleted in the same request/)
    const ad = object({ kind: 'ad', id: A1, adSetId: S1, campaignId: C })
    const d = draft([{ kind: 'video', id: VIDEO }, { kind: 'ad', id: A1 }], live({ objects: objects(ad), library: { has: new Set([VIDEO]), more: false }, adsByCreative: shows }))
    expect(d.requests.map((r) => [r.step, r.operation, r.needs ?? null])).toEqual([[1, 'ad.delete', null], [2, 'video.remove', [1]]])
    expect(refusal([{ kind: 'video', id: VIDEO }], live({ library: { has: new Set([VIDEO]), more: false }, adsByCreative: { ...noAds, more: true } }))).toMatch(/more than 500 ads, so Nexus cannot confirm no other ad shows it/)
    expect(refusal([{ kind: 'video', id: VIDEO }], live({ library: { has: new Set([VIDEO]), more: false } }))).toMatch(/could not read which ads show video/)
  })
  it('caption languages: only the ones the video has, as one POST of locales_to_delete; before the video leaves the library', () => {
    const d = draft([{ kind: 'video', id: VIDEO }, { kind: 'captions', id: VIDEO, locales: ['en_US', 'de_DE'] }], live({ library: { has: new Set([VIDEO]), more: false }, captions: new Map([[VIDEO, { locales: ['en_US', 'it_IT'] }]]), adsByCreative: noAds }))
    expect(d.requests.map((r) => [r.step, r.operation])).toEqual([[1, 'captions.delete'], [2, 'video.remove']])
    expect(d.requests[0]).toMatchObject({ objectId: VIDEO, objectKind: 'video', edge: 'captions', params: { locales_to_delete: '["en_US"]' } })
    expect(d.requests[0].method).toBeUndefined()
    expect(d.skipped).toEqual([`Video ${VIDEO} has no de_DE captions: nothing to delete.`])
    expect(refusal([{ kind: 'captions', id: VIDEO, locales: ['en_US'] }], live({ library: { has: new Set(), more: false } }))).toMatch(/is not in the video library of the chosen ad account/)
    expect(d.warnings.join(' ')).toMatch(/No ad of the account shows video 120000000000060\./)
  })
  it('review B1 — deleting caption languages names the ads that show the video (they change at once)', () => {
    const shows = { byCreative: new Map(), byVideo: new Map([[VIDEO, [{ id: A1, name: 'Ad 1', effectiveStatus: 'ACTIVE' }, { id: A2, name: null, effectiveStatus: 'PAUSED' }]]]), more: false }
    const d = draft([{ kind: 'captions', id: VIDEO, locales: ['en_US'] }], live({ library: { has: new Set([VIDEO]), more: false }, captions: new Map([[VIDEO, { locales: ['en_US'] }]]), adsByCreative: shows }))
    expect(d.requests.map((r) => r.operation)).toEqual(['captions.delete'])
    expect(d.warnings.join(' ')).toMatch(/Deleting the en_US captions changes at once the 2 ads that show video 120000000000060 \(120000000000003 ACTIVE, 120000000000013 PAUSED\)\./)
  })
  it('an Instant Experience part of the chosen Page; none chosen: refused', () => {
    const d = draft([{ kind: 'canvaselement', id: PART }], live({ page: { pageId: '120000000000080', has: new Set([PART]), more: false } }))
    expect(d.requests).toEqual([expect.objectContaining({ objectId: PART, objectKind: 'canvaselement', params: {}, method: 'DELETE', operation: 'canvaselement.delete' })])
    expect(d.warnings.join(' ')).toMatch(/pages_manage_ads permission \(with pages_read_engagement and pages_show_list\) and the Page's ADVERTISE task/)
    expect(refusal([{ kind: 'canvaselement', id: PART }], live())).toMatch(/no Facebook Page chosen/)
    expect(refusal([{ kind: 'canvaselement', id: PART }], live({ page: { unread: 'Meta answers this read only to the Page\'s own access token.' } }))).toMatch(/Page's own access token/)
  })
  it(`at most ${MAX_LIBRARY_ITEMS} images and videos in one request (the library takes one change every 30 s)`, () => {
    const items: RemoveItem[] = Array.from({ length: MAX_LIBRARY_ITEMS + 1 }, (_, i) => ({ kind: 'image', hash: `abc${i}` }))
    expect(refusal(items, live())).toMatch(/At most 10 images and videos in one request: Nexus sends each .*its own pacing/)
  })
  it('every kind in its order; the same item asked twice is one', () => {
    const ad = object({ kind: 'ad', id: A1, adSetId: S1, campaignId: C })
    const d = draft([
      { kind: 'canvaselement', id: PART }, { kind: 'video', id: VIDEO }, { kind: 'captions', id: VIDEO, locales: ['en_US'] }, { kind: 'image', hash: HASH },
      { kind: 'creative', id: CR }, { kind: 'ad', id: A1 }, { kind: 'ad', id: A1 },
    ], live({
      objects: objects(ad), creatives: new Map([[CR, { id: CR, name: null, status: 'ACTIVE', objectType: 'SHARE' }]]), adsByCreative: { byCreative: new Map(), byVideo: new Map(), more: false },
      images: new Map([[HASH, { hash: HASH, name: null, status: 'ACTIVE', creatives: [] }]]), library: { has: new Set([VIDEO]), more: false },
      captions: new Map([[VIDEO, { locales: ['en_US'] }]]), page: { pageId: '120000000000080', has: new Set([PART]), more: false },
    }))
    expect(d.requests.map((r) => r.operation)).toEqual(['ad.delete', 'creative.delete', 'image.delete', 'captions.delete', 'video.remove', 'canvaselement.delete'])
    expect(d.before).toEqual({ op: 'remove', items: [
      expect.objectContaining({ kind: 'ad', id: A1 }), expect.objectContaining({ kind: 'creative', id: CR }), expect.objectContaining({ kind: 'image', id: HASH }),
      { kind: 'captions', id: VIDEO, locales: ['en_US'] }, { kind: 'video', id: VIDEO }, { kind: 'canvaselement', id: PART },
    ] })
    expect(d.warnings.join(' ')).toMatch(/The 2 images and videos go out of the ad account's library one every 30 s — Nexus's own pacing \(Meta documents one edit per object every 30 s; whether the library counts as one object is not verified\)/)
  })
})
