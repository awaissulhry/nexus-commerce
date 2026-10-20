/**
 * Meta step 17 — set-meta-status as a pure draft: Meta's status rules (archived → only deleted; deleted final; a rejected
 * ad, an ended ad set, a sequenced ad set's ad), SPENDS MONEY for every switch-on with the parent's state in words, pauses
 * first and activations last (children before their campaign), what it stands on, and what undo reads. Made-up ids.
 */
import { describe, expect, it } from 'vitest'
import { statusDraft, type StatusRequest } from './change-status.js'
import { itemKey, statusObjectOf, STATUS_FIELDS, type MetaStatusObject } from './live-status.js'
import type { MetaChangeDraft } from './change-draft.js'

const NOW = new Date('2026-10-21T10:00:00Z')
const campaign = (id: string, status: string, extra: Partial<MetaStatusObject> = {}): MetaStatusObject => ({
  kind: 'campaign', id, name: `Campaign ${id.slice(-1)}`, adAccountId: '1234567890', status, effectiveStatus: status,
  objective: 'OUTCOME_SALES', smartPromotionType: null, endTime: null, campaign: null, adSet: null, ...extra,
})
const adSet = (id: string, status: string, parent: string, parentStatus: string, extra: Partial<MetaStatusObject> = {}): MetaStatusObject => ({
  kind: 'adset', id, name: `Ad set ${id.slice(-1)}`, adAccountId: '1234567890', status, effectiveStatus: status,
  objective: null, smartPromotionType: null, endTime: null, campaign: { id: parent, name: `Campaign ${parent.slice(-1)}`, status: parentStatus, effectiveStatus: parentStatus }, adSet: null, ...extra,
})
const ad = (id: string, status: string, setStatus: string, campaignStatus: string, extra: Partial<MetaStatusObject> = {}): MetaStatusObject => ({
  kind: 'ad', id, name: `Ad ${id.slice(-1)}`, adAccountId: '1234567890', status, effectiveStatus: status,
  objective: null, smartPromotionType: null, endTime: null,
  campaign: { id: '120000000000001', name: 'Campaign 1', status: campaignStatus, effectiveStatus: campaignStatus },
  adSet: { id: '120000000000002', name: 'Ad set 2', status: setStatus, effectiveStatus: setStatus, endTime: null, creativeSequence: false }, ...extra,
})
const liveOf = (...objects: MetaStatusObject[]) => ({ objects: new Map(objects.map((o) => [itemKey(o.kind, o.id), o])), problems: [] as string[] })
const draft = (request: StatusRequest, live: ReturnType<typeof liveOf>) => statusDraft(request, live, NOW) as MetaChangeDraft
const refusal = (request: StatusRequest, live: ReturnType<typeof liveOf>) => (statusDraft(request, live, NOW) as { refusal: string }).refusal

describe('Meta\'s answer, read as a status object', () => {
  it('reads each kind\'s own fields, the parents and the sequence flag; the fields asked are only that kind\'s', () => {
    const o = statusObjectOf('ad', { id: '3', account_id: '1234567890', name: 'Ad A', status: 'PAUSED', effective_status: 'ADSET_PAUSED', adset: { id: '2', name: 'Set', status: 'PAUSED', end_time: '2026-12-01T00:00:00+0000', creative_sequence: ['3', '4'] }, campaign: { id: '1', status: 'ACTIVE' } })
    expect(o).toMatchObject({ kind: 'ad', adAccountId: '1234567890', status: 'PAUSED', effectiveStatus: 'ADSET_PAUSED', adSet: { id: '2', status: 'PAUSED', creativeSequence: true, endTime: '2026-12-01T00:00:00+0000' }, campaign: { id: '1', status: 'ACTIVE' } })
    expect(statusObjectOf('campaign', { id: '1', account_id: 'act_1234567890', status: 'ACTIVE', smart_promotion_type: 'AUTOMATED_SHOPPING_ADS' })).toMatchObject({ adAccountId: '1234567890', smartPromotionType: 'AUTOMATED_SHOPPING_ADS', campaign: null })
    expect(statusObjectOf('campaign', { name: 'no id' })).toBeNull()
    expect(STATUS_FIELDS.campaign).toContain('objective')
    expect(STATUS_FIELDS.adset).toContain('campaign_id')
    expect(STATUS_FIELDS.ad).toContain('adset_id')
    expect(STATUS_FIELDS.adset).not.toMatch(/objective|adset_id/)
  })
})

