import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Sheet publish parity, build shape v2, phase P2 — the waiting Action and Status values on the real schema and tenant
 * policies (PGlite). Nothing here calls a channel: setting a value only marks the row; Publish sends it later.
 */
const fixture = vi.hoisted(() => ({ database: null as any, events: [] as any[] }))

vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  fixture.database = await formulaDatabase()
  return { default: fixture.database.client, prisma: fixture.database.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: (event: unknown) => { fixture.events.push(event) } }))
// New listings: eBay's out-of-stock option is a channel read; here it answers what each test sets.
const ebayOutOfStock = vi.hoisted(() => ({ answer: 'ON' as 'ON' | 'OFF' | 'UNKNOWN', calls: 0 }))
vi.mock('../channel-delist.service.js', async original => ({ ...(await original<Record<string, unknown>>()),
  readEbayOutOfStockPreference: async () => { ebayOutOfStock.calls += 1; return ebayOutOfStock.answer } }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { ALREADY_DELETED, AMAZON_NO_END, AMAZON_FBA_DELETE_WARNING, deletedShort, deletedStatusReason, EBAY_NEW_INACTIVE_OOS_OFF, ETSY_NEW_ACTIVE_NEEDS_PHOTO, ETSY_NEW_ROW_SENTENCE, ETSY_NEW_VARIATION_ACTIVE, ETSY_PUBLISHING_OFF, ETSY_VARIATION_CANNOT_HIDE, NEW_LISTING_ALIAS,
  RELIST_SENTENCE, SHOPIFY_LINKED_REFUSED, SHOPIFY_NEW_VARIATION } from '@nexus/shared/listing-actions'
import { DELETE_EBAY_VARIATION, ETSY_FIELDS_NOT_SENT, NEW_LISTING_SENT_WHOLE, NOTHING_TO_DELETE_YET, newRowId, SHARED_NO_LISTING } from '@nexus/shared/publish-actions'
import { clearWaitingValues, parsePublishActionBody, readPublishActions, SHARED_DELETED, writePublishActions, type PublishActionActor } from './publish-action.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids: Record<string, string> = {}
const publisher = (userId = ids.anna): PublishActionActor => ({ userId, can: permission => permission === 'products.publish' })
const owner = (userId = ids.anna): PublishActionActor => ({ userId, can: () => true })

async function family(prefix: string, sizes: string[]) {
  const root = await prisma.product.create({ data: { sku: prefix, name: prefix, basePrice: 10, isParent: true, fulfillmentMethod: 'FBM' } as never })
  const children: Record<string, string> = {}
  for (const size of sizes) children[size] = (await prisma.product.create({ data: { sku: `${prefix}-${size}`, name: `${prefix} ${size}`, basePrice: 10, parentId: root.id, fulfillmentMethod: 'FBM' } as never })).id
  return { root: root.id, children }
}

async function listing(productId: string, channel: string, marketplace: string, account: string, extra: Record<string, unknown> = {}) {
  return (await prisma.channelListing.create({ data: {
    productId, channel, marketplace, region: marketplace, channelMarket: `${channel}_${marketplace}`, channelConnectionId: account, aliasKey: '',
    fulfillmentMethod: 'FBM', listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'EXT', quantity: 5, price: 10, ...extra,
  } as never })).id
}

const stored = (id: string) => prisma.channelListing.findUnique({ where: { id }, select: {
  publishAction: true, publishActionAt: true, publishActionById: true, sellingTarget: true, sellingTargetAt: true, sellingTargetById: true, publishActionBasis: true,
} })

beforeAll(async () => {
  await scoped(async () => {
    ids.amazon = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'pa-amazon', isActive: true, isPrimary: true } as never })).id
    ids.ebay = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'pa-ebay', externalAccountId: 'pa-ebay-1', isActive: true, isPrimary: true } as never })).id
    ids.shopify = (await prisma.channelConnection.create({ data: { channelType: 'SHOPIFY', accountLabel: 'pa-shopify', isActive: true, isPrimary: true } as never })).id
    ids.anna = (await prisma.userProfile.create({ data: { displayName: 'Anna', email: 'anna@publish-action.test' } })).id
    ids.bruno = (await prisma.userProfile.create({ data: { displayName: 'Bruno', email: 'bruno@publish-action.test' } })).id
    // New listings: a draft is started only on an active market of the channel.
    for (const [channel, code] of [['AMAZON', 'IT'], ['AMAZON', 'DE'], ['AMAZON', 'FR'], ['EBAY', 'IT'], ['EBAY', 'DE'], ['SHOPIFY', 'GLOBAL'], ['ETSY', 'IT']])
      await prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency: 'EUR', region: 'EU', language: 'en', isActive: true } as never })
    ids.etsy = (await prisma.channelConnection.create({ data: { channelType: 'ETSY', accountLabel: 'pa-etsy', isActive: true, isPrimary: true } as never })).id
  })
}, 120_000)
beforeEach(() => { fixture.events.length = 0 })
afterAll(async () => { await fixture.database?.close() })

