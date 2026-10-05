/**
 * S4 (per-channel SKU) — the eBay label services the old Flat File page drives (membership reconcile's custom label,
 * the pool relabel, the SKU-less adoption, adding variations to a live item) write the SKU each row WANTS on that item,
 * never Product.sku over a listing's own SKU; a SKU eBay takes is recorded as the SKU eBay holds. Parity: rows with no
 * own SKU get exactly the SKUs they got before. Real PostgreSQL through PGlite (production schema and policies); eBay is
 * stubbed (no network). Another account's rows are never read.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, trading: vi.fn(), getItem: '' }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../utils/logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('./listing-push-controls.js', () => ({ readPushControls: async () => [{}] }))
vi.mock('./ebay-trading-api.service.js', async (original) => ({ ...(await original<object>()), callTradingApi: state.trading }))

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { reconcileMembershipsFromEbay } from './ebay-membership-reconcile.service.js'
import { adoptSkulessVariations, relabelListingToPoolSkus } from './ebay-variation-relabel.service.js'
import { addVariationsToListing } from './ebay-variation-add.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids: Record<string, string> = {}
const LIVE = { listingStatus: 'ACTIVE', isPublished: true }
const ACK = { ack: 'Success', raw: '<ReviseFixedPriceItemResponse><Ack>Success</Ack></ReviseFixedPriceItemResponse>', errors: [] }
const variation = (sku: string, size: string, price = '20.00') =>
  `<Variation><SKU>${sku}</SKU><StartPrice currencyID="EUR">${price}</StartPrice><Quantity>3</Quantity><VariationSpecifics><NameValueList><Name>Taglia</Name><Value>${size}</Value></NameValueList></VariationSpecifics></Variation>`
const item = (itemSku: string, variations: string) => `<GetItemResponse><Ack>Success</Ack><Item><ItemID>x</ItemID><SKU>${itemSku}</SKU><Variations>${variations}<VariationSpecificsSet><NameValueList><Name>Taglia</Name><Value>S</Value><Value>M</Value></NameValueList></VariationSpecificsSet></Variations></Item></GetItemResponse>`
const revises = () => state.trading.mock.calls.filter(([call]) => call === 'ReviseFixedPriceItem').map(([, xml]) => String(xml))
const ctx = () => ({ oauthToken: 'token', connectionId: ids.acc })
const live = (id: string) => prisma.channelListing.findUnique({ where: { id }, select: { liveChannelSku: true } }).then(r => r?.liveChannelSku ?? null)

async function family(prefix: string, sizes: string[]) {
  const parent = await prisma.product.create({ data: { sku: prefix, name: prefix, basePrice: 10, isParent: true } as never })
  const out: Record<string, string> = { parent: parent.id }
  for (const size of sizes) out[size] = (await prisma.product.create({ data: { sku: `${prefix}-${size}`, name: size, basePrice: 10, parentId: parent.id } as never })).id
  return out
}
const row = (productId: string, account: string, facts: Record<string, unknown> = {}) => prisma.channelListing.create({ data: {
  productId, channel: 'EBAY', marketplace: 'IT', region: 'IT', channelMarket: 'EBAY_IT', channelConnectionId: account, aliasKey: '', ...LIVE, ...facts,
} as never }).then(r => r.id)
const member = (itemId: string, sku: string, productId: string | null, parentSku: string, size: string) => prisma.sharedListingMembership.create({ data: {
  marketplace: 'IT', itemId, sku, productId, parentSku, variationSpecifics: { Taglia: size }, status: 'ACTIVE' } as never })

beforeAll(async () => {
  vi.stubEnv('NEXUS_EBAY_REAL_API', 'true')
  await scoped(async () => {
    ids.acc = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'els-a', externalAccountId: 'els-a', isActive: true, isPrimary: true } as never })).id
    ids.acc2 = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'els-b', externalAccountId: 'els-b', isActive: true, isPrimary: false } as never })).id
  })
}, 120_000)
afterAll(async () => { vi.unstubAllEnvs(); await state.db?.close() })
beforeEach(() => { state.trading.mockReset() })

describe('membership reconcile — the item\'s custom label', () => {
  it('parity: a main row with no own SKU gets the membership parent SKU, as before', () => scoped(async () => {
    const f = await family('REC-P', ['S'])
    await row(f.parent, ids.acc, { externalListingId: '801' })
    await member('801', 'REC-P-S', f.S, 'REC-P', 'S')
    state.trading.mockImplementation(async (call: string) => call === 'GetItem' ? { ack: 'Success', raw: item('OLD', variation('REC-P-S', 'S')) } : ACK)
    expect(await reconcileMembershipsFromEbay('801', 'IT', ctx())).toMatchObject({ customLabel: 'set' })
    expect(revises()).toEqual([expect.stringContaining('<SKU>REC-P</SKU>')])
  }))

  it('🔴 a main row with its own SKU is labelled with it (never Product.sku), and that SKU is recorded as eBay\'s', () => scoped(async () => {
    const f = await family('REC-O', ['S'])
    const root = await row(f.parent, ids.acc, { externalListingId: '802', channelSku: 'REC-O-EB' })
    // Another account's row on the same item number wants another SKU: never read here.
    await row(f.parent, ids.acc2, { externalListingId: '802', channelSku: 'OTHER-ACCOUNT' })
    await member('802', 'REC-O-S', f.S, 'REC-O', 'S')
    state.trading.mockImplementation(async (call: string) => call === 'GetItem' ? { ack: 'Success', raw: item('', variation('REC-O-S', 'S')) } : ACK)
    expect(await reconcileMembershipsFromEbay('802', 'IT', ctx())).toMatchObject({ customLabel: 'set' })
    expect(revises()).toEqual([expect.stringContaining('<SKU>REC-O-EB</SKU>')])
    expect(await live(root)).toBe('REC-O-EB')
    // The memberships keep Nexus's family grouping key.
    expect(await prisma.sharedListingMembership.findFirst({ where: { itemId: '802' }, select: { parentSku: true } })).toEqual({ parentSku: 'REC-O' })
    // eBay holding it now: kept, nothing sent.
    state.trading.mockReset().mockImplementation(async (call: string) => call === 'GetItem' ? { ack: 'Success', raw: item('REC-O-EB', variation('REC-O-S', 'S')) } : ACK)
    expect(await reconcileMembershipsFromEbay('802', 'IT', ctx())).toMatchObject({ customLabel: 'kept' })
    expect(revises()).toEqual([])
  }))
})

describe('relabel to the pool SKUs', () => {
  it('each variation gets the SKU its row on this item wants: its own, else the product SKU (parity); recorded once eBay takes it', () => scoped(async () => {
    const f = await family('RLB', ['S', 'M'])
    await row(f.parent, ids.acc, { externalListingId: '803' })
    const s = await row(f.S, ids.acc, { externalListingId: '803', channelSku: 'RLB-S-EB' })
    const m = await row(f.M, ids.acc, { externalListingId: '803' })
    await row(f.M, ids.acc2, { externalListingId: '803', channelSku: 'OTHER-ACCOUNT-M' })
    await member('803', 'T1_S', f.S, 'RLB', 'S')
    await member('803', 'T1_M', f.M, 'RLB', 'M')
    state.trading.mockResolvedValue(ACK)
    expect(await relabelListingToPoolSkus('803', 'IT', ctx())).toMatchObject({ planned: 2, membershipsRewritten: 2 })
    const xml = revises()[0]
    expect(xml).toContain('<SKU>RLB-S-EB</SKU>')
    expect(xml).toContain('<SKU>RLB-M</SKU>')
    expect(xml).not.toContain('<SKU>RLB-S</SKU>')
    expect(xml).not.toContain('OTHER-ACCOUNT-M')
    expect((await prisma.sharedListingMembership.findMany({ where: { itemId: '803' }, select: { sku: true }, orderBy: { sku: 'asc' } })).map(r => r.sku)).toEqual(['RLB-M', 'RLB-S-EB'])
    expect([await live(s), await live(m)]).toEqual(['RLB-S-EB', 'RLB-M'])
  }))

  it('a dry run (no real answer from eBay) records nothing as eBay\'s', () => scoped(async () => {
    const f = await family('RLD', ['S'])
    const s = await row(f.S, ids.acc, { externalListingId: '804', channelSku: 'RLD-S-EB' })
    await member('804', 'T1_S', f.S, 'RLD', 'S')
    state.trading.mockResolvedValue({ ack: 'Success', itemId: 'DRYRUN-ReviseFixedPriceItem', raw: '', errors: [] })
    await relabelListingToPoolSkus('804', 'IT', ctx())
    expect(await live(s)).toBeNull()
  }))

  it('SKU-less adoption writes each matched variation\'s wanted SKU', () => scoped(async () => {
    const f = await family('ADP', ['S', 'M'])
    await row(f.parent, ids.acc, { externalListingId: '805' })
    await row(f.S, ids.acc, { externalListingId: '805', channelSku: 'ADP-S-EB' })
    await row(f.M, ids.acc, { externalListingId: '805' })
    // The pool: the family's variations as another listing of the market already links them (values only this family has).
    await member('806', 'ADP-S', f.S, 'ADP', 'ADP-small')
    await member('806', 'ADP-M', f.M, 'ADP', 'ADP-medium')
    state.trading.mockImplementation(async (call: string) => call === 'GetItem' ? { ack: 'Success', raw: item('ADP', variation('', 'ADP-small') + variation('', 'ADP-medium')) } : ACK)
    expect(await adoptSkulessVariations('805', 'IT', ctx())).toMatchObject({ adopted: 2, membershipsCreated: 2 })
    const xml = revises()[0]
    expect(xml).toContain('<SKU>ADP-S-EB</SKU>')
    expect(xml).toContain('<SKU>ADP-M</SKU>')
    expect((await prisma.sharedListingMembership.findMany({ where: { itemId: '805' }, select: { sku: true, productId: true }, orderBy: { sku: 'asc' } })))
      .toEqual([{ sku: 'ADP-M', productId: f.M }, { sku: 'ADP-S-EB', productId: f.S }])
  }))
})

describe('add variations to a live item', () => {
  it('a candidate named by its product SKU is sent under its row\'s wanted SKU; the membership links that SKU to the product', () => scoped(async () => {
    const f = await family('ADD', ['S', 'M', 'L'])
    await row(f.parent, ids.acc, { externalListingId: '807' })
    await row(f.S, ids.acc, { externalListingId: '807' })
    // Two variations not on eBay yet, under the same listing: one with its own wanted SKU, one without (parity).
    const m = await row(f.M, ids.acc, { listingStatus: 'DRAFT', isPublished: false, externalListingId: null, channelSku: 'ADD-M-EB' })
    await row(f.L, ids.acc, { listingStatus: 'DRAFT', isPublished: false, externalListingId: null })
    await member('807', 'ADD-S', f.S, 'ADD', 'S')
    state.trading.mockImplementation(async (call: string) => call === 'GetItem' ? { ack: 'Success', raw: item('ADD', variation('ADD-S', 'S')) } : ACK)
    const result = await addVariationsToListing('807', 'IT', [
      { sku: 'ADD-M', price: 20, quantity: 2, specifics: { Taglia: 'M' } },
      { sku: 'ADD-L', price: 20, quantity: 1, specifics: { Taglia: 'L' } },
    ], ctx())
    expect(result).toMatchObject({ added: 2, membershipsCreated: 2 })
    const xml = revises()[0]
    expect(xml).toContain('<SKU>ADD-M-EB</SKU>')
    expect(xml).toContain('<SKU>ADD-L</SKU>')
    expect(xml).not.toContain('<SKU>ADD-M</SKU>')
    expect((await prisma.sharedListingMembership.findMany({ where: { itemId: '807' }, select: { sku: true, productId: true }, orderBy: { sku: 'asc' } })))
      .toEqual([{ sku: 'ADD-L', productId: f.L }, { sku: 'ADD-M-EB', productId: f.M }, { sku: 'ADD-S', productId: f.S }])
    expect(await live(m)).toBe('ADD-M-EB')
    // Run again: eBay holds it under the wanted SKU, so it is not added twice.
    state.trading.mockReset().mockImplementation(async (call: string) => call === 'GetItem'
      ? { ack: 'Success', raw: item('ADD', variation('ADD-S', 'S') + variation('ADD-M-EB', 'M') + variation('ADD-L', 'L')) } : ACK)
    expect(await addVariationsToListing('807', 'IT', [{ sku: 'ADD-M', price: 20, quantity: 2, specifics: { Taglia: 'M' } }], ctx())).toMatchObject({ added: 0, skippedExisting: 1 })
    expect(revises()).toEqual([])
  }))
})
