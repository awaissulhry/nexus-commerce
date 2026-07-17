import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'; import { fileURLToPath } from 'node:url'; import { dirname, join } from 'node:path'
config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') })
const p = new PrismaClient()
const J = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v } catch { return v } }

// XS + XXS SKUs (black + yellow) — confirm ASIN collision
const skus = ['GALE-JACKET-BLACK-MEN-XS','GALE-JACKET-BLACK-MEN-XXS','GALE-JACKET-YELLOW-MEN-XS','GALE-JACKET-YELLOW-MEN-XXS']
const prods = await p.product.findMany({ where: { sku: { in: skus } }, select: { id: true, sku: true, amazonAsin: true, parentId: true, variantAttributes: true } })
console.log('=== XS vs XXS ===')
for (const x of prods) console.log(`${x.sku.padEnd(28)} asin=${x.amazonAsin} parentId=…${x.parentId?.slice(-6)} Size=${(J(x.variantAttributes)||{}).Size}`)

// The two parents (vnu523 = normal family, nayiks = XXS's parent)
const parentIds = [...new Set(prods.map((x) => x.parentId).filter(Boolean))]
const parents = await p.product.findMany({ where: { id: { in: parentIds } }, select: { id: true, sku: true, name: true, isParent: true, amazonAsin: true, variationTheme: true } })
console.log('\n=== Parents referenced ===')
for (const x of parents) console.log(`id=…${x.id.slice(-6)} sku=${x.sku} isParent=${x.isParent} asin=${x.amazonAsin} theme=${x.variationTheme} name="${x.name}"`)

// How many children under each parent?
for (const par of parents) {
  const n = await p.product.count({ where: { parentId: par.id, deletedAt: null } })
  console.log(`  parent ${par.sku} (…${par.id.slice(-6)}) → ${n} children`)
}
await p.$disconnect()
