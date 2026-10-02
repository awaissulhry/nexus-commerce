/**
 * MCP full control 07 O11 — the buyer-message door and send-customer-message v2, through the one door (call-tool.ts),
 * on a real PostgreSQL with the production schema and policies (PGlite). The e-mail transport is mocked.
 *
 *   - Amazon and eBay buyers only through their marketplace messaging (decision O-2; O15, marketplace-messaging.vitest):
 *     a free Amazon message without a template, and an eBay order without its buyer and item, are refused
 *   - an opted-out buyer is refused, at the preview and again when it runs (opted out in between: a SUPPRESSED row,
 *     no e-mail)
 *   - another business's order is not found; a business without an identity for buyers is refused (O3)
 *   - templates and language per market; the copy lint's warnings in the preview; the e-mail live/dry-run mode
 *   - the preview never names the buyer beyond a first name and a masked e-mail (O-1)
 *   - one BuyerMessage row per send, and a customer.message.sent event with ids, channel, route and outcome only
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))
const mail = vi.hoisted(() => ({ sent: [] as Array<Record<string, unknown>> }))
vi.mock('../email/transport.js', () => ({
  sendEmail: vi.fn(async (message: Record<string, unknown>) => {
    mail.sent.push(message)
    return { ok: true, provider: 'mock', dryRun: true, messageId: `mock-${mail.sent.length}` }
  }),
  defaultFrom: () => 'Xavia <ship@xavia.it>',
  __test: { isReal: () => false },
}))

import { callTool, executeTool, type UserPrincipal } from '../agents/call-tool.js'

const SECOND = 'test_o11_second_business'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const principal = (workspaceId = LEGACY_WORKSPACE_ID): UserPrincipal => ({
  kind: 'user', userId: 'u-o11', label: '07 O11 test', permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
  workspace: business(workspaceId), via: 'claude',
})
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace(business(workspaceId), work)
type Out = { ok: boolean; error?: string; preview?: any; data?: any }
const dryRun = async (args: Record<string, unknown>, who = principal()) => (await callTool(who, 'send-customer-message', args)).raw as Out
const run = async (args: Record<string, unknown>, approvedPreview: unknown, who = principal()) => (await executeTool(who, 'send-customer-message', args, { approvedPreview, approvalId: 'test-approval-1' })).raw as Out
const ids: Record<string, string> = {}
let seq = 0
const order = (workspaceId: string, data: Record<string, unknown>) => inside(workspaceId, async () => (await database.client.order.create({
  data: {
    channel: 'SHOPIFY', channelOrderId: `TEST-O11-${++seq}`, marketplace: 'IT', status: 'PROCESSING', currencyCode: 'EUR', totalPrice: '10.00',
    customerName: 'Mario Rossi', customerEmail: `mario.rossi.${seq}@example.test`, shippingAddress: { city: 'Testville', countryCode: 'IT', line1: 'Via Segreta 7' }, ...data,
  } as never,
})).id)

beforeAll(async () => {
  database = await formulaDatabase()
  await database.client.workspace.create({ data: { id: SECOND, name: 'Second test business', createdByUserId: 'test', creationKey: 'test-o11-second' } })
  ids.shopifyIt = await order(LEGACY_WORKSPACE_ID, {})
  ids.shopifyDe = await order(LEGACY_WORKSPACE_ID, { marketplace: 'DE' })
  ids.amazon = await order(LEGACY_WORKSPACE_ID, { channel: 'AMAZON' })
  ids.ebay = await order(LEGACY_WORKSPACE_ID, { channel: 'EBAY' })
  ids.optedOut = await order(LEGACY_WORKSPACE_ID, { customerEmail: 'opted.out@example.test' })
  ids.later = await order(LEGACY_WORKSPACE_ID, { customerEmail: 'later.out@example.test' })
  await inside(LEGACY_WORKSPACE_ID, () => database.client.emailSuppression.create({ data: { email: 'opted.out@example.test', channel: 'agent-customer-message', source: 'unsubscribe' } as never }))
  ids.secondOrder = await order(SECOND, {})
}, 180_000)

afterAll(async () => {
  await database?.close()
}, 30_000)

describe('the buyer-message door (07 O11)', () => {
  it('Amazon and eBay buyers only through their marketplace messaging: never an e-mail', async () => {
    expect((await dryRun({ orderId: ids.amazon, message: 'Hello' })).error).toMatch(/is an Amazon order: Amazon allows only its own message kinds, so name a template/)
    expect((await dryRun({ orderId: ids.ebay, message: 'Hello' })).error).toMatch(/Nexus does not have the eBay buyer or item of this order; write from eBay Messages/)
    expect((await dryRun({ orderId: ids.amazon, template: 'delay-apology' })).preview).toMatchObject({ route: 'AMAZON', sendsAs: { from: expect.stringMatching(/^Amazon Buyer-Seller Messaging/) } })
  })

  it('an opted-out buyer is refused; another business\'s order is not found; a business without an identity is refused', async () => {
    expect((await dryRun({ orderId: ids.optedOut, message: 'Hello' })).error).toMatch(/opted out of e-mails \(unsubscribe\)/)
    expect(await dryRun({ orderId: ids.secondOrder, message: 'Hello' })).toEqual({ ok: false, error: 'Order not found' })
    expect((await dryRun({ orderId: ids.secondOrder, message: 'Hello' }, principal(SECOND))).error).toMatch(/no identity for buyers/)
  })

  it('a template in the market\'s language, the lint\'s warnings, the mode; the buyer masked in the preview', async () => {
    const it = await dryRun({ orderId: ids.shopifyIt, template: 'delay-apology', message: 'Details: https://shop.example.test/help' })
    expect(it.preview).toMatchObject({
      route: 'EMAIL', language: 'it', template: 'delay-apology', subject: 'Un messaggio sul tuo ordine Xavia',
      mode: expect.stringMatching(/^dry run/), sendsAs: { name: 'Xavia', from: 'Xavia <ship@xavia.it>' },
      to: { firstName: 'Mario', city: 'Testville', country: 'IT', email: expect.stringMatching(/^m\*\*\*@example\.test$/) },
      lint: [expect.objectContaining({ severity: 'warn', message: expect.stringMatching(/External link/) })],
    })
    expect(it.preview.body).toMatch(/^Ci scusiamo: il tuo ordine TEST-O11-\d+ partirà/)
    expect(JSON.stringify(it.preview)).not.toMatch(/Rossi|mario\.rossi|Via Segreta/)
    const de = await dryRun({ orderId: ids.shopifyDe, template: 'shipping-update' })
    expect(de.preview).toMatchObject({ language: 'en', subject: 'A message about your Xavia order' })
  })

  it('one BuyerMessage row per send and its event (ids, channel, route, outcome; no text, no buyer)', async () => {
    const args = { orderId: ids.shopifyIt, message: 'Your parcel ships today.' }
    const asked = await dryRun(args)
    const done = await run(args, asked.preview)
    expect(done.ok, done.error).toBe(true)
    expect(done.data).toMatchObject({ dryRun: true, delivered: false, to: { firstName: 'Mario' } })
    const rows = await inside(LEGACY_WORKSPACE_ID, () => database.client.buyerMessage.findMany({ where: { orderId: ids.shopifyIt } }))
    expect(rows).toEqual([expect.objectContaining({ channel: 'SHOPIFY', route: 'EMAIL', language: 'it', body: 'Your parcel ships today.', status: 'DRY_RUN', via: 'claude', approvalId: 'test-approval-1', sentByUserId: 'u-o11' })])
    const events = await inside(LEGACY_WORKSPACE_ID, () => database.client.eventOutbox.findMany({ where: { type: 'customer.message.sent' } }))
    expect(events).toHaveLength(1)
    expect(events[0].payload).toEqual({ messageId: rows[0].id, orderId: ids.shopifyIt, channel: 'SHOPIFY', route: 'EMAIL', outcome: 'DRY_RUN' })
    expect(mail.sent.at(-1)).toMatchObject({ to: expect.stringMatching(/^mario\.rossi/), subject: 'Un messaggio sul tuo ordine Xavia' })
  })

  it('opted out after the approval: refused when it runs, no e-mail', async () => {
    const args = { orderId: ids.later, message: 'Hello again' }
    const asked = await dryRun(args)
    await inside(LEGACY_WORKSPACE_ID, () => database.client.emailSuppression.create({ data: { email: 'later.out@example.test', channel: 'agent-customer-message', source: 'unsubscribe' } as never }))
    const before = mail.sent.length
    const done = await run(args, asked.preview)
    expect(done.ok).toBe(false)
    expect(done.error).toMatch(/opted out/)
    expect(mail.sent).toHaveLength(before)
  })
})
