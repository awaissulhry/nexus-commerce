/**
 * CategoryTreeService on a real database, through the production client composition
 * (db.ts: `contextualDatabase` over the business-scoped `workspacePrisma` root).
 *
 * The shared `categoryTreeService` used to decide "am I the root client?" with
 * `'$transaction' in this.db`. The root client is a Proxy over `{}`, so that was false and every
 * write ran with no transaction and no category-tree lock. These tests observe the database:
 *   · a statement trigger records, for every write, its transaction id and whether that
 *     transaction held the business's category-tree advisory lock;
 *   · a refusal trigger fails the LAST step of a write, which must roll back the earlier steps.
 * PGlite has one connection, so races are covered by category-tree-concurrency.vitest.test.ts.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { categoryTreeProblems } from '../test-support/category-tree-state.js'
import { withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
const effects = vi.hoisted(() => ({ addJobSafely: vi.fn(async () => ({ enqueued: true })), publish: vi.fn() }))
vi.mock('../db.js', async () => {
  const { contextualDatabase } = await import('../lib/database-context.js')
  return { default: contextualDatabase(new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }) as never) }
})
// The post-commit fan-out is observed here instead of reaching Redis or the SSE bus.
vi.mock('../lib/queue.js', () => ({
  addJobSafely: effects.addJobSafely, readCacheQueue: { name: 'read-cache' }, searchIndexQueue: { add: vi.fn(async () => undefined) },
  outboundSyncQueue: {}, redis: { connection: {} }, resolveRedisTarget: () => ({ kind: 'host-port', host: 'localhost', port: 6379, options: {} }),
}))
vi.mock('./listing-events.service.js', () => ({ publishListingEvent: effects.publish }))

const { categoryTreeService, CategoryTreeError } = await import('./category-tree.service.js')
const { applyCategoryCommand, categoryDirectory } = await import('./taxonomy/category-workspace.js')
const { default: pimCategoriesRoutes } = await import('../routes/pim-categories.routes.js')

const WORKSPACE = 'nexus_legacy_workspace'
const CONTEXT = { workspaceId: WORKSPACE, actorUserId: null, membershipId: null, roleKeys: [] as string[] }
const inWorkspace = <T>(work: () => Promise<T>) => withWorkspace(CONTEXT, work)
const query = (sql: string, params?: unknown[]) => database.db.query<any>(sql, params)
const problems = () => categoryTreeProblems(query)
let slugs = 0
const slug = (label: string) => `${label}-${++slugs}`
const create = (label: string, parentId: string | null = null, isActive = true) => inWorkspace(() => categoryTreeService.create({ parentId, slug: slug(label), isActive }))
const parentOf = async (id: string) => (await query('SELECT "parentId" FROM "Category" WHERE id = $1', [id])).rows[0]?.parentId ?? null
const memberships = async (productId: string) => (await query('SELECT "categoryId", "isPrimary" FROM "ProductCategory" WHERE "productId" = $1 ORDER BY "categoryId"', [productId])).rows
const productVersion = async (id: string) => (await query('SELECT version FROM "Product" WHERE id = $1', [id])).rows[0].version as number
const productEvents = async (id: string) => Number((await query('SELECT count(*) FROM "ProductEvent" WHERE "aggregateId" = $1', [id])).rows[0].count)
const refusing = async <T>(table: string, work: () => Promise<T>) => {
  await query('INSERT INTO fixture_refuse (tbl) VALUES ($1)', [table])
  try { return await work() } finally { await query('DELETE FROM fixture_refuse WHERE tbl = $1', [table]) }
}
async function product() {
  return inWorkspace(async () => (await database.client.product.create({ data: {
    sku: `CATEGORY-TREE-${++slugs}`, name: 'Category tree fixture', basePrice: 10, costPrice: 5, totalStock: 0, fulfillmentMethod: 'FBM',
  }, select: { id: true } })).id)
}
/** The writes one operation made: how many statements, in how many transactions, and whether each held the tree lock. */
async function witnessed(work: () => Promise<unknown>) {
  await query('DELETE FROM fixture_writes')
  await inWorkspace(work)
  const rows = (await query('SELECT tbl, op, xid::text AS xid, locked FROM fixture_writes ORDER BY seq')).rows
  return { writes: rows.length, transactions: new Set(rows.map((row) => row.xid)).size, unlocked: rows.filter((row) => !row.locked).map((row) => `${row.op} ${row.tbl}`) }
}

