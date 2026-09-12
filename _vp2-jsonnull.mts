import { PrismaClient } from '@prisma/client'
const p = new PrismaClient({ datasources: { db: { url: process.argv[2] } } })
const r: any[] = await p.$queryRawUnsafe(
 `SELECT count(*) FILTER (WHERE "variationMapping" IS NULL)::int AS sql_null,
         count(*) FILTER (WHERE jsonb_typeof("variationMapping") = 'null')::int AS json_null,
         count(*) FILTER (WHERE jsonb_typeof("variationMapping") = 'object')::int AS real_object,
         count(*)::int AS total FROM "ChannelListing"`)
console.log(JSON.stringify(r[0]))
const one: any[] = await p.$queryRawUnsafe(`SELECT id, jsonb_typeof("variationMapping") AS t, "updatedAt" FROM "ChannelListing" WHERE "variationMapping" IS NOT NULL`)
console.log(JSON.stringify(one))
await p.$disconnect()
