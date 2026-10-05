/**
 * W3 PR-A — Amazon's English copy of a product-type definition (`CategorySchemaService.refreshEnglishCopy`).
 *
 * A non-English market (IT) is downloaded a second time with an English locale (en_GB for EU), through the SAME SP-API
 * client and the SAME marketplace id, and kept as `CategorySchema` channel `AMAZON_EN`. Stored only when Amazon's reply
 * is in English; a failure keeps the previous copy and never touches the market row; older copies are pruned. A forced
 * refresh brings it along; a plain cache miss does not.
 *
 * The provider is mocked (no network): `callAPI` answers in the locale it is asked for (unless a test says otherwise)
 * and `fetch` serves the schema document. The market languages are the catalogue's, without a database.
 * Run: npx vitest run src/services/categories/schema-english-copy.vitest.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

const m = vi.hoisted(() => ({ accountClient: vi.fn() }))
vi.mock('../marketplaces/amazon.service.js', () => ({ AmazonService: class {} }))
vi.mock('../../lib/amazon-sp-client.js', () => ({ getAmazonSpClient: m.accountClient }))
vi.mock('../pim/market-languages.js', async (actual) => {
  const { MARKET_CATALOGUE } = await import('../pim/market-catalogue.js')
  const languages = (code: string) => [...(MARKET_CATALOGUE.find(c => c.channel === 'AMAZON' && c.code === code)?.languages ?? (code === 'MX' ? ['es'] : []))]
  return { ...(await actual<object>()), marketLanguages: async (_channel: string, code: string) => languages(code.toUpperCase()) }
})

import { CategorySchemaService } from './schema-sync.service.js'
import { amazonEnglishLocale } from './marketplace-ids.js'

const IT_ID = 'APJ6JRA9NG5V4'
const body = '{"properties":{"color":{"type":"string","enum":["red"],"enumNames":["Rosso"]}}}'
const checksum = createHash('md5').update(body).digest('base64')

/** One active market row per coordinate; English copies only when a test puts one there. */
let englishCopyExists = false
const prisma = {
  categorySchema: {
    findFirst: vi.fn(async ({ where }: { where: { channel: string } }) => where.channel === 'AMAZON_EN' && englishCopyExists ? { id: 'en-old' } : null),
    findUnique: vi.fn(async () => null),
    update: vi.fn(),
    upsert: vi.fn(async (args: { create: Record<string, unknown> }) => ({ id: `row-${args.create.channel}`, ...args.create })),
    deleteMany: vi.fn(async () => ({ count: 1 })),
  },
  schemaChange: { create: vi.fn() },
}

/** `reply` overrides the locale Amazon answers with for an English request; `englishFails` makes that request throw. */
function fixture(opts: { reply?: string; englishFails?: boolean } = {}) {
  const callAPI = vi.fn(async (req: { query: { locale: string } }) => {
    if (req.query.locale.startsWith('en_') && opts.englishFails) throw new Error('QuotaExceeded')
    const locale = req.query.locale.startsWith('en_') && opts.reply ? opts.reply : req.query.locale
    return { productType: 'COAT', productTypeVersion: { version: 'RELEASE_1' }, locale, requirementsEnforced: 'ENFORCED',
      schema: { link: { resource: `https://schemas.example/coat-${locale}`, verb: 'GET' }, checksum } }
  })
  const client = { callAPI }
  m.accountClient.mockResolvedValue(client)
  return { callAPI, service: new CategorySchemaService(prisma as never, { isConfigured: async () => true, getClient: async () => client } as never) }
}
const query = (marketplace: string, extra: Record<string, unknown> = {}) => ({ channel: 'AMAZON' as const, marketplace, productType: 'COAT', ...extra })
const englishWrites = () => prisma.categorySchema.upsert.mock.calls.map(([args]) => args.create).filter(row => row.channel === 'AMAZON_EN')
const marketWrites = () => prisma.categorySchema.upsert.mock.calls.map(([args]) => args.create).filter(row => row.channel === 'AMAZON')

beforeEach(() => {
  vi.clearAllMocks()
  englishCopyExists = false
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
})
afterEach(() => vi.unstubAllGlobals())

describe('amazonEnglishLocale', () => {
  it('British English for EU markets, US English for North America, none for a market already in English', async () => {
    expect(await amazonEnglishLocale('IT')).toBe('en_GB')
    expect(await amazonEnglishLocale('de')).toBe('en_GB')
    expect(await amazonEnglishLocale('BE')).toBe('en_GB')
    expect(await amazonEnglishLocale('MX')).toBe('en_US')
    for (const english of ['UK', 'IE', 'US']) expect(await amazonEnglishLocale(english)).toBeNull()
  })
})