describe('the read: every listing row of the family, with its state, waiting values and options', () => {
  it('reads Amazon rows as the engine does, with Partial update as the quiet default', () => scoped(async () => {
    const f = await family('PA-READ', ['S', 'M', 'L'])
    await listing(f.root, 'AMAZON', 'IT', ids.amazon)
    await listing(f.children.S, 'AMAZON', 'IT', ids.amazon)
    await listing(f.children.M, 'AMAZON', 'IT', ids.amazon, { offerClosedAt: new Date(), offerCloseReason: 'sheet-pause' })
    await listing(f.children.L, 'AMAZON', 'IT', ids.amazon, { fulfillmentMethod: 'FBA' })
    await listing(f.children.S, 'AMAZON', 'DE', ids.amazon, { listingStatus: 'DRAFT', isPublished: false, externalListingId: null })
    const cells = await readPublishActions(f.children.S)
    const cell = (sku: string, market = 'IT') => cells.find(c => c.sku === sku && c.marketplace === market)!
    expect(cells).toHaveLength(5)
    expect(cell('PA-READ-S')).toMatchObject({ state: 'active', accountId: ids.amazon, aliasKey: '',
      send: { mode: 'partial', setAt: null, setByName: null, noLongerApplies: null }, status: { target: null, setAt: null } })
    expect(cell('PA-READ-M').state).toBe('paused')
    expect(cell('PA-READ').state).toBe('mixed')
    const status = (sku: string, market = 'IT') => Object.fromEntries(cell(sku, market).statusOptions.map(o => [o.target, o.offered ? o.action ?? 'current' : o.reason]))
    // Amazon never shows Ended (it has no End).
    expect(status('PA-READ-S')).toEqual({ active: 'current', inactive: 'pause' })
    expect(status('PA-READ-M')).toEqual({ active: 'resume', inactive: 'current' })
    // FBA may pause (with the warning), and may be deleted too (Owner D2 A, 2026-10-04), with the FBA warning.
    expect(cell('PA-READ-L').statusOptions.find(o => o.target === 'inactive')).toMatchObject({ offered: true, warning: expect.stringMatching(/FBA/) })
    expect(cell('PA-READ-L').sendOptions.find(o => o.mode === 'delete')).toMatchObject({ offered: true, reason: null, warning: AMAZON_FBA_DELETE_WARNING })
    expect(cell('PA-READ-L').deleted).toBeNull()
    // A draft (never sent) is a new listing: its Action reads Full update (sent whole), and it chooses Active / Inactive /
    // Not listed (default Active).
    expect(cell('PA-READ-S', 'DE')).toMatchObject({ state: 'draft', send: { mode: 'full', setAt: null },
      create: { target: 'active', source: 'default', defaultTarget: 'active', noRecord: false, sentence: 'Publish creates it and it sells.' } })
    expect(cell('PA-READ-S', 'DE').sendOptions.find(o => o.mode === 'full')).toMatchObject({ offered: true, warning: NEW_LISTING_SENT_WHOLE })
    expect(cell('PA-READ-S', 'DE').sendOptions.find(o => o.mode === 'partial')).toMatchObject({ offered: false, reason: NEW_LISTING_SENT_WHOLE })
    expect(cell('PA-READ-S', 'DE').statusOptions.map(o => [o.target, o.offered])).toEqual([['active', true], ['inactive', true], ['not_listed', true]])
    expect(cell('PA-READ-S').create).toBeNull()
    // One destination only.
    expect((await readPublishActions(f.root, { channel: 'amazon', marketplace: 'de' })).map(c => c.sku)).toEqual(['PA-READ-S'])
  }))

  it('reads eBay and Shopify rules per destination: variation rows cannot delete, colour-split Shopify is refused', () => scoped(async () => {
    const f = await family('PA-MODEL', ['S'])
    await listing(f.root, 'EBAY', 'IT', ids.ebay, { externalListingId: '1234' })
    await listing(f.children.S, 'EBAY', 'IT', ids.ebay, { externalListingId: '1234' })
    await listing(f.root, 'SHOPIFY', 'GLOBAL', ids.shopify, { externalListingId: '9002', platformAttributes: { status: 'ACTIVE' } })
    await prisma.shopifyColourProduct.create({ data: { familyId: f.root, channelConnectionId: ids.shopify, splitAxis: 'color', valueKey: 'color:black' } as never })
    const cells = await readPublishActions(f.root)
    const ebayChild = cells.find(c => c.channel === 'EBAY' && c.sku === 'PA-MODEL-S')!
    expect(ebayChild.sendOptions.find(o => o.mode === 'delete')).toMatchObject({ offered: false, reason: DELETE_EBAY_VARIATION })
    expect(cells.find(c => c.channel === 'EBAY' && c.sku === 'PA-MODEL')!.statusOptions.find(o => o.target === 'ended')).toMatchObject({ offered: true, action: 'end' })
    const shopify = cells.find(c => c.channel === 'SHOPIFY')!
    expect(shopify.statusOptions.find(o => o.target === 'inactive')).toMatchObject({ offered: false, reason: SHOPIFY_LINKED_REFUSED })
  }))
})

