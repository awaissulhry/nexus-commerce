import { PrismaClient } from '@prisma/client'
const p = new PrismaClient({ datasources: { db: { url: process.argv[2] } } })
const r: any[] = await p.$queryRawUnsafe(`SELECT count(*) FILTER (WHERE "variationExcluded") ::int AS excluded, count(*) FILTER (WHERE "syncPaused") ::int AS paused, count(*)::int AS total FROM "ChannelListing"`)
console.log(JSON.stringify(r[0]))
const g: any[] = await p.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "Product" WHERE "parentId" = 'cmokmy3a40078pm0p1fvnu523' AND "deletedAt" IS NULL`)
console.log('GALE children:', g[0].n, '(was 20)')
await p.$disconnect()
