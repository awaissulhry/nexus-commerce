import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import compress from '@fastify/compress'
import { randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { formulaDatabase } from '../test-support/formula-database.js'
import { concurrentDatabase, concurrentDatabaseUrl } from '../test-support/concurrent-database.js'
import { LEGACY_WORKSPACE_ID, requireWorkspace, withWorkspace } from './workspace-context.js'

let database: Pick<Awaited<ReturnType<typeof formulaDatabase>>, 'client' | 'close'>
vi.mock('../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

const ROUTES = ['/api/products/bulk-replicate', '/api/pim/attach-to-parent', '/api/pim/promote-to-parent', '/api/categories/schema/download']
const BODY = { source: 'original-product' }
const WORKSPACE_B = 'command_receipt_workspace_b'
const workspaces = [LEGACY_WORKSPACE_ID, WORKSPACE_B]
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace({
  workspaceId, actorUserId: null, membershipId: null, roleKeys: [],
}, work)

/** Real SQL and tenant policies. Only verified identity/workspace middleware and
 * command handlers are fixtures; the idempotency hooks and database client are real. */
describe('durable API command idempotency', () => {
  let register: typeof import('./command-idempotency.js')['registerCommandIdempotency']
  let actorA: string
  let actorB: string
  let handlerRuns = 0
  const apps = new Set<FastifyInstance>()

  beforeAll(async () => {
    database = concurrentDatabaseUrl() ? await concurrentDatabase() : await formulaDatabase()
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    actorA = (await database.client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active' } })).id
    actorB = (await database.client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active' } })).id
    await database.client.workspace.create({ data: {
      id: WORKSPACE_B, name: 'Other command business', createdByUserId: actorA, creationKey: randomUUID(),
    } })
    await database.client.workspaceMembership.createMany({ data: workspaces.flatMap(workspaceId =>
      [actorA, actorB].map(userId => ({ workspaceId, userId, status: 'active' }))) })
    register = (await import('./command-idempotency.js')).registerCommandIdempotency
  }, 120_000)

  beforeEach(async () => {
    handlerRuns = 0
    for (const workspace of workspaces) await inside(workspace, async () => {
      await database.client.commandReceipt.deleteMany()
      await database.client.listingWizard.deleteMany()
      await database.client.product.deleteMany()
    })
  })

  afterEach(async () => {
    await Promise.all([...apps].map(app => app.close()))
    apps.clear()
  })
  afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)

  /** A command with a visible side effect: one product per run. */
  async function performCommand(_request: FastifyRequest, reply: FastifyReply) {
    handlerRuns++
    const product = await database.client.product.create({ data: {
      sku: `command-${randomUUID()}`, name: 'Command result', basePrice: 10,
    } })
    return reply.code(201).send({ id: product.id, message: 'Copiato ✓', run: handlerRuns })
  }

  async function makeApp(handler = performCommand, compressed = false) {
    const app = Fastify()
    apps.add(app)
    if (compressed) await app.register(compress, { global: true, threshold: 1024, encodings: ['gzip', 'deflate'] })
    app.addHook('onRequest', (request, reply, done) => {
      if (request.headers['x-test-denied'] === '1') { void reply.code(401).send({ error: 'Sign in required' }); return }
      withWorkspace({
        workspaceId: String(request.headers['x-test-workspace'] ?? LEGACY_WORKSPACE_ID),
        actorUserId: String(request.headers['x-test-actor'] ?? actorA), membershipId: null, roleKeys: ['OWNER'],
      }, done)
    })
    register(app)
    for (const route of [...ROUTES, '/api/listing-wizard/:id/submit']) app.post(route, {
      schema: { body: { type: 'object', required: ['source'], properties: { source: { type: 'string', minLength: 1 } } } },
    }, handler)
    await app.ready()
    return app
  }

  async function restart(app: FastifyInstance, handler = performCommand, compressed = false) {
    await app.close()
    apps.delete(app)
    return makeApp(handler, compressed)
  }

  const post = (app: FastifyInstance, url = ROUTES[0], key = 'one-command', payload: object = BODY, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, payload, headers: { 'idempotency-key': key, ...headers } })
  const receipts = (workspace = LEGACY_WORKSPACE_ID) => inside(workspace, () => database.client.commandReceipt.findMany())
  const products = (workspace = LEGACY_WORKSPACE_ID) => inside(workspace, () => database.client.product.count())
  /** Simulate the receipt window passing, without waiting for it. */
  const expireReceipts = () => inside(LEGACY_WORKSPACE_ID, () =>
    database.client.commandReceipt.updateMany({ data: { expiresAt: new Date(Date.now() - 1_000) } }))
  async function wizard() {
    return inside(LEGACY_WORKSPACE_ID, async () => {
      const product = await database.client.product.create({ data: { sku: randomUUID(), name: 'Wizard product', basePrice: 10 } })
      return database.client.listingWizard.create({ data: { productId: product.id, channels: [], channelsHash: randomUUID(), version: 1 } })
    })
  }

  it.each(ROUTES)('claims before %s can mutate and replays its result', async route => {
    const app = await makeApp(async (request, reply) => {
      const stored = await database.client.commandReceipt.findMany()
      expect(stored).toHaveLength(1)
      expect(stored[0]).toMatchObject({ status: 'pending', actorUserId: actorA, workspaceId: requireWorkspace().workspaceId })
      expect(await database.client.product.count()).toBe(0)
      return performCommand(request, reply)
    })
    const first = await post(app, route)
    expect(first.statusCode).toBe(201)
    const replay = await post(app, route)
    expect(replay.statusCode).toBe(201)
    expect(replay.json()).toEqual(first.json())
    expect(handlerRuns).toBe(1)
    expect(await products()).toBe(1)
    expect(await receipts()).toMatchObject([{ status: 'completed', httpStatus: 201 }])
  })

  it('replays from the database after a new server instance', async () => {
    const original = await makeApp()
    const first = await post(original)
    const restarted = await restart(original)
    const replay = await post(restarted)
    expect(replay.statusCode).toBe(201)
    expect(replay.json()).toEqual(first.json())
    expect(handlerRuns).toBe(1)
    expect(await products()).toBe(1)
  })

  it('encodes a replay for the client asking, not for the client that asked first', async () => {
    const message = 'Copiato ✓ '.repeat(256)
    const handler = async (_request: FastifyRequest, reply: FastifyReply) => {
      handlerRuns++
      await database.client.product.create({ data: { sku: randomUUID(), name: 'Compressed command result', basePrice: 10 } })
      return reply.code(202).send({ message })
    }
    const app = await makeApp(handler, true)
    const first = await post(app, ROUTES[0], 'compressed-command', BODY, { 'accept-encoding': 'gzip' })
    expect(first.statusCode).toBe(202)
    expect(first.headers['content-encoding']).toBe('gzip')
    expect(JSON.parse(gunzipSync(first.rawPayload).toString('utf8'))).toEqual({ message })

    const plain = await post(app, ROUTES[0], 'compressed-command')
    expect(plain.statusCode).toBe(202)
    expect(plain.headers['content-encoding']).toBeUndefined()
    expect(plain.json()).toEqual({ message })
    const gzipped = await post(app, ROUTES[0], 'compressed-command', BODY, { 'accept-encoding': 'gzip' })
    expect(gzipped.headers['content-encoding']).toBe('gzip')
    expect(JSON.parse(gunzipSync(gzipped.rawPayload).toString('utf8'))).toEqual({ message })
    expect(handlerRuns).toBe(1)
    expect(await products()).toBe(1)
  })

  it('allows only one handler while simultaneous same-key commands receive 409', async () => {
    let announce!: () => void
    let release!: () => void
    const entered = new Promise<void>(resolve => { announce = resolve })
    const continueHandler = new Promise<void>(resolve => { release = resolve })
    const app = await makeApp(async (request, reply) => {
      announce()
      await continueHandler
      return performCommand(request, reply)
    })
    const first = post(app)
    try {
      await Promise.race([entered, first.then(response => { throw new Error(`Handler did not start: HTTP ${response.statusCode}`) })])
      const competing = await Promise.all(Array.from({ length: 6 }, () => post(app)))
      expect(competing.map(response => response.statusCode)).toEqual(Array(6).fill(409))
      expect(competing[0].headers['retry-after']).toBe('1')
      expect(await products()).toBe(0)
      expect(await receipts()).toHaveLength(1)
    } finally { release() }
    expect((await first).statusCode).toBe(201)
    expect(handlerRuns).toBe(1)
    expect(await products()).toBe(1)
  })

  it.each(['body', 'query', 'actor'] as const)('refuses a reused key with a different %s', async difference => {
    const app = await makeApp()
    const first = await post(app)
    const changed = await post(app, difference === 'query' ? `${ROUTES[0]}?mode=other` : ROUTES[0], 'one-command',
      difference === 'body' ? { source: 'different-product' } : BODY,
      difference === 'actor' ? { 'x-test-actor': actorB } : {})
    expect(changed.statusCode).toBe(422)
    expect(handlerRuns).toBe(1)
    expect(await products()).toBe(1)
    expect((await post(app)).json()).toEqual(first.json())
  })

  it('refuses an explicit wizard key reused with different route parameters', async () => {
    const a = await wizard(), b = await wizard()
    const app = await makeApp()
    expect((await post(app, `/api/listing-wizard/${a.id}/submit`)).statusCode).toBe(201)
    expect((await post(app, `/api/listing-wizard/${b.id}/submit`)).statusCode).toBe(422)
    expect(handlerRuns).toBe(1)
  })

  it('isolates the same command key and responses by business', async () => {
    const app = await makeApp()
    const a = await post(app)
    const b = await post(app, ROUTES[0], 'one-command', BODY, { 'x-test-workspace': WORKSPACE_B })
    expect([a.statusCode, b.statusCode]).toEqual([201, 201])
    expect(a.json().id).not.toBe(b.json().id)
    expect(await products()).toBe(1)
    expect(await products(WORKSPACE_B)).toBe(1)
    const [receiptA] = await receipts(), [receiptB] = await receipts(WORKSPACE_B)
    expect(receiptA.id).not.toBe(receiptB.id)
    expect(await inside(LEGACY_WORKSPACE_ID, () => database.client.commandReceipt.findUnique({ where: { id: receiptB.id } }))).toBeNull()
    expect((await post(app)).json()).toEqual(a.json())
    expect(handlerRuns).toBe(2)
  })

  it('validates before claiming, so a corrected request can use the key', async () => {
    const app = await makeApp()
    expect((await post(app, ROUTES[0], 'correctable', {})).statusCode).toBe(400)
    expect(handlerRuns).toBe(0)
    expect(await receipts()).toHaveLength(0)
    expect((await post(app, ROUTES[0], 'correctable')).statusCode).toBe(201)
    expect(handlerRuns).toBe(1)
  })

  it('releases the key when the command fails, so the same request can be retried', async () => {
    let failNext = true
    const app = await makeApp(async (request, reply) => {
      if (failNext) { failNext = false; handlerRuns++; return reply.code(502).send({ error: 'Channel unavailable' }) }
      return performCommand(request, reply)
    })
    expect((await post(app)).statusCode).toBe(502)
    expect(await receipts()).toHaveLength(0)
    const retried = await post(app)
    expect(retried.statusCode).toBe(201)
    expect(handlerRuns).toBe(2)
    expect((await post(app)).json()).toEqual(retried.json())
    expect(handlerRuns).toBe(2)
  })

  it('releases the key when the handler throws', async () => {
    let throwNext = true
    const app = await makeApp(async (request, reply) => {
      if (throwNext) { throwNext = false; throw new Error('Unexpected failure') }
      return performCommand(request, reply)
    })
    expect((await post(app)).statusCode).toBe(500)
    expect(await receipts()).toHaveLength(0)
    expect((await post(app)).statusCode).toBe(201)
    expect(handlerRuns).toBe(1)
  })

  it('rejects an empty key before mutation and accepts a key of any length', async () => {
    const app = await makeApp()
    for (const key of ['', '   ']) expect((await post(app, ROUTES[0], key)).statusCode).toBe(400)
    expect(handlerRuns).toBe(0)
    expect(await receipts()).toHaveLength(0)
    // The web builds pim-attach keys from every selected id: 40 products exceed 1,000 characters.
    const contentKey = `pim-attach:parent:${Array.from({ length: 40 }, () => randomUUID()).join(',')}`
    expect((await post(app, ROUTES[1], contentKey)).statusCode).toBe(201)
    expect((await post(app, ROUTES[1], contentKey)).statusCode).toBe(201)
    expect(handlerRuns).toBe(1)
    expect((await receipts())[0].keyHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('keeps authentication ahead of a completed response replay', async () => {
    const app = await makeApp()
    expect((await post(app)).statusCode).toBe(201)
    const denied = await post(app, ROUTES[0], 'one-command', BODY, { 'x-test-denied': '1' })
    expect(denied.statusCode).toBe(401)
    expect(denied.json()).toEqual({ error: 'Sign in required' })
    expect(handlerRuns).toBe(1)
  })

  it('refuses a duplicate of an interrupted command until its window closes, then runs it', async () => {
    const original = await makeApp()
    expect((await post(original)).statusCode).toBe(201)
    // The crash window: the command ran, its response was never stored.
    await inside(LEGACY_WORKSPACE_ID, () => database.client.commandReceipt.updateMany({ data: { status: 'pending', httpStatus: null, response: null } }))
    const restarted = await restart(original)
    expect((await post(restarted)).statusCode).toBe(409)
    expect(handlerRuns).toBe(1)
    await expireReceipts()
    expect((await post(restarted)).statusCode).toBe(201)
    expect(handlerRuns).toBe(2)
    expect(await receipts()).toMatchObject([{ status: 'completed' }])
  })

  it('runs a deliberate repeat once the window has closed', async () => {
    // attach → detach → attach again sends the same content-built key and body.
    const app = await makeApp()
    const first = await post(app, ROUTES[1], 'pim-attach:parent:a,b')
    await expireReceipts()
    const again = await post(app, ROUTES[1], 'pim-attach:parent:a,b')
    expect(again.statusCode).toBe(201)
    expect(again.json().id).not.toBe(first.json().id)
    expect(handlerRuns).toBe(2)
    expect(await receipts()).toHaveLength(1)
  })

  it('keys a keyless wizard submit on the saved wizard state', async () => {
    const draft = await wizard()
    const url = `/api/listing-wizard/${draft.id}/submit`
    const app = await makeApp()
    const first = await app.inject({ method: 'POST', url, payload: BODY })
    expect(first.statusCode).toBe(201)
    const duplicate = await app.inject({ method: 'POST', url, payload: BODY })
    expect(duplicate.json()).toEqual(first.json())
    expect(handlerRuns).toBe(1)
    // A submit (or an edit) saves the wizard; the next submit is a new command,
    // so a deliberate retry after a FAILED result runs instead of replaying it.
    await inside(LEGACY_WORKSPACE_ID, () => database.client.listingWizard.update({ where: { id: draft.id }, data: { status: 'FAILED' } }))
    const retry = await app.inject({ method: 'POST', url, payload: BODY })
    expect(retry.statusCode).toBe(201)
    expect(retry.json().id).not.toBe(first.json().id)
    expect(handlerRuns).toBe(2)
    expect(await receipts()).toHaveLength(2)
  })

  it('lets a keyless wizard submit for a missing wizard reach the route', async () => {
    const app = await makeApp(async (_request, reply) => reply.code(404).send({ error: 'Wizard not found' }))
    const missing = await app.inject({ method: 'POST', url: `/api/listing-wizard/${randomUUID()}/submit`, payload: BODY })
    expect(missing.statusCode).toBe(404)
    expect(await receipts()).toHaveLength(0)
  })

  it('expires receipts in the nightly retention sweep, with or without a privacy policy', async () => {
    vi.stubEnv('NEXUS_ENABLE_RETENTION_SWEEP', '1')
    const app = await makeApp()
    await post(app, ROUTES[0], 'old')
    await expireReceipts()
    await post(app, ROUTES[0], 'current')
    const { runRetentionSweepOnce } = await import('../jobs/data-retention-sweep.job.js')
    const summary = await inside(LEGACY_WORKSPACE_ID, () => runRetentionSweepOnce())
    expect(summary.deletedByKey.commandReceipts).toBe(1)
    expect(await receipts()).toHaveLength(1)
  })
})
