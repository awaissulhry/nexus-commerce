/**
 * Meta step 19 — copy-meta-ads as a draft (pure) and the undo of a create or a copy (change-create-common.ts): a copy is
 * PAUSED (status_option said) unless activate, the source's status only from a paused source, Meta's 3 / 51 ads limit with
 * the background path, the EU payer check, a budget override of the same kind only, Meta has no check; undo deletes only
 * what the change made, while nothing else hangs under it and it spent nothing. Made-up ids.
 */
import { describe, expect, it } from 'vitest'
import { copyDraft, type CopyLive, type CopyRequest } from './change-copy.js'
import { madeByCopy, removalDraft, scheduleSpecs, type MadeRecord } from './change-create-common.js'
import type { MetaChangeDraft } from './change-draft.js'
import type { CopySource, MadeNow } from './live-create.js'
import type { LiveCampaign } from './live-settings.js'
import { metaWriteVerdict } from '../../gateway/meta-calls.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../../meta/api-version.js'

const C = '120000000000001'
const S = '120000000000002'
const A = '120000000000003'
const NOW = new Date('2026-10-21T08:00:00Z')
const SOURCE: CopySource = {
  kind: 'campaign', id: C, name: 'Campaign A', status: 'PAUSED', effectiveStatus: 'PAUSED', campaignId: C, adSetId: null, campaignStatus: 'PAUSED', adSetStatus: null,
  objective: 'OUTCOME_SALES', specialAdCategories: [], smartPromotionType: null, adCount: 2, adSets: [{ id: S, name: 'Ad set B', countries: ['IT'], dsaPayor: 'Shop A', dsaBeneficiary: 'Shop A' }], adSetsMore: false,
}
const LIVE: CopyLive = { adAccountId: '1234567890', currency: 'EUR', source: SOURCE, sourceCampaign: null, targetCampaign: null, targetAdSet: null, dsaDefaults: null }
const ok = (r: CopyRequest, live: Partial<CopyLive> = {}) => {
  const d = copyDraft(r, { ...LIVE, ...live }, NOW)
  if ('refusal' in d) throw new Error(d.refusal)
  return d
}
const no = (r: CopyRequest, live: Partial<CopyLive> = {}) => {
  const d = copyDraft(r, { ...LIVE, ...live }, NOW)
  return 'refusal' in d ? d.refusal : null
}
const judged = (d: MetaChangeDraft, objectKind?: string) => metaWriteVerdict({
  method: 'POST', url: `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}/${d.requests[0].objectId}/${d.requests[0].edge}`, kind: 'write',
  body: new URLSearchParams(d.requests[0].params).toString(), objectKind: objectKind ?? d.requests[0].objectKind ?? d.requests[0].kind,
})
const campaign = (o: Partial<LiveCampaign> = {}): LiveCampaign => ({
  id: '120000000000009', name: 'Campaign IT', status: 'ACTIVE', effectiveStatus: 'ACTIVE', objective: 'OUTCOME_SALES', buyingType: 'AUCTION', smartPromotionType: null, dailyBudget: '5000',
  lifetimeBudget: null, spendCap: null, canUseSpendCap: true, bidStrategy: 'LOWEST_COST_WITHOUT_CAP', pacingType: null, promotedObject: null, specialAdCategories: [], specialAdCategory: null,
  specialAdCategoryCountry: null, budgetSharing: false, budgetScheduling: null, reelsTrendingAds: null, advantageState: null, ...o,
})

