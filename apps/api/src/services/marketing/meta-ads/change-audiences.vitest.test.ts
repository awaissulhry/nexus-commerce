/**
 * Meta step 31 — the audience drafts on their own (pure): each kind of new audience is built from its own arguments
 * only, with Meta's limits per event source; a lookalike's size and source in one spelling; a change says what can let
 * active ads spend more, merges the account's URL tags and keeps an undo only where Meta can be put back; the people
 * drafts cap a change at 100,000; a share skips what is so already; a delete takes at most 10 audiences. Made-up ids.
 */
import { describe, expect, it } from 'vitest'
import { createAudienceDraft, membersDraft, removeDraft, setAudienceDraft, shareDraft, type AudienceCreateLive } from './change-audiences.js'
import type { AudienceDetail, AudienceUse } from './live-audience-change.js'
import { sha256Hex } from './audience-members.js'

const TERMS = { signed: true, signLink: 'https://business.facebook.com/ads/manage/customaudiences/tos/?act=1234567890', existingCustomers: [], existingProblem: null }
const LIVE: AudienceCreateLive = { adAccountId: '1234567890', terms: TERMS, sameName: { ids: [], checked: true }, seed: null, pageId: '120000000000080', idProblems: [] }
const A: AudienceDetail = {
  id: '120000000000040', name: 'List A', subtype: 'CUSTOM', description: null, rule: null, lookalikeSpec: null, lookalikeIds: [], optOutLink: null,
  customerFileSource: 'USER_PROVIDED_ONLY', retentionDays: 30, isValueBased: false, labels: null, operationCode: 200, flagged: false, flaggedFields: [], deliveryCode: 200,
}
const NO_USE: AudienceUse = { ads: [], activeAds: 0, otherAccounts: [], more: false }
const ACTIVE: AudienceUse = { ads: [{ adId: '120000000000003', name: 'Ad A', adSetId: '120000000000002', campaignId: '120000000000001', effectiveStatus: 'ACTIVE' }], activeAds: 1, otherAccounts: [], more: false }
const ok = <T>(d: T | { refusal: string }): T => { if (d && typeof d === 'object' && 'refusal' in d) throw new Error(d.refusal); return d as T }
const pageRule = (type: string, days: number) => ({ inclusions: { operator: 'or' as const, rules: [{ event_sources: [{ id: '120000000000081', type: type as 'lead' }], retention_seconds: days * 86400 }] } })

