/** Live account-access audit for the active Amazon/eBay connections.
 * Run from repository root: node --import tsx docs/audits/2026-09-07-attribute-mapping/account-access-check.mts
 * Loads the normal local API environment. Never prints credentials or full channel responses.
 * Reads account identity, inventory, participation and representative schemas; publishes no listings.
 * OAuth token refresh may update the existing encrypted token through the CX token service.
 * Amazon listing/schema probes intentionally sample AIRMESH-JACKET-BLACK-MEN-XL in IT;
 * this is not a full-catalog or write-permission certification.
 */
import fs from 'node:fs/promises'
import prisma from '../../../apps/api/src/db.ts'
import { getAccessToken } from '../../../apps/api/src/services/cx/token.service.ts'
import { getChannelApp } from '../../../apps/api/src/services/cx/apps.service.ts'
import '../../../apps/api/src/services/cx/connectors/index.ts'
const report:any={checkedAt:new Date().toISOString(),configuration:process.env.ACCOUNT_ACCESS_CONFIG_SOURCE??'local',listingWrites:0,accounts:[],applications:[]}
async function json(url:string,init:RequestInit={}) {
 const res=await fetch(url,{...init,signal:AbortSignal.timeout(20000)})
 const body:any=await res.json().catch(()=>null)
 return {status:res.status,ok:res.ok,body}
}
const fail=(e:any)=>({ok:false,error:e?.name==='TimeoutError'?'timeout':'request_failed'})
try {
 const rows=await prisma.channelConnection.findMany({where:{isActive:true,channelType:{in:['AMAZON','EBAY']}},select:{id:true,channelType:true,displayName:true,externalAccountId:true,identity:true,managedBy:true,connectionMetadata:true}})
 for(const row of rows.filter(r=>r.channelType==='EBAY')) {
  const a:any={connectionId:row.id,channel:'EBAY',name:row.displayName,checks:{}}
  try {
   const token=await getAccessToken(row.id)
   const sandbox=(row.connectionMetadata as any)?.environment==='sandbox'
   const api=sandbox?'https://api.sandbox.ebay.com':'https://api.ebay.com'
   const apiz=sandbox?'https://apiz.sandbox.ebay.com':'https://apiz.ebay.com'
   const headers={Authorization:`Bearer ${token}`,'Content-Language':'en-US','Accept-Language':'en-US','Accept':'application/json'}
   const identity=await json(`${apiz}/commerce/identity/v1/user/`,{headers})
   a.checks.identity={status:identity.status,ok:identity.ok&&!!identity.body?.userId,matchesStored:!!identity.body?.userId&&identity.body.userId===(row.identity as any)?.userId,username:identity.body?.username??null}
   for(const [name,path] of [['inventoryRead','/sell/inventory/v1/inventory_item?limit=1'],['accountPrivileges','/sell/account/v1/privilege']] as const) {
    const r=await json(api+path,{headers});a.checks[name]={status:r.status,ok:r.ok,...(name==='inventoryRead'&&r.ok?{total:r.body?.total??null}:{}),...(!r.ok?{errors:(r.body?.errors??[]).map((e:any)=>({id:e.errorId,message:e.message}))}:{})}
   }
  }catch(e){a.checks.error=fail(e)}
  report.accounts.push(a)
 }
 try {
  const app=await getChannelApp('EBAY','production')
  const auth=await json('https://api.ebay.com/identity/v1/oauth2/token',{method:'POST',headers:{Authorization:`Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',scope:'https://api.ebay.com/oauth/api_scope'})})
  const a:any={channel:'EBAY',checks:{appToken:{status:auth.status,ok:auth.ok&&!!auth.body?.access_token}}}
  if(auth.ok&&auth.body?.access_token){
   const headers={Authorization:`Bearer ${auth.body.access_token}`}
   const tree=await json('https://api.ebay.com/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=EBAY_IT',{headers})
   a.checks.taxonomy={status:tree.status,ok:tree.ok,treeId:tree.body?.categoryTreeId??null}
   const listings=await prisma.channelListing.findMany({where:{channel:'EBAY',marketplace:'IT',channelConnectionId:{in:rows.filter(r=>r.channelType==='EBAY').map(r=>r.id)}},select:{platformAttributes:true},orderBy:{id:'asc'}})
   const categoryId=listings.map(l=>(l.platformAttributes as any)?.categoryId).find(v=>v&&/^\d+$/.test(String(v)))
   if(tree.ok&&tree.body?.categoryTreeId&&categoryId){
    const schema=await json(`https://api.ebay.com/commerce/taxonomy/v1/category_tree/${encodeURIComponent(tree.body.categoryTreeId)}/get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`,{headers})
    a.checks.categorySchema={status:schema.status,ok:schema.ok,categoryId,aspectCount:schema.body?.aspects?.length??0,...(!schema.ok?{errors:(schema.body?.errors??[]).map((e:any)=>({id:e.errorId,message:e.message}))}:{})}
   }else a.checks.categorySchema={ok:false,error:'No representative category ID found'}
  }
  report.applications.push(a)
 }catch(e){report.applications.push({channel:'EBAY',error:fail(e)})}
 for(const row of rows.filter(r=>r.channelType==='AMAZON')) {
  const a:any={connectionId:row.id,channel:'AMAZON',name:row.displayName,checks:{}}
  try {
   a.checks.sellerConfiguration={ok:row.managedBy==='env'&&row.externalAccountId===process.env.AMAZON_SELLER_ID}
   if(!a.checks.sellerConfiguration.ok) throw new Error('unsupported account')
   const auth=await json('https://api.amazon.com/auth/o2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:process.env.AMAZON_LWA_CLIENT_ID!,client_secret:process.env.AMAZON_LWA_CLIENT_SECRET!,refresh_token:process.env.AMAZON_REFRESH_TOKEN!})})
   a.checks.tokenRefresh={status:auth.status,ok:auth.ok&&!!auth.body?.access_token}
   if(!a.checks.tokenRefresh.ok) throw new Error('auth failed')
   const headers={'x-amz-access-token':auth.body.access_token}
   const base='https://sellingpartnerapi-eu.amazon.com'
   const p=await json(base+'/sellers/v1/marketplaceParticipations',{headers})
   a.checks.marketplaces={status:p.status,ok:p.ok,participating:(p.body?.payload??[]).filter((m:any)=>m.participation?.isParticipating).map((m:any)=>({id:m.marketplace?.id,country:m.marketplace?.countryCode,suspended:m.participation?.hasSuspendedListings??null}))}
   const sku='AIRMESH-JACKET-BLACK-MEN-XL'
   const listing=await json(`${base}/listings/2021-08-01/items/${encodeURIComponent(process.env.AMAZON_SELLER_ID!)}/${encodeURIComponent(sku)}?marketplaceIds=APJ6JRA9NG5V4&includedData=summaries`,{headers})
   a.checks.listingRead={status:listing.status,ok:listing.ok&&listing.body?.sku===sku,sku,productType:listing.body?.summaries?.[0]?.productType??null}
   const pt=listing.body?.summaries?.[0]?.productType??'COAT'
   const def=await json(`${base}/definitions/2020-09-01/productTypes/${encodeURIComponent(pt)}?marketplaceIds=APJ6JRA9NG5V4&sellerId=${encodeURIComponent(process.env.AMAZON_SELLER_ID!)}&requirements=LISTING&requirementsEnforced=ENFORCED&productTypeVersion=LATEST`,{headers})
   a.checks.categorySchema={status:def.status,ok:def.ok,productType:pt,sellerSpecific:true}
   if(def.ok&&def.body?.schema?.link?.resource){const schema=await json(def.body.schema.link.resource);a.checks.schemaDocument={status:schema.status,ok:schema.ok,propertyCount:Object.keys(schema.body?.properties??{}).length}}
  }catch(e){a.checks.error=fail(e)}
  report.accounts.push(a)
 }
 await fs.writeFile('/tmp/nexus-live-account-access.json',JSON.stringify(report,null,2)+'\n')
 console.log(JSON.stringify(report,null,2))
}finally{await prisma.$disconnect()}