describe('the write: one column on many rows', () => {
  it('sets Inactive with who and when, refuses what a row cannot do, and tells other sheets once', () => scoped(async () => {
    const f = await family('PA-SET', ['S', 'M'])
    const s = await listing(f.children.S, 'AMAZON', 'IT', ids.amazon)
    const m = await listing(f.children.M, 'AMAZON', 'IT', ids.amazon, { listingStatus: 'DRAFT', isPublished: false, externalListingId: null })
    // Ended is not a choice for a listing not on the channel yet (New listings: Active, Inactive, Not listed); Not listed
    // is not one for a listing on the channel.
    expect((await writePublishActions(f.root, { listingIds: [m], change: { column: 'status', target: 'ended' } }, owner())).refused)
      .toEqual([{ listingId: m, sku: 'PA-SET-M', reason: expect.stringMatching(/not on the channel yet/) }])
    expect((await writePublishActions(f.root, { listingIds: [s], change: { column: 'status', target: 'not_listed' } }, owner())).refused)
      .toEqual([{ listingId: s, sku: 'PA-SET-S', reason: expect.stringMatching(/only before the first Publish/) }])
    fixture.events.length = 0
    expect(await writePublishActions(f.root, { listingIds: [s], change: { column: 'status', target: 'inactive' } }, publisher())).toMatchObject({ applied: [s], refused: [], conflicts: [] })
    const row = await stored(s)
    expect(row).toMatchObject({ sellingTarget: 'INACTIVE', sellingTargetById: ids.anna, publishAction: null,
      publishActionBasis: { status: { state: 'active', externalListingId: 'EXT', setAt: row!.sellingTargetAt!.toISOString() } } })
    expect(fixture.events).toEqual([expect.objectContaining({ type: 'listing.publish_action_changed', productId: f.root, listingIds: [s], column: 'status', value: 'inactive' })])
    const cell = (await readPublishActions(f.root)).find(c => c.listingId === s)!
    expect(cell.status).toMatchObject({ target: 'inactive', setById: ids.anna, setByName: 'Anna', setAt: row!.sellingTargetAt!.toISOString(), noLongerApplies: null })
    expect(await prisma.auditLog.findFirst({ where: { entityId: f.root, action: 'listing.publish_action.status' } })).toBeTruthy()
  }))

  it('setting a row back to the state it is in clears its waiting value; clearing twice changes nothing', () => scoped(async () => {
    const f = await family('PA-BACK', ['S'])
    const s = await listing(f.children.S, 'AMAZON', 'IT', ids.amazon)
    await writePublishActions(f.root, { listingIds: [s], change: { column: 'status', target: 'inactive' } }, publisher())
    expect(await writePublishActions(f.root, { listingIds: [s], change: { column: 'status', target: 'active' } }, publisher())).toMatchObject({ applied: [s] })
    expect(await stored(s)).toMatchObject({ sellingTarget: null, sellingTargetAt: null, sellingTargetById: null, publishActionBasis: null })
    fixture.events.length = 0
    expect(await writePublishActions(f.root, { listingIds: [s], change: { column: 'status', target: null } }, publisher())).toMatchObject({ applied: [s] })
    expect(fixture.events).toEqual([])
  }))

  it('keeps the other column and its basis when one column changes', () => scoped(async () => {
    const f = await family('PA-BOTH', ['S'])
    const s = await listing(f.children.S, 'AMAZON', 'IT', ids.amazon)
    await writePublishActions(f.root, { listingIds: [s], change: { column: 'send', mode: 'full' } }, publisher())
    await writePublishActions(f.root, { listingIds: [s], change: { column: 'status', target: 'inactive' } }, publisher(ids.bruno))
    const row = await stored(s)
    expect(row).toMatchObject({ publishAction: 'FULL_UPDATE', publishActionById: ids.anna, sellingTarget: 'INACTIVE', sellingTargetById: ids.bruno })
    expect(Object.keys(row!.publishActionBasis as object).sort()).toEqual(['send', 'status'])
    await writePublishActions(f.root, { listingIds: [s], change: { column: 'send', mode: 'partial' } }, publisher())
    expect(await stored(s)).toMatchObject({ publishAction: null, sellingTarget: 'INACTIVE', publishActionBasis: { status: expect.any(Object) } })
  }))

  it('compare-and-set: a value someone else set since the client read it stays, and the conflict names them', () => scoped(async () => {
    const f = await family('PA-CAS', ['S', 'M'])
    const s = await listing(f.children.S, 'AMAZON', 'IT', ids.amazon)
    const m = await listing(f.children.M, 'AMAZON', 'IT', ids.amazon)
    await writePublishActions(f.root, { listingIds: [s], change: { column: 'send', mode: 'full' } }, publisher(ids.bruno))
    const brunoAt = (await stored(s))!.publishActionAt!.toISOString()
    // The client saw no value on either row; Bruno set one on S meanwhile.
    const result = await writePublishActions(f.root, { listingIds: [s, m], expected: { [s]: null, [m]: null }, change: { column: 'send', mode: 'partial' } }, publisher())
    expect(result.applied).toEqual([m])
    expect(result.conflicts).toEqual([{ listingId: s, sku: 'PA-CAS-S', setByName: 'Bruno', setAt: brunoAt }])
    expect(await stored(s)).toMatchObject({ publishAction: 'FULL_UPDATE', publishActionById: ids.bruno })
    // With the value the client saw, the write goes through.
    expect((await writePublishActions(f.root, { listingIds: [s], expected: { [s]: brunoAt }, change: { column: 'send', mode: 'partial' } }, publisher())).applied).toEqual([s])
    expect(await stored(s)).toMatchObject({ publishAction: null, publishActionAt: null })
  }))

  it('Ended and Delete need products.delete; the rows of another family are refused', () => scoped(async () => {
    const f = await family('PA-PERM', ['S'])
    const other = await family('PA-OTHER', ['S'])
    const root = await listing(f.root, 'EBAY', 'IT', ids.ebay, { externalListingId: '5678' })
    await listing(f.children.S, 'EBAY', 'IT', ids.ebay, { externalListingId: '5678' })
    const foreign = await listing(other.children.S, 'EBAY', 'IT', ids.ebay)
    await expect(writePublishActions(f.root, { listingIds: [root], change: { column: 'status', target: 'ended' } }, publisher())).rejects.toMatchObject({ statusCode: 403 })
    await expect(writePublishActions(f.root, { listingIds: [root], change: { column: 'send', mode: 'delete' } }, publisher())).rejects.toMatchObject({ statusCode: 403 })
    expect(await stored(root)).toMatchObject({ sellingTarget: null, publishAction: null })
    expect((await writePublishActions(f.root, { listingIds: [root], change: { column: 'status', target: 'ended' } }, owner())).applied).toEqual([root])
    expect(await stored(root)).toMatchObject({ sellingTarget: 'ENDED' })
    await expect(writePublishActions(f.root, { listingIds: [foreign], change: { column: 'send', mode: 'full' } }, owner())).rejects.toMatchObject({ statusCode: 400 })
    await expect(writePublishActions(f.root, { change: { column: 'send', mode: 'full' } }, owner())).rejects.toMatchObject({ statusCode: 400 })
    await expect(writePublishActions(f.root, { listingIds: [root], change: { column: 'status', target: 'paused' as never } }, owner())).rejects.toMatchObject({ statusCode: 400 })
  }))

  it('Shared scope: allCoordinates writes every market of that product where allowed and names the rest', () => scoped(async () => {
    const f = await family('PA-FAN', ['S', 'M'])
    const amazon = await listing(f.children.S, 'AMAZON', 'IT', ids.amazon)
    const ebay = await listing(f.children.S, 'EBAY', 'IT', ids.ebay, { externalListingId: '777' })
    const draft = await listing(f.children.S, 'AMAZON', 'DE', ids.amazon, { listingStatus: 'DRAFT', isPublished: false, externalListingId: null })
    const sibling = await listing(f.children.M, 'AMAZON', 'IT', ids.amazon)
    const result = await writePublishActions(f.children.S, { allCoordinates: true, change: { column: 'status', target: 'ended' } }, owner())
    // Amazon has no End (it never shows Ended); a draft (a new listing) cannot be Ended; eBay can.
    expect(result.applied.sort()).toEqual([ebay].sort())
    expect(result.refused.map(r => r.listingId).sort()).toEqual([amazon, draft].sort())
    expect(result.refused.find(r => r.listingId === amazon)!.reason).toBe(AMAZON_NO_END)
    expect(await stored(sibling)).toMatchObject({ sellingTarget: null })
    expect(fixture.events).toHaveLength(1)
    // New listings: the Shared scope may choose for a draft that exists (here Inactive), and never starts a listing.
    expect((await writePublishActions(f.children.S, { allCoordinates: true, change: { column: 'status', target: 'inactive' } }, publisher())).applied.sort())
      .toEqual([amazon, ebay, draft].sort())
    expect(await stored(draft)).toMatchObject({ sellingTarget: 'INACTIVE' })
  }))
})

