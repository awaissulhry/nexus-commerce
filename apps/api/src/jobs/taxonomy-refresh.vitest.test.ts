import { beforeEach, afterEach, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ list:vi.fn(),publish:vi.fn(),node:vi.fn(),download:vi.fn(),refresh:vi.fn(), db:{marketplaceTaxonomySnapshot:{updateMany:vi.fn()},marketplaceTaxonomy:{findMany:vi.fn(),createMany:vi.fn(),updateMany:vi.fn()},categorySchema:{findMany:vi.fn()},categoryChannelMapping:{findMany:vi.fn()},$transaction:vi.fn()} }))
vi.mock('../db.js',()=>({default:m.db}))
vi.mock('../lib/cron/clustered.js',()=>({default:{schedule:vi.fn()}}))
vi.mock('../utils/logger.js',()=>({logger:{warn:vi.fn(),error:vi.fn()}}))
vi.mock('../services/taxonomy/repository.js',()=>({listTaxonomySources:m.list,publishTaxonomy:m.publish,getTaxonomyNode:m.node,pruneTaxonomyNodes:async()=>{},schemaMarkets:()=>['IT']}))
vi.mock('../services/taxonomy/providers.js',()=>({taxonomyProviders:{EBAY:{requirements:'category',download:m.download}}}))
vi.mock('../services/categories/schema-sync.service.js',()=>({CategorySchemaService:class{refreshSchema=m.refresh}}))
vi.mock('../services/marketplaces/amazon.service.js',()=>({AmazonService:class{}}))
import { TaxonomyError } from '../services/taxonomy/model.js'
import { runTaxonomyRefresh } from './taxonomy-refresh.job.js'
const source = () => ({id:'source',channel:'EBAY',marketplace:'IT',activeSnapshotId:'current',schemaRequests:['bad','good'],requestVersion:3,completedRequestVersion:2,nextSyncAt:new Date(Date.now()+86400000),attempts:0})
beforeEach(()=>{vi.resetAllMocks();vi.useFakeTimers();m.list.mockResolvedValue([{channel:'EBAY',sourceMarket:'IT',sourceId:'source',supported:true}]);m.db.marketplaceTaxonomy.findMany.mockResolvedValue([source()]);m.db.marketplaceTaxonomy.updateMany.mockResolvedValue({count:1});m.db.categorySchema.findMany.mockResolvedValue([]);m.db.categoryChannelMapping.findMany.mockResolvedValue([]);m.db.$transaction.mockImplementation(work=>work(m.db));m.node.mockResolvedValue({node:{assignable:true}})})
afterEach(()=>vi.useRealTimers())
const run=async()=>{const pending=runTaxonomyRefresh();await vi.runAllTimersAsync();await pending}
it('continues past one failed requirement and queues that failure for a bounded retry',async()=>{
 m.refresh.mockImplementation(async({productType})=>{if(productType==='bad')throw new Error('Rate limited')})
 await run()
 expect(m.refresh.mock.calls.map(c=>c[0].productType)).toEqual(['bad','good'])
 expect(m.db.marketplaceTaxonomy.updateMany.mock.calls.some(([arg])=>JSON.stringify(arg.data.schemaRequests)==='["bad"]')).toBe(true)
 const release=m.db.marketplaceTaxonomy.updateMany.mock.calls.at(-1)![0]
 expect(release.data).toMatchObject({lastError:expect.stringContaining('Rate limited'),retryAt:expect.any(Date)})
 expect(m.download).not.toHaveBeenCalled()
 expect(m.db.marketplaceTaxonomy.updateMany.mock.calls.every(([arg])=>arg.data.nextSyncAt===undefined)).toBe(true)
})
it('does not clear newer requests that arrived during a refresh',async()=>{
 m.db.marketplaceTaxonomy.updateMany.mockImplementation(async arg=>({count:arg.where.requestVersion===3?0:1}))
 await run()
 const release=m.db.marketplaceTaxonomy.updateMany.mock.calls.at(-1)![0]
 expect(release.data).toMatchObject({completedRequestVersion:3})
 expect(release.data.schemaRequests).toBeUndefined()
})
it('preserves the cached tree when provider download fails',async()=>{
 m.db.marketplaceTaxonomy.findMany.mockResolvedValue([{...source(),nextSyncAt:new Date(0)}]);m.download.mockRejectedValue(new Error('Provider unavailable'))
 await run()
 expect(m.publish).not.toHaveBeenCalled()
 const release=m.db.marketplaceTaxonomy.updateMany.mock.calls.at(-1)![0]
 expect(release.data).toMatchObject({lastError:'Provider unavailable',retryAt:expect.any(Date)})
 expect(release.data.activeSnapshotId).toBeUndefined()
})
it('never claims removed or unsupported channel sources',async()=>{
 m.list.mockResolvedValue([]);await run();expect(m.db.marketplaceTaxonomy.findMany).not.toHaveBeenCalled()
})

it('skips current sources before selecting two pending refreshes',async()=>{
 m.db.marketplaceTaxonomy.findMany.mockResolvedValue([
  {...source(),id:'current',requestVersion:3,completedRequestVersion:3},
  {...source(),id:'first'}, {...source(),id:'second'}, {...source(),id:'later'},
 ])
 await run()
 const claims=m.db.marketplaceTaxonomy.updateMany.mock.calls.filter(([arg])=>arg.data.leaseToken).map(([arg])=>arg.where.id)
 expect(claims).toEqual(['first','second'])
})

it('does not retry a retired category forever, while processing other requested schemas',async()=>{
 m.node.mockImplementation(async(_channel,_market,id)=>{if(id==='bad')throw new TaxonomyError('Category retired',409,false);return {node:{assignable:true}}})
 await run()
 expect(m.refresh.mock.calls.map(c=>c[0].productType)).toEqual(['good'])
 const checkpoint=m.db.marketplaceTaxonomy.updateMany.mock.calls.find(([arg])=>arg.data.schemaRequests!==undefined)![0]
 expect(checkpoint.data.schemaRequests).toEqual([])
 expect(checkpoint.data.completedRequestVersion).toBe(3)
})
