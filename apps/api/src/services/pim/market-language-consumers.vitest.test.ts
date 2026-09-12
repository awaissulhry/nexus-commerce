import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ findFirst: vi.fn(), warn: vi.fn(), estimate: vi.fn(() => 0.001), generate: vi.fn(() => { throw new Error('AI calls forbidden') }), network: vi.fn(() => { throw new Error('Network forbidden in language consumer tests') }) }))
vi.mock('../../db.js', () => ({ default: { marketplace: { findFirst: fixture.findFirst } } }))
vi.mock('../../utils/logger.js', () => ({ logger: { warn: fixture.warn } }))
vi.mock('../ai/providers/index.js', () => ({ getProvider: () => ({ name: 'gemini', defaultModel: 'fixture', generate: fixture.generate }), isAiKillSwitchOn: () => false }))
vi.mock('../ai/budget.service.js', () => ({ estimateCallCostUSD: fixture.estimate }))
import { marketLanguages } from './market-languages.js'
import { amazonLocale } from '../categories/marketplace-ids.js'
import { checkGpsrCompliance } from '../listing-preflight.service.js'
import { coordinatesFor } from './sheet-columns.service.js'
import { buildReviewInsertPdf } from '../reviews/review-insert-pdf.service.js'
import { ListingContentService } from '../ai/listing-content.service.js'
import { contentLanguageFor } from '../listing-wizard/ebay-publish.adapter.js'
import { SubmissionService } from '../listing-wizard/submission.service.js'

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fixture.network)
  fixture.findFirst.mockImplementation(async ({ where }) => {
    expect(where.channel).toBe('AMAZON')
    return { languages: where.code === 'BE' ? ['nl', 'fr'] : where.code === 'IT' ? ['it'] : ['fr'] }
  })
})
afterEach(() => { expect(fixture.network).not.toHaveBeenCalled(); expect(fixture.generate).not.toHaveBeenCalled(); vi.unstubAllGlobals() })

const media = (language: string) => ({ item_sku: 'LX2-FIXTURE',
  gpsr_manufacturer_reference: 'fixture@example.invalid', dsa_responsible_party_address: 'https://example.invalid/rp',
  compliance_media__source_location: 'https://example.invalid/manual.pdf', compliance_media__content_type: 'safety_information',
  compliance_media__content_language: language })

describe('LX.2 authority consumers', () => {
  it('composes Belgian wizard content and summary metadata from the Dutch group', async () => {
    const composer = new SubmissionService({ marketplace: { findMany: async () => [{ channel: 'AMAZON', code: 'BE', marketplaceId: 'BE-fixture', language: 'nl', languages: ['nl', 'fr'] }] } } as any)
    const [entry] = await composer.composeMultiChannelPayloads({ id: 'LX2-FIXTURE', channels: [{ platform: 'AMAZON', marketplace: 'BE' }], state: { productType: { productType: 'OUTERWEAR' }, content: { byGroup: {
      'nl:AMAZON': { title: { content: 'Dutch fixture title' } }, 'en:AMAZON': { title: { content: 'Wrong old fallback' } },
    } } }, channelStates: {} })
    expect(entry.language).toBe('nl')
    expect((entry.payload as any).attributes.item_name[0].value).toBe('Dutch fixture title')
  })
  it('builds the Dutch AI prompt for Belgium without generating any copy', async () => {
    const service = new ListingContentService()
    await service.previewCost({ marketplace: 'BE', channel: 'AMAZON', fields: ['title'], product: { id: 'fixture', name: 'Fixture jacket', sku: 'FIXTURE', brand: 'Fixture', bulletPoints: [], keywords: [] } as any })
    expect(fixture.estimate).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining('Dutch') }))
  })
  it.each([['DE', ['de'], 'de-DE'], ['BE', ['nl', 'fr'], 'nl-BE'], ['BE', ['fr', 'nl'], 'fr-BE'], ['GB', ['en'], 'en-GB']])('serializes eBay %s from its own configured row without publishing', async (market, languages, expected) => {
    fixture.findFirst.mockImplementationOnce(async ({ where }) => {
      expect(where.channel).toBe('EBAY')
      expect(where.code).toBe(market === 'GB' ? 'UK' : market)
      return { languages }
    })
    expect(await contentLanguageFor(`EBAY_${market}`)).toBe(expected)
  })
  it('uses Dutch schema labels for Belgium and follows a reordered authority', async () => {
    expect(await amazonLocale('BE')).toBe('nl_BE')
    fixture.findFirst.mockResolvedValueOnce({ languages: ['fr', 'nl'] })
    expect(await amazonLocale('BE')).toBe('fr_BE')
  })
  it('GPSR accepts both Belgian tags and reports ordered alternatives for a mismatch', async () => {
    const ctx = { marketplace: 'BE', languages: await marketLanguages('AMAZON', 'BE') }
    expect(checkGpsrCompliance(media('nl_BE'), ctx)).toEqual([])
    expect(checkGpsrCompliance(media('fr_BE'), ctx)).toEqual([])
    expect(checkGpsrCompliance(media('de_DE'), ctx)).toEqual([expect.objectContaining({
      field: 'compliance_media__content_language', message: expect.stringContaining('nl_BE or fr_BE'),
    })])
  })
  it('retains the Italian warning for an English manual, including auto-filled media', async () => {
    const ctx = { marketplace: 'IT', languages: await marketLanguages('AMAZON', 'IT') }
    expect(checkGpsrCompliance(media('en_GB'), ctx)).toEqual([expect.objectContaining({ message: expect.stringContaining('expected it_IT') })])
    const supplied = media('en_GB')
    const row = { item_sku: supplied.item_sku, gpsr_manufacturer_reference: supplied.gpsr_manufacturer_reference, dsa_responsible_party_address: supplied.dsa_responsible_party_address }
    expect(checkGpsrCompliance(row, { ...ctx, mediaAutoFill: supplied })).toEqual([expect.objectContaining({ message: expect.stringContaining('auto-filled user manual') })])
  })
  it('carries ordered languages into each readiness coordinate without a code-only collision', () => {
    const rows = [{ channel: 'AMAZON', code: 'BE', languages: ['nl', 'fr'] }, { channel: 'EBAY', code: 'BE', languages: ['en'] }]
    const result = coordinatesFor('BE', rows)
    expect(result.map(row => [row.channel, row.languages])).toEqual([['AMAZON', ['nl', 'fr']], ['EBAY', ['en']]])
  })
  it('reports missing Dutch review-insert copy before making a PDF', async () => {
    await expect(buildReviewInsertPdf({ brand: 'Fixture', marketplace: 'BE', products: [{ name: 'Fixture jacket', asin: 'TESTASIN01' }] })).rejects.toThrow('No reviewed review-insert copy is available for nl (BE).')
  })
  it('still builds an existing French review-insert PDF entirely offline', async () => {
    const pdf = await buildReviewInsertPdf({ brand: 'Fixture', marketplace: 'FR', products: [{ name: 'Fixture jacket', asin: 'TESTASIN01' }] })
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf.length).toBeGreaterThan(1000)
    expect(fixture.warn).not.toHaveBeenCalled()
  })
})
