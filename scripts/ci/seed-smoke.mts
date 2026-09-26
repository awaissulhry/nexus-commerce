#!/usr/bin/env -S npx tsx
/**
 * CI smoke (docs/ci-plan.md §2.3) — the few rows a production-built app needs to be driven by
 * Playwright, on a database prepared by scripts/ci/prepare-test-database.mts.
 *
 * WHAT IT CREATES
 * - the OWNER role (as apps/api/src/scripts/bootstrap-owner.ts creates it) and one owner user whose
 *   password is generated here and passes the app's own strength check;
 * - a second business, `smoke_business_b`, next to the legacy one; the owner is an active member of
 *   both, with the OWNER role in each (the shape scripts/studio-gate-session.mjs proved);
 * - two products per business, whose names carry a random NONCE. The smoke setup reads a nonce back
 *   through the UI before any test runs: that proves the app answering is the one on THIS database,
 *   and never production (backend-url.ts falls back to the production API when a variable is missing);
 * - a restricted LOGIN role for the web and API processes, INHERITING nexus_workspace_runtime. Under NODE_ENV=production RuntimePool
 *   refuses any login that owns objects or bypasses row security — the owner login production used
 *   until #4 would be refused — so the smoke stack runs on the same kind of login production must use.
 *
 * The credentials go ONLY to the file named by --out (mode 600), outside the repo.
 *
 *   npx tsx scripts/ci/seed-smoke.mts --url postgresql://postgres@127.0.0.1:5432/nexus_test --out "$RUNNER_TEMP/smoke.json"
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, writeFileSync } from 'node:fs'
import pg from 'pg'
import { checkPasswordStrength, hashPassword } from '../../apps/api/src/lib/auth/password.ts'

const args = process.argv.slice(2)
const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const url = new URL(value('--url') ?? process.env.NEXUS_TEST_LOCAL_PG_URL ?? '')
const out = value('--out')
if (!out) { console.error('✗ --out <file> is required'); process.exit(1) }
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname) || !url.pathname.includes('test')) {
  console.error(`✗ REFUSED: ${url.hostname}${url.pathname} — only a loopback database whose name contains "test"`)
  process.exit(1)
}

const A = 'nexus_legacy_workspace'
const B = 'smoke_business_b'
const email = `smoke-owner-${randomBytes(6).toString('hex')}@example.test`
const password = `${randomBytes(18).toString('base64url')}-Aa9!`
const strength = checkPasswordStrength(password, [email])
if (!strength.ok) { console.error(`✗ generated password fails the app policy: ${strength.message}`); process.exit(1) }
const nonce = randomBytes(4).toString('hex').toUpperCase()
const appLogin = 'nexus_smoke_app'
const appPassword = randomBytes(24).toString('hex')

const client = new pg.Client({ connectionString: url.toString() })
await client.connect()
await client.query('BEGIN')
await client.query(`INSERT INTO "Workspace" (id, name, status, "isLegacy", "createdByUserId", "creationKey", "updatedAt")
  VALUES ($1, 'Smoke business B', 'active', false, 'smoke-seed', 'smoke-seed-b', now()) ON CONFLICT (id) DO NOTHING`, [B])
const roleId = randomUUID()
await client.query(`INSERT INTO "Role" (id, key, name, description, permissions, "isSystem", "requireMfa", "createdAt", "updatedAt")
  VALUES ($1, 'OWNER', 'Owner', 'Full, implicit access to everything. System-protected.', '{}', true, false, now(), now())
  ON CONFLICT (key) DO NOTHING`, [roleId])
const role = (await client.query(`SELECT id FROM "Role" WHERE key = 'OWNER'`)).rows[0].id as string
const userId = `smoke_${randomUUID()}`
await client.query(`INSERT INTO "UserProfile" (id, email, "displayName", "passwordHash", status, "updatedAt")
  VALUES ($1, $2, 'Smoke owner', $3, 'active', now())`, [userId, email, await hashPassword(password)])
await client.query(`INSERT INTO "UserRole" (id, "userId", "roleId") VALUES ($1, $2, $3)`, [randomUUID(), userId, role])
for (const workspace of [A, B]) {
  const member = randomUUID()
  await client.query(`INSERT INTO "WorkspaceMembership" (id, "workspaceId", "userId", status, "updatedAt") VALUES ($1, $2, $3, 'active', now())`, [member, workspace, userId])
  await client.query(`INSERT INTO "WorkspaceMemberRole" ("membershipId", "roleId") VALUES ($1, $2)`, [member, role])
}
const products: Record<string, { id: string; sku: string; name: string }[]> = {}
for (const [workspace, tag] of [[A, 'A'], [B, 'B']] as const) {
  await client.query(`SELECT set_config('nexus.workspace_id', $1, true)`, [workspace])
  products[workspace] = []
  for (const n of [1, 2]) {
    const row = { id: `smoke_${tag}${n}_${nonce.toLowerCase()}`, sku: `SMOKE-${tag}${n}-${nonce}`, name: `Smoke ${tag}${n} ${nonce}` }
    await client.query(`INSERT INTO "Product" (id, sku, name, "basePrice", "updatedAt") VALUES ($1, $2, $3, 10.00, now())`, [row.id, row.sku, row.name])
    products[workspace].push(row)
  }
}
await client.query(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${appLogin}') THEN
    CREATE ROLE ${appLogin} LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF; END $$`)
await client.query(`ALTER ROLE ${appLogin} PASSWORD '${appPassword}'`)
// WITH INHERIT TRUE, measured: the web's control pool (apps/web/src/lib/workspaces/server.ts) reads
// UserSession, UserProfile and memberships AS THE LOGIN, without SET ROLE. A grant made without inherit
// (PostgreSQL 16+ records it per grant) left every signed-in page at 500 "permission denied for table
// UserSession". Production's restricted login (#4) needs the same grant.
await client.query(`GRANT nexus_workspace_runtime TO ${appLogin} WITH INHERIT TRUE`)
await client.query('COMMIT')
await client.end()

const appUrl = new URL(url.toString())
appUrl.username = appLogin
appUrl.password = appPassword
writeFileSync(out, JSON.stringify({ email, password, workspaces: { a: A, b: B }, nonce, products, appDatabaseUrl: appUrl.toString() }, null, 2))
chmodSync(out, 0o600)
console.log(`✓ smoke seed: owner in ${A} and ${B}, 2 products each (nonce ${nonce}), restricted app login ${appLogin}`)
