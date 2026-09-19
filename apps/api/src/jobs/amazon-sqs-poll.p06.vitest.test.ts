/**
 * P0.6 (docs/channel-connections/FINAL-PLAN.md) — Amazon notifications: every message is written to
 * the inbound ledger BEFORE it is deleted from the queue; a message no business profile owns is
 * recorded (legacy profile, `failed`, with the reason) instead of leaving only a log line; the
 * subscription job runs inside each profile that has an Amazon account; ORDER_STATUS_CHANGE (retired
 * by Amazon on 2026-07-29) is no longer subscribed.
 *
 * The real parser (`pollSqsMessages`) and the real per-message handler run. Stand-ins: the SQS client
 * (it records every delete), the ledger (it records every write with the profile it ran in), the
 * seller → profile routing index, and the order sync. One shared `timeline` puts ledger writes and
 * queue deletes in order, so "recorded before deleted" is checked, not assumed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  queue: [] as Array<{ Body: string; ReceiptHandle: string; MessageId: string }>,
  timeline: [] as Array<{ op: 'record' | 'complete' | 'delete'; key: string; workspace?: string; status?: string; ok?: boolean; error?: string; eventType?: string }>,
  ledgerDown: false,
  syncNewOrders: vi.fn(async () => undefined),
  cronRuns: [] as Array<{ name: string; workspace?: string }>,
}))

vi.mock('@aws-sdk/client-sqs', () => {
  class ReceiveMessageCommand { constructor(readonly input: unknown) {} }
  class DeleteMessageCommand { constructor(readonly input: { ReceiptHandle: string }) {} }
  class SQSClient {
    async send(command: unknown) {
      if (command instanceof ReceiveMessageCommand) { const Messages = h.queue.splice(0); return { Messages } }
      if (command instanceof DeleteMessageCommand) { h.timeline.push({ op: 'delete', key: command.input.ReceiptHandle }); return {} }
      return {}
    }
  }
  return { SQSClient, ReceiveMessageCommand, DeleteMessageCommand }
})
vi.mock('../services/cx/ingress/ledger.js', async () => {
  const { workspaceContext } = await import('../lib/workspace-context.js')
  let n = 0
  return {
    recordInbound: vi.fn(async (rec: { externalId?: string; status?: string; eventType: string; lastError?: string }) => {
      if (h.ledgerDown) return { id: null, duplicate: false }
      const id = `wh-${++n}`
      h.timeline.push({ op: 'record', key: rec.externalId ?? '?', workspace: workspaceContext()?.workspaceId, status: rec.status, eventType: rec.eventType, error: rec.lastError })
      return { id, duplicate: false }
    }),
    completeInbound: vi.fn(async (id: string | null, ok: boolean, error?: string) => { h.timeline.push({ op: 'complete', key: String(id), ok, error }) }),
  }
})
vi.mock('../lib/workspace-ingress.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/workspace-ingress.js')>()
  const { WorkspaceError } = await import('../lib/workspace-context.js')
  return {
    ...actual,
    // The routing index: seller A1 belongs to profile ws-a; nobody else is connected.
    verifiedChannelWorkspace: vi.fn(async (_channel: string, seller?: string) => {
      if (seller === 'A1') return { workspaceId: 'ws-a' }
      throw new WorkspaceError('ingress_account_ambiguous', 'The verified notification does not identify one connected seller.', 503)
    }),
  }
})
vi.mock('../services/amazon-orders.service.js', () => ({
  amazonOrdersService: { isConfigured: async () => true, syncNewOrders: h.syncNewOrders, backfillZeroTotals: vi.fn(async () => ({ repaired: 0 })) },
}))
vi.mock('../services/order-events.service.js', () => ({ publishOrderEvent: vi.fn() }))
vi.mock('../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: async () => 'A1', getAmazonRegion: async () => 'eu' }))
vi.mock('../lib/cron/clustered.js', () => ({ default: { schedule: vi.fn(), validate: () => true }, schedulePlatform: vi.fn() }))
vi.mock('../utils/cron-observability.js', async () => {
  const { workspaceContext } = await import('../lib/workspace-context.js')
  return { recordCronRun: vi.fn(async (name: string) => { h.cronRuns.push({ name, workspace: workspaceContext()?.workspaceId }); return 'recorded' }) }
})
vi.mock('../lib/workspace-sweep.js', async () => {
  const { withWorkspace } = await import('../lib/workspace-context.js')
  return {
    visitActiveWorkspaces: async (work: () => Promise<void>) => {
      for (const workspaceId of ['ws-a', 'ws-b', 'ws-c']) await withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
    },
  }
})
vi.mock('../services/connection-resolver.service.js', async () => {
  const { workspaceContext } = await import('../lib/workspace-context.js')
  return {
    // ws-a has an Amazon account; ws-b has none; ws-c's lookup fails.
    listActiveConnections: vi.fn(async () => {
      const ws = workspaceContext()?.workspaceId
      if (ws === 'ws-c') throw new Error('database blip')
      return ws === 'ws-a' ? [{ id: 'conn-a', channelType: 'AMAZON' }] : []
    }),
  }
})
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { pollSqsMessages } from '../services/amazon-sqs.service.js'
import { handleSqsMessage } from './amazon-sqs-poll.job.js'
import { NEXUS_SP_API_NOTIFICATION_TYPES, runAmazonNotificationSetup } from '../services/amazon-notifications-boot.service.js'
import { LEGACY_WORKSPACE_ID } from '../lib/workspace-context.js'

const envelope = (type: string, payload: Record<string, unknown>) => JSON.stringify({ NotificationType: type, EventTime: '2026-09-19T10:00:00Z', Payload: payload })
const orderPayload = (fulfillment: 'MFN' | 'AFN', seller = 'A1') => ({ OrderChangeNotification: { SellerId: seller, AmazonOrderId: '402-1', OrderStatus: 'Unshipped', FulfillmentType: fulfillment } })
function enqueue(id: string, Body: string) { h.queue.push({ Body, ReceiptHandle: `rh-${id}`, MessageId: `m-${id}` }) }
async function drain() {
  const tally = { processed: 0, skipped: 0 }
  for (const message of await pollSqsMessages(10, 1)) await handleSqsMessage(message, tally)
  return tally
}
const ops = (id: string) => h.timeline.filter((t) => t.key === `m-${id}` || t.key === `rh-${id}` || t.key.startsWith('wh-')).map((t) => t.op)
const recordOf = (id: string) => h.timeline.find((t) => t.op === 'record' && t.key === `m-${id}`)
const deleted = (id: string) => h.timeline.some((t) => t.op === 'delete' && t.key === `rh-${id}`)
const deleteIndex = (id: string) => h.timeline.findIndex((t) => t.op === 'delete' && t.key === `rh-${id}`)
const recordIndex = (id: string) => h.timeline.findIndex((t) => t.op === 'record' && t.key === `m-${id}`)

beforeEach(() => {
  vi.stubEnv('AMAZON_SQS_QUEUE_URL', 'https://sqs.eu-west-1.amazonaws.com/123/nexus-test')
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'test')
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test')
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  h.queue.length = 0
  h.timeline.length = 0
  h.cronRuns.length = 0
  h.ledgerDown = false
  h.syncNewOrders.mockReset()
})
afterEach(() => { vi.unstubAllEnvs() })

describe('P0.6 — every message is in the ledger before it leaves the queue', () => {
  it('positive control: an MFN order for a connected seller is recorded in its profile, synced, closed done, then deleted', async () => {
    enqueue('1', envelope('ORDER_CHANGE', orderPayload('MFN')))
    await drain()
    expect(recordOf('1')).toMatchObject({ workspace: 'ws-a', eventType: 'ORDER_CHANGE', status: 'pending' })
    expect(h.syncNewOrders).toHaveBeenCalledTimes(1)
    expect(h.timeline.map((t) => t.op)).toEqual(['record', 'complete', 'delete'])
    expect(h.timeline[1]).toMatchObject({ ok: true })
  })

  it.each([
    ['an unknown notification type', 'TEST_NOTIFICATION', { SellerId: 'A1' }, /no handler for TEST_NOTIFICATION/],
    ['an account-status notice with no readable payload', 'ACCOUNT_STATUS_CHANGED', { SellerId: 'A1' }, /no payload Nexus can read/],
    ['a feed notice with no readable payload', 'FEED_PROCESSING_FINISHED', { SellerId: 'A1' }, /no payload Nexus can read/],
    ['an FBA inventory notice with no items', 'FBA_INVENTORY_AVAILABILITY_CHANGES', { SellerId: 'A1', FBAInventoryAvailabilityChanges: { Items: [] } }, /no payload Nexus can read/],
    ['an order notice with no order payload', 'ORDER_CHANGE', { SellerId: 'A1' }, /no payload Nexus can read/],
  ])('%s: recorded in its profile, closed FAILED with the reason, and only then deleted (was: deleted with no row)', async (_label, type, payload, reason) => {
    enqueue('2', envelope(type, payload))
    await drain()
    expect(recordOf('2')).toMatchObject({ workspace: 'ws-a', eventType: type })
    expect(h.timeline.find((t) => t.op === 'complete')).toMatchObject({ ok: false, error: expect.stringMatching(reason) })
    expect(recordIndex('2')).toBeGreaterThanOrEqual(0)
    expect(deleteIndex('2')).toBeGreaterThan(recordIndex('2'))
  })

  it('an unreadable body: no seller, so it is recorded in the legacy profile as FAILED with both reasons, then deleted', async () => {
    enqueue('3', 'this is not json')
    await drain()
    expect(recordOf('3')).toMatchObject({
      workspace: LEGACY_WORKSPACE_ID, eventType: 'UNPARSEABLE', status: 'failed',
      error: expect.stringMatching(/Not routed to a business profile.*could not be read/),
    })
    expect(deleteIndex('3')).toBeGreaterThan(recordIndex('3'))
  })

  it('an order for a seller no profile owns: recorded in the legacy profile as FAILED and KEPT on the queue (a later connect can still process it)', async () => {
    enqueue('4', envelope('ORDER_CHANGE', orderPayload('MFN', 'UNKNOWN-SELLER')))
    await drain()
    expect(recordOf('4')).toMatchObject({ workspace: LEGACY_WORKSPACE_ID, status: 'failed', error: expect.stringMatching(/Not routed to a business profile/) })
    expect(deleted('4')).toBe(false)
    expect(h.syncNewOrders).not.toHaveBeenCalled()
  })

  it('when the ledger cannot be written, nothing is handled and nothing is deleted', async () => {
    h.ledgerDown = true
    enqueue('5', envelope('ORDER_CHANGE', orderPayload('MFN')))
    enqueue('6', envelope('TEST_NOTIFICATION', { SellerId: 'A1' }))
    const tally = await drain()
    expect(h.syncNewOrders).not.toHaveBeenCalled()
    expect(h.timeline.filter((t) => t.op === 'delete')).toEqual([])
    expect(tally.skipped).toBe(2)
  })

  it('a failed order sync closes the row FAILED and keeps the message for SQS to retry', async () => {
    h.syncNewOrders.mockRejectedValueOnce(new Error('SP-API 503'))
    enqueue('7', envelope('ORDER_CHANGE', orderPayload('MFN')))
    await drain()
    expect(h.timeline.find((t) => t.op === 'complete')).toMatchObject({ ok: false, error: 'SP-API 503' })
    expect(deleted('7')).toBe(false)
  })

  it('an FBA order is recorded, closed done and deleted without a sync', async () => {
    enqueue('8', envelope('ORDER_CHANGE', orderPayload('AFN')))
    await drain()
    expect(h.syncNewOrders).not.toHaveBeenCalled()
    expect(recordIndex('8')).toBe(0)
    expect(deleted('8')).toBe(true)
    expect(h.timeline.find((t) => t.op === 'complete')).toMatchObject({ ok: true })
  })

  it('with profiles OFF the same rule holds: an unknown type is recorded, then deleted', async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '0')
    enqueue('9', envelope('TEST_NOTIFICATION', {}))
    await drain()
    expect(deleteIndex('9')).toBeGreaterThan(recordIndex('9'))
    expect(recordIndex('9')).toBe(0)
  })
})

describe('P0.6 — subscriptions', () => {
  it('ORDER_STATUS_CHANGE (retired 2026-07-29) is no longer subscribed; ORDER_CHANGE still is', () => {
    expect(NEXUS_SP_API_NOTIFICATION_TYPES).not.toContain('ORDER_STATUS_CHANGE')
    expect(NEXUS_SP_API_NOTIFICATION_TYPES).toContain('ORDER_CHANGE')
  })
  it('with profiles ON the setup runs inside each profile that has an Amazon account, and one failure does not stop the others', async () => {
    vi.stubEnv('NEXUS_ENABLE_AMAZON_SQS_POLL', '1')
    const result = await runAmazonNotificationSetup()
    expect(result).toEqual({ visited: 3, ran: 1 })
    expect(h.cronRuns).toEqual([{ name: 'amazon-notifications-setup', workspace: 'ws-a' }])
  })
  it('with profiles OFF it runs once, as before', async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '0')
    expect(await runAmazonNotificationSetup()).toEqual({ visited: 1, ran: 1 })
    expect(h.cronRuns).toEqual([{ name: 'amazon-notifications-setup', workspace: undefined }])
  })
})
