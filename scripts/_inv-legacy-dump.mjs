// _inv-legacy-dump.mjs — READ-ONLY. Full list of the 90 phantom-stock products
// (totalStock>0, no WAREHOUSE StockLevel) for operator review.
import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') })
const prisma = new PrismaClient()

const products = await prisma.product.findMany({
  select: {
    sku: true, name: true, totalStock: true, isParent: true, parentId: true, deletedAt: true,
    stockLevels: { select: { quantity: true, location: { select: { type: true } } } },
    channelListings: { select: { channel: true, marketplace: true, listingStatus: true, isPublished: true } },
  },
  orderBy: { sku: 'asc' },
})
const legacy = products.filter((p) => !p.deletedAt && p.totalStock > 0
  && !p.stockLevels.some((s) => s.location?.type === 'WAREHOUSE'))

function grp(sku) {
  if (/_FBM$/.test(sku)) return '*_FBM (likely GALE duplicates)'
  if (/^xracing/i.test(sku)) return 'xracing* (likely test/junk)'
  if (/MISANO/i.test(sku)) return 'MISANO'
  if (/VENTRA/i.test(sku)) return 'VENTRA'
  return 'other'
}
const byG = {}
for (const p of legacy) (byG[grp(p.sku)] ??= []).push(p)

console.log(`\n=== ${legacy.length} phantom-stock products (totalStock>0, no warehouse ledger) ===`)
for (const g of ['VENTRA', 'MISANO', '*_FBM (likely GALE duplicates)', 'xracing* (likely test/junk)', 'other']) {
  const list = byG[g]; if (!list?.length) continue
  console.log(`\n### ${g} — ${list.length} ###`)
  for (const p of list) {
    const sl = p.stockLevels.map((s) => `${s.location?.type ?? '?'}:${s.quantity}`).join(',') || 'NO stocklevels'
    const live = p.channelListings.filter((c) => c.isPublished && (c.listingStatus === 'ACTIVE' || c.listingStatus === 'BUYABLE'))
    const mkts = [...new Set(p.channelListings.map((c) => `${c.channel}/${c.marketplace}`))].join(' ')
    console.log(`  ${p.sku}  qty=${p.totalStock}  [${sl}]  ${p.isParent ? 'PARENT' : p.parentId ? 'child' : 'std'}  live=${live.length}  (${mkts})`)
  }
}
await prisma.$disconnect()
