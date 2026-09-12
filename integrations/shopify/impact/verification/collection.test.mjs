import { test } from 'node:test'
import assert from 'node:assert/strict'
globalThis.document = { documentElement: { lang: 'en' }, addEventListener() {} }
globalThis.HTMLElement = class {}
globalThis.customElements = { get() {}, define() {} }
const { orderCards } = await import('../nexus-collection.js')
const cards = [{ key: 'red', price: 200, title: 'Helmet · Red', source: 0 }, { key: 'blue', price: 180, title: 'Helmet · Blue', source: 1 }, { key: 'green', price: 200, title: 'Helmet · Green', source: 2 }]
test('featured ordering moves colours independently and appends new cards', () => assert.deepEqual(orderCards(cards, ['blue', 'red'], 'manual').map(c => c.key), ['blue', 'red', 'green']))
test('shopper price sorting takes precedence and ties remain stable', () => assert.deepEqual(orderCards(cards, ['green', 'red', 'blue'], 'price-ascending').map(c => c.key), ['blue', 'red', 'green']))
test('localized titles sort cards while product-level best-selling order stays native', () => {
  assert.deepEqual(orderCards(cards, [], 'title-ascending').map(c => c.key), ['blue', 'green', 'red'])
  assert.deepEqual(orderCards(cards, ['blue'], 'best-selling').map(c => c.key), ['red', 'blue', 'green'])
})
