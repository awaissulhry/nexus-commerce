#!/usr/bin/env node
/**
 * CI (docs/ci-plan.md §2.3, `postgres` job) — the PR's migrations, applied the way production applies
 * them, must produce exactly the database a fresh environment gets.
 *
 * WHY
 * Nothing replayed migrations before: fresh databases come from `baseline.sql`, and tests build their
 * schema from `schema.prisma`. A migration that forgets a column, an index or a policy passes every
 * test and breaks only production. This builds two databases on a disposable server:
 *   A  the BASE commit's database (its own bootstrap and baseline), then the PR's
 *      `packages/database/scripts/migrate-direct.mjs` — the production release command — on top;
 *   B  a fresh database from the PR's own bootstrap.
 * and requires them to match:
 *   · every migration folder of the PR is recorded as applied in A;
 *   · `prisma migrate diff` from each database to the PR's `schema.prisma` leaves the SAME statements
 *     (both keep the known SET DEFAULT residue and the deployed-only extras, so those cancel out);
 *   · the row-level-security layer is the same: policies, RLS flags and the runtime role's grants.
 * Column ORDER is not compared: a migration appends a column, a fresh CREATE TABLE places it in model
 * order, and nothing reads the order.
 *
 * BASE
 *   NEXUS_MIGRATION_BASE=<sha> if set (CI: the PR base, or the push's `before`), else merge-base with
 *   origin/main. No base = exit 2.
 *
 *   node scripts/ci/check-migration-upgrade.mjs --server postgresql://postgres@127.0.0.1:5432
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const BASE_DIR = join(ROOT, 'node_modules', '.cache', 'ci-migration-base')
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')
const PRISMA = join(ROOT, 'node_modules', '.bin', 'prisma')
const args = process.argv.slice(2)
const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }

const server = new URL(value('--server') ?? 'postgresql://postgres@127.0.0.1:5432')
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(server.hostname)) {
  console.error(`✗ REFUSED: --server must be loopback, got ${server.hostname}`)
  process.exit(1)
}
const urlFor = database => { const u = new URL(server.toString()); u.pathname = `/${database}`; return u.toString() }
const A = urlFor('nexus_upgrade_a_test')
const B = urlFor('nexus_upgrade_b_test')

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
function step(label, cmd, cmdArgs, env = {}, cwd = ROOT) {
  console.log(`\n── ${label}`)
  const run = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit', env: { ...process.env, ...env } })
  if (run.status !== 0) { console.error(`✗ ${label} failed (exit ${run.status})`); process.exit(1) }
}

let base = process.env.NEXUS_MIGRATION_BASE?.trim()
try {
  base = base ? git('rev-parse', '--verify', `${base}^{commit}`) : git('merge-base', 'HEAD', 'origin/main')
} catch {
  console.error(`✗ could not resolve the base commit (${base || 'merge-base HEAD origin/main'}) — fetch the history or set NEXUS_MIGRATION_BASE`)
  process.exit(2)
}
console.log(`migration upgrade check: base ${base.slice(0, 9)} → HEAD ${git('rev-parse', '--short=9', 'HEAD')}`)

// The base's own database package, where Node still resolves the root node_modules.
rmSync(BASE_DIR, { recursive: true, force: true })
mkdirSync(BASE_DIR, { recursive: true })
execFileSync('sh', ['-c', `git archive ${base} packages/database | tar -x -C "${BASE_DIR}"`], { cwd: ROOT, stdio: 'inherit' })

const admin = new pg.Client({ connectionString: urlFor('postgres') })
await admin.connect()
for (const db of ['nexus_upgrade_a_test', 'nexus_upgrade_b_test']) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`)
await admin.end()

step('A: bootstrap the BASE commit', TSX, ['scripts/ci/prepare-test-database.mts', '--url', A, '--database-dir', join(BASE_DIR, 'packages', 'database'), '--no-markets'])
// The production release command, as Railway's pre-deploy step runs it: `npm run db:migrate:deploy` from the repo root.
step('A: apply the PR\'s migrations with the production release command', process.execPath, ['packages/database/scripts/migrate-direct.mjs'], { DATABASE_URL: A, MIGRATION_DATABASE_URL: A, NODE_ENV: 'test' }, ROOT)
step('B: bootstrap the PR head', TSX, ['scripts/ci/prepare-test-database.mts', '--url', B, '--no-markets'])

const problems = []

// 1. Every folder of the PR is recorded as applied in A.
const folders = readdirSync(join(ROOT, 'packages/database/prisma/migrations')).filter(n => statSync(join(ROOT, 'packages/database/prisma/migrations', n)).isDirectory())
const a = new pg.Client({ connectionString: A }); await a.connect()
const b = new pg.Client({ connectionString: B }); await b.connect()
const applied = new Set((await a.query('SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')).rows.map(r => r.migration_name))
const missing = folders.filter(f => !applied.has(f))
if (missing.length) problems.push(`migrations not applied to the upgraded database: ${missing.join(', ')}`)

// 2. The same residue against the PR's schema.prisma.
function residue(url) {
  // Prisma 7 reads the database from prisma.config.ts, which prefers MIGRATION_DATABASE_URL. Both
  // are set here, so a value from a developer's .env (dotenv never overrides) cannot be diffed.
  const out = execFileSync(PRISMA, ['migrate', 'diff', '--config', 'packages/database/prisma.config.ts',
    '--from-config-datasource', '--to-schema', 'packages/database/prisma/schema.prisma', '--script'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, MIGRATION_DATABASE_URL: url, DATABASE_URL: url },
  })
  return out.replace(/--[^\n]*/g, '').split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)
}
const count = list => list.reduce((m, s) => m.set(s, (m.get(s) ?? 0) + 1), new Map())
const ra = count(residue(A)), rb = count(residue(B))
const onlyA = [...ra].filter(([s, n]) => (rb.get(s) ?? 0) < n).map(([s]) => s)
const onlyB = [...rb].filter(([s, n]) => (ra.get(s) ?? 0) < n).map(([s]) => s)
if (onlyA.length) problems.push(`the upgraded database still needs these to match schema.prisma (a migration is missing or wrong):\n${onlyA.slice(0, 20).map(s => `      ${s.slice(0, 200)}`).join('\n')}`)
if (onlyB.length) problems.push(`the fresh database needs these but the upgraded one does not (baseline.sql is stale, or a migration does more than the schema):\n${onlyB.slice(0, 20).map(s => `      ${s.slice(0, 200)}`).join('\n')}`)

