/**
 * Google Ads programme 2, G8a (2026-10-15) — the conversion tools as the approval gate uses them (Google, the account, the
 * live reads, the business's orders and Nexus's records are stand-ins): each preview is built on Google's own check
 * (validate_only for a mutate, validateOnly for sales and adjustments); the run is ONE request of an approved change, as
 * a person, never by a rule; undo asks for the opposite through a registered tool. Ids, names and values are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  ingest: vi.fn(),
  adjust: vi.fn(),
  inFlight: vi.fn(async (): Promise<string | null> => null),
  enqueue: vi.fn(async () => ({ queued: true, reason: null })),
  live: {
    actions: [] as unknown[], accountGoals: [] as unknown[], campaignGoals: [] as unknown[], campaigns: [] as unknown[],
    rules: [] as unknown[], sets: [] as unknown[], orders: [] as unknown[], sent: new Map<string, string>(),
    tags: new Map<string, unknown[]>(),
  },
}))
vi.mock('../../marketing/google-ads/change-account.js', () => ({
  googleChangeAccount: vi.fn(async () => ({
    target: { connectionId: 'g-1', customerId: '1234567890', loginCustomerId: null }, accountId: 'g-1', customerId: '1234567890', name: 'Shop', currency: 'EUR', timeZone: 'Europe/Rome',
  })),
}))
vi.mock('../../marketing/google-ads/live-account.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live-account.js')>()),
  liveConversions: vi.fn(async () => ({ actions: structuredClone(h.live.actions), accountGoals: structuredClone(h.live.accountGoals), campaigns: structuredClone(h.live.campaignGoals), notRead: [] })),
  liveAccountSettings: vi.fn(async () => ({ conversionTracking: { conversionCustomerId: '1234567890', acceptedCustomerDataTerms: true } })),
}))
vi.mock('../../marketing/google-ads/live-conversions.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live-conversions.js')>()),
  liveBiddingCampaigns: vi.fn(async () => structuredClone(h.live.campaigns)),
  liveConversionActions: vi.fn(async () => structuredClone(h.live.actions)),
  liveValueRules: vi.fn(async () => ({ rules: structuredClone(h.live.rules), sets: structuredClone(h.live.sets) })),
  liveTagSnippets: vi.fn(async () => h.live.tags),
}))
vi.mock('../../marketing/google-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/write-client.js')>()),
  mutateGoogleAds: h.mutate,
}))
vi.mock('../../marketing/google-ads/conversion-upload-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/conversion-upload-client.js')>()),
  ingestSales: h.ingest,
  uploadAdjustments: h.adjust,
}))
vi.mock('../../marketing/google-ads/conversion-orders.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/conversion-orders.js')>()),
  shopifyOrdersForUpload: vi.fn(async () => ({ orders: structuredClone(h.live.orders), tooMany: false })),
  shopifyOrdersById: vi.fn(async (ids: string[]) => new Map((structuredClone(h.live.orders) as Array<{ shopifyOrderId: string }>).filter((o) => ids.includes(o.shopifyOrderId)).map((o) => [o.shopifyOrderId, o]))),
  nexusSales: vi.fn(async () => ({ sent: h.live.sent, retracted: new Set<string>(), value: new Map([['72:5001', { valueCents: 4990, currency: 'EUR' }]]) })),
  uploadInFlight: h.inFlight,
}))
vi.mock('../../marketing/google-ads/enqueue.js', () => ({ enqueueGoogleAdsSync: h.enqueue }))

import { GOOGLE_ADS_CONVERSIONS_TOOLS } from './google-ads-conversions.tools.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { listTools } from '../tool-registry.js'
import type { ToolContext } from '../tool-types.js'

const tool = (name: string) => GOOGLE_ADS_CONVERSIONS_TOOLS.find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })
const parses = (request: unknown) => {
  const r = request as { tool: string; args: unknown }
  return listTools().find((t) => t.name === r.tool)!.input.safeParse(r.args).success
}

const ACTION = {
  conversionActionId: '71', name: 'Purchase A', status: 'ENABLED', type: 'WEBPAGE', category: 'PURCHASE', origin: 'WEBSITE', primary: false, includeInConversions: true,
  counting: 'MANY_PER_CLICK', clickWindowDays: 30, viewWindowDays: 1, defaultValueCents: null, defaultValueCurrency: null, alwaysUseDefaultValue: false,
  attribution: 'GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN', dataDrivenStatus: null, ownerCustomerId: '1234567890', ga4: null,
}
const UPLOAD_ACTION = { ...ACTION, conversionActionId: '72', name: 'Sales import', type: 'UPLOAD_CLICKS', primary: true }
const ORDER = {
  orderId: 'n-5001', shopifyOrderId: '5001', status: 'PROCESSING', purchaseDate: new Date('2026-10-10T09:00:00Z'), createdAt: new Date('2026-10-10T09:00:05Z'), totalCents: 4990,
  currency: 'EUR', email: 'jane.doe@example.com', metadata: { name: '#5001', currency: 'EUR', current_total_price: '49.90', landing_site: '/?gclid=Cj0KCQjw-test' },
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-15T12:00:00Z') })
  for (const f of [h.mutate, h.ingest, h.adjust]) f.mockReset()
  h.inFlight.mockReset().mockResolvedValue(null)
  h.enqueue.mockClear()
  h.live.actions = [ACTION, UPLOAD_ACTION]
  h.live.accountGoals = [{ goal: 'PURCHASE/WEBSITE', category: 'PURCHASE', origin: 'WEBSITE', biddable: true }]
  h.live.campaignGoals = [{ campaignId: '21', name: 'Shop A', status: 'ENABLED', goalsFrom: 'CUSTOMER', customGoalId: null, biddableGoals: ['PURCHASE/WEBSITE'], differsFromAccount: false }]
  h.live.campaigns = [{ campaignId: '21', name: 'Shop A', status: 'ENABLED', bidding: 'MAXIMIZE_CONVERSION_VALUE' }]
  h.live.rules = []
  h.live.sets = []
  h.live.orders = [ORDER]
  h.live.sent = new Map()
  h.live.tags = new Map()
})
afterEach(() => { vi.useRealTimers() })

describe('every conversion tool', () => {
  it('is a Nexus change a person approves: alwaysAsk, ask at most, reaches Google, its re-check fields declared', () => {
    expect(GOOGLE_ADS_CONVERSIONS_TOOLS.map((t) => t.name)).toEqual([
      'set-google-conversion-actions', 'remove-google-conversion-actions', 'set-google-conversion-goals', 'set-google-value-rules', 'upload-google-sales', 'adjust-google-sales',
    ])
    for (const t of GOOGLE_ADS_CONVERSIONS_TOOLS) {
      expect(t).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', openWorld: true, readOnly: false, riskTier: 'high', requiresApprovalDefault: true })
      expect(MATERIAL_PREVIEW_FIELDS[t.name]).toEqual(['basis', 'plan', 'reach'])
    }
    expect(tool('remove-google-conversion-actions').reversibility).toBe('none')
    expect(tool('remove-google-conversion-actions').undo).toBeUndefined()
    expect(tool('remove-google-conversion-actions').input.safeParse({ conversionActionIds: ['71'] }).success).toBe(false)
    // Default values are money: the table, the settings already so and the records are kept from people without revenue.
    expect(tool('set-google-conversion-actions').restrictedFields).toEqual({ changes: 'financials.revenue.view', skipped: 'financials.revenue.view', defaultValueCents: 'financials.revenue.view' })
    expect(tool('set-google-value-rules').reversibility).toBe('partial')
  })
})

describe('set-google-conversion-actions', () => {
  it('preview on Google\'s check; primary is SPENDS MONEY; the run is ONE request; new tag actions bring their tags; undo puts settings back', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 2, requestId: null })
    const ask = { create: [{ name: 'Checkout tag', type: 'WEBPAGE', category: 'BEGIN_CHECKOUT' }], change: [{ conversionActionId: '71', primary: true }] }
    const out = await tool('set-google-conversion-actions').handler(ask, asker)
    expect(out.ok).toBe(true)
    expect(h.mutate.mock.calls[0][2]).toEqual({ validateOnly: true })
    expect(out.preview).toMatchObject({ spendsMoney: true, operations: 2, googleCheck: { checked: true, accepted: true } })
    expect((out.preview as { spendsMoneyBecause: string[] }).spendsMoneyBecause[0]).toMatch(/"Shop A"/)
    h.mutate.mockReset()
    h.mutate.mockResolvedValue({ responses: [{ conversionActionResult: { resourceName: 'customers/1234567890/conversionActions/81' } }, { conversionActionResult: { resourceName: 'customers/1234567890/conversionActions/71' } }], ops: 2, requestId: 'r' })
    h.live.tags = new Map([['81', [{ type: 'WEBPAGE', pageFormat: 'HTML', globalSiteTag: '<script>site</script>', eventSnippet: '<script>event</script>' }]]])
    const run = await tool('set-google-conversion-actions').execute!(ask, approved(out.preview))
    expect(run.ok).toBe(true)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    expect(h.mutate.mock.calls[0][2]).toMatchObject({ validateOnly: false })
    expect(run.data).toMatchObject({ created: [{ conversionActionId: '81', name: 'Checkout tag', type: 'WEBPAGE' }], tags: [{ conversionActionId: '81', snippets: [{ eventSnippet: '<script>event</script>' }] }] })
    expect(run.change!.before).toMatchObject({ actions: [{ conversionActionId: '71', primary: false }] })
    // The account now reads as the change left it: undo may run, and sets the old value through the same tool.
    h.live.actions = [{ ...ACTION, primary: true }, UPLOAD_ACTION, { ...ACTION, conversionActionId: '81', name: 'Checkout tag', category: 'BEGIN_CHECKOUT' }]
    expect(await tool('set-google-conversion-actions').undo!.current(run.change!)).toEqual(run.change!.after)
    const undo = tool('set-google-conversion-actions').undo!.request(run.change!)
    expect(undo).toEqual({ tool: 'set-google-conversion-actions', args: { accountId: 'g-1', change: [{ conversionActionId: '71', primary: false }], why: 'undo of an earlier conversion action change (the actions it made stay)' } })
    expect(parses(undo)).toBe(true)
  })

  it('never by a rule', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const ask = { change: [{ conversionActionId: '71', primary: true }] }
    const preview = (await tool('set-google-conversion-actions').handler(ask, asker)).preview
    h.mutate.mockClear()
    const byRule = await tool('set-google-conversion-actions').execute!(ask, { ...approved(preview), approvedByPerson: false, decidedVia: 'auto' })
    expect(byRule.error).toMatch(/never by a rule/)
    expect(h.mutate).not.toHaveBeenCalled()
  })
})

describe('set-google-conversion-goals', () => {
  it('a campaign\'s own goal: Google checks it; undo puts the campaign back on the account\'s goals', async () => {
    h.mutate.mockResolvedValue({ responses: [{}], ops: 1, requestId: null })
    const ask = { campaignGoals: [{ campaignId: '21', category: 'PURCHASE', origin: 'WEBSITE', biddable: false }] }
    const out = await tool('set-google-conversion-goals').handler(ask, asker)
    expect(out.preview).toMatchObject({ spendsMoney: false, operations: 1 })
    const run = await tool('set-google-conversion-goals').execute!(ask, approved(out.preview))
    expect(run.ok).toBe(true)
    h.live.campaignGoals = [{ campaignId: '21', name: 'Shop A', status: 'ENABLED', goalsFrom: 'CAMPAIGN', customGoalId: null, biddableGoals: [], differsFromAccount: true }]
    expect(await tool('set-google-conversion-goals').undo!.current(run.change!)).toEqual(run.change!.after)
    const undo = tool('set-google-conversion-goals').undo!.request(run.change!)
    expect(undo).toEqual({ tool: 'set-google-conversion-goals', args: { accountId: 'g-1', useAccountGoals: ['21'], why: 'undo of an earlier conversion goal change' } })
    expect(parses(undo)).toBe(true)
  })
})

describe('set-google-value-rules', () => {
  it('an enabled rule that raises values SPENDS MONEY; the run records Google\'s id; undo pauses it', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 2, requestId: null })
    const ask = { create: [{ multiply: 1.2, devices: ['MOBILE'], enable: true }] }
    const out = await tool('set-google-value-rules').handler(ask, asker)
    expect(out.preview).toMatchObject({ spendsMoney: true, operations: 2 })
    h.mutate.mockResolvedValue({ responses: [{ conversionValueRuleResult: { resourceName: 'customers/1234567890/conversionValueRules/92' } }, { conversionValueRuleSetResult: { resourceName: 'customers/1234567890/conversionValueRuleSets/95' } }], ops: 2, requestId: 'r' })
    const run = await tool('set-google-value-rules').execute!(ask, approved(out.preview))
    expect(run.data).toMatchObject({ created: [{ valueRuleId: '92', status: 'ENABLED' }], ruleSets: [{ ruleSetId: '95', created: true }] })
    h.live.rules = [{ valueRuleId: '92', status: 'ENABLED', operation: 'MULTIPLY', value: 1.2, devices: ['MOBILE'], locations: null, audiences: null, dimensions: ['DEVICE'], ownerCustomerId: '1234567890' }]
    expect(await tool('set-google-value-rules').undo!.current(run.change!)).toEqual(run.change!.after)
    const undo = tool('set-google-value-rules').undo!.request(run.change!)
    expect(undo).toEqual({ tool: 'set-google-value-rules', args: { accountId: 'g-1', change: [{ valueRuleId: '92', status: 'PAUSED' }], why: 'undo of an earlier conversion value rule change' } })
    expect(parses(undo)).toBe(true)
  })
})

describe('upload-google-sales', () => {
  const ask = { conversionActionId: '72', from: '2026-10-10', to: '2026-10-14' }

  it('preview on the Data Manager API\'s check; the run sends ONCE; the record names the sales and Google\'s request id; undo retracts them', async () => {
    h.ingest.mockResolvedValue({ requestId: null, warnings: [] })
    const out = await tool('upload-google-sales').handler(ask, asker)
    expect(out.ok).toBe(true)
    expect(h.mutate).not.toHaveBeenCalled()
    expect(h.ingest).toHaveBeenCalledTimes(1)
    expect(h.ingest.mock.calls[0][1]).toBe('72')
    expect(h.ingest.mock.calls[0][2]).toEqual([{ transactionId: '5001', eventTimestamp: '2026-10-10T09:00:00.000Z', eventSource: 'WEB', conversionValue: 49.9, currency: 'EUR', adIdentifiers: { gclid: 'Cj0KCQjw-test' } }])
    expect(h.ingest.mock.calls[0][3]).toEqual({ validateOnly: true })
    expect(out.preview).toMatchObject({ summary: 'Send 1 sale (EUR 49.90) from Shopify to the conversion action "Sales import" (72).', spendsMoney: true, googleCheck: { checked: true, accepted: true } })
    h.ingest.mockReset()
    h.ingest.mockResolvedValue({ requestId: 'req-1', warnings: [] })
    const run = await tool('upload-google-sales').execute!(ask, approved(out.preview))
    expect(run.ok).toBe(true)
    expect(h.ingest).toHaveBeenCalledTimes(1)
    expect(h.ingest.mock.calls[0][3]).toEqual({ validateOnly: false })
    expect(run.data).toMatchObject({ sent: 1, requestId: 'req-1' })
    expect(run.change!.after).toMatchObject({ conversionActionId: '72', requestId: 'req-1', sent: [{ orderId: '5001', valueCents: 4990 }], accountId: 'g-1', customerId: '1234567890' })
    expect(await tool('upload-google-sales').undo!.current(run.change!)).toEqual(run.change!.after)
    const undo = tool('upload-google-sales').undo!.request(run.change!)
    expect(undo).toMatchObject({ tool: 'adjust-google-sales', args: { accountId: 'g-1', conversionActionId: '72', retract: ['5001'] } })
    expect(parses(undo)).toBe(true)
  })

  it('another upload in flight in this business: the run is refused before anything is read or sent', async () => {
    h.ingest.mockResolvedValue({ requestId: null, warnings: [] })
    const preview = (await tool('upload-google-sales').handler(ask, asker)).preview
    h.ingest.mockClear()
    h.inFlight.mockResolvedValue('approval ap-2 is sending sales now')
    const run = await tool('upload-google-sales').execute!(ask, approved(preview))
    expect(run.ok).toBe(false)
    expect(run.error).toMatch(/another upload of sales to Google is running in this business \(approval ap-2 is sending sales now\)\. Nothing was sent/)
    expect(h.inFlight).toHaveBeenCalledWith('ap-1')
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('the conversion action the sales go to is part of the plan: the same sales to another action are another change', async () => {
    h.ingest.mockResolvedValue({ requestId: null, warnings: [] })
    h.live.actions = [ACTION, UPLOAD_ACTION, { ...UPLOAD_ACTION, conversionActionId: '73', name: 'Sales import B' }]
    const to72 = (await tool('upload-google-sales').handler(ask, asker)).preview as { plan: string }
    const to73 = (await tool('upload-google-sales').handler({ ...ask, conversionActionId: '73' }, asker)).preview as { plan: string }
    expect(h.ingest.mock.calls[0][2]).toEqual(h.ingest.mock.calls[1][2])
    expect(to72.plan).not.toBe(to73.plan)
  })

  it('a sale Nexus sent before is never sent again: the approved change stands on it', async () => {
    h.ingest.mockResolvedValue({ requestId: null, warnings: [] })
    const preview = (await tool('upload-google-sales').handler(ask, asker)).preview
    h.live.sent = new Map([['5001', '72']])
    h.ingest.mockClear()
    const run = await tool('upload-google-sales').execute!(ask, approved(preview))
    expect(run.error).toMatch(/No sale to send.*already sent/)
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('Google\'s refusal is said, and nothing is queued', async () => {
    const { GoogleAdsWriteError } = await import('../../marketing/google-ads/write-client.js')
    const { localFailure } = await import('../../marketing/google-ads/errors.js')
    h.ingest.mockRejectedValue(new GoogleAdsWriteError(localFailure('The Data Manager API is not enabled in Nexus\'s Google Cloud project. Nothing was sent.', 'SERVICE_DISABLED'), 'datamanager.events.ingest.check', 'refused'))
    const out = await tool('upload-google-sales').handler(ask, asker)
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/Data Manager API is not enabled/)
  })
})

describe('adjust-google-sales', () => {
  const ask = { conversionActionId: '72', restate: [{ orderId: '5001', valueCents: 2990 }] }

  it('an adjustment Google would refuse refuses the preview, named', async () => {
    h.adjust.mockResolvedValue({ results: [{ ok: false, why: 'The conversion was not found. (CONVERSION_NOT_FOUND)' }] })
    const out = await tool('adjust-google-sales').handler(ask, asker)
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/Google would refuse 1 of the 1 adjustments: order 5001: The conversion was not found/)
  })

  it('Google takes each on its own: only what it took is recorded; undo restates the value Nexus sent', async () => {
    h.adjust.mockResolvedValue({ results: [{ ok: true }] })
    const out = await tool('adjust-google-sales').handler(ask, asker)
    expect(out.ok).toBe(true)
    expect(h.adjust.mock.calls[0][2]).toEqual({ validateOnly: true })
    // Lower than the value Nexus gave Google: nothing spends more.
    expect(out.preview).toMatchObject({ changes: { '#5001': { from: 'EUR 49.90', to: 'EUR 29.90' } }, spendsMoney: false })
    h.adjust.mockReset()
    h.adjust.mockResolvedValue({ results: [{ ok: true }] })
    const run = await tool('adjust-google-sales').execute!(ask, approved(out.preview))
    expect(run.data).toMatchObject({ taken: 1, restated: ['5001'], refused: [] })
    expect(h.adjust.mock.calls[0][2]).toMatchObject({ validateOnly: false })
    const undo = tool('adjust-google-sales').undo!.request(run.change!)
    expect(undo).toMatchObject({ tool: 'adjust-google-sales', args: { conversionActionId: '72', restate: [{ orderId: '5001', valueCents: 4990 }] } })
    expect(parses(undo)).toBe(true)
  })

  it('a refused row in the run is said with Google\'s reason and left out of the record', async () => {
    h.adjust.mockResolvedValue({ results: [{ ok: true }, { ok: true }] })
    h.live.orders = [ORDER, { ...ORDER, orderId: 'n-5002', shopifyOrderId: '5002', metadata: { ...ORDER.metadata, name: '#5002' } }]
    const both = { conversionActionId: '72', retract: ['5002'], restate: [{ orderId: '5001', valueCents: 2990 }] }
    const out = await tool('adjust-google-sales').handler(both, asker)
    h.adjust.mockResolvedValue({ results: [{ ok: false, why: 'Too recent (TOO_RECENT_CONVERSION)' }, { ok: true }] })
    const run = await tool('adjust-google-sales').execute!(both, approved(out.preview))
    expect(run.data).toMatchObject({ taken: 1, retracted: [], restated: ['5001'], refused: [{ orderId: '5002', why: 'Too recent (TOO_RECENT_CONVERSION)' }] })
    expect(run.change!.after).toMatchObject({ retracted: [], restated: [{ orderId: '5001', valueCents: 2990 }] })
  })
})
