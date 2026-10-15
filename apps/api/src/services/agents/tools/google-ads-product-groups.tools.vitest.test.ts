/**
 * Google Ads changes (2026-10-15) — set-google-product-groups as the approval gate uses it (Google, the account and the
 * live tree are stand-ins): the preview is built on Google's check (validate_only), says what spends money and that
 * "everything else" is excluded; a campaign that is not Standard Shopping is refused before Google is asked; the gate's
 * re-check reads again without asking Google twice; a run is ONE request, only when the tree did not move; undo rebuilds
 * the old tree split by item ID, or puts the old bids back, on the same Google account.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  enqueue: vi.fn(async () => ({ queued: true, reason: null })),
  state: { adGroup: null as unknown, rows: [] as unknown[] },
}))
vi.mock('../../marketing/google-ads/change-account.js', () => ({
  googleChangeAccount: vi.fn(async () => ({
    target: { connectionId: 'g-1', customerId: '1234567890', loginCustomerId: null }, accountId: 'g-1', customerId: '1234567890', name: 'Shop', currency: 'EUR', timeZone: 'Europe/Rome',
  })),
}))
vi.mock('../../marketing/google-ads/live-product-groups.js', async (importActual) => {
  const actual = await importActual<typeof import('../../marketing/google-ads/live-product-groups.js')>()
  return {
    ...actual,
    liveProductGroupTree: vi.fn(async () => ({ adGroup: structuredClone(h.state.adGroup), nodes: (structuredClone(h.state.rows) as Record<string, unknown>[]).map(actual.productGroupNodeOf) })),
  }
})
vi.mock('../../marketing/google-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/write-client.js')>()),
  mutateGoogleAds: h.mutate,
}))
vi.mock('../../marketing/google-ads/enqueue.js', () => ({ enqueueGoogleAdsSync: h.enqueue }))

import { GOOGLE_ADS_PRODUCT_GROUPS_TOOLS } from './google-ads-product-groups.tools.js'
import { GoogleAdsWriteError } from '../../marketing/google-ads/write-client.js'
import { localFailure } from '../../marketing/google-ads/errors.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import type { ToolContext } from '../tool-types.js'

const tool = GOOGLE_ADS_PRODUCT_GROUPS_TOOLS.find((t) => t.name === 'set-google-product-groups')!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const recheck: ToolContext = { can: () => true, via: 'system', approvalId: 'ap-1' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })

const AGC = 'customers/1234567890/adGroupCriteria/51~'
const GROUP = {
  adGroupId: '51', name: 'Group A', status: 'ENABLED', type: 'SHOPPING_PRODUCT_ADS',
  campaign: { campaignId: '21', name: 'Shop A', status: 'ENABLED', type: 'SHOPPING', bidding: 'MANUAL_CPC' },
}
const row = (id: string, parent: string | null, type: string, caseValue: unknown, extra: Record<string, unknown> = {}) => ({
  adGroup: { id: '51' },
  adGroupCriterion: { criterionId: id, listingGroup: { type, ...(parent ? { parentAdGroupCriterion: `${AGC}${parent}` } : {}), ...(caseValue ? { caseValue } : {}) }, ...extra },
})
/** A hand-built tree: sku-1 at EUR 0.30, and "everything else" left ADVERTISED at EUR 0.20 (the 2026-10-15 lesson). */
const HAND_BUILT = [
  row('601', null, 'SUBDIVISION', null),
  row('602', '601', 'UNIT', { productItemId: { value: 'sku-1' } }, { cpcBidMicros: '300000' }),
  row('603', '601', 'UNIT', { productItemId: {} }, { cpcBidMicros: '200000' }),
]
const ACCOUNT = { accountId: 'g-1', customerId: '1234567890' }

beforeEach(() => {
  h.mutate.mockReset()
  h.enqueue.mockClear()
  vi.unstubAllEnvs()
  h.state.adGroup = structuredClone(GROUP)
  h.state.rows = structuredClone(HAND_BUILT)
})

