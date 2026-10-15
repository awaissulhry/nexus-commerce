/**
 * Google Ads changes, G5 (2026-10-15) — the label tools as the approval gate uses them (Google, the account and the live
 * reads are stand-ins): the preview is built on Google's check (validate_only) and spends nothing; the run is ONE request
 * of an approved change, as a person; undo puts names and links back; a removal needs the person's explicit ask and is
 * never undone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  enqueue: vi.fn(async () => ({ queued: true, reason: null })),
  live: { labels: [] as unknown[], links: [] as unknown[], campaigns: [] as unknown[], items: [] as unknown[] },
}))
vi.mock('../../marketing/google-ads/change-account.js', () => ({
  googleChangeAccount: vi.fn(async () => ({
    target: { connectionId: 'g-1', customerId: '1234567890', loginCustomerId: null }, accountId: 'g-1', customerId: '1234567890', name: 'Shop', currency: 'EUR', timeZone: 'Europe/Rome',
  })),
}))
vi.mock('../../marketing/google-ads/live-labels.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live-labels.js')>()),
  liveLabels: vi.fn(async () => structuredClone(h.live.labels)),
  liveLabelLinks: vi.fn(async (_t: unknown, ids: string[], kinds: string[]) => structuredClone(h.live.links).filter((l: any) => ids.includes(l.labelId) && kinds.includes(l.kind))),
}))
vi.mock('../../marketing/google-ads/live.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live.js')>()),
  liveCampaigns: vi.fn(async () => structuredClone(h.live.campaigns)),
}))
vi.mock('../../marketing/google-ads/live-campaigns.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live-campaigns.js')>()),
  liveStatuses: vi.fn(async () => structuredClone(h.live.items)),
}))
vi.mock('../../marketing/google-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/write-client.js')>()),
  mutateGoogleAds: h.mutate,
}))
vi.mock('../../marketing/google-ads/enqueue.js', () => ({ enqueueGoogleAdsSync: h.enqueue }))

import { GOOGLE_ADS_LABELS_TOOLS } from './google-ads-labels.tools.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import type { ToolContext } from '../tool-types.js'

const tool = (name: string) => GOOGLE_ADS_LABELS_TOOLS.find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })
const C1 = { campaignId: '21', name: 'Search A', status: 'ENABLED', servingStatus: null, primaryStatus: null, type: 'SEARCH', subType: null, bidding: 'MANUAL_CPC', start: null, end: null, shopping: null, budget: null }

beforeEach(() => {
  h.mutate.mockReset()
  h.enqueue.mockClear()
  vi.unstubAllEnvs()
  h.live.labels = [{ labelId: '61', name: 'Brand', color: '#ff0000', description: null }]
  h.live.links = [{ labelId: '61', kind: 'keyword', id: '51~601', name: 'shoes' }]
  h.live.campaigns = [C1]
  h.live.items = []
})

describe('set-google-labels', () => {
  const ask = { create: [{ name: 'Promo' }], attach: [{ newLabel: 'Promo', kind: 'campaign', id: '21' }], detach: [{ labelId: '61', kind: 'keyword', id: '51~601' }], edit: [{ labelId: '61', name: 'Brand 2' }] }

  it('is a Nexus change a person approves: alwaysAsk, ask at most, reaches Google, its re-check fields declared', () => {
    for (const t of GOOGLE_ADS_LABELS_TOOLS) {
      expect(t).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', openWorld: true, readOnly: false, riskTier: 'high' })
      expect(MATERIAL_PREVIEW_FIELDS[t.name]).toEqual(['basis', 'plan', 'reach'])
    }
    expect(tool('remove-google-labels').reversibility).toBe('none')
    expect(tool('remove-google-labels').input.safeParse({ labelIds: ['61'] }).success).toBe(false)
  })

  it('preview on Google\'s check, nothing spends; the run is ONE request, the record names the new label; undo puts it back', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 4, requestId: null })
    const out = await tool('set-google-labels').handler(ask, asker)
    expect(out.ok).toBe(true)
    expect(h.mutate.mock.calls[0][2]).toEqual({ validateOnly: true })
    expect(out.preview).toMatchObject({ spendsMoney: false, operations: 4, googleCheck: { checked: true, accepted: true } })
    h.mutate.mockReset()
    h.mutate.mockResolvedValue({ responses: [{ labelResult: { resourceName: 'customers/1234567890/labels/62' } }, {}, {}, {}], ops: 4, requestId: 'r' })
    const run = await tool('set-google-labels').execute!(ask, approved(out.preview))
    expect(run.ok).toBe(true)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    expect(h.mutate.mock.calls[0][2]).toMatchObject({ validateOnly: false })
    expect(run.change!.after).toMatchObject({
      created: [{ labelId: '62', name: 'Promo' }],
      edited: [{ labelId: '61', name: 'Brand 2' }],
      attached: [{ labelId: '62', kind: 'campaign', id: '21' }],
      detached: [{ labelId: '61', kind: 'keyword', id: '51~601' }],
      accountId: 'g-1', customerId: '1234567890',
    })
    // The account now reads as the change left it: undo may run, and asks for the opposite through the same tool.
    h.live.labels = [{ labelId: '61', name: 'Brand 2', color: '#ff0000', description: null }, { labelId: '62', name: 'Promo', color: null, description: null }]
    h.live.links = [{ labelId: '62', kind: 'campaign', id: '21', name: 'Search A' }]
    expect(await tool('set-google-labels').undo!.current(run.change!)).toEqual(run.change!.after)
    const undo = tool('set-google-labels').undo!.request(run.change!)
    expect(undo).toEqual({
      tool: 'set-google-labels',
      args: {
        accountId: 'g-1',
        edit: [{ labelId: '61', name: 'Brand', description: '', color: '#ff0000' }],
        detach: [{ labelId: '62', kind: 'campaign', id: '21' }],
        attach: [{ labelId: '61', kind: 'keyword', id: '51~601' }],
        why: 'undo of an earlier label change (the labels it made stay)',
      },
    })
    expect(tool('set-google-labels').input.safeParse((undo as { args: unknown }).args).success).toBe(true)
  })

  it('never by a rule', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 4, requestId: null })
    const preview = (await tool('set-google-labels').handler(ask, asker)).preview
    h.mutate.mockClear()
    const byRule = await tool('set-google-labels').execute!(ask, { ...approved(preview), approvedByPerson: false, decidedVia: 'auto' })
    expect(byRule.error).toMatch(/never by a rule/)
    expect(h.mutate).not.toHaveBeenCalled()
  })
})

describe('remove-google-labels', () => {
  it('says what carries the label; runs as one request; cannot be undone', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const ask = { labelIds: ['61'], confirmRemove: true }
    const out = await tool('remove-google-labels').handler(ask, asker)
    expect(out.preview).toMatchObject({ summary: 'Google Ads: REMOVE 1 label for good ("Brand").', changes: { 'label "Brand"': { from: 'on 1 keyword', to: 'REMOVED' } }, spendsMoney: false })
    h.mutate.mockResolvedValue({ responses: [{}], ops: 1, requestId: null })
    const run = await tool('remove-google-labels').execute!(ask, approved(out.preview))
    expect(run.ok).toBe(true)
    expect(h.mutate.mock.calls.at(-1)![1]).toEqual([{ labelOperation: { remove: 'customers/1234567890/labels/61' } }])
    expect(tool('remove-google-labels').undo).toBeUndefined()
  })
})
