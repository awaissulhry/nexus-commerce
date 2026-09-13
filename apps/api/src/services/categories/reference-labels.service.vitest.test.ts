import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ spec: vi.fn(), connection: vi.fn(), primary: vi.fn(), callAPI: vi.fn(), client: vi.fn(), mappings: vi.fn(), browseNames: vi.fn(), market: vi.fn(), labelRead: vi.fn(), labelWrite: vi.fn() }))
vi.mock('./browse-node-labels.service.js', () => ({ cachedBrowseNodeLabels: mocks.browseNames }))
// `amazonLocale` derives the seller-definition locale from `Marketplace.languages` (LX.2 — the ONE
// authority), so the seller-spec arms need that row mocked too. Without it every live arm failed
// on `prisma.marketplace.findFirst` — two tests in this file were red before LX.6 touched it.
// LX.FIN (R-LX-24) — the durable label cache is a row read/write, so it is mocked like the rest. The
// two arms that matter are counted, not assumed: `labelRead` proves a cold page load consulted the
// TABLE, and `mocks.client` proves it did not consult the PROVIDER, in the same run.
vi.mock('../../db.js', () => ({ default: { categoryChannelMapping: { findMany: mocks.mappings }, marketplace: { findFirst: mocks.market }, sellerReferenceLabel: { findFirst: mocks.labelRead, upsert: mocks.labelWrite } } }))
vi.mock('../pim/channel-specs/index.js', () => ({ loadAmazonSpec: mocks.spec }))
vi.mock('../connection-resolver.service.js', () => ({ resolveChannelConnectionId: mocks.connection, isPrimaryChannelConnection: mocks.primary }))
vi.mock('../../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: () => 'seller', getAmazonSpClient: mocks.client }))
vi.mock('./schema-document.js', () => ({ downloadAmazonSchema: async (schema: any) => (await fetch(schema.link.resource)).json(), schemaFingerprint: () => 'test-schema' }))
import { amazonReferenceLabels, cachedCategoryLabels, sellerShippingTemplateLabels } from './reference-labels.service.js'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.spec.mockResolvedValue({ fields: [{ key: 'recommended_browse_nodes', optionLabels: { '123': 'Clothing > Jackets' } }] })
  mocks.connection.mockResolvedValue('primary')
  mocks.primary.mockResolvedValue(true)
  mocks.client.mockResolvedValue({ callAPI: mocks.callAPI })
  mocks.market.mockResolvedValue({ languages: ['de'], language: 'de' })
  mocks.labelRead.mockResolvedValue(null)
  mocks.labelWrite.mockResolvedValue({})
})

