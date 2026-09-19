import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const s=vi.hoisted(()=>({controls:[] as any[],read:vi.fn(),send:vi.fn()}))
vi.mock('./listing-push-controls.js',()=>({readPushControls:s.read}))
vi.mock('./outbound-api-call-log.service.js',()=>({recordApiCall:(_input:unknown,run:()=>unknown)=>run()}))
import { EbayService } from './marketplaces/ebay.service.js'
const service = new EbayService()
const data={itemSpecifics:{},ebayTitle:'Fixture',htmlDescription:'Fixture',categoryId:'123'}
const writers:Array<[string,()=>Promise<unknown>,number]>=[
 ['create inventory',()=> (service as any).createInventoryItem('mock','SKU',data,2,'product'),1],
 ['create offer',()=> (service as any).createOffer('mock','SKU',data,2,2,'product'),1],
 ['publish offer',()=> (service as any).publishOffer('mock','offer','product','SKU'),1],
 ['new listing',()=>service.publishNewListing('SKU',data as any,2,2,'product'),3],
]
const locks=[{syncPaused:true},{offerClosedAt:new Date('2026-09-13')},...['HELD','WITHDRAWN','ENDED','DISCONTINUED','RELEASED'].map(presenceIntent=>({presenceIntent}))]
beforeEach(()=>{
 vi.clearAllMocks();s.controls=[{}];s.read.mockImplementation(async()=>s.controls)
 s.send.mockResolvedValue({ok:true,json:async()=>({offerId:'offer',listingId:'listing'})});vi.stubGlobal('fetch',s.send)
 vi.spyOn(service as any,'getAccessToken').mockResolvedValue('fixture');vi.spyOn(service,'ensureMerchantLocation').mockResolvedValue()
 // P0.1 — these model production: eBay publish mode `live`.
 vi.stubEnv('NEXUS_ENABLE_EBAY_PUBLISH','true');vi.stubEnv('EBAY_PUBLISH_MODE','live')
})
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals()})
for(const [name,run,count] of writers){
 it.each(locks)(`${name} refuses %j before a write`,async lock=>{s.controls=[lock];await expect(run()).rejects.toThrow('PUSH_');expect(s.send).not.toHaveBeenCalled()})
 it(`${name} allows an unlocked mocked submission`,async()=>{await run();expect(s.send).toHaveBeenCalledTimes(count);expect(s.read).toHaveBeenCalledWith({channel:'EBAY',skus:['SKU'],productIds:['product'],allowAbsent:true})})
}
it.each(['dry-run','sandbox'])('P0.1 — new listing in %s mode sends nothing and reads no controls',async mode=>{
 vi.stubEnv('EBAY_PUBLISH_MODE',mode)
 await expect(service.publishNewListing('SKU',data as any,2,2,'product')).rejects.toThrow('Nothing was sent to eBay')
 expect(s.send).not.toHaveBeenCalled();expect(s.read).not.toHaveBeenCalled()
})
