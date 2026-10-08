/**
 * Step 2 "Sells from" — where a sale takes its stock (`pickSaleLocation`, `saleLocationInTx`).
 *
 * Owner rulings 2026-10-07: the first location of the market's list with enough available for the WHOLE line wins
 * (one line is never split); none has enough → the first location (the hold or take reports the shortfall as before);
 * a pooled product, a product with no routed row, or a sale whose market cannot be told → no answer (`null`), so the
 * caller keeps the location it always used. The listing's own list beats the market's list, which beats the routes.
 *
 * The transaction is a fake that answers the loader's reads (Part A's real `loadSyncLedgers`) and this service's two
 * reads (the product's listings on the channel, the switched-on warehouses).
 */
import { describe, expect, it, vi } from 'vitest'
import { pickSaleLocation, saleLocationInTx } from './sale-location.service.js'

type Loc = { id: string; type: string; code: string; syncRoutes: string[]; isActive: boolean; warehouse: { isDefault: boolean; isActive: boolean } | null }
const wh = (code: string, over: Partial<Loc> = {}): Loc => ({ id: `loc-${code}`, type: 'WAREHOUSE', code, syncRoutes: [], isActive: true, warehouse: null, ...over })
const IT_MAIN = wh('IT-MAIN', { warehouse: { isDefault: true, isActive: true } })
const MI_3PL = wh('MI-3PL')
const RM_SHOP = wh('RM-SHOP')
const FBA = wh('AMAZON-EU-FBA', { type: 'AMAZON_FBA' })

type Listing = { id: string; channel: string; marketplace: string; channelConnectionId: string | null; aliasKey: string; externalListingId: string | null; sourceLocationCodes: string[] }
const listing = (over: Partial<Listing> = {}): Listing =>
  ({ id: 'l-1', channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'acct-1', aliasKey: '', externalListingId: null, sourceLocationCodes: [], ...over })
const marketList = (channel: string, marketplace: string, codes: string[]) =>
  ({ channel, marketplace, sourceLocationCodes: codes, channelConnectionId: null, updatedAt: new Date('2026-10-07T10:00:00Z') })

function fakeTx(args: {
  stock: Array<[Loc, number]>
  listings?: Listing[]
  lists?: Array<ReturnType<typeof marketList>>
  pooled?: boolean
}) {
  const locations = [IT_MAIN, MI_3PL, RM_SHOP, FBA, ...args.stock.map(([l]) => l)]
  const tx = {
    stockLevel: { findMany: vi.fn(async () => args.stock.map(([location, available]) => ({ productId: 'p1', quantity: available, available, location }))) },
    stockPoolLink: { findMany: vi.fn(async () => (args.pooled ? [{ productId: 'p1' }] : [])) },
    $queryRaw: vi.fn(async () => (args.pooled
      ? [{ product_id: 'p1', grant_id: 'g1', owner_workspace_id: 'ws-lender', location_id: 'lender-wh', location_code: 'LENDER-WH', quantity: 50, reserved: 0, available: 50 }]
      : [])),
    syncChannelPolicy: { findMany: vi.fn(async () => (args.lists ?? []).filter((l) => l.sourceLocationCodes.length > 0)) },
    channelListing: { findMany: vi.fn(async (q: { where: { productId: string; channel: string } }) => (args.listings ?? []).filter((l) => l.channel === q.where.channel)) },
    stockLocation: {
      findMany: vi.fn(async (q: { where: { code: { in: string[] }; type: string; isActive: boolean } }) =>
        locations.filter((l) => q.where.code.in.includes(l.code) && l.type === q.where.type && l.isActive === q.where.isActive).map((l) => ({ id: l.id, code: l.code }))),
    },
  }
  return tx
}
const sale = (tx: ReturnType<typeof fakeTx>, quantity: number, route: Record<string, unknown> = {}) =>
  saleLocationInTx(tx as never, { productId: 'p1', quantity, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'acct-1', ...route })

describe('pickSaleLocation (pure)', () => {
  const rows = [{ code: 'A', available: 1 }, { code: 'B', available: 5 }, { code: 'C', available: 9 }]
  it('keeps the list order: the first row with enough wins, even when a later one has more', () => {
    expect(pickSaleLocation(rows, 1)?.code).toBe('A')
    expect(pickSaleLocation(rows, 3)?.code).toBe('B')
    expect(pickSaleLocation([...rows].reverse(), 3)?.code).toBe('C')
  })
  it('never splits a line: none has enough → the first row (the shortfall is reported there)', () => {
    expect(pickSaleLocation(rows, 10)?.code).toBe('A')
  })
  it('no row → null', () => {
    expect(pickSaleLocation([], 1)).toBeNull()
  })
})

