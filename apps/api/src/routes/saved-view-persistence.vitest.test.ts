import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

type Row = { id: string; userId: string; surface: string; name: string; filters: unknown; isDefault: boolean; createdAt: Date; updatedAt: Date }
const db = vi.hoisted(() => ({ rows: [] as Row[], alerts: [] as Array<{ savedViewId: string; isActive: boolean; lastFiredAt: Date | null }>, forceConflict: false, failCreateName: '', serial: 0 }))

function matches(row: Row, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, value]) => {
    const actual = row[key as keyof Row]
    if (value instanceof Date) return actual instanceof Date && actual.getTime() === value.getTime()
    if (value && typeof value === 'object') {
      if ('in' in value) return value.in.includes(actual)
      if ('not' in value) return actual !== value.not
    }
    return actual === value
  })
}

const savedView = {
  findFirst: vi.fn(async ({ where }: { where: Record<string, any> }) => structuredClone(db.rows.find((row) => matches(row, where)) ?? null)),
  findMany: vi.fn(async ({ where }: { where: Record<string, any> }) => structuredClone(db.rows.filter((row) => matches(row, where)))),
  findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => structuredClone(db.rows.find((row) => row.id === where.id)!)),
  create: vi.fn(async ({ data }: { data: Omit<Row, 'id' | 'createdAt' | 'updatedAt'> }) => {
    if (data.name === db.failCreateName) throw new Error('Storage unavailable')
    if (db.rows.some((row) => row.userId === data.userId && row.surface === data.surface && row.name === data.name)) throw Object.assign(new Error('duplicate'), { code: 'P2002' })
    const row = { ...data, id: `new-${++db.serial}`, createdAt: new Date(), updatedAt: new Date() }
    db.rows.push(row)
    return structuredClone(row)
  }),
  updateMany: vi.fn(async ({ where, data }: { where: Record<string, any>; data: Partial<Row> }) => {
    if (db.forceConflict && where.updatedAt) return { count: 0 }
    let count = 0
    for (const row of db.rows) if (matches(row, where)) { Object.assign(row, data); count++ }
    return { count }
  }),
  deleteMany: vi.fn(async ({ where }: { where: Record<string, any> }) => {
    db.rows = db.rows.filter((row) => !matches(row, where))
    return { count: 1 }
  }),
}
const transaction = vi.fn(async (fn: (tx: { savedView: typeof savedView }) => Promise<unknown>) => {
  const before = structuredClone(db.rows)
  try { return await fn({ savedView }) }
  catch (error) { db.rows = before; throw error }
})

vi.mock('../db.js', () => ({ default: {
  get savedView() { return savedView },
  savedViewAlert: { findMany: vi.fn(async () => db.alerts) },
  get $transaction() { return transaction },
} }))

import routes from './saved-view-persistence.routes.js'

const NAMED = 'product-edit:views:AMAZON'
const WORKING = 'product-edit:layout:AMAZON:IT'
const stamp = '2026-09-05T10:00:00.000Z'
const payload = (columns = ['brand', 'color']) => ({ v: 3, kind: 'columns', columns, columnOrder: ['brand', 'color', 'size'], lockedColumns: ['brand'], groupOrder: ['identity', 'variation'], groupOverrides: { color: 'variation' } })
function seed(overrides: Partial<Row> = {}): Row {
  const row = { id: 'view-1', userId: 'alice', surface: NAMED, name: 'My view', filters: payload(), isDefault: false, createdAt: new Date(stamp), updatedAt: new Date(stamp), ...overrides }
  db.rows.push(row)
  return row
}

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  // Tests inject a resolved session; production attaches authUser in the global RBAC hook.
  app.addHook('preHandler', async (request) => {
    const id = request.headers['x-test-user'] as string | undefined
    if (id) (request as { authUser?: { id: string } }).authUser = { id }
  })
  await app.register(routes)
  await app.ready()
})
afterAll(async () => { await app.close(); vi.unstubAllEnvs() })
beforeEach(() => {
  db.rows = []; db.alerts = []; db.forceConflict = false; db.failCreateName = ''; db.serial = 0
  vi.clearAllMocks()
  vi.stubEnv('NEXUS_RBAC_MODE', 'enforce')
})

