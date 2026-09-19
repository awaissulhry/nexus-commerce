/**
 * P1.4b — the three Shopify order-action callers use the ORDER's own account through
 * services/shopify/order-actions.service.ts, each behind its own switch; the env credentials of the old
 * `ShopifyEnhancedService` paths are set and must not be used. Refund (publishRefundToChannel), cancel
 * (cancelOnShopify) and tracking (the push-back sweep).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; input: any }>,
  accountScopes: [] as any[],
  fail: null as string | null,
  logWrites: [] as any[],
}))
vi.mock('./order-actions.service.js', () => ({
  shopifyOrderAccount: vi.fn(async (scope: any) => { h.accountScopes.push(scope); return 'shop-B' }),
  refundShopifyOrder: vi.fn(async (input: any) => { h.calls.push({ fn: 'refund', input }); if (h.fail) throw new Error(h.fail); return { refundId: 'gid://shopify/Refund/9' } }),
  cancelShopifyOrder: vi.fn(async (input: any) => { h.calls.push({ fn: 'cancel', input }); if (h.fail) throw new Error(h.fail); return { jobId: 'gid://shopify/Job/1' } }),
  fulfilShopifyOrder: vi.fn(async (input: any) => { h.calls.push({ fn: 'fulfil', input }); if (h.fail) throw new Error(h.fail); return { fulfillmentId: 'gid://shopify/Fulfillment/5', alreadyThere: false } }),
}))
vi.mock('../../db.js', () => {
  const trackingMessageLog = {
    updateMany: vi.fn(async (args: any) => ({ count: args?.where?.status === 'IN_FLIGHT' ? 0 : 1 })),
    findMany: vi.fn(async () => [{ id: 'row-1' }]),
    findUnique: vi.fn(async () => ({ id: 'row-1', shipmentId: 'sh-1', channel: 'SHOPIFY', attemptCount: 1, maxAttempts: 8 })),
    update: vi.fn((args: any) => { h.logWrites.push(args.data); return args }),
  }
  return {
    default: {
      return: { findUnique: vi.fn(async () => ({ id: 'ret-1', channel: 'SHOPIFY', refundCents: 2500, currencyCode: 'EUR', notes: null, order: { id: 'order-1', channelOrderId: '1001', channel: 'SHOPIFY' } })) },
      trackingMessageLog,
      shipment: {
        findUnique: vi.fn(async () => ({ id: 'sh-1', trackingNumber: 'TRK1', carrierCode: 'SENDCLOUD', trackingUrl: 'https://t.example/TRK1', order: { id: 'order-1', channelOrderId: '1001' } })),
        update: vi.fn((args: any) => args),
      },
      $transaction: vi.fn(async (ops: unknown[]) => ops),
    },
  }
})
vi.mock('../outbound-events.service.js', () => ({ publishOutboundEvent: vi.fn() }))

import { publishRefundToChannel } from '../refunds/refund-publisher.service.js'
import { cancelOnShopify } from '../order-cancellation/channel-cancel.js'
import { runTrackingPushbackSweep } from '../../jobs/tracking-pushback.job.js'

beforeEach(() => {
  h.calls = []; h.accountScopes = []; h.fail = null; h.logWrites = []
  vi.stubEnv('SHOPIFY_SHOP_NAME', 'env-shop'); vi.stubEnv('SHOPIFY_ACCESS_TOKEN', 'env-token')
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('P1.4b — refund', () => {
  it('switch on: the order\'s account, the return\'s amount and id; no direct call', async () => {
    vi.stubEnv('NEXUS_ENABLE_SHOPIFY_REFUND', 'true')
    const r = await publishRefundToChannel({ returnId: 'ret-1' } as any)
    expect(r).toMatchObject({ outcome: 'OK', channelRefundId: 'gid://shopify/Refund/9' })
    expect(h.accountScopes).toEqual([{ orderId: 'order-1' }])
    expect(h.calls).toEqual([{ fn: 'refund', input: { accountId: 'shop-B', channelOrderId: '1001', returnId: 'ret-1', amount: '25.00', note: 'Refund issued via Nexus Commerce' } }])
    expect(fetch).not.toHaveBeenCalled()
  })
  it('switch off: nothing sent', async () => {
    await publishRefundToChannel({ returnId: 'ret-1' } as any)
    expect(h.calls).toHaveLength(0)
  })
  it('a refusal is the refund\'s error', async () => {
    vi.stubEnv('NEXUS_ENABLE_SHOPIFY_REFUND', 'true')
    h.fail = 'Shopify order has no refundable capture or sale transaction.'
    expect(await publishRefundToChannel({ returnId: 'ret-1' } as any)).toEqual({ outcome: 'FAILED', error: h.fail })
  })
})

describe('P1.4b — cancel', () => {
  it('switch on: the order named by the route decides the account; reason mapped', async () => {
    vi.stubEnv('NEXUS_ENABLE_SHOPIFY_ORDER_CANCEL', 'true')
    const r = await cancelOnShopify('1001', 'Out of stock', 'order-1')
    expect(r).toMatchObject({ ok: true, ackRef: 'gid://shopify/Job/1', dryRun: false })
    expect(h.accountScopes).toEqual([{ orderId: 'order-1' }])
    expect(h.calls).toEqual([{ fn: 'cancel', input: { accountId: 'shop-B', channelOrderId: '1001', reason: 'INVENTORY', staffNote: 'Out of stock' } }])
    expect(fetch).not.toHaveBeenCalled()
  })
  it('no order id: the Shopify order id finds the order', async () => {
    vi.stubEnv('NEXUS_ENABLE_SHOPIFY_ORDER_CANCEL', 'true')
    await cancelOnShopify('1001', undefined)
    expect(h.accountScopes).toEqual([{ channelOrderId: '1001' }])
  })
  it('switch off: dry run, nothing sent', async () => {
    expect(await cancelOnShopify('1001', 'x', 'order-1')).toMatchObject({ ok: true, dryRun: true })
    expect(h.calls).toHaveLength(0)
  })
})

describe('P1.4b — tracking push-back', () => {
  it('switch on: fulfilled on the order\'s account with the shipment\'s tracking; the row is SUCCESS', async () => {
    vi.stubEnv('NEXUS_ENABLE_SHOPIFY_SHIP_CONFIRM', 'true')
    const stats = await runTrackingPushbackSweep()
    expect(stats.succeeded).toBe(1)
    expect(h.accountScopes).toEqual([{ orderId: 'order-1' }])
    expect(h.calls).toEqual([{ fn: 'fulfil', input: { accountId: 'shop-B', channelOrderId: '1001', tracking: { number: 'TRK1', company: 'SENDCLOUD', url: 'https://t.example/TRK1' } } }])
    expect(fetch).not.toHaveBeenCalled()
  })
  it('switch off: nothing sent, and the row is NOT marked a success', async () => {
    const stats = await runTrackingPushbackSweep()
    expect(h.calls).toHaveLength(0)
    expect(stats.succeeded).toBe(0)
    expect(h.logWrites.at(-1)).toMatchObject({ lastErrorCode: 'SHIP_CONFIRM_OFF' })
  })
})
