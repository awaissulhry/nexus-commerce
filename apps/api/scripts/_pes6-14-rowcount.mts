import { config as loadEnv } from 'dotenv'
loadEnv({ path: new URL('../../../.env', import.meta.url).pathname })
import pg from 'pg'
const c = new pg.Client({ connectionString: (process.env.DATABASE_URL ?? '').replace('-pooler','') })
await c.connect()
for (const t of ['CellFormula','MasterFieldRule','MasterFieldRuleRevision']) {
  const r = await c.query(`select count(*)::int as n from "${t}"`)
  console.log(`  ${t}: ${r.rows[0].n} rows`)
}
await c.end()