describe('Amazon reference names', () => {
  it('fills unresolved browse-node names from the same-market cache and keeps existing schema names', async () => {
    mocks.browseNames.mockResolvedValue({ '2420941031': 'Auto e Moto > Giacche' })
    const result = await amazonReferenceLabels({ marketplace: 'IT', productType: 'OUTERWEAR', shipping: false, browseNodeIds: ['123', '2420941031', 'missing'] })
    expect(mocks.browseNames).toHaveBeenCalledWith('IT', ['2420941031', 'missing'])
    expect(result.labels.recommended_browse_nodes).toEqual({ '123': 'Clothing > Jackets', '2420941031': 'Auto e Moto > Giacche' })
    expect(result.labels.browseNodeId).toEqual(result.labels.recommended_browse_nodes)
    expect(result.unavailable).toEqual(['browseNodes'])
    expect(mocks.client).not.toHaveBeenCalled()
  })
  it('uses the selected market’s saved category path and rejects conflicting labels', async () => {
    mocks.mappings.mockResolvedValue([
      { marketplace: '*', channelCategoryPath: 'Generic jackets' },
      { marketplace: 'IT', channelCategoryPath: 'Abbigliamento > Giacche' },
    ])
    expect(await cachedCategoryLabels('EBAY', 'IT', '123')).toEqual({ categoryId: { '123': 'Abbigliamento > Giacche' } })
    expect(mocks.mappings).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ channel: 'EBAY', marketplace: { in: ['IT'] }, channelCategoryId: '123' }) }))
    mocks.mappings.mockResolvedValue([
      { marketplace: 'IT', channelCategoryPath: 'Jackets' },
      { marketplace: 'IT', channelCategoryPath: 'Shoes' },
    ])
    expect(await cachedCategoryLabels('EBAY', 'IT', '123')).toEqual({})
    mocks.mappings.mockResolvedValue([{ marketplace: '*', channelCategoryPath: 'Unknown market’s category' }])
    expect(await cachedCategoryLabels('EBAY', 'IT', '123')).toEqual({})
  })
  it('returns cached schema names without contacting a seller or changing option codes', async () => {
    const result = await amazonReferenceLabels({ marketplace: 'IT', productType: 'OUTERWEAR', shipping: false })
    expect(result.labels.recommended_browse_nodes).toEqual({ '123': 'Clothing > Jackets' })
    expect(mocks.client).not.toHaveBeenCalled()
    expect(mocks.connection).not.toHaveBeenCalled()
  })

  it('does not use primary seller credentials to name another account’s templates', async () => {
    mocks.connection.mockResolvedValue('alternate')
    mocks.primary.mockResolvedValue(false)
    const result = await amazonReferenceLabels({ marketplace: 'IT', productType: 'OUTERWEAR', accountId: 'alternate', shipping: true })
    expect(mocks.connection).toHaveBeenCalledWith('AMAZON', 'alternate')
    expect(mocks.client).toHaveBeenCalledWith('alternate')
    expect(result.unavailable).toEqual(['shippingTemplate'])
  })

  it('reads seller enum names while keeping its schema separate from the shared cache', async () => {
    mocks.callAPI.mockResolvedValue({ schema: { link: { resource: 'https://schema.test/definition' } } })
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ properties: {
      merchant_shipping_group: { type: 'array', items: { type: 'object', properties: {
        value: { type: 'string', enum: ['template-id'], enumNames: ['Standard delivery'] },
      } } },
    } }) })
    vi.stubGlobal('fetch', fetcher)
    try {
      const result = await amazonReferenceLabels({ marketplace: 'DE', productType: 'OUTERWEAR', shipping: true })
      expect(result.labels.shippingTemplate).toEqual({ 'template-id': 'Standard delivery' })
      expect(mocks.callAPI).toHaveBeenCalledWith(expect.objectContaining({ query: expect.objectContaining({ sellerId: 'seller', marketplaceIds: ['A1PA6795UKMFR9'] }) }))
      expect(result.labels.recommended_browse_nodes).toEqual({ '123': 'Clothing > Jackets' })
    } finally { vi.unstubAllGlobals() }
  })

  it('preserves cached labels when a seller lookup fails', async () => {
    mocks.callAPI.mockRejectedValue(new Error('Offline'))
    const result = await amazonReferenceLabels({ marketplace: 'FR', productType: 'OUTERWEAR', shipping: true })
    expect(result.labels.recommended_browse_nodes).toEqual({ '123': 'Clothing > Jackets' })
    expect(result.unavailable).toEqual(['shippingTemplate'])
  })

  /**
   * 🔴 LX.6 / R-LX-4 — the page-load arm may not START provider work, and the age it reports is a
   * DATABASE date. All three arms in ONE test so the refusal carries its own positive control: an
   * assertion that the client was not called proves nothing unless the same run shows it being
   * called (`reference_could_not_measure_vs_measured_empty`).
   */
  it('serves a page load from the cache alone, reports the database date, and still lets a gesture go live', async () => {
    const { withCachedSchemas } = await import('../pim/cached-schema-context.js')
    mocks.spec.mockResolvedValue({ fields: [{ key: 'recommended_browse_nodes', optionLabels: { '123': 'Clothing > Jackets' } }], fetchedAt: new Date('2026-09-12T14:52:54.095Z'), schemaVersion: 'cached-row' })
    mocks.callAPI.mockResolvedValue({ schema: { link: { resource: 'https://schema.test/definition' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ properties: {
      merchant_shipping_group: { type: 'array', items: { type: 'object', properties: {
        value: { type: 'string', enum: ['tmpl'], enumNames: ['Standard delivery'] },
      } } },
    } }) }))
    try {
      const scope = { marketplace: 'ES', productType: 'PAGELOAD_ARM', accountId: 'primary', shipping: true }

      // 1. cold page load: no provider work, no names invented, the age is the row's own date
      const cold = await withCachedSchemas(() => amazonReferenceLabels(scope))
      expect(mocks.client).not.toHaveBeenCalled()
      expect(mocks.callAPI).not.toHaveBeenCalled()
      expect(cold.unavailable).toEqual(['shippingTemplate'])
      expect(cold.labels.merchant_shipping_group).toEqual({})
      expect(cold.stamp).toMatchObject({ cachedOnly: true, sellerTemplates: 'cache-miss', schemaFetchedAt: '2026-09-12T14:52:54.095Z', schemaVersion: 'cached-row' })

      // 2. positive control — the same request as a GESTURE does reach the seller definition
      const live = await amazonReferenceLabels(scope)
      expect(mocks.callAPI).toHaveBeenCalledTimes(1)
      expect(live.labels.shippingTemplate).toEqual({ tmpl: 'Standard delivery' })
      expect(live.stamp).toMatchObject({ cachedOnly: false, sellerTemplates: 'live' })

      // 3. cache-FIRST, not cache-refuse: the warm entry the gesture left is served to a page load
      const warm = await withCachedSchemas(() => amazonReferenceLabels(scope))
      expect(mocks.callAPI).toHaveBeenCalledTimes(1)
      expect(warm.labels.merchant_shipping_group).toEqual({ tmpl: 'Standard delivery' })
      expect(warm.stamp).toMatchObject({ cachedOnly: true, sellerTemplates: 'cache-hit' })
    } finally { vi.unstubAllGlobals() }
  })

  /**
   * 🔴 LX.FIN (R-LX-24, on LX.R's R-LX-12) — a COLD page load shows NAMES from the database, and makes
   * ZERO provider calls. Proven with a MOCKED provider so the arm that would call is countable, which is
   * the reading R-LX-24 asks for and the one LX.6 could only record as an `ASSUMED:` (this machine's
   * Amazon token is refused, so no live cold-load reading exists).
   *
   * All four arms in ONE test, because "0 provider calls" is a claim about where the instrument was
   * pointed: the run must also contain the arm that DID call.
   */
  it('serves a cold page load with NAMES from the durable cache, at zero provider calls, stamped with the database date', async () => {
    const { withCachedSchemas } = await import('../pim/cached-schema-context.js')
    mocks.spec.mockResolvedValue({ fields: [{ key: 'recommended_browse_nodes', optionLabels: { '123': 'Clothing > Jackets' } }], fetchedAt: new Date('2026-09-12T14:52:54.095Z'), schemaVersion: 'cached-row' })
    mocks.callAPI.mockResolvedValue({ schema: { link: { resource: 'https://schema.test/definition' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ properties: {
      merchant_shipping_group: { type: 'array', items: { type: 'object', properties: {
        value: { type: 'string', enum: ['t-4f2a'], enumNames: ['Standard delivery'] },
      } } },
    } }) }))
    try {
      const scope = { marketplace: 'ES', productType: 'DURABLE_CACHE_ARM', accountId: 'primary', shipping: true }

      // 1. A cold page load with a STORED row: names, no provider work, and the row's OWN date.
      mocks.labelRead.mockResolvedValue({ labels: { 't-4f2a': 'Standard delivery' }, fetchedAt: new Date('2026-09-12T11:00:00.000Z') })
      const cold = await withCachedSchemas(() => amazonReferenceLabels(scope))
      expect(mocks.client).not.toHaveBeenCalled()
      expect(mocks.callAPI).not.toHaveBeenCalled()
      expect(mocks.labelRead).toHaveBeenCalledTimes(1)
      expect(cold.labels.shippingTemplate).toEqual({ 't-4f2a': 'Standard delivery' })
      expect(cold.unavailable).not.toContain('shippingTemplate')
      expect(cold.stamp).toMatchObject({ cachedOnly: true, sellerTemplates: 'cache-hit', sellerTemplateSource: 'database', sellerTemplatesFetchedAt: '2026-09-12T11:00:00.000Z' })
      // The DATE is the row's, never the request's — the whole point of a DB-dated stamp.
      expect(cold.stamp.sellerTemplatesFetchedAt).not.toBe(new Date().toISOString())

      // 2. 🔴 POSITIVE CONTROL, same run, same mock: a cold load with NO stored row still measures 0
      //    provider calls, and now says so honestly rather than pretending it had names.
      mocks.labelRead.mockResolvedValue(null)
      const empty = await withCachedSchemas(() => amazonReferenceLabels({ ...scope, productType: 'DURABLE_CACHE_ARM_EMPTY' }))
      expect(mocks.callAPI).not.toHaveBeenCalled()
      expect(empty.unavailable).toEqual(['shippingTemplate'])
      expect(empty.labels.merchant_shipping_group).toEqual({})
      expect(empty.stamp).toMatchObject({ sellerTemplates: 'cache-miss', sellerTemplateSource: 'none', sellerTemplatesFetchedAt: null })

      // 3. 🔴 THE ARM THAT DID FIRE: a gesture goes live — so "0 calls" above is a measurement.
      const live = await amazonReferenceLabels({ ...scope, productType: 'DURABLE_CACHE_ARM_LIVE' })
      expect(mocks.callAPI).toHaveBeenCalledTimes(1)
      expect(live.labels.shippingTemplate).toEqual({ 't-4f2a': 'Standard delivery' })
      expect(live.stamp).toMatchObject({ sellerTemplates: 'live', sellerTemplateSource: 'live' })

      // 4. …and the live arm WROTE what it learned, which is what makes arm 1 possible after a restart.
      expect(mocks.labelWrite).toHaveBeenCalledTimes(1)
      expect(mocks.labelWrite.mock.calls[0][0]).toMatchObject({
        where: { channel_connectionId_marketplace_productType_fieldKey: expect.objectContaining({ channel: 'AMAZON', connectionId: 'primary', marketplace: 'ES', productType: 'DURABLE_CACHE_ARM_LIVE', fieldKey: 'merchant_shipping_group' }) },
        create: expect.objectContaining({ labels: { 't-4f2a': 'Standard delivery' } }),
        update: expect.objectContaining({ labels: { 't-4f2a': 'Standard delivery' } }),
      })
    } finally { vi.unstubAllGlobals() }
  })

  /**
   * 🔴 The freshness arm the durable cache could have broken, and the reason it does not.
   *
   * `live=1` (the reference editor opening its option list) skips `withCachedSchemas` but still takes an
   * in-process memory HIT. If a cold page load seeded that memory cache from the database, the operator's
   * next "show me the live list" would serve a stored answer for up to 5 minutes — a shipping template
   * created a minute ago would be invisible in the one place it matters. So the database answer is
   * returned WITHOUT being written to the provider cache, and this is the test that says so.
   */
  it('a cold load served from the database does not make the next live gesture stale', async () => {
    const { withCachedSchemas } = await import('../pim/cached-schema-context.js')
    mocks.labelRead.mockResolvedValue({ labels: { 'old-template': 'Yesterday delivery' }, fetchedAt: new Date('2026-09-12T11:00:00.000Z') })
    mocks.callAPI.mockResolvedValue({ schema: { link: { resource: 'https://schema.test/definition' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ properties: {
      merchant_shipping_group: { type: 'array', items: { type: 'object', properties: {
        value: { type: 'string', enum: ['new-template'], enumNames: ['Today delivery'] },
      } } },
    } }) }))
    try {
      const scope = { marketplace: 'NL', productType: 'FRESHNESS_ARM', accountId: 'primary', shipping: true }
      const cold = await withCachedSchemas(() => amazonReferenceLabels(scope))
      expect(cold.labels.shippingTemplate).toEqual({ 'old-template': 'Yesterday delivery' })
      expect(mocks.callAPI).not.toHaveBeenCalled()

      // The gesture, immediately after: it MUST reach the provider and show the new template.
      const live = await amazonReferenceLabels(scope)
      expect(mocks.callAPI).toHaveBeenCalledTimes(1)
      expect(live.labels.shippingTemplate).toEqual({ 'new-template': 'Today delivery' })
      expect(live.stamp).toMatchObject({ sellerTemplateSource: 'live' })
    } finally { vi.unstubAllGlobals() }
  })

  /**
   * An EMPTY live answer must not overwrite stored names: that is
   * `reference_could_not_measure_vs_measured_empty` made durable, one row at a time.
   */
  it('never persists an empty label set over names it already has', async () => {
    mocks.callAPI.mockResolvedValue({ schema: { link: { resource: 'https://schema.test/definition' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ properties: {} }) }))
    try {
      const result = await amazonReferenceLabels({ marketplace: 'FR', productType: 'EMPTY_LIVE_ARM', accountId: 'primary', shipping: true })
      expect(mocks.callAPI).toHaveBeenCalledTimes(1)
      expect(result.labels.shippingTemplate).toEqual({})
      expect(result.unavailable).toEqual(['shippingTemplate'])
      expect(mocks.labelWrite).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })

  /**
   * A cache that can fail the page it rode in on is worse than the raw id it replaces. Both directions.
   */
  it('survives a label-cache read or write failure without failing the request', async () => {
    const { withCachedSchemas } = await import('../pim/cached-schema-context.js')
    mocks.labelRead.mockRejectedValue(new Error('relation "SellerReferenceLabel" does not exist'))
    const cold = await withCachedSchemas(() => amazonReferenceLabels({ marketplace: 'IT', productType: 'DB_DOWN_ARM', accountId: 'primary', shipping: true }))
    expect(cold.unavailable).toEqual(['shippingTemplate'])
    expect(cold.stamp).toMatchObject({ sellerTemplateSource: 'none' })
    expect(cold.labels.recommended_browse_nodes).toEqual({ '123': 'Clothing > Jackets' })

    mocks.labelWrite.mockRejectedValue(new Error('deadlock detected'))
    mocks.callAPI.mockResolvedValue({ schema: { link: { resource: 'https://schema.test/definition' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ properties: {
      merchant_shipping_group: { type: 'array', items: { type: 'object', properties: {
        value: { type: 'string', enum: ['t-1'], enumNames: ['Standard delivery'] },
      } } },
    } }) }))
    try {
      const live = await amazonReferenceLabels({ marketplace: 'IT', productType: 'DB_DOWN_WRITE_ARM', accountId: 'primary', shipping: true })
      expect(live.labels.shippingTemplate).toEqual({ 't-1': 'Standard delivery' })
    } finally { vi.unstubAllGlobals() }
  })

  it('refreshes seller choices for writes and excludes deprecated templates', async () => {
    mocks.callAPI.mockResolvedValue({ schema: { link: { resource: 'https://schema.test/definition' } } })
    let active = 'first'
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => ({ ok: true, json: async () => ({ properties: {
      merchant_shipping_group: { type: 'array', items: { type: 'object', properties: {
        value: { type: 'string', enum: [active, 'retired'], enumNames: ['Standard delivery', 'Old delivery'], $lifecycle: { enumDeprecated: ['retired'] } },
      } } },
    } }) })))
    try {
      const scope = { marketplace: 'IT', productType: 'SHOES', accountId: 'primary' }
      expect(await sellerShippingTemplateLabels({ ...scope, refresh: true })).toEqual({ first: 'Standard delivery' })
      active = 'replacement'
      expect(await sellerShippingTemplateLabels(scope)).toEqual({ first: 'Standard delivery' })
      expect(await sellerShippingTemplateLabels({ ...scope, refresh: true })).toEqual({ replacement: 'Standard delivery' })
      expect(mocks.callAPI).toHaveBeenCalledTimes(2)
    } finally { vi.unstubAllGlobals() }
  })
})
