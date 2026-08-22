/** ADM-P6/B2 — apply ONLY this migration, and record it. Never `prisma migrate deploy` in this
 *  tree: it applies every pending folder entry, which is how SPC.1/RPT's parked 20260820d reached
 *  production this morning. See reference_migrate_deploy_drags_parked_migrations.
 *
 *  🔴 Strip comments BEFORE splitting on `;`. A migration.sql that opens with a comment block is
 *  one chunk up to the first semicolon, that chunk starts with `--`, and a naive
 *  `.filter(s => !s.startsWith('--'))` therefore discards the statement along with its
 *  explanation — silently, while the run still reports success. Caught only by asserting the
 *  COLUMN afterwards rather than trusting the absence of an error. */
import fs from 'node:fs'
const { default: prisma } = await import('../src/db.js')
const NAME = '20260822b_p6_stream_budget_nullable'
const raw = fs.readFileSync(`../../packages/database/prisma/migrations/${NAME}/migration.sql`, 'utf8')
const stmts = raw
  .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
  .split(';').map((s) => s.trim()).filter(Boolean)
console.log('statements to run:', stmts.length)
for (const s of stmts) console.log('  ', s.slice(0, 90))
for (const s of stmts) await prisma.$executeRawUnsafe(s)

const known = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
  `SELECT COUNT(*)::bigint AS n FROM _prisma_migrations WHERE migration_name = $1`, NAME)
if (Number(known[0].n) === 0) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
     VALUES (gen_random_uuid()::text, '', $1, now(), now(), 1)`, NAME)
  console.log('recorded in _prisma_migrations')
} else {
  console.log('already recorded (the earlier run wrote the row before the statement ran)')
}
const col = await prisma.$queryRawUnsafe<Array<{ is_nullable: string }>>(
  `SELECT is_nullable FROM information_schema.columns WHERE table_name='AdBudgetUsageSample' AND column_name='budgetCents'`)
console.log(`\nbudgetCents is_nullable = ${col[0]?.is_nullable} (want YES)`)
const n = await prisma.adBudgetUsageSample.count()
console.log(`existing sample rows intact: ${n}`)
await prisma.$disconnect()
