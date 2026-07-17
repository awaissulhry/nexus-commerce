import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()
const API='https://nexusapi-production-b7bb.up.railway.app'
const skus=['xracingb46','AIREON-PANT-NERO-NEO-MEN-M','AIREON-JACKET-NERO-NEO-MEN-M']
const { rows } = await (await fetch(`${API}/api/amazon/flat-file/rows?marketplace=IT`)).json()
const rBySku=new Map(rows.map(r=>[r.item_sku,r]))
for(const sku of skus){
  const p=await prisma.product.findUnique({where:{sku},select:{id:true}})
  const l=await prisma.channelListing.findFirst({where:{channel:'AMAZON',channelMarket:'AMAZON_IT',productId:p.id},select:{bulletPointsOverride:true,platformAttributes:true,flatFileSnapshot:true}})
  const attrsB=l.platformAttributes?.attributes?.bullet_point
  const snap=l.flatFileSnapshot&&typeof l.flatFileSnapshot==='object'&&Object.keys(l.flatFileSnapshot).length>0
  const r=rBySku.get(sku)
  console.log(`\n${sku}`)
  console.log(`  bulletPointsOverride=${JSON.stringify(l.bulletPointsOverride)}`)
  console.log(`  attrs.bullet_point=${Array.isArray(attrsB)?attrsB.length+' items ['+String(attrsB[0]?.value??'').slice(0,25)+'…]':JSON.stringify(attrsB)}`)
  console.log(`  hasSnapshot=${snap}  snap.bullet_point_1=${snap?String(l.flatFileSnapshot.bullet_point_1??'∅').slice(0,25):'—'}`)
  console.log(`  ROW bullet_point_1=${String(r?.bullet_point_1??'∅').slice(0,30)}  bullet_point=${String(r?.bullet_point??'∅').slice(0,20)}`)
}
await prisma.$disconnect()
