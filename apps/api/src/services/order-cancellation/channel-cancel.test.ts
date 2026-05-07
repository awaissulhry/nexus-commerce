/**
 * O.50 — channel-cancel smoke tests.
 */

import { cancelOnAmazon, cancelOnEbay, cancelOnShopify, __test } from './channel-cancel.js'

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = []
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }) }
function assert(cond: unknown, msg = 'assertion failed') {
  if (!cond) throw new Error(msg)
}

const prevAmazon = process.env.NEXUS_ENABLE_AMAZON_ORDER_CANCEL
const prevEbay = process.env.NEXUS_ENABLE_EBAY_ORDER_CANCEL
const prevShopify = process.env.NEXUS_ENABLE_SHOPIFY_ORDER_CANCEL
process.env.NEXUS_ENABLE_AMAZON_ORDER_CANCEL = 'false'
process.env.NEXUS_ENABLE_EBAY_ORDER_CANCEL = 'false'
process.env.NEXUS_ENABLE_SHOPIFY_ORDER_CANCEL = 'false'

test('all channels default to dryRun', () => {
  assert(__test.isAmazonReal() === false)
  assert(__test.isEbayReal() === false)
  assert(__test.isShopifyReal() === false)
})

test('mapReasonToAmazon: stock keywords → NoInventory', () => {
  assert(__test.mapReasonToAmazon('out of stock') === 'NoInventory')
  assert(__test.mapReasonToAmazon('Inventory issue') === 'NoInventory')
})

test('mapReasonToAmazon: customer/buyer → BuyerCanceled', () => {
  assert(__test.mapReasonToAmazon('Customer asked') === 'BuyerCanceled')
  assert(__test.mapReasonToAmazon('Buyer changed mind') === 'BuyerCanceled')
})

test('mapReasonToAmazon: fallback → GeneralAdjustment', () => {
  assert(__test.mapReasonToAmazon('something else') === 'GeneralAdjustment')
  assert(__test.mapReasonToAmazon(undefined) === 'GeneralAdjustment')
})

test('mapReasonToEbay: stock → OUT_OF_STOCK_OR_CANNOT_FULFILL', () => {
  assert(__test.mapReasonToEbay('out of stock') === 'OUT_OF_STOCK_OR_CANNOT_FULFILL')
})

test('mapReasonToEbay: buyer asked → BUYER_ASKED_CANCEL', () => {
  assert(__test.mapReasonToEbay('Buyer asked') === 'BUYER_ASKED_CANCEL')
})

test('cancelOnAmazon dryRun returns ok mock with null ackRef', async () => {
  const r = await cancelOnAmazon('123-4567890-1234567', 'Out of stock', ['APJ6JRA9NG5V4'])
  assert(r.ok === true)
  assert(r.dryRun === true)
  assert(r.ackRef === null)
  assert(r.channel === 'AMAZON')
})

test('cancelOnEbay dryRun returns ok mock', async () => {
  const r = await cancelOnEbay('27-12345-67890', 'Buyer asked', 'fake-conn')
  assert(r.ok === true)
  assert(r.dryRun === true)
  assert(r.channel === 'EBAY')
})

test('cancelOnShopify dryRun returns ok mock', async () => {
  const r = await cancelOnShopify('5555555', 'Customer changed mind')
  assert(r.ok === true)
  assert(r.dryRun === true)
  assert(r.channel === 'SHOPIFY')
})

;(async () => {
  let passed = 0
  let failed = 0
  for (const t of tests) {
    try { await t.fn(); passed++ }
    catch (err) { failed++; console.error(`FAIL: ${t.name}`, err instanceof Error ? err.message : err) }
  }
  if (prevAmazon === undefined) delete process.env.NEXUS_ENABLE_AMAZON_ORDER_CANCEL; else process.env.NEXUS_ENABLE_AMAZON_ORDER_CANCEL = prevAmazon
  if (prevEbay === undefined) delete process.env.NEXUS_ENABLE_EBAY_ORDER_CANCEL; else process.env.NEXUS_ENABLE_EBAY_ORDER_CANCEL = prevEbay
  if (prevShopify === undefined) delete process.env.NEXUS_ENABLE_SHOPIFY_ORDER_CANCEL; else process.env.NEXUS_ENABLE_SHOPIFY_ORDER_CANCEL = prevShopify
  if (failed > 0) { console.error(`channel-cancel: ${failed} failed / ${passed} passed`); process.exit(1) }
  console.log(`channel-cancel: ${passed}/${passed} passed`)
})()