describe('copy-meta-ads', () => {
  it('a campaign with its children: POST /<id>/copies, PAUSED said explicitly, no check, the read-back judged', () => {
    const d = ok({ kind: 'campaign', sourceId: C, deepCopy: true })
    expect(d.requests[0]).toMatchObject({ objectId: C, edge: 'copies', kind: 'campaign', check: 'none', raisesSpend: false, operation: 'campaign.copy', expect: { status: 'PAUSED' } })
    expect(d.requests[0].params).toEqual({ status_option: 'PAUSED', deep_copy: 'true' })
    expect(d.spendsMoney).toEqual([])
    expect(judged(d)).toMatchObject({ write: { rule: 'campaign.copy' } })
    expect(d.warnings.join(' ')).toMatch(/Meta has no check for a copy/)
  })
  it('Meta\'s 3 ads in one request, 51 in the background; the background path is one async part, judged as the copy', () => {
    expect(no({ kind: 'campaign', sourceId: C, deepCopy: true }, { source: { ...SOURCE, adCount: 4 } })).toMatch(/at most 3 ads in one request.*background: true/)
    expect(no({ kind: 'campaign', sourceId: C, deepCopy: true, background: true }, { source: { ...SOURCE, adCount: 52 } })).toMatch(/at most 51/)
    const bg = ok({ kind: 'campaign', sourceId: C, deepCopy: true, background: true }, { source: { ...SOURCE, adCount: 20 } })
    expect(bg.requests[0]).toMatchObject({ objectId: 'act_1234567890', objectKind: 'adaccount', edge: 'async_batch_requests', operation: 'copy.background' })
    expect(JSON.parse(bg.requests[0].params.adbatch)).toEqual([{ name: 'campaign_copy_1', relative_url: `${C}/copies`, body: 'status_option=PAUSED&deep_copy=true' }])
    expect(judged(bg)).toMatchObject({ write: { rule: 'copy.background' } })
    expect(bg.before).toMatchObject({ op: 'background-copy' })
    expect(no({ kind: 'campaign', sourceId: C, background: true })).toMatch(/WITH its ads/)
  })
  it('switching on is the person\'s decision; the source\'s status only from a paused source', () => {
    const on = ok({ kind: 'campaign', sourceId: C, deepCopy: true, activate: true })
    expect(on.requests[0]).toMatchObject({ raisesSpend: true, params: expect.objectContaining({ status_option: 'ACTIVE' }) })
    expect(on.spendsMoney[0]).toMatch(/spend at once/)
    const kept = ok({ kind: 'campaign', sourceId: C, keepSourceStatus: true }).requests[0]
    expect(kept.params.status_option).toBe('INHERITED_FROM_SOURCE')
    // Review A5 — the copy must read back PAUSED too.
    expect(kept.expect).toEqual({ status: 'PAUSED' })
    expect(no({ kind: 'campaign', sourceId: C, keepSourceStatus: true }, { source: { ...SOURCE, status: 'ACTIVE' } })).toMatch(/only from a paused source/)
    expect(no({ kind: 'campaign', sourceId: C, keepSourceStatus: true, activate: true })).toMatch(/Name one/)
  })
  it('an ad set into another campaign: campaign_id, its settings said; under a paused campaign nothing spends yet', () => {
    const adSet: CopySource = { ...SOURCE, kind: 'adset', id: S, name: 'Ad set B', adSetId: S, adCount: 1 }
    const d = ok({ kind: 'adset', sourceId: S, targetCampaignId: '120000000000009', activate: true }, { source: adSet, targetCampaign: campaign({ status: 'PAUSED' }) })
    expect(d.requests[0].params).toMatchObject({ campaign_id: '120000000000009', status_option: 'ACTIVE', deep_copy: 'false' })
    expect(d.warnings.join(' ')).toMatch(/takes campaign 120000000000009's settings, such as its budget/)
    expect(d.spendsMoney[0]).toMatch(/nothing spends until its campaign \(120000000000009\) is on/)
    expect(judged(d)).toMatchObject({ write: { rule: 'adset.copy', ids: [{ id: '120000000000009', kind: 'campaign' }] } })
  })
  it('the EU: an ad set without its payer / beneficiary and no account default is refused in words; with a default it goes', () => {
    const eu = { ...SOURCE, adSets: [{ id: S, name: 'Ad set B', countries: ['FR'], dsaPayor: null, dsaBeneficiary: null }] }
    expect(no({ kind: 'campaign', sourceId: C, deepCopy: true }, { source: eu })).toMatch(/3858079/)
    expect(ok({ kind: 'campaign', sourceId: C, deepCopy: true }, { source: eu, dsaDefaults: { payor: 'Shop A', beneficiary: 'Shop A' } }).requests).toHaveLength(1)
    // A shallow campaign copy copies no ad set.
    expect(ok({ kind: 'campaign', sourceId: C }, { source: eu }).requests).toHaveLength(1)
  })
  it('CMP-055 — a budget override of the same kind as the source\'s campaign budget, said as Meta\'s to decide', () => {
    const d = ok({ kind: 'campaign', sourceId: C, budgetOverride: { dailyBudgetCents: 7000 } }, { sourceCampaign: campaign({ id: C }) })
    expect(d.requests[0].params.parameter_overrides).toBe('{"daily_budget":7000}')
    expect(d.warnings.join(' ')).toMatch(/LIVE-PROBE CMP-055/)
    expect(judged(d)).toMatchObject({ write: { rule: 'campaign.copy' } })
    expect(no({ kind: 'campaign', sourceId: C, budgetOverride: { lifetimeBudgetCents: 7000 } }, { sourceCampaign: campaign({ id: C }) })).toMatch(/same kind/)
    expect(no({ kind: 'campaign', sourceId: C, budgetOverride: { dailyBudgetCents: 7000 } }, { sourceCampaign: campaign({ id: C, dailyBudget: null }) })).toMatch(/no campaign budget/)
  })
  it('an ad into another ad set (AD-054: Meta cannot move one), with its creative\'s name and URL tags', () => {
    const ad: CopySource = { ...SOURCE, kind: 'ad', id: A, name: 'Ad C', adSetId: S, adSetStatus: 'ACTIVE', campaignStatus: 'ACTIVE', adCount: null }
    const target = { facts: { id: '120000000000019', name: 'Ad set IT', countries: ['IT'], dsaPayor: 'Shop A', dsaBeneficiary: 'Shop A' }, status: 'ACTIVE', campaignId: '120000000000009', campaignStatus: 'ACTIVE' }
    const d = ok({ kind: 'ad', sourceId: A, targetAdSetId: '120000000000019', creative: { name: 'Ad C — IT', urlTags: 'utm_source=meta' } }, { source: ad, targetAdSet: target })
    expect(d.requests[0].params).toEqual({ status_option: 'PAUSED', adset_id: '120000000000019', creative_parameters: '{"name":"Ad C — IT","url_tags":"utm_source=meta"}' })
    expect(d.warnings.join(' ')).toMatch(/Meta cannot change an ad's ad set/)
    expect(judged(d)).toMatchObject({ write: { rule: 'ad.copy' } })
    expect(no({ kind: 'ad', sourceId: A, deepCopy: true }, { source: ad })).toMatch(/nothing under it/)
    expect(no({ kind: 'ad', sourceId: A, startTime: '2026-11-01T00:00:00Z' }, { source: ad })).toMatch(/no times of its own/)
  })
  it('review A1 / B1 — several ads in the background: the async batch of <ad id>/copies parts, PAUSED said for each; never asyncadcopies', () => {
    const d = ok({ kind: 'ad', adIds: [A, '120000000000004'], background: true, targetAdSetId: S }, { source: null })
    expect(d.requests[0]).toMatchObject({ objectId: 'act_1234567890', edge: 'async_batch_requests', operation: 'copy.background' })
    expect(JSON.parse(d.requests[0].params.adbatch)).toEqual([
      { name: 'ad_copy_1', relative_url: `${A}/copies`, body: `status_option=PAUSED&adset_id=${S}` },
      { name: 'ad_copy_2', relative_url: '120000000000004/copies', body: `status_option=PAUSED&adset_id=${S}` },
    ])
    expect(d.warnings.join(' ')).toMatch(/asyncadcopies .* never sends it/)
    expect(judged(d)).toMatchObject({ write: { rule: 'copy.background' } })
    expect(d.before).toMatchObject({ op: 'background-copy' })
  })
  it('review A6 — an ad set in the EU\'s outermost regions needs its payer / beneficiary too', () => {
    const re = { ...SOURCE, adSets: [{ id: S, name: 'Ad set B', countries: ['RE'], dsaPayor: null, dsaBeneficiary: null }] }
    expect(no({ kind: 'campaign', sourceId: C, deepCopy: true }, { source: re })).toMatch(/3858079/)
  })
  it('refuses a legacy Advantage+ shopping source and a deleted one', () => {
    expect(no({ kind: 'campaign', sourceId: C }, { source: { ...SOURCE, smartPromotionType: 'AUTOMATED_SHOPPING_ADS' } })).toMatch(/legacy/)
    expect(no({ kind: 'campaign', sourceId: C }, { source: { ...SOURCE, status: 'DELETED' } })).toMatch(/deleted/)
  })
})

describe('what a copy made, and the undo of a create or a copy', () => {
  it('madeByCopy keeps the copy and every ad_object_ids entry (ad sets, ads, creatives)', () => {
    expect(madeByCopy('campaign', { copied_campaign_id: '120000000000009', ad_object_ids: [{ ad_object_type: 'ad_set', source_id: S, copied_id: '120000000000010' }, { ad_object_type: 'ad', source_id: A, copied_id: '120000000000011' }, { ad_object_type: 'unique_adcreative', source_id: '1', copied_id: '120000000000012' }] }, null))
      .toEqual([{ kind: 'campaign', id: '120000000000009', name: null }, { kind: 'adset', id: '120000000000010' }, { kind: 'ad', id: '120000000000011' }, { kind: 'creative', id: '120000000000012' }])
    expect(madeByCopy('ad', { copied_ad_id: '120000000000013' }, null)).toEqual([{ kind: 'ad', id: '120000000000013', name: null }])
  })
  const record: MadeRecord = { op: 'copy', made: [{ kind: 'campaign', id: '120000000000009' }, { kind: 'adset', id: '120000000000010' }, { kind: 'ad', id: '120000000000011' }], top: [{ kind: 'campaign', id: '120000000000009' }], madeAt: '2026-10-21T08:00:00.000Z' }
  const now = (o: Partial<MadeNow>): MadeNow => ({ kind: 'campaign', id: '120000000000009', there: true, status: 'PAUSED', effectiveStatus: 'PAUSED', children: ['120000000000010', '120000000000011'], childrenMore: false, childrenOn: [], spend: 0, undeletable: null, ...o })
  it('deletes only the top object the change made, when it holds only what the change made and has spent nothing', () => {
    const d = removalDraft(record, [now({})], 'copy-meta-ads')
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.requests).toEqual([expect.objectContaining({ objectId: '120000000000009', kind: 'campaign', method: 'DELETE', params: {}, check: 'none', operation: 'campaign.delete', raisesSpend: false })])
    expect(d.warnings[0]).toMatch(/final/)
    const v = metaWriteVerdict({ method: 'DELETE', url: `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}/120000000000009`, kind: 'write', objectKind: 'campaign' })
    expect(v).toMatchObject({ write: { rule: 'object.delete' } })
  })
  it('keeps what holds something else, what spent, what Nexus cannot read, and says so pointing to remove-meta-ads-items', () => {
    expect(removalDraft(record, [now({ children: ['120000000000010', '120000000000099'] })], 'copy-meta-ads')).toMatchObject({ refusal: expect.stringMatching(/did not make \(120000000000099\).*remove-meta-ads-items \(step 22, not built yet\)/) })
    expect(removalDraft(record, [now({ spend: 1.5 })], 'copy-meta-ads')).toMatchObject({ refusal: expect.stringMatching(/has spent since it was made/) })
    expect(removalDraft(record, [now({ spend: null })], 'copy-meta-ads')).toMatchObject({ refusal: expect.stringMatching(/could not read what/) })
    expect(removalDraft(record, [now({ childrenMore: true })], 'copy-meta-ads')).toMatchObject({ refusal: expect.stringMatching(/more ad sets or ads than Nexus reads/) })
    expect(removalDraft(record, [], 'copy-meta-ads')).toMatchObject({ refusal: expect.stringMatching(/could not read campaign/) })
    expect(removalDraft(record, [now({ there: false })], 'copy-meta-ads')).toMatchObject({ refusal: expect.stringMatching(/deleted already/) })
    // Review A3 — spend is reported late: nothing that delivers now is deleted (it, or anything under it).
    expect(removalDraft(record, [now({ status: 'ACTIVE', effectiveStatus: 'ACTIVE' })], 'copy-meta-ads')).toMatchObject({ refusal: expect.stringMatching(/is on: Meta reports spend late/) })
    expect(removalDraft(record, [now({ childrenOn: ['120000000000011'] })], 'copy-meta-ads')).toMatchObject({ refusal: expect.stringMatching(/1 ad set or ad that deliver now/) })
    // Review B8 — an ad Meta refuses to delete is said for that part.
    const adRecord: MadeRecord = { op: 'copy', made: [{ kind: 'ad', id: '120000000000013' }], top: [{ kind: 'ad', id: '120000000000013' }], madeAt: '2026-10-21T08:00:00.000Z' }
    expect(removalDraft(adRecord, [now({ kind: 'ad', id: '120000000000013', children: [], undeletable: 'Meta refuses to delete an ad that is part of its ad set\'s ad sequence (pause the ad set with set-meta-status instead).' })], 'copy-meta-ads'))
      .toMatchObject({ refusal: expect.stringMatching(/ad sequence/) })
    expect(removalDraft({ ...record, op: 'background-copy', top: [] }, [], 'copy-meta-ads')).toMatchObject({ refusal: expect.stringMatching(/background copy/) })
    expect(removalDraft({ ...record, op: 'remove' }, [], 'copy-meta-ads')).toMatchObject({ refusal: expect.stringMatching(/final/) })
  })
  it('scheduleSpecs: one-time increases in the future, at least 3 hours', () => {
    expect(() => scheduleSpecs([{ startTime: '2026-10-20T08:00:00Z', endTime: '2026-10-20T20:00:00Z', increasePercent: 20 }], 5000, 'EUR', NOW)).toThrow(/in the future/)
    expect(() => scheduleSpecs([{ startTime: '2026-11-20T08:00:00Z', endTime: '2026-11-20T09:00:00Z', increasePercent: 20 }], 5000, 'EUR', NOW)).toThrow(/3 hours/)
    expect(() => scheduleSpecs([{ startTime: '2026-11-20T08:00:00Z', endTime: '2026-11-20T20:00:00Z' }], 5000, 'EUR', NOW)).toThrow(/one of the two/)
    expect(JSON.parse(scheduleSpecs([{ startTime: '2026-11-20T08:00:00Z', endTime: '2026-11-20T20:00:00Z', increasePercent: 20 }], 5000, 'EUR', NOW).value)[0]).toMatchObject({ budget_value: 20, budget_value_type: 'MULTIPLIER' })
  })
})
