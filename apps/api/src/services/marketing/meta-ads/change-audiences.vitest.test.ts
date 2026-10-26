/**
 * Meta step 31 — the audience drafts on their own (pure): each kind of new audience is built from its own arguments
 * only, with Meta's limits per event source; a lookalike's size and source in one spelling; a change says what can let
 * active ads spend more, merges the account's URL tags and keeps an undo only where Meta can be put back; the people
 * drafts cap a change at 100,000; a share skips what is so already; a delete takes at most 10 audiences. Made-up ids.
 */
import { describe, expect, it } from 'vitest'
import { createAudienceDraft, membersDraft, removeDraft, setAudienceDraft, shareDraft, type AudienceCreateLive, type AudienceMembersLive } from './change-audiences.js'
import type { AudienceDetail, AudienceUse } from './live-audience-change.js'
import { NO_CONSENT, sha256Hex } from './audience-members.js'

const TERMS = { signed: true, signLink: 'https://business.facebook.com/ads/manage/customaudiences/tos/?act=1234567890', existingCustomers: [], existingProblem: null }
const LIVE: AudienceCreateLive = { adAccountId: '1234567890', uploadsOn: false, terms: TERMS, sameName: { ids: [], checked: true }, seed: null, pageId: '120000000000080', idProblems: [] }
const A: AudienceDetail = {
  id: '120000000000040', name: 'List A', subtype: 'CUSTOM', description: null, rule: null, lookalikeSpec: null, lookalikeIds: [], optOutLink: null,
  customerFileSource: 'USER_PROVIDED_ONLY', retentionDays: 30, isValueBased: false, labels: null, operationCode: 200, flagged: false, flaggedFields: [], deliveryCode: 200,
}
const NO_USE: AudienceUse = { ads: [], activeAds: 0, otherAccounts: [], more: false }
const ACTIVE: AudienceUse = { ads: [{ adId: '120000000000003', name: 'Ad A', adSetId: '120000000000002', campaignId: '120000000000001', effectiveStatus: 'ACTIVE' }], activeAds: 1, otherAccounts: [], more: false }
/** What the kit's plan hash reads of each request (meta-ads-kit.ts planOf: planParams instead of params when given). */
const planned = (d: { requests: Array<{ objectId: string; params: Record<string, string>; planParams?: Record<string, string>; method?: string; edge?: string; objectKind?: string }> }) =>
  JSON.stringify(d.requests.map((r) => ({ objectId: r.objectId, params: r.planParams ?? r.params, method: r.method, edge: r.edge, objectKind: r.objectKind })))
