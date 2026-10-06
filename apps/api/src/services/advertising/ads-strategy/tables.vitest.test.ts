/**
 * ADS AUTONOMY W1-1 — the two strategy tables (AdsStrategy, AdsStrategyVersion) on a real PostgreSQL with the
 * production schema and every business policy (PGlite), business profiles ON.
 *
 *   isolation   a row one business stores is invisible to another, through Prisma AND raw SQL (row-level security,
 *               not only the client's filter); a business cannot read, change or write into another's rows
 *   one row     one row per (channel, market, level, scope) in a business; the same scope in another business is its
 *               own row; one history row per (strategy, version)
 *   inherit     a new row says nothing until a field is set: every strategy field is null (inherit), the market row
 *               uses the '*' scope, and the business comes from the context
 *   no business with profiles ON, a call without a business is refused
 *
 * Values are made up (public repo).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
const A = 'w1_strategy_alpha'
const B = 'w1_strategy_bravo'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const inB = <T>(work: () => Promise<T>) => withWorkspace(scope(B), work)
const db = () => database.client

const STRATEGY_FIELDS = [
  'goal', 'goalNote', 'targetKind', 'targetPct', 'monthlySpendCapCents', 'minBidCents', 'maxBidCents', 'maxChangePct',
  'maxActionsPerRun', 'protect', 'harvestMinOrders', 'harvestMinClicks', 'harvestMaxAcosPct', 'harvestWindowDays',
  'negateMinClicks', 'negateMinSpendCents', 'negateMaxOrders', 'negateWindowDays', 'stopMethod', 'stopBidCents',
  'claudeAutonomy', 'reviewEveryDays',
] as const

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  for (const id of [A, B]) {
    await database.db.query(
      `INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`,
      [id],
    )
  }
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('W1-1 — the ads strategy tables', () => {
  it('a new market row says nothing yet: every strategy field inherits, the scope is "*", the business is the context', async () => {
    const row = await inA(() => db().adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Test market (IT)', updatedBy: 'user:test' } }))
    expect(row).toMatchObject({ workspaceId: A, channel: 'AMAZON', market: 'IT', level: 'MARKET', scopeId: '*', version: 1 })
    for (const field of STRATEGY_FIELDS) expect(row[field], field).toBeNull()
  })

  it('one row per channel, market, level and scope in a business; another market, level or scope is its own row', async () => {
    await expect(inA(() => db().adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Again', updatedBy: 'user:test' } })))
      .rejects.toMatchObject({ code: 'P2002' })
    await inA(() => db().adsStrategy.create({ data: { market: 'DE', level: 'MARKET', label: 'Test market (DE)', updatedBy: 'user:test' } }))
    await inA(() => db().adsStrategy.create({ data: { market: 'IT', level: 'CATEGORY', scopeId: 'cat_test_1', label: 'Test category (IT)', targetKind: 'ACOS', targetPct: 25, updatedBy: 'user:test' } }))
    await inA(() => db().adsStrategy.create({ data: { market: 'IT', level: 'PRODUCT', scopeId: 'prod_test_1', label: 'TEST-SKU-1 (IT)', maxBidCents: 90, updatedBy: 'user:test' } }))
    // The named key finds the business's own row (scoped-keys.json adds the business to the selector).
    const found = await inA(() => db().adsStrategy.findUnique({
      where: { channel_market_level_scopeId: { channel: 'AMAZON', market: 'IT', level: 'CATEGORY', scopeId: 'cat_test_1' } },
    }))
    expect(found).toMatchObject({ workspaceId: A, targetKind: 'ACOS', targetPct: 25 })
    expect(await inA(() => db().adsStrategy.count({ where: { market: 'IT' } }))).toBe(3)
  })

  it('a row one business stores is invisible to another, through Prisma and through raw SQL', async () => {
    const own = await inA(() => db().adsStrategy.findMany({ select: { id: true } }))
    expect(own.length).toBeGreaterThan(0)
    await inB(async () => {
      expect(await db().adsStrategy.findMany()).toEqual([])
      expect(await db().adsStrategy.findUnique({ where: { id: own[0].id } })).toBeNull()
      expect(await db().adsStrategy.findUnique({
        where: { channel_market_level_scopeId: { channel: 'AMAZON', market: 'IT', level: 'MARKET', scopeId: '*' } },
      })).toBeNull()
      // Row-level security itself, not only the client's filter.
      expect(await db().$queryRaw`SELECT id FROM "AdsStrategy"`).toEqual([])
      expect(await db().$queryRaw`SELECT id FROM "AdsStrategy" WHERE id = ${own[0].id}`).toEqual([])
      expect(await db().$executeRaw`UPDATE "AdsStrategy" SET "targetPct" = 99 WHERE id = ${own[0].id}`).toBe(0)
      expect(await db().$executeRaw`DELETE FROM "AdsStrategy" WHERE id = ${own[0].id}`).toBe(0)
      // Nor can it write a row into the other business.
      await expect(db().adsStrategy.create({ data: { workspaceId: A, market: 'FR', level: 'MARKET', label: 'Wrong business', updatedBy: 'user:test' } }))
        .rejects.toMatchObject({ code: 'workspace_mismatch' })
      await expect(db().$executeRaw`INSERT INTO "AdsStrategy" ("workspaceId", id, market, level, label, "updatedAt", "updatedBy") VALUES (${A}, 'w1_raw_cross', 'FR', 'MARKET', 'Wrong business', CURRENT_TIMESTAMP, 'user:test')`)
        .rejects.toThrow()
    })
    // A's rows are untouched, and B's own copy of the same scope is its own row.
    expect((await inA(() => db().adsStrategy.findUniqueOrThrow({ where: { id: own[0].id } }))).targetPct).not.toBe(99)
    const mine = await inB(() => db().adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Bravo market (IT)', updatedBy: 'user:test' } }))
    expect(mine.workspaceId).toBe(B)
    expect(await inB(() => db().adsStrategy.count())).toBe(1)
  })

  it('the history: one row per strategy and version, kept to its business', async () => {
    const strategy = await inA(() => db().adsStrategy.findUniqueOrThrow({
      where: { channel_market_level_scopeId: { channel: 'AMAZON', market: 'IT', level: 'PRODUCT', scopeId: 'prod_test_1' } },
    }))
    const version = {
      strategyId: strategy.id, channel: 'AMAZON', market: 'IT', level: 'PRODUCT', scopeId: 'prod_test_1', version: 1,
      op: 'set', values: { maxBidCents: 90 }, changes: [{ field: 'maxBidCents', from: null, to: 90, direction: 'lower' }],
      direction: 'lower', via: 'screen', actor: 'Test person',
    }
    const written = await inA(() => db().adsStrategyVersion.create({ data: version }))
    expect(written).toMatchObject({ workspaceId: A, approvalId: null, stepUpAt: null })
    await expect(inA(() => db().adsStrategyVersion.create({ data: version }))).rejects.toMatchObject({ code: 'P2002' })
    expect(await inA(() => db().adsStrategyVersion.findUnique({ where: { strategyId_version: { strategyId: strategy.id, version: 1 } } })))
      .toMatchObject({ id: written.id })
    await inB(async () => {
      expect(await db().adsStrategyVersion.findMany()).toEqual([])
      expect(await db().$queryRaw`SELECT id FROM "AdsStrategyVersion"`).toEqual([])
      expect(await db().adsStrategyVersion.findUnique({ where: { strategyId_version: { strategyId: strategy.id, version: 1 } } })).toBeNull()
      // The same strategy id and version in another business is its own history row.
      expect((await db().adsStrategyVersion.create({ data: version })).workspaceId).toBe(B)
    })
  })

  it('with business profiles on, a call without a business is refused', async () => {
    await expect(db().adsStrategy.findMany()).rejects.toMatchObject({ code: 'workspace_required' })
    await expect(db().adsStrategyVersion.findMany()).rejects.toMatchObject({ code: 'workspace_required' })
  })

  it('both tables force row-level security and carry the business policy and the reference guard', async () => {
    const tables = await database.db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('AdsStrategy', 'AdsStrategyVersion') ORDER BY relname`,
    )
    expect(tables.rows).toEqual([
      { relname: 'AdsStrategy', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'AdsStrategyVersion', relrowsecurity: true, relforcerowsecurity: true },
    ])
    const policies = await database.db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_policies WHERE policyname = 'nexus_workspace_isolation' AND tablename IN ('AdsStrategy', 'AdsStrategyVersion') ORDER BY tablename`,
    )
    expect(policies.rows.map(row => row.tablename)).toEqual(['AdsStrategy', 'AdsStrategyVersion'])
    const triggers = await database.db.query<{ relname: string }>(
      `SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname = 'nexus_workspace_references' AND c.relname IN ('AdsStrategy', 'AdsStrategyVersion') ORDER BY c.relname`,
    )
    expect(triggers.rows.map(row => row.relname)).toEqual(['AdsStrategy', 'AdsStrategyVersion'])
  })
})
