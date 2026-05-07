/**
 * O.10 — eBay pushback smoke tests.
 */

import { submitShippingFulfillment, __test, ShippingFulfillmentInput } from './index.js'

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = []
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn })
}
function assert(cond: unknown, msg = 'assertion failed') {
  if (!cond) throw new Error(msg)
}

const prevEnable = process.env.NEXUS_ENABLE_EBAY_SHIP_CONFIRM
process.env.NEXUS_ENABLE_EBAY_SHIP_CONFIRM = 'false'

const sample: ShippingFulfillmentInput = {
  ebayOrderId: '27-12345-67890',
  carrierCode: 'BRT',
  trackingNumber: 'BRT123456789',
  shippedAt: new Date('2026-05-07T10:00:00Z'),
}

test('isReal() defaults to false', () => {
  assert(__test.isReal() === false)
})

test('CARRIER_MAP maps BRT, POSTE, GLS, DHL, UPS', () => {
  assert(__test.CARRIER_MAP['BRT'] === 'BRT')
  assert(__test.CARRIER_MAP['POSTE'] === 'POSTE_ITALIANE')
  assert(__test.CARRIER_MAP['GLS'] === 'GLS')
  assert(__test.CARRIER_MAP['DHL'] === 'DHL')
  assert(__test.CARRIER_MAP['UPS'] === 'UPS')
})

test('CARRIER_MAP falls back for SENDCLOUD aggregator', () => {
  assert(__test.CARRIER_MAP['SENDCLOUD'] === 'OTHER')
})

test('submitShippingFulfillment in dryRun returns mock', async () => {
  const out = await submitShippingFulfillment(sample, 'fake-conn-id')
  assert(out.dryRun === true)
  assert(out.fulfillmentId.startsWith('MOCK-EBAY-FUL-'))
  assert(out.ebayOrderId === '27-12345-67890')
  assert(out.status === 'CREATED')
})

test('submitShippingFulfillment dryRun handles lineItems', async () => {
  const withLines: ShippingFulfillmentInput = {
    ...sample,
    lineItems: [{ lineItemId: 'LINE-1', quantity: 2 }],
  }
  const out = await submitShippingFulfillment(withLines, 'fake-conn-id')
  assert(out.dryRun === true, 'still dryRun')
  assert(out.status === 'CREATED', 'still ok')
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
  if (prevEnable === undefined) delete process.env.NEXUS_ENABLE_EBAY_SHIP_CONFIRM
  else process.env.NEXUS_ENABLE_EBAY_SHIP_CONFIRM = prevEnable
  if (failed > 0) {
    // eslint-disable-next-line no-console
    console.error(`ebay-pushback index.test.ts: ${failed} failed / ${passed} passed`)
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log(`ebay-pushback index.test.ts: ${passed}/${passed} passed`)
})()
