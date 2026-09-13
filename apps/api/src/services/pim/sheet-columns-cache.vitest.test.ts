import { expect, it, vi } from 'vitest'
const cache = vi.hoisted(() => new Map<string, unknown>())
const readMarkets = vi.hoisted(() => vi.fn(() => { throw new Error('cache miss reaches builder') }))
vi.mock('../../lib/workspace-cache.js', () => ({ WorkspaceCache: class extends Map { get(key: string) { return cache.get(key) } } }))
vi.mock('../../db.js', () => ({ default: { marketplace: { findMany: readMarkets }, channelListing: { groupBy: vi.fn(async () => []) } } }))
vi.mock('./field-registry.service.js', () => ({ getAvailableFields: vi.fn() }))
vi.mock('./channel-specs/index.js', () => ({ loadAmazonSpec: vi.fn(), loadAmazonEnglishLabels: vi.fn(), loadEbaySpec: vi.fn() }))
vi.mock('./channel-specs/store.js', () => ({ etsyProductSpec: vi.fn() }))
import { getSheetColumns } from './sheet-columns.service.js'
it('honours a fresh channel account cache and isolates account and language keys', async () => {
 const input = { market: 'BE', accountId: 'seller', locale: 'nl', onlyChannels: ['AMAZON'] }
 const value = { columns: [], schemaAge: [{ fetchedAt: '2026-08-01T00:00:00Z' }] }
 const key = JSON.stringify(['BE', [], [], [], ['AMAZON'], false, [], [], 'channel', [], [], 'seller', 'nl'])
 cache.set(key, { at: Date.now(), value })
 for (let i = 0; i < 3; i++) expect(await getSheetColumns(input)).toBe(value as any)
 expect(readMarkets).not.toHaveBeenCalled()
 await expect(getSheetColumns({ ...input, accountId: 'other' })).rejects.toThrow('cache miss reaches builder')
 await expect(getSheetColumns({ ...input, locale: 'fr' })).rejects.toThrow('cache miss reaches builder')
 cache.set(key, { at: Date.now() - 300_001, value })
 await expect(getSheetColumns(input)).rejects.toThrow('cache miss reaches builder')
 expect(readMarkets).toHaveBeenCalledTimes(3)
})
