// Fix: bullets written to attrs.bullet_point are shadowed by an empty
// bulletPointsOverride ([]). Copy them into bulletPointsOverride (read first)
// where it's empty and the row currently shows no bullets. Backup + apply.
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'; import fs from 'fs'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()
const API='https://nexusapi-production-b7bb.up.railway.app'
const APPLY=process.argv[2]==='apply'
const nz=(v)=>v!=null&&String(v).trim()!==''
const { rows } = await (await fetch(`${API}/api/amazon/flat-file/rows?marketplace=IT`)).json()
const rBySku=new Map(rows.map(r=>[r.item_sku,r]))
const bulletsOf=(r)=>[r.bullet_point,r.bullet_point_1,r.bullet_point_2,r.bullet_point_3,r.bullet_point_4,r.bullet_point_5].filter(nz)

const listings=await prisma.channelListing.findMany({
  where:{channel:'AMAZON',channelMarket:'AMAZON_IT'},
  select:{id:true,productId:true,bulletPointsOverride:true,platformAttributes:true,product:{select:{sku:true}}},
})
const backup=[],plan=[]
for(const l of listings){
  const sku=l.product?.sku; const r=rBySku.get(sku); if(!r)continue
  const overrideEmpty = !Array.isArray(l.bulletPointsOverride) || l.bulletPointsOverride.filter(nz).length===0
  const attrsB = l.platformAttributes?.attributes?.bullet_point
  const attrBullets = Array.isArray(attrsB) ? attrsB.map(b=>b?.value ?? String(b)).filter(nz) : []
  if(bulletsOf(r).length===0 && overrideEmpty && attrBullets.length>0){
    backup.push({listingId:l.id,sku,before:l.bulletPointsOverride})
    plan.push({listingId:l.id,sku,bullets:attrBullets})
  }
}
console.log(`Listings to fix: ${plan.length}`)
for(const p of plan.slice(0,6))console.log(`  ${p.sku.padEnd(30)} +${p.bullets.length} bullets`)
if(plan.length>6)console.log(`  … +${plan.length-6} more`)
if(!APPLY){console.log('\nDRY-RUN.');await prisma.$disconnect();process.exit(0)}
const bf=path.join(here,`_backup-bullets-override-${Date.now()}.json`)
fs.writeFileSync(bf,JSON.stringify(backup)); console.log(`Backup: ${bf}`)
let n=0;for(const p of plan){await prisma.channelListing.update({where:{id:p.listingId},data:{bulletPointsOverride:p.bullets}});n++}
console.log(`✅ Updated ${n} listings.`)
await prisma.$disconnect()
