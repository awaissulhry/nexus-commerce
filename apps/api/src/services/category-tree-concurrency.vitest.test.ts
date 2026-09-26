/**
 * Real PostgreSQL, several connections: concurrent category-tree writes serialize on the business's
 * category-tree lock and leave a consistent tree.
 *
 * Each race is made deterministic with a GATE: a statement trigger on the table named in
 * `fixture_gate` waits for a shared advisory lock that the test holds. Both writers are started,
 * the test waits until two sessions are blocked, then opens the gate.
 *   · Without the tree lock, both writers pass their checks and block at the gate; once it opens,
 *     both write (a cycle, a duplicate URL key, a merged membership set, a stale command applied).
 *   · With it, the first writer blocks at the gate while HOLDING the tree lock and the second blocks
 *     on the tree lock; the second then re-reads the committed state and refuses or replaces it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { concurrentDatabase, concurrentDatabaseUrl } from '../test-support/concurrent-database.js'
import { categoryTreeProblems } from '../test-support/category-tree-state.js'
import { withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../db.js', async () => {
  const { contextualDatabase } = await import('../lib/database-context.js')
  return { default: contextualDatabase(new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }) as never) }
})
vi.mock('../lib/queue.js', () => ({
  addJobSafely: vi.fn(async () => ({ enqueued: true })), readCacheQueue: {}, searchIndexQueue: { add: vi.fn(async () => undefined) },
  outboundSyncQueue: {}, redis: { connection: {} }, resolveRedisTarget: () => ({ kind: 'host-port', host: 'localhost', port: 6379, options: {} }),
}))
vi.mock('./listing-events.service.js', () => ({ publishListingEvent: vi.fn() }))

const { categoryTreeService } = await import('./category-tree.service.js')
const { applyCategoryCommand, categoryDirectory } = await import('./taxonomy/category-workspace.js')

const WORKSPACE = 'nexus_legacy_workspace'
const GATE = 7_031_926_001
const inWorkspace = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: WORKSPACE, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const query = (sql: string, params?: unknown[]) => database.pool.query(sql, params)
const problems = () => categoryTreeProblems(query)
let slugs = 0
const slug = (label: string) => `${label}-${++slugs}`
const create = (label: string, parentId: string | null = null) => inWorkspace(() => categoryTreeService.create({ parentId, slug: slug(label) }))
const parentOf = async (id: string) => (await query('SELECT "parentId" FROM "Category" WHERE id = $1', [id])).rows[0]?.parentId ?? null
type Outcome = { ok: boolean; value?: unknown; error?: any }
const settle = (work: Promise<unknown>): Promise<Outcome> => work.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }))

/** Start the writers with the gate on `table`, wait until two sessions are blocked, then open it. */
async function race(table: string, writers: Array<() => Promise<unknown>>): Promise<Outcome[]> {
  const gate = await database.pool.connect()
  let outcomes: Promise<Outcome>[] = []
  try {
    await gate.query('SELECT pg_advisory_lock($1)', [GATE])
    await gate.query('INSERT INTO fixture_gate (tbl) VALUES ($1)', [table])
    outcomes = writers.map((writer) => settle(inWorkspace(writer)))
    await vi.waitFor(async () => {
      const blocked = await query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)
      expect(blocked.rows[0].n).toBe(writers.length)
    }, { timeout: 10_000, interval: 25 })
  } finally {
    await gate.query('DELETE FROM fixture_gate')
    await gate.query('SELECT pg_advisory_unlock($1)', [GATE])
    gate.release()
  }
  return Promise.all(outcomes)
}

