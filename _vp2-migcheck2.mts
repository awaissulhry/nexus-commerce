import { PrismaClient } from '@prisma/client'
const p = new PrismaClient({ datasources: { db: { url: process.argv[2] } } })
const rows: any[] = await p.$queryRawUnsafe(`SELECT migration_name, started_at, finished_at, rolled_back_at, logs FROM _prisma_migrations WHERE finished_at IS NULL ORDER BY started_at DESC LIMIT 6`)
for (const r of rows) console.log('UNFINISHED', r.migration_name, String(r.started_at), 'rolledBack=', r.rolled_back_at, (r.logs||'').slice(0,120))
const n: any[] = await p.$queryRawUnsafe(`SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL`)
console.log('finished:', n[0].n)
const col: any[] = await p.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_name='ChannelListing' AND column_name='variationExcluded'`)
console.log('variationExcluded present:', col.length > 0)
await p.$disconnect()
