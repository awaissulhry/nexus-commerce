/**
 * Google Ads Shopping (2026-10-15, G4) — set-google-inventory-filter and set-google-shopping-settings as the approval gate
 * uses them (Google, the account and the live reads are stand-ins): a Nexus change a person approves, the preview built on
 * Google's check, one request when it runs, a record that names the account, and an undo that puts back what it replaced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  state: { campaign: null as unknown, scopes: [] as unknown[] },
}))
vi.mock('../../marketing/google-ads/change-account.js', () => ({
  googleChangeAccount: vi.fn(async () => ({
    target: { connectionId: 'g-1', customerId: '1234567890', loginCustomerId: null }, accountId: 'g-1', customerId: '1234567890', name: 'Shop', currency: 'EUR', timeZone: 'Europe/Rome',
  })),
}))
vi.mock('../../marketing/google-ads/live-shopping.js', async (importActual) => {
  const actual = await importActual<typeof import('../../marketing/google-ads/live-shopping.js')>()
  return {
    ...actual,
    liveShoppingState: vi.fn(async () => ({
      campaign: actual.shoppingCampaignOf(structuredClone(h.state.campaign) as Record<string, unknown>),
      filters: (structuredClone(h.state.scopes) as Record<string, unknown>[]).map(actual.inventoryFilterOf),
    })),
  }
})
vi.mock('../../marketing/google-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/write-client.js')>()),
  mutateGoogleAds: h.mutate,
}))
vi.mock('../../marketing/google-ads/enqueue.js', () => ({ enqueueGoogleAdsSync: vi.fn(async () => ({ queued: true, reason: null })) }))

import { GOOGLE_ADS_SHOPPING_TOOLS } from './google-ads-shopping.tools.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import type { ToolContext } from '../tool-types.js'

const tool = (name: string) => GOOGLE_ADS_SHOPPING_TOOLS.find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })
const C = 'customers/1234567890'
const scope = (id: string, dimensions: unknown[]) => ({ campaignCriterion: { criterionId: id, listingScope: { dimensions } } })

beforeEach(() => {
  h.mutate.mockReset()
  h.state.campaign = { campaign: { id: '21', name: 'Shop A', status: 'ENABLED', advertisingChannelType: 'SHOPPING', shoppingSetting: { merchantId: '5', feedLabel: 'IT' } } }
  h.state.scopes = [scope('61', [{ productBrand: { value: 'Brand A' } }])]
})

describe('G4 Shopping tools', () => {
  it('both are Nexus changes a person approves: alwaysAsk, ask at most, reach Google, their re-check fields declared', () => {
    for (const t of GOOGLE_ADS_SHOPPING_TOOLS) {
      expect(t).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', openWorld: true, readOnly: false, riskTier: 'high', requiresApprovalDefault: true })
      expect(MATERIAL_PREVIEW_FIELDS[t.name]).toEqual(['basis', 'plan', 'reach'])
    }
  })

  it('set-google-inventory-filter: Google checks it; clearing SPENDS MONEY; one request when it runs; undo sets the old filter again on the same account', async () => {
    const filter = tool('set-google-inventory-filter')
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const out = await filter.handler({ campaignId: '21', clear: true }, asker)
    expect(out.ok, String(out.error)).toBe(true)
    expect(h.mutate.mock.calls[0][1]).toEqual([{ campaignCriterionOperation: { remove: `${C}/campaignCriteria/21~61` } }])
    expect(h.mutate.mock.calls[0][2]).toEqual({ validateOnly: true })
    expect(out.preview).toMatchObject({ spendsMoney: true, googleCheck: { checked: true, accepted: true } })
    h.mutate.mockResolvedValue({ responses: [{}], ops: 1, requestId: 'r' })
    const run = await filter.execute!({ campaignId: '21', clear: true }, approved(out.preview))
    expect(run.ok).toBe(true)
    expect(run.change).toEqual({
      before: { campaignId: '21', filter: [{ dimension: 'BRAND', value: 'Brand A' }], criterionId: '61', accountId: 'g-1', customerId: '1234567890' },
      after: { campaignId: '21', filter: [], criterionId: null, accountId: 'g-1', customerId: '1234567890' },
    })
    h.state.scopes = []
    expect(await filter.undo!.current(run.change!)).toEqual(run.change!.after)
    const undo = filter.undo!.request(run.change!) as { tool: string; args: Record<string, unknown> }
    expect(undo).toMatchObject({ tool: 'set-google-inventory-filter', args: { accountId: 'g-1', campaignId: '21', filter: [{ dimension: 'BRAND', value: 'Brand A' }] } })
    expect(filter.input.safeParse(undo.args).success).toBe(true)
  })

  it('set-google-inventory-filter: a new filter records the id Google gave it; a filter that moved since approval is not sent', async () => {
    const filter = tool('set-google-inventory-filter')
    const ask = { campaignId: '21', filter: [{ dimension: 'BRAND', value: 'Brand A' }, { dimension: 'CUSTOM_LABEL_1', value: 'sale' }] }
    h.mutate.mockResolvedValue({ responses: [], ops: 2, requestId: null })
    const preview = (await filter.handler(ask, asker)).preview
    expect(preview).toMatchObject({ spendsMoney: false })
    h.mutate.mockResolvedValue({ responses: [{}, { campaignCriterionResult: { resourceName: `${C}/campaignCriteria/21~88` } }], ops: 2, requestId: 'r' })
    const run = await filter.execute!(ask, approved(preview))
    expect(run.change?.after).toMatchObject({ criterionId: '88' })
    h.mutate.mockClear()
    h.state.scopes = [scope('62', [{ productBrand: { value: 'Brand B' } }])]
    const moved = await filter.execute!(ask, approved(preview))
    expect(moved.ok).toBe(false)
    expect(moved.error).toMatch(/changed since this was approved/)
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('set-google-shopping-settings: local products on SPENDS MONEY; undo puts the old values back and parses as the tool\'s own arguments', async () => {
    const settings = tool('set-google-shopping-settings')
    const ask = { campaignId: '21', localInventory: true, clearFeedLabel: true }
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const out = await settings.handler(ask, asker)
    expect(out.ok, String(out.error)).toBe(true)
    expect(h.mutate.mock.calls[0][1]).toEqual([{ campaignOperation: { update: { resourceName: `${C}/campaigns/21`, shoppingSetting: { enableLocal: true } }, updateMask: 'shopping_setting.feed_label,shopping_setting.enable_local' } }])
    expect((out.preview as { spendsMoneyBecause: string[] }).spendsMoneyBecause).toHaveLength(2)
    h.mutate.mockResolvedValue({ responses: [{}], ops: 1, requestId: 'r' })
    const run = await settings.execute!(ask, approved(out.preview))
    expect(run.change?.before).toMatchObject({ campaignId: '21', settings: { feedLabel: 'IT', localInventory: false } })
    h.state.campaign = { campaign: { id: '21', name: 'Shop A', status: 'ENABLED', advertisingChannelType: 'SHOPPING', shoppingSetting: { merchantId: '5', enableLocal: true } } }
    expect(await settings.undo!.current(run.change!)).toEqual(run.change!.after)
    const undo = settings.undo!.request(run.change!) as { tool: string; args: Record<string, unknown> }
    expect(undo).toMatchObject({ tool: 'set-google-shopping-settings', args: { accountId: 'g-1', campaignId: '21', feedLabel: 'IT', localInventory: false } })
    expect(settings.input.safeParse(undo.args).success).toBe(true)
  })
})
