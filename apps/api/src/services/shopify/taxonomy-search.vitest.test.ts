import { beforeEach, expect, it, vi } from 'vitest'
const search = vi.hoisted(()=>vi.fn())
vi.mock('../taxonomy/repository.js',()=>({searchTaxonomy:search}))
import { searchLinkedReferences } from './linked-products-gateway.js'
beforeEach(()=>{vi.resetAllMocks();search.mockResolvedValue({state:'ready',snapshotId:'revision-1',page:1,pages:2,items:[{externalId:'gid://shopify/TaxonomyCategory/aa-1',path:'Clothing › Racing Suits'}]})})
it('uses local taxonomy data and preserves exact IDs without a store API request',async()=>{
 const gql=vi.fn();const result=await searchLinkedReferences(gql,{type:'taxonomy_category',query:'suit'})
 expect(result.items[0]).toMatchObject({id:'gid://shopify/TaxonomyCategory/aa-1',label:'Clothing › Racing Suits'})
 expect(gql).not.toHaveBeenCalled()
 expect(search).toHaveBeenCalledWith('SHOPIFY','GLOBAL',expect.objectContaining({query:'suit',page:1,assignableOnly:true}))
 const cursor=JSON.parse(Buffer.from(result.cursor!,'base64url').toString());expect(cursor).toEqual({page:2,snapshotId:'revision-1',query:'suit'})
})
it('rejects a cursor reused for a different search and reports an uncached tree',async()=>{
 const gql=vi.fn(),cursor=Buffer.from(JSON.stringify({page:2,snapshotId:'revision-1',query:'old'})).toString('base64url')
 await expect(searchLinkedReferences(gql,{type:'taxonomy_category',query:'new',cursor})).rejects.toThrow('Refresh the category search')
 search.mockResolvedValue({state:'missing'})
 await expect(searchLinkedReferences(gql,{type:'taxonomy_category',query:'new'})).rejects.toThrow('Synchronize Shopify')
 expect(gql).not.toHaveBeenCalled()
})
