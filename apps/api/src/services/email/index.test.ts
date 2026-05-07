/**
 * O.30 — email render smoke tests.
 */

import { sendShipmentEmail, __test, ShipmentEmailContext } from './index.js'

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = []
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn })
}
function assert(cond: unknown, msg = 'assertion failed') {
  if (!cond) throw new Error(msg)
}

const prevEnable = process.env.NEXUS_ENABLE_OUTBOUND_EMAILS
process.env.NEXUS_ENABLE_OUTBOUND_EMAILS = 'false'

const ctx: ShipmentEmailContext = {
  to: 'cliente@example.it',
  customerName: 'Mario Rossi',
  orderId: 'ord-123',
  orderChannelId: '111-222-333',
  trackingNumber: 'BRT123456789012',
  trackingUrl: null,
  carrier: 'BRT',
  estimatedDelivery: '2026-05-10T00:00:00Z',
  destinationCity: 'Riccione',
  brandedTrackingUrl: 'https://xavia.it/track/BRT123456789012',
  locale: 'it',
}

test('isReal() defaults to false', () => {
  assert(__test.isReal() === false)
})

test('render shipped IT subject + body include order id', () => {
  const r = __test.render('shipped', ctx)
  assert(r.subject.includes('111-222-333'), 'subject has order id')
  assert(r.html.includes('Ciao Mario Rossi'), 'greets in IT')
  assert(r.html.includes('Riccione'), 'destination present')
  assert(r.html.includes('BRT123456789012'), 'tracking present')
  assert(r.html.includes('Traccia il tuo pacco'), 'CTA in IT')
})

test('render delivered EN subject', () => {
  const r = __test.render('delivered', { ...ctx, locale: 'en' })
  assert(r.subject.includes('delivered'), 'subject in EN')
  assert(r.html.includes('Hi Mario Rossi'), 'greets in EN')
  assert(r.html.includes('arrived'), 'arrived copy')
})

test('render exception falls back gracefully', () => {
  const r = __test.render('exception', { ...ctx, trackingNumber: null, brandedTrackingUrl: null })
  assert(r.subject.includes('consegna'), 'IT subject')
  assert(!r.html.includes('Traccia il tuo pacco'), 'no CTA when no URL')
})

test('sendShipmentEmail in dryRun returns mock provider', async () => {
  const r = await sendShipmentEmail('shipped', ctx)
  assert(r.ok === true, 'ok')
  assert(r.dryRun === true, 'dryRun')
  assert(r.provider === 'mock')
  assert(r.messageId?.startsWith('mock-'))
})

;(async () => {
  let passed = 0
  let failed = 0
  for (const t of tests) {
    try { await t.fn(); passed++ }
    catch (err) { failed++; console.error(`FAIL: ${t.name}`, err instanceof Error ? err.message : err) }
  }
  if (prevEnable === undefined) delete process.env.NEXUS_ENABLE_OUTBOUND_EMAILS
  else process.env.NEXUS_ENABLE_OUTBOUND_EMAILS = prevEnable
  if (failed > 0) {
    console.error(`email index.test.ts: ${failed} failed / ${passed} passed`)
    process.exit(1)
  }
  console.log(`email index.test.ts: ${passed}/${passed} passed`)
})()
