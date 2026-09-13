/** LX.FIN — fixture state, read-only. Untracked probe. */
import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'
const url = readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').find(l => l.startsWith('DATABASE_URL='))!.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '')
const prisma = new PrismaClient({ datasources: { db: { url } } })
console.log('current_database', (await prisma.$queryRawUnsafe<any[]>('SELECT current_database()'))[0])
const fam = await prisma.product.findMany({ where: { OR: [{ sku: { startsWith: 'VX-TEST-3AX' } }] }, select: { id: true, sku: true, status: true, version: true, parentId: true } })
console.log('VX family', JSON.stringify(fam, null, 1))
const tr = await prisma.productTranslation.findMany({ select: { id: true, productId: true, language: true, name: true, version: true, source: true, reviewedAt: true } })
console.log('ALL ProductTranslation rows', JSON.stringify(tr, null, 1))
await prisma.$disconnect()
