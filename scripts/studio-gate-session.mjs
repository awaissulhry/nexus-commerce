#!/usr/bin/env node
/**
 * THE signed-in session every browser gate runs inside. Ruling R-GATE-1 (2026-09-13).
 *
 *   node scripts/studio-gate-session.mjs -- node scripts/check-editor-open.mjs --strict
 *   node scripts/studio-gate-session.mjs -- node scripts/check-control-census.mjs
 *   node scripts/studio-gate-session.mjs -- node scripts/check-layout-v2.mjs
 *   node scripts/studio-gate-session.mjs --role OPS_MANAGER -- node scripts/check-editor-open.mjs
 *
 * ## The role, and why it is BUILT rather than borrowed
 *
 * VT.3 measured the first version refusing `/channels/mapping` with "Access denied". Derived, not
 * guessed — `apps/web/src/lib/auth/nav-permissions.ts` is the map `PageGuard` reads, and the pages
 * the gates visit need `pages.products` (`/products/**`, the studio and `/products/next`),
 * `pages.listings` (`/listings/**`) and `pages.settings` (`/channels/mapping`) — then measured
 * against the roles that exist on this database:
 *
 *     ADMIN        135 perms · requireMfa TRUE   → has everything, cannot sign in without MFA
 *     OPS_MANAGER   95 perms · requireMfa false  → missing exactly `pages.settings`  ← VT.3's refusal
 *     FULFILLMENT   29 · VIEWER 27               → missing settings, pim.manage, products.edit
 *     OWNER          0 (implicit elsewhere) · FINANCE 33
 *
 * So no existing role opens every page without MFA. This creates a DISPOSABLE role whose permission
 * list is DERIVED from the database — the widest non-MFA role's own list, plus every `pages.*` that
 * any role carries — and deletes it with the user. Nothing is hand-listed, so a permission added to
 * the product tomorrow is picked up without editing this file. `--role KEY` uses an existing role
 * instead, for a lane that wants to measure what a narrower operator sees.
 *
 * ## Why this exists
 *
 * `check-editor-open`, `check-control-census` and `check-layout-v2` all refuse without a signed-in
 * studio session, and EVERY lane in this programme has held them for want of one — which turns three
 * gates into three "could not measure" lines, and a gate that never runs is worse than no gate,
 * because its absence reads as a pass. R-GATE-1: *"could not run, no session" is no longer an
 * accepted gate result for any lane.*
 *
 * Extracted from LX's `docs/audits/2026-09-12-language-axis/step6/authenticated-gate.mjs`, which
 * proved the shape. That script is left exactly as it is; this is the reusable half of it, with one
 * deliberate difference: **it DELETES the user afterwards** rather than keeping a receipt and reusing
 * it, so nothing durable is created on anyone's database by running a gate.
 *
 * ## What it does, and the four things it refuses to do
 *
 * 1. **`nexus_development` ONLY.** It reads `apps/api/.env`'s `DATABASE_URL`, connects, and asserts
 *    `current_database() = 'nexus_development'` before it writes anything. Pointed at Neon it stops.
 *    `reference_which_database_is_this_api_on` is the reason the check is a query and not a substring
 *    match on the URL — both databases have held 338 products, and only the server can say which one
 *    answered.
 * 2. **Alone.** It refuses to start while another `check-editor-open` / `check-layout-v2` /
 *    `check-control-census` **or another `studio-gate-session`** is running. Two browser gates on one
 *    dev server measure each other's interference and both readings are worthless. Authority: a LOCK
 *    FILE (`.studio-gate-session.lock`, released in the `finally`), because `ps` cannot see a peer that
 *    is between two child processes. The process view is an additional reading and it excludes this pid
 *    and its ancestors BY PID, never by name — see `scripts/lib/gate-aloneness.mjs` for why the first
 *    version was blind to exactly the peer it needed to see (VT.F item A8).
 * 3. **Credentials never touch the disk.** The email and the password are generated here, live in
 *    memory, reach the child ONLY through its environment, and every byte the child prints is
 *    filtered through a redactor before it reaches this process's stdout or any log. The password is
 *    never echoed, never written to a receipt, and never persisted.
 * 4. **The user is removed in a `finally`.** Not on the happy path — in a `finally`, so a crashing
 *    gate, a failing gate and a Ctrl-C all still clean up. The removal is verified by re-reading the
 *    row, and if it survives, the wrapper says so loudly rather than exiting quietly.
 *
 * The account is a DISPOSABLE LOCAL TEST FIXTURE on a development database. It is not anyone's real
 * account, it authenticates against nothing outside this machine, and it exists for the seconds a
 * gate takes to run.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { Client } from 'pg'
import { tsImport } from 'tsx/esm/api'
import { otherGateProcesses, readPs, gateProcessWitness, acquireGateLock, releaseGateLock } from './lib/gate-aloneness.mjs'

const ROOT = new URL('..', import.meta.url)
const LOCAL_DB = 'nexus_development'
/**
 * One well-known path, so two wrappers started from different shells contend for the SAME lock. It
 * lives in the OS temp dir, keyed by this checkout's path, rather than in the repo: this tree is shared
 * by every concurrent lane and NOTHING is committed, so a lock left behind by a SIGKILLed run must not
 * appear as an untracked file in anyone's `git status`. The refusal message prints the full path.
 */