// 3. The same isolation layer.
const LAYER = {
  policies: `SELECT tablename || ' · ' || policyname || ' · ' || cmd || ' · ' || array_to_string(roles, ',') || ' · ' || coalesce(qual, '') || ' · ' || coalesce(with_check, '') AS k FROM pg_policies WHERE schemaname = 'public'`,
  'RLS flags': `SELECT c.relname || ' · ' || c.relrowsecurity || ' · ' || c.relforcerowsecurity AS k FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`,
  'runtime grants': `SELECT table_name || ' · ' || privilege_type AS k FROM information_schema.role_table_grants WHERE grantee = 'nexus_workspace_runtime'`,
}
for (const [name, sql] of Object.entries(LAYER)) {
  const sa = new Set((await a.query(sql)).rows.map(r => r.k)), sb = new Set((await b.query(sql)).rows.map(r => r.k))
  const diffA = [...sa].filter(k => !sb.has(k)), diffB = [...sb].filter(k => !sa.has(k))
  if (sb.size === 0) problems.push(`the fresh database has zero ${name} — refusing to compare against nothing`)
  if (diffA.length || diffB.length) problems.push(`${name} differ:\n${[...diffA.map(k => `      only upgraded: ${k.slice(0, 200)}`), ...diffB.map(k => `      only fresh:    ${k.slice(0, 200)}`)].slice(0, 20).join('\n')}`)
  else console.log(`✓ ${name}: ${sb.size} identical`)
}
await a.end(); await b.end()

console.log(`\n${folders.length} migrations applied · residue ${[...ra.values()].reduce((x, y) => x + y, 0)} statements on both sides`)
if (problems.length) {
  console.error(`\n✗ migration upgrade check FAILED\n${problems.map(p => `  • ${p}`).join('\n')}`)
  process.exit(1)
}
console.log('✓ the PR\'s migrations produce the database a fresh environment gets')
