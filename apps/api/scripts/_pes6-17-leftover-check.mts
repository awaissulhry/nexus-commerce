import { config as loadEnv } from 'dotenv'
loadEnv({ path: new URL('../../../.env', import.meta.url).pathname })
import prisma from '../src/db.js'
const p = await prisma.product.findFirst({
  where: { sku: 'GALE-JACKET-BLACK-MEN-L' },
  select: { id: true, name: true, description: true },
})
console.log('formula rows on fixture :', await prisma.cellFormula.count({ where: { productId: p!.id } }))
console.log('formula rows ANYWHERE   :', await prisma.cellFormula.count())
console.log('formula.pinned audit    :', await prisma.auditLog.count({ where: { action: 'formula.pinned' } }))
console.log('masterFieldRule rows    :', await prisma.masterFieldRule.count())
console.log('name       :', JSON.stringify(p!.name?.slice(0, 70)))
console.log('description:', JSON.stringify(p!.description === null ? null : p!.description.slice(0, 70)))
await prisma.$disconnect()
