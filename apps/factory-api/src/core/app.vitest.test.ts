import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { FactoryDatabase, FactoryScope } from '@nexus/factory-db'
import { input, output } from '@nexus/factory-domain/core/contracts'
import { ConflictError, InvalidStateError } from '@nexus/factory-domain/core/errors'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { fixedClock } from '@nexus/factory-domain/core/time'
import { LOCAL_COOKIE_SECRET } from '../env'
import { buildApp, type AppConfig, type AppDependencies } from './app'
import { routesFiles } from './autoload'
import { requireContext, testAuthenticator, type SessionContext } from './context'
import { defineManifest, defineRoutes, PUBLIC, SIGNED_IN } from './manifest'

const CONFIG: AppConfig = {
  environment: 'test',
  webOrigin: 'http://localhost:3200',
  trustProxyHops: 0,
  cookieSecret: LOCAL_COOKIE_SECRET,
}
const TENANT = '0190f5c2-0000-7000-8000-000000000001'
const USER = '0190f5c2-0000-7000-8000-0000000000aa'
const COMPANY_A = '0190f5c2-0000-7000-8000-00000000000a'
const COMPANY_B = '0190f5c2-0000-7000-8000-00000000000b'
const SITE = '0190f5c2-0000-7000-8000-000000000101'
const PARTY = '0190f5c2-0000-7000-8000-000000000201'

const apps: FastifyInstance[] = []
const folders: string[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

async function boot(dependencies: AppDependencies = {}, config: AppConfig = CONFIG): Promise<FastifyInstance> {
  const app = await buildApp(config, dependencies)
  apps.push(app)
  return app
}

const grant = (permissions: Grant['permissions'], scope: Partial<Omit<Grant, 'permissions'>> = {}): Grant => ({
  permissions,
  companies: 'all',
  sites: 'all',
  parties: 'all',
  ...scope,
})

/** Sessions by a test header: `x-test-session: office-a` and so on. */
const SESSIONS: Record<string, SessionContext> = {
  'office-a': {
    audience: 'office',
    tenantId: TENANT,
    actorId: USER,
    companyId: COMPANY_A,
    grants: [grant(['quotes.view', 'quotes.send'], { companies: [COMPANY_A] })],
  },
  'office-b': {
    audience: 'office',
    tenantId: TENANT,
    actorId: USER,
    companyId: COMPANY_B,
    grants: [grant(['quotes.view', 'quotes.send'], { companies: [COMPANY_A] })],
  },
  'office-nocompany': { audience: 'office', tenantId: TENANT, actorId: USER, grants: [grant(['quotes.view'])] },
  'office-viewer': { audience: 'office', tenantId: TENANT, actorId: USER, companyId: COMPANY_A, grants: [grant(['quotes.view'])] },
  floor: { audience: 'floor', tenantId: TENANT, actorId: USER, siteId: SITE, deviceId: USER, grants: [grant(['scans.record'])] },
  partner: { audience: 'partner', tenantId: TENANT, actorId: USER, partyId: PARTY, grants: [grant(['quotes.view'])] },
  broken: { audience: 'office', tenantId: TENANT, grants: [] } as unknown as SessionContext,
}
const sessionsByHeader = testAuthenticator((request) => {
  const name = request.headers['x-test-session']
  return typeof name === 'string' ? (SESSIONS[name] ?? null) : null
})

const quotesManifest = defineManifest({
  'GET /quotes': { audiences: ['office', 'partner'], permission: 'quotes.view', scope: 'record' },
  'POST /quotes/send': { audiences: ['office'], permission: 'quotes.send', scope: 'company' },
  'GET /me': { audiences: ['office', 'floor', 'partner'], permission: SIGNED_IN, scope: 'tenant' },
  'POST /echo': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  'GET /fail/:kind': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
})
const quotesRoutes = defineRoutes('quotes', quotesManifest, async (app) => {
  app.get('/quotes', async (request) => ({ audience: requireContext(request).audience }))
  app.post('/quotes/send', async () => ({ sent: true }))
  app.get('/me', async (request) => ({ requestId: requireContext(request).requestId }))
  app.post(
    '/echo',
    { schema: { body: input({ name: z.string().min(2), qty: z.string() }), response: { 200: output({ name: z.string() }) } } },
    async (request) => ({ name: request.body.name, secret: 'stripped by the output contract' }),
  )
  app.get('/fail/:kind', async (request) => {
    const { kind } = request.params as { kind: string }
    if (kind === 'conflict') throw new ConflictError('Code Q-1 is taken.')
    if (kind === 'state') throw new InvalidStateError('A sent quote cannot be edited.')
    throw new Error('relation "Quote" does not exist at SELECT * FROM "Quote" WHERE password = \'hunter2\'')
  })
})

describe('boot', () => {
  it('answers /health with the server time', async () => {
    const app = await boot({ clock: fixedClock('2026-10-28T09:15:00.000Z') })
    const response = await app.inject({ method: 'GET', url: '/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok', time: '2026-10-28T09:15:00.000Z' })
  })

  it('answers /ready 503 without a database or Redis', async () => {
    const app = await boot()
    const response = await app.inject({ method: 'GET', url: '/ready' })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ status: 'not_ready', checks: { database: 'not_configured', redis: 'not_configured' } })
  })

  it('answers an unknown route with route_not_found and the request id', async () => {
    const app = await boot()
    const response = await app.inject({ method: 'GET', url: '/nothing-here' })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({
      error: { code: 'route_not_found', message: 'There is no such route.', requestId: response.headers['x-request-id'] },
    })
  })

  it('serves no HEAD twin of a GET route', async () => {
    const app = await boot()
    expect((await app.inject({ method: 'HEAD', url: '/health' })).statusCode).toBe(404)
  })

  it('lists every route with its manifest entry', async () => {
    const app = await boot({ routes: [quotesRoutes] })
    expect(app.factoryRouteManifest.routes().map(([key]) => key).sort()).toEqual([
      'GET /fail/:kind',
      'GET /health',
      'GET /me',
      'GET /quotes',
      'GET /ready',
      'POST /echo',
      'POST /quotes/send',
    ])
  })
})