describe('No longer applies, and the runners\' clear', () => {
  it('a waiting value the listing has outgrown says why', () => scoped(async () => {
    const f = await family('PA-OUT', ['S', 'M'])
    const s = await listing(f.children.S, 'AMAZON', 'IT', ids.amazon)
    const m = await listing(f.children.M, 'AMAZON', 'IT', ids.amazon, { externalListingId: 'OLD' })
    await writePublishActions(f.root, { listingIds: [s], change: { column: 'status', target: 'inactive' } }, publisher())
    await writePublishActions(f.root, { listingIds: [m], change: { column: 'send', mode: 'delete' } }, owner())
    await prisma.channelListing.update({ where: { id: s }, data: { offerClosedAt: new Date(), offerCloseReason: 'sheet-pause' } })
    await prisma.channelListing.update({ where: { id: m }, data: { externalListingId: 'NEW' } })
    const cells = await readPublishActions(f.root)
    expect(cells.find(c => c.listingId === s)!.status.noLongerApplies).toBe('Already inactive.')
    expect(cells.find(c => c.listingId === m)!.send.noLongerApplies).toMatch(/OLD.*NEW/)
  }))

  it('clears only the values unchanged since the review', () => scoped(async () => {
    const f = await family('PA-CLEAR', ['S', 'M', 'L'])
    const s = await listing(f.children.S, 'AMAZON', 'IT', ids.amazon)
    const m = await listing(f.children.M, 'AMAZON', 'IT', ids.amazon)
    const l = await listing(f.children.L, 'AMAZON', 'IT', ids.amazon)
    await writePublishActions(f.root, { listingIds: [s, m, l], change: { column: 'status', target: 'inactive' } }, publisher())
    await writePublishActions(f.root, { listingIds: [s, m], change: { column: 'send', mode: 'full' } }, publisher())
    const review = Object.fromEntries(await Promise.all([s, m, l].map(async id => [id, (await stored(id))!.sellingTargetAt!.toISOString()])))
    // After the review, Bruno sets M again.
    await new Promise(resolve => setTimeout(resolve, 5))
    await writePublishActions(f.root, { listingIds: [m], change: { column: 'status', target: 'inactive' } }, publisher(ids.bruno))
    fixture.events.length = 0
    const result = await clearWaitingValues([s, m, l], 'status', { ...review, [l]: null })
    expect(result).toEqual({ cleared: [s], kept: [m, l] })
    expect(await stored(s)).toMatchObject({ sellingTarget: null, publishAction: 'FULL_UPDATE', publishActionBasis: { send: expect.any(Object) } })
    expect(await stored(m)).toMatchObject({ sellingTarget: 'INACTIVE', sellingTargetById: ids.bruno })
    expect(await stored(l)).toMatchObject({ sellingTarget: 'INACTIVE' })
    expect(fixture.events).toEqual([expect.objectContaining({ productId: f.root, listingIds: [s], column: 'status', value: null })])
  }))
})

/* Wave 2 D13 (decision 12) — while Etsy publishing is off, Publish cannot send an Etsy Status change: it is held. */
describe('Etsy: Status changes are held while Etsy publishing is off', () => {
  it('holds Inactive with the reason, says Partial update sends no field, and a value set while it was on no longer applies', () => scoped(async () => {
    const before = process.env.NEXUS_ENABLE_ETSY_PUBLISH
    try {
      delete process.env.NEXUS_ENABLE_ETSY_PUBLISH
      const f = await family('PA-ETSY', ['S'])
      const s = await listing(f.children.S, 'ETSY', 'IT', ids.etsy)
      const read = async () => (await readPublishActions(f.root)).find(c => c.listingId === s)!
      const off = await read()
      expect(off.state).toBe('active')
      expect(off.statusOptions.map(o => [o.target, o.offered, o.reason])).toEqual([['active', true, null], ['inactive', false, ETSY_PUBLISHING_OFF]])
      expect(off.sendOptions.find(o => o.mode === 'partial')).toMatchObject({ offered: true, warning: ETSY_FIELDS_NOT_SENT })
      expect((await writePublishActions(f.root, { listingIds: [s], change: { column: 'status', target: 'inactive' } }, publisher())).refused)
        .toEqual([{ listingId: s, sku: 'PA-ETSY-S', reason: ETSY_PUBLISHING_OFF }])
      // With Etsy publishing on, Inactive is a choice again; once it is off, the stored value says why Publish skips it.
      process.env.NEXUS_ENABLE_ETSY_PUBLISH = 'true'
      expect((await read()).statusOptions.find(o => o.target === 'inactive')).toMatchObject({ offered: true, reason: null, action: 'pause' })
      expect(await writePublishActions(f.root, { listingIds: [s], change: { column: 'status', target: 'inactive' } }, publisher())).toMatchObject({ applied: [s], refused: [] })
      delete process.env.NEXUS_ENABLE_ETSY_PUBLISH
      expect((await read()).status).toMatchObject({ target: 'inactive', noLongerApplies: ETSY_PUBLISHING_OFF })
    } finally {
      if (before === undefined) delete process.env.NEXUS_ENABLE_ETSY_PUBLISH
      else process.env.NEXUS_ENABLE_ETSY_PUBLISH = before
    }
  }))
})

describe('the request body', () => {
  it('parses listing ids, the expected map and the fan-out flag at one boundary', () => {
    expect(parsePublishActionBody({ listingIds: ['a', 'a', 'b'], expected: { a: null, b: '2026-10-04T10:00:00.000Z' }, allCoordinates: false }))
      .toEqual({ listingIds: ['a', 'b'], expected: { a: null, b: '2026-10-04T10:00:00.000Z' }, allCoordinates: false })
    expect(() => parsePublishActionBody({ listingIds: 'a' })).toThrow(/listingIds/)
    expect(() => parsePublishActionBody({ listingIds: ['a'], expected: { a: 'yesterday' } })).toThrow(/expected/)
    expect(() => parsePublishActionBody({ allCoordinates: 'yes' })).toThrow(/allCoordinates/)
  })
})

