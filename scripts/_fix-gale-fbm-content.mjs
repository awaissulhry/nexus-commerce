// Backfill GALE-FBM children's bullets/brand/description from their matching-ASIN
// FBA sibling (GALE-JACKET) — same product, same ASIN. Fill-only. Backup + apply.
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'; import fs from 'fs'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()
const API='https://nexusapi-production-b7bb.up.railway.app'
const APPLY=process.argv[2]==='apply'
const nz=(v)=>v!=null&&String(v).trim()!==''
const bulletsOf=(r)=>[r.bullet_point,r.bullet_point_1,r.bullet_point_2,r.bullet_point_3,r.bullet_point_4,r.bullet_point_5].filter(nz)
const { rows } = await (await fetch(`${API}/api/amazon/flat-file/rows?marketplace=IT`)).json()
// FBA GALE by ASIN
const fbaByAsin=new Map()
for(const r of rows){ if(String(r.parent_sku)==='GALE-JACKET'){ fbaByAsin.set(r.external_product_id, { brand:r.brand, desc:r.product_description, bullets:bulletsOf(r) }) } }
const fbmRows=rows.filter(r=>String(r.parent_sku)==='GALE-JACKET-FBM')

const skus=fbmRows.map(r=>r.item_sku)
const products=await prisma.product.findMany({where:{sku:{in:skus}},select:{id:true,sku:true,amazonAsin:true}})
const bySku=new Map(products.map(p=>[p.sku,p]))
const listings=await prisma.channelListing.findMany({where:{channel:'AMAZON',channelMarket:'AMAZON_IT',productId:{in:products.map(p=>p.id)}},select:{id:true,productId:true,platformAttributes:true,bulletPointsOverride:true}})
const skuByPid=new Map(products.map(p=>[p.id,p.sku]))
const asinByPid=new Map(products.map(p=>[p.id,p.amazonAsin]))
const curBySku=new Map(fbmRows.map(r=>[r.item_sku,r]))

const backup=[],plan=[]
for(const l of listings){
  const sku=skuByPid.get(l.productId); const asin=asinByPid.get(l.productId); const cur=curBySku.get(sku)
  const src=fbaByAsin.get(asin); if(!src||!cur)continue
  const pa=(l.platformAttributes&&typeof l.platformAttributes==='object')?{...l.platformAttributes}:{}
  const attrs={...(pa.attributes??{})}
  const fills=[]; let newOverride
  if(!nz(cur.brand)&&nz(src.brand)){ attrs.brand=[{value:src.brand}]; fills.push('brand') }
  if(!nz(cur.product_description)&&nz(src.desc)){ attrs.product_description=[{value:src.desc}]; fills.push('desc') }
  const overrideEmpty=!Array.isArray(l.bulletPointsOverride)||l.bulletPointsOverride.filter(nz).length===0
  if(bulletsOf(cur).length===0&&overrideEmpty&&src.bullets.length>0){ newOverride=src.bullets; fills.push(`bullets(${src.bullets.length})`) }
  if(!fills.length)continue
  backup.push({listingId:l.id,sku,before:{platformAttributes:l.platformAttributes,bulletPointsOverride:l.bulletPointsOverride}})
  const data={platformAttributes:{...pa,attributes:attrs}}; if(newOverride)data.bulletPointsOverride=newOverride
  plan.push({listingId:l.id,sku,fills,data})
}
console.log(`GALE-FBM listings to fill: ${plan.length}`)
for(const p of plan.slice(0,4))console.log(`  ${p.sku} ${p.fills.join(',')}`)
if(!APPLY){console.log('DRY-RUN.');await prisma.$disconnect();process.exit(0)}
const bf=path.join(here,`_backup-gale-fbm-content-${Date.now()}.json`)
fs.writeFileSync(bf,JSON.stringify(backup)); console.log(`Backup: ${bf}`)
let n=0;for(const p of plan){await prisma.channelListing.update({where:{id:p.listingId},data:p.data});n++}
console.log(`✅ Updated ${n} listings.`)
await prisma.$disconnect()
