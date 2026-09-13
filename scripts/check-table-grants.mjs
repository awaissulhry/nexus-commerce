#!/usr/bin/env node
/**
 * R-LX-28 — every table the application routes through the RUNTIME ROLE can actually be touched by
 * it, and carries the isolation policy the project's own pattern requires.
 *
 * ## The measured case this exists for (LX.FIN, 2026-09-13)
 *
 * `SellerReferenceLabel` shipped with a `CREATE TABLE` and no `GRANT`. Twelve vitest tests passed —
 * every one of them mocked `../../db.js` — so the mock held constant the exact dimension the claim
 * was about: whether `nexus_workspace_runtime` can read and write that table. Through the
 * application's own client both arms answered **`42501 permission denied for table
 * SellerReferenceLabel`**, and because `storedShippingLabels`/`rememberShippingLabels` are both
 * wrapped in `try/catch` (deliberately — a label cache must never fail the page it rode in on) the
 * feature would have been a **silent no-op in production with nothing anywhere saying why**.
 *
 * `prisma validate` passes on a grant-less table. `prisma generate` passes. `tsc` passes. Every
 * green test passes. Nothing in this repo caught it, which is what this gate is.
 *
 * `packages/database/workspace-adapter.js:11` is why the role matters: it issues
 * `SET LOCAL ROLE nexus_workspace_runtime` on every routed query.
 *
 * ## Nothing here is a hand-written list
 *
 * Three sets, all DERIVED at run time (`reference_a_list_of_members_is_a_set_claim` — a hardcoded
 * list of tables would be stale within a day, and this repo gains tables weekly):
 *
 *  1. **The tables to check** come from `model` blocks in `packages/database/prisma/schema.prisma`
 *     (`@@map` honoured, so a renamed table follows).
 *  2. **The privileges each one needs** come from `20260908b_workspace_data_isolation/migration.sql`
 *     itself — its `GRANT`s MINUS its `REVOKE`s. That matters: `ChannelAccountRoute` and
 *     `ChannelAccountOwnership` are granted `SELECT, INSERT, UPDATE, DELETE` and then
 *     `REVOKE INSERT, UPDATE, DELETE` (migration.sql:11183-11184), because writes to them go
 *     through the `SECURITY DEFINER` function `nexus_assign_channel_account`. A gate that demanded
 *     the full set on every table would report those two as defects forever and be switched off.
 *     Measured shape of the requirement it derives: **425 tables SELECT/INSERT/UPDATE/DELETE · 2
 *     tables SELECT only**.
 *  3. **Whether a table needs an RLS policy** comes from the same migration for the 427 tables it
 *     names (it enables row-level security on 409 of them and deliberately not on the 18 identity /
 *     account tables), and from the SCHEMA for a table added afterwards: a model carrying a
 *     `workspaceId` column is workspace-scoped data, so it needs `nexus_workspace_isolation`.
 *     `20260911_category_taxonomies` and `20260908b` are the pattern; `20260912_lx4_*` and
 *     `20260912_lx5_*` are the two that departed from it.
 *
 * ## The instrument's own arms, in every run
 *
 * A "0 violations" line is a claim that the instrument was pointed at the right thing (AAA bar #2).
 * So every run also:
 *
 *  * **fires the negative arm**: it creates a deliberately grant-less, policy-less table with a
 *    `workspaceId` column INSIDE A TRANSACTION, evaluates it through the same predicate as every
 *    real table, and requires it to be reported for BOTH reasons. Then it rolls back and asserts
 *    `to_regclass` is NULL, so the probe cannot outlive the run even if the run dies.
 *  * **shows a passing arm**: `--witness <Table>` prints one named table's full row. The gate also
 *    requires that at least one real table passes every arm, or a green result would be consistent
 *    with the predicate being unsatisfiable.
 *
 * If the control does not fire, the gate exits 1 and says the measurement proves nothing.
 *
 * ## The database is NAMED before anything is read
 *
 * `reference_which_database_is_this_api_on`: the URL is read EXPLICITLY out of `apps/api/.env`
 * (never `process.env`, never the repo-root `.env` — on 09-11 the same inference cost a lane a day),
 * any `neon.tech` host is refused outright, and `current_database()` must be `nexus_development`
 * before the first measurement query. There is no flag that lifts either check: a grant gate that
 * can be pointed at production is a production write away from being a production incident.
 *
 * Usage:
 *   node scripts/check-table-grants.mjs                          # gate: exit 1 on a NEW violation
 *   node scripts/check-table-grants.mjs --strict                 # exit 1 on ANY violation
 *   node scripts/check-table-grants.mjs --baseline                # record today's violations
 *   node scripts/check-table-grants.mjs --witness SellerReferenceLabel
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const require = createRequire(join(ROOT, 'package.json'))
const pg = require('pg')

const BASELINE = join(ROOT, 'scripts/table-grants-baseline.json')
const SCHEMA = join(ROOT, 'packages/database/prisma/schema.prisma')
const ISOLATION = join(ROOT, 'packages/database/prisma/migrations/20260908b_workspace_data_isolation/migration.sql')
const ROLE = 'nexus_workspace_runtime'
const POLICY = 'nexus_workspace_isolation'
const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE']
const EXPECTED_DATABASE = 'nexus_development'

const argv = process.argv.slice(2)
const strict = argv.includes('--strict')
const writeBaseline = argv.includes('--baseline')
const witness = argv[argv.indexOf('--witness') + 1]
const witnessed = argv.includes('--witness') && witness && !witness.startsWith('--') ? witness : null

const fail = (message) => { console.error(`✗ ${message}`); process.exit(1) }

/* ── 1 · the tables to check, derived from the schema ──────────────────────────────────────── */
const schema = readFileSync(SCHEMA, 'utf8')
/** `model X { … }` — `[\s\S]*?` up to a line that is exactly `}`, which is how prisma formats. */
const models = [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)].map(([, model, body]) => ({
  model,
  table: body.match(/^\s*@@map\("([^"]+)"\)/m)?.[1] ?? model,
  // A `workspaceId` FIELD, not the word anywhere: `@relation(fields: [workspaceId])` on a child of
  // a scoped model does not make the child scoped, and a comment mentioning it makes nothing true.
  workspaceScoped: /^\s*workspaceId\s+\S/m.test(body),
}))
if (models.length < 100) fail(`only ${models.length} models parsed out of ${SCHEMA} — the parser, not the schema, is wrong`)

