import { PrismaClient } from '@prisma/client'
const p = new PrismaClient({ datasources: { db: { url: process.argv[2] } } })
const rows: any[] = await p.$queryRawUnsafe(`SELECT count(*)::int AS n, count(*) FILTER (WHERE finished_at IS NULL)::int AS unfinished FROM _prisma_migrations`)
console.log('applied:', rows[0].n, 'unfinished:', rows[0].unfinished)
const col: any[] = await p.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_name='ChannelListing' AND column_name='variationExcluded'`)
console.log('variationExcluded present:', col.length > 0)
await p.$disconnect()
