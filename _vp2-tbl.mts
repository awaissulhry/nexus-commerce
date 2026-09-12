import { PrismaClient } from '@prisma/client'
const p = new PrismaClient({ datasources: { db: { url: process.argv[2] } } })
const t: any[] = await p.$queryRawUnsafe(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND (table_name ILIKE '%sync%queue%' OR table_name ILIKE '%queue%' OR table_name ILIKE '%Sync%') ORDER BY 1`)
console.log(t.map(r => r.table_name).join(', '))
await p.$disconnect()
