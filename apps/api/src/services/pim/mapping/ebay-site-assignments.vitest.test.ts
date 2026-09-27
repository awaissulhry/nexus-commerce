import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * "Fill other eBay sites" — the save and its undo. Each site must go through the workspace's own review → activation
 * path, after every site's rules download, and one site's failure must not stop the others. The review machinery,
 * the rules download and the database are stubbed: no network, no database.
 */
const m = vi.hoisted(() => ({
  calls: [] as string[],
  db: { category: { findUnique: vi.fn() }, bulkOperation: { findUnique: vi.fn() }, categoryChannelMapping: { findFirst: vi.fn() } },
  readTaxonomyRequirements: vi.fn(), fillSchemaTargets: vi.fn(), createMappingImpact: vi.fn(), activateMappingImpact: vi.fn(),
  ebaySiteState: vi.fn(), clearSheet: vi.fn(), clearStudio: vi.fn(),
}))
vi.mock('../../../db.js', () => ({ default: m.db }))
vi.mock('../../../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('../../taxonomy/repository.js', () => ({ readTaxonomyRequirements: m.readTaxonomyRequirements }))
vi.mock('../schema-mapping.service.js', () => ({
  getMappingForMarketplace: vi.fn(async (_channel: string, market: string) => ({ version: 1, fields: {}, market })),
  InvalidMappingError: class extends Error { constructor(readonly errors: string[]) { super(errors.join('; ')) } },
}))
vi.mock('../../categories/schema-coverage.service.js', () => ({ fillSchemaTargets: m.fillSchemaTargets }))
vi.mock('../../categories/schema-sync.service.js', () => ({ CategorySchemaService: class {} }))
vi.mock('../../marketplaces/amazon.service.js', () => ({ AmazonService: class {} }))
vi.mock('../sheet-columns.service.js', () => ({ clearSheetColumnCache: m.clearSheet }))
vi.mock('../studio-columns.js', () => ({ clearStudioColumnCache: m.clearStudio }))
vi.mock('./impact.service.js', () => ({ createMappingImpact: m.createMappingImpact, activateMappingImpact: m.activateMappingImpact }))
vi.mock('./ebay-site-suggestions.service.js', () => ({ ebaySiteState: m.ebaySiteState }))
vi.mock('./category-mapping.service.js', () => ({ categoryName: (name: any) => name?.en?.name ?? null }))

import { applyEbaySiteAssignments, undoEbaySiteAssignments } from './ebay-site-assignments.service.js'
import { MappingConflict } from './revision-token.js'

const SAVED_AT = new Date('2026-09-27T10:00:00.000Z')
const fast = { pollMs: 1, timeoutMs: 50 }
let requirements: Record<string, string>
let invalidByJob: Record<string, number>

beforeEach(() => {
  vi.resetAllMocks()
  m.calls.length = 0
  requirements = { DE: 'missing', ES: 'ready', FR: 'stale', UK: 'ready' }
  invalidByJob = {}
  m.db.category.findUnique.mockResolvedValue({ id: 'jackets', name: { en: { name: 'Jackets' } }, slug: 'jackets' })
  m.ebaySiteState.mockResolvedValue({ sites: ['DE', 'ES', 'FR', 'IT', 'UK'], direct: new Map(), missing: new Map([['jackets', ['DE', 'ES', 'FR', 'UK']]]) })
  m.readTaxonomyRequirements.mockImplementation(async (_channel: string, market: string) => ({ state: requirements[market] }))
  m.fillSchemaTargets.mockImplementation(async ([target]: any[]) => {
    m.calls.push(`download:${target.marketplace}:${target.productType}:${target.status}`)
    return { results: [{ target, outcome: target.status === 'missing' ? 'added' : 'refreshed' }], counts: {} }
  })
  m.createMappingImpact.mockImplementation(async (input: any) => {
    m.calls.push(`review:${input.market}:${input.categoryChange.channelCategoryId}`)
    return { jobId: `job-${input.market}` }
  })
  m.db.bulkOperation.findUnique.mockImplementation(async ({ where }: any) => ({ status: 'MAPPING_REVIEW', changes: { counts: { introducedInvalid: invalidByJob[where.id] ?? 0 } }, errors: null }))
  m.activateMappingImpact.mockImplementation(async (jobId: string) => {
    if (invalidByJob[jobId]) throw new MappingConflict('This rule introduces invalid outputs. Correct the draft and preview it again before activating.')
    m.calls.push(`activate:${jobId}`)
    return { applied: true }
  })
  m.db.categoryChannelMapping.findFirst.mockImplementation(async ({ where }: any) => ({ id: `map-${where.marketplace}`, channelCategoryId: where.marketplace === 'DE' ? '177117' : '177104', reviewedAt: SAVED_AT }))
})

describe('applyEbaySiteAssignments', () => {
  it('downloads every missing or expired rule set first, then reviews and activates one site at a time', async () => {
    const result = await applyEbaySiteAssignments({ categoryId: 'jackets', assignments: [
      { market: 'de', channelCategoryId: '177117' }, { market: 'ES', channelCategoryId: '177104' }, { market: 'FR', channelCategoryId: '177104' },
    ] }, 'operator', fast)
    expect(m.calls).toEqual([
      'download:DE:177117:missing', 'download:FR:177104:stale',
      'review:DE:177117', 'activate:job-DE', 'review:ES:177104', 'activate:job-ES', 'review:FR:177104', 'activate:job-FR',
    ])
    expect(result.results).toEqual([
      { market: 'DE', channelCategoryId: '177117', outcome: 'assigned', assignedAt: SAVED_AT.toISOString() },
      { market: 'ES', channelCategoryId: '177104', outcome: 'assigned', assignedAt: SAVED_AT.toISOString() },
      { market: 'FR', channelCategoryId: '177104', outcome: 'assigned', assignedAt: SAVED_AT.toISOString() },
    ])
    expect(result.counts).toEqual({ assigned: 3, failed: 0 })
    // The review is the workspace's own category change, for that exact site, as the operator.
    expect(m.createMappingImpact).toHaveBeenCalledWith(expect.objectContaining({ channel: 'EBAY', market: 'DE', userId: 'operator', categoryChange: { categoryId: 'jackets', channelCategoryId: '177117' } }))
    expect(m.activateMappingImpact).toHaveBeenCalledWith('job-DE', 'operator')
    expect(m.fillSchemaTargets).toHaveBeenCalledWith([expect.objectContaining({ channel: 'EBAY', marketplace: 'DE', productType: '177117' })], expect.objectContaining({ refreshCached: true }))
    expect(m.clearSheet).toHaveBeenCalledTimes(1)
  })

  it('never assigns an all-sites default, and refuses a malformed request before touching anything', async () => {
    await expect(applyEbaySiteAssignments({ categoryId: 'jackets', assignments: [{ market: '*', channelCategoryId: '177104' }] }, null, fast)).rejects.toThrow('An all-sites assignment is not allowed here.')
    await expect(applyEbaySiteAssignments({ categoryId: 'jackets', assignments: [{ market: 'DE', channelCategoryId: 'COAT' }] }, null, fast)).rejects.toThrow('Choose an eBay category number')
    await expect(applyEbaySiteAssignments({ categoryId: 'jackets', assignments: [{ market: 'DE', channelCategoryId: '1' }, { market: 'de', channelCategoryId: '2' }] }, null, fast)).rejects.toThrow('listed twice')
    await expect(applyEbaySiteAssignments({ categoryId: 'jackets', assignments: [] }, null, fast)).rejects.toThrow('Choose between 1 and 20')
    await expect(applyEbaySiteAssignments({ assignments: [{ market: 'DE', channelCategoryId: '1' }] }, null, fast)).rejects.toThrow('Choose a category.')
    expect(m.createMappingImpact).not.toHaveBeenCalled()
    expect(m.fillSchemaTargets).not.toHaveBeenCalled()
  })

  it('one site failing never stops the others, and each failure says why', async () => {
    m.fillSchemaTargets.mockImplementation(async ([target]: any[]) => ({ results: [{ target, outcome: target.marketplace === 'DE' ? 'failed' : 'refreshed', error: 'eBay 503' }], counts: {} }))
    invalidByJob['job-FR'] = 4
    m.ebaySiteState.mockResolvedValue({ sites: ['DE', 'ES', 'FR', 'IT', 'UK'], direct: new Map(), missing: new Map([['jackets', ['DE', 'ES', 'FR']]]) })
    m.readTaxonomyRequirements.mockImplementation(async (_c: string, market: string) => {
      if (market === 'ES') throw new Error('This category is not present in the current marketplace taxonomy.')
      return { state: requirements[market] }
    })
    const result = await applyEbaySiteAssignments({ categoryId: 'jackets', assignments: [
      { market: 'DE', channelCategoryId: '177117' }, { market: 'ES', channelCategoryId: '999' }, { market: 'FR', channelCategoryId: '177104' },
      { market: 'UK', channelCategoryId: '177117' }, { market: 'US', channelCategoryId: '1' },
    ] }, 'operator', fast)
    const by = Object.fromEntries(result.results.map(r => [r.market, r]))
    expect(by.DE).toMatchObject({ outcome: 'failed', reason: expect.stringContaining('could not be downloaded: eBay 503') })
    expect(by.ES).toMatchObject({ outcome: 'failed', reason: 'This category is not present in the current marketplace taxonomy.' })
    expect(by.FR).toMatchObject({ outcome: 'failed', reason: expect.stringContaining('4 product fields on eBay · FR would have no valid value') })
    expect(by.UK).toMatchObject({ outcome: 'failed', reason: 'Jackets already has a category on eBay · UK. Change it in Channel assignments.' })
    expect(by.US).toMatchObject({ outcome: 'failed', reason: 'eBay · US is not an active eBay site.' })
    expect(result.counts).toEqual({ assigned: 0, failed: 5 })
    // Only FR reached a review; DE's failed download kept it out.
    expect(m.createMappingImpact).toHaveBeenCalledTimes(1)
  })

  it('a review that goes stale or runs too long assigns nothing, and the next site still runs', async () => {
    m.db.bulkOperation.findUnique.mockImplementation(async ({ where }: any) => where.id === 'job-ES' ? { status: 'MAPPING_STALE', changes: {}, errors: null }
      : where.id === 'job-FR' ? { status: 'MAPPING_SCANNING', changes: {}, errors: null }
      : { status: 'MAPPING_REVIEW', changes: { counts: { introducedInvalid: 0 } }, errors: null })
    const result = await applyEbaySiteAssignments({ categoryId: 'jackets', assignments: [
      { market: 'ES', channelCategoryId: '177104' }, { market: 'FR', channelCategoryId: '177104' }, { market: 'UK', channelCategoryId: '177117' },
    ] }, 'operator', fast)
    expect(result.results.map(r => [r.market, r.outcome])).toEqual([['ES', 'failed'], ['FR', 'failed'], ['UK', 'assigned']])
    expect(result.results[0].reason).toContain('changed while eBay · ES was being checked')
    expect(result.results[1].reason).toContain('taking longer than two minutes')
    expect(m.activateMappingImpact).toHaveBeenCalledTimes(1)
  })
})

describe('undoEbaySiteAssignments', () => {
  it('removes only the rows that save created, through the same review path with no category', async () => {
    m.db.categoryChannelMapping.findFirst.mockImplementation(async ({ where }: any) => ({
      DE: { id: 'map-DE', channelCategoryId: '177117', reviewedAt: SAVED_AT },
      // Re-assigned by someone after the save: the stamp moved on.
      FR: { id: 'map-FR', channelCategoryId: '177104', reviewedAt: new Date('2026-09-27T11:00:00.000Z') },
      // Changed to another category.
      ES: { id: 'map-ES', channelCategoryId: '11111', reviewedAt: SAVED_AT },
    } as Record<string, unknown>)[where.marketplace] ?? null)
    const stamp = SAVED_AT.toISOString()
    const result = await undoEbaySiteAssignments({ categoryId: 'jackets', assignments: [
      { market: 'DE', channelCategoryId: '177117', assignedAt: stamp }, { market: 'FR', channelCategoryId: '177104', assignedAt: stamp },
      { market: 'ES', channelCategoryId: '177104', assignedAt: stamp }, { market: 'UK', channelCategoryId: '177117', assignedAt: stamp },
    ] }, 'operator', fast)
    expect(result.results.map(r => [r.market, r.outcome])).toEqual([['DE', 'removed'], ['FR', 'unchanged'], ['ES', 'unchanged'], ['UK', 'unchanged']])
    expect(m.createMappingImpact).toHaveBeenCalledTimes(1)
    expect(m.createMappingImpact).toHaveBeenCalledWith(expect.objectContaining({ market: 'DE', categoryChange: { categoryId: 'jackets', channelCategoryId: null } }))
    expect(m.activateMappingImpact).toHaveBeenCalledWith('job-DE', 'operator')
    expect(result.counts).toEqual({ removed: 1, unchanged: 3, failed: 0 })
  })

  it('reports the existing check refusing a removal, without stopping the next site', async () => {
    invalidByJob['job-DE'] = 12
    m.db.categoryChannelMapping.findFirst.mockImplementation(async ({ where }: any) => ({ id: 'x', channelCategoryId: where.marketplace === 'DE' ? '177117' : '177104', reviewedAt: SAVED_AT }))
    const stamp = SAVED_AT.toISOString()
    const result = await undoEbaySiteAssignments({ categoryId: 'jackets', assignments: [
      { market: 'DE', channelCategoryId: '177117', assignedAt: stamp }, { market: 'FR', channelCategoryId: '177104', assignedAt: stamp },
    ] }, 'operator', fast)
    expect(result.results[0]).toMatchObject({ market: 'DE', outcome: 'failed', reason: expect.stringContaining('nothing was removed') })
    expect(result.results[1]).toMatchObject({ market: 'FR', outcome: 'removed' })
  })
})
