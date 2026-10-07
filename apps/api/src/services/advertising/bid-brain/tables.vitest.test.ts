/**
 * BID BRAIN BB-2 — the four bid-brain tables (BidBrainEnrollment, BidBrainDecision, BidHold, BidDirective) on a real
 * PostgreSQL with the production schema and every business policy (PGlite), business profiles ON.
 *
 *   isolation   a row one business stores is invisible to another, through Prisma AND raw SQL, and cannot be written
 *               into another business
 *   one row     one enrollment per campaign in a business (the same campaign id in another business is its own row);
 *               a new enrollment starts in SHADOW
 *   no business with profiles ON, a call without a business is refused
 *   policies    every table forces row-level security and carries the business policy and the reference guard
 *
 * Values are made up (public repo).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
const A = 'bb2_brain_alpha'
const B = 'bb2_brain_bravo'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const inB = <T>(work: () => Promise<T>) => withWorkspace(scope(B), work)
const db = () => database.client
const TABLES = ['BidBrainDecision', 'BidBrainEnrollment', 'BidDirective', 'BidHold']

const decision = {
  runId: 'run_test_1', mode: 'SHADOW', kind: 'change', marketplace: 'IT', campaignId: 'camp_test_1', adGroupId: 'ag_test_1',
  targetId: 'tgt_test_1', action: 'write', layer: 'goal', currentCents: 33, decidedCents: 25, goalBidCents: 16,
  aim: 0.2, bandLo: 0.18, bandHi: 0.28, expectedAcos: 0.409, confidence: 0.998, dataDay: new Date('2026-09-29'),
  lastWriter: 'automation:auto-bid', why: 'goal: aim 20% (band 18%–28%); 33¢ → 25¢', evidence: { step: { fromCents: 33, toCents: 25 } },
}

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

describe('BB-2 — the bid brain tables', () => {
  it('one enrollment per campaign in a business, starting in SHADOW; another business has its own', async () => {
    const row = await inA(() => db().bidBrainEnrollment.create({ data: { campaignId: 'camp_test_1', marketplace: 'IT', enrolledBy: 'user:test' } }))
    expect(row).toMatchObject({ workspaceId: A, mode: 'SHADOW', heldUntil: null, snapshot: null })
    await expect(inA(() => db().bidBrainEnrollment.create({ data: { campaignId: 'camp_test_1', marketplace: 'IT', enrolledBy: 'user:test' } })))
      .rejects.toMatchObject({ code: 'P2002' })
    const found = await inA(() => db().bidBrainEnrollment.findUnique({ where: { campaign_enrollment: { campaignId: 'camp_test_1' } } }))
    expect(found?.id).toBe(row.id)
    const theirs = await inB(() => db().bidBrainEnrollment.create({ data: { campaignId: 'camp_test_1', marketplace: 'IT', enrolledBy: 'user:test' } }))
    expect(theirs.workspaceId).toBe(B)
  })

  it('stores a decision, a hold and a directive in the business of the context', async () => {
    const d = await inA(() => db().bidBrainDecision.create({ data: decision }))
    expect(d).toMatchObject({ workspaceId: A, action: 'write', layer: 'goal', decidedCents: 25 })
    expect(Number(d.aim)).toBe(0.2)
    const h = await inA(() => db().bidHold.create({ data: { campaignId: 'camp_test_1', targetId: 'tgt_test_1', kind: 'PERSON', by: 'user:test', until: new Date('2026-12-06') } }))
    expect(h).toMatchObject({ workspaceId: A, endedAt: null })
    const r = await inA(() => db().bidDirective.create({ data: { campaignId: 'camp_test_1', kind: 'CEILING', valueCents: 20, source: 'rule:test' } }))
    expect(r).toMatchObject({ workspaceId: A, targetId: null, lane: null })
  })

  it('a row one business stores is invisible to another, through Prisma and raw SQL, and cannot be written into it', async () => {
    const own = await inA(() => db().bidBrainDecision.findFirstOrThrow({ select: { id: true } }))
    await inB(async () => {
      expect(await db().bidBrainDecision.findMany()).toEqual([])
      expect(await db().bidHold.findMany()).toEqual([])
      expect(await db().bidDirective.findMany()).toEqual([])
      expect(await db().$queryRaw`SELECT id FROM "BidBrainDecision"`).toEqual([])
      expect(await db().$executeRaw`UPDATE "BidBrainDecision" SET "decidedCents" = 99 WHERE id = ${own.id}`).toBe(0)
      expect(await db().$executeRaw`DELETE FROM "BidBrainDecision" WHERE id = ${own.id}`).toBe(0)
      await expect(db().bidHold.create({ data: { workspaceId: A, campaignId: 'camp_x', kind: 'PIN', by: 'user:test' } }))
        .rejects.toMatchObject({ code: 'workspace_mismatch' })
    })
    expect((await inA(() => db().bidBrainDecision.findUniqueOrThrow({ where: { id: own.id } }))).decidedCents).toBe(25)
  })

  it('with business profiles on, a call without a business is refused', async () => {
    await expect(db().bidBrainDecision.findMany()).rejects.toMatchObject({ code: 'workspace_required' })
    await expect(db().bidBrainEnrollment.findMany()).rejects.toMatchObject({ code: 'workspace_required' })
  })

  it('every table forces row-level security and carries the business policy and the reference guard', async () => {
    const tables = await database.db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1) ORDER BY relname`, [TABLES],
    )
    expect(tables.rows).toEqual(TABLES.map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true })))
    const policies = await database.db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_policies WHERE policyname = 'nexus_workspace_isolation' AND tablename = ANY($1) ORDER BY tablename`, [TABLES],
    )
    expect(policies.rows.map((row) => row.tablename)).toEqual(TABLES)
    const triggers = await database.db.query<{ relname: string }>(
      `SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname = 'nexus_workspace_references' AND c.relname = ANY($1) ORDER BY c.relname`, [TABLES],
    )
    expect(triggers.rows.map((row) => row.relname)).toEqual(TABLES)
  })
})