describe('the routes: each value is its own path, so the permission manifest decides', () => {
  it('registers literal paths that resolve to products.view, products.publish or products.delete', async () => {
    const { default: Fastify } = await import('fastify')
    const { permissionForRoute } = await import('../../lib/auth/permissions-manifest.js')
    const { default: routes } = await import('../../routes/publish-actions.routes.js')
    const app = Fastify()
    const registered: Array<[string, string]> = []
    app.addHook('onRoute', route => { for (const method of [route.method].flat()) if (method !== 'HEAD') registered.push([method, route.url]) })
    await app.register(routes, { prefix: '/api' })
    await app.ready()
    const base = '/api/products/:id/studio/publish-actions'
    expect(Object.fromEntries(registered.map(([method, url]) => [`${method} ${url}`, permissionForRoute(method, url)]))).toEqual({
      [`GET ${base}`]: 'products.view',
      [`PUT ${base}/send/partial`]: 'products.publish',
      [`PUT ${base}/send/full`]: 'products.publish',
      [`PUT ${base}/send/delete`]: 'products.delete',
      [`PUT ${base}/status/active`]: 'products.publish',
      [`PUT ${base}/status/inactive`]: 'products.publish',
      [`PUT ${base}/status/not_listed`]: 'products.publish',
      [`PUT ${base}/status/ended`]: 'products.delete',
      [`PUT ${base}/status/none`]: 'products.publish',
    })
    await app.close()
  })
})