/* ── 2 · what each table needs, derived from the isolation migration ──────────────────────── */
const isolation = readFileSync(ISOLATION, 'utf8')
const required = new Map()
for (const [, list, table] of isolation.matchAll(/^GRANT\s+([A-Z, ]+?)\s+ON\s+(?:TABLE\s+)?"([^"]+)"\s+TO\s+nexus_workspace_runtime/gm)) {
  const set = required.get(table) ?? new Set()
  for (const privilege of list.split(',')) set.add(privilege.trim())
  required.set(table, set)
}
for (const [, list, table] of isolation.matchAll(/^REVOKE\s+([A-Z, ]+?)\s+ON\s+(?:TABLE\s+)?"([^"]+)"\s+FROM\s+nexus_workspace_runtime/gm)) {
  const set = required.get(table)
  if (set) for (const privilege of list.split(',')) set.delete(privilege.trim())
}
const rlsInMigration = new Set([...isolation.matchAll(/ALTER TABLE "([^"]+)" ENABLE ROW LEVEL SECURITY/g)].map(([, table]) => table))
if (required.size < 100 || rlsInMigration.size < 100) fail(`the isolation migration parsed as ${required.size} grants / ${rlsInMigration.size} RLS tables — the parser is wrong`)

const needs = (entry) => ({
  privileges: [...(required.get(entry.table) ?? new Set(PRIVILEGES))].sort(),
  // In the migration → the migration already ruled. Added later → the schema rules: workspace-scoped
  // data carries the policy. A table with no `workspaceId` has nothing to scope BY.
  policy: required.has(entry.table) ? rlsInMigration.has(entry.table) : entry.workspaceScoped,
})

/* ── 3 · the database, NAMED before it is measured ────────────────────────────────────────── */
const apiEnv = readFileSync(join(ROOT, 'apps/api/.env'), 'utf8')
const raw = apiEnv.match(/^\s*DATABASE_URL\s*=\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '')
if (!raw) fail('apps/api/.env carries no DATABASE_URL — this gate reads that file and nothing else')
const url = raw.replace('-pooler', '')
const host = (() => { try { return new URL(url).host } catch { return '(unparseable)' } })()
if (/neon\.tech/i.test(url)) fail(`REFUSED: ${host} is a Neon host. This gate creates and rolls back a probe table; it runs on the LOCAL database only.`)

const client = new pg.Client({ connectionString: url })
await client.connect()
const identity = (await client.query('SELECT current_database() AS database, current_user AS role, version() AS version')).rows[0]
console.log(`database: ${identity.database} @ ${host} as ${identity.role}`)
if (identity.database !== EXPECTED_DATABASE) {
  await client.end()
  fail(`REFUSED: current_database() is "${identity.database}", not "${EXPECTED_DATABASE}"`)
}
if ((await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [ROLE])).rowCount !== 1) {
  await client.end()
  fail(`the role ${ROLE} does not exist on ${identity.database} — the isolation migration has not been applied here, so this gate can measure nothing`)
}

