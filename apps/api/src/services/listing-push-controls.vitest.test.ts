import { beforeEach, expect, it, vi } from 'vitest'
const s = vi.hoisted(() => ({ find: vi.fn() }))
vi.mock('../db.js', () => ({ default: { channelListing: { findMany: s.find } } }))
import { readPushControls } from './listing-push-controls.js'
beforeEach(() => { vi.clearAllMocks(); s.find.mockResolvedValue([{id:'listing',syncPaused:false,offerClosedAt:null}]) })
it('reads full stored controls across accounts for the actual legacy identity', async () => {
 const rows = await readPushControls({channel:'ebay',externalIds:[' 123 ','123']})
 expect(rows).toEqual([{id:'listing',syncPaused:false,offerClosedAt:null}])
 expect(s.find).toHaveBeenCalledWith({where:{channel:'EBAY',OR:[{externalListingId:{in:['123']}},{platformProductId:{in:['123']}}]}})
})
it('matches physical SKU snapshot and product/variant identities without inventing a column', async () => {
 await readPushControls({channel:'AMAZON',skus:['seller'],productIds:['product'],listingIds:['listing']})
 const query=s.find.mock.calls[0][0]
 expect(query.where.OR).toContainEqual({flatFileSnapshot:{path:['sku'],equals:'seller'}})
 expect(query.where.OR).toContainEqual({product:{OR:[{sku:{in:['seller']}},{variations:{some:{sku:{in:['seller']}}}}]}})
 expect(query.where.OR).toContainEqual({id:{in:['listing']}})
 expect(query.where.OR).toContainEqual({productId:{in:['product']}})
 // S8 — ChannelListing.channelSku now exists (a listing's own channel SKU): matched with liveChannelSku, in the same statement.
 expect(query.where.OR).toContainEqual({OR:[{channelSku:{in:['seller']}},{liveChannelSku:{in:['seller']}}]})
 expect(query).not.toHaveProperty('select')
})
it('recognizes numeric and GID Shopify identities carried in platform attributes', async () => {
 await readPushControls({channel:'SHOPIFY',externalIds:['gid://shopify/ProductVariant/123']})
 expect(s.find.mock.calls[0][0].where.OR).toContainEqual({platformAttributes:{path:['variantId'],equals:'123'}})
})
it('refuses a missing identity without querying', async () => {
 await expect(readPushControls({channel:'EBAY',externalIds:[' '],allowAbsent:true})).rejects.toMatchObject({code:'PUSH_CONTROL_UNAVAILABLE'})
 expect(s.find).not.toHaveBeenCalled()
})
it('refuses unreadable and absent controls; only an explicit creation lookup allows absence', async () => {
 s.find.mockRejectedValueOnce(new Error('offline'))
 await expect(readPushControls({channel:'AMAZON',skus:['SKU'],allowAbsent:true})).rejects.toMatchObject({code:'PUSH_CONTROL_UNAVAILABLE'})
 s.find.mockResolvedValue([])
 await expect(readPushControls({channel:'AMAZON',skus:['SKU']})).rejects.toMatchObject({code:'PUSH_CONTROL_UNAVAILABLE'})
 await expect(readPushControls({channel:'AMAZON',skus:['SKU'],allowAbsent:true})).resolves.toEqual([])
})
it('S8 — a listing\'s own channel SKU is matched in the same statement, on the indexed columns only (no JSON store, no second read)', async () => {
 await readPushControls({channel:'amazon',skus:[' OWN-IT ']})
 expect(s.find).toHaveBeenCalledOnce()
 const OR=s.find.mock.calls[0][0].where.OR
 expect(OR).toContainEqual({OR:[{channelSku:{in:['OWN-IT']}},{liveChannelSku:{in:['OWN-IT']}}]})
 // The own-SKU clause names no JSON store (the pre-existing eBay snapshot clause is the only JSON condition).
 expect(JSON.stringify(OR.filter((c:any)=>!c.flatFileSnapshot))).not.toMatch(/platformAttributes|flatFileSnapshot|overrideData/)
 // Parity: the product-SKU and snapshot matches stay.
 expect(OR).toContainEqual({product:{OR:[{sku:{in:['OWN-IT']}},{variations:{some:{sku:{in:['OWN-IT']}}}}]}})
 expect(OR).toContainEqual({flatFileSnapshot:{path:['sku'],equals:'OWN-IT'}})
})
it('S8 — no own-SKU clause without a SKU', async () => {
 await readPushControls({channel:'EBAY',listingIds:['listing']})
 expect(JSON.stringify(s.find.mock.calls[0][0])).not.toContain('channelSku')
})