/** New listings (Owner 2026-10-04) — rows not on the channel: Create, Active / Inactive / Not listed, and starting drafts. */
describe('New listings: control before the first publish', () => {
  const at = (channel: string, marketplace: string, accountId: string, aliasKey = '') => ({ channel, marketplace, accountId, aliasKey })
  const rowsOf = (productId: string, channel: string, marketplace: string, accountId?: string) =>
    prisma.channelListing.findMany({ where: { productId, channel, marketplace, ...(accountId ? { channelConnectionId: accountId } : {}) },
      select: { id: true, channelConnectionId: true, listingStatus: true, isPublished: true, syncPaused: true, externalListingId: true, sellingTarget: true, aliasKey: true } })

  it('reads every family member with no listing on a named destination, with today\'s defaults (ND2 A)', () => scoped(async () => {
    const f = await family('NL-READ', ['S', 'M'])
    const amazon = await readPublishActions(f.children.S, at('AMAZON', 'FR', ids.amazon), { newRows: true })
    expect(amazon.map(c => c.sku).sort()).toEqual(['NL-READ', 'NL-READ-M', 'NL-READ-S'])
    const main = amazon.find(c => c.sku === 'NL-READ')!
    expect(main).toMatchObject({ listingId: newRowId({ productId: f.root, ...at('AMAZON', 'FR', ids.amazon) }), state: 'not_listed', send: { mode: 'full', setAt: null },
      status: { target: null }, create: { target: 'active', source: 'default', defaultTarget: 'active', noRecord: true } })
    // Amazon leaves out a variation with no listing today: it reads Not listed until someone chooses for it.
    expect(amazon.find(c => c.sku === 'NL-READ-S')!.create).toMatchObject({ target: 'not_listed', source: 'default', defaultTarget: 'not_listed', noRecord: true })
    expect(amazon.find(c => c.sku === 'NL-READ-S')!.sendOptions.map(o => [o.mode, o.offered ? 'ok' : o.reason]))
      .toEqual([['partial', NEW_LISTING_SENT_WHOLE], ['full', 'ok'], ['delete', NOTHING_TO_DELETE_YET]])
    // eBay creates a family never started here whole (audit P4): its variations read Active.
    const ebay = await readPublishActions(f.root, at('EBAY', 'IT', ids.ebay), { newRows: true })
    expect(ebay.map(c => [c.sku, c.create?.target]).sort()).toEqual([['NL-READ', 'active'], ['NL-READ-M', 'active'], ['NL-READ-S', 'active']])
    // Shopify: a Draft product by default; a variation follows the main row. Etsy: an Etsy draft by default (Inactive);
    // Active waits for photos (E1, Owner D1 = A).
    const shopify = await readPublishActions(f.root, at('SHOPIFY', 'GLOBAL', ids.shopify), { newRows: true })
    expect(shopify.find(c => c.sku === 'NL-READ')!.create!.target).toBe('inactive')
    expect(shopify.find(c => c.sku === 'NL-READ-S')!.statusOptions.every(o => !o.offered && o.reason === SHOPIFY_NEW_VARIATION)).toBe(true)
    const etsy = await readPublishActions(f.root, at('ETSY', 'IT', ids.etsy), { newRows: true })
    expect(etsy.find(c => c.sku === 'NL-READ')!.create).toMatchObject({ target: 'inactive', source: 'default', defaultTarget: 'inactive', noRecord: true })
    expect(etsy.find(c => c.sku === 'NL-READ')!.statusOptions.map(o => [o.target, o.offered ? 'ok' : o.reason]))
      .toEqual([['active', ETSY_NEW_ACTIVE_NEEDS_PHOTO], ['inactive', 'ok'], ['not_listed', 'ok']])
    expect(etsy.find(c => c.sku === 'NL-READ')!.create!.sentence).toBe(ETSY_NEW_ROW_SENTENCE)
    // Only a read that asks for them, on one destination named exactly.
    expect(await readPublishActions(f.root, at('AMAZON', 'FR', ids.amazon))).toEqual([])
    expect(await readPublishActions(f.root, { channel: 'AMAZON' }, { newRows: true })).toEqual([])
  }))

  it('Etsy: a new variation of a listing already on Etsy joins it for sale by default; Inactive is refused (one variation cannot be hidden); no photo refusal', () => scoped(async () => {
    const f = await family('NL-ETSY', ['S', 'M', 'L'])
    await listing(f.root, 'ETSY', 'IT', ids.etsy, { externalListingId: '9000000001' })
    await listing(f.children.S, 'ETSY', 'IT', ids.etsy, { externalListingId: '9000000001' })
    await listing(f.children.M, 'ETSY', 'IT', ids.etsy, { externalListingId: null, listingStatus: 'DRAFT', isPublished: false })
    const cells = await readPublishActions(f.root, at('ETSY', 'IT', ids.etsy), { newRows: true })
    const m = cells.find(c => c.sku === 'NL-ETSY-M')!
    expect(m.create).toMatchObject({ target: 'active', source: 'default', defaultTarget: 'active', sentence: ETSY_NEW_ROW_SENTENCE })
    // A variation with no row here is left out until someone chooses for it, as on every channel.
    expect(cells.find(c => c.sku === 'NL-ETSY-L')!.create).toMatchObject({ target: 'not_listed', source: 'default', noRecord: true })
    expect(m.statusOptions.map(o => [o.target, o.offered ? 'ok' : o.reason])).toEqual([['active', 'ok'], ['inactive', ETSY_VARIATION_CANNOT_HIDE], ['not_listed', 'ok']])
    expect(m.statusOptions.find(o => o.target === 'active')).toMatchObject({ sentence: ETSY_NEW_VARIATION_ACTIVE })
  }))

  it('a Status choice on a row with no listing starts the whole family on the sheet\'s own account, with the choice stored', () => scoped(async () => {
    const f = await family('NL-START', ['S', 'M'])
    const second = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'pa-amazon-2', externalAccountId: 'pa-amazon-2', isActive: true, isPrimary: false } as never })).id
    const id = newRowId({ productId: f.children.M, ...at('AMAZON', 'FR', second) })
    const result = await writePublishActions(f.root, { listingIds: [id], expected: { [id]: null }, change: { column: 'status', target: 'inactive' } }, publisher())
    expect(result.refused).toEqual([])
    expect(result.applied).toEqual([id])
    expect(result.started).toMatchObject({ sentence: 'Started Amazon · FR for NL-START and 2 variations.' })
    expect(result.started!.listingIds).toHaveLength(3)
    // On the sheet's own account (not the primary one), as inert drafts; only the chosen row holds the choice.
    const m = (await rowsOf(f.children.M, 'AMAZON', 'FR'))
    expect(m).toEqual([expect.objectContaining({ channelConnectionId: second, listingStatus: 'DRAFT', isPublished: false, syncPaused: true, sellingTarget: 'INACTIVE' })])
    expect(result.started!.rows).toEqual([{ id, listingId: m[0].id }])
    expect(await rowsOf(f.children.S, 'AMAZON', 'FR')).toEqual([expect.objectContaining({ channelConnectionId: second, sellingTarget: null })])
    expect(await rowsOf(f.root, 'AMAZON', 'FR', ids.amazon)).toEqual([])
    expect(fixture.events).toEqual([expect.objectContaining({ type: 'listing.publish_action_changed', listingIds: [m[0].id], column: 'status', value: 'inactive' })])
    // The family is now a draft here: S reads Active (the default), M its own Inactive.
    const cells = await readPublishActions(f.root, at('AMAZON', 'FR', second), { newRows: true })
    expect(cells.map(c => [c.sku, c.state, c.create?.target, c.create?.source, c.create?.noRecord]).sort())
      .toEqual([['NL-START', 'draft', 'active', 'default', false], ['NL-START-M', 'draft', 'inactive', 'own', false], ['NL-START-S', 'draft', 'active', 'default', false]])
    expect(cells.find(c => c.sku === 'NL-START-M')!.status).toMatchObject({ target: 'inactive', setByName: 'Anna', noLongerApplies: null })
    // A connection that is not active is refused by name; nothing is started.
    const off = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'pa-amazon-off', externalAccountId: 'pa-amazon-off', isActive: false, isPrimary: false } as never })).id
    const refused = await writePublishActions(f.root, { listingIds: [newRowId({ productId: f.root, ...at('AMAZON', 'FR', off) })], change: { column: 'status', target: 'active' } }, publisher())
    expect(refused.refused).toEqual([expect.objectContaining({ sku: 'NL-START', reason: expect.stringMatching(/not connected/) })])
    expect(await rowsOf(f.root, 'AMAZON', 'FR', off)).toEqual([])
  }))

  it('a main row\'s choice is its variations\' until they choose; Not listed is stored; Full update stores nothing, Partial and Delete are refused', () => scoped(async () => {
    const f = await family('NL-MAIN', ['S', 'M'])
    const draft = (productId: string) => listing(productId, 'AMAZON', 'IT', ids.amazon, { listingStatus: 'DRAFT', isPublished: false, externalListingId: null })
    const root = await draft(f.root), s = await draft(f.children.S), m = await draft(f.children.M)
    await writePublishActions(f.root, { listingIds: [root], change: { column: 'status', target: 'inactive' } }, publisher())
    await writePublishActions(f.root, { listingIds: [m], change: { column: 'status', target: 'not_listed' } }, publisher())
    expect(await stored(m)).toMatchObject({ sellingTarget: 'NOT_LISTED', sellingTargetById: ids.anna })
    const cells = await readPublishActions(f.root, at('AMAZON', 'IT', ids.amazon), { newRows: true })
    expect(cells.map(c => [c.sku, c.create?.target, c.create?.source]).sort())
      .toEqual([['NL-MAIN', 'inactive', 'own'], ['NL-MAIN-M', 'not_listed', 'own'], ['NL-MAIN-S', 'inactive', 'main']])
    expect((await writePublishActions(f.root, { listingIds: [s], change: { column: 'send', mode: 'partial' } }, owner())).refused[0].reason).toBe(NEW_LISTING_SENT_WHOLE)
    // Full update is what a new row reads already: choosing it stores nothing.
    expect(await writePublishActions(f.root, { listingIds: [s], change: { column: 'send', mode: 'full' } }, owner())).toMatchObject({ applied: [s], refused: [] })
    expect(await stored(s)).toMatchObject({ publishAction: null, publishActionAt: null })
    expect((await writePublishActions(f.root, { listingIds: [s], change: { column: 'send', mode: 'delete' } }, owner())).refused[0].reason).toBe(NOTHING_TO_DELETE_YET)
    // Clearing the choice brings the default back.
    await writePublishActions(f.root, { listingIds: [m], change: { column: 'status', target: null } }, publisher())
    expect(await stored(m)).toMatchObject({ sellingTarget: null })
  }))

  it('an alias destination never creates a listing; the Shared scope never starts one and says how many markets it left out', () => scoped(async () => {
    const f = await family('NL-ALIAS', ['S', 'M'])
    const alias = (await prisma.productListingAlias.create({ data: { productId: f.root, channel: 'AMAZON', marketplace: 'DE', channelConnectionId: ids.amazon, label: 'Second', position: 1 } as never })).id
    const aliasCells = await readPublishActions(f.root, at('AMAZON', 'DE', ids.amazon, alias), { newRows: true })
    expect(aliasCells.map(c => [c.aliasLabel, c.aliasPosition])).toEqual([['Second', 1], ['Second', 1], ['Second', 1]])
    expect(aliasCells.every(c => c.statusOptions.every(o => !o.offered && o.reason === NEW_LISTING_ALIAS))).toBe(true)
    const aliasWrite = await writePublishActions(f.root, { listingIds: [aliasCells[0].listingId], change: { column: 'status', target: 'active' } }, publisher())
    expect(aliasWrite.refused).toEqual([expect.objectContaining({ reason: NEW_LISTING_ALIAS })])
    expect(await rowsOf(f.root, 'AMAZON', 'DE')).toEqual([])
    // S sells on Amazon IT; M also on eBay IT — the Shared scope of S leaves eBay IT out (one market without a listing).
    const s = await listing(f.children.S, 'AMAZON', 'IT', ids.amazon)
    await listing(f.children.M, 'AMAZON', 'IT', ids.amazon)
    await listing(f.children.M, 'EBAY', 'IT', ids.ebay, { externalListingId: '991' })
    const shared = await writePublishActions(f.children.S, { allCoordinates: true, change: { column: 'status', target: 'inactive' } }, publisher())
    expect(shared).toMatchObject({ applied: [s], started: null, leftOut: { count: 1, sentence: '1 market without a listing was left out: set it in its own sheet.' } })
    expect(await rowsOf(f.children.S, 'EBAY', 'IT')).toEqual([])
    expect(SHARED_NO_LISTING).toMatch(/own sheet/)
  }))

  it('eBay Inactive needs the account\'s out-of-stock option: off refuses it and starts nothing', () => scoped(async () => {
    const f = await family('NL-EBAY', ['S'])
    const id = newRowId({ productId: f.root, ...at('EBAY', 'DE', ids.ebay) })
    ebayOutOfStock.answer = 'OFF'
    const refused = await writePublishActions(f.root, { listingIds: [id], change: { column: 'status', target: 'inactive' } }, publisher())
    expect(refused.refused).toEqual([{ listingId: id, sku: 'NL-EBAY', reason: EBAY_NEW_INACTIVE_OOS_OFF }])
    expect(await rowsOf(f.root, 'EBAY', 'DE')).toEqual([])
    ebayOutOfStock.answer = 'ON'
    const done = await writePublishActions(f.root, { listingIds: [id], change: { column: 'status', target: 'inactive' } }, publisher())
    expect(done.applied).toEqual([id])
    expect(await rowsOf(f.root, 'EBAY', 'DE')).toEqual([expect.objectContaining({ sellingTarget: 'INACTIVE', channelConnectionId: ids.ebay })])
    // Active needs no read of the option.
    const calls = ebayOutOfStock.calls
    await writePublishActions(f.root, { listingIds: [id], change: { column: 'status', target: 'active' } }, publisher())
    expect(ebayOutOfStock.calls).toBe(calls)
  }))
})

