/**
 * Meta step 22 — the live reads a delete stands on (live-remove.ts): each object read with its kind's own fields and its
 * account checked; everything under a campaign or ad set listed with every status but DELETED (archived ones too); an ad of
 * a sequenced or dynamic creative ad set marked undeletable; an ad set under a campaign budget with the campaign's other ad
 * sets; a deleted object read by its own id; the account's ads by creative; images by hash with the creatives Meta lists;
 * an Instant Experience part's id from its row or its element. Meta is a stand-in; made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ answers: {} as Record<string, unknown>, reads: [] as Array<{ path: string; query: Record<string, unknown> }> }))
vi.mock('./read-client.js', () => ({
  metaReadOne: vi.fn(async (_t: unknown, req: { path: string; query: Record<string, unknown> }) => {
    h.reads.push(req)
    const body = h.answers[req.path]
    if (body instanceof Error) throw body
    return { body: body ?? { data: [] }, calls: 1 }
  }),
  metaReadAll: vi.fn(async () => ({ rows: 0, calls: 1, truncated: false })),
}))

import { liveAdsByCreative, livePageCanvasElements, liveRemoveImages, liveRemoveObjects } from './live-remove.js'
import { MetaReadError } from './errors.js'

const target = { connectionId: 'm-1', adAccountId: '1234567890' }
const C = '120000000000001'
const S = '120000000000002'
const A = '120000000000003'

beforeEach(() => { h.answers = {}; h.reads = [] })

describe('liveRemoveObjects', () => {
  it('a campaign: its kind\'s fields, its account; every ad set and ad under it with every status but DELETED', async () => {
    h.answers[C] = { id: C, account_id: '1234567890', name: 'Campaign A', status: 'ACTIVE', objective: 'OUTCOME_SALES', effective_status: 'ACTIVE' }
    h.answers[`${C}/adsets`] = { data: [{ id: S, name: 'Ad set B', status: 'ARCHIVED', effective_status: 'ARCHIVED' }] }
    h.answers[`${C}/ads`] = { data: [{ id: A, name: 'Ad 1', status: 'PAUSED', effective_status: 'CAMPAIGN_PAUSED', creative: { id: '120000000000040' } }] }
    const read = await liveRemoveObjects(target, [{ kind: 'campaign', id: C }])
    expect(read.problems).toEqual([])
    expect(read.objects.get(`campaign:${C}`)).toMatchObject({ name: 'Campaign A', status: 'ACTIVE', children: [
      { kind: 'adset', id: S, status: 'ARCHIVED', effectiveStatus: 'ARCHIVED', creativeId: null },
      { kind: 'ad', id: A, effectiveStatus: 'CAMPAIGN_PAUSED', creativeId: '120000000000040' },
    ], childrenMore: false })
    expect(h.reads[0].query.fields).toBe('id,account_id,name,status,objective,effective_status')
    const statuses = h.reads.find((r) => r.path === `${C}/ads`)!.query.effective_status as string[]
    expect(statuses).toContain('ARCHIVED')
    expect(statuses).not.toContain('DELETED')
  })
  it('another account, another kind, not found: problems in words; a deleted one is read but nothing under it', async () => {
    h.answers[C] = { id: C, account_id: '5555555555', status: 'PAUSED', objective: 'OUTCOME_SALES', effective_status: 'PAUSED' }
    h.answers[S] = { id: S, account_id: '1234567890', status: 'PAUSED', effective_status: 'PAUSED' }
    h.answers[A] = new MetaReadError({ origin: 'meta', httpStatus: 400, code: '100', authLost: false, throttled: false, permissionDenied: false, notFound: true, sentence: 'Meta does not find it.' }, 'x', 1)
    const read = await liveRemoveObjects(target, [{ kind: 'campaign', id: C }, { kind: 'adset', id: S }, { kind: 'ad', id: A }])
    expect(read.problems).toEqual([
      `campaign ${C} is not of the Meta ad account this business chose: Nexus deletes nothing in another account.`,
      `${S} is not an ad set (Meta answered without an ad set's own fields); name its kind as meta-ads-live shows it.`,
      `Meta does not find ad ${A} (or the system user cannot see it): nothing to delete.`,
    ])
    h.answers[C] = { id: C, account_id: '1234567890', status: 'DELETED', objective: 'OUTCOME_SALES', effective_status: 'DELETED' }
    h.reads = []
    expect((await liveRemoveObjects(target, [{ kind: 'campaign', id: C }])).objects.get(`campaign:${C}`)).toMatchObject({ status: 'DELETED', children: [] })
    expect(h.reads.map((r) => r.path)).toEqual([C])
  })
  it('an ad of a sequenced ad set, and a dynamic creative ad: undeletable alone', async () => {
    const ad = (adset: Record<string, unknown>) => ({ id: A, account_id: '1234567890', status: 'PAUSED', effective_status: 'PAUSED', adset_id: S, campaign_id: C, creative: { id: '1' }, adset: { id: S, ...adset } })
    h.answers[A] = ad({ creative_sequence: { data: [{ id: '120000000000077' }] } })
    expect((await liveRemoveObjects(target, [{ kind: 'ad', id: A }])).objects.get(`ad:${A}`)!.undeletable).toMatch(/sequence/)
    h.answers[A] = ad({ is_dynamic_creative: true })
    expect((await liveRemoveObjects(target, [{ kind: 'ad', id: A }])).objects.get(`ad:${A}`)!.undeletable).toMatch(/1340029/)
    h.answers[A] = ad({ creative_sequence: [], is_dynamic_creative: false })
    expect((await liveRemoveObjects(target, [{ kind: 'ad', id: A }])).objects.get(`ad:${A}`)).toMatchObject({ undeletable: null, adSetId: S, campaignId: C, creativeId: '1' })
  })
  it('an ad set under a campaign budget: the campaign\'s other ad sets; without one: none read', async () => {
    h.answers[S] = { id: S, account_id: '1234567890', status: 'ACTIVE', effective_status: 'ACTIVE', optimization_goal: 'LINK_CLICKS', billing_event: 'IMPRESSIONS', campaign_id: C, campaign: { id: C, name: 'Campaign A', daily_budget: '5000' } }
    h.answers[`${C}/adsets`] = { data: [{ id: S, effective_status: 'ACTIVE' }, { id: '120000000000012', effective_status: 'ACTIVE' }] }
    expect((await liveRemoveObjects(target, [{ kind: 'adset', id: S }])).objects.get(`adset:${S}`)!.campaignBudget).toEqual({ campaignId: C, name: 'Campaign A', otherAdSets: [{ id: '120000000000012', effectiveStatus: 'ACTIVE' }], more: false })
    h.answers[S] = { ...(h.answers[S] as object), campaign: { id: C, name: 'Campaign A', daily_budget: '0' } }
    h.reads = []
    expect((await liveRemoveObjects(target, [{ kind: 'adset', id: S }])).objects.get(`adset:${S}`)!.campaignBudget).toBeNull()
    expect(h.reads.map((r) => r.path)).toEqual([S, `${S}/ads`])
  })
})

describe('the account\'s ads by creative, images, Instant Experience parts', () => {
  it('ads by the creative they use, only the account\'s own', async () => {
    h.answers['act_1234567890/ads'] = { data: [
      { id: A, account_id: '1234567890', effective_status: 'ACTIVE', creative: { id: '120000000000040' } },
      { id: '120000000000004', account_id: '5555555555', creative: { id: '120000000000040' } },
    ] }
    const read = await liveAdsByCreative(target)
    expect(read.byCreative.get('120000000000040')).toEqual([{ id: A, name: null, effectiveStatus: 'ACTIVE' }])
  })
  it('images by hash, with the creatives Meta lists (a list or {data})', async () => {
    h.answers['act_1234567890/adimages'] = { data: [
      { hash: 'abc', name: 'a.jpg', status: 'ACTIVE', creatives: ['120000000000041'] },
      { hash: 'def', status: 'ACTIVE', creatives: { data: [{ id: '120000000000042' }] } },
      { hash: 'zzz', status: 'ACTIVE' },
    ] }
    const images = await liveRemoveImages(target, ['abc', 'def'])
    expect([...images.values()]).toEqual([{ hash: 'abc', name: 'a.jpg', status: 'ACTIVE', creatives: ['120000000000041'] }, { hash: 'def', name: null, status: 'ACTIVE', creatives: ['120000000000042'] }])
    expect(h.reads[0].query.hashes).toEqual(['abc', 'def'])
  })
  it('an Instant Experience part\'s id: its row\'s or its element\'s', async () => {
    h.answers['120000000000080/canvas_elements'] = { data: [{ element: { id: '120000000000070' } }, { id: '120000000000071' }] }
    expect([...(await livePageCanvasElements(target, '120000000000080')).ids]).toEqual(['120000000000070', '120000000000071'])
  })
})
