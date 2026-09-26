/** PE P3.1 — the eBay Inventory live reader on anonymised fixtures (no network). */
import { describe, expect, it, vi } from 'vitest'
import { readEbayInventoryListing, type EbayInventoryReads } from './ebay-inventory.js'

const destination = { productId: 'family', channel: 'EBAY' as const, marketplace: 'IT', accountId: 'account', aliasKey: '',
  expectedSkus: ['FAM-RED-M', 'FAM-RED-L'], itemId: '9000000001', parentSku: 'FAM' }
const group = (overrides: Record<string, unknown> = {}) => ({ title: 'Jacket', description: '<p>Warm</p>', imageUrls: ['https://img.example/1.jpg'],
  aspects: { Marca: ['Brand'], 'Tipo di prodotto': ['Giacca'] }, variantSKUs: ['FAM-RED-M', 'FAM-RED-L'],
  variesBy: { specifications: [{ name: 'Colore', values: ['Rosso'] }, { name: 'Taglia', values: ['M', 'L'] }] }, ...overrides })
const inventoryItem = (size: string, quantity: number, inventoryItemGroupKeys = ['FAM']) =>
  ({ product: { aspects: { Colore: ['Rosso'], Taglia: [size] } }, availability: { shipToLocationAvailability: { quantity } }, inventoryItemGroupKeys })
const getItemXml = `<?xml version="1.0"?><GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Item><ItemID>9000000001</ItemID><Variations>
  <Variation><SKU>FAM-RED-M</SKU><StartPrice currencyID="EUR">19.90</StartPrice></Variation>
  <Variation><SKU>FAM-RED-L</SKU><StartPrice currencyID="EUR">21.90</StartPrice></Variation></Variations></Item></GetItemResponse>`

function reads(over: Partial<{ groups: Record<string, { status: number; body: any }>; items: Record<string, any>; getItem: { xml: string | null; error?: string } }> = {}): EbayInventoryReads & { groupCalls: string[] } {
  const groups = over.groups ?? { FAM: { status: 200, body: group() } }
  const items = over.items ?? { 'FAM-RED-M': inventoryItem('M', 3), 'FAM-RED-L': inventoryItem('L', 0) }
  const groupCalls: string[] = []
  return { groupCalls,
    group: vi.fn(async (key: string) => { groupCalls.push(key); return groups[key] ?? { status: 404, body: null } }),
    items: vi.fn(async (skus: string[]) => skus.map(sku => items[sku] === 'error' ? { sku, statusCode: 500, inventoryItem: null }
      : items[sku] ? { sku, statusCode: 200, inventoryItem: items[sku] } : { sku, statusCode: 404, inventoryItem: null })),
    getItem: vi.fn(async () => over.getItem ?? { xml: getItemXml }) }
}
const now = () => new Date('2026-09-26T20:00:00Z')

