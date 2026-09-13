import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'; import { parse } from 'dotenv'
const url = parse(readFileSync(new URL('../.env', import.meta.url).pathname, 'utf8')).DATABASE_URL!
if (!/nexus_development/.test(url)) throw new Error('REFUSED')
const prisma = new PrismaClient({ datasources: { db: { url } } })
/**
 * 🔴 The classifier my first census used called a JSON `null` value "flat", because `jsonb_typeof(x->'axes')` is
 * NULL for both. It is corrected here: the TYPE of the value itself is read first
 * (`reference_could_not_measure_vs_measured_empty` — two different states must not serialise to one word).
 */
const rows = await prisma.$queryRawUnsafe<Array<{ shape: string; n: bigint }>>(`
  SELECT CASE
           WHEN "variationMapping" IS NULL THEN 'sql-null'
           WHEN jsonb_typeof("variationMapping"::jsonb) = 'null' THEN 'json-null'
           WHEN jsonb_typeof("variationMapping"::jsonb) <> 'object' THEN 'not-an-object'
           WHEN jsonb_typeof(("variationMapping"::jsonb) -> 'axes') = 'array' THEN 'ordered'
           WHEN ("variationMapping"::jsonb) = '{}'::jsonb THEN 'empty-object'
           ELSE 'flat' END AS shape,
         COUNT(*)::bigint AS n
  FROM "ChannelListing" GROUP BY 1 ORDER BY 2 DESC`)
console.log('variationMapping SHAPE CENSUS:', JSON.stringify(rows.map(r => [r.shape, Number(r.n)])))
await prisma.$disconnect()
