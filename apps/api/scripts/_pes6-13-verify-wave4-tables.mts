import { config as loadEnv } from 'dotenv'
loadEnv({ path: new URL('../../../.env', import.meta.url).pathname })
import pg from 'pg'
const url = (process.env.DATABASE_URL ?? '').replace('-pooler', '')
const c = new pg.Client({ connectionString: url }); await c.connect()
for (const t of ['CellFormula', 'MasterFieldRule', 'MasterFieldRuleRevision']) {
  const reg = await c.query(`select to_regclass($1) as t`, [`"${t}"`])
  const cols = await c.query(
    `select column_name, data_type, is_nullable, column_default from information_schema.columns
     where table_name = $1 order by ordinal_position`, [t])
  const idx = await c.query(`select indexname from pg_indexes where tablename = $1 order by indexname`, [t])
  console.log(`\n${t}: ${reg.rows[0].t ? 'EXISTS' : '🔴 MISSING'} — ${cols.rows.length} columns`)
  for (const r of cols.rows) {
    console.log(`  ${r.column_name.padEnd(14)} ${r.data_type.padEnd(28)} ${r.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'} ${r.column_default ?? ''}`)
  }
  console.log('  indexes: ' + idx.rows.map((r: any) => r.indexname).join(', '))
}
const rec = await c.query(`select migration_name, finished_at from "_prisma_migrations" where migration_name like '%wave4%'`)
console.log('\n_prisma_migrations:', rec.rows.map((r: any) => r.migration_name).join(', ') || 'NOT RECORDED')
await c.end()
