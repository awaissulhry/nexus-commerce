/** APS.5b — apply the AdProductSet migration and record it.
 *  Same reasoning as _aps1-apply-migration: `migrate deploy` takes a
 *  SESSION-scoped advisory lock that is broken over the Neon pooler, while the
 *  DDL itself is transaction-scoped and safe. Idempotent. */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const prisma = (await import('../src/db.js')).default
const p = prisma as any
const L = (s = '') => console.log(s)

const NAME = '20260730_aps5b_ad_product_set'
const sql = readFileSync(
  new URL(`../../../packages/database/prisma/migrations/${NAME}/migration.sql`, import.meta.url),
  'utf8',
)

const already = await p.$queryRawUnsafe(
  `SELECT migration_name FROM "_prisma_migrations" WHERE migration_name = $1`, NAME,
)
if ((already as any[]).length > 0) {
  L(`already recorded: ${NAME}`)
} else {
  const statements = sql
    .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    .split(';').map((s) => s.trim()).filter(Boolean)
  for (const stmt of statements) {
    L(`  ${stmt.split('\n')[0].slice(0, 74)}`)
    await p.$executeRawUnsafe(stmt)
  }
  await p.$executeRawUnsafe(
    `INSERT INTO "_prisma_migrations"
       (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
     VALUES (gen_random_uuid()::text, $1, now(), $2, NULL, NULL, now(), 1)`,
    createHash('sha256').update(sql).digest('hex'), NAME,
  )
  L('recorded in _prisma_migrations')
}

L('\n══ VERIFY ════════════════════════════════════════════════════════')
const cols = await p.$queryRawUnsafe(
  `SELECT column_name::text AS c, data_type::text AS t, is_nullable::text AS n
     FROM information_schema.columns WHERE table_name = 'AdProductSet' ORDER BY ordinal_position`,
)
for (const c of cols as any[]) L(`  ${String(c.c).padEnd(14)} ${String(c.t).padEnd(28)} nullable=${c.n}`)
const idx = await p.$queryRawUnsafe(
  `SELECT indexname::text AS i FROM pg_indexes WHERE tablename = 'AdProductSet' ORDER BY 1`,
)
for (const i of idx as any[]) L(`  index ${i.i}`)
L(`  rows: ${await p.adProductSet.count()}`)

await prisma.$disconnect()
