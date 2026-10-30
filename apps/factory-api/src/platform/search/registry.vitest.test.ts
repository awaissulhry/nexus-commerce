import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { defineIndexer, IndexerConfigError, idWhere, type SearchIndexer } from './indexer'
import { indexerFiles } from './indexer-files'
import { checkIndexers, followedEvents, loadIndexers } from './registry'
import { entryOf } from './store'

const SRC = fileURLToPath(new URL('../..', import.meta.url))
const read: SearchIndexer['read'] = async () => []

describe('the indexers folder is the registry (B-W2a-32)', () => {
  it('finds one file per record type, never a test, and the build makes each an entry point', async () => {
    const files = indexerFiles(SRC)
    expect(files.length).toBeGreaterThanOrEqual(12)
    expect(files.every((file) => /platform\/search\/indexers\/[a-z-]+\.ts$/.test(file))).toBe(true)
    const indexers = await loadIndexers(SRC)
    expect(indexers).toHaveLength(files.length)
    expect(readFileSync(fileURLToPath(new URL('../../../build.mjs', import.meta.url)), 'utf8')).toMatch(/indexerFiles\(source\)/)
  })

  it('every indexer asks a declared read permission and follows declared events', async () => {
    for (const indexer of await loadIndexers(SRC)) {
      expect(FACTORY_PERMISSIONS.get(indexer.viewPermission)?.risk, indexer.recordType).toBe('read')
      expect(Object.keys(indexer.on).length, indexer.recordType).toBeGreaterThan(0)
    }
    expect(followedEvents(await loadIndexers(SRC))).toEqual(expect.arrayContaining(['sales_order.created', 'quote.created', 'party.updated', 'lot.released']))
  })

  it('refuses a bad indexer at once', () => {
    const base = { recordType: 'SalesOrder', area: 'sales', viewPermission: 'orders.view' as const, on: { 'sales_order.created': 'subject' as const }, read }
    expect(() => defineIndexer({ ...base, recordType: 'sales order' })).toThrow(IndexerConfigError)
    expect(() => defineIndexer({ ...base, area: 'Sales' })).toThrow(/area/)
    expect(() => defineIndexer({ ...base, viewPermission: 'orders.peek' })).toThrow(/permission/)
    expect(() => defineIndexer({ ...base, on: {} })).toThrow(/no event/)
    expect(() => defineIndexer({ ...base, on: { 'sales_order.teleported': 'subject' } })).toThrow(/not declared/)
    const one = defineIndexer(base)
    expect(() => checkIndexers([one, one])).toThrow(/Two indexers of SalesOrder/)
  })

  it('reads by ids or by the page after an id', () => {
    expect(idWhere({ ids: ['a', 'b'] })).toEqual({ id: { in: ['a', 'b'] } })
    expect(idWhere({ after: 'a' })).toEqual({ id: { gt: 'a' } })
    expect(idWhere({ after: null })).toEqual({})
  })

  it("makes an entry's row: cleaned words, the title falls back to the number, the text from them all", () => {
    const indexer = defineIndexer({ recordType: 'SalesOrder', area: 'sales', viewPermission: 'orders.view', on: { 'sales_order.created': 'subject' }, read })
    const row = entryOf(indexer, { recordId: 'x', companyId: null, siteId: null, partyId: null, number: ' ORD-2026-00042 ', title: '  ', subtitle: 'Rif.\n PR-7', status: 'CONFIRMED', words: ['SEED-C1'] })
    expect(row).toEqual({ companyId: null, siteId: null, partyId: null, number: 'ORD-2026-00042', title: 'ORD-2026-00042', subtitle: 'Rif. PR-7', status: 'CONFIRMED', area: 'sales', viewPermission: 'orders.view', searchText: 'ord-2026-00042 rif pr-7 seed-c1' })
  })
})
