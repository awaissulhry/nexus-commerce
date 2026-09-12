import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createServer } from 'vite'
const root = fileURLToPath(new URL('.', import.meta.url)), repo = resolve(root, '../../../..')
const token = 'a'.repeat(64), writes = []; let conflict = false, schemaReady = false, impact = null
let rows = Array.from({ length: 125 }, (_, i) => ({ id: `cat-${i}`, parentId: i === 1 ? 'cat-0' : null, name: i === 0 ? 'Motorcycle clothing' : i === 1 ? 'Racing suits' : `Equipment ${String(i).padStart(3, '0')}`, path: i === 0 ? 'Motorcycle clothing' : i === 1 ? 'Motorcycle clothing › Racing suits' : `Equipment ${String(i).padStart(3, '0')}`, slug: `category-${i}`, code: `CAT-${String(i).padStart(3, '0')}`, active: i !== 124, products: i === 1 ? 2500 : i === 0 ? 7500 : 0, children: i === 0 ? 1 : 0, mappings: i === 1 ? 1 : 0 }))
const sources = ['AMAZON', 'EBAY', 'ETSY', 'SHOPIFY', 'FUTURE_CHANNEL'].map((channel, i) => ({ channel, market: i < 2 ? 'IT' : 'GLOBAL', sourceMarket: i < 2 ? 'IT' : 'GLOBAL', name: ['Amazon Italy', 'eBay Italy', 'Etsy', 'Shopify', 'Future channel'][i], label: ['Amazon', 'eBay', 'Etsy', 'Shopify', 'Future channel'][i], kind: i === 0 ? 'productTypes' : 'categories', supported: i < 4, requirements: i === 3 ? 'store' : 'category', sourceId: `source-${i}`, snapshotId: i < 4 ? `snapshot-${i}` : null, nodeCount: i === 0 ? 1634 : i === 1 ? 100000 : 11000, state: i === 4 ? 'unsupported' : i === 2 ? 'failed' : 'ready', error: i === 2 ? 'Etsy temporarily refused the refresh. The previous taxonomy remains available.' : null, changes: { added: 12, changed: 8, removed: 2 }, lastSyncedAt: '2026-09-10T22:00:00Z', nextSyncAt: '2026-09-11T22:00:00Z', accounts: [{ id: `${channel}-account`, name: `${channel} main account` }] }))
const mapping = { marketplace: 'IT', channelCategoryId: 'retired', channelCategoryPath: 'Old racing suits', reviewedAt: '2026-09-01T10:00:00Z' }
const assignments = () => ({ token, counts: { total: rows.length, mapped: 1, inherited: 1 }, rows: rows.map((r,i)=>({ categoryId:r.id, categoryName:r.name, categoryPath:r.path, parentId:r.parentId, productCount:r.products, mapping:i===1?mapping:null, inheritedFrom:i===2?{categoryId:'cat-1',categoryName:'Racing suits',channelCategoryId:'retired'}:null, health:i===1||i===2?'retired':'unmapped', currentPath:null })) })
const node = (id='suit') => ({ externalId:id, name:id==='suit'?'Racing suits':`Category ${id}`, path:id==='suit'?'Automotive › Motorcycle & Powersports › Protective Gear › Racing Suits':`Automotive › Equipment › Category ${id}`, parentId:'gear', assignable:true })
const server = await createServer({ configFile:false, root, resolve:{alias:[
 {find:'@/lib/backend-url',replacement:root+'/backend.ts'}, {find:'next/navigation',replacement:root+'/navigation.ts'}, {find:'next/link',replacement:root+'/link.tsx'},
 {find:'@',replacement:repo+'/apps/web/src'}, {find:'@nexus/shared',replacement:repo+'/packages/shared'}, {find:'react-dom',replacement:repo+'/node_modules/react-dom'}, {find:'react',replacement:repo+'/node_modules/react'},
]}, esbuild:{jsx:'automatic'}, define:{'process.env.NODE_ENV':'"development"'}, server:{hmr:false,host:'127.0.0.1',port:3155,strictPort:true,fs:{allow:[root,repo]}}, plugins:[{name:'isolated-category-taxonomy-fixture',configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
 const url=new URL(req.url,'http://127.0.0.1:3155');if(!url.pathname.startsWith('/api/'))return next()
 const send=(value,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value))}
 let body={};if(req.method!=='GET'){let raw='';for await(const chunk of req)raw+=chunk;body=raw?JSON.parse(raw):{};writes.push({path:url.pathname,body})}
 const path=url.pathname.replace('/api/pim/','')
 if(path==='fixture/conflict'){conflict=true;return send({ok:true})}
 if(path==='fixture/evidence')return send({writes,categories:rows.length})
 if(path==='category-workspace')return send({rows,token})
 if(path==='category-workspace/preview')return send({token,productCount:body.id==='cat-1'?2500:body.id==='cat-0'?10000:0,descendantCount:body.id==='cat-0'?1:0,inheritedChanges:body.action==='move'?['eBay · IT']:[],blocked:body.action==='move'?'This move changes inherited channel assignments. Review explicit assignments before moving.':body.action==='delete'&&['cat-0','cat-1'].includes(body.id)?'This category has products or child categories. Reassign them first.':null})
 if(path==='category-workspace/apply'){
  if(conflict){conflict=false;return send({error:'Categories or memberships changed. Reload and review the change again.'},409)}
  if(body.action==='create')rows.push({id:`cat-${rows.length}`,parentId:body.parentId,name:body.name,path:body.name,slug:body.slug,code:body.code,active:true,products:0,children:0,mappings:0})
  if(body.action==='delete')rows=rows.filter(r=>r.id!==body.id)
  if(body.action==='rename'){const row=rows.find(r=>r.id===body.id);Object.assign(row,{name:body.name,path:body.name,slug:body.slug,code:body.code})}
  return send({directory:{rows,token}})
 }
 if(path.endsWith('/assignments'))return send(assignments())
 if(path==='taxonomies')return send({sources})
 if(path.endsWith('/history'))return send({runs:[{id:'run-1',status:'SUCCEEDED',providerVersion:'2026-09',nodeCount:100000,addedCount:12,removedCount:2,changedCount:8,error:null,createdAt:'2026-09-10T22:00:00Z',completedAt:'2026-09-10T22:01:00Z'}]})
 const source=sources.find(s=>path.startsWith(`taxonomies/${s.channel}/${s.market}`))
 if(path.endsWith('/refresh')){if(source){source.state='queued';source.error=null;setTimeout(()=>{source.state='ready';if(body.categoryId)schemaReady=true},2000)}return send({state:'queued'},202)}
 if(path.endsWith('/nodes')){const query=url.searchParams.get('q')?.trim(),page=Number(url.searchParams.get('page')||1);return send({items:query?[node()]:Array.from({length:50},(_,i)=>node(String((page-1)*50+i))),total:query?1:100000,page,pages:query?1:2000,snapshotId:source?.snapshotId??'snapshot-1',state:'ready'})}
 if(path.endsWith('/requirements')){const id=url.searchParams.get('id');if(id==='retired')return send({error:'This category is not present in the current marketplace taxonomy.'},409);return send({node:node(id),snapshotId:source?.snapshotId,state:source?.channel==='SHOPIFY'?'store':schemaReady?'ready':'missing',schema:schemaReady?{id:'schema-1',version:'v1',definition:{properties:{material:{title:'Material'},certification:{title:'Safety certification'},size:{title:'Size'}},required:['material','certification']},fetchedAt:'2026-09-11T00:00:00Z',expiresAt:'2026-09-12T00:00:00Z'}:null})}
 if(path.endsWith('/impact')&&req.method==='POST'){impact={jobId:'review-1',state:'MAPPING_REVIEW',total:10000,processed:10000,page:0,pages:1,channel:'EBAY',market:'IT',category:null,categoryChange:body.categoryChange,version:1,createdAt:new Date().toISOString(),counts:{scanned:10000,matchedProducts:2500,matchedListings:2500,affectedListings:2400,changed:2400,preservedOverrides:100,invalid:0,introducedInvalid:0,excluded:7500},rows:[{productId:'p-1',sku:'RACE-001',listingId:'listing-1',accountId:null,aliasKey:'MASTER',field:'category',before:'retired',after:'suit',source:'category mapping',changed:true,preserved:false,errors:[]}]};return send({jobId:'review-1'})}
 if(path.endsWith('/review-1/activate')){mapping.channelCategoryId='suit';mapping.channelCategoryPath=node().path;return send({applied:true})}
 if(path.endsWith('/review-1'))return send(impact)
 return send({error:`Unknown fixture route: ${path}`},404)
})}}],optimizeDeps:{include:['react','react-dom/client']}})
await server.listen();console.log('Category QA fixture: http://127.0.0.1:3155/catalog/categories')