describe.skipIf(!concurrentDatabaseUrl())('concurrent category-tree writes on real PostgreSQL', () => {
  beforeAll(async () => {
    database = await concurrentDatabase({ maxConnections: 8 })
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    await query(`
      CREATE TABLE fixture_gate (tbl text PRIMARY KEY);
      CREATE FUNCTION fixture_gate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM fixture_gate WHERE tbl = TG_TABLE_NAME || ':' || TG_OP) THEN PERFORM pg_advisory_xact_lock_shared(${GATE}); END IF;
        RETURN NULL;
      END $$;`)
    for (const table of ['Category', 'CategoryClosure', 'ProductCategory']) {
      await query(`CREATE TRIGGER fixture_gate BEFORE INSERT OR UPDATE OR DELETE ON "${table}" FOR EACH STATEMENT EXECUTE FUNCTION fixture_gate()`)
    }
  }, 180_000)
  afterAll(async () => {
    vi.unstubAllEnvs()
    await database?.close()
  }, 60_000)

  it('two opposite moves serialize: one wins, the other sees the cycle and is refused', async () => {
    const left = await create('left')
    const right = await create('right')
    await create('left-child', left.id)
    const outcomes = await race('CategoryClosure:DELETE', [() => categoryTreeService.move(left.id, right.id), () => categoryTreeService.move(right.id, left.id)])
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1)
    expect(outcomes.find((outcome) => !outcome.ok)).toMatchObject({ error: { name: 'CategoryTreeError', status: 400, message: 'Cannot move a category beneath its own descendant' } })
    expect([await parentOf(left.id), await parentOf(right.id)].filter(Boolean)).toHaveLength(1)
    expect(await problems()).toEqual([])
  })

  it('two creates of the same top-level URL key serialize: the second is refused', async () => {
    const key = slug('same')
    const outcomes = await race('Category:INSERT', [0, 1].map(() => () => categoryTreeService.create({ parentId: null, slug: key })))
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1)
    expect(outcomes.find((outcome) => !outcome.ok)).toMatchObject({ error: { name: 'CategoryTreeError', status: 409 } })
    expect((await query('SELECT id FROM "Category" WHERE slug = $1', [key])).rows).toHaveLength(1)
    expect(await problems()).toEqual([])
  })

  it('two membership replacements serialize: the product ends with exactly one requested set and one primary', async () => {
    const [a, b, c] = [await create('a'), await create('b'), await create('c')]
    const productId = await inWorkspace(async () => (await database.client.product.create({ data: {
      sku: `CATEGORY-RACE-${++slugs}`, name: 'Category race fixture', basePrice: 10, costPrice: 5, totalStock: 0, fulfillmentMethod: 'FBM',
    }, select: { id: true } })).id)
    const version = async () => (await query('SELECT version FROM "Product" WHERE id = $1', [productId])).rows[0].version as number
    const before = await version()
    const outcomes = await race('ProductCategory:INSERT', [
      () => categoryTreeService.assign(productId, [a.id, b.id], { primaryId: a.id }),
      () => categoryTreeService.assign(productId, [c.id], { primaryId: c.id }),
    ])
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true)
    const final = (await query('SELECT "categoryId", "isPrimary" FROM "ProductCategory" WHERE "productId" = $1 ORDER BY "categoryId"', [productId])).rows
    const requested = [[{ categoryId: a.id, isPrimary: true }, { categoryId: b.id, isPrimary: false }], [{ categoryId: c.id, isPrimary: true }]]
      .map((set) => [...set].sort((x, y) => x.categoryId.localeCompare(y.categoryId)))
    expect(requested).toContainEqual(final)
    expect(await version()).toBe(before + 2)
    expect(Number((await query('SELECT count(*) FROM "ProductEvent" WHERE "aggregateId" = $1', [productId])).rows[0].count)).toBe(2)
    expect(await problems()).toEqual([])
  })

  it('two Categories workspace commands reviewed against the same directory: only the first applies', async () => {
    const { token } = await inWorkspace(() => categoryDirectory())
    const keys = [slug('reviewed'), slug('reviewed')]
    const outcomes = await race('Category:INSERT', keys.map((key) => () => applyCategoryCommand({ action: 'create', name: `Reviewed ${key}`, slug: key, parentId: null, expectedToken: token }, null)))
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1)
    expect(outcomes.find((outcome) => !outcome.ok)).toMatchObject({ error: { statusCode: 409, message: expect.stringContaining('changed') } })
    expect((await query('SELECT count(*)::int AS n FROM "Category" WHERE slug = ANY($1)', [keys])).rows[0].n).toBe(1)
    expect(await problems()).toEqual([])
  })

  it('a burst of overlapping moves and membership changes leaves a consistent tree', async () => {
    const nodes = []
    for (const label of ['n0', 'n1', 'n2', 'n3', 'n4', 'n5']) nodes.push(await create(label, nodes.length > 2 ? nodes[nodes.length - 3].id : null))
    const products = await inWorkspace(async () => Promise.all([0, 1].map(async () => (await database.client.product.create({ data: {
      sku: `CATEGORY-BURST-${++slugs}`, name: 'Category burst fixture', basePrice: 10, costPrice: 5, totalStock: 0, fulfillmentMethod: 'FBM',
    }, select: { id: true } })).id)))
    const pairs: Array<[number, number | null]> = [[0, 1], [1, 2], [2, 0], [3, 4], [4, 5], [5, 3], [1, null], [3, 0], [4, 2], [0, 5]]
    const outcomes = await Promise.all([
      ...pairs.map(([node, parent]) => settle(inWorkspace(() => categoryTreeService.move(nodes[node].id, parent === null ? null : nodes[parent].id)))),
      ...products.flatMap((productId, index) => [0, 1, 2].map((offset) => settle(inWorkspace(() => categoryTreeService.assign(productId, [nodes[(index + offset) % 6].id, nodes[(index + offset + 3) % 6].id]))))),
    ])
    for (const outcome of outcomes) if (!outcome.ok) expect(outcome.error).toMatchObject({ name: 'CategoryTreeError' })
    expect(outcomes.filter((outcome) => outcome.ok).length).toBeGreaterThan(pairs.length / 2)
    expect(await problems()).toEqual([])
  })
})
