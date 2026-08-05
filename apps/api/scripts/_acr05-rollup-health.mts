/** ACR.0.5 — did the null write actually break the nightly rollup? READ-ONLY. */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = <T = Record<string, unknown>>(s: string) => p.$queryRawUnsafe<T[]>(s)
const n = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v)
const show = (rows: Record<string, unknown>[], max = 12) => rows.length
  ? rows.slice(0, max).forEach((r) => console.log('  ' + Object.entries(r).map(([k, v]) => `${k}=${String(n(v)).slice(0, 260)}`).join('  ')))
  : console.log('  (none)')

console.log('\n1. column nullability — can these columns hold "unknown" at all?')
show(await q(`
  SELECT table_name, column_name, is_nullable, column_default
  FROM information_schema.columns
  WHERE (table_name='ProductProfitDaily' AND column_name IN ('trueProfitCents','trueProfitMarginPct'))
     OR (table_name='Campaign' AND column_name IN ('trueProfitCents','trueProfitMarginPct'))
  ORDER BY table_name, column_name
`))

console.log('\n2. recent runs of the profit jobs')
show(await q(`
  SELECT "jobName", status, "startedAt"::text AS started,
         LEFT(COALESCE("errorMessage",''), 200) AS err,
         LEFT(COALESCE("outputSummary"::text,''), 200) AS summary
  FROM "CronRun"
  WHERE "jobName" ILIKE '%profit%' OR "jobName" ILIKE '%fba-fee%' OR "jobName" ILIKE '%metrics-ingest%'
  ORDER BY "startedAt" DESC LIMIT 10
`))

console.log('\n3. ProductProfitDaily: how many rows claim a profit they cannot know')
show(await q(`
  SELECT COUNT(*)::int AS rows,
         COUNT(*) FILTER (WHERE ("coverage"->>'hasCostPrice')::boolean IS TRUE)::int AS with_cost,
         COUNT(*) FILTER (WHERE "trueProfitCents" <> 0)::int AS nonzero_profit,
         COUNT(*) FILTER (WHERE "trueProfitMarginPct" IS NOT NULL)::int AS with_margin
  FROM "ProductProfitDaily"
`))

console.log('\n4. Campaign: same question')
show(await q(`
  SELECT COUNT(*)::int AS campaigns,
         COUNT(*) FILTER (WHERE "trueProfitCents" <> 0)::int AS nonzero_profit,
         COUNT(*) FILTER (WHERE "trueProfitMarginPct" IS NOT NULL)::int AS with_margin
  FROM "Campaign"
`))

await p.$disconnect()
console.log('\nDone — read-only.\n')
