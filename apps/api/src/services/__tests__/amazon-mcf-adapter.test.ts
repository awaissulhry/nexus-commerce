/**
 * FCF.5 — Unit tests for the SP-API FBA Outbound (MCF) adapter mapping.
 *
 * The adapter is pure given a request() stub: it maps the MCFAdapter surface
 * onto SP-API FBA Outbound v2020-07-01 calls and parses the responses. These
 * tests pin the request shape (path, method, body) and the response parsing
 * without touching the network.
 */

import { describe, it, expect } from 'vitest'
import { createSpApiMcfAdapter } from '../amazon-mcf.service.js'

type Call = { method: string; path: string; opts: any }

function stubRequester(responses: unknown[] = []) {
  const calls: Call[] = []
  let i = 0
  return {
    calls,
    request: async (method: string, path: string, opts: any = {}) => {
      calls.push({ method, path, opts })
      return responses[i++] ?? {}
    },
  }
}

const baseArgs = {
  sellerFulfillmentOrderId: 'MCF-abc123-xy',
  marketplaceId: 'APJ6JRA9NG5V4',
  displayableOrderId: 'EBAY-987',
  displayableOrderDate: new Date('2026-05-29T10:00:00.000Z'),
  displayableOrderComment: 'thanks!',
  shippingSpeedCategory: 'Standard' as const,
  destinationAddress: {
    name: 'Mario Rossi',
    addressLine1: 'Via Roma 1',
    city: 'Milano',
    postalCode: '20100',
    countryCode: 'IT',
  },
  items: [{ sellerSku: 'SKU-1', sellerFulfillmentOrderItemId: 'abc123-0', quantity: 2 }],
}

describe('createSpApiMcfAdapter | createFulfillmentOrder', () => {
  it('POSTs to the fulfillmentOrders endpoint with an ISO date', async () => {
    const stub = stubRequester([{}])
    const adapter = createSpApiMcfAdapter(stub, { sandbox: false })
    await adapter.createFulfillmentOrder(baseArgs)
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0].method).toBe('POST')
    expect(stub.calls[0].path).toBe('/fba/outbound/2020-07-01/fulfillmentOrders')
    const body = stub.calls[0].opts.body
    expect(body.sellerFulfillmentOrderId).toBe('MCF-abc123-xy')
    expect(body.displayableOrderDate).toBe('2026-05-29T10:00:00.000Z')
    expect(body.destinationAddress.countryCode).toBe('IT')
    expect(body.items[0]).toMatchObject({ sellerSku: 'SKU-1', quantity: 2 })
  })

  it('echoes the sellerFulfillmentOrderId as the lookup id (Amazon returns no id)', async () => {
    const stub = stubRequester([{}])
    const adapter = createSpApiMcfAdapter(stub, { sandbox: false })
    const res = await adapter.createFulfillmentOrder(baseArgs)
    expect(res.amazonFulfillmentOrderId).toBe('MCF-abc123-xy')
  })

  it('omits optional address/item fields when absent', async () => {
    const stub = stubRequester([{}])
    const adapter = createSpApiMcfAdapter(stub, { sandbox: false })
    await adapter.createFulfillmentOrder(baseArgs)
    const addr = stub.calls[0].opts.body.destinationAddress
    expect('addressLine2' in addr).toBe(false)
    expect('phone' in addr).toBe(false)
  })

  it('passes sandbox through to the requester', async () => {
    const stub = stubRequester([{}])
    const adapter = createSpApiMcfAdapter(stub, { sandbox: true })
    await adapter.createFulfillmentOrder(baseArgs)
    expect(stub.calls[0].opts.sandbox).toBe(true)
  })
})

describe('createSpApiMcfAdapter | getFulfillmentOrder', () => {
  it('GETs by id and parses status + tracking from the payload', async () => {
    const stub = stubRequester([
      {
        payload: {
          fulfillmentOrder: { fulfillmentOrderStatus: 'COMPLETE', statusUpdatedDate: '2026-05-30T00:00:00Z' },
          fulfillmentShipments: [
            {
              fulfillmentShipmentStatus: 'SHIPPED',
              shippingDate: '2026-05-29T12:00:00Z',
              fulfillmentShipmentPackage: [{ trackingNumber: 'TRK1', carrierCode: 'UPS' }],
            },
          ],
        },
      },
    ])
    const adapter = createSpApiMcfAdapter(stub, { sandbox: false })
    const res = await adapter.getFulfillmentOrder('MCF-abc123-xy')
    expect(stub.calls[0].method).toBe('GET')
    expect(stub.calls[0].path).toBe('/fba/outbound/2020-07-01/fulfillmentOrders/MCF-abc123-xy')
    expect(res.status).toBe('COMPLETE')
    expect(res.fulfillmentShipments?.[0]).toMatchObject({ shipmentStatus: 'SHIPPED', trackingNumber: 'TRK1', carrier: 'UPS' })
  })

  it('defaults status to UNKNOWN when the payload is empty', async () => {
    const stub = stubRequester([{}])
    const adapter = createSpApiMcfAdapter(stub, { sandbox: false })
    const res = await adapter.getFulfillmentOrder('MCF-x')
    expect(res.status).toBe('UNKNOWN')
    expect(res.fulfillmentShipments).toEqual([])
  })
})

describe('createSpApiMcfAdapter | cancelFulfillmentOrder', () => {
  it('PUTs to the cancel endpoint', async () => {
    const stub = stubRequester([{}])
    const adapter = createSpApiMcfAdapter(stub, { sandbox: false })
    await adapter.cancelFulfillmentOrder('MCF-abc123-xy')
    expect(stub.calls[0].method).toBe('PUT')
    expect(stub.calls[0].path).toBe('/fba/outbound/2020-07-01/fulfillmentOrders/MCF-abc123-xy/cancel')
  })
})
