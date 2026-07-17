import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const rows = await p.product.findMany({
  where: { OR: [{ name: { contains: 'Gale', mode: 'insensitive' } }, { sku: { startsWith: 'GAL' } }] },
  select: { sku: true, name: true, brand: true },
  take: 5,
})
console.log(JSON.stringify(rows, null, 2))
await p.$disconnect()
