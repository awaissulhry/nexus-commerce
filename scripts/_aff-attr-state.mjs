// _aff-attr-state.mjs — READ-ONLY. True hydration state: how many Amazon
// listings have a non-empty attribute set now (vs truly empty / never pulled).
import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') })
const prisma = new PrismaClient()
const cls = await prisma.channelListing.findMany({
  where: { channel: 'AMAZON', externalListingId: { not: null } },
  select: { platformAttributes: true },
})
let empty = 0, has = 0
const buckets = { '0': 0, '1-20': 0, '21-60': 0, '60+': 0 }
let missingKey = 0
const KEY = ['bullet_point', 'fabric_type', 'country_of_origin']
for (const cl of cls) {
  const attrs = (cl.platformAttributes?.attributes ?? {})
  const n = attrs && typeof attrs === 'object' ? Object.keys(attrs).length : 0
  if (n === 0) { empty++; buckets['0']++ }
  else {
    has++
    if (n <= 20) buckets['1-20']++; else if (n <= 60) buckets['21-60']++; else buckets['60+']++
    if (KEY.some((k) => attrs[k] === undefined)) missingKey++
  }
}
console.log(`Amazon listings: ${cls.length}`)
console.log(`  EMPTY attrs (truly never pulled): ${empty}`)
console.log(`  HAS attrs (hydrated): ${has}`)
console.log(`  attr-count buckets:`, JSON.stringify(buckets))
console.log(`  hydrated but missing >=1 of [bullet_point,fabric_type,country_of_origin] (genuinely absent on Amazon): ${missingKey}`)
await prisma.$disconnect()
