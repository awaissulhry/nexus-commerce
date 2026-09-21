/**
 * Gate on the gate (docs/product-cheat/PLAN.md Step 0.1, amendment A-2).
 *
 * The plan's rule: "Prove every gate can fail before you trust its green."
 * So every arm below is paired — a case that MUST refuse, and a positive control that MUST pass.
 * A check that has only ever been seen green is not evidence.
 *
 * 🔴 DATABASE TARGET. The DB-backed arms create a THROWAWAY schema on the LOCAL development
 * Postgres and drop it again. They never touch `public`, and they never touch production:
 * the connection string is read from apps/api/.env (local Docker) and the test refuses outright
 * if the resolved host is not loopback. Both facts are asserted, not assumed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { checkAppliedButMissing, classifyMigrations } from './check-applied-but-missing.mjs'

const row = (name: string, extra: Partial<{ finished_at: Date | null; rolled_back_at: Date | null }> = {}) => ({
  migration_name: name,
  finished_at: extra.finished_at !== undefined ? extra.finished_at : new Date(),
  rolled_back_at: extra.rolled_back_at !== undefined ? extra.rolled_back_at : null,
})

describe('classifyMigrations — the decision, every branch', () => {
  it('REFUSES when the database holds a migration with no folder', () => {
    const r = classifyMigrations([row('20260101_a'), row('20260102_ghost')], ['20260101_a'])
    expect(r.status).toBe('drift')
    expect(r.appliedButMissing).toEqual(['20260102_ghost'])
  })

  it('positive control — PASSES when every applied migration has a folder', () => {
    const r = classifyMigrations([row('20260101_a'), row('20260102_b')], ['20260101_a', '20260102_b'])
    expect(r.status).toBe('ok')
    expect(r.appliedButMissing).toEqual([])
  })

  it('a ROLLED BACK row with no folder is not drift — it was never applied', () => {
    const r = classifyMigrations([row('20260102_ghost', { finished_at: null, rolled_back_at: new Date() })], [])
    expect(r.status).toBe('ok')
    expect(r.counts.rolledBack).toBe(1)
  })

  it("production's real shape: a failed attempt plus a successful sibling is ONE applied migration", () => {
    const r = classifyMigrations(
      [
        row('20260813a_sqp3_rows_changed', { finished_at: null, rolled_back_at: new Date() }),
        row('20260813a_sqp3_rows_changed'),
      ],
      ['20260813a_sqp3_rows_changed'],
    )
    expect(r.status).toBe('ok')
    expect(r.counts.rows).toBe(2)
    expect(r.counts.rolledBack).toBe(1)
  })

  it('an IN-PROGRESS row is reported, and still counts as applied for the drift set', () => {
    const r = classifyMigrations([row('20260102_ghost', { finished_at: null })], [])
    expect(r.inProgress).toEqual(['20260102_ghost'])
    expect(r.status).toBe('drift')
  })

  it('reports pending in the other direction without refusing on it', () => {
    const r = classifyMigrations([row('20260101_a')], ['20260101_a', '20260103_new'])
    expect(r.status).toBe('ok')
    expect(r.pending).toEqual(['20260103_new'])
  })
})

// ── DB-backed arms ────────────────────────────────────────────────
const repoRoot = join(__dirname, '..', '..', '..')
const localUrl = readFileSync(join(repoRoot, 'apps/api/.env'), 'utf8').match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim()
const host = localUrl ? new URL(localUrl).hostname : ''
const isLoopback = host === '127.0.0.1' || host === 'localhost'
const canRun = Boolean(localUrl) && isLoopback
const SCHEMA = 'abm_gate_test'

describe.runIf(canRun)('checkAppliedButMissing — against a throwaway schema', () => {
  let client: pg.Client

  beforeAll(async () => {
    // R-VT-12 in spirit: name the host before the first connection, never assume it.
    expect(isLoopback, `refusing a non-loopback test database: ${host}`).toBe(true)
    client = new pg.Client({ connectionString: localUrl })
    await client.connect()
    const who = await client.query('SELECT current_database() AS d')
    expect(who.rows[0].d).not.toBe('neondb')
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await client.query(`CREATE SCHEMA ${SCHEMA}`)
    await client.query(
      `CREATE TABLE ${SCHEMA}."_prisma_migrations" (
         migration_name TEXT PRIMARY KEY,
         finished_at TIMESTAMPTZ,
         rolled_back_at TIMESTAMPTZ
       )`,
    )
  })

  afterAll(async () => {
    if (!client) return
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await client.end()
  })

  it('positive control — a database holding exactly the repo folders PASSES', async () => {
    await client.query(`TRUNCATE ${SCHEMA}."_prisma_migrations"`)
    const folders = ['20260101_a', '20260102_b']
    for (const f of folders) {
      await client.query(`INSERT INTO ${SCHEMA}."_prisma_migrations" VALUES ($1, now(), NULL)`, [f])
    }
    const r = await checkAppliedButMissing({ connectionString: localUrl!, schema: SCHEMA, migrationsDir: fixtureDir(folders) })
    expect(r.status).toBe('ok')
  })

  it('REFUSES a seeded row that has no folder — the gate goes red', async () => {
    await client.query(
      `INSERT INTO ${SCHEMA}."_prisma_migrations" VALUES ('20991231_hand_applied_ghost', now(), NULL)`,
    )
    const r = await checkAppliedButMissing({ connectionString: localUrl!, schema: SCHEMA, migrationsDir: fixtureDir(['20260101_a', '20260102_b']) })
    expect(r.status).toBe('drift')
    expect(r.appliedButMissing).toEqual(['20991231_hand_applied_ghost'])
  })

  it('a schema with no _prisma_migrations reads as no-history, not as drift', async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA}_empty CASCADE`)
    await client.query(`CREATE SCHEMA ${SCHEMA}_empty`)
    const r = await checkAppliedButMissing({ connectionString: localUrl!, schema: `${SCHEMA}_empty`, migrationsDir: fixtureDir([]) })
    expect(r.status).toBe('no-history')
    await client.query(`DROP SCHEMA ${SCHEMA}_empty CASCADE`)
  })

  it('an unreachable database reads as COULD NOT CHECK, never as no drift', async () => {
    const r = await checkAppliedButMissing({
      connectionString: 'postgresql://nobody:nobody@127.0.0.1:1/none',
      migrationsDir: fixtureDir([]),
    })
    expect(r.status).toBe('unreachable')
    expect(r.appliedButMissing).toEqual([])
  })
})

/** A temp dir of empty folders standing in for prisma/migrations. */
function fixtureDir(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'abm-'))
  for (const n of names) mkdirSync(join(dir, n))
  return dir
}
