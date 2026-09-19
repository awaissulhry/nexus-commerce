/**
 * P1.4b — Shopify order actions on the 2026-07 GraphQL client with the ORDER's own account: which
 * account (recorded, else the only connected one, never "the primary"), the refund (transactions with
 * their gateway, parts that add up, `@idempotent(key)`), the cancel (the 2026-07 top-level form, no
 * refund, no restock) and the tracking fulfilment (only fulfilment orders Shopify can still fulfil; a
 * retry that finds its tracking number reports it instead of fulfilling twice). The shop is a fake that
 * records every operation and the account it was opened for.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  accounts: [] as string[],
  ops: [] as Array<{ query: string; variables: any }>,
  order: { channel: 'SHOPIFY', channelConnectionId: 'shop-B' as string | null } as { channel: string; channelConnectionId: string | null } | null,
  active: [{ id: 'shop-A' }] as Array<{ id: string }>,
  transactions: [] as any[],
  fulfillmentOrders: [] as any[],
  fulfillments: [] as any[],
  refundErrors: [] as any[],
  cancelErrors: [] as any[],
}))
vi.mock('../../db.js', () => ({
  default: { order: { findUnique: vi.fn(async () => h.order), findFirst: vi.fn(async () => h.order) } },
}))
vi.mock('../connection-resolver.service.js', () => ({ listActiveConnections: vi.fn(async () => h.active) }))
vi.mock('./admin-client.js', async (original) => ({
  ...(await original<object>()),
  shopifyAdmin: vi.fn(async (accountId: string) => {
    h.accounts.push(accountId)
    return {
      domain: 'x.myshopify.com',
      graphql: async (query: string, variables: any = {}) => {
        h.ops.push({ query, variables })
        if (query.includes('NexusOrderTransactions')) return { order: { id: variables.id, currencyCode: 'EUR', transactions: h.transactions } }
        if (query.includes('refundCreate')) return { refundCreate: { refund: h.refundErrors.length ? null : { id: 'gid://shopify/Refund/9', legacyResourceId: '9' }, userErrors: h.refundErrors } }
        if (query.includes('orderCancel')) return { orderCancel: { job: { id: 'gid://shopify/Job/1', done: false }, orderCancelUserErrors: h.cancelErrors } }
        if (query.includes('NexusFulfillmentOrders')) return { order: { id: variables.id, fulfillmentOrders: { nodes: h.fulfillmentOrders }, fulfillments: h.fulfillments } }
        if (query.includes('fulfillmentCreate')) return { fulfillmentCreate: { fulfillment: { id: 'gid://shopify/Fulfillment/5', status: 'SUCCESS', trackingInfo: [] }, userErrors: [] } }
        throw new Error(`unexpected operation: ${query.slice(0, 60)}`)
      },
    }
  }),
}))

import { cancelShopifyOrder, fulfilShopifyOrder, refundShopifyOrder, shopifyOrderAccount } from './order-actions.service.js'

const mutations = () => h.ops.filter((o) => /^\s*mutation/.test(o.query))
const tx = (id: string, amount: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'SALE', status: 'SUCCESS', gateway: 'shopify_payments', amountSet: { shopMoney: { amount, currencyCode: 'EUR' } }, ...extra })
const refund = (amount: string, returnId = 'ret-1') => refundShopifyOrder({ accountId: 'shop-B', channelOrderId: '1001', returnId, amount, note: 'Returned' })

beforeEach(() => {
  h.accounts = []; h.ops = []
  h.order = { channel: 'SHOPIFY', channelConnectionId: 'shop-B' }
  h.active = [{ id: 'shop-A' }]
  h.transactions = [tx('gid://shopify/OrderTransaction/1', '100.00')]
  h.fulfillmentOrders = []; h.fulfillments = []; h.refundErrors = []; h.cancelErrors = []
})

describe('P1.4b — whose shop', () => {
  it('the account recorded on the order', async () => {
    expect(await shopifyOrderAccount({ orderId: 'o1' })).toBe('shop-B')
  })
  it('an order with no recorded account: the only connected Shopify account', async () => {
    h.order = { channel: 'SHOPIFY', channelConnectionId: null }
    expect(await shopifyOrderAccount({ channelOrderId: '1001' })).toBe('shop-A')
  })
  it('no recorded account and two connected: refused — never the primary', async () => {
    h.order = { channel: 'SHOPIFY', channelConnectionId: null }
    h.active = [{ id: 'shop-A' }, { id: 'shop-B' }]
    await expect(shopifyOrderAccount({ orderId: 'o1' })).rejects.toThrow(/more than one Shopify account/)
  })
  it('an order Nexus does not have, or not a Shopify order: refused', async () => {
    h.order = null
    await expect(shopifyOrderAccount({ orderId: 'o1' })).rejects.toThrow(/not in Nexus/)
    h.order = { channel: 'EBAY', channelConnectionId: 'x' }
    await expect(shopifyOrderAccount({ orderId: 'o1' })).rejects.toThrow(/not a Shopify order/)
  })
})

describe('P1.4b — refund', () => {
  it('refundCreate on the given account with @idempotent(key) and each transaction\'s gateway', async () => {
    expect(await refund('25.00')).toEqual({ refundId: 'gid://shopify/Refund/9' })
    expect(h.accounts).toEqual(['shop-B'])
    const [write] = mutations()
    expect(write.query).toMatch(/refundCreate\(input: \$input\) @idempotent\(key: \$key\)/)
    expect(write.variables.key).toMatch(/^[0-9a-f]{40}$/)
    expect(write.variables.input.orderId).toBe('gid://shopify/Order/1001')
    expect(write.variables.input.transactions).toEqual([{ orderId: 'gid://shopify/Order/1001', parentId: 'gid://shopify/OrderTransaction/1', gateway: 'shopify_payments', kind: 'REFUND', amount: '25.00' }])
  })
  it('the same return and amount give the same key (a retry does not pay twice); another return, another key', async () => {
    await refund('25.00'); await refund('25.00'); await refund('25.00', 'ret-2')
    const keys = mutations().map((m) => m.variables.key)
    expect(keys[0]).toBe(keys[1])
    expect(keys[2]).not.toBe(keys[0])
  })
  it('split over two payments, the parts add up to the refund exactly', async () => {
    h.transactions = [tx('t1', '30.00'), tx('t2', '70.00'), tx('t3', '5.00', { kind: 'AUTHORIZATION' })]
    await refund('33.33')
    const parts = mutations()[0].variables.input.transactions
    expect(parts.map((p: any) => p.parentId)).toEqual(['t1', 't2'])
    expect(parts.reduce((sum: number, p: any) => sum + Math.round(Number(p.amount) * 100), 0)).toBe(3333)
    // three equal payments: a third of 10.00 each rounds to 3.33 — the last part takes the rest
    h.ops = []; h.transactions = [tx('a', '33.33'), tx('b', '33.33'), tx('c', '33.33')]
    await refund('10.00')
    expect(mutations()[0].variables.input.transactions.map((p: any) => p.amount)).toEqual(['3.33', '3.33', '3.34'])
  })
  it('no refundable payment, or more than was captured: refused, nothing written', async () => {
    h.transactions = [tx('t1', '10.00', { status: 'FAILURE' })]
    await expect(refund('5.00')).rejects.toThrow(/no refundable/)
    h.transactions = [tx('t1', '10.00')]
    await expect(refund('10.01')).rejects.toThrow(/not between 0 and the captured 10.00/)
    expect(mutations()).toHaveLength(0)
  })
  it('Shopify\'s refusal is reported', async () => {
    h.refundErrors = [{ field: ['transactions'], message: 'Amount exceeds refundable' }]
    await expect(refund('5.00')).rejects.toThrow(/Shopify refund: transactions Amount exceeds refundable/)
  })
})

describe('P1.4b — cancel', () => {
  it('the 2026-07 form: top-level arguments, no refund, no restock, note capped', async () => {
    expect(await cancelShopifyOrder({ accountId: 'shop-B', channelOrderId: '1001', reason: 'CUSTOMER', staffNote: 'x'.repeat(300) })).toEqual({ jobId: 'gid://shopify/Job/1' })
    const [write] = mutations()
    expect(write.query).toMatch(/orderCancel\(orderId: \$orderId/)
    expect(write.variables).toMatchObject({ orderId: 'gid://shopify/Order/1001', reason: 'CUSTOMER', restock: false, notifyCustomer: true, refundMethod: { originalPaymentMethodsRefund: false } })
    expect(write.variables.staffNote).toHaveLength(255)
    expect(h.accounts).toEqual(['shop-B'])
  })
  it('Shopify\'s refusal is reported', async () => {
    h.cancelErrors = [{ field: ['orderId'], message: 'Order has active returns', code: 'INVALID' }]
    await expect(cancelShopifyOrder({ accountId: 'shop-B', channelOrderId: '1001', reason: 'OTHER', staffNote: 'n' })).rejects.toThrow(/Order has active returns/)
  })
})

describe('P1.4b — tracking fulfilment', () => {
  const fulfil = () => fulfilShopifyOrder({ accountId: 'shop-B', channelOrderId: '1001', tracking: { number: 'TRK1', company: 'GLS', url: 'https://t.example/TRK1' } })
  it('one fulfilment for the fulfilment orders Shopify can still fulfil, with the tracking', async () => {
    h.fulfillmentOrders = [
      { id: 'fo-1', status: 'OPEN', supportedActions: [{ action: 'CREATE_FULFILLMENT' }] },
      { id: 'fo-2', status: 'CLOSED', supportedActions: [] },
    ]
    expect(await fulfil()).toEqual({ fulfillmentId: 'gid://shopify/Fulfillment/5', alreadyThere: false })
    const [write] = mutations()
    expect(write.variables.fulfillment).toEqual({ notifyCustomer: true, trackingInfo: { number: 'TRK1', company: 'GLS', url: 'https://t.example/TRK1' }, lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: 'fo-1' }] })
  })
  it('a retry finds its tracking number already on the order: reported, nothing written', async () => {
    h.fulfillments = [{ id: 'gid://shopify/Fulfillment/4', trackingInfo: [{ number: 'TRK1' }] }]
    expect(await fulfil()).toEqual({ fulfillmentId: 'gid://shopify/Fulfillment/4', alreadyThere: true })
    expect(mutations()).toHaveLength(0)
  })
  it('nothing left to fulfil and no fulfilment with this number: an error, nothing written', async () => {
    h.fulfillmentOrders = [{ id: 'fo-2', status: 'CLOSED', supportedActions: [] }]
    await expect(fulfil()).rejects.toThrow(/nothing left to fulfil/)
    expect(mutations()).toHaveLength(0)
  })
})
