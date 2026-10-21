/**
 * Meta step 39 — set-meta-brand-safety as a draft: an ad set's brand-safety keys changed inside its WHOLE live targeting
 * (every other key as Meta has it); never a level looser than the ad account's own; stricter = no spend, looser on an ad
 * set that is on = SPENDS MONEY (nothing spends yet while its campaign is off); a targeting change warns of Meta's review;
 * the account's own filter: documented levels only, looser = SPENDS MONEY while a campaign delivers; undo puts each key
 * back. Made-up ids.
 */
import { describe, expect, it } from 'vitest'
import { accountSafetyDraft, adSetJudge, adSetSafetyDraft, applyLevels, brandSafetyUndoArgs, looserLevel, safetyOf } from './change-brand-safety.js'
import type { AdSetSafetyState } from './live-brand-safety.js'
import type { MetaChangeDraft } from './change-draft.js'

const TARGETING = { geo_locations: { countries: ['IT'] }, age_min: 18, brand_safety_content_filter_levels: ['FACEBOOK_STANDARD', 'FEED_STANDARD'], excluded_publisher_categories: ['dating'] }
const AD_SET: AdSetSafetyState = { id: '120000000000002', name: 'Ad set B', status: 'ACTIVE', campaign: { id: '120000000000001', name: 'Campaign A', status: 'ACTIVE' }, targeting: TARGETING }
const live = (state: Partial<AdSetSafetyState> = {}, accountLevels: string[] = []) => ({ adSets: new Map([[AD_SET.id, { ...AD_SET, ...state }]]), accountLevels })
const draftOf = (d: MetaChangeDraft | { refusal: string }) => { if ('refusal' in d) throw new Error(d.refusal); return d }

describe('levels', () => {
  it('a placement named is replaced in place, NONE drops it, a new one is added; the rest stays', () => {
    expect(applyLevels(['FACEBOOK_STANDARD', 'FEED_STANDARD'], { feed: 'LIMITED' })).toEqual(['FACEBOOK_STANDARD', 'FEED_STRICT'])
    expect(applyLevels(['FACEBOOK_STANDARD', 'FEED_STANDARD'], { inContent: 'NONE', audienceNetwork: 'EXPANDED' })).toEqual(['FEED_STANDARD', 'AN_RELAXED'])
  })
  it('looser: by Meta\'s order, Meta\'s undocumented default read as possibly looser, the account\'s own level merged in', () => {
    expect(looserLevel('STRICT', 'STANDARD', null)).toBe(true)
    expect(looserLevel('STANDARD', 'STRICT', null)).toBe(false)
    expect(looserLevel(null, 'RELAXED', null)).toBe(true)
    expect(looserLevel(null, 'STRICT', null)).toBe(false)
    expect(looserLevel('RELAXED', null, null)).toBe(false)
    expect(looserLevel('STANDARD', null, null)).toBe(true)
    // With the account at STRICT, the effective level stays STRICT whatever the ad set says.
    expect(looserLevel('STANDARD', 'RELAXED', 'STRICT')).toBe(false)
    expect(looserLevel('STRICT', null, 'STANDARD')).toBe(true)
  })
})

