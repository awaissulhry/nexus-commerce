/** LX.FIN — the database discriminator, read through an explicitly-URL'd client. Untracked probe. */
import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'
const url = readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').find(l => l.startsWith('DATABASE_URL='))!.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '')
const prisma = new PrismaClient({ datasources: { db: { url } } })
const db = await prisma.$queryRawUnsafe<{ current_database: string }[]>('SELECT current_database()')
const gale = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET' }, select: { id: true, sku: true, version: true } })
const counts = {
  products: await prisma.product.count(),
  readinessIndex: await prisma.readinessIndex.count(),
  productTranslation: await prisma.productTranslation.count(),
  channelListingTranslation: await prisma.channelListingTranslation.count(),
  syncLogErrorGroup: await prisma.syncLogErrorGroup.count(),
}
const markets = await prisma.marketplace.findMany({ select: { channel: true, code: true, name: true, language: true, languages: true, isActive: true }, orderBy: [{ channel: 'asc' }, { code: 'asc' }] })
console.log(JSON.stringify({ at: new Date().toISOString(), current_database: db[0].current_database, gale, counts, markets }, null, 2))
await prisma.$disconnect()
