import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()

// Count first
const count = await p.product.count({ where: { brand: { not: 'Xavia Racing' } } })
const sample = await p.product.findMany({
  where: { brand: { not: 'Xavia Racing' } },
  select: { sku: true, brand: true },
  take: 5,
})
console.log(`Products with brand != "Xavia Racing": ${count}`)
console.log('Sample:', JSON.stringify(sample, null, 2))
await p.$disconnect()
