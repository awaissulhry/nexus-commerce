/**
 * MCP full control 07 O14 — `issue-fiscal-document` through the one door (call-tool.ts), on a real PostgreSQL with the
 * production schema and policies (PGlite).
 *
 *   - It numbers invoices (orders) and credit notes (POSTED refunds) in the business's OWN series; a document already
 *     numbered keeps its number (idempotent: run twice, the same numbers, one event each).
 *   - Per business: a second business numbers its own series from 1, and another business's order is not found.
 *   - Refused without the company's name, full address and P.IVA (Settings › Company) — no number taken; for a
 *     cancelled or unpaid order; for a refund that is not POSTED.
 *   - Nothing is sent to SDI or the RT (no dispatch is called), and `invoice.issued` carries ids and the number only.
 *   - Never confirmed in Claude or auto; cannot be undone.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))
const sdi = vi.hoisted(() => ({ dispatched: [] as unknown[] }))
vi.mock('../../fattura-pa.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  dispatchToSdi: vi.fn(async (...args: unknown[]) => { sdi.dispatched.push(args); return { ok: true } }),
}))

import { callTool, executeTool, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'

const SECOND = 'test_o14_second_business'
const principal = (workspaceId = LEGACY_WORKSPACE_ID): UserPrincipal => ({
  kind: 'user', userId: 'u-o14', label: '07 O14 test', permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
  workspace: { workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, via: 'claude',
})
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
type Out = { ok: boolean; error?: string; preview?: any; data?: any }
const dryRun = async (args: Record<string, unknown>, who = principal()) => (await callTool(who, 'issue-fiscal-document', args)).raw as Out
const run = async (args: Record<string, unknown>, approvedPreview: unknown, who = principal()) => (await executeTool(who, 'issue-fiscal-document', args, { approvedPreview })).raw as Out
const approved = async (args: Record<string, unknown>, who = principal()) => {
  const asked = await dryRun(args, who)
  expect(asked.ok, asked.error).toBe(true)
  return run(args, asked.preview, who)
}
let seq = 0
const order = (workspaceId = LEGACY_WORKSPACE_ID, data: Record<string, unknown> = {}) => inside(workspaceId, async () => (await database.client.order.create({
  data: {
    channel: 'SHOPIFY', channelOrderId: `TEST-O14-${++seq}`, marketplace: 'IT', status: 'DELIVERED', currencyCode: 'EUR', totalPrice: '30.00',
    customerName: 'Test Buyer', customerEmail: 'buyer@example.test', shippingAddress: { city: 'Testville' }, ...data,
  } as never,
})).id)
const refund = (orderId: string, channelStatus = 'POSTED') => inside(LEGACY_WORKSPACE_ID, async () => {
  const ret = await database.client.return.create({ data: { orderId, channel: 'SHOPIFY', rmaNumber: `TEST-O14-RMA-${++seq}`, status: 'REFUNDED' } as never })
  return (await database.client.refund.create({ data: { returnId: ret.id, amountCents: 1500, channel: 'SHOPIFY', channelStatus } as never })).id
})
const company = (workspaceId: string, data: Record<string, unknown>) => inside(workspaceId, () => database.client.brandSettings.create({ data: data as never }))
const events = () => inside(LEGACY_WORKSPACE_ID, () => database.client.eventOutbox.findMany({ where: { type: 'invoice.issued' }, orderBy: { createdAt: 'asc' } }))

beforeAll(async () => {
  database = await formulaDatabase()
  await database.client.workspace.create({ data: { id: SECOND, name: 'Second test business', createdByUserId: 'test', creationKey: 'test-o14-second' } })
}, 180_000)
afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('issue-fiscal-document (07 O14)', () => {
  it('refused without the company\'s P.IVA and full address: no number is taken', async () => {
    const id = await order()
    const refused = await dryRun({ orderIds: [id] })
    expect(refused.error).toMatch(/Fill in the company .*P\.IVA in Settings › Company/)
    expect(await inside(LEGACY_WORKSPACE_ID, () => database.client.fiscalInvoice.count())).toBe(0)
  })

  it('numbers invoices and credit notes in the business\'s own series; run again: the same numbers, no new event', async () => {
    await company(LEGACY_WORKSPACE_ID, { companyName: 'Test Company Srl', piva: 'IT00000000000', addressLines: ['Via Test 1', '00100 Testborgo'] })
    const first = await order()
    const second = await order()
    const credited = await refund(first)
    const args = { orderIds: [first, second], refundIds: [credited] }
    const asked = await dryRun(args)
    expect(asked.preview).toMatchObject({
      series: { issuer: 'XAVIA', fiscalYear: new Date().getFullYear() }, newNumbers: 3,
      invoices: [{ orderId: first, outcome: 'new number' }, { orderId: second, outcome: 'new number' }],
      creditNotes: [{ refundId: credited, outcome: 'new number', amount: 15, currencyCode: 'EUR' }],
    })
    const done = await run(args, asked.preview)
    expect(done.ok, done.error).toBe(true)
    const year = new Date().getFullYear()
    expect(done.data).toMatchObject({
      invoices: [{ orderId: first, number: `00001/${year}`, newlyAssigned: true }, { orderId: second, number: `00002/${year}`, newlyAssigned: true }],
      creditNotes: [{ refundId: credited, number: `NC-00001/${year}`, newlyAssigned: true }],
    })
    const again = await approved(args)
    expect(again.data.invoices.map((i: { number: string }) => i.number)).toEqual([`00001/${year}`, `00002/${year}`])
    expect(again.data.invoices.every((i: { newlyAssigned: boolean }) => !i.newlyAssigned)).toBe(true)
    const issued = await events()
    expect(issued).toHaveLength(3)
    expect(issued[0].payload).toEqual({ kind: 'INVOICE', documentId: expect.any(String), number: `00001/${year}`, orderId: first, refundId: null })
    expect(issued[2].payload).toEqual({ kind: 'CREDIT_NOTE', documentId: expect.any(String), number: `NC-00001/${year}`, orderId: first, refundId: credited })
    expect(sdi.dispatched).toEqual([])
  })

  it('per business: a second business numbers its own series from 1; another business\'s order is not found', async () => {
    await company(SECOND, { companyName: 'Second Test Srl', piva: 'IT11111111111', addressLines: ['Via Altra 2', '00200 Envtown'] })
    const own = await order(SECOND)
    const done = await approved({ orderIds: [own] }, principal(SECOND))
    expect(done.data.invoices[0]).toMatchObject({ number: `00001/${new Date().getFullYear()}`, issuer: `BUSINESS-${SECOND}` })
    expect(await dryRun({ orderIds: [own] })).toEqual({ ok: false, error: `Order not found: ${own}. Nothing was queued.` })
  })

  it('refused for a cancelled or unpaid order and for a refund that is not POSTED', async () => {
    expect((await dryRun({ orderIds: [await order(LEGACY_WORKSPACE_ID, { status: 'CANCELLED' })] })).error).toMatch(/is CANCELLED: an invoice is numbered only for a paid order/)
    expect((await dryRun({ orderIds: [await order(LEGACY_WORKSPACE_ID, { status: 'AWAITING_PAYMENT' })] })).error).toMatch(/is AWAITING_PAYMENT/)
    expect((await dryRun({ refundIds: [await refund(await order(), 'FAILED')] })).error).toMatch(/is FAILED: a credit note is numbered only for a POSTED refund/)
    expect((await dryRun({})).error).toMatch(/Name the orders .* or the refunds/)
  })

  it('always waits for a person in Nexus; cannot be undone', () => {
    expect(getTool('issue-fiscal-document')).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', reversibility: 'none', openWorld: false })
    expect(getTool('issue-fiscal-document')!.undo).toBeUndefined()
  })
})
