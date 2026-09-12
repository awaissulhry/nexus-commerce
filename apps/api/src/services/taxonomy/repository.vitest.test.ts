import { beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({
  marketplaceTaxonomy: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() },
  marketplaceTaxonomySnapshot: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  marketplaceTaxonomyNode: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn(), createMany: vi.fn() },
  categorySchema: { findFirst: vi.fn() }, marketplace: { findMany: vi.fn() }, channelConnection: { findMany: vi.fn() }, $transaction: vi.fn(),
}))
vi.mock('../../db.js', () => ({ default: db }))
vi.mock('@nexus/database/workspace-context', () => ({ workspaceKey: (value: unknown) => value }))
import { listTaxonomySources, publishTaxonomy, readTaxonomyRequirements, searchTaxonomy, schemaMarkets } from './repository.js'
import { mappingToken } from '../pim/mapping/revision-token.js'
import { taxonomySearchCache } from './search-cache.js'
const download = { providerVersion: 'v2', nodes: [{ externalId: '001', name: 'Suits', path: 'Suits', parentId: null, assignable: true }] }
const source = { id: 'source', channel: 'EBAY', marketplace: 'IT', activeSnapshotId: 'old', leaseToken: 'worker', leaseUntil: new Date(Date.now()+60_000), lastSyncedAt: new Date(), nextSyncAt: new Date(Date.now()+60_000), requestVersion: 1, completedRequestVersion: 1 }
beforeEach(() => {
  vi.resetAllMocks()
  taxonomySearchCache.clear()
  db.marketplaceTaxonomy.findFirst.mockResolvedValue(source); db.marketplaceTaxonomy.findUnique.mockResolvedValue(source)
  db.marketplaceTaxonomy.updateMany.mockResolvedValue({ count: 1 }); db.marketplaceTaxonomyNode.findMany.mockResolvedValue([])
  db.marketplaceTaxonomySnapshot.findUnique.mockResolvedValue(null)
  db.marketplaceTaxonomySnapshot.create.mockImplementation(async ({ data }) => ({ ...data, id: 'new' }))
  db.$transaction.mockImplementation(async work => work(db))
})
describe('taxonomy snapshot lifecycle', () => {
  it('publishes only after every insert succeeds and records a complete snapshot', async () => {
    const calls: string[] = []
    db.marketplaceTaxonomyNode.createMany.mockImplementation(async () => { calls.push('insert'); expect(db.marketplaceTaxonomy.updateMany).not.toHaveBeenCalled() })
    db.marketplaceTaxonomySnapshot.update.mockImplementation(async ({ data }) => { calls.push(data.status) })
    db.marketplaceTaxonomy.updateMany.mockImplementation(async () => { calls.push('activate'); return { count: 1 } })
    await publishTaxonomy('source', 'worker', download)
    expect(calls).toEqual(['insert','SUCCEEDED','activate'])
    expect(db.marketplaceTaxonomyNode.createMany.mock.calls[0][0].data[0]).toMatchObject({ externalId: '001', snapshotId: 'new' })
  })
  it('does not activate a partial import when a database batch fails', async () => {
    db.marketplaceTaxonomyNode.createMany.mockRejectedValue(new Error('disk unavailable'))
    await expect(publishTaxonomy('source','worker',download)).rejects.toThrow('disk unavailable')
    expect(db.marketplaceTaxonomy.updateMany).not.toHaveBeenCalled()
    expect(db.marketplaceTaxonomySnapshot.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }))
  })
  it('fences workers whose lease expired before activation', async () => {
    db.marketplaceTaxonomy.updateMany.mockResolvedValue({count:0})
    await expect(publishTaxonomy('source','worker',download)).rejects.toThrow('worker lease')
    expect(db.marketplaceTaxonomy.updateMany.mock.calls[0][0].where).toMatchObject({ leaseToken:'worker',leaseUntil:{gt:expect.any(Date)} })
  })
  it('reuses an unchanged revision rather than inserting duplicate trees every day', async () => {
    db.marketplaceTaxonomySnapshot.findUnique.mockResolvedValue({id:'old',contentHash:mappingToken(download.nodes),providerVersion:'v2'})
    expect((await publishTaxonomy('source','worker',download)).id).toBe('old')
    expect(db.marketplaceTaxonomySnapshot.create).not.toHaveBeenCalled()
    expect(db.marketplaceTaxonomyNode.createMany).not.toHaveBeenCalled()
  })
  it('rejects a drastically truncated tree and preserves the active version', async () => {
    db.marketplaceTaxonomyNode.findMany.mockResolvedValue(Array.from({length:101},(_,i)=>({externalId:String(i)})))
    await expect(publishTaxonomy('source','worker',download)).rejects.toThrow('fewer than half')
    expect(db.marketplaceTaxonomySnapshot.create).not.toHaveBeenCalled()
  })
})
describe('cached taxonomy reads', () => {
  it('pins paginated reads to a revision and refuses mixing two versions', async () => {
    await expect(searchTaxonomy('EBAY','IT',{snapshotId:'different',page:2})).rejects.toThrow('updated')
    expect(db.marketplaceTaxonomyNode.findMany).not.toHaveBeenCalled()
  })
  it('searches full paths and IDs with bounded stable pagination', async () => {
    db.marketplaceTaxonomyNode.findMany.mockResolvedValue(Array.from({length:101}, (_,i)=>({externalId:String(i),parentId:null,name:'Suits',path:`Racing Suits ${i}`,assignable:true})))
    const result = await searchTaxonomy('EBAY','IT',{query:'racing suit',page:2,assignableOnly:true})
    expect(result.pages).toBe(3)
    expect(result.items).toHaveLength(50)
    expect(result.items[0].externalId).toBe('50')
    expect(db.marketplaceTaxonomyNode.findMany.mock.calls[0][0].where).toEqual({snapshotId:'old'})
  })
  it('rechecks business access and active revision before serving a warm search', async () => {
    db.marketplaceTaxonomyNode.findMany.mockResolvedValue(download.nodes)
    await searchTaxonomy('EBAY','IT',{})
    db.marketplaceTaxonomy.findUnique.mockResolvedValue(null)
    expect((await searchTaxonomy('EBAY','IT',{})).state).toBe('missing')
    db.marketplaceTaxonomy.findUnique.mockResolvedValue({...source,activeSnapshotId:'replacement'})
    await expect(searchTaxonomy('EBAY','IT',{snapshotId:'old'})).rejects.toThrow('updated')
    expect(db.marketplaceTaxonomyNode.findMany).toHaveBeenCalledTimes(1)
  })
  it('distinguishes missing, expired, and retired requirements', async () => {
    db.marketplaceTaxonomyNode.findFirst.mockResolvedValue(download.nodes[0]);db.categorySchema.findFirst.mockResolvedValue(null)
    expect((await readTaxonomyRequirements('EBAY','IT','001')).state).toBe('missing')
    db.categorySchema.findFirst.mockResolvedValue({expiresAt:new Date(0)})
    expect((await readTaxonomyRequirements('EBAY','IT','001')).state).toBe('stale')
    db.marketplaceTaxonomyNode.findFirst.mockResolvedValue(null)
    await expect(readTaxonomyRequirements('EBAY','IT','001')).rejects.toThrow('not present')
  })
  it('reports counts from the active snapshot, even when another import exists', async () => {
    db.marketplace.findMany.mockResolvedValue([{channel:'EBAY',code:'IT',name:'eBay Italy'}]);db.marketplaceTaxonomy.findMany.mockResolvedValue([source]);db.channelConnection.findMany.mockResolvedValue([])
    db.marketplaceTaxonomySnapshot.findMany.mockResolvedValue([{id:'old',nodeCount:100},{id:'new',nodeCount:200}])
    expect((await listTaxonomySources())[0].nodeCount).toBe(100)
  })
  it('finds existing UK aliases while keeping country-specific categories separate', () => {
    expect(schemaMarkets('EBAY','UK')).toEqual(expect.arrayContaining(['UK','GB','EBAY_GB']))
    expect(schemaMarkets('AMAZON','DE')).not.toContain('IT')
  })
})