describe('createAudienceDraft', () => {
  it('engagement: each source\'s own longest retention (lead forms 90 days, a Page 730)', () => {
    expect(createAudienceDraft({ kind: 'engagement', name: 'Leads A', rule: pageRule('lead', 120) }, LIVE)).toEqual({ refusal: expect.stringMatching(/at most 90 days/) })
    expect(ok(createAudienceDraft({ kind: 'engagement', name: 'Leads A', rule: pageRule('lead', 90) }, LIVE)).requests).toHaveLength(1)
    expect(ok(createAudienceDraft({ kind: 'engagement', name: 'Fans A', rule: pageRule('page', 730) }, LIVE)).requests[0].params).toMatchObject({ name: 'Fans A' })
    expect(createAudienceDraft({ kind: 'offline', name: 'Shop A', rule: pageRule('page', 30) }, LIVE)).toEqual({ refusal: expect.stringMatching(/offline_events only/) })
  })
  it('video and catalog: their own shapes, sent as Meta documents', () => {
    const video = ok(createAudienceDraft({ kind: 'video', name: 'Viewers A', video: { videoIds: ['120000000000090', '120000000000091'], event: 'video_completed' } }, LIVE))
    expect(video.requests[0].params).toEqual({ name: 'Viewers A', subtype: 'ENGAGEMENT', rule: '[{"object_id":"120000000000090","event_name":"video_completed"},{"object_id":"120000000000091","event_name":"video_completed"}]' })
    const catalog = ok(createAudienceDraft({ kind: 'catalog', name: 'Carts A', catalog: { productSetId: '120000000000061', include: [{ event: 'AddToCart', days: 7 }], exclude: [{ event: 'Purchase', days: 7 }], pixelId: '120000000000050' } }, LIVE))
    expect(catalog.requests[0]).toMatchObject({ edge: 'product_audiences', objectId: 'act_1234567890', params: {
      product_set_id: '120000000000061', inclusions: '[{"retention_seconds":604800,"rule":{"event":{"eq":"AddToCart"}}}]',
      exclusions: '[{"retention_seconds":604800,"rule":{"event":{"eq":"Purchase"}}}]', event_sources: '[{"id":"120000000000050","type":"PIXEL"}]',
    } })
  })
  it('a lookalike: one source, one size; overlapping tiers and a value seed without custom_ratio refused', () => {
    const seed = { ...A, isValueBased: true }
    expect(createAudienceDraft({ kind: 'lookalike', name: 'L', lookalike: { seedAudienceId: A.id, type: 'similarity' } }, { ...LIVE, seed })).toEqual({ refusal: expect.stringMatching(/custom_ratio/) })
    const tiers = ok(createAudienceDraft({ kind: 'lookalike', name: 'L', lookalike: { seedAudienceId: A.id, tiers: [{ fromPercent: 0, toPercent: 1 }] } }, { ...LIVE, seed }))
    expect(JSON.parse(tiers.requests[0].params.lookalike_spec)).toEqual({ type: 'custom_ratio', ratio: 0.01 })
    const value = ok(createAudienceDraft({ kind: 'lookalike', name: 'L', lookalike: { seedAudienceId: A.id, type: 'custom_ratio', percent: 2 } }, { ...LIVE, seed }))
    expect(JSON.parse(value.requests[0].params.lookalike_spec)).toEqual({ type: 'custom_ratio', ratio: 0.02 })
    expect(createAudienceDraft({ kind: 'lookalike', name: 'L', lookalike: { seedAudienceId: A.id, tiers: [{ fromPercent: 0, toPercent: 3 }, { fromPercent: 2, toPercent: 5 }] } }, { ...LIVE, seed: A })).toEqual({ refusal: expect.stringMatching(/do not overlap/) })
    expect(createAudienceDraft({ kind: 'lookalike', name: 'L', lookalike: { seedAudienceId: A.id, type: 'reach', percent: 3 } }, { ...LIVE, seed: A })).toEqual({ refusal: expect.stringMatching(/ONE size/) })
    const converters = ok(createAudienceDraft({ kind: 'lookalike', name: 'L', lookalike: { campaignIds: ['120000000000001'], adSetIds: ['120000000000002'], percent: 5 } }, LIVE))
    expect(JSON.parse(converters.requests[0].params.lookalike_spec)).toEqual({ ratio: 0.05, origin_ids: ['120000000000001', '120000000000002'], conversion_type: 'campaign_conversions' })
    expect(converters.requests[0].params.origin_audience_id).toBeUndefined()
  })
  it('a same-name audience is said; nothing spends; the after record names what it will make', () => {
    const d = ok(createAudienceDraft({ kind: 'customer_list', name: 'List A' }, { ...LIVE, sameName: { ids: ['120000000000045'], checked: true } }))
    expect(d.warnings.join(' ')).toMatch(/named so exists already \(120000000000045\)/)
    expect(d.spendsMoney).toEqual([])
    expect(d.after).toEqual({ created: [{ audienceId: null, name: 'List A', kind: 'customer_list' }] })
  })
})

describe('setAudienceDraft', () => {
  const live = (over: Partial<Parameters<typeof setAudienceDraft>[1]> = {}) => ({ adAccountId: '1234567890', audience: A, use: NO_USE, terms: null, tags: null, idProblems: [], ...over })
  it('labels added say what value rules can do; labels on a lookalike refused; an old empty list has no undo', () => {
    const d = ok(setAudienceDraft({ audienceId: A.id, labels: ['HIGH_VALUE_CUSTOMERS'] }, live()))
    expect(d.spendsMoney[0]).toMatch(/value rule that raises bids/)
    expect((d.before as { noUndo: string[] }).noUndo.join(' ')).toMatch(/no labels/)
    expect(setAudienceDraft({ audienceId: A.id, labels: ['AT_RISK'] }, live({ audience: { ...A, subtype: 'LOOKALIKE' } }))).toEqual({ refusal: expect.stringMatching(/labels on customer lists, website and app audiences only/) })
  })
  it('a longer retention of a list active ads use spends; a shorter one does not; the SDK-only field is said', () => {
    const longer = ok(setAudienceDraft({ audienceId: A.id, retentionDays: 90 }, live({ use: ACTIVE })))
    expect(longer.spendsMoney[0]).toMatch(/keeping people longer/)
    expect(longer.warnings.join(' ')).toMatch(/SDK only/)
    expect(longer.requests[0]).toMatchObject({ expect: { retention_days: '90' }, readBackFields: 'id,retention_days', raisesSpend: true })
    expect(ok(setAudienceDraft({ audienceId: A.id, retentionDays: 10 }, live({ use: ACTIVE }))).spendsMoney).toEqual([])
  })
  it('a lookalike\'s size: its old size is the undo; a bigger one in use spends', () => {
    const look = { ...A, subtype: 'LOOKALIKE', lookalikeSpec: { ratio: 0.01, type: 'custom_ratio' } }
    const d = ok(setAudienceDraft({ audienceId: A.id, lookalike: { percent: 3 } }, live({ audience: look, use: ACTIVE })))
    expect(d.requests[0].params).toEqual({ lookalike_spec: '{"ratio":0.03}' })
    expect(d.requests[0].expect).toEqual({ id: A.id })
    expect(d.spendsMoney[0]).toMatch(/bigger lookalike/)
    expect((d.before as { undo: unknown }).undo).toEqual({ audienceId: A.id, lookalike: { type: 'custom_ratio', percent: 1 } })
  })
  it('the URL tags keep the tag not named; nothing to change is said', () => {
    const d = ok(setAudienceDraft({ audienceTypeTags: { paramName: 'audience_type', newCustomerTag: 'prospecting' } }, live({ audience: null, tags: { audience_type_param_name: 'audience_type', existing_customer_tag: 'retargeting' } })))
    expect(d.requests[0].params).toEqual({ custom_audience_info: '{"audience_type_param_name":"audience_type","new_customer_tag":"prospecting","existing_customer_tag":"retargeting"}' })
    expect(setAudienceDraft({ audienceId: A.id, name: 'List A' }, live())).toEqual({ refusal: expect.stringMatching(/already named so/) })
    expect(setAudienceDraft({}, live())).toEqual({ refusal: expect.stringMatching(/Nothing to change/) })
  })
})

