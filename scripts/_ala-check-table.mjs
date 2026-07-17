import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'; import { fileURLToPath } from 'node:url'; import { dirname, join } from 'node:path'
config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') })
const p = new PrismaClient()
try {
  const r = await p.$queryRawUnsafe(`SELECT to_regclass('"ListingIssue"')::text AS t`)
  console.log('ListingIssue table:', r[0].t ? 'EXISTS ✓' : 'not yet')
  const m = await p.$queryRawUnsafe(`SELECT migration_name, finished_at FROM "_prisma_migrations" WHERE migration_name = '20260623_listing_issue'`)
  console.log('migration record:', m.length ? `applied @ ${m[0].finished_at}` : 'not recorded yet')
} catch (e) { console.log('check error:', e.message) } finally { await p.$disconnect() }
