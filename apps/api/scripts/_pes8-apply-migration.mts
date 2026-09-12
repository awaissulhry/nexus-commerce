// PES.8 — apply ONLY this lane's additive migration.
//
// Deliberately not `prisma migrate deploy`: siblings have their own uncommitted
// migration folders in the shared tree, and deploy would drag every one of them
// in (reference_migrate_deploy_drags_parked_migrations). This applies one file
// and records exactly that one in _prisma_migrations.
import '../src/env.js'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const NAME = process.argv[2] ?? '20260901c_pes8_product_ai_draft'
const SQL_PATH = new URL(
  `../../../packages/database/prisma/migrations/${NAME}/migration.sql`,
  import.meta.url,
)

const { default: prisma } = await import('../src/db.js')

const [{ db }] = await prisma.$queryRawUnsafe<{ db: string }[]>('SELECT current_database()::text AS db')
console.log('database:', db)

const applied = await prisma.$queryRawUnsafe<{ c: bigint }[]>(
  `SELECT count(*)::bigint AS c FROM "_prisma_migrations" WHERE migration_name = $1`, NAME,
)
if (Number(applied[0].c) > 0) {
  console.log(`${NAME} already applied — nothing to do.`)
  await prisma.$disconnect()
  process.exit(0)
}

const sql = readFileSync(SQL_PATH, 'utf8')

/**
 * Strip `--` line comments BEFORE splitting on `;`.
 *
 * Splitting first is a trap this script fell into: a comment reading "...cached Amazon schema;
 * without it every attribute draft was refused..." contains a semicolon, so the naive split cut a
 * statement in half and Postgres answered `syntax error at or near "without"`. The comment is not
 * SQL; remove it, then split.
 */
const stripped = sql
  .split('\n')
  .map((line) => {
    const i = line.indexOf('--')
    return i === -1 ? line : line.slice(0, i)
  })
  .join('\n')

const statements = stripped
  .split(';')
  .map((s) => s.trim())
  .filter((s) => s.length > 0)

for (const stmt of statements) {
  const head = stmt.split('\n').filter((l) => !l.trim().startsWith('--'))[0]?.slice(0, 80)
  console.log('  ->', head)
  await prisma.$executeRawUnsafe(stmt)
}

const checksum = createHash('sha256').update(sql).digest('hex')
await prisma.$executeRawUnsafe(
  `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
   VALUES (gen_random_uuid()::text, $1, now(), $2, NULL, NULL, now(), $3)`,
  checksum,
  NAME,
  statements.length,
)

const cols = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
  `SELECT column_name::text AS column_name FROM information_schema.columns WHERE table_name = 'ProductAiDraft' ORDER BY ordinal_position`,
)
console.log('applied. columns:', cols.map((c) => c.column_name).join(', '))
await prisma.$disconnect()
