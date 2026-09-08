import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShipmentRequestDetails } from './buy-shipping.js'

const resolveConnection = vi.fn(async () => ({ id: 'order-owner-not-primary' }))
const callAPI = vi.fn(async () => ({ ShippingServiceList: [] }))
const getAmazonSpClient = vi.fn(async () => ({ callAPI }))
vi.mock('../connection-resolver.service.js', () => ({ resolveConnection }))
vi.mock('../../lib/amazon-sp-client.js', () => ({ getAmazonSpClient }))
const { getEligibleShippingServices, createShipment } = await import('./buy-shipping.js')

const details: ShipmentRequestDetails = {
  amazonOrderId: '123-4567890-1234567',
  itemList: [{ orderItemId: 'item', quantity: 1 }],
  shipFromAddress: { name: 'Sender', addressLine1: 'Street', city: 'Rome', postalCode: '00100', countryCode: 'IT' },
  weightGrams: 1000,
}

describe('Buy Shipping account routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXUS_ENABLE_AMAZON_BUY_SHIPPING', 'true')
    resolveConnection.mockResolvedValue({ id: 'order-owner-not-primary' })
  })

  it('quotes with the account attributed to the order', async () => {
    await getEligibleShippingServices(details)
    expect(resolveConnection).toHaveBeenCalledWith({ channel: 'AMAZON', channelOrderId: details.amazonOrderId })
    expect(getAmazonSpClient).toHaveBeenCalledWith('order-owner-not-primary')
  })

  it('purchases with the account attributed to the order', async () => {
    // The minimal fixture stops after the request; routing must already be correct.
    await expect(createShipment(details, 'offer')).rejects.toThrow('no Shipment')
    expect(getAmazonSpClient).toHaveBeenCalledWith('order-owner-not-primary')
    expect(callAPI).toHaveBeenCalledWith(expect.objectContaining({ operation: 'createShipment' }))
  })

  it('never falls back to another account when the order owner is disconnected', async () => {
    resolveConnection.mockRejectedValueOnce(new Error('Order owner is not active'))
    await expect(createShipment(details, 'offer')).rejects.toThrow('not active')
    expect(getAmazonSpClient).not.toHaveBeenCalled()
    expect(callAPI).not.toHaveBeenCalled()
  })
})
