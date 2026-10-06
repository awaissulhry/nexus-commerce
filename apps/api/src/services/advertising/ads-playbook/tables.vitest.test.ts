/**
 * ADS PLAYBOOK PB-1 — the four playbook tables (AdsPlaybookTemplate, AdsPlaybook, AdsPlaybookVersion, AdsPlaybookLink)
 * and AdBlueprintApplication.playbookId on a real PostgreSQL with the production schema and every business policy
 * (PGlite), business profiles ON.
 *
 *   isolation   a row one business stores is invisible to another, through Prisma AND raw SQL (row-level security,
 *               not only the client's filter); a business cannot read, change or write into another's rows
 *   one row     one template name per business; one playbook row per (channel, market, level, scope); one history row
 *               per (kind, ref, version); one campaign in one slot, one link per playbook slot — each per business
 *   inherit     a new playbook row says nothing until a field is set, the market row uses the '*' scope
 *   no business with profiles ON, a call without a business is refused
 *
 * Values are made up (public repo).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
const A = 'pb1_playbook_alpha'
const B = 'pb1_playbook_bravo'
const TABLES = ['AdsPlaybook', 'AdsPlaybookLink', 'AdsPlaybookTemplate', 'AdsPlaybookVersion'] as const
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const inB = <T>(work: () => Promise<T>) => withWorkspace(scope(B), work)
const db = () => database.client

const PRODUCT_FIELDS = [
  'templateId', 'overrides', 'enrolled', 'state', 'nameToken', 'portfolioName', 'dailyBudgetCents', 'baseBidCents',
  'terms', 'phaseRecipes', 'compiledVersion', 'compiledTemplateVersion',
] as const
const doc = { structure: { slots: [{ key: 'auto', targeting: 'AUTO' }] } }

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

describe('PB-1 — the ads playbook tables', () => {
  it('a template: one name per business, version 1, active, the business from the context', async () => {
    const row = await inA(() => db().adsPlaybookTemplate.create({ data: { name: 'Test funnel', doc, updatedBy: 'user:test' } }))
    expect(row).toMatchObject({ workspaceId: A, channel: 'AMAZON', adProduct: 'SP', version: 1, status: 'ACTIVE', capturedFrom: null })
    await expect(inA(() => db().adsPlaybookTemplate.create({ data: { name: 'Test funnel', doc, updatedBy: 'user:test' } })))
      .rejects.toMatchObject({ code: 'P2002' })
    // The named key finds the business's own template (scoped-keys.json adds the business to the selector).
    expect(await inA(() => db().adsPlaybookTemplate.findUnique({ where: { workspace_name: { workspaceId: A, name: 'Test funnel' } } })))
      .toMatchObject({ id: row.id })
  })

  it('a new market row says nothing yet: every playbook field inherits, the scope is "*"', async () => {
    const row = await inA(() => db().adsPlaybook.create({ data: { market: 'IT', level: 'MARKET', label: 'Test market (IT)', updatedBy: 'user:test' } }))
    expect(row).toMatchObject({ workspaceId: A, channel: 'AMAZON', market: 'IT', level: 'MARKET', scopeId: '*', version: 1 })
    for (const field of PRODUCT_FIELDS) expect(row[field], field).toBeNull()
  })

  it('one playbook row per channel, market, level and scope in a business; another market, level or scope is its own row', async () => {
    await expect(inA(() => db().adsPlaybook.create({ data: { market: 'IT', level: 'MARKET', label: 'Again', updatedBy: 'user:test' } })))
      .rejects.toMatchObject({ code: 'P2002' })
    const template = await inA(() => db().adsPlaybookTemplate.findUniqueOrThrow({ where: { workspace_name: { workspaceId: A, name: 'Test funnel' } } }))
    await inA(() => db().adsPlaybook.create({ data: { market: 'DE', level: 'MARKET', label: 'Test market (DE)', updatedBy: 'user:test' } }))
    await inA(() => db().adsPlaybook.create({ data: { market: 'IT', level: 'CATEGORY', scopeId: 'cat_test_1', label: 'Test category (IT)', templateId: template.id, updatedBy: 'user:test' } }))
    await inA(() => db().adsPlaybook.create({
      data: {
        market: 'IT', level: 'PRODUCT', scopeId: 'prod_test_1', label: 'TEST-SKU-1 (IT)', enrolled: true, state: 'DRAFT',
        nameToken: 'TESTTOKEN', dailyBudgetCents: 1000, baseBidCents: 30, terms: { brand: ['test brand'] }, updatedBy: 'user:test',
      },
    }))
    const found = await inA(() => db().adsPlaybook.findUnique({
      where: { channel_market_level_scopeId: { channel: 'AMAZON', market: 'IT', level: 'PRODUCT', scopeId: 'prod_test_1' } },
    }))
    expect(found).toMatchObject({ workspaceId: A, enrolled: true, state: 'DRAFT', dailyBudgetCents: 1000, baseBidCents: 30 })
    expect(await inA(() => db().adsPlaybook.count({ where: { market: 'IT' } }))).toBe(3)
  })

  it('a row one business stores is invisible to another, through Prisma and through raw SQL', async () => {
    const own = await inA(() => db().adsPlaybook.findMany({ select: { id: true } }))
    const template = await inA(() => db().adsPlaybookTemplate.findFirstOrThrow())
    expect(own.length).toBeGreaterThan(0)
    await inB(async () => {
      expect(await db().adsPlaybook.findMany()).toEqual([])
      expect(await db().adsPlaybookTemplate.findMany()).toEqual([])
      expect(await db().adsPlaybook.findUnique({ where: { id: own[0].id } })).toBeNull()
      expect(await db().adsPlaybookTemplate.findUnique({ where: { workspace_name: { workspaceId: B, name: 'Test funnel' } } })).toBeNull()
      expect(await db().adsPlaybook.findUnique({
        where: { channel_market_level_scopeId: { channel: 'AMAZON', market: 'IT', level: 'MARKET', scopeId: '*' } },
      })).toBeNull()
      // Row-level security itself, not only the client's filter.
      expect(await db().$queryRaw`SELECT id FROM "AdsPlaybook"`).toEqual([])
      expect(await db().$queryRaw`SELECT id FROM "AdsPlaybookTemplate" WHERE id = ${template.id}`).toEqual([])
      expect(await db().$executeRaw`UPDATE "AdsPlaybook" SET "dailyBudgetCents" = 99999 WHERE id = ${own[0].id}`).toBe(0)
      expect(await db().$executeRaw`UPDATE "AdsPlaybookTemplate" SET name = 'Taken' WHERE id = ${template.id}`).toBe(0)
      expect(await db().$executeRaw`DELETE FROM "AdsPlaybook" WHERE id = ${own[0].id}`).toBe(0)
      // Nor can it write a row into the other business.
      await expect(db().adsPlaybook.create({ data: { workspaceId: A, market: 'FR', level: 'MARKET', label: 'Wrong business', updatedBy: 'user:test' } }))
        .rejects.toMatchObject({ code: 'workspace_mismatch' })
      await expect(db().$executeRaw`INSERT INTO "AdsPlaybook" ("workspaceId", id, market, level, label, "updatedAt", "updatedBy") VALUES (${A}, 'pb1_raw_cross', 'FR', 'MARKET', 'Wrong business', CURRENT_TIMESTAMP, 'user:test')`)
        .rejects.toThrow()
      await expect(db().$executeRaw`INSERT INTO "AdsPlaybookTemplate" ("workspaceId", id, name, doc, "updatedAt", "updatedBy") VALUES (${A}, 'pb1_raw_cross_t', 'Wrong business', '{}'::jsonb, CURRENT_TIMESTAMP, 'user:test')`)
        .rejects.toThrow()
    })
    // A's rows are untouched, and B's own copies (same template name, same scope) are its own rows.
    expect((await inA(() => db().adsPlaybook.findUniqueOrThrow({ where: { id: own[0].id } }))).dailyBudgetCents).not.toBe(99999)
    expect((await inA(() => db().adsPlaybookTemplate.findUniqueOrThrow({ where: { id: template.id } }))).name).toBe('Test funnel')
    const mine = await inB(() => db().adsPlaybook.create({ data: { market: 'IT', level: 'MARKET', label: 'Bravo market (IT)', updatedBy: 'user:test' } }))
    const mineTemplate = await inB(() => db().adsPlaybookTemplate.create({ data: { name: 'Test funnel', doc, updatedBy: 'user:test' } }))
    expect([mine.workspaceId, mineTemplate.workspaceId]).toEqual([B, B])
    expect(await inB(() => db().adsPlaybook.count())).toBe(1)
  })

  it('the history: one row per kind, ref and version, kept to its business; a playbook row keeps its scope', async () => {
    const playbook = await inA(() => db().adsPlaybook.findUniqueOrThrow({
      where: { channel_market_level_scopeId: { channel: 'AMAZON', market: 'IT', level: 'PRODUCT', scopeId: 'prod_test_1' } },
    }))
    const version = {
      kind: 'playbook', refId: playbook.id, version: 1, market: 'IT', level: 'PRODUCT', scopeId: 'prod_test_1',
      op: 'enroll', values: { enrolled: true }, changes: [{ field: 'enrolled', from: null, to: true, direction: 'raise' }], direction: 'raise',
      via: 'screen', actor: 'Test person', stepUpAt: new Date('2026-10-01T10:00:00Z'),
    }
    const written = await inA(() => db().adsPlaybookVersion.create({ data: version }))
    expect(written).toMatchObject({ workspaceId: A, approvalId: null, actorUserId: null, reason: null, direction: 'raise', stepUpAt: new Date('2026-10-01T10:00:00Z') })
    await expect(inA(() => db().adsPlaybookVersion.create({ data: version }))).rejects.toMatchObject({ code: 'P2002' })
    // The same ref and version of the OTHER kind is its own row; a template's history has no scope.
    const template = await inA(() => db().adsPlaybookVersion.create({
      data: { kind: 'template', refId: playbook.id, version: 1, op: 'set', changes: [], direction: 'same', via: 'claude', actor: 'Claude', approvalId: 'appr_test_1' },
    }))
    expect(template).toMatchObject({ market: null, level: null, scopeId: null })
    expect(await inA(() => db().adsPlaybookVersion.findUnique({ where: { kind_refId_version: { kind: 'playbook', refId: playbook.id, version: 1 } } })))
      .toMatchObject({ id: written.id })
    await inB(async () => {
      expect(await db().adsPlaybookVersion.findMany()).toEqual([])
      expect(await db().$queryRaw`SELECT id FROM "AdsPlaybookVersion"`).toEqual([])
      expect(await db().adsPlaybookVersion.findUnique({ where: { kind_refId_version: { kind: 'playbook', refId: playbook.id, version: 1 } } })).toBeNull()
      expect((await db().adsPlaybookVersion.create({ data: version })).workspaceId).toBe(B)
    })
  })

  it('the links: one campaign plays one slot of one playbook, one slot has one link, kept to its business', async () => {
    const link = (over: Record<string, unknown> = {}) => ({
      playbookId: 'pb_test_1', kind: 'slot', key: 'exact-brand', refId: 'camp_test_1', adGroupId: 'ag_test_1',
      origin: 'adopted', compiledVersion: 1, updatedBy: 'user:test', ...over,
    })
    const written = await inA(() => db().adsPlaybookLink.create({ data: link() }))
    expect(written).toMatchObject({ workspaceId: A, origin: 'adopted' })
    // The same campaign in another slot (or another playbook) is refused …
    await expect(inA(() => db().adsPlaybookLink.create({ data: link({ key: 'exact-category' }) }))).rejects.toMatchObject({ code: 'P2002' })
    await expect(inA(() => db().adsPlaybookLink.create({ data: link({ playbookId: 'pb_test_2' }) }))).rejects.toMatchObject({ code: 'P2002' })
    // … and so is a second campaign in the same slot of the same playbook.
    await expect(inA(() => db().adsPlaybookLink.create({ data: link({ refId: 'camp_test_2' }) }))).rejects.toMatchObject({ code: 'P2002' })
    // A different kind may reuse a key ('rank:performance') and point at its own artifact.
    await inA(() => db().adsPlaybookLink.create({ data: link({ kind: 'rankGroup', key: 'rank:performance', refId: 'rsg_test_1', adGroupId: null, origin: 'built' }) }))
    expect(await inA(() => db().adsPlaybookLink.findUnique({ where: { playbookId_kind_key: { playbookId: 'pb_test_1', kind: 'slot', key: 'exact-brand' } } })))
      .toMatchObject({ id: written.id })
    expect(await inA(() => db().adsPlaybookLink.findUnique({ where: { kind_refId: { kind: 'slot', refId: 'camp_test_1' } } })))
      .toMatchObject({ id: written.id })
    await inB(async () => {
      expect(await db().adsPlaybookLink.findMany()).toEqual([])
      expect(await db().$queryRaw`SELECT id FROM "AdsPlaybookLink"`).toEqual([])
      expect(await db().adsPlaybookLink.findUnique({ where: { kind_refId: { kind: 'slot', refId: 'camp_test_1' } } })).toBeNull()
      expect(await db().$executeRaw`UPDATE "AdsPlaybookLink" SET "refId" = 'stolen' WHERE id = ${written.id}`).toBe(0)
      // The same campaign id in another business is its own link.
      expect((await db().adsPlaybookLink.create({ data: link() })).workspaceId).toBe(B)
    })
  })

  it('a blueprint run may name its playbook; every run before the playbook names none', async () => {
    const base = { productToken: 'TESTTOKEN', marketplace: 'IT', plan: { campaigns: [] } }
    const old = await inA(() => db().adBlueprintApplication.create({ data: base }))
    expect(old.playbookId).toBeNull()
    const run = await inA(() => db().adBlueprintApplication.create({ data: { ...base, playbookId: 'pb_test_1' } }))
    expect(await inA(() => db().adBlueprintApplication.findMany({ where: { playbookId: 'pb_test_1' }, select: { id: true } })))
      .toEqual([{ id: run.id }])
  })

  it('with business profiles on, a call without a business is refused', async () => {
    await expect(db().adsPlaybookTemplate.findMany()).rejects.toMatchObject({ code: 'workspace_required' })
    await expect(db().adsPlaybook.findMany()).rejects.toMatchObject({ code: 'workspace_required' })
    await expect(db().adsPlaybookVersion.findMany()).rejects.toMatchObject({ code: 'workspace_required' })
    await expect(db().adsPlaybookLink.findMany()).rejects.toMatchObject({ code: 'workspace_required' })
  })

  it('all four tables force row-level security and carry the business policy and the reference guard', async () => {
    const tables = await database.db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1) ORDER BY relname`, [TABLES],
    )
    expect(tables.rows).toEqual(TABLES.map(relname => ({ relname, relrowsecurity: true, relforcerowsecurity: true })))
    const policies = await database.db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_policies WHERE policyname = 'nexus_workspace_isolation' AND tablename = ANY($1) ORDER BY tablename`, [TABLES],
    )
    expect(policies.rows.map(row => row.tablename)).toEqual([...TABLES])
    const triggers = await database.db.query<{ relname: string }>(
      `SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname = 'nexus_workspace_references' AND c.relname = ANY($1) ORDER BY c.relname`, [TABLES],
    )
    expect(triggers.rows.map(row => row.relname)).toEqual([...TABLES])
  })
})