describe('the route manifest stops the boot', () => {
  it('when a route has no entry', async () => {
    const routes = defineRoutes('demo', defineManifest({}), async (app) => {
      app.get('/unlisted', async () => ({}))
    })
    await expect(boot({ routes: [routes] })).rejects.toThrow(/GET \/unlisted has no manifest entry/)
  })

  it('when a route is registered outside defineRoutes', async () => {
    const plain = async (app: FastifyInstance) => {
      app.post('/plain', async () => ({}))
    }
    await expect(boot({ routes: [plain] })).rejects.toThrow(/POST \/plain has no manifest entry/)
  })

  it('when an entry has no route', async () => {
    const routes = defineRoutes(
      'demo',
      defineManifest({ 'GET /promised': { audiences: ['office'], permission: 'demo.view', scope: 'tenant' } }),
      async () => {},
    )
    await expect(boot({ routes: [routes] })).rejects.toThrow(/Manifest entries without a route: GET \/promised/)
  })

  it('when two modules declare the same route', async () => {
    const manifest = defineManifest({ 'GET /twice': { audiences: ['office'], permission: 'demo.view', scope: 'tenant' } })
    const first = defineRoutes('first', manifest, async (app) => {
      app.get('/twice', async () => ({}))
    })
    const second = defineRoutes('second', manifest, async () => {})
    await expect(boot({ routes: [first, second] })).rejects.toThrow(/GET \/twice is declared twice \(first and second\)/)
  })

  it('when a test authenticator is used outside FACTORY_ENV=test', async () => {
    await expect(boot({ authenticate: sessionsByHeader }, { ...CONFIG, environment: 'local' })).rejects.toThrow(
      /test authenticator is refused with FACTORY_ENV=local/,
    )
  })
})