/** Aliases in the Publish window (Owner 2026-10-05): an alias row is read with its name, place and state. An archived
 *  alias's rows are read too (review 2026-10-05): its live item stays endable and deletable from its Status cell. */
describe('aliases: name, place and state; an archived alias stays endable', () => {
  it('each alias row carries its name, place and state (null on the main listing); an archived alias is read and written, never started', () => scoped(async () => {
    const f = await family('PA-ALIAS', ['S'])
    const alias = async (label: string, position: number, status = 'ACTIVE') => (await prisma.productListingAlias.create({ data: {
      productId: f.root, channel: 'EBAY', marketplace: 'IT', channelConnectionId: ids.ebay, label, position, status } as never })).id
    const alt1 = await alias('ALT1', 1)
    const old = await alias('OLD', 2, 'ARCHIVED')
    await listing(f.root, 'EBAY', 'IT', ids.ebay, { externalListingId: '901' })
    await listing(f.children.S, 'EBAY', 'IT', ids.ebay, { externalListingId: '901' })
    await listing(f.root, 'EBAY', 'IT', ids.ebay, { aliasKey: alt1, aliasId: alt1, externalListingId: '902' })
    const altS = await listing(f.children.S, 'EBAY', 'IT', ids.ebay, { aliasKey: alt1, aliasId: alt1, externalListingId: '902' })
    const oldRoot = await listing(f.root, 'EBAY', 'IT', ids.ebay, { aliasKey: old, aliasId: old, externalListingId: '903' })
    const oldS = await listing(f.children.S, 'EBAY', 'IT', ids.ebay, { aliasKey: old, aliasId: old, externalListingId: '903' })
    const cells = await readPublishActions(f.root)
    expect(cells).toHaveLength(6)
    const marks = (key: string) => cells.filter(c => c.aliasKey === key).map(c => [c.sku, c.aliasLabel, c.aliasPosition, c.aliasStatus]).sort()
    expect(marks('')).toEqual([['PA-ALIAS', null, null, null], ['PA-ALIAS-S', null, null, null]])
    expect(marks(alt1)).toEqual([['PA-ALIAS', 'ALT1', 1, 'ACTIVE'], ['PA-ALIAS-S', 'ALT1', 1, 'ACTIVE']])
    expect(marks(old)).toEqual([['PA-ALIAS', 'OLD', 2, 'ARCHIVED'], ['PA-ALIAS-S', 'OLD', 2, 'ARCHIVED']])
    // One destination, by its alias: the same name and place.
    expect((await readPublishActions(f.root, { channel: 'EBAY', marketplace: 'IT', accountId: ids.ebay, aliasKey: alt1 })).map(c => c.aliasLabel)).toEqual(['ALT1', 'ALT1'])
    // The archived alias, named exactly: its own rows only — never a stand-in for a member it lacks.
    await prisma.channelListing.delete({ where: { id: oldRoot } })
    expect((await readPublishActions(f.root, { channel: 'EBAY', marketplace: 'IT', accountId: ids.ebay, aliasKey: old }, { newRows: true })).map(c => c.listingId)).toEqual([oldS])
    // Its live item can still be ended from its Status cell, as the active alias's can.
    expect((await writePublishActions(f.root, { listingIds: [oldS], change: { column: 'status', target: 'inactive' } }, publisher())).applied).toEqual([oldS])
    expect(await stored(oldS)).toMatchObject({ sellingTarget: expect.any(String) })
    expect((await writePublishActions(f.root, { listingIds: [altS], change: { column: 'status', target: 'inactive' } }, publisher())).applied).toEqual([altS])
  }))
})

