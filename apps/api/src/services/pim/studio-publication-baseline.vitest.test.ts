import { afterAll, aroundAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '@nexus/database/workspace-context'
import type { Prisma } from '@prisma/client'
import type { StudioPublishFieldWrite } from '@nexus/shared/studio-publication'
import type { PublicationFacts } from './studio-publication-plan.js'

const fixture = vi.hoisted(() => ({ database: null as any, transactionOptions: [] as unknown[] }))
aroundAll(run => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, run))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  fixture.database = await formulaDatabase()
  return { default: new Proxy(fixture.database.client, { get(target, key) {
    const original = Reflect.get(target, key)
    if (key !== '$transaction') return original
    return (...args: unknown[]) => { fixture.transactionOptions.push(args[1]); return original.apply(target, args) }
  } }) }
})
import prisma from '../../db.js'
import { publicationChangeId } from './studio-publication-changes.js'
import { readPublicationBaseline } from './studio-publication-baseline.js'

const scope = { channel: 'AMAZON', marketplace: 'IT', accountId: 'baseline-account' }
const aliasKey = 'baseline-alias'
const identities = [
  { productId: 'baseline-parent', sku: 'SELLER-PARENT' },
  { productId: 'baseline-child', sku: 'SELLER-CHILD' },
  { productId: 'baseline-new', sku: 'SELLER-NEW' },
]
const value = (field: string, input: unknown): StudioPublishFieldWrite => ({ field, value: { state: 'value', value: input } })
const absent = (field: string): StudioPublishFieldWrite => ({ field, value: { state: 'absent' } })
const intent = (writes: unknown[], raw: unknown = { exact: 'provider request' }) => ({ intentVersion: 1, writes, request: raw })
const envelope = (requests: unknown[], overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, kind: 'studio-publication', productId: identities[0].productId, channelConnectionId: scope.accountId,
  sku: identities[0].sku, requests, ...overrides,
})
let sequence = 0
function snapshotData(id: string, writes: unknown[], overrides: Partial<Prisma.ChannelListingSnapshotUncheckedCreateInput> = {}): Prisma.ChannelListingSnapshotUncheckedCreateInput {
  const at = new Date(Date.UTC(2026, 8, 25, 0, 0, sequence++))
  return { id, channelListingId: 'baseline-listing-parent', channel: scope.channel, marketplace: scope.marketplace, aliasKey, reason: 'publish',
    publishEventId: `review-${id}`, outcome: 'ACCEPTED', acceptedAt: at, createdAt: at, payload: envelope([intent(writes)]) as Prisma.InputJsonValue, ...overrides }
}
const save = (id: string, writes: unknown[], overrides: Partial<Prisma.ChannelListingSnapshotUncheckedCreateInput> = {}) => prisma.channelListingSnapshot.create({ data: snapshotData(id, writes, overrides) })
const facts = async () => ({
  scope, destination: { aliasKey }, parent: { id: identities[0].productId },
  products: identities.map(item => ({ id: item.productId, sku: `LOCAL-${item.productId}`, name: 'Current product must not supply a baseline' })),
  // Deliberately broad: the loader must still enforce its exact listing coordinate and included products.
  listings: await prisma.channelListing.findMany(),
}) as unknown as PublicationFacts
const read = async () => readPublicationBaseline(await facts(), identities)
const field = (result: Awaited<ReturnType<typeof read>>, name: string, productId = identities[0].productId) => result.values.get(publicationChangeId(productId, name))

