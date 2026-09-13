import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'
const url = readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').find(l => l.startsWith('DATABASE_URL='))!.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '')
const prisma = new PrismaClient({ datasources: { db: { url } } })
console.log('current_database', (await prisma.$queryRawUnsafe<any[]>('SELECT current_database()::text AS db'))[0])
console.log('columns', JSON.stringify(await prisma.$queryRawUnsafe(`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name='SellerReferenceLabel' ORDER BY ordinal_position`), null, 0))
console.log('indexes', JSON.stringify(await prisma.$queryRawUnsafe(`SELECT indexname FROM pg_indexes WHERE tablename='SellerReferenceLabel' ORDER BY indexname`), null, 0))
console.log('rows', await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "SellerReferenceLabel"`))
await prisma.$disconnect()
