import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'
const url = readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').find(l => l.startsWith('DATABASE_URL='))!.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '')
const prisma = new PrismaClient({ datasources: { db: { url } } })
console.log('db', (await prisma.$queryRawUnsafe<any[]>('SELECT current_database()::text AS db'))[0])
console.log('roles', JSON.stringify(await prisma.$queryRawUnsafe(`SELECT rolname FROM pg_roles WHERE rolname LIKE 'nexus%' ORDER BY rolname`)))
console.log('databases', JSON.stringify(await prisma.$queryRawUnsafe(`SELECT datname FROM pg_database WHERE datname LIKE 'nexus%' OR datname LIKE '%test%' ORDER BY datname`)))
await prisma.$disconnect()