describe('saleLocationInTx', () => {
  it('respects the market list order: the first listed location wins when it has enough, whatever the default is', async () => {
    const tx = fakeTx({ stock: [[IT_MAIN, 10], [MI_3PL, 10]], listings: [listing()], lists: [marketList('AMAZON', 'IT', ['MI-3PL', 'IT-MAIN'])] })
    expect(await sale(tx, 2)).toEqual({ locationId: 'loc-MI-3PL', code: 'MI-3PL', origin: 'market', enough: true })
  })

  it('the first location with enough stock for the whole line wins', async () => {
    const tx = fakeTx({ stock: [[IT_MAIN, 1], [MI_3PL, 3], [RM_SHOP, 8]], listings: [listing()], lists: [marketList('AMAZON', 'IT', ['IT-MAIN', 'MI-3PL', 'RM-SHOP'])] })
    expect(await sale(tx, 1)).toMatchObject({ code: 'IT-MAIN', enough: true })
    expect(await sale(tx, 3)).toMatchObject({ code: 'MI-3PL', enough: true })
    expect(await sale(tx, 5)).toMatchObject({ code: 'RM-SHOP', enough: true })
  })

  it('shortfall: no location has enough → the first location, never a split', async () => {
    const tx = fakeTx({ stock: [[IT_MAIN, 2], [MI_3PL, 3]], listings: [listing()], lists: [marketList('AMAZON', 'IT', ['MI-3PL', 'IT-MAIN'])] })
    expect(await sale(tx, 4)).toEqual({ locationId: 'loc-MI-3PL', code: 'MI-3PL', origin: 'market', enough: false })
  })

  it('a pooled product has no answer: the caller keeps its default location (the pool doors decide)', async () => {
    const tx = fakeTx({ stock: [[IT_MAIN, 10]], listings: [listing({ sourceLocationCodes: ['IT-MAIN'] })], lists: [marketList('AMAZON', 'IT', ['IT-MAIN'])], pooled: true })
    expect(await sale(tx, 1)).toBeNull()
  })

  it('no routed row has no answer: no stock row at all, or rows routed elsewhere only', async () => {
    expect(await sale(fakeTx({ stock: [], listings: [listing()] }), 1)).toBeNull()
    // Only FBA: never a warehouse row.
    expect(await sale(fakeTx({ stock: [[FBA, 30]], listings: [listing()] }), 1)).toBeNull()
    // Routes keep IT-MAIN off Amazon IT, and there is no list.
    const ebayOnly = wh('IT-MAIN', { warehouse: { isDefault: true, isActive: true }, syncRoutes: ['EBAY'] })
    expect(await sale(fakeTx({ stock: [[ebayOnly, 10]], listings: [listing()] }), 1)).toBeNull()
    // A list naming only locations the product has no stock row at.
    expect(await sale(fakeTx({ stock: [[IT_MAIN, 10]], listings: [listing()], lists: [marketList('AMAZON', 'IT', ['RM-SHOP'])] }), 1)).toBeNull()
  })

  it('a switched-off warehouse is skipped, even first in the list', async () => {
    const off = wh('OLD-WH', { isActive: false })
    const tx = fakeTx({ stock: [[off, 50], [IT_MAIN, 5]], listings: [listing()], lists: [marketList('AMAZON', 'IT', ['OLD-WH', 'IT-MAIN'])] })
    expect(await sale(tx, 2)).toMatchObject({ code: 'IT-MAIN', enough: true })
    // Even if a row reached the list, a location that is not a switched-on warehouse is never named.
    const stale = fakeTx({ stock: [[MI_3PL, 50], [IT_MAIN, 5]], listings: [listing()], lists: [marketList('AMAZON', 'IT', ['MI-3PL', 'IT-MAIN'])] })
    stale.stockLocation.findMany.mockResolvedValueOnce([{ id: 'loc-IT-MAIN', code: 'IT-MAIN' }])
    expect(await sale(stale, 2)).toMatchObject({ code: 'IT-MAIN' })
  })

  it('precedence: the listing\'s own list beats the market list, which beats the routes', async () => {
    const stock: Array<[Loc, number]> = [[IT_MAIN, 10], [MI_3PL, 10], [RM_SHOP, 10]]
    // Routes only: the default warehouse first (sale order), then by code.
    expect(await sale(fakeTx({ stock, listings: [listing()] }), 1)).toMatchObject({ code: 'IT-MAIN', origin: 'routes' })
    // The market list beats the routes.
    const lists = [marketList('AMAZON', 'IT', ['RM-SHOP', 'IT-MAIN'])]
    expect(await sale(fakeTx({ stock, listings: [listing()], lists }), 1)).toMatchObject({ code: 'RM-SHOP', origin: 'market' })
    // The listing's own list beats the market list.
    expect(await sale(fakeTx({ stock, listings: [listing({ sourceLocationCodes: ['MI-3PL'] })], lists }), 1)).toMatchObject({ code: 'MI-3PL', origin: 'product' })
    // Another market's list does not apply.
    expect(await sale(fakeTx({ stock, listings: [listing()], lists: [marketList('AMAZON', 'DE', ['RM-SHOP'])] }), 1)).toMatchObject({ code: 'IT-MAIN', origin: 'routes' })
  })

  it('a market list applies even when the product has no listing in that market (the sale names the market)', async () => {
    const tx = fakeTx({ stock: [[IT_MAIN, 10], [MI_3PL, 10]], listings: [], lists: [marketList('AMAZON', 'IT', ['MI-3PL'])] })
    expect(await sale(tx, 1)).toMatchObject({ code: 'MI-3PL', origin: 'market' })
  })

  it('finds the listing that sold: same market, never another account, the sold item id first', async () => {
    const stock: Array<[Loc, number]> = [[IT_MAIN, 10], [MI_3PL, 10], [RM_SHOP, 10]]
    // Another account's listing in the same market is not this sale's.
    const other = listing({ id: 'l-0', channelConnectionId: 'acct-2', sourceLocationCodes: ['RM-SHOP'] })
    expect(await sale(fakeTx({ stock, listings: [other, listing({ id: 'l-1', sourceLocationCodes: ['MI-3PL'] })] }), 1)).toMatchObject({ code: 'MI-3PL' })
    // eBay names no market: the line's item id picks the listing (DE), and with it the market's list.
    const ebay = [
      listing({ id: 'e-it', channel: 'EBAY', marketplace: 'IT', externalListingId: '111' }),
      listing({ id: 'e-de', channel: 'EBAY', marketplace: 'DE', externalListingId: '222' }),
    ]
    const lists = [marketList('EBAY', 'EBAY_DE', ['RM-SHOP']), marketList('EBAY', 'IT', ['MI-3PL'])]
    const ebaySale = (itemId: string | null) => saleLocationInTx(fakeTx({ stock, listings: ebay, lists }) as never,
      { productId: 'p1', quantity: 1, channel: 'EBAY', channelConnectionId: 'acct-1', externalListingId: itemId })
    expect(await ebaySale('222')).toMatchObject({ code: 'RM-SHOP', origin: 'market' })
    expect(await ebaySale('111')).toMatchObject({ code: 'MI-3PL', origin: 'market' })
    // No item id and listings in two markets: the market cannot be told, so no answer (the default location).
    expect(await ebaySale(null)).toBeNull()
    // One market only (a Shopify store): its listing decides.
    const shopify = [listing({ channel: 'SHOPIFY', marketplace: 'GLOBAL', sourceLocationCodes: ['RM-SHOP'] })]
    expect(await saleLocationInTx(fakeTx({ stock, listings: shopify }) as never, { productId: 'p1', quantity: 1, channel: 'SHOPIFY', channelConnectionId: 'acct-1' }))
      .toMatchObject({ code: 'RM-SHOP', origin: 'product' })
    // No listing and no market named: no answer.
    expect(await saleLocationInTx(fakeTx({ stock }) as never, { productId: 'p1', quantity: 1, channel: 'ETSY', channelConnectionId: 'acct-1' })).toBeNull()
  })

  it('only reads', async () => {
    const tx = fakeTx({ stock: [[IT_MAIN, 10]], listings: [listing()] })
    await sale(tx, 1)
    const writes = Object.values(tx).flatMap((delegate) => Object.keys(delegate as object)).filter((m) => /create|update|upsert|delete/i.test(m))
    expect(writes).toEqual([])
  })
})
