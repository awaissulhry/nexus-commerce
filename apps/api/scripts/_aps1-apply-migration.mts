/** APS.1 — apply the additive migration and record it in _prisma_migrations.
 *
 *  `prisma migrate deploy` takes a SESSION-scoped advisory lock, which is
 *  broken over the Neon pooler (see reference_pgbouncer_advisory_locks), and
 *  the CLI's own dotenv resolution fights the repo's layered .env files. The
 *  DDL itself is transaction-scoped and perfectly safe over the pooler, so we
 *  run it through the app's own client and then write the migration row so
 *  Railway's `migrate deploy` sees it as already applied instead of blocking
 *  boot on a pending migration.
 *
 *  Every statement is IF NOT EXISTS — re-running is a no-op.
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const prisma = (await import('../src/db.js')).default
const p = prisma as any
const L = (s = '') => console.log(s)

const NAME = '20260730_aps1_readcache_asin_rollup'
const SQL_PATH = new URL(
  `../../../packages/database/prisma/migrations/${NAME}/migration.sql`,
  import.meta.url,
)

const sql = readFileSync(SQL_PATH, 'utf8')
const checksum = createHash('sha256').update(sql).digest('hex')

const already = await p.$queryRawUnsafe(
  `SELECT migration_name, finished_at FROM "_prisma_migrations" WHERE migration_name = $1`,
  NAME,
)
if ((already as any[]).length > 0) {
  L(`already recorded: ${NAME}`)
} else {
  L(`applying ${NAME} …`)
  // Strip comments, split on ';' — every statement here is a plain DDL.
  const statements = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)

  for (const stmt of statements) {
    L(`  ${stmt.split('\n')[0].slice(0, 78)}`)
    await p.$executeRawUnsafe(stmt)
  }

  await p.$executeRawUnsafe(
    `INSERT INTO "_prisma_migrations"
       (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
     VALUES (gen_random_uuid()::text, $1, now(), $2, NULL, NULL, now(), 1)`,
    checksum,
    NAME,
  )
  L('recorded in _prisma_migrations')
}

L('\n══ VERIFY COLUMNS ════════════════════════════════════════════════')
const cols = await p.$queryRawUnsafe(
  // information_schema columns are of pg type `name`, which the Prisma
  // driver cannot deserialize — cast every one of them to text.
  `SELECT column_name::text AS column_name, data_type::text AS data_type, is_nullable::text AS is_nullable
     FROM information_schema.columns
    WHERE table_name = 'ProductReadCache'
      AND column_name IN ('asin','rollupChannelKeys')
    ORDER BY column_name`,
)
for (const c of cols as any[]) L(`  ${String(c.column_name).padEnd(20)} ${String(c.data_type).padEnd(10)} nullable=${c.is_nullable}`)

const idx = await p.$queryRawUnsafe(
  `SELECT indexname::text AS indexname FROM pg_indexes
    WHERE tablename = 'ProductReadCache'
      AND indexname IN ('ProductReadCache_asin_idx','ProductReadCache_rollupChannelKeys_idx')
    ORDER BY indexname`,
)
for (const i of idx as any[]) L(`  index ${i.indexname}`)

await prisma.$disconnect()