beforeAll(async () => {
  await prisma.product.createMany({ data: [...identities.map(item => item.productId), 'baseline-excluded'].map(id => ({ id, sku: `LOCAL-${id}`, name: id, basePrice: 10, status: 'DRAFT' })) })
  await prisma.channelConnection.createMany({ data: [{ id: scope.accountId, externalAccountId: 'baseline-seller', channelType: 'AMAZON', isActive: true }, { id: 'baseline-other-account', externalAccountId: 'baseline-other-seller', channelType: 'AMAZON', isActive: true }] })
  const listing = { productId: identities[0].productId, channel: scope.channel, marketplace: scope.marketplace, region: 'EU', channelMarket: 'AMAZON_IT', channelConnectionId: scope.accountId, aliasKey, externalListingId: 'remote-parent' }
  await prisma.channelListing.createMany({ data: [
    { ...listing, id: 'baseline-listing-parent' },
    { ...listing, id: 'baseline-listing-child', productId: identities[1].productId, externalListingId: 'remote-child' },
    { ...listing, id: 'baseline-listing-new', productId: identities[2].productId, externalListingId: null },
    { ...listing, id: 'baseline-listing-excluded', productId: 'baseline-excluded' },
    { ...listing, id: 'baseline-listing-account', channelConnectionId: 'baseline-other-account' },
    { ...listing, id: 'baseline-listing-alias', aliasKey: 'other-alias' },
    { ...listing, id: 'baseline-listing-market', marketplace: 'DE', channelMarket: 'AMAZON_DE' },
    { ...listing, id: 'baseline-listing-channel', channel: 'EBAY', channelMarket: 'EBAY_IT' },
  ] })
}, 120_000)
beforeEach(async () => { vi.restoreAllMocks(); sequence = 0; fixture.transactionOptions = []; await prisma.channelListingSnapshot.deleteMany() })
afterAll(async () => { vi.restoreAllMocks(); await fixture.database?.close() }, 30_000)

it('returns no invented baseline for empty history and a stable revision', async () => {
  const first = await read(), second = await read()
  expect([...first.values]).toEqual([])
  expect(first.revision).toMatch(/^[a-f0-9]{64}$/)
  expect(second.revision).toBe(first.revision)
})
it('retains accepted field history while a newly created listing awaits its local external ID', async () => {
  await save('accepted-new', [], { channelListingId: 'baseline-listing-new', payload: envelope([intent([value('brand', 'Accepted brand')])], {
    productId: identities[2].productId, sku: identities[2].sku,
  }) as Prisma.InputJsonValue })
  expect(field(await read(), 'brand', identities[2].productId)).toEqual({ state: 'value', value: 'Accepted brand' })
})

it('counts only publishes accepted after the listing\'s last accepted delete (delete and relist)', async () => {
  await save('before-delete', [value('brand', 'Old brand'), value('item_name', 'Old title')])
  const before = await read()
  expect(field(before, 'brand')).toEqual({ state: 'value', value: 'Old brand' })
  const deleteRecord = (id: string, overrides: Partial<Prisma.ChannelListingSnapshotUncheckedCreateInput> = {}) => {
    const at = new Date(Date.UTC(2026, 8, 25, 0, 0, sequence++))
    return prisma.channelListingSnapshot.create({ data: { id, channelListingId: 'baseline-listing-parent', channel: scope.channel, marketplace: scope.marketplace, aliasKey,
      reason: 'delete', publishEventId: `delete-${id}`, outcome: 'ACCEPTED', acceptedAt: at, createdAt: at, payload: { kind: 'listing-action', action: 'delete' }, ...overrides } })
  }
  // A delete the channel did not accept, or one of another listing, ends nothing.
  await deleteRecord('unaccepted-delete', { outcome: 'UNKNOWN', acceptedAt: null })
  await deleteRecord('child-delete', { channelListingId: 'baseline-listing-child' })
  expect(field(await read(), 'brand')).toEqual({ state: 'value', value: 'Old brand' })
  // The engine's accepted Delete of this listing ends its history: the next Publish reviews it as a new listing.
  await deleteRecord('the-delete')
  const after = await read()
  expect([...after.values]).toEqual([])
  expect(after.revision).not.toBe(before.revision)
  // A publish accepted after the delete counts again, alone.
  await save('after-delete', [value('item_name', 'Relisted title')])
  const relisted = await read()
  expect(field(relisted, 'item_name')).toEqual({ state: 'value', value: 'Relisted title' })
  expect(field(relisted, 'brand')).toBeUndefined()
})

