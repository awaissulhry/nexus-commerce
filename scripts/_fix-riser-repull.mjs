// Re-pull the Riser family (IT) from LIVE Amazon and write real title + color +
// size over the "Cascade IT Test" snapshot. Backs up before writing. Does NOT
// push to Amazon (pulls FROM Amazon INTO our DB). Apply only when argv[2]==='apply'.
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import fs from 'fs'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()
const API = 'https://nexusapi-production-b7bb.up.railway.app'
const APPLY = process.argv[2] === 'apply'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SKUS = ['1J-EYE5-Y0TW','xriser-bla-l','xriser-bla-m','xriser-bla-s','xriser-bla-xl','xriser-bla-xxl']

// 1. Pull fresh full data from prod (Amazon source of truth)
const start = await fetch(`${API}/api/amazon/flat-file/pull-preview/start`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ marketplace: 'IT', productType: 'GLOVES', skus: SKUS }),
})
const { jobId } = await start.json()
let job
for (let i=0;i<30;i++){ await sleep(1500); job = await (await fetch(`${API}/api/amazon/flat-file/pull-preview/status/${jobId}`)).json(); if ((job.status??job.state)==='done') break }
const pulled = new Map((job.rows ?? []).map(r => [r.item_sku, r]))
console.log(`Pulled ${pulled.size} rows from Amazon.`)

// 2. Map SKU → product → IT AMAZON ChannelListing
const products = await prisma.product.findMany({ where: { sku: { in: SKUS } }, select: { id: true, sku: true, name: true } })
const pidBySku = new Map(products.map(p => [p.sku, p.id]))
const nameBySku = new Map(products.map(p => [p.sku, p.name]))
const listings = await prisma.channelListing.findMany({
  where: { channel: 'AMAZON', channelMarket: 'AMAZON_IT', productId: { in: products.map(p=>p.id) } },
  select: { id: true, productId: true, title: true, platformAttributes: true },
})
const sizeFromSku = (sku) => { const m = sku.match(/-(xxl|xl|l|m|s)$/i); return m ? m[1].toUpperCase() : '' }

const backup = [], plan = []
for (const l of listings) {
  const sku = [...pidBySku.entries()].find(([,id]) => id === l.productId)?.[0]
  const row = pulled.get(sku)
  const isChild = sku !== '1J-EYE5-Y0TW'
  const fullTitle = (row?.item_name && row.item_name.length > 20) ? row.item_name : nameBySku.get(sku)
  const color = row?.color || (isChild ? 'Nero' : '')
  const size = row?.size || (isChild ? sizeFromSku(sku) : '')
  const cur = (l.platformAttributes ?? {})
  const curAttrs = (cur.attributes ?? {})
  const newAttrs = { ...curAttrs }
  if (isChild) {
    if (color) newAttrs.color = [{ value: color }]
    if (size) newAttrs.size = [{ value: size }]
  }
  if (fullTitle) newAttrs.item_name = [{ value: fullTitle }]
  const newPA = { ...cur, attributes: newAttrs }
  backup.push({ listingId: l.id, sku, before: { title: l.title, platformAttributes: l.platformAttributes } })
  plan.push({ listingId: l.id, sku, title: fullTitle, color: color || '—', size: size || '—', newPA })
}
for (const p of plan) console.log(`  ${p.sku}  title="${String(p.title).slice(0,45)}…"  color=${p.color} size=${p.size}`)

if (!APPLY) { console.log('\nDRY-RUN (pass "apply" to write).'); await prisma.$disconnect(); process.exit(0) }
const backupFile = path.join(here, `_backup-riser-${Date.now()}.json`)
fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2))
console.log(`\nRollback backup: ${backupFile}`)
let n = 0
for (const p of plan) { await prisma.channelListing.update({ where: { id: p.listingId }, data: { title: p.title, platformAttributes: p.newPA } }); n++ }
console.log(`✅ Updated ${n} Riser IT listings.`)
await prisma.$disconnect()
