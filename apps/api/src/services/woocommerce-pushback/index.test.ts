/**
 * O.11 — WooCommerce pushback smoke tests.
 */

import { submitShipConfirmation, __test, WooShipConfirmationInput } from './index.js'

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = []
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn })
}
function assert(cond: unknown, msg = 'assertion failed') {
  if (!cond) throw new Error(msg)
}

const prevEnable = process.env.NEXUS_ENABLE_WOO_SHIP_CONFIRM
process.env.NEXUS_ENABLE_WOO_SHIP_CONFIRM = 'false'

const sample: WooShipConfirmationInput = {
  wooOrderId: 12345,
  carrierCode: 'BRT',
  carrierName: 'BRT (Bartolini)',
  trackingNumber: 'BRT123456789012',
  shippedAt: new Date('2026-05-07T10:00:00Z'),
}

test('isReal() defaults to false', () => {
  assert(__test.isReal() === false)
})

test('composeShipNote includes carrier + tracking + url', () => {
  const note = __test.composeShipNote(sample)
  assert(note.includes('BRT (Bartolini)'), 'carrier name')
  assert(note.includes('BRT123456789012'), 'tracking')
  assert(note.includes('brt.it'), 'BRT tracking URL via registry')
})

test('composeShipNote falls back gracefully when carrier has no URL pattern', () => {
  const noUrlSample: WooShipConfirmationInput = {
    ...sample,
    carrierCode: 'OTHER',
    carrierName: 'Local Courier',
    trackingUrl: null,
  }
  const note = __test.composeShipNote(noUrlSample)
  // OTHER carrier returns empty URL — note still has carrier + tracking
  assert(note.includes('Local Courier'), 'carrier name')
  assert(note.includes('BRT123456789012'), 'tracking')
})

test('composeShipNote prefers explicit trackingUrl when set', () => {
  const customUrl: WooShipConfirmationInput = {
    ...sample,
    trackingUrl: 'https://custom.example/track/abc',
  }
  const note = __test.composeShipNote(customUrl)
  assert(note.includes('https://custom.example/track/abc'), 'custom URL preserved')
})

test('submitShipConfirmation in dryRun returns mock', async () => {
  const out = await submitShipConfirmation(sample)
  assert(out.dryRun === true)
  assert(out.status === 'completed')
  assert(out.noteAdded === true)
  assert(out.wooOrderId === 12345)
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
  if (prevEnable === undefined) delete process.env.NEXUS_ENABLE_WOO_SHIP_CONFIRM
  else process.env.NEXUS_ENABLE_WOO_SHIP_CONFIRM = prevEnable
  if (failed > 0) {
    // eslint-disable-next-line no-console
    console.error(`woo-pushback index.test.ts: ${failed} failed / ${passed} passed`)
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log(`woo-pushback index.test.ts: ${passed}/${passed} passed`)
})()