it('folds sparse accepted publishes per field and applies later request ordinals last', async () => {
  await save('first', [value('item_name', 'First title'), value('brand', 'Original brand')])
  await save('second', [], { payload: envelope([intent([value('item_name', 'Intermediate title')]), intent([value('item_name', 'Final title')])]) as Prisma.InputJsonValue })
  const result = await read()
  expect(field(result, 'item_name')).toEqual({ state: 'value', value: 'Final title' })
  expect(field(result, 'brand')).toEqual({ state: 'value', value: 'Original brand' })
  expect(result.values.size).toBe(2)
})

it('folds scoped Amazon language intents independently and never adopts preserved remote companions', async () => {
  const marketplaceId = 'A1PA6795UKMFR9'
  // Contractual keys from the scoped content compiler; no provider/runtime module is imported.
  const de = 'item_name:["A1PA6795UKMFR9","de_DE"]'
  const en = 'item_name:["A1PA6795UKMFR9","en_GB"]'
  const entry = (language_tag: string, text: string) => ({ marketplace_id: marketplaceId, language_tag, value: text })
  const deInitial = entry('de_DE', 'Erster Titel'), enInitial = entry('en_GB', 'First title')
  const deNext = entry('de_DE', 'Neuer deutscher Titel'), enNext = entry('en_GB', 'New English title')
  const germanFacts = { ...await facts(), scope: { ...scope, marketplace: 'DE' } }
  const readLanguages = () => readPublicationBaseline(germanFacts, identities)
  const accepted = (id: string, writes: StudioPublishFieldWrite[], op: 'replace' | 'delete', entries: unknown[]) => save(id, [], {
    channelListingId: 'baseline-listing-market', marketplace: 'DE',
    payload: envelope([{ intentVersion: 1, writes, feedType: 'JSON_LISTINGS_FEED', marketplaceIds: [marketplaceId],
      header: { sellerId: 'seller-de', version: '2.0' }, message: { messageId: 1, sku: identities[0].sku, operationType: 'PATCH', productType: 'COAT',
        patches: [{ op, path: '/attributes/item_name', value: entries }] } }]) as Prisma.InputJsonValue,
  })

  await accepted('languages-initial', [value(de, [deInitial]), value(en, [enInitial])], 'replace', [deInitial, enInitial])
  const initial = await readLanguages()
  expect(field(initial, de)).toEqual({ state: 'value', value: [deInitial] })
  expect(field(initial, en)).toEqual({ state: 'value', value: [enInitial] })

  await accepted('languages-de-only', [value(de, [deNext])], 'replace', [deNext, entry('en_GB', 'Seller Central English companion')])
  const afterDe = await readLanguages()
  expect(field(afterDe, de)).toEqual({ state: 'value', value: [deNext] })
  expect(field(afterDe, en)).toEqual({ state: 'value', value: [enInitial] })

  await accepted('languages-en-only', [value(en, [enNext])], 'replace', [enNext, entry('de_DE', 'Seller Central German companion')])
  const afterEn = await readLanguages()
  expect(field(afterEn, de)).toEqual({ state: 'value', value: [deNext] })
  expect(field(afterEn, en)).toEqual({ state: 'value', value: [enNext] })

  await accepted('languages-delete-de', [absent(de)], 'delete', [{ marketplace_id: marketplaceId, language_tag: 'de_DE' }])
  const afterDelete = await readLanguages()
  expect(field(afterDelete, de)).toEqual({ state: 'absent' })
  expect(field(afterDelete, en)).toEqual({ state: 'value', value: [enNext] })
  expect([...afterDelete.values.keys()].sort()).toEqual([publicationChangeId(identities[0].productId, de), publicationChangeId(identities[0].productId, en)].sort())
})

it('keeps explicit deletion tombstones and replaces them on a later recreate', async () => {
  await save('initial', [value('description', 'Old description')])
  await save('delete', [absent('description')])
  expect(field(await read(), 'description')).toEqual({ state: 'absent' })
  await save('recreate', [value('description', 'New description')])
  expect(field(await read(), 'description')).toEqual({ state: 'value', value: 'New description' })
})