describe('set-google-product-groups', () => {
  const ask = { campaignId: '21', adGroupId: '51', itemIds: ['SKU-1', 'SKU-2'], bidCents: 30 }

  it('is a Nexus change a person approves: alwaysAsk, ask at most, reaches Google, its re-check fields declared', () => {
    expect(tool).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', openWorld: true, readOnly: false, riskTier: 'high', requiresApprovalDefault: true })
    expect(MATERIAL_PREVIEW_FIELDS[tool.name]).toEqual(['basis', 'plan', 'reach'])
  })

  it('preview: Google checks the whole new tree (validateOnly); "everything else" goes from advertised to EXCLUDED; the raise is SPENDS MONEY', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 5, requestId: null })
    const out = await tool.handler(ask, asker)
    expect(out.ok).toBe(true)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    expect(h.mutate.mock.calls[0][2]).toEqual({ validateOnly: true })
    const ops = h.mutate.mock.calls[0][1] as unknown[]
    expect(ops[0]).toEqual({ adGroupCriterionOperation: { remove: `${AGC}601` } })
    expect(ops).toHaveLength(5)
    expect(out.preview).toMatchObject({
      spendsMoney: true,
      spendsMoneyBecause: ['Raises the bid of 1 item in "Group A": "SKU-2" EUR 0.20 → EUR 0.30.'],
      changes: { '"everything else" (every other product of the feed)': { from: 'EUR 0.20 a click', to: 'excluded' } },
      totals: { operations: 5, units: 3, excluded: 1, itemsWithBid: 2 },
      googleCheck: { checked: true, accepted: true },
      reach: { mode: 'live', accountId: 'g-1', customerId: '1234567890' },
      operations: 5,
    })
    expect((out.preview as { warnings: string[] }).warnings).toContain('After this change only the items named here can be advertised in "Group A": everything else is excluded.')
  })

  it('a campaign that is not Standard Shopping, or an ad group of another campaign: refused before Google is asked', async () => {
    h.state.adGroup = { ...structuredClone(GROUP), campaign: { ...GROUP.campaign, type: 'PERFORMANCE_MAX' } }
    expect((await tool.handler(ask, asker)).error).toMatch(/is a PERFORMANCE_MAX campaign: product groups belong to Standard Shopping/)
    h.state.adGroup = structuredClone(GROUP)
    expect((await tool.handler({ ...ask, campaignId: '22' }, asker)).error).toBe('Ad group "Group A" (51) belongs to campaign "Shop A" (21), not to campaign 22.')
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('a change Google would refuse is never queued: the answer says why', async () => {
    h.mutate.mockRejectedValue(new GoogleAdsWriteError({ ...localFailure('x', 'X'), errors: [{ group: 'criterionError', code: 'LISTING_GROUP_SUBDIVISION_REQUIRES_OTHERS_CASE', message: 'Subdivided listing groups must have an "others" case.', path: 'mutate_operations[1]' }] }, 'ads.mutate.check', 'refused', 5))
    const out = await tool.handler(ask, asker)
    expect(out).toEqual({ ok: false, error: 'Not queued: Google Ads refused it: Subdivided listing groups must have an "others" case. (at mutate_operations[1]). Nothing was changed.' })
  })

  it('the gate\'s re-check reads again but does not ask Google to check twice; the facts compare equal', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 5, requestId: null })
    const first = await tool.handler(ask, asker)
    h.mutate.mockClear()
    const again = await tool.handler(ask, recheck)
    expect(h.mutate).not.toHaveBeenCalled()
    const pick = (p: unknown) => { const { basis, plan, reach } = p as Record<string, unknown>; return { basis, plan, reach } }
    expect(pick(again.preview)).toEqual(pick(first.preview))
  })

  it('runs as ONE request; the record names the account; undo rebuilds the hand-built tree (its "everything else" bid too) on that account', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 5, requestId: null })
    const preview = (await tool.handler(ask, asker)).preview
    h.mutate.mockReset()
    h.mutate.mockResolvedValue({ responses: [{}, {}, {}, {}, {}], ops: 5, requestId: 'r' })
    const run = await tool.execute!(ask, approved(preview))
    expect(run.ok).toBe(true)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    expect(h.mutate.mock.calls[0][2]).toMatchObject({ validateOnly: false })
    expect(run.change).toEqual({
      before: { campaignId: '21', adGroupId: '51', tree: { kind: 'items', items: [{ itemId: 'sku-1', bidCents: 30, excluded: false }], everythingElse: { bidCents: 20, excluded: false } }, ...ACCOUNT },
      after: {
        campaignId: '21', adGroupId: '51',
        tree: { kind: 'items', items: [{ itemId: 'SKU-1', bidCents: 30, excluded: false }, { itemId: 'SKU-2', bidCents: 30, excluded: false }], everythingElse: { bidCents: null, excluded: true } },
        ...ACCOUNT,
      },
    })
    expect(h.enqueue).toHaveBeenCalledWith({ customerId: '1234567890', kind: 'MANUAL' })
    // Google now holds the new tree (new ids; it may answer the item ids in lower case): nothing moved since.
    h.state.rows = [
      row('701', null, 'SUBDIVISION', null),
      row('702', '701', 'UNIT', { productItemId: {} }, { negative: true }),
      row('703', '701', 'UNIT', { productItemId: { value: 'sku-1' } }, { cpcBidMicros: '300000' }),
      row('704', '701', 'UNIT', { productItemId: { value: 'sku-2' } }, { cpcBidMicros: '300000' }),
    ]
    expect(await tool.undo!.current(run.change!)).toEqual(run.change!.after)
    const undo = tool.undo!.request(run.change!)
    expect(undo).toEqual({
      tool: 'set-google-product-groups',
      args: { accountId: 'g-1', campaignId: '21', adGroupId: '51', itemIds: ['sku-1'], itemBids: [{ itemId: 'sku-1', bidCents: 30 }], includeEverythingElse: { bidCents: 20 }, why: 'undo of an earlier product group change' },
    })
    expect(tool.input.safeParse((undo as { args: unknown }).args).success).toBe(true)
  })

  it('a bid change: undo puts the old bid back by the same product group id', async () => {
    const bids = { campaignId: '21', adGroupId: '51', bids: [{ criterionId: '602', bidCents: 45 }] }
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const preview = await tool.handler(bids, asker)
    expect(preview.preview).toMatchObject({ spendsMoneyBecause: ['Raises the bid of item "sku-1" in "Group A" from EUR 0.30 to EUR 0.45 a click.'] })
    expect((preview.preview as { warnings: string[] }).warnings).toContain('"Everything else" in "Group A" is NOT excluded: every product of the feed that the tree does not name can be advertised.')
    h.mutate.mockResolvedValue({ responses: [{}], ops: 1, requestId: null })
    const run = await tool.execute!(bids, approved(preview.preview))
    expect(run.change?.after).toMatchObject({ bids: [{ criterionId: '602', bidCents: 45 }], ...ACCOUNT })
    expect(tool.undo!.request(run.change!)).toMatchObject({ args: { accountId: 'g-1', campaignId: '21', adGroupId: '51', bids: [{ criterionId: '602', bidCents: 30 }] } })
  })

  it('not sent when the tree moved since it was approved', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 5, requestId: null })
    const preview = (await tool.handler(ask, asker)).preview
    h.state.rows = HAND_BUILT.map((r) => (r.adGroupCriterion.criterionId === '603' ? row('603', '601', 'UNIT', { productItemId: {} }, { negative: true }) : r))
    h.mutate.mockClear()
    const run = await tool.execute!(ask, approved(preview))
    expect(run.ok).toBe(false)
    expect(run.error).toMatch(/changed since this was approved/)
    expect(h.mutate).not.toHaveBeenCalled()
  })
})
