import { afterAll, beforeAll, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ database: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  fixture.database = await formulaDatabase()
  return { default: fixture.database.client }
})
vi.mock('./readiness-index.service.js', () => ({ produceReadiness: vi.fn() }))

import prisma from '../../db.js'
import { writeContent } from './content-write.js'
import { getCellHistory } from './cell-history.service.js'

beforeAll(async () => {
  await prisma.product.create({ data: { id: 'history-product', sku: 'HISTORY', name: 'Source', basePrice: 10, status: 'DRAFT' } })
  await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  for (const accountId of ['history-a', 'history-b']) {
    await prisma.channelConnection.create({ data: { id: accountId, channelType: 'EBAY', isActive: true } })
    await prisma.channelListing.create({ data: { id: accountId, productId: 'history-product', channel: 'EBAY', marketplace: 'IT', region: 'IT', channelMarket: 'EBAY_IT', channelConnectionId: accountId } })
  }
  await prisma.productListingAlias.create({ data: { id: 'history-alt', productId: 'history-product', channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'history-b', label: 'Alternate', status: 'ACTIVE' } })
  await prisma.channelListing.create({ data: { id: 'history-b-alt', productId: 'history-product', channel: 'EBAY', marketplace: 'IT', region: 'IT', channelMarket: 'EBAY_IT', channelConnectionId: 'history-b', aliasKey: 'history-alt', aliasId: 'history-alt' } })
  await prisma.product.create({ data: { id: 'history-child', parentId: 'history-product', sku: 'HISTORY-CHILD', name: 'Child', basePrice: 10, status: 'DRAFT' } })
  await prisma.channelListing.create({ data: { id: 'history-child-alt', productId: 'history-child', channel: 'EBAY', marketplace: 'IT', region: 'IT', channelMarket: 'EBAY_IT', channelConnectionId: 'history-b', aliasKey: 'history-alt', aliasId: 'history-alt' } })
}, 120_000)
afterAll(async () => { await fixture.database?.close() }, 30_000)

it('shows source edits recorded by the current content writer', async () => {
  await writeContent({ productId: 'history-product', address: { tier: 'source' }, values: { title: 'Updated source', feature_200: ['Source only'] }, label: 'Title', userId: 'editor' })
  const history = await getCellHistory({ productId: 'history-product', fieldKey: 'name', locale: 'it' })
  expect(history.entries.map(row => row.next)).toContain('Updated source')
  expect(history.entries[0]).toMatchObject({ previous: 'Source', previousRecorded: true })
  expect((await getCellHistory({ productId: 'history-product', fieldKey: 'attr_feature_200', locale: 'de' })).entries).toEqual([])
})

it('shows only the requested translation, including its actual previous title and list slot', async () => {
  for (const [language, title] of [['de', 'Alt'], ['fr', 'Autre']]) {
    await writeContent({ productId: 'history-product', address: { tier: 'language', language }, values: { title, bulletPoints: ['First', 'Old'] }, label: 'Text' })
  }
  await writeContent({ productId: 'history-product', address: { tier: 'language', language: 'de' }, values: { title: 'Neu', bulletPoints: ['First', 'New'], feature: ['Other'], feature_200: ['Red', 'Blue'] }, label: 'Text' })
  const history = await getCellHistory({ productId: 'history-product', fieldKey: 'name', locale: 'de' })
  expect(history.entries.map(row => row.next)).toEqual(['Neu', 'Alt'])
  expect(history.entries[0]).toMatchObject({ previous: 'Alt', previousRecorded: true })
  const slot = await getCellHistory({ productId: 'history-product', fieldKey: 'bulletPoints[2]', locale: 'de' })
  expect(slot.entries[0]).toMatchObject({ previous: 'Old', next: 'New', previousRecorded: true })
  const attribute = await getCellHistory({ productId: 'history-product', fieldKey: 'attr_feature_200', locale: 'de' })
  expect(attribute.entries[0].next).toEqual(['Red', 'Blue'])
})

it('reads current pin audits and resets without exposing another account or alias', async () => {
  const coordinate = { channel: 'EBAY', market: 'IT', accountId: 'history-b', aliasId: 'history-alt' }
  for (const destination of [{ ...coordinate, accountId: 'history-a', aliasId: undefined }, { ...coordinate, aliasId: undefined }, coordinate]) {
    await writeContent({ productId: 'history-product', address: { tier: 'pin', language: 'it', coordinate: destination }, values: { title: `${destination.accountId}:${destination.aliasId ?? 'primary'}` }, label: 'Title' })
  }
  const input = { productId: 'history-product', fieldKey: 'ebay_title', locale: 'it', channel: 'EBAY', marketplace: 'IT', accountId: 'history-b', aliasKey: 'history-alt' }
  const history = await getCellHistory(input)
  expect(history.entries.map(row => row.next)).toEqual(['history-b:history-alt'])
  await writeContent({ productId: 'history-product', address: { tier: 'pin', language: 'it', coordinate }, values: {}, reset: ['title'], label: 'Title' })
  expect((await getCellHistory(input)).entries[0]).toMatchObject({ next: null, previous: 'history-b:history-alt', previousRecorded: true })
  expect((await getCellHistory({ ...input, locale: 'de' })).entries).toEqual([])
})

it('rejects invalid requested languages and skips malformed recorded languages without breaking history', async () => {
  await expect(getCellHistory({ productId: 'history-product', fieldKey: 'name', locale: 'invalid language' })).rejects.toMatchObject({ statusCode: 400 })
  await prisma.auditLog.create({ data: { entityType: 'Product', entityId: 'history-product', action: 'update',
    after: { title: 'Malformed attribution' }, metadata: { layer: 'master', language: 'invalid language' } } })
  const history = await getCellHistory({ productId: 'history-product', fieldKey: 'name', locale: 'it', limit: Number.NaN })
  expect(history.entries.map(row => row.next)).toEqual(['Updated source'])
})

it('reads the inspected child’s history when its family’s root listing selected the alias', async () => {
  await writeContent({ productId: 'history-child', address: { tier: 'pin', language: 'it', coordinate: { channel: 'EBAY', market: 'IT', accountId: 'history-b', aliasId: 'history-alt' } }, values: { title: 'Child pin' }, label: 'Title' })
  const history = await getCellHistory({ productId: 'history-child', fieldKey: 'ebay_title', locale: 'it', channel: 'EBAY', marketplace: 'IT', accountId: 'history-b', listingId: 'history-b-alt' })
  expect(history.entries.map(row => row.next)).toEqual(['Child pin'])
})
