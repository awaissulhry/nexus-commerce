/**
 * BN.0.3 — GET /amazon/flat-file/browse-nodes (route)
 *
 * The route uses a module-level singleton:
 *   const schemaService = new CategorySchemaService(prisma, amazon)
 * so we stub the class with vi.mock + vi.hoisted (no injectable deps).
 * We also stub productEventService to prevent BullMQ/Redis connections.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.hoisted: the fn must exist before vi.mock factories run (which are
// hoisted above imports by Vitest). Variables in normal module scope
// would be TDZ at factory execution time.
const mockGetSchema = vi.hoisted(() => vi.fn())

vi.mock('../services/categories/schema-sync.service.js', () => ({
  // Use a class so `new CategorySchemaService(...)` works without warnings.
  // The class field closes over the hoisted vi.fn() so mockReset() in
  // beforeEach clears recorded calls while the reference stays stable.
  CategorySchemaService: class {
    getSchema = mockGetSchema
  },
}))

// Prevent BullMQ / ioredis connections during test (product-event.service
// imports queue.js which constructs Queue instances eagerly at module load).
vi.mock('../services/product-event.service.js', () => ({
  productEventService: {
    emit: vi.fn(),
    emitMany: vi.fn(),
    emitTx: vi.fn(),
    emitManyTx: vi.fn(),
  },
}))

import Fastify from 'fastify'
import amazonFlatFileRoutes from './amazon-flat-file.routes.js'

describe('GET /amazon/flat-file/browse-nodes', () => {
  beforeEach(() => {
    mockGetSchema.mockReset()
  })

  it('returns nodes from the PTD enum (source=schema)', async () => {
    mockGetSchema.mockResolvedValue({
      schemaDefinition: {
        properties: {
          recommended_browse_nodes: {
            items: {
              properties: {
                value: {
                  enum: ['2420941031'],
                  enumNames: ['… > Giacche'],
                },
              },
            },
          },
        },
      },
      fetchedAt: '2026-06-30T00:00:00Z',
    })

    const app = Fastify()
    await app.register(amazonFlatFileRoutes)

    const res = await app.inject({
      method: 'GET',
      url: '/amazon/flat-file/browse-nodes?marketplace=IT&productType=COAT',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.source).toBe('schema')
    expect(body.nodes).toEqual([{ id: '2420941031', path: '… > Giacche', label: '… > Giacche' }])
    expect(body.marketplace).toBe('IT')
    expect(body.productType).toBe('COAT')
  })

  it('400 when productType is missing', async () => {
    const app = Fastify()
    await app.register(amazonFlatFileRoutes)

    const res = await app.inject({
      method: 'GET',
      url: '/amazon/flat-file/browse-nodes?marketplace=IT',
    })
    expect(res.statusCode).toBe(400)
  })

  it('source=none + nodes=[] when enum is absent from schema', async () => {
    mockGetSchema.mockResolvedValue({
      schemaDefinition: { properties: {} },
      fetchedAt: '2026-06-30T00:00:00Z',
    })

    const app = Fastify()
    await app.register(amazonFlatFileRoutes)

    const res = await app.inject({
      method: 'GET',
      url: '/amazon/flat-file/browse-nodes?marketplace=IT&productType=WIDGET',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.source).toBe('none')
    expect(body.nodes).toEqual([])
  })

  it('returns 200 with valid ISO fetchedAt when schema has no fetchedAt (null-safe guard)', async () => {
    mockGetSchema.mockResolvedValue({
      schemaDefinition: { properties: {} },
      // fetchedAt intentionally absent (undefined)
    })

    const app = Fastify()
    await app.register(amazonFlatFileRoutes)

    const res = await app.inject({
      method: 'GET',
      url: '/amazon/flat-file/browse-nodes?marketplace=IT&productType=NOFETCHEDAT',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Number.isFinite(Date.parse(body.fetchedAt))).toBe(true)
  })

  it('honors ?force=1: passes { force: true } to getSchema', async () => {
    mockGetSchema.mockResolvedValue({
      schemaDefinition: { properties: {} },
      fetchedAt: '2026-06-30T00:00:00Z',
    })

    const app = Fastify()
    await app.register(amazonFlatFileRoutes)

    // Use a distinct productType so the module-level browseNodeCache never
    // serves a cached entry seeded by another test.
    await app.inject({
      method: 'GET',
      url: '/amazon/flat-file/browse-nodes?marketplace=IT&productType=FORCEPT1&force=1',
    })
    await app.inject({
      method: 'GET',
      url: '/amazon/flat-file/browse-nodes?marketplace=IT&productType=FORCEPT2&force=1',
    })

    // Both calls should have reached getSchema with force: true as second arg
    const calls = mockGetSchema.mock.calls
    const forceCalls = calls.filter((c) => c[1]?.force === true)
    expect(forceCalls.length).toBeGreaterThanOrEqual(2)
  })
})