const send = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: object, user = 'alice') => app.inject({ method, url, ...(body ? { payload: body } : {}), headers: user ? { 'x-test-user': user } : {} })

describe('saved view ownership', () => {
  it('requires a session in enforced mode and uses the legacy operator only in shadow mode', async () => {
    expect((await send('GET', '/saved-views', undefined, '')).statusCode).toBe(401)
    vi.stubEnv('NEXUS_RBAC_MODE', 'shadow')
    const response = await send('POST', '/saved-views', { name: 'Local', surface: NAMED, filters: payload() }, '')
    expect(response.statusCode).toBe(200)
    expect(response.json().userId).toBe('default-user')
  })

  it('lists personal views and shared legacy templates without exposing another user', async () => {
    seed({ id: 'owned', isDefault: true })
    seed({ id: 'other', userId: 'bob', name: 'Private' })
    seed({ id: 'legacy', userId: 'default-user', name: 'Legacy', isDefault: true })
    const response = await send('GET', `/saved-views?surface=${NAMED}`)
    expect(response.json().items.map((row: Row) => row.id)).toEqual(['owned', 'legacy'])
    expect(response.json().items[1]).toMatchObject({ legacyShared: true, isDefault: false })
  })

  it('copies a legacy view on edit and hides the old same-name template for its new owner', async () => {
    seed({ userId: 'default-user' })
    const response = await send('PATCH', '/saved-views/view-1', { expectedUpdatedAt: stamp, filters: payload(['color', 'brand']) })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ userId: 'alice', legacyShared: false })
    expect(response.json().id).not.toBe('view-1')
    expect(db.rows.find((row) => row.id === 'view-1')?.filters).toEqual(payload())
    const ownList = (await send('GET', `/saved-views?surface=${NAMED}`)).json().items
    expect(ownList).toHaveLength(1)
    expect(ownList[0].id).toBe(response.json().id)
  })

  it('refuses modifications to another user and deletion of a legacy source', async () => {
    seed({ userId: 'bob' })
    expect((await send('PATCH', '/saved-views/view-1', { expectedUpdatedAt: stamp, filters: payload() })).statusCode).toBe(404)
    expect((await send('DELETE', '/saved-views/view-1')).statusCode).toBe(404)
    db.rows[0].userId = 'default-user'
    expect((await send('DELETE', '/saved-views/view-1')).statusCode).toBe(403)
    expect(db.rows).toHaveLength(1)
  })

  it('keeps working layouts private instead of implicitly restoring a legacy working draft', async () => {
    seed({ surface: WORKING, name: 'Current layout', userId: 'default-user' })
    expect((await send('GET', `/saved-views?surface=${WORKING}`)).json().items).toEqual([])
  })

  it('retains the catalog alert summary on saved-view reads', async () => {
    seed({ surface: 'products' })
    db.alerts = [
      { savedViewId: 'view-1', isActive: true, lastFiredAt: new Date() },
      { savedViewId: 'view-1', isActive: false, lastFiredAt: new Date('2020-01-01') },
    ]
    expect((await send('GET', '/saved-views')).json().items[0].alertSummary).toEqual({ active: 1, total: 2, firedRecently: 1 })
  })
})

