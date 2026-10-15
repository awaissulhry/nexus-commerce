/**
 * Google Ads programme 2, G12 (2026-10-16) — the Merchant Center tools as the approval gate uses them (the database rows,
 * Merchant Center and Nexus's records are stand-ins). The account is the one this business chose in Nexus; another id is
 * refused in a sentence. A change is previewed from the live account and the records (Google cannot check it first), runs
 * only as a request a person approved, as ONE call, and only when nothing it stands on moved; undo puts it back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  links: [] as Array<{ connectionId: string; externalId: string; label: string }>,
  product: null as Record<string, unknown> | null,
  dataSources: [] as Array<Record<string, unknown>>,
  promotions: [] as Array<Record<string, unknown>>,
  products: [] as Array<Record<string, unknown>>,
  reads: [] as string[],
  send: vi.fn(),
  nexusMade: new Set<string>(),
  inputs: new Map<string, { state: Record<string, unknown> | null; at: string }>(),
  promotionRecords: new Map<string, { state: Record<string, unknown> | null; at: string }>(),
}))
vi.mock('../../../db.js', () => ({
  default: {
    googleAccountLink: { findMany: vi.fn(async () => h.links) },
    product: { findUnique: vi.fn(async () => ({ name: 'Jacket A', description: '<p>Warm</p>', brand: 'Brand A', gtin: '1234567890128', ean: null, upc: null })) },
  },
}))
vi.mock('../../marketing/google-merchant/client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-merchant/client.js')>()),
  merchantRead: vi.fn(async (_account: unknown, _op: string, path: string, options: { body?: unknown } = {}) => {
    h.reads.push(path)
    if (path.includes('/products/')) return h.product
    if (path.endsWith('reports:search')) return { results: [{ productPerformanceView: { offerId: 'SKU-A', title: 'Jacket A', marketingMethod: 'ADS', impressions: '120', clicks: '7', clickThroughRate: 0.058 } }], query: (options.body as { query: string }).query }
    return {}
  }),
  merchantList: vi.fn(async (_account: unknown, _op: string, path: string) => {
    h.reads.push(path)
    if (path.endsWith('/dataSources')) return { items: h.dataSources, more: false }
    if (path.endsWith('/promotions')) return { items: h.promotions, more: false }
    if (path.endsWith('/products')) return { items: h.products, more: false }
    return { items: [], more: false }
  }),
  sendMerchantCall: h.send,
}))
vi.mock('../../marketing/google-merchant/records.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-merchant/records.js')>()),
  nexusDataSourceIds: vi.fn(async () => new Set(h.nexusMade)),
  recordedInput: vi.fn(async (_m: string, ds: string, key: string) => h.inputs.get(`${ds}|${key}`) ?? null),
  recordedPromotion: vi.fn(async (_m: string, ds: string, key: string) => h.promotionRecords.get(`${ds}|${key}`) ?? null),
  recordedCount: vi.fn(async () => 0),
}))
vi.mock('../../marketing/google-ads/read-detail.service.js', () => ({
  nexusProductsBySku: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, id === 'SKU-A' ? { productId: 'p-1', sku: 'SKU-A', name: 'Jacket A' } : null]))),
}))

import { FEATURES as F } from '@nexus/shared/permissions'
import { GOOGLE_ADS_MERCHANT_TOOLS } from './google-ads-merchant.tools.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { MerchantError, byRun } from '../../marketing/google-merchant/client.js'
import type { ToolContext } from '../tool-types.js'

const tool = (name: string) => GOOGLE_ADS_MERCHANT_TOOLS.find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const recheck: ToolContext = { can: () => true, via: 'system', approvalId: 'ap-1' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })
const pick = (p: unknown) => { const { basis, plan, reach } = p as Record<string, unknown>; return { basis, plan, reach } }
const M = '555'
const PRIMARY = { dataSourceId: '11', displayName: 'Shop feed', input: 'API', primaryProductDataSource: { defaultRule: { takeFromDataSources: [{ supplementalDataSourceName: `accounts/${M}/dataSources/71` }, { self: true }] } } }
const SUPPLEMENTAL = { dataSourceId: '71', displayName: 'Nexus A', input: 'API', supplementalProductDataSource: { referencingPrimaryDataSources: [{ primaryDataSourceName: `accounts/${M}/dataSources/11` }] } }
const PROMOTION_SOURCE = { dataSourceId: '72', displayName: 'Nexus P', input: 'API', promotionDataSource: { targetCountry: 'IT', contentLanguage: 'it' } }

beforeEach(() => {
  vi.unstubAllEnvs()
  h.links = [{ connectionId: 'g-1', externalId: M, label: 'Shop A' }]
  h.product = { offerId: 'SKU-A', contentLanguage: 'it', feedLabel: 'IT', dataSource: `accounts/${M}/dataSources/11`, productAttributes: { title: 'Jacket A', customLabel0: 'old' } }
  h.dataSources = [PRIMARY, SUPPLEMENTAL, PROMOTION_SOURCE]
  h.promotions = []
  h.products = []
  h.reads = []
  h.send.mockReset()
  h.nexusMade = new Set(['71', '72'])
  h.inputs.clear()
  h.promotionRecords.clear()
})

describe('the Merchant tools keep the change contract', () => {
  it('each change a Nexus change a person approves, with its re-check fields and an undo; the read is read only', () => {
    for (const t of GOOGLE_ADS_MERCHANT_TOOLS.filter((x) => !x.readOnly)) {
      expect(t).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', openWorld: true, riskTier: 'high', requiresApprovalDefault: true })
      expect(MATERIAL_PREVIEW_FIELDS[t.name]).toEqual(['basis', 'plan', 'reach'])
      expect(t.undo).toBeDefined()
      expect(t.description).toContain('Google CANNOT check a Merchant Center change first')
      expect(t.description).toContain('ids never cross businesses')
    }
    expect(tool('google-merchant-live')).toMatchObject({ readOnly: true, openWorld: true, requires: [F.listingsView] })
    expect(tool('set-google-merchant-promotions').requires).toContain(F.pricingEdit)
    // Ending a pause or an ads exclusion, or moving a product between product groups, can make the ads spend more.
    expect(tool('set-google-merchant-products').requires).toContain(F.adsCampaignsManage)
    // The Merchant API cannot read an input back: undo restores what Nexus recorded.
    expect(tool('set-google-merchant-products').reversibility).toBe('partial')
    expect(tool('set-google-merchant-data-sources').input.safeParse({ action: 'fetch-now', dataSourceId: '81' }).success).toBe(false)
  })
})

describe('the account', () => {
  it('only the Merchant Center account this business chose: another id is refused in a sentence, nothing read', async () => {
    const out = await tool('google-merchant-live').handler({ view: 'overview', merchantCenterId: '556' }, asker)
    expect(out).toEqual({ ok: false, error: expect.stringMatching(/^Merchant Center 556 is not the Merchant Center account this business chose in Nexus/) })
    expect(h.reads).toEqual([])
    h.links = []
    expect((await tool('set-google-merchant-data-sources').handler({ action: 'create-supplemental', displayName: 'Nexus B' }, asker)).error).toMatch(/no Merchant Center account chosen in Nexus/)
  })
})

describe('set-google-merchant-products', () => {
  const ask = { action: 'set', dataSourceId: '71', offerId: 'SKU-A', contentLanguage: 'it', feedLabel: 'IT', attributes: { customLabel0: 'top' } }

  it('preview from the live account and the records (no Google check); the run sends ONE call as the approver; undo deletes the new input', async () => {
    const out = await tool('set-google-merchant-products').handler(ask, asker)
    expect(out.ok).toBe(true)
    expect(out.preview).toMatchObject({
      googleCheck: { checked: false }, calls: 1, spendsMoney: true, reach: { mode: 'live', accountId: 'g-1', merchantCenterId: M },
      spendsMoneyBecause: [expect.stringMatching(/changes customLabel0 .* product group or inventory filter that bids/)],
      changes: { customLabel0: { from: 'old', to: 'top' } },
      warnings: expect.arrayContaining([expect.stringMatching(/comes before the primary feed: its values win/)]),
    })
    expect(h.send).not.toHaveBeenCalled()
    const again = await tool('set-google-merchant-products').handler(ask, recheck)
    expect(pick(again.preview)).toEqual(pick(out.preview))

    expect((await tool('set-google-merchant-products').execute!(ask, asker)).error).toMatch(/runs only as an approved request/)
    expect((await tool('set-google-merchant-products').execute!(ask, { ...approved(out.preview), approvedByPerson: false, decidedVia: 'auto' })).error).toMatch(/never by a rule/)
    h.send.mockResolvedValue({ name: `accounts/${M}/productInputs/x` })
    const run = await tool('set-google-merchant-products').execute!(ask, approved(out.preview))
    expect(run.ok).toBe(true)
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.send.mock.calls[0][1]).toEqual({
      method: 'POST', path: `products/v1/accounts/${M}/productInputs:insert`, query: { dataSource: `accounts/${M}/dataSources/71` },
      body: { offerId: 'SKU-A', contentLanguage: 'it', feedLabel: 'IT', productAttributes: { customLabel0: 'top' } },
    })
    expect(h.send.mock.calls[0][2]).toBe('merchant.productInputs.insert')
    expect(run.change!.after).toMatchObject({ key: 'it~IT~SKU-A', state: { customLabel0: 'top' }, accountId: 'g-1', merchantCenterId: M })

    // Undo: what Nexus wrote is still its last record → a delete of the input.
    h.inputs.set('71|it~IT~SKU-A', { state: { customLabel0: 'top' }, at: '2026-10-16T10:00:00.000Z' })
    const undo = tool('set-google-merchant-products').undo!
    expect(await undo.current(run.change!)).toEqual(run.change!.after)
    const request = undo.request(run.change!)
    expect(request).toMatchObject({ tool: 'set-google-merchant-products', args: { accountId: 'g-1', merchantCenterId: M, action: 'delete', dataSourceId: '71', offerId: 'SKU-A' } })
    expect(tool('set-google-merchant-products').input.safeParse((request as { args: unknown }).args).success).toBe(true)
    // A later change of the same input: undo would overwrite it.
    h.inputs.set('71|it~IT~SKU-A', { state: { customLabel0: 'later' }, at: '2026-10-16T11:00:00.000Z' })
    expect(await undo.current(run.change!)).not.toEqual(run.change!.after)
  })

  it('not sent when what it stands on moved since approval; no answer from Google: recorded as NOT CONFIRMED, and the next change says so', async () => {
    const out = await tool('set-google-merchant-products').handler(ask, asker)
    h.inputs.set('71|it~IT~SKU-A', { state: { customLabel1: 'x' }, at: '2026-10-16T10:00:00.000Z', outcome: 'done' })
    expect((await tool('set-google-merchant-products').execute!(ask, approved(out.preview))).error).toMatch(/changed since this was approved/)
    expect(h.send).not.toHaveBeenCalled()
    h.inputs.clear()
    h.send.mockRejectedValue(new MerchantError('Merchant Center did not answer …', 'merchant.productInputs.insert', 'unknown'))
    const run = await tool('set-google-merchant-products').execute!(ask, approved(out.preview))
    expect(run).toMatchObject({ ok: true, data: { outcome: 'unknown', summary: expect.stringMatching(/^NOT CONFIRMED/) } })
    expect(run.change).toMatchObject({ before: { state: null }, after: { state: { customLabel0: 'top' }, outcome: 'unknown', merchantCenterId: M } })
    // Its undo still puts back what was there before (none: a delete), which is right whether or not Google applied it.
    expect(tool('set-google-merchant-products').undo!.request(run.change!)).toMatchObject({ args: { action: 'delete' } })
    // The next change of this input (the same values again is allowed) says the input may differ.
    h.inputs.set('71|it~IT~SKU-A', { state: { customLabel0: 'top' }, at: '2026-10-16T10:00:00.000Z', outcome: 'unknown' })
    const next = await tool('set-google-merchant-products').handler(ask, asker)
    expect(next.preview).toMatchObject({ summary: expect.stringMatching(/again/), warnings: expect.arrayContaining([expect.stringMatching(/unknown outcome/)]) })
  })

  it('never into the primary feed; price is not an attribute it takes; writes off: said, and not sent', async () => {
    expect((await tool('set-google-merchant-products').handler({ ...ask, dataSourceId: '11' }, asker)).error).toMatch(/never edits or deletes the primary feed/)
    expect(tool('set-google-merchant-products').input.safeParse({ ...ask, attributes: { price: { amountMicros: '1' } } }).success).toBe(false)
    vi.stubEnv('NEXUS_GOOGLE_ADS_WRITES', 'off')
    const out = await tool('set-google-merchant-products').handler(ask, asker)
    expect(out.preview).toMatchObject({ reach: { mode: 'off' }, warnings: expect.arrayContaining([expect.stringMatching(/switched off/)]) })
    expect((await tool('set-google-merchant-products').execute!(ask, approved(out.preview))).error).toMatch(/switched off/)
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe('set-google-merchant-data-sources', () => {
  it('a supplemental data source made is Nexus\'s (its id from Google\'s answer); undo deletes it when empty', async () => {
    const ask = { action: 'create-supplemental', displayName: 'Nexus B' }
    const out = await tool('set-google-merchant-data-sources').handler(ask, asker)
    expect(out.preview).toMatchObject({ summary: expect.stringMatching(/new supplemental product data source/), warnings: expect.arrayContaining([expect.stringMatching(/a person links it in Merchant Center/)]) })
    h.send.mockResolvedValue({ name: `accounts/${M}/dataSources/74`, dataSourceId: '74' })
    const run = await tool('set-google-merchant-data-sources').execute!(ask, approved(out.preview))
    expect(run.change!.after).toMatchObject({ action: 'create-supplemental', created: true, dataSourceId: '74', merchantCenterId: M })
    const request = tool('set-google-merchant-data-sources').undo!.request(run.change!)
    expect(request).toMatchObject({ tool: 'set-google-merchant-data-sources', args: { action: 'delete', dataSourceId: '74', confirmDelete: true } })
    expect(tool('set-google-merchant-data-sources').input.safeParse((request as { args: unknown }).args).success).toBe(true)
  })

  it('a delete cannot be undone; a data source Nexus did not make is never renamed', async () => {
    expect(tool('set-google-merchant-data-sources').undo!.request({ before: { action: 'delete' }, after: { action: 'delete', dataSourceId: '74', deleted: true } })).toEqual({ refusal: expect.stringMatching(/cannot come back/) })
    expect((await tool('set-google-merchant-data-sources').handler({ action: 'rename', dataSourceId: '11', displayName: 'X' }, asker)).error).toMatch(/not one Nexus made/)
  })
})

describe('set-google-merchant-promotions', () => {
  const fields = { title: 'Ten off', type: 'PERCENT_OFF', percentOff: 10, appliesTo: 'all', startsAt: '2026-11-01T00:00:00Z', endsAt: '2099-11-08T00:00:00Z' }

  it('a new promotion: the price buyers see in its money line; ending it records the moment it was sent', async () => {
    const ask = { action: 'set', dataSourceId: '72', promotionId: 'PROMO-A', ...fields }
    const out = await tool('set-google-merchant-promotions').handler(ask, asker)
    expect(out.preview).toMatchObject({ spendsMoney: true, spendsMoneyBecause: [expect.stringMatching(/^CHANGES THE PRICE BUYERS SEE/)] })
    h.send.mockResolvedValue({})
    const run = await tool('set-google-merchant-promotions').execute!(ask, approved(out.preview))
    expect(run.ok).toBe(true)
    const undo = tool('set-google-merchant-promotions').undo!.request(run.change!)
    expect(undo).toMatchObject({ args: { action: 'end', dataSourceId: '72', promotionId: 'PROMO-A' } })
    expect(tool('set-google-merchant-promotions').input.safeParse((undo as { args: unknown }).args).success).toBe(true)

    h.promotionRecords.set('72|IT~it~PROMO-A', { state: { ...fields, startsAt: '2026-10-01T00:00:00Z' }, at: '2026-10-01T00:00:00Z' })
    h.promotions = [{ promotionId: 'PROMO-A', contentLanguage: 'it', targetCountry: 'IT', dataSource: `accounts/${M}/dataSources/72` }]
    const end = { action: 'end', dataSourceId: '72', promotionId: 'PROMO-A' }
    const ending = await tool('set-google-merchant-promotions').handler(end, asker)
    expect(ending.preview).toMatchObject({ spendsMoney: false, changes: { endsAt: { from: '2099-11-08T00:00:00Z', to: 'when this change runs' } } })
    h.send.mockClear()
    const ended = await tool('set-google-merchant-promotions').execute!(end, approved(ending.preview))
    expect(h.send.mock.calls[0][1].body.promotion.attributes.promotionEffectiveTimePeriod).toEqual({ startTime: byRun('2026-10-01T00:00:00Z').replace('@BY_RUN:', '@BY_RUN-1M:'), endTime: byRun('2099-11-08T00:00:00Z') })
    const endedAt = (ended.change!.after as { state: { endsAt: string } }).state.endsAt
    expect(endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(Date.parse(endedAt)).toBeLessThanOrEqual(Date.now())
  })

  it('undo of a change takes out what the old promotion did not hold (null), and the undo request runs as a change', async () => {
    const was = { ...fields }
    const now = { ...fields, code: 'EXTRA10', minimumPurchaseCents: 5000, currency: 'EUR' }
    const change = {
      before: { action: 'set', merchantCenterId: M, dataSourceId: '72', key: 'IT~it~PROMO-A', promotionId: 'PROMO-A', state: was },
      after: { action: 'set', merchantCenterId: M, dataSourceId: '72', key: 'IT~it~PROMO-A', promotionId: 'PROMO-A', state: now, accountId: 'g-1' },
    }
    const request = tool('set-google-merchant-promotions').undo!.request(change) as { tool: string; args: Record<string, unknown> }
    expect(request.args).toMatchObject({ action: 'set', code: null, minimumPurchaseCents: null, currency: null, percentOff: 10 })
    const parsed = tool('set-google-merchant-promotions').input.safeParse(request.args)
    expect(parsed.success).toBe(true)
    h.promotionRecords.set('72|IT~it~PROMO-A', { state: now, at: '2026-10-16T09:00:00Z' })
    h.promotions = [{ promotionId: 'PROMO-A', contentLanguage: 'it', targetCountry: 'IT', dataSource: `accounts/${M}/dataSources/72` }]
    const out = await tool('set-google-merchant-promotions').handler(parsed.data as Record<string, unknown>, asker)
    expect(out.ok).toBe(true)
    expect(out.preview).toMatchObject({ changes: { code: { from: 'EXTRA10', to: '(none)' }, minimumPurchaseCents: { from: 5000, to: '(none)' } } })
  })
})

describe('google-merchant-live', () => {
  it('products: status and issues per destination and country, filtered, with the Nexus product of that SKU', async () => {
    h.products = [
      { offerId: 'SKU-A', contentLanguage: 'it', feedLabel: 'IT', productAttributes: { title: 'Jacket A' }, productStatus: { destinationStatuses: [{ reportingContext: 'SHOPPING_ADS', disapprovedCountries: ['IT'] }], itemLevelIssues: [{ code: 'missing_gtin', severity: 'DISAPPROVED' }] } },
      { offerId: 'SKU-B', contentLanguage: 'it', feedLabel: 'IT', productAttributes: { title: 'Glove B' }, productStatus: { destinationStatuses: [{ reportingContext: 'SHOPPING_ADS', approvedCountries: ['IT'] }] } },
    ]
    const out = await tool('google-merchant-live').handler({ view: 'products', status: 'disapproved' }, asker)
    expect(out.data).toMatchObject({ read: 2, counts: { approved: 1, disapproved: 1, pending: 0, none: 0 }, matching: 1 })
    expect((out.data as { products: unknown[] }).products).toEqual([expect.objectContaining({ offerId: 'SKU-A', verdict: 'disapproved', nexus: { productId: 'p-1', sku: 'SKU-A', name: 'Jacket A' } })])
  })

  it('data sources: which ones Nexus made, the rule order; performance: clicks per product', async () => {
    const sources = await tool('google-merchant-live').handler({ view: 'data-sources' }, asker)
    expect((sources.data as { dataSources: unknown[] }).dataSources).toEqual([
      expect.objectContaining({ dataSourceId: '11', type: 'primary', madeByNexus: false, defaultRule: ['71', 'self'] }),
      expect.objectContaining({ dataSourceId: '71', type: 'supplemental', madeByNexus: true, linkedFrom: ['11'] }),
      expect.objectContaining({ dataSourceId: '72', type: 'promotion', madeByNexus: true }),
    ])
    const perf = await tool('google-merchant-live').handler({ view: 'performance', from: '2026-10-01', to: '2026-10-15', limit: 10 }, asker)
    expect((perf.data as { rows: unknown[] }).rows).toEqual([{ offerId: 'SKU-A', title: 'Jacket A', method: 'ADS', impressions: 120, clicks: 7, ctr: 0.058, nexus: { productId: 'p-1', sku: 'SKU-A', name: 'Jacket A' } }])
  })
})
