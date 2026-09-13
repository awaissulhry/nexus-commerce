/**
 * R-VT-12 — the API test suite must REFUSE a production database before the first connection.
 *
 * Both arms the ruling names live in this one file:
 *   • the NEGATIVE arm — the repo-root CWD resolution (Neon production) is REFUSED with a sentence naming the host;
 *   • the POSITIVE arm — the `apps/api` CWD resolution is allowed, pinned, and CONNECTS (`current_database()`).
 *
 * The two URLs are read from the REAL `.env` files rather than typed in, so the arms measure the hazard this
 * repo actually has today: a hand-written fixture would pass for ever after someone fixed the files
 * (`reference_fixture_must_be_writer_produced` — ask which writer produced the fixture).
 */

import { afterAll, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import {
  ALLOW_PROD_DB_TESTS,
  API_DIR,
  REPO_ROOT,
  applyTestDatabaseGuard,
  guardTestDatabaseTarget,
  readDotenvDatabaseUrl,
  resolveDatabaseUrlLikeEnvTs,
  testDatabaseVerdict,
} from './database-target.js'
import prisma from '../../db.js'

afterAll(async () => { await prisma.$disconnect().catch(() => {}) })

const ROOT_ENV = readDotenvDatabaseUrl(resolve(REPO_ROOT, '.env'))
const API_ENV = readDotenvDatabaseUrl(resolve(API_DIR, '.env'))
const hostOf = (url: string | undefined) => { try { return new URL(url as string).hostname } catch { return '' } }
const dbOf = (url: string | undefined) => { try { return new URL(url as string).pathname.replace(/^\//, '') } catch { return '' } }

describe('R-VT-12 · the two CWDs, from the real .env files', () => {
  it('the repo-root CWD resolves the ROOT .env — and this repo\'s root .env is a NON-LOCAL host, so it is refused by NAME', () => {
    // The premise, asserted rather than assumed: the root .env sets a DATABASE_URL and it is not local.
    expect(typeof ROOT_ENV.databaseUrl).toBe('string')
    const rootHost = hostOf(ROOT_ENV.databaseUrl)
    expect(rootHost).not.toBe('127.0.0.1')

    const outcome = guardTestDatabaseTarget({
      cwd: REPO_ROOT,
      ambient: undefined,
      candidates: [ROOT_ENV],                        // from the repo root, `${cwd}/.env` IS the root .env
      pinned: API_ENV,
      allowProdFlag: undefined,
    })
    expect(outcome.action).toBe('refused')
    expect(outcome.url).toBeUndefined()
    expect(outcome.host).toBe(rootHost)
    expect(outcome.message).toContain(rootHost)              // the sentence NAMES the host
    expect(outcome.message).toContain(dbOf(ROOT_ENV.databaseUrl))
    expect(outcome.message).toContain('(cd apps/api && npx vitest run')
    if (/neon\.tech$/i.test(rootHost)) expect(outcome.message).toContain('Neon PRODUCTION')
  })

  it('the apps/api CWD resolves the LOCAL .env — allowed, and PINNED so the target is stated, not inherited', () => {
    const outcome = guardTestDatabaseTarget({
      cwd: API_DIR,
      ambient: undefined,
      candidates: [API_ENV, ROOT_ENV],               // env.ts's order: ${cwd}/.env, then the repo-root .env
      pinned: API_ENV,
      allowProdFlag: undefined,
    })
    expect(outcome.action).toBe('pinned')
    expect(outcome.url).toBe(API_ENV.databaseUrl)
    expect(outcome.host).toBe('127.0.0.1')
    expect(outcome.database).toBe('nexus_development')
    expect(outcome.message).toContain('127.0.0.1')
  })

  it('a CWD with no .env of its own falls through to the repo-root .env — the same refusal, from a third directory', () => {
    const outcome = guardTestDatabaseTarget({
      cwd: resolve(REPO_ROOT, 'packages'),
      ambient: undefined,
      candidates: [{ path: resolve(REPO_ROOT, 'packages/.env'), databaseUrl: undefined }, ROOT_ENV],
      pinned: API_ENV,
      allowProdFlag: undefined,
    })
    expect(outcome.action).toBe('refused')
    expect(outcome.message).toContain(hostOf(ROOT_ENV.databaseUrl))
  })

  it(`${ALLOW_PROD_DB_TESTS}=1 lets it past — and is never silent: the message names the host it allowed`, () => {
    const outcome = guardTestDatabaseTarget({
      cwd: REPO_ROOT, ambient: undefined, candidates: [ROOT_ENV], pinned: API_ENV, allowProdFlag: '1',
    })
    expect(outcome.action).toBe('allowed-by-flag')
    expect(outcome.message).toContain(hostOf(ROOT_ENV.databaseUrl))
    expect(outcome.url).toBe(ROOT_ENV.databaseUrl)
  })

  it('an EXPORTED DATABASE_URL is deliberate: a local test database is kept as stated, a production one is still refused', () => {
    const kept = guardTestDatabaseTarget({
      cwd: REPO_ROOT,
      ambient: 'postgresql://postgres:x@127.0.0.1:55439/nexus_vtf2_test',
      candidates: [ROOT_ENV], pinned: API_ENV, allowProdFlag: undefined,
    })
    expect(kept.action).toBe('kept-ambient')
    expect(kept.database).toBe('nexus_vtf2_test')

    // …and the ambient value beats the .env in BOTH directions: a prod export from apps/api is refused too.
    const refused = guardTestDatabaseTarget({
      cwd: API_DIR,
      ambient: 'postgresql://u:p@ep-purple-river-altf6t3y-pooler.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=require',
      candidates: [API_ENV, ROOT_ENV], pinned: API_ENV, allowProdFlag: undefined,
    })
    expect(refused.action).toBe('refused')
    expect(refused.message).toContain('Neon PRODUCTION')
  })
})

describe('resolveDatabaseUrlLikeEnvTs — env.ts\'s order, reproduced', () => {
  it('an exported value wins, then the FIRST .env that sets one, and "none" when nothing does', () => {
    const a = { path: '/a/.env', databaseUrl: 'postgresql://u@127.0.0.1/nexus_development' }
    const b = { path: '/b/.env', databaseUrl: 'postgresql://u@localhost/nexus_development' }
    expect(resolveDatabaseUrlLikeEnvTs({ ambient: 'postgresql://u@127.0.0.1/x_test', candidates: [a, b] }).from).toBe('process-env')
    expect(resolveDatabaseUrlLikeEnvTs({ ambient: undefined, candidates: [a, b] }).from).toBe('/a/.env')
    expect(resolveDatabaseUrlLikeEnvTs({ ambient: undefined, candidates: [{ path: '/a/.env', databaseUrl: undefined }, b] }).from).toBe('/b/.env')
    expect(resolveDatabaseUrlLikeEnvTs({ ambient: '   ', candidates: [] })).toEqual({ url: undefined, from: 'none' })
  })
})

describe('testDatabaseVerdict — it only ever refuses, so a weak confirmation cannot pass as a strong one', () => {
  it('refuses an absent, unparseable, non-local, or wrongly-named database, and allows the two local shapes', () => {
    expect(testDatabaseVerdict(undefined).allowed).toBe(false)
    expect(testDatabaseVerdict('').allowed).toBe(false)
    expect(testDatabaseVerdict('not a url').reason).toContain('does not parse')
    expect(testDatabaseVerdict('postgresql://u:p@db.example.com/nexus_development')).toMatchObject({ allowed: false, looksLikeProduction: false })
    expect(testDatabaseVerdict('postgresql://u:p@x.neon.tech/neondb')).toMatchObject({ allowed: false, looksLikeProduction: true })
    // local host, wrong database — the arm that a host-only check would have let through
    expect(testDatabaseVerdict('postgresql://u:p@127.0.0.1:5432/nexus_production').allowed).toBe(false)
    // the two allowed shapes (the POSITIVE control for every refusal above)
    expect(testDatabaseVerdict('postgresql://u:p@127.0.0.1:55439/nexus_development').allowed).toBe(true)
    expect(testDatabaseVerdict('postgresql://u:p@localhost:55439/vtf2_test_db').allowed).toBe(true)
  })
})

describe('R-VT-12 · the guard is WIRED, not merely defined', () => {
  it('this very run is on the pinned local database — the setup file ran before this file was imported', () => {
    // Assert the TYPE of the witness first: a `null`/undefined reading must not pass an equality check (AAA #12).
    expect(typeof process.env.DATABASE_URL).toBe('string')
    expect(hostOf(process.env.DATABASE_URL)).toBe('127.0.0.1')
    expect(dbOf(process.env.DATABASE_URL)).toBe('nexus_development')
    // Idempotent: applying the guard again in this process reports the same pinned target.
    const again = applyTestDatabaseGuard({ ...process.env }, API_DIR)
    expect(again.action).toBe('kept-ambient')     // it is now an exported value, and it is local: kept as stated
    expect(again.host).toBe('127.0.0.1')
  })

  it('CONNECTS to it, and the server itself names the database (the discriminator, not the URL)', async () => {
    /**
     * 🔴 `current_database()` is Postgres type `name`, and Prisma cannot deserialise it: the first version of
     * this arm printed *"no database — this arm proves nothing"* while the connection had in fact SUCCEEDED
     * (`reference_prisma_invalid_invocation_is_a_prefix` — the invocation line is a prefix, the message under it
     * is the cause). Hence the `::text` cast, and hence an abstention that only ever fires on a CONNECTION
     * error code: a query bug must never be able to read as an absent database
     * (`reference_could_not_measure_vs_measured_empty`).
     */
    const CONNECTION_CODES = new Set(['P1000', 'P1001', 'P1002', 'P1003', 'P1017'])
    const rows = await prisma.$queryRawUnsafe<Array<{ current_database: string; products: number }>>(
      `SELECT current_database()::text AS current_database, (SELECT COUNT(*)::int FROM "Product") AS products`,
    ).catch((error: unknown) => {
      const code = (error as { code?: string })?.code
      if (!code || !CONNECTION_CODES.has(code)) throw error
      console.log(`[VT.F2] no database — this arm proves nothing in this run: ${code}`)
      return null
    })
    if (!rows) { expect.soft('no database reachable — arm abstained out loud').toBe('no database reachable — arm abstained out loud'); return }
    expect(typeof rows[0].current_database).toBe('string')
    expect(rows[0].current_database).toBe('nexus_development')
    // The positive control that the connection really read a catalogue and not an empty shell.
    expect(rows[0].products).toBeGreaterThan(0)
    console.log(`[VT.F2] connected: current_database=${rows[0].current_database}, Product rows=${rows[0].products}`)
  }, 30_000)
})