describe('statusDraft', () => {
  it('a pause is one safe request; it says what stops with it; undo reads before → after', () => {
    const d = draft({ items: [{ kind: 'campaign', id: '120000000000001' }], status: 'PAUSED' }, liveOf(campaign('120000000000001', 'ACTIVE')))
    expect(d.requests).toEqual([{ step: 1, label: 'Pause campaign "Campaign 1" (120000000000001)', kind: 'campaign', objectId: '120000000000001', params: { status: 'PAUSED' }, checkable: true, budget: false, undoable: true }])
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings.join(' ')).toMatch(/stops every ad set and ad in it .*CAMPAIGN_PAUSED/)
    expect(d.changes).toEqual({ 'campaign "Campaign 1" (120000000000001)': { from: 'ACTIVE', to: 'PAUSED' } })
    expect(d.before).toEqual({ items: [{ kind: 'campaign', id: '120000000000001', name: 'Campaign 1', status: 'ACTIVE' }] })
    expect(d.after).toEqual({ items: [{ kind: 'campaign', id: '120000000000001', status: 'PAUSED' }] })
  })
  it('switching on is always SPENDS MONEY; the line says when a parent is off, so nothing spends yet', () => {
    const d = draft({ items: [{ kind: 'adset', id: '120000000000002' }, { kind: 'ad', id: '120000000000003' }], status: 'ACTIVE' },
      liveOf(adSet('120000000000002', 'PAUSED', '120000000000001', 'PAUSED'), ad('120000000000003', 'PAUSED', 'PAUSED', 'PAUSED')))
    expect(d.spendsMoney).toHaveLength(2)
    expect(d.spendsMoney[0]).toMatch(/Switching on ad "Ad 3".*nothing spends yet — its campaign "Campaign 1" \(120000000000001\) is not on/)
    expect(d.spendsMoney[1]).toMatch(/Switching on ad set "Ad set 2".*nothing spends yet — its campaign "Campaign 1" .*is not on/)
    const on = draft({ items: [{ kind: 'campaign', id: '120000000000001' }, { kind: 'adset', id: '120000000000002' }], status: 'ACTIVE' },
      liveOf(campaign('120000000000001', 'PAUSED'), adSet('120000000000002', 'PAUSED', '120000000000001', 'PAUSED')))
    // The campaign is switched on in the same request: its ad set spends, and the campaign goes LAST.
    expect(on.spendsMoney.join(' ')).toMatch(/ad set "Ad set 2".*start delivering and spending/)
    expect(on.requests.map((r) => r.kind)).toEqual(['adset', 'campaign'])
  })
  it('pauses and archives go first, activations last (ads, then ad sets, then campaigns)', () => {
    const d = draft({ items: [
      { kind: 'campaign', id: '120000000000011', status: 'ACTIVE' }, { kind: 'ad', id: '120000000000013', status: 'ACTIVE' },
      { kind: 'campaign', id: '120000000000021', status: 'PAUSED' }, { kind: 'adset', id: '120000000000012', status: 'ACTIVE' },
    ] }, liveOf(campaign('120000000000011', 'PAUSED'), ad('120000000000013', 'PAUSED', 'ACTIVE', 'ACTIVE'), campaign('120000000000021', 'ACTIVE'), adSet('120000000000012', 'PAUSED', '120000000000011', 'PAUSED')))
    expect(d.requests.map((r) => `${r.params.status}:${r.kind}`)).toEqual(['PAUSED:campaign', 'ACTIVE:ad', 'ACTIVE:adset', 'ACTIVE:campaign'])
    expect(d.requests.map((r) => r.step)).toEqual([1, 2, 3, 4])
    expect(d.totals).toMatchObject({ pause: 1, switchOn: 3, archive: 0, requests: 4 })
  })
  it('an archive is for good and says so (children archived with a campaign); only campaigns are checkable', () => {
    const d = draft({ items: [{ kind: 'campaign', id: '120000000000001' }, { kind: 'adset', id: '120000000000002' }], status: 'ARCHIVED' },
      liveOf(campaign('120000000000001', 'PAUSED'), adSet('120000000000002', 'PAUSED', '120000000000009', 'ACTIVE')))
    expect(d.warnings.join(' ')).toMatch(/Archiving campaign .* is for good.*ad sets and ads are archived with it.*cannot be undone/)
    expect(d.requests.map((r) => r.checkable)).toEqual([true, false])
    expect(d.requests.map((r) => r.undoable)).toEqual([false, false])
  })
  it('Meta\'s rules refuse in words: deleted, archived → anything but archived, a rejected ad, an ended ad set, a sequenced ad', () => {
    expect(refusal({ items: [{ kind: 'campaign', id: '120000000000001' }], status: 'PAUSED' }, liveOf(campaign('120000000000001', 'DELETED')))).toMatch(/deleted on Meta/)
    expect(refusal({ items: [{ kind: 'campaign', id: '120000000000001' }], status: 'ACTIVE' }, liveOf(campaign('120000000000001', 'ARCHIVED')))).toMatch(/archived: Meta lets an archived item only be deleted/)
    expect(refusal({ items: [{ kind: 'ad', id: '120000000000003' }], status: 'ACTIVE' }, liveOf(ad('120000000000003', 'PAUSED', 'ACTIVE', 'ACTIVE', { effectiveStatus: 'DISAPPROVED' })))).toMatch(/rejected in Meta's review/)
    expect(refusal({ items: [{ kind: 'adset', id: '120000000000002' }], status: 'ACTIVE' }, liveOf(adSet('120000000000002', 'PAUSED', '120000000000001', 'ACTIVE', { endTime: '2026-10-01T00:00:00+0000' })))).toMatch(/ended on 2026-10-01/)
    const sequenced = ad('120000000000003', 'ACTIVE', 'ACTIVE', 'ACTIVE')
    sequenced.adSet!.creativeSequence = true
    expect(refusal({ items: [{ kind: 'ad', id: '120000000000003' }], status: 'PAUSED' }, liveOf(sequenced))).toMatch(/in a sequence/)
  })
  it('already so is skipped; nothing to change, a duplicate, no status, a problem reading or an item not read: refused', () => {
    const d = draft({ items: [{ kind: 'campaign', id: '120000000000001' }, { kind: 'campaign', id: '120000000000004' }], status: 'PAUSED' }, liveOf(campaign('120000000000001', 'PAUSED'), campaign('120000000000004', 'ACTIVE')))
    expect(d.skipped).toEqual(['campaign "Campaign 1" (120000000000001) is already PAUSED.'])
    expect(d.requests).toHaveLength(1)
    expect(refusal({ items: [{ kind: 'campaign', id: '120000000000001' }], status: 'PAUSED' }, liveOf(campaign('120000000000001', 'PAUSED')))).toMatch(/Nothing to change/)
    expect(refusal({ items: [{ kind: 'campaign', id: '1' }, { kind: 'campaign', id: '1' }], status: 'PAUSED' }, liveOf())).toMatch(/named twice/)
    expect(refusal({ items: [{ kind: 'campaign', id: '1' }] }, liveOf())).toMatch(/Say the status/)
    expect(refusal({ items: [{ kind: 'campaign', id: '1' }], status: 'PAUSED' }, { objects: new Map(), problems: ['1 is not a campaign (Meta: nonexisting field).'] })).toMatch(/Nothing was asked of Meta: 1 is not a campaign/)
    expect(refusal({ items: [{ kind: 'campaign', id: '1' }], status: 'PAUSED' }, liveOf())).toMatch(/could not read campaign 1/)
  })
  it('stands on each object\'s own status and its parents\' — not on effective statuses (they move with review)', () => {
    const a = draft({ items: [{ kind: 'ad', id: '120000000000003' }], status: 'ACTIVE' }, liveOf(ad('120000000000003', 'PAUSED', 'ACTIVE', 'ACTIVE')))
    const b = draft({ items: [{ kind: 'ad', id: '120000000000003' }], status: 'ACTIVE' }, liveOf(ad('120000000000003', 'PAUSED', 'ACTIVE', 'ACTIVE', { effectiveStatus: 'PENDING_REVIEW' })))
    const c = draft({ items: [{ kind: 'ad', id: '120000000000003' }], status: 'ACTIVE' }, liveOf(ad('120000000000003', 'PAUSED', 'PAUSED', 'ACTIVE')))
    expect(JSON.stringify(a.stands)).toBe(JSON.stringify(b.stands))
    expect(JSON.stringify(a.stands)).not.toBe(JSON.stringify(c.stands))
  })
  it('a legacy Advantage+ shopping campaign is warned about (Meta\'s own check answers first)', () => {
    const d = draft({ items: [{ kind: 'campaign', id: '120000000000001' }], status: 'PAUSED' }, liveOf(campaign('120000000000001', 'ACTIVE', { smartPromotionType: 'AUTOMATED_SHOPPING_ADS' })))
    expect(d.warnings.join(' ')).toMatch(/legacy Advantage\+ shopping campaign/)
  })
})
