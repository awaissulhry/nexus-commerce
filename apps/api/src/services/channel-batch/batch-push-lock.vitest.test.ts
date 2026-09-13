import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const s=vi.hoisted(()=>({ controls:[] as any[],read:vi.fn(),closed:vi.fn(),send:vi.fn(),sp:vi.fn(),auth:vi.fn() }))
vi.mock('../amazon-market-offer.service.js',()=>({closedMarketSet:s.closed}))
vi.mock('../listing-push-controls.js',()=>({readPushControls:s.read}))
vi.mock('../ebay-auth.service.js',()=>({EbayAuthService:class{ getValidToken=s.auth }}))
vi.mock('../../lib/amazon-sp-client.js',()=>({amazonSpClient:()=>({callAPI:s.sp})}))
import { submitShopifyBulkMutation } from './shopify-bulk-mutation.service.js'
import { submitEbayParallelBatch } from './ebay-parallel-batch.service.js'
import { submitAmazonListingsBatch } from './amazon-batch-feed.service.js'
const shop={mutation:'mutation Update($input:ProductInput!){productUpdate(input:$input){userErrors{message}}}',operations:[{input:{id:'gid://shopify/Product/123',title:'Fixture'}}],shopName:'fixture',accessToken:'mock'}
const amazon={sellerId:'fixture',marketplaceIds:['APJ6JRA9NG5V4'],operations:[{type:'stock' as const,sku:'SKU',quantity:2}]}
const locks=[{syncPaused:true},{offerClosedAt:new Date('2026-09-13')},...['HELD','WITHDRAWN','ENDED','DISCONTINUED','RELEASED'].map(presenceIntent=>({presenceIntent}))]
beforeEach(()=>{
 vi.clearAllMocks();s.closed.mockResolvedValue(new Set());s.controls=[{productId:'product',marketplace:'IT'}];s.read.mockImplementation(async()=>s.controls);s.auth.mockResolvedValue('fixture')
 vi.stubEnv('NEXUS_SHOPIFY_BULK_DRYRUN','0');vi.stubEnv('NEXUS_EBAY_BATCH_DRYRUN','0');vi.stubEnv('NEXUS_ENABLE_AMAZON_PUBLISH','true');vi.stubEnv('AMAZON_PUBLISH_MODE','live')
 vi.stubGlobal('fetch',s.send);s.send.mockResolvedValue({ok:true,status:200,text:async()=>'',json:async()=>({})})
 s.sp.mockImplementation(async({operation}:any)=>operation==='createFeedDocument'?{feedDocumentId:'doc',url:'https://fixture.invalid/upload'}:{feedId:'feed'})
})
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals()})
it.each(locks)('Shopify bulk refuses %j before upload or mutation',async lock=>{
 s.controls=[lock];await expect(submitShopifyBulkMutation(shop)).rejects.toThrow('PUSH_');expect(s.send).not.toHaveBeenCalled()
})
it('Shopify bulk collects nested product and inventory identities and submits an unlocked mocked operation',async()=>{
 s.send.mockResolvedValueOnce({ok:true,json:async()=>({data:{stagedUploadsCreate:{stagedTargets:[{url:'https://fixture.invalid/upload',resourceUrl:'path',parameters:[]}],userErrors:[]}}})})
 .mockResolvedValueOnce({ok:true}).mockResolvedValueOnce({ok:true,json:async()=>({data:{bulkOperationRunMutation:{bulkOperation:{id:'bulk',status:'CREATED'},userErrors:[]}}})})
 expect(await submitShopifyBulkMutation(shop)).toMatchObject({bulkOperationId:'bulk',dryRun:false});expect(s.send).toHaveBeenCalledTimes(3)
 expect(s.read).toHaveBeenCalledWith({channel:'SHOPIFY',externalIds:['gid://shopify/Product/123']})
})
it('Shopify explicit dry-run bypasses reads and writes even when the fixture is held',async()=>{
 vi.stubEnv('NEXUS_SHOPIFY_BULK_DRYRUN','1');s.controls=[{syncPaused:true}]
 expect((await submitShopifyBulkMutation(shop)).dryRun).toBe(true);expect(s.read).not.toHaveBeenCalled();expect(s.send).not.toHaveBeenCalled()
})
it.each(locks)('eBay batch refuses %j for stock and price',async lock=>{
 s.controls=[lock]
 const r=await submitEbayParallelBatch({connectionId:'fixture',maxRetries:0,operations:[{type:'stock',sku:'SKU',quantity:2},{type:'price',sku:'SKU',offerId:'offer',currency:'EUR',value:'2'}]})
 expect(r.failed).toBe(2);expect(r.results.every(v=>v.attempts===0&&v.errorMessage?.startsWith('PUSH_'))).toBe(true);expect(s.send).not.toHaveBeenCalled()
})
it('eBay unlocked stock writes once; lifecycle withdraw does not consult the ordinary-push lock',async()=>{
 const r=await submitEbayParallelBatch({connectionId:'fixture',maxRetries:0,operations:[{type:'stock',sku:'SKU',quantity:2},{type:'withdraw',sku:'SKU',offerId:'offer'}]})
 expect(r.succeeded).toBe(2);expect(s.send).toHaveBeenCalledTimes(2);expect(s.read).toHaveBeenCalledOnce()
})
it('eBay explicit dry-run preserves its no-transport behavior',async()=>{
 vi.stubEnv('NEXUS_EBAY_BATCH_DRYRUN','1');s.controls=[{syncPaused:true}]
 expect((await submitEbayParallelBatch({connectionId:'fixture',operations:[{type:'stock',sku:'SKU',quantity:2}]})).dryRun).toBe(true)
 expect(s.read).not.toHaveBeenCalled();expect(s.auth).not.toHaveBeenCalled();expect(s.send).not.toHaveBeenCalled()
})
it.each(locks)('Amazon batch refuses %j before document creation and feed upload',async lock=>{
 s.controls=[lock];await expect(submitAmazonListingsBatch(amazon)).rejects.toThrow('PUSH_');expect(s.sp).not.toHaveBeenCalled();expect(s.send).not.toHaveBeenCalled()
})
it('Amazon unlocked batch creates one mocked feed, and explicit rehearsal still bypasses the controls',async()=>{
 expect(await submitAmazonListingsBatch(amazon)).toMatchObject({feedId:'feed',dryRun:false});expect(s.sp).toHaveBeenCalledTimes(2);expect(s.send).toHaveBeenCalledOnce()
 vi.clearAllMocks();expect((await submitAmazonListingsBatch({...amazon,dryRun:true})).dryRun).toBe(true)
 expect(s.read).not.toHaveBeenCalled();expect(s.sp).not.toHaveBeenCalled();expect(s.send).not.toHaveBeenCalled()
})

it('Amazon cross-account closure belt refuses even an unlocked selected row',async()=>{
 s.closed.mockResolvedValue(new Set(['product|IT']))
 await expect(submitAmazonListingsBatch(amazon)).rejects.toThrow('PUSH_OFFER_CLOSED');expect(s.sp).not.toHaveBeenCalled();expect(s.send).not.toHaveBeenCalled()
})