describe('readEbayInventoryListing', () => {
  it('reads content, channel axis names in channel order, value order, price and available stock', async () => {
    const read = await readEbayInventoryListing(destination, reads(), now)
    expect(read).toMatchObject({ readAt: '2026-09-26T20:00:00.000Z', source: 'ebay-inventory-group', errors: [],
      destination: { productId: 'family', channel: 'EBAY', marketplace: 'IT', accountId: 'account', aliasKey: '' } })
    expect(read.content).toEqual({ title: { state: 'value', value: 'Jacket' }, description: { state: 'value', value: '<p>Warm</p>' },
      pictures: { state: 'value', value: ['https://img.example/1.jpg'] }, 'aspect:marca': { state: 'value', value: ['Brand'] },
      'aspect:tipo di prodotto': { state: 'value', value: ['Giacca'] } })
    expect(read.variations).toEqual({ axes: ['Colore', 'Taglia'], order: { Colore: ['Rosso'], Taglia: ['M', 'L'] }, variants: [
      { sku: 'FAM-RED-M', values: { Colore: 'Rosso', Taglia: 'M' }, price: { state: 'value', value: { amount: '19.90', currency: 'EUR' } }, stock: { state: 'value', value: 3 }, state: 'live' },
      { sku: 'FAM-RED-L', values: { Colore: 'Rosso', Taglia: 'L' }, price: { state: 'value', value: { amount: '21.90', currency: 'EUR' } }, stock: { state: 'value', value: 0 }, state: 'live' }] })
    expect(read.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(read.raw.groupKey).toBe('FAM')
  })

  it('finds a group whose key is not the parent SKU by asking the items, exactly one answer', async () => {
    const r = reads({ groups: { OLD: { status: 200, body: group() } }, items: { 'FAM-RED-M': inventoryItem('M', 3, ['OLD']), 'FAM-RED-L': inventoryItem('L', 0, ['OLD']) } })
    const read = await readEbayInventoryListing(destination, r, now)
    expect(r.groupCalls).toEqual(['FAM', 'OLD'])
    expect(read.raw.groupKey).toBe('OLD')
    expect(read.errors).toEqual([])
  })

  it('never guesses between two groups: content is unread with the reason, no revision', async () => {
    const read = await readEbayInventoryListing(destination, reads({ groups: {}, items: { 'FAM-RED-M': inventoryItem('M', 3, ['A']), 'FAM-RED-L': inventoryItem('L', 0, ['B']) } }), now)
    expect(read.revision).toBeNull()
    expect(read.variations).toBeNull()
    expect(read.content.title).toEqual({ state: 'unread', reason: 'The items belong to 2 eBay groups; the group cannot be chosen.' })
    expect(read.errors[0]).toMatchObject({ scope: 'item' })
  })

  it('a failed item read is addressed to that SKU; its stock is unread, never zero', async () => {
    const read = await readEbayInventoryListing(destination, reads({ items: { 'FAM-RED-M': inventoryItem('M', 3), 'FAM-RED-L': 'error' } }), now)
    expect(read.errors).toEqual([{ scope: 'sku', sku: 'FAM-RED-L', reason: 'The eBay item could not be read (500).' }])
    expect(read.variations!.variants[1]).toMatchObject({ sku: 'FAM-RED-L', values: {}, stock: { state: 'unread' } })
  })

  it('a failed GetItem leaves every price unread and the content readable', async () => {
    const read = await readEbayInventoryListing(destination, reads({ getItem: { xml: null, error: 'GetItem timed out' } }), now)
    expect(read.errors).toEqual([{ scope: 'field', field: 'price', reason: 'GetItem timed out' }])
    expect(read.variations!.variants.every(v => v.price.state === 'unread')).toBe(true)
    expect(read.content.title).toEqual({ state: 'value', value: 'Jacket' })
  })

  it('a read that throws names its real cause — for the group and for each SKU — never just "no answer"', async () => {
    const r = reads()
    r.group = vi.fn(async () => { throw new Error('NEXUS_CREDENTIAL_ENC_KEY is missing or malformed') })
    r.items = vi.fn(async () => { throw new Error('token refresh failed') })
    const read = await readEbayInventoryListing(destination, r, now)
    expect(read.errors).toContainEqual({ scope: 'item', reason: 'The eBay group could not be read: NEXUS_CREDENTIAL_ENC_KEY is missing or malformed.' })
    expect(read.errors).toContainEqual({ scope: 'sku', sku: 'FAM-RED-M', reason: 'The eBay item could not be read: token refresh failed.' })
    expect(read.content.title).toEqual({ state: 'unread', reason: 'The eBay group could not be read: NEXUS_CREDENTIAL_ENC_KEY is missing or malformed.' })
  })

  it('marks a Nexus SKU the group lacks as missing and a group SKU Nexus lacks as extra', async () => {
    const read = await readEbayInventoryListing({ ...destination, expectedSkus: ['FAM-RED-M', 'FAM-BLUE-M'] }, reads(), now)
    expect(read.variations!.variants.map(v => [v.sku, v.state])).toEqual([['FAM-RED-M', 'live'], ['FAM-RED-L', 'extra'], ['FAM-BLUE-M', 'missing']])
  })

  it('the revision follows content, not the available quantity that moves by itself', async () => {
    const base = (await readEbayInventoryListing(destination, reads(), now)).revision
    const stockMoved = (await readEbayInventoryListing(destination, reads({ items: { 'FAM-RED-M': inventoryItem('M', 9), 'FAM-RED-L': inventoryItem('L', 0) } }), now)).revision
    const titleMoved = (await readEbayInventoryListing(destination, reads({ groups: { FAM: { status: 200, body: group({ title: 'Coat' }) } } }), now)).revision
    expect(stockMoved).toBe(base)
    expect(titleMoved).not.toBe(base)
  })
})
