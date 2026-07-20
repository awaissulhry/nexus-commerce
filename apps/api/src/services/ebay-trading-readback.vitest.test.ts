/**
 * AS.4a — Trading-lane quantity read-back: XML extraction + diff semantics.
 *
 * The Inventory-API read-back was structurally blind for shared (Trading)
 * listings — every sweep read checked=129 errors=129. This locks the GetItem
 * parser and the pool-authority diff (Amazon P0c model: mismatch → log+heal,
 * never adopt channel numbers into the pool).
 */
import { describe, it, expect } from 'vitest'
import { parseGetItemQuantities, buildGetItemQuantitiesXml } from './ebay-trading-api.service.js'
import { diffTradingReadback, type TradingReadbackEntry } from './ebay-inventory-readback.service.js'

const VARIATION_XML = `<?xml version="1.0" encoding="UTF-8"?>
<GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <Item>
    <ItemID>256552369326</ItemID>
    <Quantity>40</Quantity>
    <SellingStatus><QuantitySold>3</QuantitySold><ListingStatus>Active</ListingStatus></SellingStatus>
    <Variations>
      <Variation>
        <SKU>GALE-JACKET-BLACK-MEN-M</SKU>
        <Quantity>12</Quantity>
        <SellingStatus><QuantitySold>2</QuantitySold></SellingStatus>
        <VariationSpecifics><NameValueList><Name>Taglia</Name><Value>M</Value></NameValueList></VariationSpecifics>
      </Variation>
      <Variation>
        <SKU>GALE-JACKET-BLACK-MEN-L</SKU>
        <Quantity>7</Quantity>
        <SellingStatus><QuantitySold>0</QuantitySold></SellingStatus>
      </Variation>
      <Variation>
        <SKU>AIR&amp;MESH-XL</SKU>
        <Quantity>1</Quantity>
        <SellingStatus><QuantitySold>5</QuantitySold></SellingStatus>
      </Variation>
    </Variations>
  </Item>
</GetItemResponse>`

const SINGLE_XML = `<GetItemResponse><Item>
  <Quantity>9</Quantity>
  <SellingStatus><QuantitySold>4</QuantitySold><ListingStatus>Active</ListingStatus></SellingStatus>
</Item></GetItemResponse>`

const ENDED_XML = `<GetItemResponse><Item>
  <Quantity>5</Quantity>
  <SellingStatus><QuantitySold>5</QuantitySold><ListingStatus>Completed</ListingStatus></SellingStatus>
</Item></GetItemResponse>`

describe('AS.4a — parseGetItemQuantities', () => {
  it('extracts per-variation available = Quantity − QuantitySold', () => {
    const r = parseGetItemQuantities(VARIATION_XML)
    expect(r.listingStatus).toBe('Active')
    expect(r.itemAvailable).toBeNull() // variation listing → no item-level number
    expect(r.variations).toEqual([
      { sku: 'GALE-JACKET-BLACK-MEN-M', available: 10 },
      { sku: 'GALE-JACKET-BLACK-MEN-L', available: 7 },
      { sku: 'AIR&MESH-XL', available: 0 }, // oversold clamps at 0; entity decoded
    ])
  })

  it('item-level listing status is not confused by variation blocks', () => {
    // The item-level Quantity (40) and QuantitySold (3) must NOT leak into
    // variation parsing, and vice versa.
    const r = parseGetItemQuantities(VARIATION_XML)
    expect(r.variations.some((v) => v.available === 37)).toBe(false)
  })

  it('single-SKU listing exposes item-level available', () => {
    const r = parseGetItemQuantities(SINGLE_XML)
    expect(r.variations).toEqual([])
    expect(r.itemAvailable).toBe(5)
    expect(r.listingStatus).toBe('Active')
  })

  it('ended listing carries its status', () => {
    expect(parseGetItemQuantities(ENDED_XML).listingStatus).toBe('Completed')
  })

  it('empty/dry-run raw parses to a harmless no-op shape', () => {
    expect(parseGetItemQuantities('')).toEqual({ listingStatus: null, variations: [], itemAvailable: null })
  })

  it('request XML asks for variations + narrow selectors only', () => {
    const xml = buildGetItemQuantitiesXml('123')
    expect(xml).toContain('<IncludeVariations>true</IncludeVariations>')
    expect(xml).toContain('<OutputSelector>Item.Variations</OutputSelector>')
    expect(xml).not.toContain('Description')
  })
})

describe('AS.4a — diffTradingReadback (pool is the authority)', () => {
  const NOW = 1_700_000_000_000
  const entry = (sku: string, productId: string | null, lastPushedAgoMs: number | null = null): TradingReadbackEntry => ({
    sku,
    itemId: '256552369326',
    marketplace: 'EBAY_IT',
    productId,
    lastPushedAt: lastPushedAgoMs === null ? null : new Date(NOW - lastPushedAgoMs),
  })

  it('flags observed ≠ intended', () => {
    const diffs = diffTradingReadback(
      [entry('A', 'p1')],
      new Map([['A', 4]]),
      new Map([['p1', 7]]),
      { now: NOW },
    )
    expect(diffs).toEqual([
      { sku: 'A', itemId: '256552369326', marketplace: 'EBAY_IT', productId: 'p1', ebayQty: 4, intendedQty: 7 },
    ])
  })

  it('matching quantities produce no diff', () => {
    expect(
      diffTradingReadback([entry('A', 'p1')], new Map([['A', 7]]), new Map([['p1', 7]]), { now: NOW }),
    ).toEqual([])
  })

  it('skips entries pushed within the settle window (sale→revise transient)', () => {
    const diffs = diffTradingReadback(
      [entry('A', 'p1', 30_000)],
      new Map([['A', 4]]),
      new Map([['p1', 7]]),
      { now: NOW, settleMs: 90_000 },
    )
    expect(diffs).toEqual([])
  })

  it('UNCOUNTED products (absent from intended map) are never compared or healed', () => {
    const diffs = diffTradingReadback(
      [entry('A', 'p-uncounted')],
      new Map([['A', 4]]),
      new Map(),
      { now: NOW },
    )
    expect(diffs).toEqual([])
  })

  it('membership without productId is skipped', () => {
    expect(
      diffTradingReadback([entry('A', null)], new Map([['A', 4]]), new Map([['p1', 7]]), { now: NOW }),
    ).toEqual([])
  })

  it('SKU not present in the GetItem response is skipped (no phantom zero)', () => {
    expect(
      diffTradingReadback([entry('A', 'p1')], new Map(), new Map([['p1', 7]]), { now: NOW }),
    ).toEqual([])
  })
})
