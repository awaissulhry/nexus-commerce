/**
 * 🔴🔴 R-VT-12 — the API test suite REFUSES a production database before the first connection.
 *
 * ## The hazard, measured by VT.F on 2026-09-13 and re-measured by VT.F2 (env read only, no connection)
 *
 * `apps/api/src/env.ts` loads dotenv NON-OVERRIDING, twice: `config()` (the process CWD's `.env`) and then the
 * repo-root `.env`. First wins, so the answer to "which database does this process talk to" is decided by the
 * CWD — and by an exported `DATABASE_URL` before that:
 *
 *     cwd = apps/api    (how `:8091` is started)                     → 127.0.0.1:55439 / nexus_development
 *     cwd = repo root   (how every lane ran `npx vitest --root apps/api`) → ep-purple-river-…neon.tech / neondb
 *
 * The second line is **Neon production**. Every DB-backed API vitest arm in the VT programme measured (or would
 * have written) production while its author believed it measured local Docker. Nothing was damaged only because
 * the connection failed — luck, not design (`project_neon_credential_exposed_in_git`).
 *
 * ## What this module does, and the one thing it deliberately does NOT do
 *
 * It answers two SEPARATE questions and keeps them separate, because conflating them is how the hazard hid:
 *
 *  1. **What would this process have talked to?** (`resolveDatabaseUrlLikeEnvTs`) — the env.ts resolution order,
 *     reproduced. If that is a production target the run is REFUSED with a sentence naming the host, so the
 *     author of the command learns their command was wrong instead of reading a green run as a local one.
 *  2. **What will it talk to now?** (`pinnedTestDatabaseUrl`) — `apps/api/.env`'s own URL, pinned into
 *     `process.env.DATABASE_URL` regardless of CWD, so the suite STATES its target rather than inheriting it
 *     from whichever directory the command was typed in.
 *
 * It does **not** weaken `apps/api/src/env.ts`. That file decides the database for the running API `:8091`,
 * which other sessions are using; the guard is scoped to the vitest setup.
 *
 * ## Why a URL check is acceptable here when the banked rule says DISCRIMINATE, never infer
 *
 * Because it only ever REFUSES (`reference_which_database_is_this_api_on`). A URL is a weak confirmation
 * ("it says local, therefore it is") and a strong refusal ("it does not say local, so I will not connect and
 * find out"). Over-caution is the only error it can make. Past the guard, an arm still takes the server's own
 * `current_database()` as its discriminator — that rule is unchanged.
 *
 * Deliberate escape hatch: `ALLOW_PROD_DB_TESTS=1`. It is never silent — the message names the host it let past.
 */

/** Hosts a test run may query. Anything else is refused before a connection is opened. */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** The one database this repo's local Docker container serves, plus any disposable test database. */
const DEVELOPMENT_DATABASE = 'nexus_development'

/** The environment variable that lets a human aim the suite at a non-local database on purpose. */
export const ALLOW_PROD_DB_TESTS = 'ALLOW_PROD_DB_TESTS'

export interface DotenvCandidate {
  /** Where this `.env` lives, printed verbatim in the refusal so the reader can open it. */
  path: string
  /** Its `DATABASE_URL`, or undefined when the file is absent or does not set one. */
  databaseUrl: string | undefined
}

export interface ResolvedDatabaseTarget {
  url: string | undefined
  /** `'process-env'` = an exported variable (deliberate); otherwise the `.env` path that won; `'none'` = nothing set it. */
  from: string
}

/**
 * PURE. The resolution `apps/api/src/env.ts` produces: an exported `DATABASE_URL` wins (dotenv is
 * non-overriding), then the first candidate `.env` that sets one, in the order given.
 *
 * At vitest SETUP time `process.env.DATABASE_URL` can only have come from the shell, because no `.env` has been
 * loaded yet — `env.ts` runs at the first import of `db.ts`, which is after this. That is what makes an ambient
 * value readable as DELIBERATE and a `.env` value readable as inherited.
 */
export function resolveDatabaseUrlLikeEnvTs(input: {
  ambient: string | undefined
  candidates: DotenvCandidate[]
}): ResolvedDatabaseTarget {
  if (input.ambient && input.ambient.trim()) return { url: input.ambient, from: 'process-env' }
  for (const candidate of input.candidates) {
    if (candidate.databaseUrl && candidate.databaseUrl.trim()) return { url: candidate.databaseUrl, from: candidate.path }
  }
  return { url: undefined, from: 'none' }
}

