/**
 * O.9 — Amazon FBM pushback smoke tests. Pure functions only; no DB;
 * no real HTTP. Same hand-rolled pattern as sendcloud/client.test.ts.
 */

import { submitShippingConfirmation, __test, ShippingConfirmationInput } from './index.js'

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = []
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn })
}
function assert(cond: unknown, msg = 'assertion failed') {
  if (!cond) throw new Error(msg)
}

const prevEnableReal = process.env.NEXUS_ENABLE_AMAZON_SHIP_CONFIRM
process.env.NEXUS_ENABLE_AMAZON_SHIP_CONFIRM = 'false'

const sample: ShippingConfirmationInput = {
  amazonOrderId: '123-4567890-1234567',
  carrierCode: 'BRT',
  trackingNumber: 'BRT123456789',
  shippedAt: new Date('2026-05-07T10:00:00Z'),
}

test('isReal() defaults to false', () => {
  assert(__test.isReal() === false, 'expected dryRun default')
})

test('CARRIER_MAP maps Sendcloud-aggregated carriers correctly', () => {
  assert(__test.CARRIER_MAP['BRT'] === 'BRT', 'BRT direct')
  assert(__test.CARRIER_MAP['SENDCLOUD'] === 'Other', 'Sendcloud → Other')
  assert(__test.CARRIER_MAP['UPS'] === 'UPS', 'UPS direct')
})

test('buildFeedXml produces well-formed AmazonEnvelope', () => {
  const xml = __test.buildFeedXml(sample, 'M_MERCHANT_TOKEN')
  assert(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'xml prelude')
  assert(xml.includes('<AmazonEnvelope'), 'envelope present')
  assert(xml.includes('<MerchantIdentifier>M_MERCHANT_TOKEN'), 'merchant identifier set')
  assert(xml.includes('<AmazonOrderID>123-4567890-1234567'), 'order id set')
  assert(xml.includes('<CarrierCode>BRT'), 'carrier code mapped')
  assert(xml.includes('<ShipperTrackingNumber>BRT123456789'), 'tracking set')
})

test('buildFeedXml escapes special chars in carrier and tracking', () => {
  const dangerous: ShippingConfirmationInput = {
    amazonOrderId: '<script>',
    carrierCode: 'UNKNOWN',
    carrierName: 'Acme & Co',
    trackingNumber: '"quoted"',
    shippedAt: new Date('2026-05-07T10:00:00Z'),
  }
  const xml = __test.buildFeedXml(dangerous, 'M')
  assert(!xml.includes('<script>'), 'no raw <script>')
  assert(xml.includes('&lt;script&gt;'), 'escaped <script>')
  assert(xml.includes('Acme &amp; Co'), 'escaped ampersand')
  assert(xml.includes('&quot;quoted&quot;'), 'escaped quotes')
})

test('submitShippingConfirmation in dryRun returns mock feedId', async () => {
  const out = await submitShippingConfirmation(sample, ['APJ6JRA9NG5V4'])
  assert(out.dryRun === true, 'dryRun flag set')
  assert(out.feedId.startsWith('MOCK-FEED-'), 'mock feedId prefix')
  assert(out.feedDocumentId.startsWith('MOCK-DOC-'), 'mock docId prefix')
})

test('escapeXml handles all five XML-reserved chars', () => {
  const out = __test.escapeXml(`a<b>c&d"e'f`)
  assert(out === 'a&lt;b&gt;c&amp;d&quot;e&apos;f', `escape mismatch: ${out}`)
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
  if (prevEnableReal === undefined) delete process.env.NEXUS_ENABLE_AMAZON_SHIP_CONFIRM
  else process.env.NEXUS_ENABLE_AMAZON_SHIP_CONFIRM = prevEnableReal
  if (failed > 0) {
    // eslint-disable-next-line no-console
    console.error(`amazon-pushback index.test.ts: ${failed} failed / ${passed} passed`)
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log(`amazon-pushback index.test.ts: ${passed}/${passed} passed`)
})()
