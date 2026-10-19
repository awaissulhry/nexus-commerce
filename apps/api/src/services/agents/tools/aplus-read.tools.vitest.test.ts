/**
 * Amazon A+ content (2026-10-19) — aplus-content as Claude calls it. Amazon is a stand-in (aplus-client mocked with
 * fixtures); the module guide, documentHash and summarizeModules are the real ones (aplus-modules is pure).
 *
 * Held here: the flags; view list (kind from the badges, the first ASINs, a cursor bound to its list); view document
 * (the modules verbatim, documentHash, the ASINs' badges); view asin (publish records paired with their documents'
 * names); view modules (no Amazon call, no market); and every failure answered as a sentence, never thrown, with
 * nothing fetched before the account resolves.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  class AplusError extends Error {
    constructor(readonly code: string, message: string, readonly status: number, readonly operation: string, readonly amazon: unknown[] = []) {
      super(message)
      this.name = 'AplusError'
    }
  }
  return {
    AplusError,
    resolve: vi.fn(),
    search: vi.fn(),
    get: vi.fn(),
    relations: vi.fn(),
    allRelations: vi.fn(),
    records: vi.fn(),
    warn: vi.fn(),
  }
})

vi.mock('../../../db.js', () => ({ default: {} }))
vi.mock('../../../utils/logger.js', () => ({ logger: { warn: h.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../../aplus/aplus-client.js', () => ({
  AplusError: h.AplusError,
  aplusErrorSentence: (error: unknown) => (error instanceof h.AplusError ? `Amazon said: ${error.message}` : 'Nexus could not read it.'),
  resolveAplusMarket: h.resolve,
  searchContentDocuments: h.search,
  getContentDocument: h.get,
  listContentDocumentAsinRelations: h.relations,
  listAllAsinRelations: h.allRelations,
  searchContentPublishRecords: h.records,
}))

import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import { APLUS_DOCUMENT_RULES, APLUS_MODULE_TYPES, aplusModuleGuide, documentHash, summarizeModules } from '../../aplus/aplus-modules.js'
import type { ToolContext } from '../tool-types.js'
import { APLUS_READ_TOOLS } from './aplus-read.tools.js'

const tool = APLUS_READ_TOOLS[0]
const ctx: ToolContext = { can: () => true, via: 'claude' }
const run = (args: Record<string, unknown>) => tool.handler(tool.input.parse(args) as Record<string, unknown>, ctx)
const amazonCalls = () => [h.search, h.get, h.relations, h.allRelations, h.records].reduce((n, fn) => n + fn.mock.calls.length, 0)

const IT = { accountId: 'acc-1', marketplaceId: 'APJ6JRA9NG5V4', market: 'IT', marketName: 'Amazon.it', language: 'it', locale: 'it-IT', publishMode: 'live' }
const TARGET = { accountId: 'acc-1', marketplaceId: 'APJ6JRA9NG5V4' }
const meta = (name: string, status: string, badgeSet: string[]) => ({ name, marketplaceId: IT.marketplaceId, status, badgeSet, updateTime: '2026-10-18T10:00:00Z' })
const asinsOf = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `B0000000${String(from + i).padStart(2, '0')}`)
const relation = (asin: string, badgeSet: string[] = []) => ({ asin, badgeSet, parent: null, title: null, imageUrl: null, contentReferenceKeySet: [] })

/** A Premium document as Amazon keeps it: an image already at Amazon, with its crop, and decorated text. */
const PREMIUM_DOCUMENT = {
  name: 'Jacket A+',
  contentType: 'EBC',
  locale: 'it-IT',
  contentModuleList: [
    {
      contentModuleType: 'PREMIUM_TEXT',
      premiumText: {
        headline: { value: 'Giacca da moto' },
        description: [{ textList: [{ value: 'Protezioni certificate.', decoratorSet: [{ type: 'STYLE_BOLD', offset: 0, length: 10, depth: 0 }] }] }],
      },
    },
    {
      contentModuleType: 'PREMIUM_IMAGE_TEXT',
      premiumImageText: {
        positionType: 'LEFT',
        headline: { value: 'Rete traspirante' },
        image: {
          uploadDestinationId: 'aplus-media/sc/abc123.jpg',
          imageCropSpecification: { size: { width: { value: 800, units: 'pixels' }, height: { value: 600, units: 'pixels' } }, offset: { x: { value: 0, units: 'pixels' }, y: { value: 0, units: 'pixels' } } },
          altText: 'Rete sul retro',
        },
      },
    },
  ],
}

