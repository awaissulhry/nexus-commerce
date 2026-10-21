/**
 * Meta step 22 — remove-meta-ads-items as the approval gate uses it (Meta, the account and the live reads are stand-ins):
 * the change contract of every Meta change tool; explicit ask only (confirmDelete must be true, the description says so and
 * points a stop to set-meta-status); no undo; a preview from the live state listing everything that goes; Meta never asked
 * to check a delete; a run only as a request a person approved, request by request — a creative that stands on the delete of
 * its ad is not sent when that delete did not happen; the record names what was deleted. Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  account: { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' } as Record<string, unknown> | { refusal: string },
  objects: new Map<string, Record<string, unknown>>(),
  users: new Map<string, Array<{ id: string; name: string | null; effectiveStatus: string | null }>>(),
  videoUsers: new Map<string, Array<{ id: string; name: string | null; effectiveStatus: string | null }>>(),
  check: vi.fn(),
  send: vi.fn(),
  stored: vi.fn(async () => 1),
}))
vi.mock('../../marketing/meta-ads/change-account.js', () => ({ metaChangeAccount: vi.fn(async () => h.account) }))
vi.mock('../../marketing/meta-ads/live-remove.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live-remove.js')>()),
  liveRemoveObjects: vi.fn(async (_t: unknown, items: Array<{ kind: string; id: string }>) => ({
    objects: new Map(items.filter((i) => h.objects.has(`${i.kind}:${i.id}`)).map((i) => [`${i.kind}:${i.id}`, structuredClone(h.objects.get(`${i.kind}:${i.id}`))])),
    problems: items.filter((i) => !h.objects.has(`${i.kind}:${i.id}`)).map((i) => `Meta does not find ${i.kind} ${i.id} (or the system user cannot see it): nothing to delete.`),
  })),
  liveRemoveCreatives: vi.fn(async (_t: unknown, ids: string[]) => ({ creatives: new Map(ids.map((id) => [id, { id, name: 'Creative C', status: 'ACTIVE', objectType: 'SHARE' }])), problems: [] })),
  liveAdsByCreative: vi.fn(async (_t: unknown, withVideos?: boolean) => ({ byCreative: h.users, byVideo: withVideos ? h.videoUsers : null, more: false })),
  liveRemoveImages: vi.fn(async () => new Map()),
  liveCreativeStatus: vi.fn(async () => null),
  liveVideoLibrary: vi.fn(async () => ({ videos: new Map([['120000000000060', { description: null, createdTime: null }]]), more: false })),
  liveVideoCaptions: vi.fn(async () => ({ locales: [] })),
  livePageCanvasElements: vi.fn(async () => ({ ids: new Set(), more: false })),
}))
vi.mock('../../marketing/meta-ads/live.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live.js')>()),
  metaChosenAccount: vi.fn(async () => ({ pageId: null })),
}))
vi.mock('../../marketing/meta-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/write-client.js')>()),
  metaCheckChange: h.check,
  metaSendChange: h.send,
}))
vi.mock('../../marketing/meta-ads/store.js', () => ({ recordStatusReadBack: h.stored }))

import { META_ADS_REMOVE_TOOLS } from './meta-ads-remove.tools.js'
import { META_CHANGE_RULES } from './meta-ads-kit.js'
import { MetaWriteError } from '../../marketing/meta-ads/write-client.js'
import { localFailure } from '../../marketing/meta-ads/errors.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { __metaObjectLimitsTest } from '../../gateway/meta-object-limits.js'
import type { ToolContext, ToolResult } from '../tool-types.js'

const tool = META_ADS_REMOVE_TOOLS[0]
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })
const ask = (args: Record<string, unknown>) => tool.input.parse({ confirmDelete: true, ...args }) as Record<string, unknown>
const preview = async (args: Record<string, unknown>, ctx = asker) => (await tool.handler(ask(args), ctx)) as ToolResult & { preview: Record<string, any> }
const run = async (args: Record<string, unknown>, p: unknown) => (await tool.execute!(ask(args), approved(p))) as ToolResult & { data: Record<string, any> }

const C = '120000000000001'
const S = '120000000000002'
const A = '120000000000003'
const CR = '120000000000040'
const base = { name: null, status: 'PAUSED', effectiveStatus: 'PAUSED', campaignId: null, adSetId: null, creativeId: null, undeletable: null, children: [], childrenMore: false, campaignBudget: null }

beforeEach(() => {
  __metaObjectLimitsTest.useMemory()
  vi.unstubAllEnvs()
  vi.stubEnv('NEXUS_META_ADS_WRITES', 'on')
  h.check.mockReset(); h.send.mockReset(); h.stored.mockClear()
  h.send.mockImplementation(async () => ({ node: { success: true }, readBack: 'none', waitedMs: 0 }))
  h.objects = new Map([
    [`campaign:${C}`, { ...base, kind: 'campaign', id: C, name: 'Campaign A', status: 'ACTIVE', effectiveStatus: 'ACTIVE', children: [
      { kind: 'adset', id: S, name: 'Ad set B', status: 'ACTIVE', effectiveStatus: 'ACTIVE', creativeId: null },
      { kind: 'ad', id: '120000000000013', name: 'Ad old', status: 'ARCHIVED', effectiveStatus: 'ARCHIVED', creativeId: null },
    ] }],
    [`ad:${A}`, { ...base, kind: 'ad', id: A, name: 'Ad 1', adSetId: '120000000000022', campaignId: '120000000000021', creativeId: CR }],
  ])
  h.users = new Map([[CR, [{ id: A, name: 'Ad 1', effectiveStatus: 'PAUSED' }]]])
  h.videoUsers = new Map()
})

describe('the change contract', () => {
  it('alwaysAsk at ask, high risk, open world, no undo (reversibility none), ads.campaigns.manage, the Meta rules line, material fields', () => {
    expect(tool).toMatchObject({ name: 'remove-meta-ads-items', alwaysAsk: true, maxClaudeTrust: 'ask', riskTier: 'high', requiresApprovalDefault: true, openWorld: true, readOnly: false, category: 'advertising', reversibility: 'none', requires: ['ads.campaigns.manage'] })
    expect(tool.undo).toBeUndefined()
    expect(tool.description.endsWith(META_CHANGE_RULES)).toBe(true)
    expect(MATERIAL_PREVIEW_FIELDS['remove-meta-ads-items']).toEqual(['basis', 'plan', 'reach'])
  })
  it('explicit ask only: confirmDelete must be literally true; the description says so and points a stop to a pause', () => {
    expect(() => tool.input.parse({ items: [{ kind: 'campaign', id: C }] })).toThrow()
    expect(() => tool.input.parse({ items: [{ kind: 'campaign', id: C }], confirmDelete: false })).toThrow()
    expect(() => tool.input.parse({ items: [{ kind: 'campaign', id: C }], confirmDelete: 'yes' })).toThrow()
    expect(tool.description).toMatch(/only when the person explicitly asked to DELETE \(confirmDelete true\)/)
    expect(tool.description).toMatch(/Never for a pause, an archive or "stop".*pause it \(set-meta-status\)/)
    expect(tool.description).toMatch(/FINAL, no undo/)
    expect(() => tool.input.parse({ items: Array.from({ length: 51 }, () => ({ kind: 'ad', id: A })), confirmDelete: true })).toThrow()
  })
  it('each kind takes exactly what names it', async () => {
    expect(await preview({ items: [{ kind: 'image', id: C }] })).toEqual({ ok: false, error: expect.stringMatching(/an image is named by its hash only/) })
    expect(await preview({ items: [{ kind: 'captions', id: C }] })).toEqual({ ok: false, error: expect.stringMatching(/the video's id and the locales/) })
    expect(await preview({ items: [{ kind: 'campaign', id: C, hash: 'abc' }] })).toEqual({ ok: false, error: expect.stringMatching(/by its Meta id only/) })
  })
})

describe('preview', () => {
  it('lists everything that goes, says what stops; Meta is never asked to check a delete; nothing spends', async () => {
    const r = await preview({ items: [{ kind: 'campaign', id: C }] })
    expect(r.ok).toBe(true)
    expect(h.check).not.toHaveBeenCalled()
    expect(r.preview).toMatchObject({ spendsMoney: false, metaCheck: { checked: 'none', sentence: expect.stringMatching(/Meta has no check for this change/) }, requests: [{ step: 1, label: `Delete campaign "Campaign A" (${C}) with its 1 ad set and 1 ad`, metaCheck: 'no-check' }] })
    expect(r.preview.alsoDeleted).toEqual([{ deleting: `campaign "Campaign A" (${C})`, adSets: [expect.objectContaining({ id: S })], ads: [expect.objectContaining({ id: '120000000000013', status: 'ARCHIVED' })] }])
    expect(r.preview.warnings.join(' ')).toMatch(/DELETING IS FINAL/)
    expect(r.preview.basis).toMatch(/\w/)
  })
  it('a creative an ad still uses is refused in words; Meta not found is refused in words', async () => {
    expect(await preview({ items: [{ kind: 'creative', id: CR }] })).toEqual({ ok: false, error: expect.stringMatching(/^Nothing is deleted: Creative "Creative C" \(120000000000040\) is used by 1 ad/) })
    expect(await preview({ items: [{ kind: 'adset', id: '120000000000099' }] })).toEqual({ ok: false, error: expect.stringMatching(/Meta does not find adset 120000000000099/) })
  })
  it('the business has no Meta account chosen: refused in words', async () => {
    h.account = { refusal: 'No Meta ad account is chosen for this business yet.' }
    expect(await preview({ items: [{ kind: 'campaign', id: C }] })).toEqual({ ok: false, error: 'No Meta ad account is chosen for this business yet.' })
    h.account = { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' }
  })
})

describe('run', () => {
  it('only as a request a person approved; then request by request, recorded; Nexus\'s stored row marked deleted', async () => {
    const args = { items: [{ kind: 'campaign', id: C }] }
    const p = (await preview(args)).preview
    expect(await tool.execute!(ask(args), { ...approved(p), approvedByPerson: false })).toMatchObject({ ok: false })
    expect(h.send).not.toHaveBeenCalled()
    const r = await run(args, p)
    expect(r.ok).toBe(true)
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: C, kind: 'campaign', method: 'DELETE', params: {}, operation: 'campaign.delete' })
    expect(r.data).toMatchObject({ done: 1, of: 1, deleted: [{ kind: 'campaign', id: C }], noUndo: expect.stringMatching(/final/) })
    expect(r.data.steps[0]).toMatchObject({ outcome: 'done', sentence: expect.stringMatching(/Meta confirmed it/) })
    expect(r.change).toMatchObject({ before: { op: 'remove', items: [{ kind: 'campaign', id: C, ads: 1, adSets: 1 }], accountId: 'm-1', adAccountId: '1234567890' }, after: { op: 'remove', items: [{ kind: 'campaign', id: C, status: 'DELETED' }] } })
    expect(h.stored).toHaveBeenCalledWith('1234567890', [{ kind: 'campaign', id: C, status: 'DELETED', effectiveStatus: 'DELETED' }])
  })
  it('a creative that stands on the delete of its ad is not sent when Meta refused that delete', async () => {
    const args = { items: [{ kind: 'creative', id: CR }, { kind: 'ad', id: A }] }
    const p = (await preview(args)).preview
    expect(p.requests.map((x: { label: string }) => x.label)).toEqual([`Delete ad "Ad 1" (${A})`, `Delete creative "Creative C" (${CR})`])
    h.send.mockImplementationOnce(async () => { throw new MetaWriteError(localFailure('Meta refused it (100): Invalid parameter. Nothing was changed.', '100'), 'ad.delete', 'refused') })
    const r = await run(args, p)
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ ok: false })
    expect(JSON.stringify(r)).toMatch(/not sent — it stands on step 1 of this change, which did not happen as asked/)
  })
  it('review A5 — a partial run of a delete says there is no undo, never "Undo puts back only what Meta made"', async () => {
    const args = { items: [{ kind: 'ad', id: A }, { kind: 'campaign', id: C }] }
    const p = (await preview(args)).preview
    h.send.mockImplementationOnce(async () => ({ node: { success: true }, readBack: 'none', waitedMs: 0 }))
    h.send.mockImplementationOnce(async () => { throw new MetaWriteError(localFailure('Meta refused it (100): Invalid parameter. Nothing was changed.', '100'), 'campaign.delete', 'refused') })
    const r = await run(args, p)
    expect(r.data.sentence).toBe('Meta made 1 of 2 requests as asked; the steps say what happened to each. A deletion on Meta is final: there is no undo, also for what Meta did delete.')
    expect(r.data.sentence).not.toMatch(/Undo puts back/)
  })
  it('review B1 — a video an ad still shows is refused; read with the creatives\' video fields', async () => {
    h.videoUsers = new Map([['120000000000060', [{ id: A, name: 'Ad 1', effectiveStatus: 'ACTIVE' }]]])
    expect(await preview({ items: [{ kind: 'video', id: '120000000000060' }] })).toEqual({ ok: false, error: expect.stringMatching(/Video 120000000000060 is named by the creative of 1 ad this change does not delete/) })
    const ok = await preview({ items: [{ kind: 'video', id: '120000000000060' }, { kind: 'ad', id: A }] })
    expect(ok.preview.requests.map((x: { label: string }) => x.label)).toEqual([`Delete ad "Ad 1" (${A})`, 'Remove video 120000000000060 from the ad account\'s library'])
  })
  it('a changed live state (a new ad set under the campaign) is not run', async () => {
    const args = { items: [{ kind: 'campaign', id: C }] }
    const p = (await preview(args)).preview
    const campaign = h.objects.get(`campaign:${C}`)!
    h.objects.set(`campaign:${C}`, { ...campaign, children: [...(campaign.children as unknown[]), { kind: 'adset', id: '120000000000033', name: 'New', status: 'ACTIVE', effectiveStatus: 'ACTIVE', creativeId: null }] })
    const r = await run(args, p)
    expect(r).toMatchObject({ ok: false })
    expect(JSON.stringify(r)).toMatch(/changed since this was approved/)
    expect(h.send).not.toHaveBeenCalled()
  })
})