describe('an ad set', () => {
  it('stricter: the whole live spec with only the brand-safety keys changed, no spend, Meta\'s review said, Meta has no check', () => {
    const d = draftOf(adSetSafetyDraft([{ adSetId: AD_SET.id, filterLevels: { feed: 'LIMITED' }, addCategories: ['gambling'], addBlockLists: ['120000000000601'] }], live()))
    expect(d.requests).toHaveLength(1)
    const r = d.requests[0]
    expect(r).toMatchObject({ objectKind: 'adsettargeting', objectId: AD_SET.id, check: 'none', raisesSpend: false, operation: 'adset.brandSafety', readBackFields: 'id,targeting', undoable: true })
    expect(JSON.parse(r.params.targeting)).toEqual({ ...TARGETING, brand_safety_content_filter_levels: ['FACEBOOK_STANDARD', 'FEED_STRICT'], excluded_publisher_categories: ['dating', 'gambling'], excluded_publisher_list_ids: ['120000000000601'] })
    expect(Object.keys(r.params)).toEqual(['targeting'])
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings.join(' ')).toMatch(/back to its review/)
    expect(d.changes['ad set "Ad set B" (120000000000002): excluded_publisher_categories']).toEqual({ from: ['dating'], to: ['dating', 'gambling'] })
    expect(d.before).toEqual({ adSets: [{ id: AD_SET.id, name: 'Ad set B', safety: safetyOf(TARGETING) }] })
    expect((d.after as { adSets: Array<{ safety: Record<string, string[]> }> }).adSets[0].safety.excluded_publisher_list_ids).toEqual(['120000000000601'])
  })
  it('looser on an ad set that is on = SPENDS MONEY (raises spend); with its campaign off, nothing spends yet; on a paused ad set, a warning', () => {
    const on = draftOf(adSetSafetyDraft([{ adSetId: AD_SET.id, filterLevels: { feed: 'EXPANDED' }, removeCategories: ['dating'] }], live()))
    expect(on.spendsMoney[0]).toMatch(/is on: the feeds inventory filter from Moderate to Expanded; no longer excluding dating can widen where its ads show/)
    expect(on.requests[0].raisesSpend).toBe(true)
    const off = draftOf(adSetSafetyDraft([{ adSetId: AD_SET.id, removeCategories: ['dating'] }], live({ campaign: { id: '120000000000001', name: 'Campaign A', status: 'PAUSED' } })))
    expect(off.spendsMoney[0]).toMatch(/nothing spends yet, its campaign "Campaign A" \(120000000000001\) is not on/)
    const paused = draftOf(adSetSafetyDraft([{ adSetId: AD_SET.id, removeCategories: ['dating'] }], live({ status: 'PAUSED' })))
    expect(paused.spendsMoney).toEqual([])
    expect(paused.requests[0].raisesSpend).toBe(false)
    expect(paused.warnings.join(' ')).toMatch(/is not on: no longer excluding dating widens where its ads can show once it is switched on/)
  })
  it('a level dropped, or the undocumented severity levels changed, may widen delivery: SPENDS MONEY, and the values are Meta\'s to judge', () => {
    const dropped = draftOf(adSetSafetyDraft([{ adSetId: AD_SET.id, filterLevels: { inContent: 'NONE' } }], live()))
    expect(dropped.spendsMoney[0]).toMatch(/in-content .* from Moderate to none set \(Meta's default\)/)
    expect(JSON.parse(dropped.requests[0].params.targeting).brand_safety_content_filter_levels).toEqual(['FEED_STANDARD'])
    const severity = draftOf(adSetSafetyDraft([{ adSetId: AD_SET.id, severityLevels: ['LEVEL_ONE'], addContentTypes: ['LIVE_GAMING'] }], live()))
    expect(severity.spendsMoney[0]).toMatch(/content severity levels \(Meta does not document their values/)
    expect(severity.warnings.join(' ')).toMatch(/Meta documents no values for content severity levels, and only one example for excluded content types \(INSTREAM_LIVE/)
    const cleared = draftOf(adSetSafetyDraft([{ adSetId: AD_SET.id, removeCategories: ['dating'] }], live({ status: 'PAUSED' })))
    expect(JSON.parse(cleared.requests[0].params.targeting)).not.toHaveProperty('excluded_publisher_categories')
  })
  it('refused in words: looser than the account\'s own level, nothing to change, an ad set twice, added and removed, too large, unread', () => {
    expect(adSetSafetyDraft([{ adSetId: AD_SET.id, filterLevels: { feed: 'EXPANDED' } }], live({}, ['FEED_STANDARD']))).toEqual({ refusal: expect.stringMatching(/feeds level Expanded is looser than the ad account's own \(Moderate\)/) })
    expect(draftOf(adSetSafetyDraft([{ adSetId: AD_SET.id, filterLevels: { feed: 'LIMITED' } }], live({}, ['FEED_STANDARD']))).requests).toHaveLength(1)
    expect(adSetSafetyDraft([{ adSetId: AD_SET.id, addCategories: ['dating'] }], live())).toEqual({ refusal: expect.stringMatching(/^Nothing to change: .* already has these brand-safety settings/) })
    expect(adSetSafetyDraft([{ adSetId: AD_SET.id, addCategories: ['gambling'] }, { adSetId: AD_SET.id, addCategories: ['dating'] }], live())).toEqual({ refusal: expect.stringMatching(/named twice/) })
    expect(adSetSafetyDraft([{ adSetId: AD_SET.id, addCategories: ['gambling'], removeCategories: ['gambling'] }], live())).toEqual({ refusal: expect.stringMatching(/both added and removed/) })
    expect(adSetSafetyDraft([{ adSetId: AD_SET.id }], live())).toEqual({ refusal: expect.stringMatching(/Say what to change/) })
    const huge = { ...TARGETING, zips: Array.from({ length: 15000 }, (_, i) => ({ key: `IT:${10000 + i}` })) }
    expect(adSetSafetyDraft([{ adSetId: AD_SET.id, addCategories: ['gambling'] }], live({ targeting: huge }))).toEqual({ refusal: expect.stringMatching(/too large for one Nexus change/) })
    expect(adSetSafetyDraft([{ adSetId: '120000000000009', addCategories: ['gambling'] }], live())).toEqual({ refusal: expect.stringMatching(/could not read ad set 120000000000009/) })
    // A value Meta wrote that Nexus does not send, kept in a key the change sets: refused here, not at the run.
    expect(adSetSafetyDraft([{ adSetId: AD_SET.id, filterLevels: { inContent: 'LIMITED' } }], live({ targeting: { ...TARGETING, brand_safety_content_filter_levels: ['FEED_SELECT'] } }))).toEqual({ refusal: expect.stringMatching(/Meta's own value there is one Nexus does not send/) })
    // An undocumented account value for that placement: Meta judges it (said, not refused).
    expect(draftOf(adSetSafetyDraft([{ adSetId: AD_SET.id, filterLevels: { feed: 'LIMITED' } }], live({}, ['FEED_SELECT']))).warnings.join(' ')).toMatch(/reads FEED_SELECT/)
  })
  it('review A4, A8, B7 — a changed key Meta holds as anything but names, a placement Meta set to an undocumented level: refused; list caps said', () => {
    expect(adSetSafetyDraft([{ adSetId: AD_SET.id, addCategories: ['gambling'] }], live({ targeting: { ...TARGETING, excluded_publisher_categories: ['dating', 7] } }))).toEqual({ refusal: expect.stringMatching(/holds its excluded_publisher_categories as \["dating",7\], not a list of names/) })
    // Untouched, the same value goes back as Meta has it.
    expect(draftOf(adSetSafetyDraft([{ adSetId: AD_SET.id, addBlockLists: ['120000000000601'] }], live({ targeting: { ...TARGETING, excluded_publisher_categories: [{ id: 1 }] } }))).requests).toHaveLength(1)
    expect(adSetSafetyDraft([{ adSetId: AD_SET.id, filterLevels: { feed: 'LIMITED' } }], live({ targeting: { ...TARGETING, brand_safety_content_filter_levels: ['FEED_SELECT'] } }))).toEqual({ refusal: expect.stringMatching(/reads FEED_SELECT, a value Meta does not document, so Nexus does not change it/) })
    expect(accountSafetyDraft({ feed: 'LIMITED' }, { adAccountId: '1234567890', accountLevels: ['FEED_DNM'], delivering: true })).toEqual({ refusal: expect.stringMatching(/reads FEED_DNM, a value Meta does not document/) })
    const caps = draftOf(adSetSafetyDraft([{ adSetId: AD_SET.id, addBlockLists: ['120000000000601'] }], live()))
    expect(caps.warnings.join(' ')).toMatch(/1,000 publishers in in-stream videos and on Reels, 12,500 on Audience Network .* 3,400 in Audience Network rewarded videos/)
    expect(draftOf(adSetSafetyDraft([{ adSetId: AD_SET.id, addCategories: ['gambling'] }], live())).warnings.join(' ')).not.toMatch(/12,500/)
  })
  it('review A5 — the record holds every list in one order, whatever order Meta answers', () => {
    const d = draftOf(adSetSafetyDraft([{ adSetId: AD_SET.id, addCategories: ['gambling'] }], live({ targeting: { ...TARGETING, brand_safety_content_filter_levels: ['FEED_STANDARD', 'FACEBOOK_STANDARD'], excluded_publisher_categories: ['mature_audiences', 'dating'] } })))
    expect((d.before as { adSets: Array<{ safety: Record<string, string[]> }> }).adSets[0].safety).toMatchObject({ brand_safety_content_filter_levels: ['FACEBOOK_STANDARD', 'FEED_STANDARD'], excluded_publisher_categories: ['dating', 'mature_audiences'] })
    expect((d.after as { adSets: Array<{ safety: Record<string, string[]> }> }).adSets[0].safety.excluded_publisher_categories).toEqual(['dating', 'gambling', 'mature_audiences'])
    expect(draftOf(accountSafetyDraft({ audienceNetwork: 'LIMITED' }, { adAccountId: '1234567890', accountLevels: ['FEED_STANDARD'], delivering: true })).after).toEqual({ account: { levels: ['AN_STRICT', 'FEED_STANDARD'] } })
  })
  it('the read-back judge: the keys it set, as Meta reads them (order aside)', () => {
    const judge = adSetJudge({ excluded_publisher_categories: ['dating', 'gambling'] })
    expect(judge({ targeting: { excluded_publisher_categories: ['gambling', 'dating'] } })).toEqual({ moved: [], reads: 'excluded_publisher_categories [gambling, dating]' })
    expect(judge({ targeting: { excluded_publisher_categories: ['dating'] } }).moved).toEqual(['excluded_publisher_categories'])
    expect(judge({}).moved).toEqual(['excluded_publisher_categories'])
  })
})

describe('the ad account\'s own filter (AA-060)', () => {
  const base = { adAccountId: '1234567890', accountLevels: ['FEED_STANDARD'], delivering: true }
  it('stricter: one request on act_<id>, read back from the account; Meta documents it only in its SDK (said)', () => {
    const d = draftOf(accountSafetyDraft({ feed: 'LIMITED', inContent: 'LIMITED' }, base))
    expect(d.requests[0]).toMatchObject({ objectKind: 'adaccount', objectId: 'act_1234567890', edge: 'brand_safety_content_filter_levels', params: { brand_safety_content_filter_levels: '["FEED_STRICT","FACEBOOK_STRICT"]' }, readBackOf: 'act_1234567890', readBackFields: 'id,brand_safety_content_filter_levels', check: 'none' })
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings.join(' ')).toMatch(/every campaign and ad set of the account/)
    expect(d.warnings.join(' ')).toMatch(/only in its own SDK/)
  })
  it('looser = SPENDS MONEY while a campaign delivers (a new level other than LIMITED too: Meta\'s default is undocumented); nothing spends with none delivering', () => {
    expect(draftOf(accountSafetyDraft({ inContent: 'MODERATE' }, base)).spendsMoney[0]).toMatch(/in-content .* from none set \(Meta's default\) to Moderate/)
    expect(draftOf(accountSafetyDraft({ feed: 'EXPANDED' }, base)).spendsMoney[0]).toMatch(/widens where EVERY campaign's ads can show — campaigns of this account deliver now/)
    const idle = draftOf(accountSafetyDraft({ feed: 'EXPANDED' }, { ...base, delivering: false }))
    expect(idle.spendsMoney).toEqual([])
    expect(idle.warnings.join(' ')).toMatch(/spends nothing yet/)
  })
  it('refused: clearing (no API for it), an undocumented value it would have to send back, nothing to change', () => {
    expect(accountSafetyDraft({ feed: 'NONE' }, base)).toEqual({ refusal: expect.stringMatching(/no way to clear/) })
    expect(accountSafetyDraft({ inContent: 'LIMITED' }, { ...base, accountLevels: ['FEED_SELECT'] })).toEqual({ refusal: expect.stringMatching(/also reads FEED_SELECT/) })
    expect(accountSafetyDraft({ feed: 'MODERATE' }, base)).toEqual({ refusal: expect.stringMatching(/already reads/) })
  })
})

describe('undo', () => {
  it('an ad set: each key back as it was (a level dropped comes back, a level added goes to NONE)', () => {
    const d = draftOf(adSetSafetyDraft([{ adSetId: AD_SET.id, filterLevels: { feed: 'LIMITED', audienceNetwork: 'MODERATE' }, addCategories: ['gambling'], removeCategories: ['dating'], severityLevels: ['LEVEL_ONE'] }], live()))
    expect(brandSafetyUndoArgs(d.before as never, d.after as never)).toEqual({
      adSets: [{ adSetId: AD_SET.id, filterLevels: { audienceNetwork: 'NONE', feed: 'MODERATE' }, addCategories: ['dating'], removeCategories: ['gambling'], severityLevels: [] }],
    })
  })
  it('the account: its old levels; a placement it had none for cannot be cleared by API', () => {
    expect(brandSafetyUndoArgs({ account: { levels: ['FEED_STANDARD'] } }, { account: { levels: ['FEED_STRICT'] } })).toEqual({ account: { filterLevels: { feed: 'MODERATE' } } })
    expect(brandSafetyUndoArgs({ account: { levels: [] } }, { account: { levels: ['FEED_STRICT'] } })).toEqual({ refusal: expect.stringMatching(/no way to clear one by API/) })
  })
})
