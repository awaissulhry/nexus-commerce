import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

const fixture = vi.hoisted(() => ({ database: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  fixture.database = await formulaDatabase()
  return { default: fixture.database.client }
})
vi.mock('../../lib/queue.js', () => ({ addJobSafely: vi.fn(), outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: null }))
vi.mock('../audit-log.service.js', () => ({ auditLogService: { write: vi.fn() } }))
import prisma from '../../db.js'
import pimRoutes from '../../routes/pim.routes.js'
import { catalogRoutes } from '../../routes/catalog.routes.js'
import amazonRoutes from '../../routes/amazon.routes.js'
import { createAlias, archiveAlias, updateAlias } from './listing-alias.service.js'
import { productReadCacheService } from '../product-read-cache.service.js'
import { applyTransferTarget } from './catalog-transfer.service.js'
import { relationshipTransaction } from './product-relationship.service.js'

const app = Fastify()
const row = (id: string) => prisma.product.findUniqueOrThrow({ where: { id } })
const post = (path: string, payload: object) => app.inject({ method: 'POST', url: path, payload })
const addListing = (productId: string, extra: object = {}) => prisma.channelListing.create({ data: {
  productId, channel: 'EBAY', marketplace: 'IT', region: 'IT', channelMarket: 'EBAY_IT',
  channelConnectionId: 'account', isPublished: false, ...extra,
} })
const addAlias = (productId = 'parent', status = 'ACTIVE') => prisma.productListingAlias.create({ data: {
  productId, status, label: 'Second listing', channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'account',
} })
beforeAll(async () => {
  await app.register(pimRoutes, { prefix: '/api' })
  await app.register(catalogRoutes, { prefix: '/api/catalog' })
  await app.register(amazonRoutes, { prefix: '/api/amazon' })
  await app.ready()
}, 60_000)
beforeEach(async () => {
  await prisma.productReadCache.deleteMany()
  await prisma.productImage.deleteMany()
  await prisma.channelListing.deleteMany()
  await prisma.productListingAlias.deleteMany()
  await prisma.product.deleteMany()
  await prisma.channelConnection.deleteMany()
  await prisma.channelConnection.create({ data: { id: 'account', channelType: 'EBAY', isActive: true } })
  await prisma.product.createMany({ data: ['parent', 'other', 'standalone', 'archived'].map(id => ({
    id, sku: id, name: id, basePrice: 10, version: 3, isParent: ['parent', 'other'].includes(id),
    deletedAt: id === 'archived' ? new Date() : null,
  })) })
  await prisma.product.createMany({ data: ['child', 'sibling'].map(id => ({ id, sku: id, name: id, basePrice: 10, version: 3,
    parentId: 'parent', variantAttributes: { Color: 'Black' }, categoryAttributes: { variations: { Color: 'Black' }, material: 'Cotton' },
  })) })
})
afterAll(async () => { await app.close(); await fixture.database.close() })

describe('product family actions against the production Prisma schema', () => {
  it('commits imported values, Parent SKU and their cache projection together', async () => {
    const before = await prisma.product.findUniqueOrThrow({ where: { id: 'standalone' }, include: { categories: { select: { categoryId: true, isPrimary: true } } } })
    await prisma.$transaction(tx => applyTransferTarget(tx, {
      key: 'standalone', identity: { row: 2, entity: 'Products', sku: 'standalone', channel: '', accountId: '', marketplace: '', aliasKey: '', locale: '', field: 'name', action: 'SET', value: 'Imported name' },
      before: JSON.parse(JSON.stringify(before)), patch: { name: 'Imported name' }, parentSku: 'parent', cells: [], rows: [], contractHash: 'fixture', create: false,
    }, 'fixture-import', null), { isolationLevel: 'Serializable' })
    expect(await row('standalone')).toMatchObject({ name: 'Imported name', parentId: 'parent', version: 4 })
    expect(await prisma.productReadCache.findUniqueOrThrow({ where: { id: 'standalone' } })).toMatchObject({ name: 'Imported name', parentId: 'parent', version: 4 })
    expect(await prisma.productReadCache.findUniqueOrThrow({ where: { id: 'parent' } })).toMatchObject({ childCount: 3 })
  })
  it('refreshes both parents’ cached counts, coverage and borrowed image when a child moves', async () => {
    await addListing('child')
    await prisma.productImage.create({ data: { productId: 'child', url: 'https://fixture.invalid/child.jpg', type: 'MAIN' } })
    await productReadCacheService.refresh('child')
    expect(await prisma.productReadCache.findUniqueOrThrow({ where: { id: 'parent' } })).toMatchObject({ childCount: 2, rollupChannelKeys: ['EBAY_IT'], imageUrl: 'https://fixture.invalid/child.jpg' })
    const res = await post('/api/pim/reparent', { productId: 'child', newParentId: 'other', expectedParentId: 'parent' })
    expect(res.statusCode, res.body).toBe(200)
    expect(await prisma.productReadCache.findUniqueOrThrow({ where: { id: 'child' } })).toMatchObject({ parentId: 'other', version: 4 })
    expect(await prisma.productReadCache.findUniqueOrThrow({ where: { id: 'parent' } })).toMatchObject({ childCount: 1, rollupChannelKeys: [], imageUrl: null })
    expect(await prisma.productReadCache.findUniqueOrThrow({ where: { id: 'other' } })).toMatchObject({ childCount: 1, rollupChannelKeys: ['EBAY_IT'], imageUrl: 'https://fixture.invalid/child.jpg' })
  })
  it('rolls back a family change if the cache update fails', async () => {
    await productReadCacheService.refresh('child')
    await fixture.database.db.exec(`CREATE FUNCTION reject_cache() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'cache fixture refusal'; END; $$ LANGUAGE plpgsql; CREATE TRIGGER reject_cache BEFORE UPDATE ON "ProductReadCache" FOR EACH ROW EXECUTE FUNCTION reject_cache();`)
    try {
      const res = await post('/api/amazon/pim/unlink-child', { productId: 'child', expectedParentId: 'parent' })
      expect(res.statusCode).toBe(500)
      expect(await row('child')).toMatchObject({ parentId: 'parent', version: 3 })
      expect(await prisma.productReadCache.findUniqueOrThrow({ where: { id: 'child' } })).toMatchObject({ parentId: 'parent', version: 3 })
    } finally { await fixture.database.db.exec('DROP TRIGGER reject_cache ON "ProductReadCache"; DROP FUNCTION reject_cache();') }
  })
  it('repairs the former parent from the previous cache membership after an external unlink', async () => {
    await productReadCacheService.refresh('child')
    await prisma.product.update({ where: { id: 'child' }, data: { parentId: null } })
    await productReadCacheService.refresh('child')
    expect(await prisma.productReadCache.findUniqueOrThrow({ where: { id: 'parent' } })).toMatchObject({ childCount: 1 })
    expect(await prisma.productReadCache.findUniqueOrThrow({ where: { id: 'child' } })).toMatchObject({ parentId: null })
  })
  it('offers eligible roots and standalones by name, excluding archived and current products', async () => {
    await addAlias('standalone')
    const parents = await app.inject('/api/pim/relationship-choices?kind=parent&exclude=parent,child')
    expect(parents.json().items.map((item: any) => item.id)).toEqual(['other'])
    const standalone = await app.inject('/api/pim/relationship-choices?kind=standalone&search=stand')
    expect(standalone.json().items).toEqual([{ id: 'standalone', sku: 'standalone', name: 'standalone', unavailable: expect.stringContaining('listing aliases') }])
    expect((await app.inject('/api/pim/relationship-choices?kind=unknown')).statusCode).toBe(400)
  })
  it('recognizes alias foreign keys even when a legacy discriminator is empty', async () => {
    const alias = await addAlias()
    await addListing('child', { aliasId: alias.id, aliasKey: '' })
    const res = await post('/api/amazon/pim/unlink-child', { productId: 'child' })
    expect(res.statusCode, res.body).toBe(409)
    expect((await row('child')).parentId).toBe('parent')
  })
  it('attaches only promoted roots and preserves the child’s existing axis values', async () => {
    const bad = await post('/api/pim/attach-to-parent', { parentId: 'standalone', productIds: ['child'] })
    expect(bad.statusCode, bad.body).toBe(409)
    await post('/api/pim/promote-to-parent', { productId: 'standalone' })
    await post('/api/amazon/pim/unlink-child', { productId: 'child' })
    const good = await post('/api/pim/attach-to-parent', { parentId: 'standalone', productIds: ['child', 'child'], axisValues: { child: { Size: 'L' } } })
    expect(good.json()).toMatchObject({ attached: 1, errors: [] })
    expect(await row('child')).toMatchObject({ parentId: 'standalone', version: 5, variantAttributes: { Color: 'Black', Size: 'L' }, categoryAttributes: { material: 'Cotton', variations: { Color: 'Black', Size: 'L' } } })
  })
  it.each(['child', 'archived'])('refuses %s as an attach destination', async parentId => {
    const res = await post('/api/pim/attach-to-parent', { parentId, productIds: ['standalone'] })
    expect([404, 409]).toContain(res.statusCode)
    expect((await row('standalone')).parentId).toBeNull()
  })
  it('retains per-child attach results without silently reparenting an existing child', async () => {
    const res = await post('/api/pim/attach-to-parent', { parentId: 'other', productIds: ['standalone', 'child', 'missing'] })
    expect(res.json()).toMatchObject({ attached: 1, errors: [{ productId: 'child' }, { productId: 'missing' }] })
    expect((await row('child')).parentId).toBe('parent')
    expect((await row('standalone')).parentId).toBe('other')
  })
  it('refuses a root with children even when its stored parent flag is false', async () => {
    await prisma.product.update({ where: { id: 'parent' }, data: { isParent: false } })
    const res = await post('/api/pim/attach-to-parent', { parentId: 'other', productIds: ['parent'] })
    expect(res.json().errors).toHaveLength(1)
    expect((await row('parent')).parentId).toBeNull()
  })
  it.each(['ACTIVE', 'ARCHIVED'])('protects %s alias members from move, unlink, forced demotion and deletion', async status => {
    const alias = await addAlias('parent', status)
    const listing = await addListing('child', { aliasId: alias.id, aliasKey: alias.id })
    for (const [path, body] of [
      ['/api/pim/reparent', { productId: 'child', newParentId: 'other' }],
      ['/api/amazon/pim/unlink-child', { productIds: ['child', 'sibling'] }],
      ['/api/pim/demote-parent', { productId: 'parent', force: true, expectedChildIds: ['child', 'sibling'] }],
    ] as const) {
      const res = await post(path, body)
      expect(res.statusCode, res.body).toBe(409)
    }
    const deleted = await app.inject({ method: 'DELETE', url: '/api/catalog/products/parent/children/child' })
    expect(deleted.statusCode, deleted.body).toBe(409)
    expect(await row('child')).toMatchObject({ parentId: 'parent', version: 3 })
    expect(await row('sibling')).toMatchObject({ parentId: 'parent', version: 3 })
    expect(await row('parent')).toMatchObject({ isParent: true, version: 3 })
    expect(await prisma.channelListing.findUnique({ where: { id: listing.id } })).not.toBeNull()
  })
  it('protects aliases owned by a standalone before attach', async () => {
    await addAlias('standalone', 'ARCHIVED')
    const res = await post('/api/pim/attach-to-parent', { parentId: 'parent', productIds: ['standalone'] })
    expect(res.json()).toMatchObject({ attached: 0, errors: [{ productId: 'standalone', error: expect.stringContaining('listing aliases') }] })
  })
  it('treats an unchanged relationship as a no-op even with aliases', async () => {
    const alias = await addAlias()
    await addListing('child', { aliasId: alias.id, aliasKey: alias.id })
    const res = await post('/api/pim/reparent', { productId: 'child', newParentId: 'parent' })
    expect(res.statusCode, res.body).toBe(200)
    expect((await row('child')).version).toBe(3)
  })
  it('unlinks a selected batch atomically and keeps axes and the empty Parent role', async () => {
    const res = await post('/api/amazon/pim/unlink-child', { productIds: ['child', 'sibling'] })
    expect(res.json()).toMatchObject({ detached: 2 })
    expect(await row('child')).toMatchObject({ parentId: null, version: 4, variantAttributes: { Color: 'Black' } })
    expect((await row('parent')).isParent).toBe(true)
    await post('/api/amazon/pim/unlink-child', { productIds: ['child', 'sibling'] })
    expect((await row('child')).version).toBe(4)
  })
  it('leaves the old parent role intact after moving its last child', async () => {
    await post('/api/amazon/pim/unlink-child', { productId: 'sibling' })
    const res = await post('/api/pim/reparent', { productId: 'child', newParentId: 'other' })
    expect(res.statusCode, res.body).toBe(200)
    expect(await row('child')).toMatchObject({ parentId: 'other', version: 4 })
    expect((await row('parent')).isParent).toBe(true)
  })
  it.each(['move', 'unlink'])('refuses a stale %s confirmation after a child changes parent', async action => {
    await prisma.product.update({ where: { id: 'child' }, data: { parentId: 'other', version: { increment: 1 } } })
    const res = action === 'move'
      ? await post('/api/pim/reparent', { productId: 'child', newParentId: 'parent', expectedParentId: 'parent' })
      : await post('/api/amazon/pim/unlink-child', { productIds: ['child', 'sibling'], expectedParentId: 'parent' })
    expect(res.statusCode, res.body).toBe(409)
    expect(await row('child')).toMatchObject({ parentId: 'other', version: 4 })
    expect(await row('sibling')).toMatchObject({ parentId: 'parent', version: 3 })
  })
  it.each([undefined, [], ['child'], ['child', 'sibling', 'new-child']])('refuses a forced demotion with stale or missing confirmation %j', async expectedChildIds => {
    const res = await post('/api/pim/demote-parent', { productId: 'parent', force: true, expectedChildIds })
    expect(res.statusCode, res.body).toBe(409)
    expect(await row('parent')).toMatchObject({ isParent: true, version: 3 })
    expect((await row('child')).parentId).toBe('parent')
  })
  it('demotes and detaches exactly the reviewed children in one transaction', async () => {
    const res = await post('/api/pim/demote-parent', { productId: 'parent', force: true, expectedChildIds: ['sibling', 'child'] })
    expect(res.statusCode, res.body).toBe(200)
    expect(await row('parent')).toMatchObject({ isParent: false, variationTheme: null, version: 4 })
    expect(await row('child')).toMatchObject({ parentId: null, version: 4 })
    expect(await row('sibling')).toMatchObject({ parentId: null, version: 4 })
  })
  it('rolls back detachment if updating the parent fails', async () => {
    await fixture.database.db.exec(`CREATE FUNCTION reject_demote() RETURNS trigger AS $$ BEGIN IF NEW.id = 'parent' AND NEW."isParent" = false THEN RAISE EXCEPTION 'fixture refusal'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql; CREATE TRIGGER reject_demote BEFORE UPDATE ON "Product" FOR EACH ROW EXECUTE FUNCTION reject_demote();`)
    try {
      const res = await post('/api/pim/demote-parent', { productId: 'parent', force: true, expectedChildIds: ['child', 'sibling'] })
      expect(res.statusCode).toBe(500)
      expect(await row('child')).toMatchObject({ parentId: 'parent', version: 3 })
    } finally { await fixture.database.db.exec('DROP TRIGGER reject_demote ON "Product"; DROP FUNCTION reject_demote();') }
  })
  it('bulk promotion skips children, missing and archived products', async () => {
    const res = await post('/api/pim/bulk-promote-to-parent', { productIds: ['parent', 'child', 'standalone', 'archived', 'missing'] })
    expect(res.json()).toMatchObject({ promoted: 1, skipped: { currentlyChild: ['child'], alreadyParent: ['parent'], notFound: ['archived', 'missing'] } })
    expect(await row('standalone')).toMatchObject({ isParent: true, version: 4 })
  })
  it('creates a draft child and keeps copied listings in their exact account and alias', async () => {
    const alias = await addAlias()
    await addListing('child', { title: 'Shared title' })
    await addListing('child', { aliasId: alias.id, aliasKey: alias.id, title: 'Alias title' })
    const res = await post('/api/catalog/products/parent/children', { sku: '00123', name: 'New child', copyFromProductId: 'child' })
    expect(res.statusCode, res.body).toBe(201)
    const product = res.json().data
    expect(product).toMatchObject({ sku: '00123', parentId: 'parent', status: 'DRAFT', syncChannels: [] })
    expect(await prisma.productReadCache.findUniqueOrThrow({ where: { id: product.id } })).toMatchObject({ status: 'DRAFT', parentId: 'parent', channelCount: 2 })
    expect(await prisma.productReadCache.findUniqueOrThrow({ where: { id: 'parent' } })).toMatchObject({ childCount: 3 })
    const listings = await prisma.channelListing.findMany({ where: { productId: product.id }, orderBy: { aliasKey: 'asc' } })
    expect(listings).toHaveLength(2)
    expect(listings[0]).toMatchObject({ channelConnectionId: 'account', aliasId: null, aliasKey: '', isPublished: false, externalListingId: null })
    expect(listings[1]).toMatchObject({ channelConnectionId: 'account', aliasId: alias.id, aliasKey: alias.id, isPublished: false, externalListingId: null })
  })
  it('rolls back a new child when the copy source belongs to another family', async () => {
    const res = await post('/api/catalog/products/other/children', { sku: 'new', name: 'New', copyFromProductId: 'child' })
    expect(res.statusCode, res.body).toBe(409)
    expect(await prisma.product.findUnique({ where: { sku: 'new' } })).toBeNull()
  })
  it('refuses creating a nested child', async () => {
    const res = await post('/api/catalog/products/child/children', { sku: 'nested', name: 'Nested' })
    expect(res.statusCode, res.body).toBe(409)
    expect(await prisma.product.findUnique({ where: { sku: 'nested' } })).toBeNull()
  })
  it.each([{ externalListingId: '123', listingStatus: 'DRAFT' }, { isPublished: true }])('protects remote records before hard deletion: %j', async listing => {
    await addListing('child', listing)
    const res = await app.inject({ method: 'DELETE', url: '/api/catalog/products/parent/children/child' })
    expect(res.statusCode, res.body).toBe(409)
    expect(await row('child')).toBeTruthy()
  })
  it('deletes a local child and cleans the parent payload while keeping its Parent role', async () => {
    await post('/api/amazon/pim/unlink-child', { productId: 'sibling' })
    const listing = await addListing('parent', { platformAttributes: { variants: { child: { color: 'Black' }, unrelated: { keep: true } } } })
    const res = await app.inject({ method: 'DELETE', url: '/api/catalog/products/parent/children/child' })
    expect(res.statusCode, res.body).toBe(200)
    expect(await prisma.product.findUnique({ where: { id: 'child' } })).toBeNull()
    expect(await prisma.productReadCache.findUnique({ where: { id: 'child' } })).toBeNull()
    expect(await prisma.productReadCache.findUniqueOrThrow({ where: { id: 'parent' } })).toMatchObject({ childCount: 0, isParent: true })
    expect((await row('parent')).isParent).toBe(true)
    expect((await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })).platformAttributes).toEqual({ variants: { unrelated: { keep: true } } })
  })
  it('creates aliases for the current root and children with draft-only listings', async () => {
    const alias = await createAlias({ productId: 'child', channel: 'EBAY', marketplace: 'IT', accountId: 'account' })
    expect(alias.productId).toBe('parent')
    const listings = await prisma.channelListing.findMany({ where: { aliasId: alias.id } })
    expect(listings.map(listing => listing.productId).sort()).toEqual(['child', 'parent', 'sibling'])
    expect(listings.every(listing => listing.aliasKey === alias.id && !listing.isPublished && listing.listingStatus === 'DRAFT')).toBe(true)
    expect(await prisma.productReadCache.findUniqueOrThrow({ where: { id: 'parent' } })).toMatchObject({ channelCount: 1, rollupChannelKeys: ['EBAY_IT'] })
    await archiveAlias(alias.id, { productId: 'child', accountId: 'account' })
    const archived = await archiveAlias(alias.id, { productId: 'child', accountId: 'account' })
    expect(archived.status).toBe('ARCHIVED')
    expect(await prisma.channelListing.count({ where: { aliasId: alias.id } })).toBe(3)
    await expect(updateAlias(alias.id, { label: 'Revived' }, { productId: 'child', accountId: 'account' })).rejects.toMatchObject({ statusCode: 409 })
  })
  it('rejects a child whose alias root was archived', async () => {
    await prisma.product.update({ where: { id: 'parent' }, data: { deletedAt: new Date() } })
    await expect(createAlias({ productId: 'child', channel: 'EBAY', marketplace: 'IT', accountId: 'account' })).rejects.toMatchObject({ statusCode: 404 })
    expect(await prisma.productListingAlias.count()).toBe(0)
  })
  it('returns actionable recovery for serialization conflicts without retrying a changed family', async () => {
    await expect(relationshipTransaction(async () => { throw Object.assign(new Error('serialization'), { code: 'P2034' }) })).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('Reload') })
  })
})