it('does not adopt preserved collection companions or erase prior fields for empty intent', async () => {
  await save('before', [value('ItemSpecifics:Material', 'Original material')])
  await save('collection', [], { payload: envelope([intent([value('ItemSpecifics:Color', 'Blue')], { xml: '<ItemSpecifics><Material>External material</Material><Color>Blue</Color></ItemSpecifics>' })]) as Prisma.InputJsonValue })
  await save('preserved-only', [], { payload: envelope([intent([], { xml: '<ItemSpecifics><Material>Preserved only</Material></ItemSpecifics>' })]) as Prisma.InputJsonValue })
  const result = await read()
  expect(field(result, 'ItemSpecifics:Material')).toEqual({ state: 'value', value: 'Original material' })
  expect(field(result, 'ItemSpecifics:Color')).toEqual({ state: 'value', value: 'Blue' })
})

it('uses only the accepted sibling of a partial publication and excludes every non-baseline state', async () => {
  await save('accepted-parent', [value('item_name', 'Accepted parent')], { publishEventId: 'partial-review' })
  await save('failed-child', [value('item_name', 'Rejected child')], { channelListingId: 'baseline-listing-child', publishEventId: 'partial-review', outcome: 'FAILED', acceptedAt: null,
    payload: envelope([intent([value('item_name', 'Rejected child')])], { productId: identities[1].productId, sku: identities[1].sku }) as Prisma.InputJsonValue })
  for (const outcome of ['FAILED', 'SUBMITTED', 'UNKNOWN', 'UNACCEPTED']) await save(`not-${outcome}`, [value('item_name', outcome)], { outcome })
  await save('accepted-without-time', [value('item_name', 'No acceptance time')], { acceptedAt: null })
  await save('manual', [value('item_name', 'Manual state')], { reason: 'manual' })
  const result = await read()
  expect(field(result, 'item_name')).toEqual({ state: 'value', value: 'Accepted parent' })
  expect(field(result, 'item_name', identities[1].productId)).toBeUndefined()
})

it('does not borrow sibling accounts, aliases, markets, channels, excluded products or local-only drafts', async () => {
  await save('own', [value('item_name', 'Own coordinate')])
  const before = await read()
  for (const suffix of ['account', 'alias', 'market', 'channel', 'excluded', 'new']) await save(`foreign-${suffix}`, [value(suffix, 'Foreign')], { channelListingId: `baseline-listing-${suffix}` })
  // A snapshot's denormalized coordinate must also match, even when its listing ID matches.
  for (const [key, input] of [['aliasKey', 'other-alias'], ['marketplace', 'DE'], ['channel', 'EBAY']]) await save(`wrong-${key}`, [value(key, 'Wrong coordinate')], { [key]: input })
  const after = await read()
  expect([...after.values]).toEqual([[publicationChangeId(identities[0].productId, 'item_name'), { state: 'value', value: 'Own coordinate' }]])
  expect(after.revision).toBe(before.revision)
})

it.each([{ sku: 'OTHER-SELLER-SKU' }, { channelConnectionId: 'baseline-other-account' }, { productId: 'baseline-excluded' }])('does not adopt a journal with another identity (%j)', async attribution => {
  await save('wrong-identity', [], { payload: envelope([intent([value('item_name', 'Not ours')])], attribution) as Prisma.InputJsonValue })
  expect((await read()).values.size).toBe(0)
})

it('marks previously known fields unknown after a later accepted request-only journal, preserving cleared keys', async () => {
  await save('before-legacy', [value('item_name', 'Old title'), absent('description')])
  await save('legacy', [], { payload: envelope([{ message: { attributes: { item_name: [{ value: 'Raw is not interpreted' }] } } }]) as Prisma.InputJsonValue })
  const unknown = await read()
  expect(field(unknown, 'item_name')).toMatchObject({ state: 'unknown', reason: expect.stringContaining('intent') })
  expect(field(unknown, 'description')).toMatchObject({ state: 'unknown' })
  expect(unknown.values.size).toBe(2)
  await save('after-legacy', [value('item_name', 'Known again')])
  const restored = await read()
  expect(field(restored, 'item_name')).toEqual({ state: 'value', value: 'Known again' })
  expect(field(restored, 'description')).toMatchObject({ state: 'unknown' })
})