/** Simplify (Owner 2026-10-04) — a row Nexus deleted is a row not on the channel: Status Not listed, Active lists it again. */
describe('delete and relist: Status is the one control', () => {
  const gone = { externalListingId: null, listingStatus: 'DRAFT', isPublished: false }
  async function deleted(productId: string, at: Date, extra: Record<string, unknown> = {}) {
    const id = await listing(productId, 'AMAZON', 'IT', ids.amazon, { ...gone, ...extra })
    await prisma.channelListingSnapshot.create({ data: { channelListingId: id, channel: 'AMAZON', marketplace: 'IT', aliasKey: '', reason: 'delete',
      publishEventId: `gone-${id}`, outcome: 'ACCEPTED', acceptedAt: at, payload: { kind: 'listing-action', evidence: { oldExternalListingId: 'B0OLD00001' } } } as never })
    return id
  }

  it('a deleted row reads Not listed with the delete\'s words, defaults to Not listed, offers the new-row Status choices and reads Full update', () => scoped(async () => {
    const f = await family('DR-READ', ['S'])
    const at = new Date(Date.now() - 60_000)
    await deleted(f.root, at)
    await deleted(f.children.S, at)
    const cell = (await readPublishActions(f.children.S, { channel: 'AMAZON', marketplace: 'IT' })).find(c => c.sku === 'DR-READ-S')!
    const where = { where: 'Amazon · IT', at: at.toISOString() }
    expect(cell).toMatchObject({ state: 'not_listed', stateReason: deletedStatusReason(where),
      deleted: { where: 'Amazon · IT', oldReference: 'B0OLD00001', sentence: deletedShort(where) },
      create: { target: 'not_listed', source: 'default', defaultTarget: 'not_listed', sentence: deletedStatusReason(where) },
      send: { mode: 'full', setAt: null }, status: { target: null } })
    expect(cell.statusOptions.map(o => [o.target, o.offered, o.sentence])).toEqual([
      ['active', true, RELIST_SENTENCE.active], ['inactive', true, RELIST_SENTENCE.inactive], ['not_listed', true, RELIST_SENTENCE.not_listed]])
    expect(cell.sendOptions.map(o => [o.mode, o.offered ? 'ok' : o.reason])).toEqual([
      ['partial', NEW_LISTING_SENT_WHOLE], ['full', 'ok'], ['delete', ALREADY_DELETED('Amazon · IT')]])
    expect(cell.sendOptions.find(o => o.mode === 'full')!.warning).toBe(NEW_LISTING_SENT_WHOLE)
  }))

  it('Status Active on a deleted row lists it again on the next Publish; the Action takes only Full update; the Shared scope refuses', () => scoped(async () => {
    const f = await family('DR-WRITE', ['S', 'M'])
    const at = new Date(Date.now() - 60_000)
    const root = await deleted(f.root, at)
    const s = await deleted(f.children.S, at)
    const m = await deleted(f.children.M, at)
    expect(await writePublishActions(f.root, { listingIds: [s], change: { column: 'status', target: 'active' } }, publisher())).toMatchObject({ applied: [s], refused: [] })
    expect(await stored(s)).toMatchObject({ sellingTarget: 'ACTIVE', sellingTargetById: ids.anna })
    // The main row's choice reaches its variations that did not choose (Amazon needs the main product to list them).
    await writePublishActions(f.root, { listingIds: [root], change: { column: 'status', target: 'inactive' } }, publisher())
    const cells = await readPublishActions(f.root, { channel: 'AMAZON', marketplace: 'IT' })
    expect(cells.map(c => [c.sku, c.create?.target, c.create?.source]).sort()).toEqual([['DR-WRITE', 'inactive', 'own'], ['DR-WRITE-M', 'inactive', 'main'], ['DR-WRITE-S', 'active', 'own']])
    expect(cells.find(c => c.sku === 'DR-WRITE-S')!.create!.sentence).toBe(RELIST_SENTENCE.active)
    // Action: Partial update and Delete are refused; Full update stores nothing (a create is always sent whole).
    expect((await writePublishActions(f.root, { listingIds: [m], change: { column: 'send', mode: 'partial' } }, owner())).refused[0].reason).toBe(NEW_LISTING_SENT_WHOLE)
    expect((await writePublishActions(f.root, { listingIds: [m], change: { column: 'send', mode: 'delete' } }, owner())).refused[0].reason).toBe(ALREADY_DELETED('Amazon · IT'))
    expect(await writePublishActions(f.root, { listingIds: [m], change: { column: 'send', mode: 'full' } }, owner())).toMatchObject({ applied: [m], refused: [] })
    expect(await stored(m)).toMatchObject({ publishAction: null, publishActionAt: null, sellingTarget: null })
    // The Shared scope never lists a deleted market again: it is chosen in that market's own sheet.
    const shared = await writePublishActions(f.children.M, { listingIds: [m], allCoordinates: true, change: { column: 'status', target: 'active' } }, publisher())
    expect(shared.refused).toEqual([{ listingId: m, sku: 'DR-WRITE-M', reason: SHARED_DELETED('Amazon · IT') }])
    expect(await stored(m)).toMatchObject({ sellingTarget: null })
  }))

  it('an OLDER relist choice (Partial update stored as a lone time after the delete) reads as Status Active; a Status choice clears it', () => scoped(async () => {
    const f = await family('DR-OLD', [])
    const at = new Date(Date.now() - 120_000)
    const id = await deleted(f.root, at, { publishAction: null, publishActionAt: new Date(at.getTime() + 30_000), publishActionById: ids.anna })
    const before = (await readPublishActions(f.root, { channel: 'AMAZON', marketplace: 'IT' }))[0]
    expect(before).toMatchObject({ create: { target: 'active', source: 'own' }, send: { mode: 'full', setAt: null } })
    await writePublishActions(f.root, { listingIds: [id], change: { column: 'status', target: 'not_listed' } }, publisher())
    expect(await stored(id)).toMatchObject({ sellingTarget: 'NOT_LISTED', publishAction: null, publishActionAt: null, publishActionById: null })
    expect((await readPublishActions(f.root, { channel: 'AMAZON', marketplace: 'IT' }))[0].create).toMatchObject({ target: 'not_listed', source: 'own' })
  }))

  it('the Shared scope counts the markets left out for every product it wrote, not only the page\'s product', () => scoped(async () => {
    const f = await family('DR-LEFT', ['S', 'M'])
    const s = await listing(f.children.S, 'AMAZON', 'IT', ids.amazon)
    const mAmazon = await listing(f.children.M, 'AMAZON', 'IT', ids.amazon)
    const mEbay = await listing(f.children.M, 'EBAY', 'IT', ids.ebay, { externalListingId: '992' })
    // Opened on M (which lacks nothing), the fill also wrote S, which has no eBay IT listing: one market left out.
    const result = await writePublishActions(f.children.M, { listingIds: [s, mAmazon, mEbay], allCoordinates: true, change: { column: 'status', target: 'inactive' } }, publisher())
    expect(result).toMatchObject({ refused: [], leftOut: { count: 1 } })
    expect(result.applied.sort()).toEqual([s, mAmazon, mEbay].sort())
  }))
})
