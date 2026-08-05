/** ACR.0.5 — did the migration land, and did it land right? READ-ONLY. */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = <T = Record<string, unknown>>(s: string) => p.$queryRawUnsafe<T[]>(s)
const n = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v)
const show = (rows: Record<string, unknown>[], max = 10) => rows.length
  ? rows.slice(0, max).forEach((r) => console.log('  ' + Object.entries(r).map(([k, v]) => `${k}=${String(n(v)).slice(0, 120)}`).join('  ')))
  : console.log('  (none)')
const h = (s: string) => console.log(`\n${'─'.repeat(76)}\n${s}\n${'─'.repeat(76)}`)

h('1. migration recorded?')
show(await q(`SELECT migration_name, finished_at::text AS finished, COALESCE(logs,'') AS logs
              FROM "_prisma_migrations" ORDER BY started_at DESC LIMIT 3`))

h('2. columns can now hold unknown')
show(await q(`SELECT table_name, column_name, is_nullable, COALESCE(column_default,'(none)') AS default
              FROM information_schema.columns
              WHERE column_name='trueProfitCents' AND table_name IN ('Campaign','ProductProfitDaily')
              ORDER BY table_name`))

h('3. the repair — expected 714 unknown / 137 known / 216 campaigns unknown')
show(await q(`SELECT
   (SELECT COUNT(*) FROM "ProductProfitDaily" WHERE "trueProfitCents" IS NULL)::int AS ppd_unknown,
   (SELECT COUNT(*) FROM "ProductProfitDaily" WHERE "trueProfitCents" IS NOT NULL)::int AS ppd_known,
   (SELECT COUNT(*) FROM "ProductProfitDaily" WHERE ("coverage"->>'hasCostPrice')::boolean IS TRUE)::int AS ppd_claims_cost,
   (SELECT COUNT(*) FROM "Campaign" WHERE "trueProfitCents" IS NULL)::int AS camp_unknown,
   (SELECT COUNT(*) FROM "Campaign" WHERE "trueProfitCents" IS NOT NULL)::int AS camp_known`))

h('4. no row still claims a profit it cannot know')
show(await q(`SELECT COUNT(*)::int AS liars FROM "ProductProfitDaily"
              WHERE "cogsCents" <= 0 AND "grossRevenueCents" > 0
                AND ("trueProfitCents" IS NOT NULL OR ("coverage"->>'hasCostPrice')::boolean IS TRUE)`))

await p.$disconnect()
console.log('\nDone — read-only.\n')
