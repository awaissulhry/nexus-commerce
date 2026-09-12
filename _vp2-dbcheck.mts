import { PrismaClient } from '@prisma/client'
const url = process.argv[2]
const p = new PrismaClient({ datasources: { db: { url } } })
try {
  const n = await p.product.count()
  const gale = await p.product.findFirst({ where: { id: 'cmokmy3a40078pm0p1fvnu523' }, select: { id: true, sku: true, variationAxes: true, version: true, _count: { select: { children: true } } } })
  console.log(JSON.stringify({ host: url.replace(/:\/\/([^:]+):[^@]+@/, '://$1:***@').slice(0, 70), products: n, gale }, null, 1))
} catch (e) { console.log('ERR', (e as Error).message.slice(0, 200)) }
await p.$disconnect()
