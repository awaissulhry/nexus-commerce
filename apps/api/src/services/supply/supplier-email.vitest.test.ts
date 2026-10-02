/**
 * MCP full control 08 S9 — an e-mail to a supplier, for the supplier page and for Claude.
 *
 *   Route: `POST /api/fulfillment/suppliers/:id/comms/email` answers as before now that the send and its comms-log entry
 *   live in services/supply/supplier-email.service.ts (written against the route before the move, unchanged after it).
 *   Tool: email-supplier through the doors a person uses (runOrQueueTool, then the Approvals page's schedule and commit):
 *   the supplier's own address on file, at most one of its POs (one approval per PO), from the business's identity
 *   (refused without one), a dry run unless outbound e-mail is on, logged as sent by the person who approved it.
 *
 * Real SQL (PGlite with the production schema); the e-mail transport is the real one (a dry run: outbound e-mail is off
 * here), watched so the sender it is handed can be read.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

const stand = vi.hoisted(() => ({ sent: [] as Array<{ to: unknown; from?: string; subject: string; text?: string }>, identity: null as null | { ok: false; reason: string } | { ok: true; identity: Record<string, unknown> } }))

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property) }) }
})
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() }, redis: { connection: null },
  }
})
vi.mock('../email/transport.js', async (original) => {
  const real = await original<typeof import('../email/transport.js')>()
  return { ...real, sendEmail: vi.fn(async (message: Parameters<typeof real.sendEmail>[0]) => { stand.sent.push(message); return real.sendEmail(message) }) }
})
// Another business's identity (or none), when a test says so; otherwise the real one (this business is Xavia).
vi.mock('../business-identity.service.js', async (original) => {
  const real = await original<typeof import('../business-identity.service.js')>()
  return { ...real, resolveBusinessIdentity: vi.fn(async () => stand.identity ?? real.resolveBusinessIdentity()) }
})

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
type Json = any
const ids: Record<string, string> = {}
let app: FastifyInstance
const EVERYTHING = new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)])
const person = () => ({ kind: 'user' as const, userId: ids.approver, label: 'S9 Approver', permissions: { isOwner: false, permissions: EVERYTHING }, workspace: business, via: 'claude' as const })
const db = () => database.client

async function preview(args: Record<string, unknown>) {
  const { callTool } = await import('../agents/call-tool.js')
  return (await inside(() => callTool(person(), 'email-supplier', args))).raw as Json
}
async function askAndRun(args: Record<string, unknown>) {
  const { runOrQueueTool } = await import('../agents/approval-gate.service.js')
  const { commitScheduledApproval, scheduleApproval } = await import('../agent-fleet/approval-inbox.service.js')
  const run = await inside(() => db().agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'running', userId: ids.approver, via: 'claude' } }))
  const queued = await inside(() => runOrQueueTool('email-supplier', args, person(), run.id, { forceAsk: true })) as Json
  expect(queued, queued.error).toMatchObject({ ok: true, mode: 'queued' })
  expect(stand.sent).toEqual([])
  const parked = await inside(() => scheduleApproval({ id: queued.approvalId, actor: person() as never })) as Json
  expect(parked, parked.error).toMatchObject({ ok: true, status: 'scheduled' })
  await inside(() => db().agentApproval.update({ where: { id: queued.approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(queued.approvalId)) as Promise<Json>
}

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const c = db()
    ids.approver = (await c.userProfile.create({ data: { email: 's9-approver@example.test', status: 'active', displayName: 'S9 Approver' } })).id
    const role = await c.role.create({ data: { key: 'S9_EMAIL_APPROVER', name: 'S9 approver', description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
    await c.userRole.create({ data: { userId: ids.approver, roleId: role.id } })
    const membership = await c.workspaceMembership.create({ data: { workspaceId: LEGACY_WORKSPACE_ID, userId: ids.approver, status: 'active' } })
    await c.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
    ids.supplier = (await c.supplier.create({ data: { name: 'Test Leathers', email: 'orders@leathers.example.test' } })).id
    ids.silent = (await c.supplier.create({ data: { name: 'Test Buckles' } })).id
    ids.po = (await c.purchaseOrder.create({ data: { poNumber: 'PO-TEST-S9-1', supplierId: ids.supplier, status: 'SUBMITTED', totalCents: 1000, currencyCode: 'EUR' } })).id
    ids.otherPo = (await c.purchaseOrder.create({ data: { poNumber: 'PO-TEST-S9-2', supplierId: ids.silent, status: 'DRAFT', totalCents: 500, currencyCode: 'EUR' } })).id
  })
  app = Fastify()
  app.addHook('onRequest', (_request, _reply, done) => { withWorkspace(business, done) })
  await app.register((await import('../../routes/fulfillment.routes.js')).default, { prefix: '/api' })
  await app.ready()
}, 180_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await app?.close()
  await database?.close()
}, 60_000)

beforeEach(() => {
  stand.sent = []
  stand.identity = null
})

describe('08 S9 — the supplier e-mail route answers as before', () => {
  it('sends (a dry run here) and logs it; refuses a bad recipient and an empty message', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/fulfillment/suppliers/${ids.supplier}/comms/email`, headers: { 'x-user-id': 'person-1' }, payload: { to: 'orders@leathers.example.test', body: ' Hello <b>there</b> ' } })
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json()
    expect(Object.keys(body).sort()).toEqual(['comm', 'delivery'])
    expect(body.delivery).toMatchObject({ ok: true, provider: 'mock', dryRun: true })
    expect(body.comm).toMatchObject({ supplierId: ids.supplier, channel: 'EMAIL', direction: 'OUT', subject: 'Message from Xavia', body: 'Hello <b>there</b>', emailTo: 'orders@leathers.example.test', emailOk: true, byUserId: 'person-1', contactId: null })
    expect(stand.sent).toEqual([expect.objectContaining({ to: 'orders@leathers.example.test', subject: 'Message from Xavia', text: 'Hello <b>there</b>', html: expect.stringContaining('Hello &lt;b&gt;there&lt;/b&gt;') })])
    expect(stand.sent[0]).not.toHaveProperty('from')
    expect((await app.inject({ method: 'POST', url: `/api/fulfillment/suppliers/${ids.supplier}/comms/email`, payload: { to: 'nope', body: 'x' } })).json()).toEqual({ error: 'valid recipient email required' })
    expect((await app.inject({ method: 'POST', url: `/api/fulfillment/suppliers/${ids.supplier}/comms/email`, payload: { to: 'a@b.example.test' } })).json()).toEqual({ error: 'body required' })
  })
})

describe('the supplier page writes as its own business', () => {
  const send = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: `/api/fulfillment/suppliers/${ids.supplier}/comms/email`, payload })

  it('another business: the default subject and the sender are its own', async () => {
    stand.identity = { ok: true, identity: { workspaceId: 'ws_test_moto', xavia: false, brandName: 'Test Moto', brandMark: 'TEST MOTO', emailFrom: '"Test Moto" <shop@moto.example.test>', supportEmail: 'shop@moto.example.test', unsubscribeEmail: 'shop@moto.example.test' } }
    const res = await send({ to: 'orders@leathers.example.test', body: 'Hello' })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().comm).toMatchObject({ subject: 'Message from Test Moto' })
    expect(stand.sent).toEqual([expect.objectContaining({ subject: 'Message from Test Moto', from: '"Test Moto" <shop@moto.example.test>' })])
    // A subject the person typed is kept.
    expect((await send({ to: 'orders@leathers.example.test', subject: 'Samples', body: 'Hello' })).json().comm).toMatchObject({ subject: 'Samples' })
  })

  it('a business with no identity is refused: nothing is sent or logged', async () => {
    stand.identity = { ok: false, reason: 'This business has no identity for buyers yet: set its company name in Settings › Company. Nothing was sent or printed, and nothing goes out as another business.' }
    const before = await inside(() => db().supplierComm.count())
    const res = await send({ to: 'orders@leathers.example.test', body: 'Hello' })
    expect({ status: res.statusCode, body: res.json() }).toEqual({ status: 409, body: { error: expect.stringContaining('no identity for buyers yet') } })
    expect(stand.sent).toEqual([])
    expect(await inside(() => db().supplierComm.count())).toBe(before)
  })
})

describe('08 S9 — email-supplier', { timeout: 60_000 }, () => {
  it('previews the address on file, the PO, the sender and the dry run; run, it is sent as the approver', async () => {
    const shown = await preview({ supplierId: ids.supplier, purchaseOrderId: ids.po, message: 'Please confirm the delivery date.' })
    expect(shown.ok, shown.error).toBe(true)
    expect(shown.preview).toMatchObject({
      supplier: { id: ids.supplier, name: 'Test Leathers' },
      purchaseOrder: { id: ids.po, poNumber: 'PO-TEST-S9-1', status: 'SUBMITTED' },
      email: { to: 'orders@leathers.example.test', subject: 'Xavia — purchase order PO-TEST-S9-1', live: false, what: expect.stringContaining('dry run') },
      message: 'Please confirm the delivery date.',
    })
    expect(stand.sent).toEqual([])
    const ran = await askAndRun({ supplierId: ids.supplier, purchaseOrderId: ids.po, message: 'Please confirm the delivery date.' })
    expect(ran, ran.error).toMatchObject({ ok: true, status: 'executed' })
    expect(stand.sent).toEqual([expect.objectContaining({ to: 'orders@leathers.example.test', subject: 'Xavia — purchase order PO-TEST-S9-1', text: 'Please confirm the delivery date.' })])
    const comm = await inside(() => db().supplierComm.findFirstOrThrow({ where: { supplierId: ids.supplier, subject: 'Xavia — purchase order PO-TEST-S9-1' } }))
    expect(comm).toMatchObject({ channel: 'EMAIL', direction: 'OUT', emailTo: 'orders@leathers.example.test', emailOk: true, byUserId: ids.approver })
  })

  it('another business writes from its own identity; without one it is refused, never sent as another business', async () => {
    stand.identity = { ok: true, identity: { workspaceId: 'ws_test_moto', xavia: false, brandName: 'Test Moto', brandMark: 'TEST MOTO', emailFrom: '"Test Moto" <shop@moto.example.test>', supportEmail: 'shop@moto.example.test', unsubscribeEmail: 'shop@moto.example.test' } }
    const shown = await preview({ supplierId: ids.supplier, message: 'Hello' })
    expect(shown.preview.email).toMatchObject({ from: '"Test Moto" <shop@moto.example.test>', subject: 'Message from Test Moto' })
    const ran = await askAndRun({ supplierId: ids.supplier, message: 'Hello' })
    expect(ran, ran.error).toMatchObject({ ok: true, status: 'executed' })
    expect(stand.sent).toEqual([expect.objectContaining({ from: '"Test Moto" <shop@moto.example.test>', subject: 'Message from Test Moto' })])
    stand.identity = { ok: false, reason: 'This business has no identity for buyers yet: set its company name in Settings › Company. Nothing was sent or printed, and nothing goes out as another business.' }
    expect(await preview({ supplierId: ids.supplier, message: 'Hello' })).toEqual({ ok: false, error: expect.stringContaining('no identity for buyers yet') })
  })

  it('live only when outbound e-mail is on (the card says so)', async () => {
    vi.stubEnv('NEXUS_ENABLE_OUTBOUND_EMAILS', 'true')
    vi.stubEnv('RESEND_API_KEY', 'test-key-not-used')
    try {
      expect((await preview({ supplierId: ids.supplier, message: 'Hello' })).preview.email).toMatchObject({ live: true, what: expect.stringContaining('cannot be taken back') })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('refuses a supplier with no address, a PO of another supplier, and what it cannot find', async () => {
    expect(await preview({ supplierId: ids.silent, message: 'Hello' })).toMatchObject({ ok: false, error: expect.stringContaining('no e-mail address on file') })
    expect(await preview({ supplierId: ids.supplier, purchaseOrderId: ids.otherPo, message: 'Hello' })).toEqual({ ok: false, error: 'PO-TEST-S9-2 is not a purchase order of Test Leathers.' })
    expect(await preview({ supplierId: 'no-such-supplier', message: 'Hello' })).toEqual({ ok: false, error: 'Supplier not found' })
    expect(await preview({ supplierId: ids.supplier, purchaseOrderId: 'no-such-po', message: 'Hello' })).toEqual({ ok: false, error: 'Purchase order not found' })
  })
})