export interface DatabaseTargetVerdict {
  allowed: boolean
  /** The sentence a refusal prints. Empty when allowed. */
  reason: string
  host: string
  database: string
  /** True when the host is one this repo knows to be production hosting (Neon). */
  looksLikeProduction: boolean
}

/**
 * PURE. May a test run talk to this URL? Opens nothing.
 *
 * 🔴 NO default value for `url`. A `= process.env.DATABASE_URL` default (the shape VT.F had to remove from its
 * own helper) makes the arm meant to prove "an absent URL is refused" pass for the wrong reason on a machine
 * that has one — a test that cannot fail. The caller states the URL.
 */
export function testDatabaseVerdict(url: string | undefined): DatabaseTargetVerdict {
  if (!url || !url.trim()) {
    return { allowed: false, reason: 'DATABASE_URL is not set, so there is no database this run could name.', host: '', database: '', looksLikeProduction: false }
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { allowed: false, reason: 'DATABASE_URL does not parse as a URL, so which database it names cannot be established.', host: '', database: '', looksLikeProduction: false }
  }
  const host = parsed.hostname
  const database = parsed.pathname.replace(/^\//, '')
  const looksLikeProduction = /(^|\.)neon\.tech$/i.test(host)
  if (!LOCAL_HOSTS.has(host)) {
    return {
      allowed: false,
      host,
      database,
      looksLikeProduction,
      reason: looksLikeProduction
        ? `REFUSED: this run would talk to "${host}" (database "${database}") — that is Neon PRODUCTION.`
        : `REFUSED: this run would talk to "${host}" (database "${database}"), which is not a local host.`,
    }
  }
  if (database !== DEVELOPMENT_DATABASE && !/test/i.test(database)) {
    return {
      allowed: false,
      host,
      database,
      looksLikeProduction,
      reason: `REFUSED: "${host}" is local but database "${database}" is neither "${DEVELOPMENT_DATABASE}" nor a disposable test database.`,
    }
  }
  return { allowed: true, reason: '', host, database, looksLikeProduction }
}

export type GuardAction = 'refused' | 'pinned' | 'kept-ambient' | 'allowed-by-flag'

export interface GuardOutcome {
  action: GuardAction
  /** One line, printed by the setup file on every run. Names the host in every branch. */
  message: string
  /** The URL the run will use. `undefined` only when refused. */
  url: string | undefined
  host: string
  database: string
}

/**
 * PURE. The whole decision, so both the vitest config (fail fast, once) and the vitest setup (per worker, where
 * the pin has to happen) run the SAME rule rather than two equivalent ones
 * (`reference_write_predicate_must_match_its_readers`).
 */
export function guardTestDatabaseTarget(input: {
  cwd: string
  ambient: string | undefined
  /** The `.env` files, in the order env.ts consults them: `${cwd}/.env`, then the repo-root `.env`. */
  candidates: DotenvCandidate[]
  /** `apps/api/.env`'s own URL — the local target the suite pins, found from this module's location, not the CWD. */
  pinned: DotenvCandidate
  allowProdFlag: string | undefined
}): GuardOutcome {
  const resolved = resolveDatabaseUrlLikeEnvTs({ ambient: input.ambient, candidates: input.candidates })
  const verdict = testDatabaseVerdict(resolved.url)

  if (input.allowProdFlag === '1') {
    return {
      action: 'allowed-by-flag',
      url: resolved.url,
      host: verdict.host,
      database: verdict.database,
      message:
        `${ALLOW_PROD_DB_TESTS}=1 — the database guard is OFF for this run. ` +
        `DATABASE_URL resolves to host "${verdict.host || '(unparseable)'}" (database "${verdict.database}") from ${resolved.from}. ` +
        `Every write this run makes lands there.`,
    }
  }

  if (!verdict.allowed) {
    return {
      action: 'refused',
      url: undefined,
      host: verdict.host,
      database: verdict.database,
      message:
        `${verdict.reason}\n` +
        `  resolved from : ${resolved.from}\n` +
        `  cwd           : ${input.cwd}\n` +
        `  why           : apps/api/src/env.ts loads dotenv NON-OVERRIDING, so the CWD's .env wins — from the repo root that is the root .env (Neon production).\n` +
        `  run it as     : (cd apps/api && npx vitest run <file>)\n` +
        `  or, on purpose: ${ALLOW_PROD_DB_TESTS}=1 npx vitest run … (this is a production database; it is never the right answer for a suite that writes)`,
    }
  }

  if (resolved.from === 'process-env') {
    // An exported DATABASE_URL at setup time can only be deliberate, and it passed the verdict. Pinning over it
    // would redirect a disposable test database to nexus_development behind the author's back.
    return {
      action: 'kept-ambient',
      url: resolved.url,
      host: verdict.host,
      database: verdict.database,
      message: `database target: host "${verdict.host}", database "${verdict.database}" — from an exported DATABASE_URL (kept as stated, not pinned).`,
    }
  }

  const pinnedVerdict = testDatabaseVerdict(input.pinned.databaseUrl)
  if (!pinnedVerdict.allowed) {
    return {
      action: 'refused',
      url: undefined,
      host: pinnedVerdict.host,
      database: pinnedVerdict.database,
      message:
        `${pinnedVerdict.reason}\n` +
        `  this is the URL the suite pins, read from ${input.pinned.path}\n` +
        `  fix that file, or run with ${ALLOW_PROD_DB_TESTS}=1 if you really mean it.`,
    }
  }
  return {
    action: 'pinned',
    url: input.pinned.databaseUrl,
    host: pinnedVerdict.host,
    database: pinnedVerdict.database,
    message: `database target: host "${pinnedVerdict.host}", database "${pinnedVerdict.database}" — pinned from ${input.pinned.path} regardless of CWD (${input.cwd}).`,
  }
}

/** The message every refusal throws with, so the config-level and setup-level refusals read identically. */
export class ProductionDatabaseRefused extends Error {
  constructor(message: string) {
    super(`\n🔴 API tests refused: the database is not local.\n${message}\n`)
    this.name = 'ProductionDatabaseRefused'
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The IO half. Everything above is pure and unit-tested; this reads the two `.env` files and applies the verdict.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseDotenv } from 'dotenv'

/** This module lives at `apps/api/src/lib/testing/`, so `apps/api` is three directories up — never the CWD. */
export const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
export const REPO_ROOT = resolve(API_DIR, '../..')

/** Read one `.env`'s `DATABASE_URL`. An absent file is not an error: it is one candidate that sets nothing. */
export function readDotenvDatabaseUrl(path: string): DotenvCandidate {
  if (!existsSync(path)) return { path, databaseUrl: undefined }
  try {
    return { path, databaseUrl: parseDotenv(readFileSync(path, 'utf8')).DATABASE_URL }
  } catch {
    return { path, databaseUrl: undefined }
  }
}

/**
 * Apply the guard to the real environment: refuse, or pin `process.env.DATABASE_URL`. Returns the outcome so the
 * caller can print it — a guard whose decision is invisible is a guard nobody can check.
 *
 * Called from `apps/api/vitest.config.ts` (fail fast, once, in the main process) and from
 * `apps/api/vitest.setup.ts` (per worker, where the pin has to land before any module imports `db.ts`).
 */
export function applyTestDatabaseGuard(env: Record<string, string | undefined> = process.env, cwd: string = process.cwd()): GuardOutcome {
  const cwdEnvPath = resolve(cwd, '.env')
  const rootEnvPath = resolve(REPO_ROOT, '.env')
  const candidates: DotenvCandidate[] = [readDotenvDatabaseUrl(cwdEnvPath)]
  if (rootEnvPath !== cwdEnvPath) candidates.push(readDotenvDatabaseUrl(rootEnvPath))

  const outcome = guardTestDatabaseTarget({
    cwd,
    ambient: env.DATABASE_URL,
    candidates,
    pinned: readDotenvDatabaseUrl(resolve(API_DIR, '.env')),
    allowProdFlag: env[ALLOW_PROD_DB_TESTS],
  })
  if (outcome.action === 'refused') throw new ProductionDatabaseRefused(outcome.message)
  if (outcome.action === 'pinned' && outcome.url) env.DATABASE_URL = outcome.url
  return outcome
}
