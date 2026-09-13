import { beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ readinessIndex: { count: vi.fn(), findMany: vi.fn() }, channelListing: { findMany: vi.fn() }, bulkOperation: { findFirst: vi.fn() }, importJobRow: { findMany: vi.fn() } }))
const forbidden = vi.hoisted(() => vi.fn(() => { throw new Error('No live resolution on the readiness page') }))
vi.mock('../../db.js', () => ({ default: db }))
vi.mock('./mapping/resolve-batch.service.js', () => ({ resolveBatch: forbidden }))
import { listingReadiness, listingReadinessWhere, readinessQuery } from './listing-readiness.service.js'
const date = new Date('2026-09-01T12:00:00Z')
const row = (language = 'nl', extra = {}) => ({ id: `r-${language}`, productId: 'p1', product: { id: 'p1', sku: 'GALE', name: 'Jacket', familyId: 'xavia' }, channel: 'AMAZON', market: 'BE', accountId: 'seller-a', aliasId: 'alternate', language, state: 'warn', pct: 50, computedAt: date, label: 'Seller A', missing: [{ field: 'title', label: 'Title', reason: 'French is missing' }], ...extra })
beforeEach(() => { vi.clearAllMocks(); db.readinessIndex.count.mockResolvedValue(200); db.readinessIndex.findMany.mockImplementation(async input => input.select ? [{ productId: 'p1' }] : [row()]) })
describe('materialized listing readiness', () => {
  it('filters before count and page and preserves the database computation time', async () => {
    const page = await listingReadiness({ familyId: 'xavia', channel: 'amazon', market: 'be', language: 'fr-BE', state: 'warn', page: '3' }, null)
    const where = { product: { deletedAt: null, OR: [{ familyId: 'xavia' }, { familyId: null, parent: { familyId: 'xavia' } }] }, channel: 'AMAZON', market: 'BE', language: 'fr', state: 'warn' }
    expect(db.readinessIndex.count).toHaveBeenCalledWith({ where })
    expect(db.readinessIndex.findMany).toHaveBeenCalledWith(expect.objectContaining({ where, skip: 50, take: 25 }))
    expect(page).toMatchObject({ total: 200, page: 3, pageSize: 25, computedAt: date.toISOString(), productCount: 1 })
    expect(forbidden).not.toHaveBeenCalled()
  })
  it('retains both market languages and exact Studio language, account and alias links', async () => {
    db.readinessIndex.findMany.mockImplementation(async input => input.select ? [{ productId: 'p1' }] : [row('nl'), row('fr')])
    const page = await listingReadiness({}, null)
    expect(page.rows.map(r => r.locale)).toEqual(['nl', 'fr'])
    for (const record of page.rows) {
      const link = new URL(record.editorHref, 'http://nexus.test')
      expect(Object.fromEntries(link.searchParams)).toMatchObject({ scope: 'AMAZON', market: 'BE', locale: record.locale, account: 'seller-a', alias: 'alternate' })
    }
  })
  it('preserves absent/null index data and does not invent a fresh timestamp for empty pages', async () => {
    db.readinessIndex.findMany.mockImplementation(async input => input.select ? [] : [row('de', { state: 'absent', pct: null })])
    expect((await listingReadiness({ language: 'de' }, null)).rows[0]).toMatchObject({ state: 'absent', pct: null })
    db.readinessIndex.findMany.mockResolvedValue([])
    expect((await listingReadiness({}, null)).computedAt).toBeNull()
  })
  it('accepts indexed marketplace channels without a second hardcoded list', async () => {
    expect(await listingReadinessWhere({ channel: 'woocommerce' }, null)).toMatchObject({ channel: 'WOOCOMMERCE' })
  })
  it('uses shared coordinates without a channel fallback', async () => {
    expect(await listingReadinessWhere({ channel: 'shared', language: 'de' }, null)).toMatchObject({ channel: null, language: 'de' })
  })
  it('keeps an explicit empty listing selection empty and never guesses another account', async () => {
    db.channelListing.findMany.mockResolvedValue([])
    expect(await listingReadinessWhere({ listingIds: 'missing' }, null)).toMatchObject({ OR: [] })
    db.channelListing.findMany.mockResolvedValue([{ productId: 'p1', channel: 'AMAZON', marketplace: 'BE', channelConnectionId: 'seller-b', aliasKey: 'alternate' }])
    expect(await listingReadinessWhere({ listingIds: 'l1' }, null)).toMatchObject({ OR: [{ productId: 'p1', channel: 'AMAZON', market: 'BE', accountId: 'seller-b', aliasId: 'alternate' }] })
  })
  it('authorizes completed import scopes and includes every saved identity without a row cap', async () => {
    db.bulkOperation.findFirst.mockResolvedValueOnce(null)
    await expect(listingReadinessWhere({ job: 'secret' }, 'viewer')).rejects.toThrow('not found')
    expect(db.bulkOperation.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'secret', userId: 'viewer' } }))
    db.bulkOperation.findFirst.mockResolvedValue({ status: 'COMPLETED', changes: { kind: 'catalog-transfer-v2' } })
    db.importJobRow.findMany.mockResolvedValue(Array.from({ length: 3000 }, (_, i) => ({ targetId: JSON.stringify(['Products', `P${i}`]) })))
    const where = await listingReadinessWhere({ job: 'owned' }, 'viewer')
    expect((where.product as any).sku.in).toHaveLength(3000)
    expect(db.importJobRow.findMany.mock.calls.at(-1)?.[0]).not.toHaveProperty('take')
  })
  it('refuses contradictory selections and invalid states/pages', () => {
    expect(() => readinessQuery({ familyId: 'f', productIds: 'p' })).toThrow('Choose one')
    expect(() => readinessQuery({ state: 'checks-passed' })).toThrow('readiness state')
    expect(() => readinessQuery({ page: '0' })).toThrow('positive')
  })
})