describe('CategoryTreeService writes on a real database', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    database = await formulaDatabase()
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    await database.db.exec(`
      CREATE TABLE fixture_writes (seq serial PRIMARY KEY, tbl text NOT NULL, op text NOT NULL, xid bigint NOT NULL, locked boolean NOT NULL);
      CREATE TABLE fixture_refuse (tbl text PRIMARY KEY);
      -- Is the category-tree lock of THIS business held by THIS transaction? (a bigint advisory key is
      -- shown as classid = high half, objid = low half, objsubid = 1)
      CREATE FUNCTION fixture_witness() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN
        INSERT INTO fixture_writes (tbl, op, xid, locked) VALUES (TG_TABLE_NAME, TG_OP, txid_current(), EXISTS (
          SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted AND objsubid = 1
            AND ((classid::bigint << 32) | objid::bigint) = hashtextextended('categories:' || current_setting('nexus.workspace_id', true), 0)));
        RETURN NULL;
      END $$;
      CREATE FUNCTION fixture_refuse() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM fixture_refuse WHERE tbl = TG_TABLE_NAME) THEN RAISE EXCEPTION 'fixture refuses writes to %', TG_TABLE_NAME; END IF;
        RETURN NULL;
      END $$;
    `)
    for (const table of ['Category', 'CategoryClosure', 'ProductCategory', 'ProductEvent', 'Product', 'BulkOperation']) {
      await database.db.exec(`CREATE TRIGGER fixture_witness AFTER INSERT OR UPDATE OR DELETE ON "${table}" FOR EACH STATEMENT EXECUTE FUNCTION fixture_witness();
        CREATE TRIGGER fixture_refuse BEFORE INSERT ON "${table}" FOR EACH STATEMENT EXECUTE FUNCTION fixture_refuse();`)
    }
    app = Fastify()
    app.addHook('preHandler', (_request, _reply, done) => withWorkspace(CONTEXT, () => done()))
    await app.register(pimCategoriesRoutes, { prefix: '/api' })
    await app.ready()
  }, 120_000)
  afterAll(async () => {
    vi.unstubAllEnvs()
    await app?.close()
    await database?.close()
  }, 30_000)
  beforeEach(() => vi.clearAllMocks())

  it('runs every write of the shared service in ONE transaction that holds the category-tree lock', async () => {
    const root = await create('root')
    const other = await create('other')
    const empty = await create('empty')
    const productId = await product()
    let child = { id: '' }
    const observed = {
      create: await witnessed(async () => { child = await categoryTreeService.create({ parentId: root.id, slug: slug('child') }) }),
      update: await witnessed(() => categoryTreeService.update(child.id, { name: { en: { name: 'Renamed' } } })),
      move: await witnessed(() => categoryTreeService.move(child.id, other.id)),
      assign: await witnessed(() => categoryTreeService.assign(productId, [child.id, other.id], { primaryId: other.id })),
      unassign: await witnessed(() => categoryTreeService.unassign(productId, other.id)),
      remove: await witnessed(() => categoryTreeService.remove(empty.id)),
    }
    for (const [operation, seen] of Object.entries(observed)) {
      expect(seen.writes, operation).toBeGreaterThan(0)
      expect({ operation, transactions: seen.transactions, unlocked: seen.unlocked }).toEqual({ operation, transactions: 1, unlocked: [] })
    }
    expect(await problems()).toEqual([])
  })

  it('create leaves no category behind when its ancestor rows cannot be written', async () => {
    const parent = await create('parent')
    const key = slug('orphan')
    await expect(refusing('CategoryClosure', () => inWorkspace(() => categoryTreeService.create({ parentId: parent.id, slug: key })))).rejects.toThrow('fixture refuses')
    expect((await query('SELECT id FROM "Category" WHERE slug = $1', [key])).rows).toEqual([])
    expect(await problems()).toEqual([])
  })

  it('move restores the severed ancestor rows when grafting the new ones fails', async () => {
    const from = await create('from')
    const to = await create('to')
    const moved = await create('moved', from.id)
    await create('grandchild', moved.id)
    await expect(refusing('CategoryClosure', () => inWorkspace(() => categoryTreeService.move(moved.id, to.id)))).rejects.toThrow('fixture refuses')
    expect(await parentOf(moved.id)).toBe(from.id)
    expect(await problems()).toEqual([])
  })

  it('assign replaces the membership set, bumps the product revision and records its event atomically, then notifies once', async () => {
    const [a, b, c] = [await create('a'), await create('b'), await create('c')]
    const productId = await product()
    await inWorkspace(() => categoryTreeService.assign(productId, [a.id, b.id], { primaryId: a.id }))
    vi.clearAllMocks()
    const before = { version: await productVersion(productId), events: await productEvents(productId) }

    // The event is the last write: refusing it must undo the membership swap and the revision bump.
    await expect(refusing('ProductEvent', () => inWorkspace(() => categoryTreeService.assign(productId, [c.id], { primaryId: c.id })))).rejects.toThrow('fixture refuses')
    expect(await memberships(productId)).toEqual([{ categoryId: a.id, isPrimary: true }, { categoryId: b.id, isPrimary: false }].sort((x, y) => x.categoryId.localeCompare(y.categoryId)))
    expect({ version: await productVersion(productId), events: await productEvents(productId) }).toEqual(before)
    expect(effects.addJobSafely).not.toHaveBeenCalled()

    await expect(inWorkspace(() => categoryTreeService.assign(productId, [c.id, b.id], { primaryId: c.id }))).resolves.toEqual({ productId, categoryIds: [c.id, b.id], primaryCategoryId: c.id })
    expect(await memberships(productId)).toEqual([{ categoryId: b.id, isPrimary: false }, { categoryId: c.id, isPrimary: true }].sort((x, y) => x.categoryId.localeCompare(y.categoryId)))
    expect({ version: await productVersion(productId), events: await productEvents(productId) }).toEqual({ version: before.version + 1, events: before.events + 1 })
    // The read-cache refresh is enqueued once, after the commit.
    expect(effects.addJobSafely).toHaveBeenCalledOnce()
    expect(effects.addJobSafely).toHaveBeenCalledWith(expect.anything(), 'refresh', { productId }, expect.objectContaining({ jobId: `cache:refresh:${productId}` }))
    expect(await problems()).toEqual([])
  })

  it('unassign removes the primary and promotes the next membership atomically, then notifies once', async () => {
    const [a, b] = [await create('a'), await create('b')]
    const productId = await product()
    await inWorkspace(() => categoryTreeService.assign(productId, [a.id, b.id], { primaryId: a.id }))
    vi.clearAllMocks()
    const version = await productVersion(productId)

    await expect(refusing('ProductEvent', () => inWorkspace(() => categoryTreeService.unassign(productId, a.id)))).rejects.toThrow('fixture refuses')
    expect((await memberships(productId)).find((row) => row.isPrimary)?.categoryId).toBe(a.id)
    expect(await productVersion(productId)).toBe(version)
    expect(effects.addJobSafely).not.toHaveBeenCalled()

    await expect(inWorkspace(() => categoryTreeService.unassign(productId, a.id))).resolves.toEqual({ productId, categoryId: a.id, removed: true })
    expect(await memberships(productId)).toEqual([{ categoryId: b.id, isPrimary: true }])
    expect(await productVersion(productId)).toBe(version + 1)
    expect(effects.addJobSafely).toHaveBeenCalledOnce()
    await expect(inWorkspace(() => categoryTreeService.unassign(productId, a.id))).resolves.toEqual({ productId, categoryId: a.id, removed: false })
    expect(effects.addJobSafely).toHaveBeenCalledOnce()
  })

  it('keeps the validation responses of the legacy move route, including moves under an inactive parent', async () => {
    const root = await create('root')
    const child = await create('child', root.id)
    const clash = await create('clash')
    const childKey = (await query('SELECT slug FROM "Category" WHERE id = $1', [child.id])).rows[0].slug
    await inWorkspace(() => categoryTreeService.update(clash.id, { slug: childKey }))
    const inactive = await create('inactive', null, false)
    const move = (id: string, newParentId: string | null) => app.inject({ method: 'POST', url: `/api/pim/categories/${id}/move`, payload: { newParentId } })
    const cases = {
      self: await move(root.id, root.id),
      missing: await move('no-such-category', null),
      missingParent: await move(root.id, 'no-such-parent'),
      intoDescendant: await move(root.id, child.id),
      urlKeyTaken: await move(child.id, null),
    }
    expect(Object.fromEntries(Object.entries(cases).map(([name, response]) => [name, [response.statusCode, response.json().error]]))).toEqual({
      self: [400, 'A category cannot be its own parent'],
      missing: [404, 'Category not found'],
      missingParent: [404, 'New parent not found'],
      intoDescendant: [400, 'Cannot move a category beneath its own descendant'],
      urlKeyTaken: [409, 'The destination already has a category with that URL key'],
    })
    await expect(inWorkspace(() => categoryTreeService.move(root.id, root.id))).rejects.toBeInstanceOf(CategoryTreeError)
    const underInactive = await move(child.id, inactive.id)
    expect([underInactive.statusCode, underInactive.json()]).toEqual([200, { ok: true }])
    expect(await parentOf(child.id)).toBe(inactive.id)
    expect(await problems()).toEqual([])
  })

  it('refuses a legacy move that would change inherited channel assignments until the category has its own', async () => {
    const suits = await create('suits')
    const gloves = await create('gloves')
    const jacket = await create('jacket', suits.id)
    const lining = await create('lining', jacket.id)
    const assignment = (categoryId: string, target: string) => query(`INSERT INTO "CategoryChannelMapping" (id, "workspaceId", "categoryId", channel, marketplace, "channelCategoryId", "updatedAt")
      VALUES ($1, $2, $3, 'EBAY', 'IT', $4, now())`, [`mapping-${++slugs}`, WORKSPACE, categoryId, target])
    await assignment(suits.id, 'ebay-suits')
    await assignment(gloves.id, 'ebay-gloves')

    const refused = await app.inject({ method: 'POST', url: `/api/pim/categories/${jacket.id}/move`, payload: { newParentId: gloves.id } })
    expect([refused.statusCode, refused.json().error]).toEqual([409, expect.stringContaining('changes inherited channel assignments')])
    await expect(inWorkspace(() => categoryTreeService.move(jacket.id, gloves.id))).rejects.toMatchObject({ status: 409 })
    expect(await parentOf(jacket.id)).toBe(suits.id)

    // An explicit assignment on the moved category keeps its whole subtree's classification.
    await assignment(jacket.id, 'ebay-suits')
    const allowed = await app.inject({ method: 'POST', url: `/api/pim/categories/${jacket.id}/move`, payload: { newParentId: gloves.id } })
    expect([allowed.statusCode, allowed.json()]).toEqual([200, { ok: true }])
    expect(await parentOf(jacket.id)).toBe(gloves.id)
    expect(await parentOf(lining.id)).toBe(jacket.id)
    expect(await problems()).toEqual([])
  })

  it('applies a Categories workspace command in one locked transaction: a failed audit row undoes the change', async () => {
    const key = slug('workspace')
    const command = async () => ({ action: 'create' as const, name: 'Workspace category', slug: key, parentId: null, expectedToken: (await inWorkspace(() => categoryDirectory())).token })
    const first = await command()
    await expect(refusing('BulkOperation', () => inWorkspace(() => applyCategoryCommand(first, null)))).rejects.toThrow('fixture refuses')
    expect((await query('SELECT id FROM "Category" WHERE slug = $1', [key])).rows).toEqual([])

    const second = await command()
    const seen = await witnessed(() => applyCategoryCommand(second, null))
    expect({ transactions: seen.transactions, unlocked: seen.unlocked }).toEqual({ transactions: 1, unlocked: [] })
    expect((await query('SELECT id FROM "Category" WHERE slug = $1', [key])).rows).toHaveLength(1)
    expect(await problems()).toEqual([])
  })
})