describe('refreshEnglishCopy', () => {
  it('IT: a forced refresh asks the same client for the same marketplace in en_GB, and stores the copy as AMAZON_EN', async () => {
    const { callAPI, service } = fixture()
    const market = await service.refreshSchema(query('IT', { accountId: 'acc-1' }))
    expect(market.channel).toBe('AMAZON')
    // The account's own client for both requests (through the gateway, like the market download).
    expect(m.accountClient.mock.calls).toEqual([['acc-1'], ['acc-1']])
    expect(callAPI.mock.calls.map(([req]) => req.query)).toEqual([
      { marketplaceIds: [IT_ID], requirements: 'LISTING', requirementsEnforced: 'ENFORCED', locale: 'it_IT' },
      { marketplaceIds: [IT_ID], requirements: 'LISTING', requirementsEnforced: 'ENFORCED', locale: 'en_GB' },
    ])
    expect(callAPI.mock.calls[1][0]).toMatchObject({ operation: 'getDefinitionsProductType', path: { productType: 'COAT' } })
    expect(englishWrites()).toEqual([expect.objectContaining({ channel: 'AMAZON_EN', marketplace: 'IT', productType: 'COAT', isActive: true })])
    expect(englishWrites()[0].schemaDefinition.__schemaProvenance).toMatchObject({ locale: 'en_GB', marketplaceId: IT_ID, providerVersion: 'RELEASE_1' })
    expect(marketWrites()).toHaveLength(1)
  })

  it('UK: the market download is already English — no second request, no copy', async () => {
    const { callAPI, service } = fixture()
    await service.refreshSchema(query('UK'))
    expect(callAPI.mock.calls.map(([req]) => req.query.locale)).toEqual(['en_GB'])
    expect(await service.refreshEnglishCopy(query('UK'))).toBe('notNeeded')
    expect(callAPI).toHaveBeenCalledTimes(1)
    expect(englishWrites()).toEqual([])
  })

  it('a reply in the market language (it_IT) is not stored, and counts as failed', async () => {
    const { callAPI, service } = fixture({ reply: 'it_IT' })
    expect(await service.refreshEnglishCopy(query('IT'))).toBe('failed')
    expect(callAPI).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
    expect(englishWrites()).toEqual([])
    expect(prisma.categorySchema.deleteMany).not.toHaveBeenCalled()
  })

  it('a failure keeps both rows: the market refresh still succeeds, nothing is deleted or overwritten', async () => {
    englishCopyExists = true
    const { service } = fixture({ englishFails: true })
    const market = await service.refreshSchema(query('IT'))
    expect(market.channel).toBe('AMAZON')
    expect(marketWrites()).toHaveLength(1)
    expect(englishWrites()).toEqual([])
    expect(prisma.categorySchema.deleteMany).not.toHaveBeenCalled()
    expect(prisma.categorySchema.update).not.toHaveBeenCalled()
    // A checksum mismatch on the English document is a failure too, with the same guarantees.
    const again = fixture()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"properties":{"tampered":{}}}')))
    expect(await again.service.refreshEnglishCopy(query('IT'))).toBe('failed')
    expect(englishWrites()).toEqual([])
    expect(prisma.categorySchema.deleteMany).not.toHaveBeenCalled()
  })

  it('after a store, older English copies of the coordinate are pruned — never the market row, never a newer copy', async () => {
    const { service } = fixture()
    expect(await service.refreshEnglishCopy(query('IT'))).toBe('stored')
    const stored = await prisma.categorySchema.upsert.mock.results[0].value
    expect(prisma.categorySchema.deleteMany.mock.calls).toEqual([[{ where: {
      channel: 'AMAZON_EN', marketplace: 'IT', productType: 'COAT', id: { not: stored.id }, fetchedAt: { lt: stored.fetchedAt },
    } }]])
  })

  it('onlyIfMissing: a present copy costs no request; a missing one is downloaded', async () => {
    const { callAPI, service } = fixture()
    englishCopyExists = true
    expect(await service.refreshEnglishCopy(query('IT'), { onlyIfMissing: true })).toBe('present')
    expect(callAPI).not.toHaveBeenCalled()
    englishCopyExists = false
    expect(await service.refreshEnglishCopy(query('IT'), { onlyIfMissing: true })).toBe('stored')
    expect(callAPI.mock.calls.map(([req]) => req.query.locale)).toEqual(['en_GB'])
  })

  it('a plain cache miss does not fetch it, and a forced refresh can leave it to its caller', async () => {
    const { callAPI, service } = fixture()
    await service.getSchema(query('IT'))
    await service.refreshSchema(query('IT'), { englishCopy: false })
    expect(callAPI.mock.calls.map(([req]) => req.query.locale)).toEqual(['it_IT', 'it_IT'])
    expect(englishWrites()).toEqual([])
  })

  it('never for another channel', async () => {
    const { callAPI, service } = fixture()
    expect(await service.refreshEnglishCopy({ channel: 'EBAY', marketplace: 'IT', productType: '177104' })).toBe('notNeeded')
    expect(callAPI).not.toHaveBeenCalled()
  })
})
