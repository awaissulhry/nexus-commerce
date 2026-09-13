import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'
const url = readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').find(l => l.startsWith('DATABASE_URL='))!.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '')
const prisma = new PrismaClient({ datasources: { db: { url } } })
console.log('db', (await prisma.$queryRawUnsafe<any[]>('SELECT current_database()::text AS db'))[0])
console.log('rls', JSON.stringify(await prisma.$queryRawUnsafe(`SELECT relname::text, relrowsecurity FROM pg_class WHERE relname = 'SellerReferenceLabel'`)))
console.log('policies', JSON.stringify(await prisma.$queryRawUnsafe(`SELECT policyname::text, cmd::text, roles::text FROM pg_policies WHERE tablename = 'SellerReferenceLabel'`)))
console.log('grants', JSON.stringify(await prisma.$queryRawUnsafe(`SELECT grantee::text, privilege_type::text FROM information_schema.role_table_grants WHERE table_name = 'SellerReferenceLabel' AND grantee = 'nexus_workspace_runtime' ORDER BY privilege_type`)))
console.log('rows', await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "SellerReferenceLabel"`))
await prisma.$disconnect()
