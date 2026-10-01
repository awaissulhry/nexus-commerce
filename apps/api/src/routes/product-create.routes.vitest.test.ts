/**
 * `POST /api/products` — the Products page's "New product" dialog, against the production Prisma schema and the
 * business row policies (PGlite), with business profiles ON and two businesses.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'

const fixture = vi.hoisted(() => ({ database: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  fixture.database = await formulaDatabase()
  return { default: fixture.database.client }
})
vi.mock('../lib/queue.js', () => ({ addJobSafely: vi.fn(async () => ({ enqueued: true })), outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: null }))
vi.mock('../services/audit-log.service.js', () => ({ auditLogService: { write: vi.fn(async () => {}) } }))
vi.mock('../services/listing-events.service.js', () => ({ publishListingEvent: vi.fn() }))
import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { permissionForRoute } from '../lib/auth/permissions-manifest.js'
import { auditLogService } from '../services/audit-log.service.js'
import { publishListingEvent } from '../services/listing-events.service.js'
import { productReadCacheService } from '../services/product-read-cache.service.js'
import productCreateRoutes from './product-create.routes.js'

const OTHER = 'product_create_other_business'
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let app: FastifyInstance
let operator: string
const create = (payload: object, workspace = LEGACY_WORKSPACE_ID) =>
  app.inject({ method: 'POST', url: '/api/products', payload, headers: { 'x-test-workspace': workspace } })

beforeAll(async () => {
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  // A real member of both businesses: the row policies check the acting person's membership.
  operator = (await prisma.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active' } })).id
  await prisma.workspace.create({ data: { id: OTHER, name: 'Other business', createdByUserId: operator, creationKey: randomUUID() } })
  await prisma.workspaceMembership.createMany({ data: [LEGACY_WORKSPACE_ID, OTHER].map(workspaceId => ({ workspaceId, userId: operator, status: 'active' })) })
  app = Fastify()
  app.addHook('onRequest', (request, _reply, done) => {
    request.authUser = { id: operator } as never
    withWorkspace({ workspaceId: String(request.headers['x-test-workspace']), actorUserId: operator, membershipId: null, roleKeys: ['OWNER'] }, done)
  })
  await app.register(productCreateRoutes, { prefix: '/api' })
  await app.ready()
}, 120_000)
beforeEach(async () => {
  vi.clearAllMocks()
  for (const workspace of [LEGACY_WORKSPACE_ID, OTHER]) await inside(workspace, async () => {
    await prisma.productEvent.deleteMany()
    await prisma.productReadCache.deleteMany()
    await prisma.productListingAlias.deleteMany()
    await prisma.product.deleteMany()
    await prisma.productFamily.deleteMany()
  })
})
afterAll(async () => { await app.close(); vi.unstubAllEnvs(); await fixture.database.close() }, 30_000)

const stored = (id: string, workspace = LEGACY_WORKSPACE_ID) => inside(workspace, () => prisma.product.findUniqueOrThrow({ where: { id } }))

describe('POST /api/products', () => {
  it('needs products.create to write; the list stays products.view', () => {
    expect(permissionForRoute('POST', '/api/products')).toBe('products.create')
    expect(permissionForRoute('GET', '/api/products')).toBe('products.view')
    // Positive control: the plugin really registers the route the rule names.
    expect(app.hasRoute({ method: 'POST', url: '/api/products' })).toBe(true)
  })

  it('creates a single product as a DRAFT with the typed SKU, refreshes the list cache and tells open lists', async () => {
    const refresh = vi.spyOn(productReadCacheService, 'refreshInTransaction')
    const response = await create({ sku: '  GALE-JACKET ', name: ' Gale jacket ', kind: 'single' })
    expect(response.statusCode, response.body).toBe(201)
    const { id, sku } = response.json()
    expect(sku).toBe('GALE-JACKET')
    const product = await stored(id)
    expect(product).toMatchObject({ sku: 'GALE-JACKET', name: 'Gale jacket', status: 'DRAFT', isParent: false, parentId: null, familyId: null, deletedAt: null })
    expect(Number(product.basePrice)).toBe(0)
    expect(product.workspaceId).toBe(LEGACY_WORKSPACE_ID)
    // The list reads the cache: the new row is there at once, as a draft.
    expect(refresh).toHaveBeenCalledWith(expect.anything(), [id])
    expect(await inside(LEGACY_WORKSPACE_ID, () => prisma.productReadCache.findUniqueOrThrow({ where: { id } }))).toMatchObject({ sku: 'GALE-JACKET', status: 'DRAFT' })
    expect(await inside(LEGACY_WORKSPACE_ID, () => prisma.productEvent.findMany({ where: { aggregateId: id } }))).toEqual([
      expect.objectContaining({ eventType: 'PRODUCT_CREATED', aggregateType: 'Product', metadata: { source: 'OPERATOR', userId: operator } }),
    ])
    expect(publishListingEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'product.created', productId: id }))
    expect(auditLogService.write).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'Product', entityId: id, action: 'create', userId: operator }))
  })

  it('creates a product with variations as a parent in the chosen family', async () => {
    const family = await inside(LEGACY_WORKSPACE_ID, () => prisma.productFamily.create({ data: { code: 'motorcycle_jacket', label: 'Motorcycle jacket' } }))
    const response = await create({ sku: 'GALE', name: 'Gale', kind: 'parent', familyId: family.id })
    expect(response.statusCode, response.body).toBe(201)
    expect(await stored(response.json().id)).toMatchObject({ status: 'DRAFT', isParent: true, familyId: family.id })
  })

  it('refuses a SKU this business already has, and points at the product', async () => {
    const first = await create({ sku: 'GALE', name: 'Gale', kind: 'single' })
    const again = await create({ sku: 'GALE', name: 'Another', kind: 'parent' })
    expect(again.statusCode).toBe(409)
    expect(again.json()).toEqual({ error: 'GALE already exists in this business.', code: 'DUPLICATE_SKU', field: 'sku', productId: first.json().id })
    expect(await inside(LEGACY_WORKSPACE_ID, () => prisma.product.count())).toBe(1)
  })

  it('refuses the SKU of a deleted product without offering to open it', async () => {
    const first = await create({ sku: 'OLD', name: 'Old', kind: 'single' })
    await inside(LEGACY_WORKSPACE_ID, () => prisma.product.update({ where: { id: first.json().id }, data: { deletedAt: new Date() } }))
    const again = await create({ sku: 'OLD', name: 'Old', kind: 'single' })
    expect(again.statusCode).toBe(409)
    expect(again.json()).toEqual({ error: 'OLD belongs to a deleted product in this business. Choose another SKU.', code: 'DUPLICATE_SKU', field: 'sku' })
  })

  it('refuses the SKU of an active channel listing here; an archived listing does not hold it', async () => {
    const parent = await create({ sku: 'ROOT', name: 'Root', kind: 'parent' })
    await inside(LEGACY_WORKSPACE_ID, () => prisma.productListingAlias.createMany({ data: [
      { productId: parent.json().id, channel: 'EBAY', marketplace: 'IT', label: 'Second', position: 1, sku: 'EBAY-LISTING' },
      { productId: parent.json().id, channel: 'EBAY', marketplace: 'IT', label: 'Old', position: 2, sku: 'ARCHIVED-LISTING', status: 'ARCHIVED' },
    ] }))
    const taken = await create({ sku: 'EBAY-LISTING', name: 'Clash', kind: 'single' })
    expect(taken.statusCode).toBe(409)
    expect(taken.json()).toMatchObject({ field: 'sku', error: 'EBAY-LISTING is already the SKU of a channel listing in this business. Choose another SKU for the product.' })
    expect((await create({ sku: 'ARCHIVED-LISTING', name: 'Free', kind: 'single' })).statusCode).toBe(201)
  })

  it('refuses a family this business does not have, and creates nothing', async () => {
    const elsewhere = await inside(OTHER, () => prisma.productFamily.create({ data: { code: 'helmet', label: 'Helmet' } }))
    for (const familyId of ['no-such-family', elsewhere.id]) {
      const response = await create({ sku: 'FAM-1', name: 'Fam', kind: 'single', familyId })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ field: 'familyId', code: 'INVALID_REQUEST' })
    }
    expect(await inside(LEGACY_WORKSPACE_ID, () => prisma.product.count())).toBe(0)
  })

  it('names the field a typed value breaks', async () => {
    for (const [payload, field] of [
      [{ sku: 'GALE JACKET', name: 'Gale', kind: 'single' }, 'sku'],
      [{ sku: 'A'.repeat(101), name: 'Gale', kind: 'single' }, 'sku'],
      [{ sku: 'GALE', name: '   ', kind: 'single' }, 'name'],
      [{ sku: 'GALE', name: 'Gale', kind: 'bundle' }, 'kind'],
      [{ sku: 'GALE', name: 'Gale', kind: 'single', familyId: 42 }, 'familyId'],
    ] as const) {
      const response = await create(payload)
      expect(response.statusCode, JSON.stringify(payload)).toBe(400)
      expect(response.json().field).toBe(field)
    }
    expect((await app.inject({ method: 'POST', url: '/api/products', headers: { 'x-test-workspace': LEGACY_WORKSPACE_ID } })).json().field).toBe('sku')
  })

  it('keeps businesses apart: the same SKU can exist once in each', async () => {
    const mine = await create({ sku: 'SHARED-SKU', name: 'Mine', kind: 'single' })
    const theirs = await create({ sku: 'SHARED-SKU', name: 'Theirs', kind: 'single' }, OTHER)
    expect([mine.statusCode, theirs.statusCode]).toEqual([201, 201])
    expect((await stored(theirs.json().id, OTHER)).workspaceId).toBe(OTHER)
    expect(await inside(LEGACY_WORKSPACE_ID, () => prisma.product.findMany({ select: { name: true } }))).toEqual([{ name: 'Mine' }])
  })
})
