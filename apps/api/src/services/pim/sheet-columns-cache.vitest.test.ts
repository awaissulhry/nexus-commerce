import { expect, it, vi } from 'vitest'
const cache = vi.hoisted(() => new Map<string, unknown>())
const readMarkets = vi.hoisted(() => vi.fn(() => { throw new Error('cache miss reaches builder') }))
// The stub takes the entry cap and ignores it: this file is about key isolation and the TTL. The
// cap itself is gated in `sheet-columns-bound.vitest.test.ts` and `lib/workspace-cache.vitest.test.ts`.
vi.mock('../../lib/workspace-cache.js', () => ({ WorkspaceCache: class extends Map { constructor(_maxEntriesPerWorkspace?: number) { super() } get(key: string) { return cache.get(key) } } }))
// P3b S4 — the column cache key carries the dictionary version (`dictionary-version.ts`).
vi.mock('../../db.js', () => ({ default: { marketplace: { findMany: readMarkets }, channelListing: { groupBy: vi.fn(async () => []) }, $queryRaw: async () => [{ v: 'test-dictionary' }] } }))
vi.mock('./field-registry.service.js', () => ({ getAvailableFields: vi.fn() }))
vi.mock('./channel-specs/index.js', () => ({ loadAmazonSpec: vi.fn(), loadAmazonEnglishLabels: vi.fn(), loadEbaySpec: vi.fn() }))
vi.mock('./channel-specs/store.js', () => ({ etsyProductSpec: vi.fn() }))
import { getSheetColumns } from './sheet-columns.service.js'
it('honours a fresh channel account cache and isolates account and language keys', async () => {
 const input = { market: 'BE', accountId: 'seller', locale: 'nl', onlyChannels: ['AMAZON'] }
 const value = { columns: [], schemaAge: [{ fetchedAt: '2026-08-01T00:00:00Z' }] }
 // The trailing [] is `productIds` (Step 2.4). It narrows the coordinate set, so it changes the
 // RESULT and has to be in the key — this hand-written key is the assertion that it is.
 // P3b S4 — it now starts with the dictionary version and the saved-fields mode ('all' unless a Shared view asks).
 const key = JSON.stringify(['test-dictionary', 'all', 'BE', [], [], [], ['AMAZON'], false, [], [], 'channel', [], [], 'seller', 'nl', []])
 cache.set(key, { at: Date.now(), value })
 for (let i = 0; i < 3; i++) expect(await getSheetColumns(input)).toBe(value as any)
 expect(readMarkets).not.toHaveBeenCalled()
 await expect(getSheetColumns({ ...input, accountId: 'other' })).rejects.toThrow('cache miss reaches builder')
 await expect(getSheetColumns({ ...input, locale: 'fr' })).rejects.toThrow('cache miss reaches builder')
 cache.set(key, { at: Date.now() - 300_001, value })
 await expect(getSheetColumns(input)).rejects.toThrow('cache miss reaches builder')
 expect(readMarkets).toHaveBeenCalledTimes(3)
})
