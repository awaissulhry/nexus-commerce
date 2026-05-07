/**
 * O.9b — Amazon Buy Shipping smoke tests. Pure functions only; no DB;
 * no real HTTP. Same hand-rolled pattern as sibling tests.
 */

import {
  getEligibleShippingServices,
  createShipment,
  cancelBuyShippingShipment,
  __test,
  ShipmentRequestDetails,
} from './buy-shipping.js'

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = []
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn })
}
function assert(cond: unknown, msg = 'assertion failed') {
  if (!cond) throw new Error(msg)
}

const prevEnable = process.env.NEXUS_ENABLE_AMAZON_BUY_SHIPPING
process.env.NEXUS_ENABLE_AMAZON_BUY_SHIPPING = 'false'

const sample: ShipmentRequestDetails = {
  amazonOrderId: '123-4567890-1234567',
  itemList: [{ orderItemId: 'A1B2C3D4', quantity: 1 }],
  shipFromAddress: {
    name: 'Xavia',
    addressLine1: 'Via Roma 1',
    city: 'Riccione',
    postalCode: '47838',
    countryCode: 'IT',
  },
  weightGrams: 1500,
  lengthCm: 30,
  widthCm: 25,
  heightCm: 10,
}

test('isReal() defaults to false', () => {
  assert(__test.isReal() === false)
})

test('toAmazonShape preserves order ID + items', () => {
  const a = __test.toAmazonShape(sample)
  assert(a.AmazonOrderId === '123-4567890-1234567')
  assert(a.ItemList.length === 1)
  assert(a.ItemList[0].OrderItemId === 'A1B2C3D4')
  assert(a.ItemList[0].Quantity === 1)
})

test('toAmazonShape converts weight + dimensions to Amazon shape', () => {
  const a = __test.toAmazonShape(sample)
  assert(a.Weight.Value === 1500, 'weight value')
  assert(a.Weight.Unit === 'grams', 'weight unit')
  assert(a.PackageDimensions.Length === 30, 'length')
  assert(a.PackageDimensions.Unit === 'centimeters', 'dim unit')
})

test('toAmazonShape omits PackageDimensions when any dim is missing', () => {
  const noDims: ShipmentRequestDetails = { ...sample, lengthCm: 0, widthCm: 0, heightCm: 0 }
  const a = __test.toAmazonShape(noDims)
  assert(a.PackageDimensions === undefined, 'dims omitted')
})

test('toAmazonShape defaults shipping options safely', () => {
  const a = __test.toAmazonShape(sample)
  assert(a.ShippingServiceOptions.DeliveryExperience === 'DeliveryConfirmationWithoutSignature')
  assert(a.ShippingServiceOptions.CarrierWillPickUp === false)
})

test('getEligibleShippingServices in dryRun returns 3 mock services', async () => {
  const services = await getEligibleShippingServices(sample)
  assert(services.length === 3, `expected 3, got ${services.length}`)
  // Ordered low → high cost so rate-compare UI can show the cheapest first.
  assert(services[0].rate.amount < services[1].rate.amount, 'sorted ascending by rate')
  assert(services[1].rate.amount < services[2].rate.amount, 'sorted ascending by rate')
  assert(services[0].carrierName === 'DPD', 'cheapest is DPD')
})

test('createShipment in dryRun returns a Purchased mock with base64 label', async () => {
  const out = await createShipment(sample, 'MOCK-OFFER-DPD-1')
  assert(out.dryRun === true, 'dryRun flag')
  assert(out.amazonShipmentId.startsWith('MOCK-AMZ-SHIP-'), 'mock id prefix')
  assert(out.trackingId?.startsWith('MOCK-BS-'), 'mock tracking prefix')
  assert(out.labelData != null, 'label present')
  assert(out.labelFormat === 'PDF', 'PDF format')
  // base64-decoded should start with %PDF
  const decoded = Buffer.from(out.labelData!, 'base64').toString('utf8')
  assert(decoded.startsWith('%PDF'), 'base64 decodes to PDF prefix')
})

test('cancelBuyShippingShipment in dryRun returns ok=true', async () => {
  const out = await cancelBuyShippingShipment('MOCK-SHIP-1')
  assert(out.ok === true)
})

;(async () => {
  let passed = 0
  let failed = 0
  for (const t of tests) {
    try {
      await t.fn()
      passed++
    } catch (err) {
      failed++
      // eslint-disable-next-line no-console
      console.error(`FAIL: ${t.name}`, err instanceof Error ? err.message : err)
    }
  }
  if (prevEnable === undefined) delete process.env.NEXUS_ENABLE_AMAZON_BUY_SHIPPING
  else process.env.NEXUS_ENABLE_AMAZON_BUY_SHIPPING = prevEnable
  if (failed > 0) {
    // eslint-disable-next-line no-console
    console.error(`amazon-pushback buy-shipping.test.ts: ${failed} failed / ${passed} passed`)
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log(`amazon-pushback buy-shipping.test.ts: ${passed}/${passed} passed`)
})()