const LOCK = join(tmpdir(), `nexus-studio-gate-${createHash('sha1').update(ROOT.pathname).digest('hex').slice(0, 12)}.lock`)

const argv = process.argv.slice(2)
const dashdash = argv.indexOf('--')
const flags = dashdash === -1 ? [] : argv.slice(0, dashdash)
const roleFlag = flags.includes('--role') ? flags[flags.indexOf('--role') + 1] : null
const command = dashdash === -1 ? argv : argv.slice(dashdash + 1)
if (command.length === 0) {
  console.error('Usage: node scripts/studio-gate-session.mjs -- <gate command…>')
  console.error('   e.g. node scripts/studio-gate-session.mjs -- node scripts/check-editor-open.mjs --strict')
  process.exit(64)
}

/** `DATABASE_URL` from `apps/api/.env` — the same file the API itself reads, never a guess. */
function localDatabaseUrl() {
  const env = readFileSync(new URL('apps/api/.env', ROOT), 'utf8')
  const line = env.split('\n').find((l) => l.startsWith('DATABASE_URL='))
  assert.ok(line, 'apps/api/.env carries no DATABASE_URL')
  return line.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '')
}

/**
 * 🔴 The ONE guard against two browser gates racing — VT.F item A8, rewritten on measurements.
 *
 * The first version matched the gate SCRIPT names in `ps` and then dropped every line containing
 * `studio-gate-session.mjs`, because the shell that launched this wrapper repeats the gate command in
 * its own argv and the guard fired on its own caller. That name exclusion also hid every OTHER
 * wrapper — the one process it most needed to see. Both arms were measured on 2026-09-13: VT.3b's
 * census reading was taken while VT.2c's wrapper was open (tainted, discarded, re-run), and VT.4b had
 * two `studio-gate-session` processes alive at 10:04.
 *
 * Now: (a) the process view excludes THIS pid and its ANCESTORS by pid, never by name, so a peer
 * wrapper is a finding; (b) a LOCK FILE is the authority, because `ps` cannot see a peer that is
 * between two child processes — a wrapper inside its own DB setup owns the dev server just as much;
 * (c) `pgrep -fc 'node scripts/'` is printed as the WITNESS and never as the judge, since it counts
 * this very process.
 */
function assertAlone() {
  const others = otherGateProcesses(readPs(), { selfPid: process.pid })
  const witness = gateProcessWitness()
  console.log(
    `studio-gate-session: aloneness — ${others.length} peer gate process(es); ` +
      `pgrep -f 'node scripts/' counted ${witness} (this process included, so ≥1 or the view is blind)`,
  )
  assert.equal(
    others.length,
    0,
    `Another browser gate is running — a gate must run ALONE:\n${others.map((o) => `  pid ${o.pid} · ${o.args}`).join('\n')}`,
  )
  /* 🔴 A witness below 1 from inside a `node scripts/…` process cannot be true: the instrument is
     blind and the emptiness above proves nothing (`could not measure` vs `measured empty`). `>= 1`,
     not `!== 0`, because a pgrep that errored answers `null` and `null !== 0` is true. */
  assert.ok(
    typeof witness === 'number' && witness >= 1,
    `pgrep cannot see this process (witness ${witness}) — the aloneness reading is not trustworthy`,
  )
  const { note } = acquireGateLock(LOCK, { command: command.join(' ') })
  lockHeld = true
  console.log(`studio-gate-session: lock taken at ${LOCK} — ${note}`)
}

const url = localDatabaseUrl()
const client = new Client({ connectionString: url })

