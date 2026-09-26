/**
 * NCF N6 — the host half of Shopify's product CSV on a real PostgreSQL (PGlite): the store is chosen, the store's
 * listings become verified targets with the handles Nexus knows them by, a first file makes a DRAFT mapping version and
 * every read records its use. The store's field list is not saved here, so its metafield columns are refused by name.
 */
import { beforeAll, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { readShopifyCsv, resolveShopifyCsv, SHOPIFY_CSV_IDENTITY } from './catalog-shopify-csv.js'
import { csvOf, SHOPIFY_CLASSIC_HEADERS, SHOPIFY_SAMPLE_ROWS } from './catalog-transfer-test/shopify-csv-fixtures.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let store = ''
beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'SHOPIFY', code: 'GLOBAL', name: 'Shopify', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  store = (await prisma.channelConnection.create({ data: { channelType: 'SHOPIFY', displayName: 'ACME store', isActive: true } })).id
  const product = (sku: string, parentId?: string) => prisma.product.create({ data: { id: `p-${sku}`, sku, name: sku, basePrice: 10, ...(parentId ? { parentId } : { isParent: sku === 'ACME-JACKET' }) } })
  const jacket = await product('ACME-JACKET')
  for (const size of ['S', 'M', 'L']) await product(`ACME-JACKET-${size}`, jacket.id)
  await product('ACME-CAP')
  const listing = (sku: string, platformAttributes: object = {}, externalListingId: string | null = null) => prisma.channelListing.create({ data: { productId: `p-${sku}`, channel: 'SHOPIFY', channelConnectionId: store,
    channelMarket: 'SHOPIFY_GLOBAL', marketplace: 'GLOBAL', region: 'GLOBAL', externalListingId, platformAttributes } })
  // The jacket is known by the handle its last Shopify file recorded; the cap by a linked-products workspace member.
  await listing('ACME-JACKET', { [SHOPIFY_CSV_IDENTITY]: { handle: 'acme-jacket', status: 'active', options: ['Size'], variants: [{ sku: 'ACME-JACKET-S', values: ['S'] }] },
    _nexusLinkedProducts: { version: 1, members: [{ id: 'gid://shopify/Product/777', title: 'Acme cap', handle: 'acme-cap', image: null }], relationship: null, baselineLinks: [], edits: [] } })
  for (const size of ['S', 'M', 'L']) await listing(`ACME-JACKET-${size}`)
  await listing('ACME-CAP', {}, 'gid://shopify/Product/777')
}))

it('reads the file against the store’s listings, makes a DRAFT version on first read and records every use', () => scoped(async () => {
  const table = readShopifyCsv(csvOf(SHOPIFY_CLASSIC_HEADERS, SHOPIFY_SAMPLE_ROWS))
  const first = await resolveShopifyCsv(table)
  expect(first.accountId).toBe(store)
  expect(first.mapping).toMatchObject({ version: 1, status: 'DRAFT', created: true, label: 'Shopify · product CSV · v1 (draft)' })
  expect(first.warnings[0]).toMatch(/^Shopify product CSV \(ACME store\): populated values are reviewed/)
  expect(first.warnings).toContain('Shopify · product CSV · v1 (draft): the first file with these columns. Nexus made a new mapping version from its rules; review it on the File mappings page.')
  // Both known products are read; the gloves are not linked, so nothing of theirs is.
  expect(new Set(first.rows.map(r => r.sku))).toEqual(new Set(['ACME-JACKET', 'ACME-JACKET-S', 'ACME-JACKET-M', 'ACME-JACKET-L', 'ACME-CAP']))
  expect(first.issues.filter(i => i.field === 'Handle').every(i => /acme-gloves/.test(i.message))).toBe(true)
  // The store's field list is not saved in this database: every filled metafield cell is refused, by name.
  expect(first.issues.filter(i => /metafields/.test(i.field)).map(i => i.message)).toEqual([expect.stringMatching(/field list \(its metafield definitions\) is not loaded/), expect.stringMatching(/not loaded/)])
  const set = await prisma.channelMappingSet.findFirstOrThrow({ where: { channel: 'SHOPIFY', formKind: 'SHOPIFY_PRODUCT_CSV', formKey: store }, include: { fields: true, uses: true } })
  expect(set).toMatchObject({ marketplace: 'GLOBAL', status: 'DRAFT', version: 1 })
  expect(set.fields).toHaveLength(SHOPIFY_CLASSIC_HEADERS.length)
  expect(set.uses).toMatchObject([{ action: 'IMPORT', detail: { rows: first.rows.length, refused: first.issues.length, excluded: first.exclusions.length } }])
  // A second read of the same columns uses the same version.
  const second = await resolveShopifyCsv(table, { accountId: store })
  expect(second.mapping).toMatchObject({ setId: set.id, created: false })
  expect(await prisma.channelMappingUse.count({ where: { setId: set.id } })).toBe(2)
}))

it('reads only the product group on the product sheet, in its own store', () => scoped(async () => {
  const table = readShopifyCsv(csvOf(SHOPIFY_CLASSIC_HEADERS, SHOPIFY_SAMPLE_ROWS))
  const sheet = await resolveShopifyCsv(table, { productId: 'p-ACME-JACKET-M' })
  expect(new Set(sheet.rows.map(r => r.sku))).toEqual(new Set(['ACME-JACKET', 'ACME-JACKET-S', 'ACME-JACKET-M', 'ACME-JACKET-L']))
  expect(sheet.exclusions.some(e => e.message === 'Outside this product; use Catalog import')).toBe(true)
  await expect(resolveShopifyCsv(table, { productId: 'nope' })).rejects.toThrow('This product is unavailable')
}))
