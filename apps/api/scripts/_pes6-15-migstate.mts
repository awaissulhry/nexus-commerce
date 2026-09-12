import { config as loadEnv } from 'dotenv'
loadEnv({ path: new URL('../../../.env', import.meta.url).pathname })
import pg from 'pg'
const c = new pg.Client({ connectionString: (process.env.DATABASE_URL ?? '').replace('-pooler','') })
await c.connect()
const r = await c.query(`select migration_name, finished_at from "_prisma_migrations" where migration_name like '%pes6%' order by started_at`)
for (const x of r.rows) console.log(`  ${x.migration_name}  ${x.finished_at ? 'finished' : 'PENDING'}`)
const col = await c.query(`select count(*)::int n from information_schema.columns where table_name='CellFormula' and column_name='lastValue'`)
console.log(`  lastValue column present: ${col.rows[0].n > 0 ? 'YES' : 'NO'}`)
await c.end()