const email = `vt-gate-${randomBytes(12).toString('hex')}@example.test`
const password = randomBytes(36).toString('base64url')
/** Every secret this process knows, for the redactor. `passwordHash` joins it once it exists. */
const secrets = [email, password]
const redact = (text) => secrets.reduce((s, v) => (v ? s.split(v).join('[redacted]') : s), String(text))

let userId = null
let roleId = null
let lockHeld = false
let connected = false
let exitCode = 1

try {
  assertAlone()
  await client.connect()
  connected = true

  const db = (await client.query('SELECT current_database() AS name')).rows[0].name
  assert.equal(db, LOCAL_DB, `Refusing: connected to "${db}", and this wrapper only ever writes to "${LOCAL_DB}"`)

  /* The role and the workspace are the ONES THAT EXIST — never invented. An operator role with
     `requireMfa` would make the gate's own sign-in impossible, so that is part of the query. */
  let role
  if (roleFlag) {
    role = (await client.query('SELECT id,key,"requireMfa" FROM "Role" WHERE key=$1', [roleFlag])).rows[0]
    assert.ok(role, `No role "${roleFlag}" on this database`)
    assert.equal(role.requireMfa, false, `Role "${roleFlag}" requires MFA — the gate cannot sign in as it`)
  } else {
    /* DERIVED: the widest non-MFA role's own permissions, plus every `pages.*` any role carries —
       which is what adds the `pages.settings` OPS_MANAGER lacks. No hand-written list. */
    const rows = (await client.query('SELECT key,permissions,"requireMfa" FROM "Role"')).rows
    const listOf = (r) => (Array.isArray(r.permissions) ? r.permissions : (r.permissions?.list ?? []))
    const widestOpen = rows.filter((r) => !r.requireMfa).sort((a, b) => listOf(b).length - listOf(a).length)[0]
    assert.ok(widestOpen, 'No role on this database can sign in without MFA')
    const pages = [...new Set(rows.flatMap(listOf).filter((p) => typeof p === 'string' && p.startsWith('pages.')))]
    const permissions = [...new Set([...listOf(widestOpen), ...pages])]
    assert.ok(permissions.includes('pages.settings'), 'Derived gate permissions still lack pages.settings')
    roleId = `vtgate_role_${randomUUID()}`
    await client.query(
      /* `Role.permissions` is `text[]`, measured — not jsonb. `pg` maps a JS array to it directly. */
      'INSERT INTO "Role" (id,key,name,description,permissions,"isSystem","requireMfa","updatedAt","createdAt") VALUES ($1,$2,$3,$4,$5,false,false,now(),now())',
      [roleId, `VT_GATE_${roleId.slice(-8)}`, 'Studio gate session', 'Disposable; created and deleted by scripts/studio-gate-session.mjs', permissions],
    )
    role = { id: roleId }
    console.log(`studio-gate-session: disposable role from ${widestOpen.key} + ${pages.length} page permissions = ${permissions.length} total`)
  }

  const workspace = (await client.query(
    'SELECT "workspaceId" FROM "Product" WHERE "workspaceId" IS NOT NULL GROUP BY "workspaceId" ORDER BY count(*) DESC LIMIT 1',
  )).rows[0]
  assert.ok(workspace, 'No workspace with products on this database — the gates need a sheet to read')

  const { hashPassword, checkPasswordStrength } = await tsImport(
    new URL('apps/api/src/lib/auth/password.ts', ROOT).pathname,
    import.meta.url,
  )
  /* A generated password the app's own policy would reject is a sign-in that fails for a reason
     nobody would look for. Asserted here rather than discovered in the gate's output. */
  if (typeof checkPasswordStrength === 'function') {
    assert.equal(checkPasswordStrength(password, [email]).ok, true, 'Generated password fails the app policy')
  }
  const passwordHash = await hashPassword(password)
  secrets.push(passwordHash)

  userId = `vtgate_${randomUUID()}`
  const memberId = `vtgate_member_${randomUUID()}`
  await client.query('BEGIN')
  await client.query(
    'INSERT INTO "UserProfile" (id,email,"displayName","passwordHash",status,"updatedAt") VALUES ($1,$2,$3,$4,$5,now())',
    [userId, email, 'Studio gate session', passwordHash, 'active'],
  )
  await client.query(
    'INSERT INTO "WorkspaceMembership" (id,"workspaceId","userId",status,"updatedAt") VALUES ($1,$2,$3,$4,now())',
    [memberId, workspace.workspaceId, userId, 'active'],
  )
  await client.query('INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)', [memberId, role.id])
  await client.query(
    'INSERT INTO "UserRole" (id,"userId","roleId") VALUES ($1,$2,$3) ON CONFLICT ("userId","roleId") DO NOTHING',
    [`vtgate_role_${randomUUID()}`, userId, role.id],
  )
  await client.query('UPDATE "UserProfile" SET "permissionsVersion"="permissionsVersion"+1 WHERE id=$1', [userId])
  await client.query('COMMIT')
  console.log(`studio-gate-session: disposable user created on ${LOCAL_DB} (id ${userId}); credentials stay in memory`)

  const env = { ...process.env, STUDIO_TEST_EMAIL: email, STUDIO_TEST_PASSWORD: password }
  /* A stale storage state would silently win over the credentials above and the gate would measure
     somebody else's session — the "wrong instrument, confident reading" shape. */
  for (const key of ['STUDIO_STORAGE_STATE', 'CENSUS_STORAGE_STATE']) delete env[key]
  env.STUDIO_API_BASE ??= 'http://localhost:8091'
  env.EDITOR_BASE ??= 'http://localhost:3000'
  env.EDITOR_API ??= 'http://localhost:8091'
  env.CENSUS_BASE ??= 'http://localhost:3000'

  console.log(`studio-gate-session: running \`${command.join(' ')}\``)
  const child = spawn(command[0], command.slice(1), { cwd: ROOT.pathname, env, stdio: ['ignore', 'pipe', 'pipe'] })
  /* 🔴 EVERY byte the child prints goes through the redactor. A gate that echoed its own
     `STUDIO_TEST_PASSWORD` into a log a lane then pasted into the ledger is the failure this
     one line prevents. */
  child.stdout.on('data', (d) => process.stdout.write(redact(d)))
  child.stderr.on('data', (d) => process.stderr.write(redact(d)))
  exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)))
  })
  console.log(`studio-gate-session: gate exited ${exitCode}`)
} catch (error) {
  /* 🔴 Only roll back a connection that EXISTS. `pg`'s `query()` on a client that never connected
     never settles — so the first failure here (the guard above refusing its own shell) exited 13
     "unsettled top-level await" and printed nothing about the actual cause. */
  if (connected) await client.query('ROLLBACK').catch(() => {})
  console.error(`studio-gate-session: ${redact(error?.message ?? error)}`)
  exitCode = 1
} finally {
  /* 🔴 In a `finally`, and it VERIFIES. A cleanup that runs only on the happy path leaves an
     account behind on exactly the runs that went wrong. */
  if (userId && connected) {
    try {
      await client.query('DELETE FROM "UserRole" WHERE "userId"=$1', [userId])
      await client.query(
        'DELETE FROM "WorkspaceMemberRole" WHERE "membershipId" IN (SELECT id FROM "WorkspaceMembership" WHERE "userId"=$1)',
        [userId],
      )
      await client.query('DELETE FROM "WorkspaceMembership" WHERE "userId"=$1', [userId])
      await client.query('DELETE FROM "UserProfile" WHERE id=$1', [userId])
      if (roleId) await client.query('DELETE FROM "Role" WHERE id=$1', [roleId])
      const left = (await client.query('SELECT id FROM "UserProfile" WHERE id=$1', [userId])).rowCount
      const roleLeft = roleId ? (await client.query('SELECT id FROM "Role" WHERE id=$1', [roleId])).rowCount : 0
      if (roleLeft > 0) console.error(`🔴 studio-gate-session: role ${roleId} SURVIVED cleanup — remove it by hand`)
      if (left === 0) console.log(`studio-gate-session: disposable user ${userId}${roleId ? ` and role ${roleId}` : ''} removed (verified)`)
      else console.error(`🔴 studio-gate-session: user ${userId} SURVIVED cleanup — remove it by hand`)
    } catch (error) {
      console.error(`🔴 studio-gate-session: cleanup failed for ${userId}: ${redact(error?.message ?? error)}`)
    }
  }
  if (connected) await client.end().catch(() => {})
  /* 🔴 The lock goes back in the SAME `finally` as the user, for the same reason: a crashing or
     Ctrl-C'd run must not wedge every other lane's gate. `releaseGateLock` removes only OUR record. */
  if (lockHeld) console.log(`studio-gate-session: lock ${releaseGateLock(LOCK)}`)
}

process.exit(exitCode)
