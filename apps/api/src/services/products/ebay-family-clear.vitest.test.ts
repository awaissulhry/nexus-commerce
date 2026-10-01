/** The real bulk writer must not conflict with its own earlier family clear or forget that clear's field contract. */
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'

const state = vi.hoisted(() => ({
  db: null as Awaited<ReturnType<typeof import('../../test-support/formula-database.js').formulaDatabase>> | null,
  failAfterReceiptFor: null as string | null,
  failAfterContentFor: null as string | null,
}))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(async () => []), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
vi.mock('../pim/readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))
vi.mock('./bulk-edit-receipts.js', async load => {
  const original = await load<typeof import('./bulk-edit-receipts.js')>()
  return { ...original, writeBulkEditReceipts: async (...args: Parameters<typeof original.writeBulkEditReceipts>) => {
    await original.writeBulkEditReceipts(...args)
    if (state.failAfterReceiptFor && args[0].some(unit => unit.changes.some(change => change.id === state.failAfterReceiptFor))) {
      state.failAfterReceiptFor = null
      throw new Error('E2E fail after real listing writes and audit receipts')
    }
  } }
})
vi.mock('../pim/content-bulk-write.js', async load => {
  const original = await load<typeof import('../pim/content-bulk-write.js')>()
  return { ...original, applyContentBulk: async (...args: Parameters<typeof original.applyContentBulk>) => {
    const result = await original.applyContentBulk(...args)
    if (state.failAfterContentFor && args[0].changes.some(change => change.id === state.failAfterContentFor)) {
      const { default: database } = await import('../../db.js')
      const stored = await database.channelListingTranslation.findFirst({ where: { channelListing: { productId: state.failAfterContentFor }, language: 'it' }, select: { name: true } })
      if (stored?.name !== 'Must roll back') throw new Error('The late-failure control did not reach a completed content write')
      state.failAfterContentFor = null
      throw new Error('E2E fail after real content and fact writes completed')
    }
    return result
  } }
})

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { applyProductBulkSave, type BulkSaveUnit, type BulkSaveResult } from './bulk-save.service.js'
import { getStudioSheet } from '../pim/studio-sheet.service.js'
import { emptyMapping } from '../pim/schema-mapping.service.js'
import { readPublicationFacts } from '../pim/studio-publication-plan.js'
import { buildEbayListingInput } from '../pim/studio-publication-ebay.js'
import { resolveBatch } from '../pim/mapping/resolve-batch.service.js'
import { writeContent } from '../pim/content-write.js'
import type { ContentAddress } from '@nexus/shared/content-language'
import { aspectCanonicalName } from '../ebay-theme-axes.js'
import { seedClearEnvironment, seedClearFamily, seedClearListings, clearListings, clearUnit, itemSpecifics,
  COUNTRY_FIELD, COUNTRY_NAME, CUSTOM_FIELD, COLOR_FIELD, type ClearEnvironment, type ClearFamily } from '../../test-support/ebay-family-clear-fixture.js'

vi.setConfig({ testTimeout: 60_000 })
const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const context = { formulaCascade: false, contentPerRow: true, logger: { warn: vi.fn(), error: vi.fn() } }
let environment: ClearEnvironment
beforeAll(() => scoped(async () => { environment = await seedClearEnvironment(prisma) }), 120_000)
afterAll(async () => { await state.db?.close() }, 30_000)
const save = (units: BulkSaveUnit[]) => applyProductBulkSave({ units }, context)
const read = (family: ClearFamily) => getStudioSheet({ productId: family.parentId, scope: 'channel', channel: 'EBAY', market: family.market, locale: family.locale, accountId: family.accountId })
const resolved = (family: ClearFamily) => resolveBatch({ productIds: family.productIds, channel: 'EBAY', marketplace: family.market,
  channelConnectionId: family.accountId, aliasKey: family.aliasKey, locale: family.locale })
const offline = async (family: ClearFamily) => buildEbayListingInput(await readPublicationFacts(family.parentId, {
  channel: 'EBAY', marketplace: family.market, accountId: family.accountId,
  ...(family.aliasKey ? { listingId: (await clearListings(prisma, family)).find(row => row.productId === family.parentId)!.id } : {}),
}), { currency: 'EUR' })
const children = async (family: ClearFamily) => {
  const rows = await clearListings(prisma, family)
  return family.children.flatMap(id => rows.filter(row => row.productId === id))
}
const confirmed = (answer: BulkSaveResult) => {
  expect(answer.units.map(unit => unit.status), JSON.stringify(answer.units)).toEqual(answer.units.map(() => 200))
  for (const unit of answer.units) expect(unit.body.errors ?? []).toEqual([])
}
async function finalReceipts(family: ClearFamily, units: BulkSaveUnit[], answer: BulkSaveResult) {
  const rows = await clearListings(prisma, family)
  for (const result of answer.units.filter(unit => unit.status === 200)) {
    const request = units.find(unit => unit.key === result.key)!
    const productId = request.changes[0].id
    expect(result.body.versionOf).toBe('channelListing')
    expect(result.body.currentVersion).toBe(rows.find(row => row.productId === productId)!.version)
    if (result.body.expectedVersion !== undefined) expect(result.body.expectedVersion).toBe(request.expectedVersion)
    if (typeof result.body.operationId === 'string') {
      expect(await prisma.bulkOperation.findUnique({ where: { id: result.body.operationId }, select: { expectedVersion: true } }))
        .toEqual({ expectedVersion: request.expectedVersion })
    }
    for (const receipt of (result.body.familyListings ?? []) as Array<{ listingId: string; version: number }>) expect(receipt.version).toBe(rows.find(row => row.id === receipt.listingId)!.version)
  }
}
async function cleared(family: ClearFamily, name = COUNTRY_NAME) {
  const rows = await clearListings(prisma, family)
  for (const row of rows) expect(itemSpecifics(row)[name] ?? null).toBeNull()
  const parent = rows.find(row => row.productId === family.parentId)
  if (parent) expect(itemSpecifics(parent)).toHaveProperty(name, null)
}

it('clears a category-backed family field from A/B using their original tokens', () => scoped(async () => {
  const family = await seedClearFamily(prisma, environment)
  const sheet = await read(family)
  expect(sheet.columns.some(column => column.key === 'paese_di_origine' && column.editable)).toBe(true)
  const units = (await children(family)).map(row => clearUnit(family, row))
  const answer = await save(units)
  confirmed(answer); await cleared(family); await finalReceipts(family, units, answer)
  for (const row of (await read(family)).rows) expect(row.values.paese_di_origine.value).toBeNull()
}))

it('clears parent/A/B once and returns final owner counters for every unit', () => scoped(async () => {
  const family = await seedClearFamily(prisma, environment)
  const before = await clearListings(prisma, family)
  const ordered = family.productIds.map(id => before.find(row => row.productId === id)!)
  const units = ordered.map(row => clearUnit(family, row))
  const answer = await save(units)
  confirmed(answer); await cleared(family); await finalReceipts(family, units, answer)
  for (const row of await clearListings(prisma, family)) expect(row.version).toBe(before.find(prior => prior.id === row.id)!.version + 1)
}))

it.each([
  { field: CUSTOM_FIELD, name: 'Genere', legacyValue: 'Legacy value' },
  { field: COUNTRY_FIELD, name: COUNTRY_NAME, legacyValue: 'Italia' },
])('clears every casing of $name from storage and the actual offline payload', ({ field, name, legacyValue }) => scoped(async () => {
  const family = await seedClearFamily(prisma, environment), row = (await children(family))[1]
  const legacyName = name.toUpperCase(), specifics = { ...itemSpecifics(row) }
  delete specifics[name]; specifics[legacyName] = legacyValue
  await prisma.channelListing.update({ where: { id: row.id }, data: { platformAttributes: {
    ...(row.platformAttributes as Prisma.JsonObject), itemSpecifics: specifics,
  } } })
  const before = await clearListings(prisma, family)
  const column = (await read(family)).columns.find(column => column.key === field.slice(5))!
  expect(column.editable).toBe(true)
  const store = Object.values(column.channels ?? {})[0].store
  expect(store).toMatchObject({ kind: 'platformAttributes', path: ['itemSpecifics', name] })
  const units = (await children(family)).map(row => clearUnit(family, row, field))
  const answer = await save(units)
  confirmed(answer); await finalReceipts(family, units, answer)
  const after = await clearListings(prisma, family)
  const payload = await offline(family)
  // Check logical identity, not merely one spelling: a surviving GENERE must not evade a Genere assertion.
  expect.soft(Object.entries(payload.shared.itemSpecifics).filter(([key]) => aspectCanonicalName(key) === aspectCanonicalName(name))).toEqual([])
  for (const current of after) {
    expect.soft(itemSpecifics(current)).not.toHaveProperty(legacyName)
    expect.soft(Object.entries(itemSpecifics(current)).filter(([key, value]) => aspectCanonicalName(key) === aspectCanonicalName(name) && value !== null)).toEqual([])
    expect(current.version).toBe(before.find(prior => prior.id === current.id)!.version + 1)
    expect(itemSpecifics(current).Colore).toEqual(itemSpecifics(before.find(prior => prior.id === current.id)!).Colore)
  }
  expect(itemSpecifics(after.find(current => current.productId === family.parentId)!)).toHaveProperty(name, null)
}))

it.each([
  { field: CUSTOM_FIELD, name: 'Genere', legacyValue: 'Legacy value' },
  { field: COUNTRY_FIELD, name: COUNTRY_NAME, legacyValue: 'Italia' },
])('shows the listing-level $name that eBay receives when the first variant holds another spelling', ({ field, name, legacyValue }) => scoped(async () => {
  const family = await seedClearFamily(prisma, environment)
  const parent = (await clearListings(prisma, family)).find(row => row.productId === family.parentId)!
  const first = (await children(family))[0]
  // eBay takes ONE listing-level value per aspect: the parent first, then each variant in order. Move the parent's and
  // the first variant's value to a legacy spelling so that spelling is the one the payload chooses.
  for (const row of [parent, first]) {
    const specifics = { ...itemSpecifics(row) }
    if (!(name in specifics) && row !== first) continue
    delete specifics[name]
    if (row === first) specifics[name.toUpperCase()] = legacyValue
    await prisma.channelListing.update({ where: { id: row.id }, data: { platformAttributes: {
      ...(row.platformAttributes as Prisma.JsonObject), itemSpecifics: specifics,
    } } })
  }
  const sent = Object.entries((await offline(family)).shared.itemSpecifics)
    .filter(([key]) => aspectCanonicalName(key) === aspectCanonicalName(name)).map(([, value]) => value)
  // Positive control: the payload really sends the legacy spelling's value, so the sheet must not show another one.
  expect(sent).toEqual([legacyValue])
  for (const row of (await read(family)).rows) expect.soft(row.values[field.slice(5)].value, row.id).toEqual(legacyValue)
}))

for (const shape of ['scalar', 'list'] as const) it(`keeps a stored ${shape} other-specific clear editable in later units and a new operation`, () => scoped(async () => {
  const family = await seedClearFamily(prisma, environment)
  if (shape === 'list') for (const row of await children(family)) await prisma.channelListing.update({ where: { id: row.id }, data: {
    platformAttributes: { ...(row.platformAttributes as Prisma.JsonObject), itemSpecifics: { ...itemSpecifics(row), Genere: [String(itemSpecifics(row).Genere), 'Unisex'] } },
  } })
  expect((await read(family)).columns.some(column => column.key === 'other_specific_genere')).toBe(true)
  const before = await children(family), oldValue = itemSpecifics(before[0]).Genere
  const units = before.map(row => clearUnit(family, row, CUSTOM_FIELD))
  const answer = await save(units)
  confirmed(answer); await cleared(family, 'Genere'); await finalReceipts(family, units, answer)
  expect((await offline(family)).shared.itemSpecifics).not.toHaveProperty('Genere')
  const blankSheet = await read(family)
  const current = (await children(family)).find(row => row.id === before[0].id)!
  const unknown = clearUnit(family, current, 'attr_other_specific_never_stored')
  expect((await save([unknown])).units[0].status).toBe(400)
  for (const value of [{ invalid: true }, ['text', { invalid: true }]]) {
    const invalid = clearUnit(family, current, CUSTOM_FIELD); invalid.changes[0].value = value
    expect((await save([invalid])).units[0].status).toBe(400)
  }
  await cleared(family, 'Genere')
  const undo = clearUnit(family, current, CUSTOM_FIELD); undo.changes[0].value = oldValue
  confirmed(await save([undo])) // A new HTTP operation has no prior operation-local column evidence.
  expect(blankSheet.columns.some(column => column.key === 'other_specific_genere' && column.editable)).toBe(true)
  expect(itemSpecifics((await clearListings(prisma, family)).find(row => row.productId === family.parentId)!)).toHaveProperty('Genere', oldValue)
  expect((await offline(family)).shared.itemSpecifics.Genere).toEqual(oldValue)
}))

for (const field of [COUNTRY_FIELD, CUSTOM_FIELD]) it(`preserves the later unit's valid axis edit beside ${field}`, () => scoped(async () => {
  const family = await seedClearFamily(prisma, environment)
  const before = await children(family), units = before.map(row => clearUnit(family, row, field))
  units[1].changes.push({ id: before[1].productId, field: COLOR_FIELD, value: 'Verde', target: 'channel', intent: 'set' })
  const answer = await save(units)
  confirmed(answer); await cleared(family, field === CUSTOM_FIELD ? 'Genere' : COUNTRY_NAME)
  expect(itemSpecifics((await clearListings(prisma, family)).find(row => row.id === before[1].id)!)).toHaveProperty('Colore', 'Verde')
  await finalReceipts(family, units, answer)
}))

for (const { position, repeatClear } of [
  { position: 'first', repeatClear: true }, { position: 'later', repeatClear: true }, { position: 'later', repeatClear: false },
] as const) it(`preserves the ${position} unit's acknowledged pin-content edit ${repeatClear ? 'beside its family clear' : 'without a repeated clear'}`, () => scoped(async () => {
  const family = await seedClearFamily(prisma, environment), id = family.children[position === 'first' ? 0 : 1]
  const address: ContentAddress = { tier: 'pin', language: 'it', coordinate: { channel: 'EBAY', market: 'IT', accountId: family.accountId } }
  await writeContent({ productId: id, address, values: { title: 'Before title' }, label: 'Title' })
  const before = await children(family), units = before.map(row => clearUnit(family, row))
  const owner = await prisma.channelListing.findUniqueOrThrow({ where: { id: before.find(row => row.productId === id)!.id }, include: { translations: true } })
  const contentUnit = units.find(unit => unit.key === id)!
  if (!repeatClear) contentUnit.changes = []
  contentUnit.changes.push({ id, field: 'name', value: 'Saved title', contentAddress: address,
    contentVersion: owner.translations.find(row => row.language === 'it')!.version, contentAcknowledged: true })
  units.push({ ...clearUnit(family, before.find(row => row.productId === id)!, COUNTRY_FIELD, `${id}:after-content`),
    changes: [{ id, field: COLOR_FIELD, value: 'After content', target: 'channel' }] })
  const answer = await save(units)
  confirmed(answer); await cleared(family); await finalReceipts(family, units, answer)
  expect(await prisma.channelListingTranslation.findFirst({ where: { channelListingId: owner.id, language: 'it' }, select: { name: true } })).toEqual({ name: 'Saved title' })
  expect(itemSpecifics((await clearListings(prisma, family)).find(row => row.productId === id)!)).toHaveProperty('Colore', 'After content')
}))

it('keeps stale content counters and Product owners refused beside family clears', () => scoped(async () => {
  const family = await seedClearFamily(prisma, environment), id = family.children[1]
  const address: ContentAddress = { tier: 'pin', language: 'it', coordinate: { channel: 'EBAY', market: 'IT', accountId: family.accountId } }
  await writeContent({ productId: id, address, values: { title: 'Original title' }, label: 'Title' })
  const listing = (await children(family)).find(row => row.productId === id)!
  const content = await prisma.channelListingTranslation.findFirstOrThrow({ where: { channelListingId: listing.id, language: 'it' } })
  await writeContent({ productId: id, address, values: { title: 'External title' }, label: 'Title' })
  const before = await children(family), units = before.map(row => clearUnit(family, row))
  units.find(unit => unit.key === id)!.changes.push({ id, field: 'name', value: 'Must not overwrite', contentAddress: address,
    contentVersion: content.version, contentAcknowledged: true })
  const answer = await save(units), refused = answer.units.find(unit => unit.key === id)!
  expect(answer.units.map(unit => unit.status)).toEqual([200, 409])
  expect(refused.body.error).toMatch(/^.+ changed\. Reload before saving it\.$/)
  expect(refused.body.message).toBe(refused.body.error)
  await cleared(family)
  expect(await prisma.channelListingTranslation.findFirst({ where: { id: content.id }, select: { name: true, version: true } }))
    .toEqual({ name: 'External title', version: content.version + 1 })

  for (const tier of ['source', 'language'] as const) {
    const ownFamily = await seedClearFamily(prisma, environment), productId = ownFamily.children[1]
    const initialListing = (await children(ownFamily)).find(row => row.productId === productId)!
    await prisma.channelListing.update({ where: { id: initialListing.id }, data: { id: productId } })
    const contentAddress: ContentAddress = tier === 'source' ? { tier } : { tier, language: 'de' }
    const locale = tier === 'source' ? 'it' : 'de'
    if (tier === 'language') await writeContent({ productId, address: contentAddress, values: { title: 'Shared before' }, label: 'Title' })
    const listingRows = await children(ownFamily)
    // Coinciding ID strings and numbers are deliberate: a listing AFTER token cannot guard this Product owner.
    expect(listingRows[1].id).toBe(productId)
    await prisma.product.update({ where: { id: productId }, data: { version: listingRows[1].version + 1 } })
    const productBefore = await prisma.product.findUniqueOrThrow({ where: { id: productId }, include: { translations: true } })
    const requests = listingRows.map(row => clearUnit(ownFamily, row))
    requests[1].marketplaceContexts![0].locale = locale
    if (tier === 'language') requests[1].marketplaceContexts![0].marketplace = 'DE'
    requests[1].changes = [{ id: productId, field: 'name', value: 'Must not borrow listing proof', contentAddress,
      ...(tier === 'language' ? { contentVersion: productBefore.translations.find(row => row.language === 'de')!.version } : {}), contentAcknowledged: true }]
    expect((await save(requests)).units.map(unit => unit.status)).toEqual([200, 409])
    expect(await prisma.product.findUniqueOrThrow({ where: { id: productId }, include: { translations: true } })).toEqual(productBefore)
    await cleared(ownFamily)
  }
}))

it('rolls back completed content and its owner proof before the following factual unit', () => scoped(async () => {
  const family = await seedClearFamily(prisma, environment), id = family.children[1]
  const address: ContentAddress = { tier: 'pin', language: 'it', coordinate: { channel: 'EBAY', market: 'IT', accountId: family.accountId } }
  await writeContent({ productId: id, address, values: { title: 'Before title' }, label: 'Title' })
  const before = await children(family), units = before.map(row => clearUnit(family, row))
  const listing = before.find(row => row.productId === id)!
  const content = await prisma.channelListingTranslation.findFirstOrThrow({ where: { channelListingId: listing.id, language: 'it' } })
  units.find(unit => unit.key === id)!.changes.push({ id, field: 'name', value: 'Must roll back', contentAddress: address,
    contentVersion: content.version, contentAcknowledged: true })
  units.push({ ...clearUnit(family, listing, COUNTRY_FIELD, `${id}:after-rollback`),
    changes: [{ id, field: COLOR_FIELD, value: 'After rollback', target: 'channel' }] })
  state.failAfterContentFor = id
  try {
    const answer = await save(units)
    expect(state.failAfterContentFor).toBeNull() // The fault ran after real content + factual completion.
    expect(answer.units.map(unit => unit.status)).toEqual([200, 500, 200])
    expect(answer.units[1].body.nothingSaved).toBe(true)
    await cleared(family); await finalReceipts(family, units, answer)
    expect(await prisma.channelListingTranslation.findFirst({ where: { id: content.id }, select: { name: true, version: true } }))
      .toEqual({ name: 'Before title', version: content.version })
    expect(itemSpecifics((await clearListings(prisma, family)).find(row => row.id === listing.id)!)).toHaveProperty('Colore', 'After rollback')
  } finally { state.failAfterContentFor = null }
}))

it('does not authorize stale sibling data using A\'s token or B\'s own after-version', () => scoped(async () => {
  for (const supplied of ['stale-before', 'matches-after', 'matches-after-with-master-noop', 'valid-before-with-master-noops'] as const) {
    const family = await seedClearFamily(prisma, environment)
    const before = await children(family), units = before.map(row => clearUnit(family, row))
    await prisma.channelListing.update({ where: { id: before[1].id }, data: { version: { increment: 1 }, platformAttributes: {
      ...(before[1].platformAttributes as Prisma.JsonObject), itemSpecifics: { ...itemSpecifics(before[1]), Colore: 'External' },
    } } })
    const valid = supplied === 'valid-before-with-master-noops'
    if (supplied !== 'stale-before') units[1].expectedVersion = before[1].version + (valid ? 1 : 2)
    units[1].changes.push({ id: before[1].productId, field: COLOR_FIELD, value: valid ? 'External' : 'Must not overwrite', target: 'channel' })
    if (supplied === 'matches-after-with-master-noop' || valid) units[1].changes.push({ id: before[1].productId, field: 'brand', value: null })
    const answer = await save(units)
    expect(answer.units.map(unit => unit.status)).toEqual([200, valid ? 200 : 409])
    await cleared(family) // A's accepted family effect is distinct from B's refused mixed unit.
    expect(itemSpecifics((await clearListings(prisma, family)).find(row => row.id === before[1].id)!)).toHaveProperty('Colore', 'External')
    if (valid) await finalReceipts(family, units, answer)
  }
}))

it('isolates each account, market, alias and family', () => scoped(async () => {
  const family = await seedClearFamily(prisma, environment)
  const foreign = [
    { ...family, accountId: environment.otherAccountId }, { ...family, aliasKey: 'other-alias' }, { ...family, market: 'DE', locale: 'de' },
    await seedClearFamily(prisma, environment),
  ]
  for (const other of foreign.slice(0, 3)) await seedClearListings(prisma, other)
  const snapshots = await Promise.all(foreign.map(other => clearListings(prisma, other)))
  confirmed(await save((await children(family)).map(row => clearUnit(family, row))))
  await cleared(family)
  for (const [index, other] of foreign.entries()) expect(await clearListings(prisma, other)).toEqual(snapshots[index])
}))

it('keeps per-cell refusals and does not publish a dry-run clear as a stored effect', () => scoped(async () => {
  const family = await seedClearFamily(prisma, environment)
  const before = await children(family), units = before.map(row => clearUnit(family, row))
  units[1].changes.push(
    { id: before[1].productId, field: COLOR_FIELD, value: ['invalid', 'scalar'], target: 'channel' },
    { id: before[1].productId, field: 'attr_other_specific_never_stored', value: null, target: 'channel' },
    { id: before[1].productId, field: 'createdAt', value: 'must not change', target: 'channel' },
  )
  const answer = await save(units)
  expect(answer.units.map(unit => unit.status)).toEqual([200, 200])
  const errors = answer.units[1].body.errors as Array<{ field: string }>
  expect(errors.map(error => error.field).sort()).toEqual([COLOR_FIELD, 'attr_other_specific_never_stored', 'createdAt'].sort())
  await cleared(family)
  expect(itemSpecifics((await clearListings(prisma, family)).find(row => row.id === before[1].id)!)).toEqual({ Colore: itemSpecifics(before[1]).Colore, Genere: itemSpecifics(before[1]).Genere })
  const dryFamily = await seedClearFamily(prisma, environment), dryRows = await children(dryFamily)
  const dryUnits = dryRows.map(row => clearUnit(dryFamily, row)); dryUnits[0].dryRun = true
  confirmed(await save(dryUnits)); await cleared(dryFamily)
}))

it('still writes the first explicit blank to stop a mapping when no family copy exists', () => scoped(async () => {
  const family = await seedClearFamily(prisma, environment, { emptyCountry: true })
  const market = await prisma.marketplace.findFirstOrThrow({ where: { channel: 'EBAY', code: 'IT' } })
  await prisma.marketplace.update({ where: { id: market.id }, data: { schemaMapping: { ...emptyMapping(), fields: { paese_di_origine: { source: '', transforms: [{ type: 'default', value: 'Pakistan' }] } } } as unknown as Prisma.InputJsonValue } })
  try {
    const shown = await read(family)
    expect(shown.rows.find(row => row.id === family.parentId)!.values.paese_di_origine.value).toBe('Pakistan')
    expect((await offline(family)).shared.itemSpecifics).toHaveProperty(COUNTRY_NAME, 'Pakistan')
    const before = await clearListings(prisma, family)
    // One accepted clear isolates the explicit-blank read from the later-unit CAS defect.
    confirmed(await save([clearUnit(family, (await children(family))[0])]))
    await cleared(family)
    for (const row of await clearListings(prisma, family)) expect(row.version).toBe(before.find(prior => prior.id === row.id)!.version + 1)
    const payload = await offline(family)
    expect(payload.shared.itemSpecifics).not.toHaveProperty(COUNTRY_NAME)
    for (const row of (await read(family)).rows) expect(row.values.paese_di_origine.value).toBeNull()
    for (const row of (await resolved(family)).products) expect(row.cells.paese_di_origine.value).toBeNull()
    expect(payload.shared.variations.map(row => row.specifics.Colore).sort()).toEqual(['Giallo', 'Rosso'])

    const otherAccount = { ...family, accountId: environment.otherAccountId }
    await seedClearListings(prisma, otherAccount, { emptyCountry: true })
    expect((await offline(otherAccount)).shared.itemSpecifics).toHaveProperty(COUNTRY_NAME, 'Pakistan')
    const alias = await prisma.productListingAlias.create({ data: { productId: family.parentId, channel: 'EBAY', marketplace: 'IT', channelConnectionId: family.accountId, label: 'Clear isolation' } })
    const otherAlias = { ...family, aliasKey: alias.id }
    await seedClearListings(prisma, otherAlias, { emptyCountry: true })
    expect((await offline(otherAlias)).shared.itemSpecifics).toHaveProperty(COUNTRY_NAME, 'Pakistan')

    const own = (await children(family))[0]
    await prisma.channelListing.update({ where: { id: own.id }, data: { platformAttributes: {
      ...(own.platformAttributes as Prisma.JsonObject), itemSpecifics: { ...itemSpecifics(own), [COUNTRY_NAME]: 'Cina' },
    } } })
    expect((await offline(family)).shared.itemSpecifics).toHaveProperty(COUNTRY_NAME, 'Cina')
    const parent = (await clearListings(prisma, family)).find(row => row.productId === family.parentId)!
    const reset = clearUnit(family, parent); reset.changes[0].intent = 'reset'
    confirmed(await save([reset]))
    expect((await offline(family)).shared.itemSpecifics).toHaveProperty(COUNTRY_NAME, 'Pakistan')

    await prisma.marketplace.update({ where: { id: market.id }, data: { schemaMapping: { ...emptyMapping(), fields: {
      color: { source: '', transforms: [{ type: 'default', value: 'Mapped axis' }] },
    } } as unknown as Prisma.InputJsonValue } })
    for (const row of await clearListings(prisma, family)) {
      const specifics = { ...itemSpecifics(row) }
      if (row.productId === family.parentId) specifics.Colore = null
      else delete specifics.Colore
      await prisma.channelListing.update({ where: { id: row.id }, data: { platformAttributes: {
        ...(row.platformAttributes as Prisma.JsonObject), itemSpecifics: specifics,
      } } })
    }
    for (const row of (await resolved(family)).products.filter(row => family.children.includes(row.productId))) {
      expect(row.cells.color.value).toBe('Mapped axis')
    }
  } finally { await prisma.marketplace.update({ where: { id: market.id }, data: { schemaMapping: market.schemaMapping ?? Prisma.DbNull } }) }
}))

it('does not keep a clear acknowledgment across an intervening own set', () => scoped(async () => {
  const family = await seedClearFamily(prisma, environment, { children: 3 }), rows = await children(family)
  const units = rows.map(row => clearUnit(family, row))
  units[1].changes[0].value = 'Italia'
  const answer = await save(units)
  confirmed(answer); await cleared(family); await finalReceipts(family, units, answer)
}))

it('preserves the canonical missing-parent and optional-child cases', () => scoped(async () => {
  const parentless = await seedClearFamily(prisma, environment, { noParentListing: true })
  confirmed(await save((await children(parentless)).map(row => clearUnit(parentless, row))))
  await cleared(parentless)
  expect(await clearListings(prisma, parentless)).toHaveLength(2)
  const missingChild = await seedClearFamily(prisma, environment, { omitLastListing: true })
  confirmed(await save((await clearListings(prisma, missingChild)).map(row => clearUnit(missingChild, row))))
  await cleared(missingChild)
  expect(await clearListings(prisma, missingChild)).toHaveLength(2)
}))

it('publishes no clear/progression state from a unit rolled back after its real writes', () => scoped(async () => {
  const family = await seedClearFamily(prisma, environment), before = await children(family)
  state.failAfterReceiptFor = before[0].productId
  const answer = await save(before.map(row => clearUnit(family, row)))
  expect(answer.units.map(unit => unit.status)).toEqual([500, 200])
  expect(answer.units[0].body.nothingSaved).toBe(true)
  await cleared(family)
  expect(await prisma.auditLog.count({ where: { entityId: before[0].productId } })).toBe(0)
  expect(await prisma.auditLog.count({ where: { entityId: before[1].productId } })).toBeGreaterThan(0)
  const committed = await clearListings(prisma, family)
  const later = committed.find(row => row.productId === before[0].productId)!
  confirmed(await save([clearUnit(family, later)]))
  expect((await clearListings(prisma, family)).find(row => row.productId === family.parentId)!.version)
    .toBeGreaterThan(committed.find(row => row.productId === family.parentId)!.version)
}))