const ok = <T>(d: T | { refusal: string }): T => { if (d && typeof d === 'object' && 'refusal' in d) throw new Error(d.refusal); return d as T }
const FILTER = { operator: 'and', filters: [{ field: 'event', operator: 'eq', value: 'lead_generation_submitted' }] }
const pageRule = (type: string, days: number) => ({ inclusions: { operator: 'or' as const, rules: [{ event_sources: [{ id: '120000000000081', type: type as 'lead' }], retention_seconds: days * 86400, filter: FILTER }] } })

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
    // Review B3 — converters and Page fans take a percent or tiers, never a type alone.
    expect(createAudienceDraft({ kind: 'lookalike', name: 'L', lookalike: { campaignIds: ['120000000000001'], type: 'similarity' } }, LIVE)).toEqual({ refusal: expect.stringMatching(/takes a percent or tiers/) })
    expect(createAudienceDraft({ kind: 'lookalike', name: 'L', lookalike: { pageFans: true, type: 'reach' } }, LIVE)).toEqual({ refusal: expect.stringMatching(/takes a percent or tiers/) })
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
  it('review A2 — every size change of a list ads use spends, in either direction; unused, none does; the SDK-only field is said', () => {
    const longer = ok(setAudienceDraft({ audienceId: A.id, retentionDays: 90 }, live({ use: ACTIVE })))
    expect(longer.spendsMoney[0]).toMatch(/keeping people longer, 90 days changes who is in it — where an ad set targets it a bigger audience, where one excludes it a smaller one/)
    expect(longer.warnings.join(' ')).toMatch(/SDK only/)
    expect(longer.requests[0]).toMatchObject({ expect: { retention_days: '90' }, readBackFields: 'id,retention_days', raisesSpend: true })
    expect(ok(setAudienceDraft({ audienceId: A.id, retentionDays: 10 }, live({ use: ACTIVE }))).spendsMoney[0]).toMatch(/shorter, 10 days/)
    expect(ok(setAudienceDraft({ audienceId: A.id, retentionDays: 10 }, live())).spendsMoney).toEqual([])
    // Ads of an account it is shared with count too (another business's: always).
    const shared: AudienceUse = { ...NO_USE, otherAccounts: [{ adAccountId: '1234567891', ads: null, takenByAnotherBusiness: true }] }
    expect(ok(setAudienceDraft({ audienceId: A.id, retentionDays: 10 }, live({ use: shared }))).spendsMoney[0]).toMatch(/ads of 1 ad account it is shared with/)
    expect(ok(setAudienceDraft({ audienceId: A.id, productSetId: '120000000000061' }, live({ use: ACTIVE }))).spendsMoney[0]).toMatch(/another product set/)
    expect(ok(setAudienceDraft({ audienceId: A.id, allowedDomains: ['shop.example'] }, live({ use: ACTIVE }))).spendsMoney[0]).toMatch(/other allowed domains/)
  })
  it('review B5 — Meta\'s retention 0 is "for good": 0 → 30 is shorter, said so', () => {
    const d = ok(setAudienceDraft({ audienceId: A.id, retentionDays: 30 }, live({ audience: { ...A, retentionDays: 0 }, use: ACTIVE })))
    expect(d.changes).toEqual({ 'audience "List A" (120000000000040): kept (days)': { from: 'for good', to: 30 } })
    expect(d.spendsMoney[0]).toMatch(/not for good but 30 days/)
    expect((d.before as { noUndo: string[] }).noUndo.join(' ')).toMatch(/without an end/)
  })
  it('a lookalike\'s size: its old size is the undo; ANY size in use spends — {percent: 5} on a 3–5% lookalike widens it to 0–5%', () => {
    const look = { ...A, subtype: 'LOOKALIKE', lookalikeSpec: { ratio: 0.01, type: 'custom_ratio' } }
    const d = ok(setAudienceDraft({ audienceId: A.id, lookalike: { percent: 3 } }, live({ audience: look, use: ACTIVE })))
    expect(d.requests[0].params).toEqual({ lookalike_spec: '{"ratio":0.03}' })
    expect(d.requests[0].expect).toEqual({ id: A.id })
    expect(d.spendsMoney[0]).toMatch(/a new lookalike size changes who is in it/)
    expect((d.before as { undo: unknown }).undo).toEqual({ audienceId: A.id, lookalike: { type: 'custom_ratio', percent: 1 } })
    const tier = { ...A, subtype: 'LOOKALIKE', lookalikeSpec: { ratio: 0.05, starting_ratio: 0.03 } }
    const wide = ok(setAudienceDraft({ audienceId: A.id, lookalike: { percent: 5 } }, live({ audience: tier, use: ACTIVE })))
    expect(wide.spendsMoney).toHaveLength(1)
    expect(wide.warnings.join(' ')).toMatch(/3–5% becomes 0–5%/)
    expect((wide.before as { undo: unknown }).undo).toEqual({ audienceId: A.id, lookalike: { percent: 5, fromPercent: 3 } })
  })
  it('re-review N2 — what SPENDS MONEY rests on is in the basis: a shared account\'s ads, the ad sets reading the list', () => {
    const quiet = ok(setAudienceDraft({ audienceId: A.id, retentionDays: 10 }, live()))
    const shared = ok(setAudienceDraft({ audienceId: A.id, retentionDays: 10 }, live({ use: { ...NO_USE, otherAccounts: [{ adAccountId: '1234567891', ads: 3, takenByAnotherBusiness: false }] } })))
    expect([quiet.spendsMoney.length, shared.spendsMoney.length]).toEqual([0, 1])
    expect(JSON.stringify(shared.stands)).not.toBe(JSON.stringify(quiet.stands))
    const base = { audience: null, use: null, terms: { ...TERMS, existingCustomers: ['120000000000044'] } }
    const none = ok(setAudienceDraft({ existingCustomers: [A.id] }, live({ ...base, existingUsers: { adSets: [], problem: null } })))
    const read = ok(setAudienceDraft({ existingCustomers: [A.id] }, live({ ...base, existingUsers: { adSets: [{ id: '120000000000002', name: 'B', campaignId: null }], problem: null } })))
    expect([none.spendsMoney.length, read.spendsMoney.length]).toEqual([0, 1])
    expect(JSON.stringify(read.stands)).not.toBe(JSON.stringify(none.stands))
  })
  it('review A3 — a new existing-customer list that active ad sets read spends (they are listed); unread, it spends too', () => {
    const base = { audience: null, terms: { ...TERMS, existingCustomers: ['120000000000044'] } }
    const named = ok(setAudienceDraft({ existingCustomers: [A.id] }, live({ ...base, existingUsers: { adSets: [{ id: '120000000000002', name: 'Ad set B', campaignId: '120000000000001' }], problem: null } })))
    expect(named.spendsMoney[0]).toMatch(/1 active ad set read the existing-customer list .*"Ad set B" \(120000000000002, campaign 120000000000001\)/)
    expect(named.requests[0].raisesSpend).toBe(true)
    expect(ok(setAudienceDraft({ existingCustomers: [A.id] }, live({ ...base, existingUsers: { adSets: [], problem: 'Meta refused it' } }))).spendsMoney[0]).toMatch(/could not read which active ad sets/)
    expect(ok(setAudienceDraft({ existingCustomers: [A.id] }, live({ ...base, existingUsers: { adSets: [], problem: null } }))).spendsMoney).toEqual([])
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
    const people = { hashes: Array.from({ length: 100_001 }, (_, i) => sha256Hex(String(i))), skipped: 0 }
    expect(membersDraft({ mode: 'opt_out_everywhere' }, { adAccountId: '1234567890', uploadsOn: false, terms: TERMS, audience: null, use: null, people })).toEqual({ refusal: expect.stringMatching(/in parts/) })
    const one = { hashes: [sha256Hex('a@example.com')], skipped: 0 }
    expect(membersDraft({ mode: 'remove', audienceId: A.id }, { adAccountId: '1234567890', uploadsOn: false, terms: TERMS, audience: { ...A, operationCode: 414 }, use: NO_USE, people: one })).toEqual({ refusal: expect.stringMatching(/being replaced/) })
    expect(membersDraft({ mode: 'remove', audienceId: A.id }, { adAccountId: '1234567890', uploadsOn: false, terms: TERMS, audience: { ...A, flagged: true }, use: NO_USE, people: one })).toEqual({ refusal: expect.stringMatching(/1713230/) })
    const d = ok(membersDraft({ mode: 'remove', audienceId: A.id }, { adAccountId: '1234567890', uploadsOn: false, terms: TERMS, audience: A, use: ACTIVE, people: one }))
    expect(d.warnings.join(' ')).toMatch(/restarts the learning phase/)
    // Review A2 — people out of a list ads use, and every opt-out everywhere: the person's decision (SPENDS MONEY).
    expect(d.spendsMoney[0]).toMatch(/taking these people out changes who is in it/)
    expect(d.requests[0].raisesSpend).toBe(true)
    expect(ok(membersDraft({ mode: 'remove', audienceId: A.id }, { adAccountId: '1234567890', uploadsOn: false, terms: TERMS, audience: A, use: NO_USE, people: one })).spendsMoney).toEqual([])
    const all = ok(membersDraft({ mode: 'opt_out_everywhere' }, { adAccountId: '1234567890', uploadsOn: false, terms: TERMS, audience: null, use: null, people: one }))
    expect(all.spendsMoney[0]).toMatch(/EVERY customer list/)
    expect(all.requests.every((r) => r.raisesSpend === true && Object.keys(r.params).join() === 'payload')).toBe(true)
    expect(all.warnings.join(' ')).toMatch(/honoured everywhere/)
    expect(JSON.stringify(all.stands)).not.toContain(one.hashes[0])
    expect(JSON.stringify({ ...d, requests: d.requests.map((r) => r.label) })).not.toContain(one.hashes[0])
  })
})