beforeEach(() => {
  for (const fn of [h.resolve, h.search, h.get, h.relations, h.allRelations, h.records, h.warn]) fn.mockReset()
  h.resolve.mockResolvedValue(IT)
})

describe('aplus-content — the tool', () => {
  it('is a live read of Amazon, low risk, behind the A+ permission, with no change contract', () => {
    expect(APLUS_READ_TOOLS.map((t) => t.name)).toEqual(['aplus-content'])
    expect(tool).toMatchObject({ title: 'Amazon A+ content', category: 'listings', readOnly: true, openWorld: true, riskTier: 'low', requires: [F.aplusManage] })
    expect(tool.title.length).toBeLessThanOrEqual(40)
    for (const key of ['execute', 'undo', 'reversibility', 'maxClaudeTrust', 'limits', 'withinLimits', 'alwaysAsk', 'surfaces']) {
      expect(tool[key as keyof typeof tool]).toBeUndefined()
    }
    expect(tool.description).toMatch(/^Amazon A\+ content of one market, read live from Amazon \(nothing is stored in Nexus\)\./)
    expect(tool.description).toMatch(/keep each image's uploadDestinationId and imageCropSpecification/)
    expect(tool.description).toMatch(/read its status at most once an hour\. Read only\.$/)
  })

  it('takes its arguments as Amazon names them: market and ASINs in capitals, view in small letters, ASINs bounded', () => {
    expect(tool.input.parse({ market: ' it ', view: 'LIST' })).toEqual({ market: 'IT', view: 'list' })
    expect(tool.input.parse({ asins: ['b000000001'] }).asins).toEqual(['B000000001'])
    expect(tool.input.parse({ type: 'premium_image_text' }).type).toBe('PREMIUM_IMAGE_TEXT')
    expect(tool.input.safeParse({ asins: ['B00000001'] }).success).toBe(false)
    expect(tool.input.safeParse({ asins: asinsOf(21) }).success).toBe(false)
    expect(tool.input.safeParse({ asins: [] }).success).toBe(false)
    expect(tool.input.safeParse({ type: 'PREMIUM_QUOTE_BLOCK' }).success).toBe(false)
    expect(tool.input.safeParse({ view: 'everything' }).success).toBe(false)
    expect(tool.input.safeParse({ cursor: 'x'.repeat(2001) }).success).toBe(false)
    // The cross-business probe's arguments (every key named, the unused ones undefined).
    expect(tool.input.safeParse({ market: 'IT', view: 'list', accountId: undefined, contentReferenceKey: undefined, asins: undefined, cursor: undefined, type: undefined }).success).toBe(true)
  })

  it('describes every argument, requires none, and bounds its list (the schema Claude is shown)', () => {
    const schema = z.toJSONSchema(tool.input, { io: 'input' }) as { properties: Record<string, { description?: string; maxItems?: number }>; required?: string[] }
    expect(Object.keys(schema.properties).sort()).toEqual(['accountId', 'asins', 'contentReferenceKey', 'cursor', 'market', 'type', 'view'])
    for (const [name, property] of Object.entries(schema.properties)) expect(property.description, name).toMatch(/\S/)
    expect(schema.required ?? []).toEqual([])
    expect(schema.properties.asins.maxItems).toBe(20)
  })
})

describe('view list', () => {
  beforeEach(() => {
    h.search.mockResolvedValue({
      records: [
        { contentReferenceKey: 'k-premium', contentMetadata: meta('Jacket A+', 'APPROVED', ['PREMIUM']) },
        { contentReferenceKey: 'k-standard', contentMetadata: meta('Gloves A+', 'DRAFT', ['STANDARD', 'BULK']) },
        { contentReferenceKey: 'k-story', contentMetadata: meta('Our story', 'SUBMITTED', []) },
      ],
      nextPageToken: 'amazon-page-2',
      warnings: [],
    })
    h.relations.mockImplementation(async (_t: unknown, key: string) => {
      if (key === 'k-premium') return { asins: asinsOf(25).map((a) => relation(a)), nextPageToken: null, warnings: [] }
      if (key === 'k-standard') return { asins: asinsOf(2, 50).map((a) => relation(a)), nextPageToken: 'more', warnings: [{ code: 'W1', message: 'a warning' }] }
      return { asins: [], nextPageToken: null, warnings: [] }
    })
  })

  it('lists the documents of Amazon\'s page: kind from the badges, the first 20 ASINs, moreAsins when there are more', async () => {
    const out = await run({ market: 'IT' })
    expect(out.ok).toBe(true)
    const data = out.data as any
    expect(data).toMatchObject({ market: 'IT', marketplaceId: 'APJ6JRA9NG5V4', accountId: 'acc-1' })
    expect(data.documents.map((d: any) => [d.contentReferenceKey, d.kind, d.status])).toEqual([
      ['k-premium', 'premium', 'APPROVED'], ['k-standard', 'standard', 'DRAFT'], ['k-story', 'brand-story', 'SUBMITTED'],
    ])
    expect(data.documents[0]).toMatchObject({ name: 'Jacket A+', badges: ['PREMIUM'], updatedAt: '2026-10-18T10:00:00Z', moreAsins: true })
    expect(data.documents[0].asins).toEqual(asinsOf(20))
    expect(data.documents[1]).toMatchObject({ asins: asinsOf(2, 50), moreAsins: true })
    expect(data.documents[2]).toEqual(expect.objectContaining({ asins: [] }))
    expect(data.documents[2].moreAsins).toBeUndefined()
    expect(data.warnings).toEqual([{ code: 'W1', message: 'a warning' }])
    expect(data.note).toMatch(/Read live from Amazon; a live read works only in the deployed API \(channel logins are sealed there\)/)
    // The account and the marketplace only, the first page of each document's ASINs (no metadata).
    expect(h.search).toHaveBeenCalledWith(TARGET, undefined)
    expect(h.relations.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([[TARGET, 'k-premium', undefined], [TARGET, 'k-standard', undefined], [TARGET, 'k-story', undefined]])
    expect(h.resolve).toHaveBeenCalledWith({ market: 'IT' })
  })

  it('nextCursor carries Amazon\'s page token, bound to the list: it reads the next page; an altered one or another account\'s is refused', async () => {
    const first = (await run({ market: 'IT', accountId: 'acc-1' })).data as any
    expect(first.nextCursor).toEqual(expect.any(String))
    expect(first.nextCursor).toContain('amazon-page-2')
    expect(first.hint).toMatch(/cursor set to nextCursor/)
    expect(h.resolve).toHaveBeenCalledWith({ market: 'IT', accountId: 'acc-1' })

    h.search.mockClear()
    expect((await run({ market: 'IT', cursor: first.nextCursor })).ok).toBe(true)
    expect(h.search).toHaveBeenCalledWith(TARGET, 'amazon-page-2')

    h.search.mockClear()
    const altered = first.nextCursor.replace('amazon-page-2', 'amazon-page-9')
    expect(await run({ market: 'IT', cursor: altered })).toMatchObject({ ok: false, error: expect.stringMatching(/^aplus-content was called wrongly — cursor: /) })
    expect(await run({ market: 'IT', cursor: 'amazon-page-2' })).toMatchObject({ ok: false, error: expect.stringMatching(/called wrongly/) })
    h.resolve.mockResolvedValue({ ...IT, accountId: 'acc-2' })
    expect(await run({ market: 'IT', cursor: first.nextCursor })).toMatchObject({ ok: false, error: expect.stringMatching(/called wrongly/) })
    expect(h.search).not.toHaveBeenCalled()
  })

  it('the last page has no cursor; a document whose ASINs Amazon refused is listed with asins null and named in notRead', async () => {
    h.search.mockResolvedValue({ records: [{ contentReferenceKey: 'k-premium', contentMetadata: meta('Jacket A+', 'APPROVED', ['PREMIUM']) }], nextPageToken: null, warnings: [] })
    h.relations.mockRejectedValue(new h.AplusError('throttled', 'busy', 429, 'aplus.listContentDocumentAsinRelations'))
    const data = (await run({ market: 'IT' })).data as any
    expect(data.nextCursor).toBeNull()
    expect(data.hint).toBeUndefined()
    expect(data.documents[0]).toMatchObject({ contentReferenceKey: 'k-premium', asins: null })
    expect(data.notRead).toEqual([{ part: 'the ASINs of k-premium', why: 'Amazon said: busy' }])
  })
})

describe('view document', () => {
  beforeEach(() => {
    h.get.mockResolvedValue({
      record: { contentReferenceKey: 'k-premium', contentMetadata: meta('Jacket A+', 'APPROVED', ['PREMIUM']), contentDocument: PREMIUM_DOCUMENT },
      warnings: [{ code: 'W0', message: 'old module' }],
    })
    h.allRelations.mockResolvedValue({
      asins: [
        { ...relation('B000000001', ['CONTENT_PUBLISHED']), title: 'Giacca Airmesh', parent: 'B0000000P1' },
        relation('B000000002', ['CONTENT_NOT_PUBLISHED']),
      ],
      complete: true,
      warnings: [],
    })
  })

  it('shows the document in full: modules exactly as Amazon keeps them, documentHash, the ASINs with their badges', async () => {
    const out = await run({ market: 'IT', contentReferenceKey: 'k-premium' })
    expect(out.ok).toBe(true)
    const data = out.data as any
    expect(data).toMatchObject({
      market: 'IT', marketplaceId: 'APJ6JRA9NG5V4', accountId: 'acc-1',
      contentReferenceKey: 'k-premium', name: 'Jacket A+', status: 'APPROVED', kind: 'premium', badges: ['PREMIUM'],
      updatedAt: '2026-10-18T10:00:00Z', contentType: 'EBC', contentSubType: null, locale: 'it-IT', asinsComplete: true,
      asinTotal: 2, publishedOn: 1,
    })
    expect(data.modules).toEqual(PREMIUM_DOCUMENT.contentModuleList)
    expect(data.modules[1].premiumImageText.image).toMatchObject({ uploadDestinationId: 'aplus-media/sc/abc123.jpg', imageCropSpecification: expect.any(Object) })
    expect(data.documentHash).toBe(documentHash(PREMIUM_DOCUMENT as never))
    expect(data.moduleSummary).toEqual(summarizeModules(PREMIUM_DOCUMENT.contentModuleList as never))
    expect(data.asins).toEqual([
      { asin: 'B000000001', title: 'Giacca Airmesh', parent: 'B0000000P1', badges: ['CONTENT_PUBLISHED'] },
      { asin: 'B000000002', title: null, parent: null, badges: ['CONTENT_NOT_PUBLISHED'] },
    ])
    expect(data.warnings).toEqual([{ code: 'W0', message: 'old module' }])
    expect(h.get).toHaveBeenCalledWith(TARGET, 'k-premium', 'CONTENTS,METADATA')
    expect(h.allRelations).toHaveBeenCalledWith(TARGET, 'k-premium', { metadata: true })
  })

  it('a Brand Story document is kind brand-story; an incomplete ASIN list says so; ASINs Amazon refused are null, not empty', async () => {
    h.get.mockResolvedValue({
      record: {
        contentReferenceKey: 'k-story', contentMetadata: meta('Our story', 'DRAFT', []),
        contentDocument: { name: 'Our story', contentType: 'BrandStory', locale: 'it-IT', contentModuleList: [] },
      },
      warnings: [],
    })
    h.allRelations.mockResolvedValue({ asins: [relation('B000000001')], complete: false, warnings: [] })
    const story = (await run({ market: 'IT', contentReferenceKey: 'k-story' })).data as any
    expect(story).toMatchObject({ kind: 'brand-story', contentType: 'BrandStory', asinsComplete: false })
    expect(story.note).toMatch(/not complete/)

    h.allRelations.mockRejectedValue(new h.AplusError('forbidden', 'no role', 403, 'aplus.listContentDocumentAsinRelations'))
    const refused = (await run({ market: 'IT', contentReferenceKey: 'k-story' })).data as any
    expect(refused).toMatchObject({ asins: null, asinTotal: null, asinsComplete: false, notRead: [{ part: 'its ASINs', why: 'Amazon said: no role' }] })
  })

  it('a document Amazon answers without its contents is a sentence, not an empty document', async () => {
    h.get.mockResolvedValue({ record: { contentReferenceKey: 'k-x', contentMetadata: meta('X', 'DRAFT', ['STANDARD']), contentDocument: null }, warnings: [] })
    expect(await run({ market: 'IT', contentReferenceKey: 'k-x' })).toMatchObject({ ok: false, error: expect.stringMatching(/without its contents/) })
    expect(h.allRelations).not.toHaveBeenCalled()
  })
})

describe('view asin', () => {
  it('pairs each ASIN\'s publish records with their documents\' names and statuses (one METADATA read per document)', async () => {
    h.records.mockImplementation(async (_t: unknown, asin: string) => ({
      records: asin === 'B000000001'
        ? [
          { marketplaceId: IT.marketplaceId, locale: 'it_IT', asin, contentType: 'EBC', contentSubType: null, contentReferenceKey: 'k-premium' },
          { marketplaceId: IT.marketplaceId, locale: 'it_IT', asin, contentType: 'BrandStory', contentSubType: null, contentReferenceKey: 'k-story' },
        ]
        : asin === 'B000000002'
          ? [{ marketplaceId: IT.marketplaceId, locale: 'it_IT', asin, contentType: 'EBC', contentSubType: null, contentReferenceKey: 'k-premium' }]
          : [],
      nextPageToken: null,
      warnings: [],
    }))
    h.get.mockImplementation(async (_t: unknown, key: string, data: string) => {
      expect(data).toBe('METADATA')
      if (key === 'k-premium') return { record: { contentReferenceKey: key, contentMetadata: meta('Jacket A+', 'APPROVED', ['PREMIUM']), contentDocument: null }, warnings: [] }
      throw new h.AplusError('not_found', 'no such document', 404, 'aplus.getContentDocument')
    })
    const out = await run({ market: 'IT', asins: ['B000000001', 'b000000002', 'B000000001', 'B000000003'] })
    expect(out.ok).toBe(true)
    const data = out.data as any
    expect(data.asins).toEqual([
      {
        asin: 'B000000001',
        aPlus: { contentReferenceKey: 'k-premium', name: 'Jacket A+', status: 'APPROVED', locale: 'it-IT' },
        brandStory: { contentReferenceKey: 'k-story', name: null, status: null, locale: 'it-IT' },
      },
      { asin: 'B000000002', aPlus: { contentReferenceKey: 'k-premium', name: 'Jacket A+', status: 'APPROVED', locale: 'it-IT' }, brandStory: null },
      { asin: 'B000000003', aPlus: null, brandStory: null },
    ])
    expect(data.notRead).toEqual([{ part: 'the name and status of k-story', why: 'Amazon said: no such document' }])
    // Each ASIN once, each document once.
    expect(h.records.mock.calls.map((c) => [c[0], c[1]])).toEqual([[TARGET, 'B000000001'], [TARGET, 'B000000002'], [TARGET, 'B000000003']])
    expect(h.get.mock.calls.map((c) => c[1]).sort()).toEqual(['k-premium', 'k-story'])
  })

  it('a market with two languages: the market\'s own is aPlus, the other is listed; every page of records is read', async () => {
    h.records
      .mockResolvedValueOnce({ records: [{ marketplaceId: IT.marketplaceId, locale: 'en_GB', asin: 'B000000001', contentType: 'EBC', contentSubType: null, contentReferenceKey: 'k-en' }], nextPageToken: 'p2', warnings: [] })
      .mockResolvedValueOnce({ records: [{ marketplaceId: IT.marketplaceId, locale: 'it_IT', asin: 'B000000001', contentType: 'EBC', contentSubType: null, contentReferenceKey: 'k-it' }], nextPageToken: null, warnings: [] })
    h.get.mockImplementation(async (_t: unknown, key: string) => ({ record: { contentReferenceKey: key, contentMetadata: meta(key, 'APPROVED', ['STANDARD']), contentDocument: null }, warnings: [] }))
    const data = (await run({ market: 'IT', asins: ['B000000001'] })).data as any
    expect(data.asins[0]).toMatchObject({
      aPlus: { contentReferenceKey: 'k-it', locale: 'it-IT' },
      alsoPublished: [{ kind: 'a-plus', contentReferenceKey: 'k-en', locale: 'en-GB' }],
    })
    expect(h.records.mock.calls.map((c) => c[2])).toEqual([undefined, 'p2'])
  })

  it('an ASIN Amazon refused is named in notRead; when every one is refused, the answer is Amazon\'s sentence', async () => {
    h.records.mockImplementation(async (_t: unknown, asin: string) => {
      if (asin === 'B000000002') throw new h.AplusError('invalid', 'bad ASIN', 400, 'aplus.searchContentPublishRecords')
      return { records: [], nextPageToken: null, warnings: [] }
    })
    const some = (await run({ market: 'IT', asins: ['B000000001', 'B000000002'] })).data as any
    expect(some.asins).toEqual([{ asin: 'B000000001', aPlus: null, brandStory: null }])
    expect(some.notRead).toEqual([{ part: 'ASIN B000000002', why: 'Amazon said: bad ASIN' }])

    expect(await run({ market: 'IT', asins: ['B000000002'] })).toEqual({ ok: false, error: 'Amazon said: bad ASIN' })
  })
})

describe('view modules', () => {
  it('is Nexus\'s own guide: no market, no account, no Amazon call; type narrows it to one module', async () => {
    const all = await run({ view: 'modules' })
    expect(all.ok).toBe(true)
    expect((all.data as any).rules).toBe(APLUS_DOCUMENT_RULES)
    expect((all.data as any).modules).toEqual(aplusModuleGuide())
    expect((all.data as any).modules).toHaveLength(APLUS_MODULE_TYPES.length)
    const one = await run({ type: 'premium_image_text' })
    expect((one.data as any).modules).toEqual(aplusModuleGuide('PREMIUM_IMAGE_TEXT'))
    expect((one.data as any).modules.map((m: any) => m.type)).toEqual(['PREMIUM_IMAGE_TEXT'])
    expect(h.resolve).not.toHaveBeenCalled()
    expect(amazonCalls()).toBe(0)
  })
})

describe('every failure is an answer, never a throw; nothing is fetched before the account resolves', () => {
  it('a call its view cannot answer is refused before the market is read', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{}, /view list needs market/],
      [{ contentReferenceKey: 'k1' }, /view document needs market/],
      [{ view: 'document', market: 'IT' }, /needs contentReferenceKey/],
      [{ view: 'asin', market: 'IT' }, /needs asins/],
      [{ view: 'list', market: 'IT', asins: ['B000000001'] }, /asins is for view asin, not view list/],
      [{ market: 'IT', contentReferenceKey: 'k1', asins: ['B000000001'] }, /asins is for view asin, not view document/],
      [{ view: 'document', market: 'IT', contentReferenceKey: 'k1', cursor: 'c' }, /cursor is for view list/],
      [{ view: 'list', market: 'IT', type: 'STANDARD_TEXT' }, /type is for view modules/],
    ]
    for (const [args, error] of cases) expect(await run(args), JSON.stringify(args)).toMatchObject({ ok: false, error: expect.stringMatching(error) })
    expect(h.resolve).not.toHaveBeenCalled()
    expect(amazonCalls()).toBe(0)
  })

  it('a market or account this business does not have is resolveAplusMarket\'s sentence, and Amazon is never asked', async () => {
    h.resolve.mockResolvedValue({ error: 'Amazon account not found for this business: no Amazon account.' })
    for (const args of [{ market: 'IT' }, { market: 'IT', contentReferenceKey: 'k1' }, { market: 'IT', asins: ['B000000001'] }]) {
      expect(await run(args)).toEqual({ ok: false, error: 'Amazon account not found for this business: no Amazon account.' })
    }
    expect(amazonCalls()).toBe(0)
  })

  it('Amazon\'s refusal is its sentence; a fault in Nexus is logged and answered too; the market is read before Amazon', async () => {
    h.search.mockRejectedValue(new h.AplusError('forbidden', 'no Product Listing role', 403, 'aplus.searchContentDocuments'))
    expect(await run({ market: 'IT' })).toEqual({ ok: false, error: 'Amazon said: no Product Listing role' })
    expect(h.resolve.mock.invocationCallOrder[0]).toBeLessThan(h.search.mock.invocationCallOrder[0])
    expect(h.warn).not.toHaveBeenCalled()

    h.get.mockRejectedValue(new TypeError('cannot read properties of undefined'))
    expect(await run({ market: 'IT', contentReferenceKey: 'k1' })).toEqual({ ok: false, error: 'Nexus could not read it.' })
    expect(h.warn).toHaveBeenCalledTimes(1)

    h.resolve.mockRejectedValue(new Error('database down'))
    expect(await run({ market: 'IT', asins: ['B000000001'] })).toEqual({ ok: false, error: 'Nexus could not read it.' })
    expect(h.records).not.toHaveBeenCalled()
  })
})