describe('membersDraft', () => {
  it('more than 100,000 people is asked in parts; a list being replaced or flagged is refused', () => {
    const people = { hashes: Array.from({ length: 100_001 }, (_, i) => sha256Hex(String(i))), skipped: 0, fingerprint: 'x' }
    expect(membersDraft({ mode: 'opt_out_everywhere' }, { adAccountId: '1234567890', terms: TERMS, audience: null, use: null, people })).toEqual({ refusal: expect.stringMatching(/in parts/) })
    const one = { hashes: [sha256Hex('a@example.com')], skipped: 0, fingerprint: 'x' }
    expect(membersDraft({ mode: 'remove', audienceId: A.id }, { adAccountId: '1234567890', terms: TERMS, audience: { ...A, operationCode: 414 }, use: NO_USE, people: one })).toEqual({ refusal: expect.stringMatching(/being replaced/) })
    expect(membersDraft({ mode: 'remove', audienceId: A.id }, { adAccountId: '1234567890', terms: TERMS, audience: { ...A, flagged: true }, use: NO_USE, people: one })).toEqual({ refusal: expect.stringMatching(/1713230/) })
    const d = ok(membersDraft({ mode: 'remove', audienceId: A.id }, { adAccountId: '1234567890', terms: TERMS, audience: A, use: ACTIVE, people: one }))
    expect(d.warnings.join(' ')).toMatch(/restarts the learning phase/)
    expect(JSON.stringify({ ...d, requests: d.requests.map((r) => r.label) })).not.toContain(one.hashes[0])
  })
})

describe('shareDraft and removeDraft', () => {
  it('an unshare of an account it is not shared with is skipped; permissions go with a share only', () => {
    const live = { audience: A, sharing: { accounts: ['1234567891'], problem: null }, use: NO_USE, idProblems: [] }
    expect(shareDraft({ audienceId: A.id, action: 'unshare', adAccountIds: ['1234567899'] }, live)).toEqual({ refusal: expect.stringMatching(/is not shared with ad account 1234567899/) })
    expect(shareDraft({ audienceId: A.id, action: 'unshare', adAccountIds: ['1234567891'], permissions: 'targeting' }, live)).toEqual({ refusal: expect.stringMatching(/go with a share/) })
    expect(ok(shareDraft({ audienceId: A.id, action: 'unshare', adAccountIds: ['1234567891'] }, live)).requests[0]).toMatchObject({ method: 'DELETE', edge: 'ad_accounts', params: { adaccounts: '["1234567891"]' } })
  })
  it('at most 10 audiences in one delete, lookalikes counted', () => {
    const audiences = Array.from({ length: 11 }, (_, i) => ({ audience: { ...A, id: String(120000000000100 + i) }, use: NO_USE, lookalikes: [] }))
    expect(removeDraft({ audienceIds: audiences.map((a) => a.audience.id) }, { audiences })).toEqual({ refusal: expect.stringMatching(/at most 10/) })
  })
})
