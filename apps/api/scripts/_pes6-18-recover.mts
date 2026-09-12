import { config as loadEnv } from 'dotenv'
loadEnv({ path: new URL('../../../.env', import.meta.url).pathname })
import prisma from '../src/db.js'
const me = await prisma.product.findFirst({
  where: { sku: 'GALE-JACKET-BLACK-MEN-L' },
  select: { id: true, parentId: true, name: true, description: true, updatedAt: true },
})
console.log('damaged:', JSON.stringify({ name: me!.name, description: me!.description }))
// Siblings under the same parent — do they agree on name/description?
const sibs = await prisma.product.findMany({
  where: { parentId: me!.parentId, id: { not: me!.id }, deletedAt: null },
  select: { sku: true, name: true, description: true },
  take: 25,
})
const names = new Map<string, string[]>()
const descs = new Map<string, string[]>()
for (const s of sibs) {
  names.set(s.name ?? '∅', [...(names.get(s.name ?? '∅') ?? []), s.sku])
  descs.set((s.description ?? '∅').slice(0, 400), [...(descs.get((s.description ?? '∅').slice(0, 400)) ?? []), s.sku])
}
console.log(`\nsiblings: ${sibs.length}`)
console.log('distinct names:', names.size)
for (const [n, skus] of names) console.log(`  (${skus.length}) ${JSON.stringify(n.slice(0, 90))}`)
console.log('distinct descriptions:', descs.size)
for (const [d, skus] of descs) console.log(`  (${skus.length}) ${JSON.stringify(d.slice(0, 90))}…`)
// Any audit/event history for this product carrying the old values?
const events = await prisma.productEvent.findMany({
  where: { productId: me!.id }, orderBy: { createdAt: 'desc' }, take: 5,
  select: { eventType: true, createdAt: true, data: true },
})
console.log('\nrecent ProductEvent rows:', events.length)
for (const e of events) console.log(`  ${e.eventType} ${e.createdAt.toISOString()} ${JSON.stringify(e.data).slice(0, 120)}`)
await prisma.$disconnect()