/**
 * One reading for every regular table in `public`, plus the privileges of the runtime role and
 * whether the isolation policy exists FOR THAT ROLE. `has_table_privilege` is the honest instrument:
 * it answers "can the role do this", which is the question `42501` asked, including privileges the
 * role holds through membership — `information_schema.role_table_grants` only lists direct grantees
 * and would have called an inherited privilege missing.
 */
const read = async () => {
  const { rows } = await client.query(`
    SELECT c.relname AS table,
           c.relrowsecurity AS rls,
           c.relforcerowsecurity AS forced,
           ${PRIVILEGES.map((p) => `has_table_privilege($1, c.oid, '${p}') AS "${p}"`).join(', ')},
           EXISTS (
             SELECT 1 FROM pg_policy p
              WHERE p.polrelid = c.oid AND p.polname = $2
                AND $1::regrole = ANY (p.polroles)
           ) AS policy
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'`, [ROLE, POLICY])
  return new Map(rows.map((row) => [row.table, row]))
}

/** The ONE predicate. The probe table below is judged by this same function, or it proves nothing. */
const violationsFor = (entry, row) => {
  const need = needs(entry)
  const out = []
  const missing = need.privileges.filter((privilege) => !row[privilege])
  if (missing.length) out.push(`${entry.table}: ${ROLE} lacks ${missing.join(', ')} (needs ${need.privileges.join(', ')}) — a routed query answers 42501, and a try/catch turns that into silence`)
  if (need.policy && !row.rls) out.push(`${entry.table}: row-level security is NOT enabled, and the table carries workspaceId — a routed read returns every workspace's rows`)
  else if (need.policy && !row.policy) out.push(`${entry.table}: row-level security is enabled but no ${POLICY} policy applies to ${ROLE} — every routed read returns 0 rows`)
  return out
}

/* ── 4 · the NEGATIVE arm, in this run, inside a transaction that is rolled back ──────────── */
const probe = `_close1_grant_probe_${process.pid}`
await client.query('BEGIN')
await client.query(`CREATE TABLE "${probe}" ("id" text PRIMARY KEY, "workspaceId" text NOT NULL)`)
const probeRow = (await read()).get(probe)
const probeViolations = probeRow ? violationsFor({ table: probe, workspaceScoped: true }, probeRow) : []
await client.query('ROLLBACK')
const probeGone = (await client.query(`SELECT to_regclass($1) AS still_there`, [`public.${probe}`])).rows[0].still_there === null
console.log(`instrument control — a grant-less, policy-less table with workspaceId: ${probeViolations.length} violation(s) reported, table dropped: ${probeGone}`)
for (const violation of probeViolations) console.log(`  control fired: ${violation}`)
if (probeViolations.length !== 2 || !probeGone) {
  await client.end()
  fail(`the control did not fire on a table that is WRONG in both ways (expected 2 violations and a dropped table, got ${probeViolations.length} and dropped=${probeGone}) — this run's "0 violations" would prove nothing`)
}