describe('routes from src/platform and src/modules', () => {
  const manifestModule = fileURLToPath(new URL('./manifest.ts', import.meta.url))

  function tree(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'factory-routes-'))
    folders.push(root)
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true })
      writeFileSync(join(root, path), content)
    }
    return root
  }
  const routesModule = (name: string, path: string, body: string) => ({
    [`${name}/manifest.ts`]: `import { defineManifest } from ${JSON.stringify(manifestModule)}
export const manifest = defineManifest({ 'GET ${path}': { audiences: 'public', permission: 'public', scope: 'none' } })`,
    [`${name}/routes.ts`]: `import { defineRoutes } from ${JSON.stringify(manifestModule)}
import { manifest } from './manifest'
export default defineRoutes(${JSON.stringify(name)}, manifest, async (app) => { app.get('${path}', async () => (${body})) })`,
  })

  it('registers every routes file of both roots, with its manifest', async () => {
    const root = tree({
      ...routesModule('platform/numbering', '/numbering', '{ from: "platform" }'),
      ...routesModule('modules/gauges', '/gauges', '{ from: "modules" }'),
      'modules/gauges/routes.vitest.test.ts': 'throw new Error("a test file is never loaded as routes")',
      'modules/gauges/service.ts': 'throw new Error("only routes files are loaded")',
      'modules/gauges/deeper/routes.ts': 'throw new Error("only one folder level is loaded")',
      'elsewhere/stray/routes.ts': 'throw new Error("only platform and modules are route roots")',
    })
    const app = await boot({ routesRoot: root })
    expect((await app.inject({ method: 'GET', url: '/numbering' })).json()).toEqual({ from: 'platform' })
    expect((await app.inject({ method: 'GET', url: '/gauges' })).json()).toEqual({ from: 'modules' })
  })

  it('finds the files platform first, each root in name order', () => {
    const root = tree({
      'modules/b/routes.ts': '',
      'modules/a/routes.ts': '',
      'platform/z/routes.ts': '',
      'platform/auth/routes.js': '',
    })
    expect(routesFiles(root).map((file) => file.slice(root.length + 1))).toEqual([
      join('platform', 'auth', 'routes.js'),
      join('platform', 'z', 'routes.ts'),
      join('modules', 'a', 'routes.ts'),
      join('modules', 'b', 'routes.ts'),
    ])
  })

  it('refuses a folder with two routes files', () => {
    const root = tree({ 'platform/auth/routes.ts': '', 'platform/auth/routes.js': '' })
    expect(() => routesFiles(root)).toThrow(/platform\/auth has more than one routes file/)
  })

  it('refuses a routes file that does not export defineRoutes', async () => {
    const root = tree({ 'platform/loose/routes.ts': 'export default async function loose() {}' })
    await expect(boot({ routesRoot: root })).rejects.toThrow(/must default-export defineRoutes/)
  })

  it('a route of a module without its entry stops the boot', async () => {
    const root = tree({
      ...routesModule('modules/quotes', '/quotes', '{}'),
      'modules/quotes/routes.ts': `import { defineRoutes } from ${JSON.stringify(manifestModule)}
import { manifest } from './manifest'
export default defineRoutes('quotes', manifest, async (app) => {
  app.get('/quotes', async () => ({}))
  app.post('/quotes', async () => ({}))
})`,
    })
    await expect(boot({ routesRoot: root })).rejects.toThrow(/POST \/quotes has no manifest entry/)
  })

  it('treats missing roots as no routes', async () => {
    const app = await boot({ routesRoot: tree({}) })
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200)
  })
})

describe('access check before the handler', () => {
  const session = (name: string) => ({ 'x-test-session': name })

  it('401 without a session, on every route that is not public', async () => {
    const app = await boot({ routes: [quotesRoutes] })
    for (const [method, url] of [
      ['GET', '/quotes'],
      ['POST', '/quotes/send'],
      ['GET', '/me'],
    ] as const) {
      const response = await app.inject({ method, url })
      expect(response.statusCode).toBe(401)
      expect(response.json().error.code).toBe('unauthenticated')
    }
  })

  it('401 by default: the app has no sessions until the sign-in step', async () => {
    const app = await boot({ routes: [quotesRoutes] })
    expect((await app.inject({ method: 'GET', url: '/quotes', headers: session('office-a') })).statusCode).toBe(401)
  })

  it('lets a listed audience with the permission through', async () => {
    const app = await boot({ routes: [quotesRoutes], authenticate: sessionsByHeader })
    const response = await app.inject({ method: 'GET', url: '/quotes', headers: session('partner') })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ audience: 'partner' })
  })

  it('403 for an audience the route does not list', async () => {
    const app = await boot({ routes: [quotesRoutes], authenticate: sessionsByHeader })
    const response = await app.inject({ method: 'GET', url: '/quotes', headers: session('floor') })
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('forbidden')
  })

  it('403 without the permission', async () => {
    const app = await boot({ routes: [quotesRoutes], authenticate: sessionsByHeader })
    expect((await app.inject({ method: 'POST', url: '/quotes/send', headers: session('office-viewer') })).statusCode).toBe(403)
  })

  it('checks a company scope against the grants', async () => {
    const app = await boot({ routes: [quotesRoutes], authenticate: sessionsByHeader })
    expect((await app.inject({ method: 'POST', url: '/quotes/send', headers: session('office-a') })).json()).toEqual({ sent: true })
    expect((await app.inject({ method: 'POST', url: '/quotes/send', headers: session('office-b') })).statusCode).toBe(403)
    const none = await app.inject({ method: 'POST', url: '/quotes/send', headers: session('office-nocompany') })
    expect(none.statusCode).toBe(403)
    expect(none.json().error.message).toMatch(/inside one company/)
  })

  it('a signed-in route needs a session, not a permission; the context carries the request id', async () => {
    const app = await boot({ routes: [quotesRoutes], authenticate: sessionsByHeader })
    const response = await app.inject({ method: 'GET', url: '/me', headers: session('floor') })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ requestId: response.headers['x-request-id'] })
  })

  it('answers 500 for an incomplete session context (a bug), without details of it', async () => {
    const app = await boot({ routes: [quotesRoutes], authenticate: sessionsByHeader })
    const response = await app.inject({ method: 'GET', url: '/quotes', headers: session('broken') })
    expect(response.statusCode).toBe(500)
    expect(response.json().error).toMatchObject({ code: 'internal_error' })
  })

  it('refuses before the body is read', async () => {
    const app = await boot({ routes: [quotesRoutes], authenticate: sessionsByHeader })
    const response = await app.inject({
      method: 'POST',
      url: '/quotes/send',
      headers: { 'content-type': 'application/json' },
      payload: '{ not json',
    })
    expect(response.statusCode).toBe(401)
  })
})