describe('saved layout write contract', () => {
  it('round-trips the full layout and advances its timestamp on a conditional update', async () => {
    seed({ surface: WORKING, name: 'Current layout' })
    const next = payload(['color', 'brand'])
    const response = await send('PATCH', '/saved-views/view-1', { expectedUpdatedAt: stamp, filters: next })
    expect(response.statusCode).toBe(200)
    expect(response.json().filters).toEqual(next)
    expect(Date.parse(response.json().updatedAt)).toBeGreaterThan(Date.parse(stamp))
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' })
  })

  it('refuses stale and missing sheet tokens, including a race after reading the row', async () => {
    seed()
    expect((await send('PATCH', '/saved-views/view-1', { filters: payload() })).statusCode).toBe(400)
    expect((await send('PATCH', '/saved-views/view-1', { expectedUpdatedAt: '2026-09-04T10:00:00Z', filters: payload() })).statusCode).toBe(409)
    db.forceConflict = true
    expect((await send('PATCH', '/saved-views/view-1', { expectedUpdatedAt: stamp, filters: payload(['color']) })).statusCode).toBe(409)
    expect(db.rows[0].filters).toEqual(payload())
  })

  it('does not blindly overwrite an existing working layout on initial creation', async () => {
    seed({ surface: WORKING, name: 'Current layout' })
    expect((await send('POST', '/saved-views', { surface: WORKING, name: 'Current layout', filters: payload(['color']) })).statusCode).toBe(409)
    expect(db.rows[0].filters).toEqual(payload())
  })

  it('saves a named view and a current-layout companion atomically', async () => {
    const response = await send('POST', '/saved-views', { surface: NAMED, name: 'Colors', filters: payload(), workingLayout: { surface: WORKING, filters: payload(), expectedUpdatedAt: null } })
    expect(response.statusCode).toBe(200)
    expect(response.json().workingLayout).toMatchObject({ name: 'Current layout', surface: WORKING, filters: payload() })
    expect(db.rows).toHaveLength(2)
  })

  it('updates an existing companion using its own conditional token', async () => {
    seed({ id: 'working', surface: WORKING, name: 'Current layout' })
    const next = payload(['color'])
    const response = await send('POST', '/saved-views', { surface: NAMED, name: 'Colors', filters: next, workingLayout: { surface: WORKING, filters: next, expectedUpdatedAt: stamp } })
    expect(response.statusCode).toBe(200)
    expect(response.json().workingLayout).toMatchObject({ id: 'working', filters: next })
    expect(response.json().workingLayout.updatedAt).not.toBe(stamp)
  })

  it('refuses a companion from a different channel', async () => {
    const response = await send('POST', '/saved-views', { surface: NAMED, name: 'Colors', filters: payload(), workingLayout: { surface: 'product-edit:layout:EBAY:IT', filters: payload() } })
    expect(response.statusCode).toBe(400)
    expect(db.rows).toEqual([])
  })

  it('rolls back a named update and default changes if the companion is stale', async () => {
    seed()
    seed({ id: 'old-default', name: 'Default', isDefault: true })
    seed({ id: 'working', surface: WORKING, name: 'Current layout' })
    const before = structuredClone(db.rows)
    const response = await send('PATCH', '/saved-views/view-1', { expectedUpdatedAt: stamp, filters: payload(['color']), isDefault: true, workingLayout: { surface: WORKING, filters: payload(), expectedUpdatedAt: null } })
    expect(response.statusCode).toBe(409)
    expect(db.rows).toEqual(before)
  })

  it('rolls back creation and default clearing on storage failure', async () => {
    seed({ isDefault: true })
    db.failCreateName = 'Current layout'
    const response = await send('POST', '/saved-views', { name: 'New default', surface: NAMED, filters: payload(), isDefault: true, workingLayout: { surface: WORKING, filters: payload() } })
    expect(response.statusCode).toBe(500)
    expect(db.rows).toHaveLength(1)
    expect(db.rows[0].isDefault).toBe(true)
  })

  it('keeps default changes scoped to the owner and surface', async () => {
    seed({ isDefault: true })
    seed({ id: 'bob', name: 'Bob', userId: 'bob', isDefault: true })
    seed({ id: 'master', surface: 'product-edit:views:master', isDefault: true })
    const response = await send('POST', '/saved-views', { name: 'New default', surface: NAMED, filters: payload(), isDefault: true })
    expect(response.statusCode).toBe(200)
    expect(db.rows.filter((row) => row.isDefault).map((row) => row.id)).toEqual(['bob', 'master', response.json().id])
    expect((await send('PATCH', '/saved-views/view-1', { expectedUpdatedAt: stamp, filters: payload() })).statusCode).toBe(409)
  })

  it('validates sheet payloads while retaining v2 and generic filter compatibility', async () => {
    const malformed = { ...payload(), columnOrder: ['color'] }
    expect((await send('POST', '/saved-views', { name: 'Bad', surface: NAMED, filters: malformed })).statusCode).toBe(400)
    expect((await send('POST', '/saved-views', { name: 'V2', surface: NAMED, filters: { v: 2, kind: 'columns', columns: ['color'] } })).statusCode).toBe(200)
    const generic = await send('POST', '/saved-views', { name: 'Catalog', filters: { status: 'ACTIVE' } })
    expect(generic.statusCode).toBe(200)
    expect((await send('PATCH', `/saved-views/${generic.json().id}`, { name: 'Renamed' })).statusCode).toBe(200)
  })
})