describe('shareDraft and removeDraft', () => {
  it('review A1 — an audience shared with another business\'s account: a share refused, its unshare let through', () => {
    const taken = { audience: A, sharing: { accounts: ['1234567891'], problem: 'The audience is shared with an ad account another business in Nexus uses.' }, use: NO_USE, idProblems: [] }
    expect(shareDraft({ audienceId: A.id, action: 'share', adAccountIds: ['1234567892'] }, taken)).toEqual({ refusal: expect.stringMatching(/another business in Nexus uses/) })
    expect(ok(shareDraft({ audienceId: A.id, action: 'unshare', adAccountIds: ['1234567891'] }, taken)).requests).toHaveLength(1)
  })
  it('re-review N1 — who it is shared with could not be read: an unshare (and a share) says so, never "not shared"', () => {
    const unread = { audience: A, sharing: { accounts: null, problem: 'Nexus could not read who the audience is shared with (Meta refused), so it changes nothing of it.' }, use: NO_USE, idProblems: [] }
    expect(shareDraft({ audienceId: A.id, action: 'unshare', adAccountIds: ['1234567891'] }, unread)).toEqual({ refusal: expect.stringMatching(/could not read who the audience is shared with/) })
    expect(shareDraft({ audienceId: A.id, action: 'share', adAccountIds: ['1234567891'] }, unread)).toEqual({ refusal: expect.stringMatching(/could not read who the audience is shared with/) })
  })
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

describe('membersDraft — consent PR 2: add and replace consenting Shopify buyers', () => {
  const people = { hashes: [sha256Hex('a@example.com'), sha256Hex('b@example.com')].sort(), skipped: 0 }
  const live = (over: Partial<AudienceMembersLive> = {}): AudienceMembersLive => ({ adAccountId: '1234567890', uploadsOn: true, terms: TERMS, audience: A, use: NO_USE, people, ...over })
  const hashFree = (d: unknown) => { const text = JSON.stringify(d); for (const hash of people.hashes) expect(text).not.toContain(hash); expect(text).not.toContain('example.com') }

  it('the switch first: off, an add or a replace is refused with the switch-off words, whatever else is so', () => {
    for (const mode of ['add', 'replace'] as const) {
      expect(membersDraft({ mode, audienceId: A.id }, live({ uploadsOn: false }))).toEqual({ refusal: NO_CONSENT })
      expect(membersDraft({ mode, audienceId: A.id }, live({ uploadsOn: false, terms: null }))).toEqual({ refusal: NO_CONSENT })
    }
    expect(NO_CONSENT).toMatch(/Upload customer lists to Meta/)
    expect(NO_CONSENT).toMatch(/Claude cannot/)
    // Taking people out needs no switch.
    expect(ok(membersDraft({ mode: 'remove', audienceId: A.id }, live({ uploadsOn: false }))).requests).toHaveLength(1)
  })
  it('Meta\'s terms: not read is refused in plain words, never taken as signed; not signed gives the link', () => {
    expect(membersDraft({ mode: 'add', audienceId: A.id }, live({ terms: null, termsProblem: 'Meta answered 500' }))).toEqual({ refusal: expect.stringMatching(/could not read whether Meta's Custom Audience terms are signed .*Meta answered 500.*uploads nobody/) })
    expect(membersDraft({ mode: 'replace', audienceId: A.id }, live({ terms: { ...TERMS, signed: false } }))).toEqual({ refusal: expect.stringMatching(/terms are not signed.*tos\/\?act=1234567890/) })
  })
  it('only the chosen account\'s own customer list that is not value-based, being replaced or flagged; who only with remove', () => {
    expect(membersDraft({ mode: 'add', audienceId: A.id }, live({ audience: { ...A, subtype: 'WEBSITE' } }))).toEqual({ refusal: expect.stringMatching(/not a customer list: Meta takes people into customer lists only/) })
    expect(membersDraft({ mode: 'add', audienceId: A.id }, live({ audience: { ...A, isValueBased: true } }))).toEqual({ refusal: expect.stringMatching(/value-based customer list/) })
    expect(membersDraft({ mode: 'replace', audienceId: A.id }, live({ audience: { ...A, operationCode: 414 } }))).toEqual({ refusal: expect.stringMatching(/being replaced right now/) })
    // Review NIT 3 — Meta replaces only a Normal list (200): a fresh list (410, no upload yet) is added to first.
    expect(membersDraft({ mode: 'replace', audienceId: A.id }, live({ audience: { ...A, operationCode: 410 } }))).toEqual({ refusal: expect.stringMatching(/only while its status is Normal \(operation_status 200\).*reads status 410 \(no upload yet: add people first with mode add, then replace\)/) })
    expect(membersDraft({ mode: 'replace', audienceId: A.id }, live({ audience: { ...A, operationCode: null } }))).toEqual({ refusal: expect.stringMatching(/reads no status/) })
    expect(ok(membersDraft({ mode: 'add', audienceId: A.id }, live({ audience: { ...A, operationCode: 410 } }))).requests).toHaveLength(1)
    expect(membersDraft({ mode: 'add', audienceId: A.id }, live({ audience: { ...A, flagged: true } }))).toEqual({ refusal: expect.stringMatching(/1713230/) })
    expect(membersDraft({ mode: 'add', audienceId: A.id }, live({ audience: null }))).toEqual({ refusal: expect.stringMatching(/Name the customer list/) })
    expect(membersDraft({ mode: 'add', audienceId: A.id, who: 'added' }, live())).toEqual({ refusal: 'who goes with mode remove only.' })
    expect(membersDraft({ mode: 'remove', audienceId: A.id, who: 'added' }, live())).toEqual({ refusal: expect.stringMatching(/it takes addRanAt/) })
    expect(membersDraft({ mode: 'remove', audienceId: A.id, addRanAt: '2026-10-10T12:00:00.000Z' }, live())).toEqual({ refusal: expect.stringMatching(/addRanAt goes with who added only/) })
    expect(membersDraft({ mode: 'add', audienceId: A.id }, live({ people: { hashes: [], skipped: 1 } }))).toEqual({ refusal: expect.stringMatching(/Nobody to add.*backfill/) })
  })
  it('add: POST /{list}/users, the payload only, at most 10,000 hashes each; the preview counts the hashed e-mails, names where they go and the undo', () => {
    const many = { hashes: Array.from({ length: 10_003 }, (_, i) => sha256Hex(`p${i}@example.com`)).sort(), skipped: 2 }
    const d = ok(membersDraft({ mode: 'add', audienceId: A.id, since: '2026-10-01' }, live({ people: many })))
    expect(d.requests.map((r) => [r.objectId, r.operation, r.edge, r.method ?? 'POST', r.objectKind, r.undoable, Object.keys(r.params).join()])).toEqual([
      [A.id, 'audience.users.add', 'users', 'POST', 'customaudience', true, 'payload'],
      [A.id, 'audience.users.add', 'users', 'POST', 'customaudience', true, 'payload'],
    ])
    expect(JSON.parse(d.requests[1].params.payload)).toEqual({ schema: 'EMAIL_SHA256', data: many.hashes.slice(10_000) })
    expect(d.totals).toEqual({ hashedEmails: 10_003, requests: 2, withoutEmail: 2 })
    expect(d.summary).toBe('Meta: add 10003 hashed e-mails (Shopify buyers who said yes to the business\'s e-mail) to customer list "List A" (120000000000040) of ad account act_1234567890.')
    const words = d.warnings.join(' ')
    expect(words).toMatch(/10003 hashed e-mails go to Meta, into customer list "List A" \(120000000000040\) of ad account act_1234567890: the SHA-256 of each e-mail/)
    expect(words).toMatch(/never an Amazon, eBay or Etsy buyer/)
    // Review FIX-2 / NIT 8 — the undo's exact reach, and who stays, in words.
    expect(words).toMatch(/Undo takes the people out again .*already held when this add ran\. Nexus keeps no list of whom it sent, so the undo can also take out people another add put in\. It cannot take out people erased at Shopify since, people whose shop was uninstalled since, people whose e-mail changed at Shopify since/)
    expect(words).toMatch(/A person erased at Shopify \(customers\/redact\) stays in Meta's lists until the next replace/)
    expect(words).toMatch(/runs about 20 s after it is asked/)
    expect(d.spendsMoney).toEqual([])
    expect(d.before).toEqual({ mode: 'add', audienceId: A.id, people: 10_003, batches: 2, since: '2026-10-01' })
    hashFree({ ...d, requests: d.requests.map((r) => r.label) })
  })
  it('add or replace on a list active ads use is SPENDS MONEY; an add restarts their learning, a replace does not', () => {
    const add = ok(membersDraft({ mode: 'add', audienceId: A.id }, live({ use: ACTIVE })))
    expect(add.spendsMoney[0]).toMatch(/adding these people changes who is in it/)
    expect(add.requests[0].raisesSpend).toBe(true)
    expect(add.warnings.join(' ')).toMatch(/restarts the learning phase/)
    const replace = ok(membersDraft({ mode: 'replace', audienceId: A.id }, live({ use: ACTIVE })))
    expect(replace.spendsMoney[0]).toMatch(/replacing its people changes who is in it/)
    expect(replace.warnings.join(' ')).toMatch(/does not restart the learning phase/)
  })
  it('replace: ONE session — batch_seq from 1, the last flagged, the total, one new id kept out of the plan; no since; no undo, said plainly', () => {
    expect(membersDraft({ mode: 'replace', audienceId: A.id, since: '2026-10-01' }, live())).toEqual({ refusal: expect.stringMatching(/takes no since/) })
    const many = { hashes: Array.from({ length: 20_001 }, (_, i) => sha256Hex(`p${i}@example.com`)).sort(), skipped: 0 }
    const d = ok(membersDraft({ mode: 'replace', audienceId: A.id }, live({ people: many })))
    const sessions = d.requests.map((r) => JSON.parse(r.params.session) as Record<string, unknown>)
    expect(d.requests.map((r) => [r.operation, r.edge, r.method ?? 'POST', r.undoable, r.needs ?? null])).toEqual([
      ['audience.users.replace', 'usersreplace', 'POST', false, null], ['audience.users.replace', 'usersreplace', 'POST', false, [1]], ['audience.users.replace', 'usersreplace', 'POST', false, [2]],
    ])
    expect(sessions.map((x) => [x.batch_seq, x.last_batch_flag, x.estimated_num_total])).toEqual([[1, false, 20_001], [2, false, 20_001], [3, true, 20_001]])
    expect(new Set(sessions.map((x) => x.session_id)).size).toBe(1)
    expect(Number.isSafeInteger(sessions[0].session_id) && (sessions[0].session_id as number) > 0).toBe(true)
    expect(d.requests.every((r) => r.planParams && !/session_id/.test(r.planParams.session) && r.planParams.payload === r.params.payload)).toBe(true)
    // Built again (the re-check, the run): a new session id, the same plan.
    const again = ok(membersDraft({ mode: 'replace', audienceId: A.id }, live({ people: many })))
    expect(JSON.parse(again.requests[0].params.session).session_id).not.toBe(sessions[0].session_id)
    expect(planned(again)).toBe(planned(d))
    expect(d.warnings.join(' ')).toMatch(/No undo: Meta does not list a Custom Audience's members/)
    expect(d.warnings.join(' ')).toMatch(/ONE replace session of 3 requests/)
    expect(d.summary).toMatch(/^Meta: replace everyone in customer list "List A" \(120000000000040\) of ad account act_1234567890 with 20001 hashed e-mails/)
    expect(membersDraft({ mode: 'replace', audienceId: A.id }, live({ people: { hashes: Array.from({ length: 100_001 }, (_, i) => sha256Hex(String(i))), skipped: 0 } }))).toEqual({ refusal: expect.stringMatching(/ONE session of at most 10 requests/) })
    hashFree({ ...d, requests: d.requests.map((r) => r.label) })
  })
  it('remove: the people who said no, counted by why; who added is the undo of an add, said so', () => {
    const d = ok(membersDraft({ mode: 'remove', audienceId: A.id }, live({ uploadsOn: false, saidNo: { optedOut: 1, consentEnded: 1 } })))
    expect(d.warnings.join(' ')).toMatch(/1 opted out of the business's e-mail and 1 had said yes on Shopify and unsubscribed since/)
    expect(d.warnings.join(' ')).toMatch(/Nobody who never said yes is sent/)
    expect(d.warnings.join(' ')).toMatch(/A person erased at Shopify/)
    expect(d.summary).toMatch(/who said no \(opted out of the business's e-mail, or whose yes ended on Shopify\)/)
    expect(d.before).toMatchObject({ mode: 'remove', who: 'said_no' })
    const undo = ok(membersDraft({ mode: 'remove', audienceId: A.id, who: 'added', addRanAt: '2026-10-10T12:00:00.000Z' }, live({ uploadsOn: false })))
    expect(undo.summary).toMatch(/whom the add may have sent \(the undo of an add\)/)
    expect(undo.warnings.join(' ')).toMatch(/It is the undo of an add that ran at 2026-10-10T12:00:00\.000Z: it takes out the rows that said yes, or whose yes ended since, and that Nexus already held then\..*can also take out people another add put in\. It cannot take out people erased at Shopify since, people whose shop was uninstalled since, people whose e-mail changed at Shopify since/)
    expect(undo.requests[0]).toMatchObject({ method: 'DELETE', operation: 'audience.users.remove' })
  })
})