/* ── 5 · every real table ────────────────────────────────────────────────────────────────── */
const rows = await read()
const present = models.filter((entry) => rows.has(entry.table))
const absent = models.filter((entry) => !rows.has(entry.table))
const violations = present.flatMap((entry) => violationsFor(entry, rows.get(entry.table)))
const passing = present.filter((entry) => violationsFor(entry, rows.get(entry.table)).length === 0)
const unknown = [...rows.keys()].filter((table) => !models.some((entry) => entry.table === table) && table !== '_prisma_migrations').sort()
const forcedGap = present.filter((entry) => rows.get(entry.table).rls && !rows.get(entry.table).forced).map((entry) => entry.table)
await client.end()

console.log(`R-LX-28 table-grant gate: ${models.length} models · ${present.length} tables on this database · ${passing.length} pass every arm · ${violations.length} violation(s)`)
if (absent.length) console.log(`  ${absent.length} model(s) have no table here (not judged): ${absent.map((e) => e.table).slice(0, 12).join(', ')}${absent.length > 12 ? ' …' : ''}`)
if (unknown.length) console.log(`  ${unknown.length} table(s) on the database with no model (not judged): ${unknown.join(', ')}`)
if (forcedGap.length) console.log(`  note, not a failure: RLS enabled WITHOUT FORCE on ${forcedGap.join(', ')} — ${ROLE} is NOBYPASSRLS so ENABLE binds it; FORCE binds the table OWNER, and it is what 20260908b does on all ${rlsInMigration.size} of its tables. An Owner call, not this gate's.`)
if (witnessed) {
  const entry = models.find((e) => e.table === witnessed)
  const row = rows.get(witnessed)
  if (!entry) console.log(`  witness ${witnessed}: NO SUCH MODEL in schema.prisma`)
  else if (!row) console.log(`  witness ${witnessed}: the model exists, the table does not`)
  else console.log(`  witness ${witnessed}: needs ${needs(entry).privileges.join('/')}${needs(entry).policy ? ' + policy' : ' (no policy required)'} · has ${PRIVILEGES.filter((p) => row[p]).join('/') || 'nothing'} · rls=${row.rls} forced=${row.forced} policy=${row.policy} → ${violationsFor(entry, row).length === 0 ? 'PASSES' : 'FAILS'}`)
}
// A predicate nothing can satisfy also reports "0 new violations" once every offender is baselined.
if (passing.length === 0) fail(`not one of ${present.length} tables passes the predicate — the requirement, not the database, is wrong`)

if (writeBaseline) {
  writeFileSync(BASELINE, JSON.stringify({ recorded: new Date().toISOString().slice(0, 10), by: 'scripts/check-table-grants.mjs --baseline', violations }, null, 2) + '\n')
  console.log(`baseline written: ${violations.length} known violation(s)`)
  process.exit(0)
}
let baseline = []
try { baseline = JSON.parse(readFileSync(BASELINE, 'utf8')).violations ?? [] } catch { baseline = [] }
const known = new Set(strict ? [] : baseline)
const fresh = violations.filter((violation) => !known.has(violation))
const carried = violations.filter((violation) => known.has(violation))
const cleared = baseline.filter((violation) => !violations.includes(violation))
// Loud on every run, green or not: a baselined isolation gap is a decision someone owes an answer
// for, not a fact that has been dealt with.
for (const violation of carried) console.log(`  carried by the baseline (still true): ${violation}`)
if (cleared.length) console.log(`${cleared.length} baseline violation(s) now fixed — rerun with --baseline to tighten`)
for (const violation of fresh) console.error(`✗ ${violation}`)
if (fresh.length) {
  console.error(`End a new table's migration the way 20260912_lx5_readiness_index and 20260911_category_taxonomies do: GRANT ${PRIVILEGES.join(', ')} TO ${ROLE}, and for workspace-scoped data ENABLE ROW LEVEL SECURITY plus the ${POLICY} policy.`)
  process.exit(1)
}
console.log(`${carried.length} known violation(s) carried by the baseline; 0 new.`)
process.exit(0)