const PRODUCTS_NAMED = 'products-next'
const PRODUCTS_WORKING = 'products-next:layout'
const productsPayload = () => ({
  v: 1,
  gridState: { columnOrder: { orderedColIds: ['brand', 'color', 'size'] }, columnPinning: { leftColIds: ['brand'] } },
  page: { density: 'cozy', pageSize: 50, columnLayout: payload() },
})

describe('products grid durable layout parity', () => {
  it('keeps working layouts private to the operator, including the legacy operator', async () => {
    seed({ id: 'alice-layout', surface: PRODUCTS_WORKING, name: 'Current layout', filters: productsPayload() })
    seed({ id: 'bob-layout', surface: PRODUCTS_WORKING, name: 'Current layout', userId: 'bob', filters: productsPayload() })
    seed({ id: 'legacy-layout', surface: PRODUCTS_WORKING, name: 'Current layout', userId: 'default-user', filters: productsPayload() })
    expect((await send('GET', `/saved-views?surface=${PRODUCTS_WORKING}`)).json().items.map((row: Row) => row.id)).toEqual(['alice-layout'])
    expect((await send('GET', `/saved-views?surface=${PRODUCTS_WORKING}`, undefined, 'bob')).json().items.map((row: Row) => row.id)).toEqual(['bob-layout'])
    expect((await send('PATCH', '/saved-views/bob-layout', { expectedUpdatedAt: stamp, filters: productsPayload() })).statusCode).toBe(404)
    expect((await send('PATCH', '/saved-views/legacy-layout', { expectedUpdatedAt: stamp, filters: productsPayload() })).statusCode).toBe(404)
  })

  it('saves and returns a named view plus its complete working layout in one transaction', async () => {
    const filters = productsPayload()
    const response = await send('POST', '/saved-views', { name: 'Grouped catalog', surface: PRODUCTS_NAMED, filters, isDefault: true, workingLayout: { surface: PRODUCTS_WORKING, filters, expectedUpdatedAt: null } })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ surface: PRODUCTS_NAMED, filters, isDefault: true, workingLayout: { surface: PRODUCTS_WORKING, name: 'Current layout', filters, isDefault: false } })
    expect(db.rows).toHaveLength(2)
    expect(transaction).toHaveBeenCalledTimes(1)
  })

  it.each([PRODUCTS_NAMED, PRODUCTS_WORKING])('requires a current revision when updating %s', async (surface) => {
    seed({ surface, name: surface === PRODUCTS_WORKING ? 'Current layout' : 'Catalog', filters: productsPayload() })
    expect((await send('PATCH', '/saved-views/view-1', { filters: productsPayload() })).statusCode).toBe(400)
    expect((await send('PATCH', '/saved-views/view-1', { filters: productsPayload(), expectedUpdatedAt: '2026-09-04T10:00:00Z' })).statusCode).toBe(409)
    const response = await send('PATCH', '/saved-views/view-1', { filters: productsPayload(), expectedUpdatedAt: stamp })
    expect(response.statusCode).toBe(200)
    expect(response.json().updatedAt).not.toBe(stamp)
  })

  it('refuses duplicate working creation with instructions to reload', async () => {
    seed({ surface: PRODUCTS_WORKING, name: 'Current layout', filters: productsPayload() })
    const response = await send('POST', '/saved-views', { name: 'Current layout', surface: PRODUCTS_WORKING, filters: productsPayload() })
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toContain('Reload the saved layout')
    expect(db.rows).toHaveLength(1)
  })

  it('rolls back named changes and defaults when the working layout is stale', async () => {
    seed({ surface: PRODUCTS_NAMED, filters: productsPayload() })
    seed({ id: 'default', surface: PRODUCTS_NAMED, name: 'Default', isDefault: true, filters: productsPayload() })
    seed({ id: 'working', surface: PRODUCTS_WORKING, name: 'Current layout', filters: productsPayload() })
    const before = structuredClone(db.rows)
    const response = await send('PATCH', '/saved-views/view-1', { name: 'Changed', filters: productsPayload(), isDefault: true, expectedUpdatedAt: stamp, workingLayout: { surface: PRODUCTS_WORKING, filters: productsPayload(), expectedUpdatedAt: null } })
    expect(response.statusCode).toBe(409)
    expect(db.rows).toEqual(before)
  })

  it.each([
    [PRODUCTS_NAMED, WORKING],
    [NAMED, PRODUCTS_WORKING],
    [PRODUCTS_NAMED, `${PRODUCTS_WORKING}:IT`],
  ])('refuses a companion from %s to %s', async (surface, companionSurface) => {
    const response = await send('POST', '/saved-views', { name: 'Wrong scope', surface, filters: surface === PRODUCTS_NAMED ? productsPayload() : payload(), workingLayout: { surface: companionSurface, filters: productsPayload() } })
    expect(response.statusCode).toBe(400)
    expect(db.rows).toEqual([])
  })

  it('accepts a legacy named schema1 view and copies it without changing the shared source', async () => {
    const legacy = { v: 1, gridState: { columnVisibility: { hiddenColIds: ['size'] } }, page: { pageSize: 50 } }
    seed({ surface: PRODUCTS_NAMED, userId: 'default-user', filters: legacy })
    const response = await send('PATCH', '/saved-views/view-1', { name: 'Personal catalog', expectedUpdatedAt: stamp })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ userId: 'alice', filters: legacy, legacyShared: false })
    expect(response.json().id).not.toBe('view-1')
    expect(db.rows.find((row) => row.id === 'view-1')?.filters).toEqual(legacy)
  })

  it('requires complete schema3 metadata for a working layout', async () => {
    const missing = { v: 1, gridState: {}, page: { pageSize: 50 } }
    expect((await send('POST', '/saved-views', { name: 'Legacy named', surface: PRODUCTS_NAMED, filters: missing })).statusCode).toBe(200)
    expect((await send('POST', '/saved-views', { name: 'Current layout', surface: PRODUCTS_WORKING, filters: missing })).statusCode).toBe(400)
    const version2 = { ...productsPayload(), page: { columnLayout: { v: 2, kind: 'columns', columns: ['brand'] } } }
    expect((await send('POST', '/saved-views', { name: 'Current layout', surface: PRODUCTS_WORKING, filters: version2 })).statusCode).toBe(400)
    const malformed = { ...productsPayload(), page: { columnLayout: { ...payload(), lockedColumns: ['unknown-column'] } } }
    expect((await send('POST', '/saved-views', { name: 'Bad named', surface: PRODUCTS_NAMED, filters: malformed })).statusCode).toBe(400)
    expect((await send('POST', '/saved-views', { name: 'Current layout', surface: PRODUCTS_WORKING, filters: malformed })).statusCode).toBe(400)
  })

  it.each([
    { v: 1, gridState: [], page: {} },
    { v: 1, gridState: {}, page: null },
    { v: 2, gridState: {}, page: {} },
  ])('rejects malformed products grid envelopes', async (filters) => {
    expect((await send('POST', '/saved-views', { name: 'Bad envelope', surface: PRODUCTS_NAMED, filters })).statusCode).toBe(400)
  })
})
