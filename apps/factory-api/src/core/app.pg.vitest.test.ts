import type { FastifyInstance } from 'fastify'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import { LOCAL_COOKIE_SECRET } from '../env'
import { buildApp, type AppConfig } from './app'
import { requireContext, testAuthenticator, type SessionContext } from './context'
import { defineManifest, defineRoutes } from './manifest'

/**
 * The API on the local stack: a throwaway PostgreSQL 17 database built from the migrations (runtime login
 * factory_app, audited at open) and the local Redis. Run with `node scripts/factory/run-pg-tests.mjs apps/factory-api`.
 */

const CONFIG: AppConfig = { environment: 'test', webOrigin: 'http://localhost:3200', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET }
// Loopback only, like every factory test; the stack's Redis (infra/factory/docker-compose.yml).
const REDIS_URL = 'redis://127.0.0.1:6399'

let db: MigratedDatabase
let database: FactoryDatabase
let redis: Redis
const apps: FastifyInstance[] = []
const tenantA = newId()
const tenantB = newId()
const user = newId()

beforeAll(async () => {
  db = await migratedDatabase('api_core')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  redis = new Redis(REDIS_URL, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1 })
  await redis.connect()
  // The admin login (superuser) writes the fixture rows; the API reads them through factory_app only.
  for (const [tenantId, slug] of [
    [tenantA, 'api-a'],
    [tenantB, 'api-b'],
  ] as const) {
    await db.admin.query('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenantId, slug])
    for (const code of ['C1', 'C2']) {
      await db.admin.query('INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, $3, $4)', [
        newId(),
        tenantId,
        code,
        `${slug} ${code}`,
      ])
    }
  }
}, 60_000)

afterAll(async () => {
  for (const app of apps.splice(0)) await app.close()
  await database?.close()
  redis?.disconnect()
  await db?.close()
})

const session = (tenantId: string): SessionContext => ({
  audience: 'office',
  tenantId,
  actorId: user,
  grants: [{ permissions: ['companies.view'], companies: 'all', sites: 'all', parties: 'all' }],
})
const sessions = testAuthenticator((request) => {
  const tenant = request.headers['x-test-tenant']
  return tenant === 'a' ? session(tenantA) : tenant === 'b' ? session(tenantB) : null
})

const companyRoutes = defineRoutes(
  'companies',
  defineManifest({ 'GET /companies': { audiences: ['office'], permission: 'companies.view', scope: 'record' } }),
  async (app) => {
    app.get('/companies', async (request) => {
      requireContext(request)
      const rows = await request.withClient((client) => client.company.findMany({ select: { legalName: true }, orderBy: { legalName: 'asc' } }))
      return { companies: rows.map((row) => row.legalName) }
    })
  },
)

async function boot(redisClient: Redis | undefined = redis): Promise<FastifyInstance> {
  const app = await buildApp(CONFIG, { database, redis: redisClient, authenticate: sessions, routes: [companyRoutes] })
  apps.push(app)
  return app
}

describe('/ready on the local stack', () => {
  it('is 200 when the database (as factory_app) and Redis answer', async () => {
    const app = await boot()
    const response = await app.inject({ method: 'GET', url: '/ready' })
    expect(response.json()).toEqual({ status: 'ready', checks: { database: 'ok', redis: 'ok' } })
    expect(response.statusCode).toBe(200)
  })

  it('is 503 when Redis does not answer, and says which check failed', async () => {
    const down = new Redis('redis://127.0.0.1:1', { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0 })
    down.on('error', () => {})
    try {
      const app = await boot(down)
      const response = await app.inject({ method: 'GET', url: '/ready' })
      expect(response.statusCode).toBe(503)
      expect(response.json()).toEqual({ status: 'not_ready', checks: { database: 'ok', redis: 'failed' } })
    } finally {
      down.disconnect()
    }
  })
})

describe('context → scoped client on the real database', () => {
  it('an office session reads only its own tenant (row-level security through the context scope)', async () => {
    const app = await boot()
    const a = await app.inject({ method: 'GET', url: '/companies', headers: { 'x-test-tenant': 'a' } })
    expect(a.json()).toEqual({ companies: ['api-a C1', 'api-a C2'] })
    const b = await app.inject({ method: 'GET', url: '/companies', headers: { 'x-test-tenant': 'b' } })
    expect(b.json()).toEqual({ companies: ['api-b C1', 'api-b C2'] })
  })

  it('a request without a session never reaches the database', async () => {
    const app = await boot()
    const response = await app.inject({ method: 'GET', url: '/companies' })
    expect(response.statusCode).toBe(401)
  })
})
