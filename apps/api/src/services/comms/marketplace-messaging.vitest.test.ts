/**
 * MCP full control 07 O15 — Amazon and eBay buyers are written to through the marketplace's own messaging (decision
 * OD2 = A), through the channel gateway, via send-customer-message and the one buyer-message door. The gateway calls
 * are MOCKED (amazonSellerFetch, ebayTradingSend) and the account resolver stands in: nothing leaves the machine.
 *
 *   Amazon — only in one of Amazon's message kinds (a template picks it); Nexus asks Amazon which kinds the order allows
 *            and sends only an allowed one; links and incentives refused; dry run while NEXUS_ENABLE_AMAZON_MESSAGING
 *            is off (no call at all).
 *   eBay   — AddMemberMessageAAQToPartner to the order's buyer about its item; dry run while NEXUS_ENABLE_EBAY_MESSAGING
 *            is off.
 *   Both   — one BuyerMessage row per send with its route and outcome, and a customer.message.sent event; the preview
 *            never shows the buyer's full name; another business's order is not found.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
const gw = vi.hoisted(() => ({
  amazon: [] as Array<{ accountId?: string; method?: string; path: string; body?: unknown }>,
  ebay: [] as Array<{ connectionId: string | null; body: string; headers: Record<string, string> }>,
  allowed: ['confirmOrderDetails', 'unexpectedProblem'],
  ebayAnswer: '<AddMemberMessageAAQToPartnerResponse><Ack>Success</Ack><CorrelationID>TEST-CORR-1</CorrelationID></AddMemberMessageAAQToPartnerResponse>',
}))
vi.mock('../gateway/amazon-sdk.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  amazonSellerFetch: vi.fn(async (input: { accountId?: string; method?: string; path: string; body?: unknown }) => {
    gw.amazon.push(input)
    if ((input.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify({ _links: { actions: gw.allowed.map((name) => ({ name, href: `/messaging/v1/orders/x/messages/${name}` })) } }), { status: 200 })
    }
    return new Response('', { status: 201, headers: { 'x-amzn-requestid': 'TEST-AMZ-REQ-1' } })
  }),
}))
vi.mock('../gateway/ebay.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ebayTradingSend: vi.fn(async (connectionId: string | null, _url: string, init: { body: string; headers: Record<string, string> }) => {
    gw.ebay.push({ connectionId, body: init.body, headers: init.headers })
    return new Response(gw.ebayAnswer, { status: 200 })
  }),
}))
vi.mock('../connection-resolver.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  tryResolveConnection: vi.fn(async () => ({ id: 'test-connection-1' })),
}))
vi.mock('../ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: vi.fn(async () => 'test-token') } }))
vi.mock('../email/transport.js', () => ({
  sendEmail: vi.fn(async () => { throw new Error('no e-mail may be sent to an Amazon or eBay buyer') }),
  defaultFrom: () => 'Test <ship@example.test>',
  __test: { isReal: () => false },
}))

import { callTool, executeTool, type UserPrincipal } from '../agents/call-tool.js'

const SECOND = 'test_o15_second_business'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const principal = (workspaceId = LEGACY_WORKSPACE_ID): UserPrincipal => ({
  kind: 'user', userId: 'u-o15', label: '07 O15 test', permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
  workspace: business(workspaceId), via: 'claude',
})
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace(business(workspaceId), work)
type Out = { ok: boolean; error?: string; preview?: any; data?: any }
const dryRun = async (args: Record<string, unknown>) => (await callTool(principal(), 'send-customer-message', args)).raw as Out
const run = async (args: Record<string, unknown>) => {
  const asked = await dryRun(args)
  expect(asked.ok, asked.error).toBe(true)
  return (await executeTool(principal(), 'send-customer-message', args, { approvedPreview: asked.preview, approvalId: 'test-approval-o15' })).raw as Out
}
const ids: Record<string, string> = {}
let seq = 0
const order = (workspaceId: string, data: Record<string, unknown>) => inside(workspaceId, async () => (await database.client.order.create({
  data: {
    channel: 'AMAZON', channelOrderId: `TEST-O15-${++seq}`, marketplace: 'IT', status: 'SHIPPED', currencyCode: 'EUR', totalPrice: '10.00', fulfillmentMethod: 'MFN',
    customerName: 'Mario Rossi', customerEmail: `buyer.${seq}@example.test`, shippingAddress: { city: 'Testville', countryCode: 'IT' }, ...data,
  } as never,
})).id)
const rowsOf = (orderId: string) => inside(LEGACY_WORKSPACE_ID, () => database.client.buyerMessage.findMany({ where: { orderId }, select: { route: true, channel: true, status: true, providerRef: true, error: true, template: true } }))

beforeAll(async () => {
  database = await formulaDatabase()
  await database.client.workspace.create({ data: { id: SECOND, name: 'Second test business', createdByUserId: 'test', creationKey: 'test-o15-second' } })
  ids.amazon = await order(LEGACY_WORKSPACE_ID, {})
  ids.amazonLive = await order(LEGACY_WORKSPACE_ID, {})
  ids.amazonNotAllowed = await order(LEGACY_WORKSPACE_ID, {})
  ids.ebay = await order(LEGACY_WORKSPACE_ID, {
    channel: 'EBAY', ebayMetadata: { buyer: { username: 'test_buyer_1' } },
    items: { create: [{ sku: 'TEST-SKU-1', quantity: 1, price: '10.00', ebayMetadata: { legacyItemId: '110000000001' } }] },
  })
  ids.other = await order(SECOND, {})
}, 180_000)
beforeEach(() => {
  gw.amazon.length = 0
  gw.ebay.length = 0
})
afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('Amazon Buyer-Seller Messaging (07 O15)', () => {
  it('dry run: the preview says so, nothing is called, the row and the event say DRY_RUN', async () => {
    const asked = await dryRun({ orderId: ids.amazon, template: 'delay-apology', message: 'It leaves on Monday.' })
    expect(asked.preview).toMatchObject({
      route: 'AMAZON', template: 'delay-apology', mode: expect.stringMatching(/^dry run: Amazon is not called/),
      sendsAs: { from: 'Amazon Buyer-Seller Messaging (as "unexpectedProblem")' }, to: { firstName: 'Mario' },
    })
    expect(JSON.stringify(asked.preview)).not.toMatch(/Rossi/)
    const done = await run({ orderId: ids.amazon, template: 'delay-apology', message: 'It leaves on Monday.' })
    expect(done.ok, done.error).toBe(true)
    expect(gw.amazon).toEqual([])
    expect(await rowsOf(ids.amazon)).toEqual([{ route: 'AMAZON', channel: 'AMAZON', status: 'DRY_RUN', providerRef: null, error: null, template: 'delay-apology' }])
  })

  it('live: asks Amazon which kinds the order allows, then sends the allowed one through the gateway', async () => {
    vi.stubEnv('NEXUS_ENABLE_AMAZON_MESSAGING', 'true')
    const done = await run({ orderId: ids.amazonLive, template: 'shipping-update' })
    expect(done.ok, done.error).toBe(true)
    expect(gw.amazon.map((c) => [c.method ?? 'GET', c.path, c.accountId])).toEqual([
      ['GET', expect.stringMatching(/^\/messaging\/v1\/orders\/TEST-O15-\d+\?marketplaceIds=APJ6JRA9NG5V4$/), 'test-connection-1'],
      ['POST', expect.stringMatching(/^\/messaging\/v1\/orders\/TEST-O15-\d+\/messages\/confirmOrderDetails\?marketplaceIds=APJ6JRA9NG5V4$/), 'test-connection-1'],
    ])
    expect(gw.amazon[1].body).toEqual({ text: expect.stringMatching(/^Il tuo ordine TEST-O15-\d+ è in preparazione/) })
    expect(await rowsOf(ids.amazonLive)).toEqual([expect.objectContaining({ status: 'SENT', providerRef: 'TEST-AMZ-REQ-1' })])
    const events = await inside(LEGACY_WORKSPACE_ID, () => database.client.eventOutbox.findMany({ where: { type: 'customer.message.sent' } }))
    expect(events.map((e) => e.payload)).toContainEqual(expect.objectContaining({ orderId: ids.amazonLive, route: 'AMAZON', outcome: 'SENT' }))
    vi.unstubAllEnvs()
  })

  it('a kind Amazon does not allow for the order is not sent; links and a free message alone are refused', async () => {
    vi.stubEnv('NEXUS_ENABLE_AMAZON_MESSAGING', 'true')
    const done = await run({ orderId: ids.amazonNotAllowed, template: 'address-check' })
    expect(done.ok).toBe(false)
    expect(done.error).toMatch(/Amazon does not allow a "confirmDeliveryDetails" message for this order now/)
    expect(gw.amazon.filter((c) => c.method === 'POST')).toEqual([])
    expect(await rowsOf(ids.amazonNotAllowed)).toEqual([expect.objectContaining({ status: 'FAILED' })])
    expect((await dryRun({ orderId: ids.amazon, template: 'delay-apology', message: 'See https://shop.example.test' })).error).toMatch(/Amazon does not allow this in a buyer message — External link/)
    expect((await dryRun({ orderId: ids.amazon, template: 'delay-apology', message: 'Leave a 5-star review' })).error).toMatch(/positive \/ 5-star/)
    expect((await dryRun({ orderId: ids.amazon, message: 'Hello' })).error).toMatch(/name a template/)
    vi.unstubAllEnvs()
  })

  it('another business\'s order is not found', async () => {
    expect(await dryRun({ orderId: ids.other, template: 'delay-apology' })).toEqual({ ok: false, error: 'Order not found' })
  })
})

describe('eBay member messages (07 O15)', () => {
  it('dry run: nothing is called; live: AddMemberMessageAAQToPartner to the order\'s buyer about its item, through the gateway', async () => {
    const asked = await dryRun({ orderId: ids.ebay, message: 'Your parcel ships today.' })
    expect(asked.preview).toMatchObject({ route: 'EBAY', mode: expect.stringMatching(/^dry run: eBay is not called/), sendsAs: { from: 'eBay Messages' } })
    expect(JSON.stringify(asked.preview)).not.toMatch(/test_buyer_1|110000000001/)
    expect((await run({ orderId: ids.ebay, message: 'Your parcel ships today.' })).ok).toBe(true)
    expect(gw.ebay).toEqual([])
    vi.stubEnv('NEXUS_ENABLE_EBAY_MESSAGING', 'true')
    const done = await run({ orderId: ids.ebay, message: 'Your parcel ships today.' })
    expect(done.ok, done.error).toBe(true)
    expect(gw.ebay).toHaveLength(1)
    expect(gw.ebay[0].connectionId).toBe('test-connection-1')
    expect(gw.ebay[0].headers).toMatchObject({ 'X-EBAY-API-CALL-NAME': 'AddMemberMessageAAQToPartner', 'X-EBAY-API-SITEID': '101' })
    expect(gw.ebay[0].body).toMatch(/<ItemID>110000000001<\/ItemID>.*<Body>Your parcel ships today\.<\/Body>.*<RecipientID>test_buyer_1<\/RecipientID>/s)
    expect((await rowsOf(ids.ebay)).map((r) => r.status)).toEqual(['DRY_RUN', 'SENT'])
    vi.unstubAllEnvs()
  })

  it('eBay\'s refusal is said, and the row says FAILED', async () => {
    vi.stubEnv('NEXUS_ENABLE_EBAY_MESSAGING', 'true')
    gw.ebayAnswer = '<AddMemberMessageAAQToPartnerResponse><Ack>Failure</Ack><Errors><ShortMessage>Test refusal</ShortMessage></Errors></AddMemberMessageAAQToPartnerResponse>'
    const done = await run({ orderId: ids.ebay, template: 'shipping-update' })
    expect(done.ok).toBe(false)
    expect(done.error).toMatch(/eBay refused the message: Test refusal/)
    vi.unstubAllEnvs()
  })
})
