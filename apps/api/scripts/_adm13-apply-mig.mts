/** ADM.13 — apply ONLY this migration's SQL and record it, per
 *  reference_migrate_deploy_drags_parked_migrations (never `migrate deploy` in a shared tree). */
import prisma from '../src/db.js'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const NAME = '20260826a_adm_a3_ntb_kenp'
const sql = readFileSync(`../../packages/database/prisma/migrations/${NAME}/migration.sql`, 'utf8')
const already = await prisma.$queryRawUnsafe<any[]>(`SELECT 1 FROM "_prisma_migrations" WHERE migration_name=$1`, NAME)
if (already.length) { console.log('already recorded — nothing to do'); process.exit(0) }
// 🔴 Strip comment LINES before splitting: this migration's prose contains a semicolon, and a
// naive split on ';' cut mid-sentence and fed Postgres "0 will mean a real reported zero."
const stripped = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
for (const stmt of stripped.split(';').map((s) => s.trim()).filter(Boolean)) {
  await prisma.$executeRawUnsafe(stmt)
  console.log('  applied:', stmt.replace(/\s+/g,' ').slice(0, 90))
}
await prisma.$executeRawUnsafe(
  `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
   VALUES ($1,$2,$3,now(),now(),1)`,
  createHash('sha256').update(NAME).digest('hex').slice(0,36),
  createHash('sha256').update(sql).digest('hex'), NAME)
console.log('recorded in _prisma_migrations')
const cols = await prisma.$queryRawUnsafe<any[]>(`SELECT column_name::text c, is_nullable::text n, column_default::text d FROM information_schema.columns WHERE table_name='AmazonAdsDailyPerformance' AND column_name IN ('ntbUnits14d','ntbOrdersRate14d','kenpRead14d','kenpRoyaltiesCents14d') ORDER BY 1`)
console.log('\nverified on prod:')
for (const c of cols) console.log(`  ${c.c.padEnd(24)} nullable=${c.n} default=${c.d ?? 'NONE'}`)
await prisma.$disconnect()
