// _aff-snap-check.mjs — READ-ONLY. For hydrated Amazon listings, check whether
// the flatFileSnapshot (returned verbatim to the editor) actually carries the
// reportedly-missing columns. Pinpoints read vs mapping vs snapshot gaps.
import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') })
const prisma = new PrismaClient()
const cls = await prisma.channelListing.findMany({
  where: { channel: 'AMAZON', externalListingId: { not: null }, flatFileSnapshot: { not: null } },
  select: { marketplace: true, flatFileSnapshot: true, product: { select: { sku: true } } },
  take: 4,
})
const probe = ['country_of_origin', 'supplier_declared_dg_hz_regulation',
  'supplier_declared_dangerous_goods__supplier_declared_dg_hz_regulation', 'fabric_type', 'bullet_point', 'bullet_point_1']
for (const cl of cls) {
  const ff = cl.flatFileSnapshot ?? {}
  console.log(`\n${cl.product.sku} ${cl.marketplace} — snapshot ${Object.keys(ff).length} cols`)
  for (const k of probe) console.log(`  ${k}:`, k in ff ? JSON.stringify(ff[k]).slice(0, 120) : '(NOT a column)')
  const matchCols = Object.keys(ff).filter((x) => /dg|dangerous|country|origin/i.test(x))
  console.log('  dg/country-ish columns present:', matchCols.join(', ') || '(none)')
}
await prisma.$disconnect()
