import { config as loadEnv } from 'dotenv'
loadEnv({ path: new URL('../../../.env', import.meta.url).pathname })
import prisma from '../src/db.js'
const me = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET-BLACK-MEN-L' }, select: { id: true, parentId: true } })
const sibs = await prisma.product.findMany({
  where: { parentId: me!.parentId, deletedAt: null },
  select: { sku: true, name: true, description: true },
  orderBy: { sku: 'asc' },
})
const groups = new Map<string, string[]>()
for (const s of sibs) groups.set(s.name ?? '∅', [...(groups.get(s.name ?? '∅') ?? []), s.sku])
let i = 0
for (const [name, skus] of groups) {
  i++
  console.log(`\n[group ${i}] ${skus.length} sku(s): ${skus.join(', ')}`)
  console.log(`  name (${name.length} chars): ${JSON.stringify(name)}`)
}
console.log('\nparent:')
const parent = await prisma.product.findUnique({ where: { id: me!.parentId! }, select: { sku: true, name: true, description: true } })
console.log(' ', parent!.sku, JSON.stringify(parent!.name))
console.log('  parent description is null:', parent!.description === null)
await prisma.$disconnect()