describe('contracts and error mapping', () => {
  it('validates the body with the zod contract and lists the issues', async () => {
    const app = await boot({ routes: [quotesRoutes] })
    const response = await app.inject({ method: 'POST', url: '/echo', payload: { name: 'x', qty: 3, extra: true } })
    expect(response.statusCode).toBe(400)
    const { error } = response.json()
    expect(error.code).toBe('validation_failed')
    expect(error.issues.map((issue: { path: string }) => issue.path).sort()).toEqual(['body', 'body/name', 'body/qty'])
  })

  it('strips unknown keys from a response', async () => {
    const app = await boot({ routes: [quotesRoutes] })
    const response = await app.inject({ method: 'POST', url: '/echo', payload: { name: 'Alpha', qty: '3' } })
    expect(response.json()).toEqual({ name: 'Alpha' })
  })

  it('turns domain errors into their codes and keeps their messages', async () => {
    const app = await boot({ routes: [quotesRoutes] })
    const conflict = await app.inject({ method: 'GET', url: '/fail/conflict' })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().error).toMatchObject({ code: 'conflict', message: 'Code Q-1 is taken.' })
    const state = await app.inject({ method: 'GET', url: '/fail/state' })
    expect(state.statusCode).toBe(409)
    expect(state.json().error.code).toBe('invalid_state')
  })

  it('never sends a stack trace, SQL or a driver message', async () => {
    const app = await boot({ routes: [quotesRoutes] })
    const response = await app.inject({ method: 'GET', url: '/fail/sql' })
    expect(response.statusCode).toBe(500)
    expect(response.json()).toEqual({
      error: {
        code: 'internal_error',
        message: 'Something went wrong. The error was logged.',
        requestId: response.headers['x-request-id'],
      },
    })
    expect(response.body).not.toMatch(/SELECT|Quote|hunter2|at |\.ts/)
  })

  it('answers malformed JSON with bad_request and a foreign content type with unsupported_media_type', async () => {
    const app = await boot({ routes: [quotesRoutes] })
    const bad = await app.inject({ method: 'POST', url: '/echo', headers: { 'content-type': 'application/json' }, payload: '{ nope' })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error.code).toBe('bad_request')
    expect(bad.body).not.toMatch(/Unexpected token|JSON\.parse/)
    const xml = await app.inject({ method: 'POST', url: '/echo', headers: { 'content-type': 'application/xml' }, payload: '<a/>' })
    expect(xml.statusCode).toBe(415)
    expect(xml.json().error.code).toBe('unsupported_media_type')
  })
})

describe('the database through the context', () => {
  function recordingDatabase(): FactoryDatabase & { scopes: FactoryScope[] } {
    const scopes: FactoryScope[] = []
    return {
      scopes,
      async withScope(scope, work) {
        scopes.push(scope)
        return work({} as never)
      },
      async close() {},
    }
  }
  const dataManifest = defineManifest({
    'GET /data': { audiences: ['office'], permission: 'quotes.view', scope: 'record' },
    'GET /data/public': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  })
  const dataRoutes = defineRoutes('data', dataManifest, async (app) => {
    app.get('/data', async (request) => request.withClient(async () => ({ ok: true })))
    app.get('/data/public', async (request) => request.withClient(async () => ({ leaked: true })))
  })

  it('a request with a session reaches the client of its scope', async () => {
    const database = recordingDatabase()
    const app = await boot({ routes: [dataRoutes], database, authenticate: sessionsByHeader })
    expect((await app.inject({ method: 'GET', url: '/data', headers: { 'x-test-session': 'office-a' } })).json()).toEqual({ ok: true })
    expect(database.scopes).toEqual([{ audience: 'office', tenantId: TENANT, actorId: USER }])
  })

  it('a request without a session never reaches a tenant client (fail closed)', async () => {
    const database = recordingDatabase()
    const app = await boot({ routes: [dataRoutes], database, authenticate: sessionsByHeader })
    const response = await app.inject({ method: 'GET', url: '/data/public' })
    expect(response.statusCode).toBe(401)
    expect(database.scopes).toEqual([])
  })
})
