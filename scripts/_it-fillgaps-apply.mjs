// APPLY fill-gaps-only merge for IT: fill ONLY empty fields (image, brand,
// bullets, description, asin) from a live Amazon pull. Writes to the snapshot
// when one exists (snapshot wins in the editor), else to platformAttributes.
// Full backup first. Never overwrites populated fields. Never touches price/qty.
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'; import fs from 'fs'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()
const API = 'https://nexusapi-production-b7bb.up.railway.app'
const APPLY = process.argv[2] === 'apply'
const sleep = (ms) => new Promise((r)=>setTimeout(r,ms))
const nz = (v) => v != null && String(v).trim() !== ''
const bulletsOf = (r) => [r.bullet_point,r.bullet_point_1,r.bullet_point_2,r.bullet_point_3,r.bullet_point_4,r.bullet_point_5].filter(nz)

// 1. current rows (snapshot-overlaid)
const { rows: cur } = await (await fetch(`${API}/api/amazon/flat-file/rows?marketplace=IT`)).json()
const curBySku = new Map(cur.map(r=>[r.item_sku,r]))
const byType = new Map()
for (const r of cur){ const t=String(r.product_type??'').toUpperCase()||'UNKNOWN'; if(!byType.has(t))byType.set(t,[]); byType.get(t).push(r.item_sku) }

// 2. pull Amazon per type
const pulled = new Map()
for (const [pt,skus] of byType){
  const s=await fetch(`${API}/api/amazon/flat-file/pull-preview/start`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({marketplace:'IT',productType:pt,skus})})
  const {jobId}=await s.json(); if(!jobId)continue
  let job; for(let i=0;i<120;i++){await sleep(2000);job=await(await fetch(`${API}/api/amazon/flat-file/pull-preview/status/${jobId}`)).json();if((job.status??job.state)==='done')break}
  for(const r of job.rows??[])pulled.set(r.item_sku,r)
  console.log(`pulled ${pt}: ${(job.rows??[]).length}`)
}

// 3. listings for the IT market
const skuList=[...curBySku.keys()]
const products=await prisma.product.findMany({ where:{ sku:{in:skuList} }, select:{ id:true, sku:true } })
const pidBySku=new Map(products.map(p=>[p.sku,p.id]))
const skuByPid=new Map(products.map(p=>[p.id,p.sku]))
const listings=await prisma.channelListing.findMany({ where:{ channel:'AMAZON', channelMarket:'AMAZON_IT', productId:{in:products.map(p=>p.id)} }, select:{ id:true, productId:true, platformAttributes:true, flatFileSnapshot:true, externalListingId:true } })

const backup=[]; const plan=[]
for (const l of listings){
  const sku=skuByPid.get(l.productId); const c=curBySku.get(sku); const a=pulled.get(sku)
  if(!c||!a)continue
  const hasSnap=l.flatFileSnapshot&&typeof l.flatFileSnapshot==='object'&&Object.keys(l.flatFileSnapshot).length>0
  const snap=hasSnap?{...l.flatFileSnapshot}:null
  const pa=(l.platformAttributes&&typeof l.platformAttributes==='object')?{...l.platformAttributes}:{}
  const attrs={...(pa.attributes??{})}
  const fills=[]; let extId
  const setF=(field,val,snapKey,attrShape)=>{ if(snap)snap[snapKey]=val; else attrs[attrShape.key]=attrShape.wrap(val); fills.push(field) }
  if(!nz(c.main_product_image_locator)&&nz(a.main_product_image_locator)) setF('image',a.main_product_image_locator,'main_product_image_locator',{key:'main_product_image_locator',wrap:v=>[{media_location:v}]})
  if(!nz(c.brand)&&nz(a.brand)) setF('brand',a.brand,'brand',{key:'brand',wrap:v=>[{value:v}]})
  if(!nz(c.product_description)&&nz(a.product_description)) setF('desc',a.product_description,'product_description',{key:'product_description',wrap:v=>[{value:v}]})
  const cb=bulletsOf(c), ab=bulletsOf(a)
  if(cb.length===0&&ab.length>0){ if(snap){ab.forEach((b,i)=>snap[`bullet_point_${i+1}`]=b)} else {attrs.bullet_point=ab.map(b=>({value:b}))} fills.push('bullets') }
  if(!nz(c.external_product_id)&&(nz(a.external_product_id)||nz(a._asin))){ extId=a.external_product_id||a._asin; fills.push('asin') }
  if(fills.length===0)continue
  backup.push({ listingId:l.id, sku, before:{ platformAttributes:l.platformAttributes, flatFileSnapshot:l.flatFileSnapshot, externalListingId:l.externalListingId } })
  const data={}
  if(snap)data.flatFileSnapshot=snap; else data.platformAttributes={...pa,attributes:attrs}
  if(extId)data.externalListingId=extId
  plan.push({ listingId:l.id, sku, fills, data, target: snap?'snapshot':'attributes' })
}
console.log(`\nListings to update: ${plan.length}`)
const agg={}; for(const p of plan)for(const f of p.fills)agg[f]=(agg[f]||0)+1
console.log('fills:',JSON.stringify(agg))
console.log('write target:', JSON.stringify(plan.reduce((o,p)=>{o[p.target]=(o[p.target]||0)+1;return o},{})))

if(!APPLY){ console.log('\nDRY-RUN (pass "apply").'); await prisma.$disconnect(); process.exit(0) }
const bf=path.join(here,`_backup-it-fillgaps-${Date.now()}.json`)
fs.writeFileSync(bf,JSON.stringify(backup)); console.log(`\nBackup: ${bf}`)
let n=0; for(const p of plan){ await prisma.channelListing.update({where:{id:p.listingId},data:p.data}); n++ }
console.log(`✅ Updated ${n} listings.`)
await prisma.$disconnect()