it('applies legacy unknown barriers in request order and only to their own product', async () => {
  await save('parent-before', [value('brand', 'Parent brand')])
  await save('child-before', [], { channelListingId: 'baseline-listing-child', payload: envelope([intent([value('brand', 'Child brand')])], identities[1]) as Prisma.InputJsonValue })
  await save('parent-mixed', [], { payload: envelope([intent([value('brand', 'Before raw request')]), { xml: '<Raw/>' }, intent([value('title', 'After raw request')])]) as Prisma.InputJsonValue })
  const result = await read()
  expect(field(result, 'brand')).toMatchObject({ state: 'unknown' })
  expect(field(result, 'title')).toEqual({ state: 'value', value: 'After raw request' })
  expect(field(result, 'brand', identities[1].productId)).toEqual({ state: 'value', value: 'Child brand' })
})

it.each([
  { intentVersion: 2, writes: [] }, { intentVersion: 1 }, { intentVersion: 1, writes: {} },
  intent([{ field: '', value: { state: 'value', value: 'Invalid' } }]),
  intent([{ field: 'title', value: { state: 'unknown', reason: 'Not intentional' } }]),
  intent([{ field: 'title', value: { state: 'value' } }]),
  intent([{ field: 'title', value: { state: 'absent', value: 'Ambiguous' } }]),
])('refuses malformed latest intent instead of reusing an older clean baseline (%j)', async request => {
  await save('older', [value('title', 'Old clean value')])
  await save('invalid', [], { payload: envelope([request]) as Prisma.InputJsonValue })
  await expect(read()).rejects.toThrow(/intent|field|value/i)
})

it('uses accepted time, then created time, then ID for deterministic history ordering', async () => {
  const early = new Date('2026-09-01T00:00:00Z'), late = new Date('2026-09-02T00:00:00Z')
  await save('z-earlier-acceptance', [value('title', 'Earlier acceptance')], { acceptedAt: early, createdAt: late })
  await save('b-later', [value('title', 'B')], { acceptedAt: late, createdAt: early })
  await save('a-later', [value('title', 'A')], { acceptedAt: late, createdAt: early })
  expect(field(await read(), 'title')).toEqual({ state: 'value', value: 'B' })
  await save('a-latest-created', [value('title', 'Later created')], { acceptedAt: late, createdAt: late })
  expect(field(await read(), 'title')).toEqual({ state: 'value', value: 'Later created' })
})

it('continues past a full 250-row page without losing older untouched fields', async () => {
  await prisma.channelListingSnapshot.createMany({ data: Array.from({ length: 253 }, (_, index) => snapshotData(`page-${String(index).padStart(3, '0')}`, [
    value('title', `Version ${index}`), ...(index === 0 ? [value('brand', 'Retained from first page')] : []),
  ])) })
  const result = await read()
  expect(field(result, 'title')).toEqual({ state: 'value', value: 'Version 252' })
  expect(field(result, 'brand')).toEqual({ state: 'value', value: 'Retained from first page' })
  expect(fixture.transactionOptions).toEqual([{ isolationLevel: 'RepeatableRead' }])
}, 30_000)

it('binds revision to the accepted history and identities, including an empty intent request', async () => {
  const empty = await read()
  await save('known', [value('brand', 'Value')])
  const before = await read()
  expect(before.revision).not.toBe(empty.revision)
  await save('empty-intent', [])
  const after = await read()
  expect([...after.values]).toEqual([...before.values])
  expect(after.revision).not.toBe(before.revision)
  const changedSku = await readPublicationBaseline(await facts(), identities.map(item => ({ ...item, sku: `${item.sku}-NEW` })))
  expect(changedSku.revision).not.toBe(after.revision)
  expect(changedSku.values.size).toBe(0)
})

it('refuses missing or duplicate supplied product identities', async () => {
  await expect(readPublicationBaseline(await facts(), identities.slice(0, 1))).rejects.toThrow(/identity/i)
  await expect(readPublicationBaseline(await facts(), [...identities, identities[0]])).rejects.toThrow(/identity|duplicate/i)
})
