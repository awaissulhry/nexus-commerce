import { afterAll, beforeAll, expect, it, vi } from 'vitest'

/**
 * PLAN A-39 (R-41) — the REAL "ours" seam (`amazonContentOurs`) on an in-process PostgreSQL (PGlite), against the studio
 * publication builder itself: what the content read compares must be what the studio would SEND — a second opinion of
 * the payload would report drift the payload does not have. Then the job end to end with the real seam and a stubbed
 * Amazon read, and the R-LX-6 case through the real resolver.
 * The fixture is Step 3.2's gate's (`sheet-payload-parity.vitest.test.ts`): one product, one live Amazon·IT listing,
 * a cached category schema, three values stored where the sheet stores them.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../services/outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.stubGlobal('fetch', vi.fn(async (url: unknown) => { throw new Error(`network refused in a gate: ${String(url)}`) }))

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { amazonContentOurs } from '../services/channel-drift/amazon-content-ours.js'
import { readPublicationFacts } from '../services/pim/studio-publication-plan.js'
import { prepareAmazonPublication } from '../services/pim/studio-publication-amazon.js'
import { runContentDrift } from './content-drift.job.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const MP = 'APJ6JRA9NG5V4'
const one = (extra: Record<string, unknown>) => ({ type: 'array', maxItems: 1, selectors: ['marketplace_id'],
  items: { type: 'object', properties: { value: { type: 'string', ...extra }, marketplace_id: { const: MP } } } })
const STORED = { part_number: 'XP-100', color: 'Nero', material: 'Mesh' }
let productId = '', account = '', itListing = '', deListing = ''

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: MP } as never })
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'DE', name: 'Germany', currency: 'EUR', region: 'EU', language: 'de', languages: ['de'], marketplaceId: 'A1PA6795UKMFR9' } as never })
  account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'wiring', isActive: true, externalAccountId: 'SELLER',
    authStatus: 'connected', managedBy: 'oauth', region: 'EU' } as never })).id
  await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'IT', productType: 'COAT', schemaVersion: 'v1', expiresAt: new Date(Date.now() + 86_400_000),
    schemaDefinition: { properties: { part_number: one({ maxLength: 40 }), color: one({ maxLength: 50 }), material: one({ enum: ['Mesh', 'Leather'] }) } } } })
  productId = (await prisma.product.create({ data: { sku: 'wiring-a', name: 'Giacca Wiring', basePrice: 10, productType: 'COAT', fulfillmentMethod: 'FBM' } as never })).id
  itListing = (await prisma.channelListing.create({ data: { productId, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU', channelConnectionId: account,
    externalListingId: 'B0WIRING01', listingStatus: 'ACTIVE', overrideData: STORED } })).id
  // DE: no German text and no cached DE schema — nothing of ours to compare.
  deListing = (await prisma.channelListing.create({ data: { productId, channel: 'AMAZON', marketplace: 'DE', channelMarket: 'AMAZON_DE', region: 'EU', channelConnectionId: account,
    externalListingId: 'B0WIRING01', listingStatus: 'ACTIVE' } })).id
}), 60_000)
afterAll(async () => { await state.db?.close() })

async function studioPayload() {
  const facts = await readPublicationFacts(productId, { channel: 'AMAZON', marketplace: 'IT', accountId: account })
  const message = (await prepareAmazonPublication(facts)).feed.messages[0]
  return (message.attributes ?? Object.fromEntries((message.patches ?? []).filter((p: any) => p.op === 'replace').map((p: any) => [p.path.replace('/attributes/', ''), p.value]))) as Record<string, unknown>
}

it('🔴 ours = what the studio would SEND: the mapped attributes and the content, root for root', async () => {
  const built = await scoped(() => amazonContentOurs(itListing))
  expect(built.ok).toBe(true)
  const ours = (built as any).ours
  const payload = await scoped(() => studioPayload())
  // Positive control: the seam built the three stored values and the title — an empty "ours" would agree vacuously.
  expect(Object.keys(ours.attributes).sort()).toEqual(['color', 'material', 'part_number'])
  expect(ours.content.item_name).toEqual([{ value: 'Giacca Wiring', marketplace_id: MP, language_tag: 'it_IT' }])
  for (const root of Object.keys(ours.attributes)) expect({ root, value: ours.attributes[root] }).toEqual({ root, value: payload[root] })
  for (const root of Object.keys(ours.content)) expect({ root, value: ours.content[root] }).toEqual({ root, value: payload[root] })
})

it('🔴 end to end with the real seam: Amazon holds another title and another colour → exactly those two entries', async () => {
  const payload = await scoped(() => studioPayload())
  const theirs = { ...payload, item_name: [{ value: 'Altro titolo', marketplace_id: MP, language_tag: 'it_IT' }], color: [{ value: 'Rosso', marketplace_id: MP }] }
  await scoped(() => runContentDrift({ at: new Date('2026-10-01T03:37:00Z'), deps: {
    read: async () => ({ success: true, asin: 'B0WIRING01', attributes: theirs }), sleep: async () => undefined } }))
  const row = await scoped(() => prisma.channelDrift.findFirst({ where: { channelListingId: itListing } }))
  expect((row?.driftedFields as any[]).map(e => e.field).sort()).toEqual(['color', 'item_name[it_IT]'])
  expect(row?.driftCount).toBe(2)
  expect((row?.checkedBySource as any)['amazon-content']).toMatchObject({ outcome: 'compared', differing: 2 })
})

it('🔴 R-LX-6 through the real resolver: a DE listing with no German text (and no DE schema) is NOT compared, with the reason', async () => {
  const row = await scoped(() => prisma.channelDrift.findFirst({ where: { channelListingId: deListing } }))
  expect(row?.driftCount).toBe(0)
  const clock = (row?.checkedBySource as any)['amazon-content']
  expect(clock.outcome).toBe('not_compared')
  expect(clock.reason).toMatch(/R-LX-6/)
  expect(clock.reason).toMatch(/no cached COAT schema for Amazon·DE/)
  // And the resolver itself emitted no German entry (not a compare that hid one).
  const built = await scoped(() => amazonContentOurs(deListing))
  expect((built as any).ours.content).toEqual({})
})

it('S7 — Amazon is read under the SKU it holds the listing by: parity (product SKU), an own SKU; no single SKU is a reason, never a guess', async () => {
  // Parity: the fixture listing has no SKU of its own.
  expect(((await scoped(() => amazonContentOurs(itListing))) as any).ours.sku).toBe('wiring-a')
  const ids = await scoped(async () => {
    const make = async (sku: string, data: Record<string, unknown>, offers: Array<[string, 'FBA' | 'FBM']> = []) => {
      const product = await prisma.product.create({ data: { sku, name: sku, basePrice: 10, productType: 'COAT', fulfillmentMethod: 'FBM' } as never })
      const listing = await prisma.channelListing.create({ data: { productId: product.id, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU',
        channelConnectionId: account, listingStatus: 'ACTIVE', isPublished: true, ...data } })
      for (const [offerSku, method] of offers) await prisma.offer.create({ data: { channelListingId: listing.id, sku: offerSku, fulfillmentMethod: method, isActive: true } })
      return listing.id
    }
    return {
      own: await make('wiring-own', { externalListingId: 'B0WIRING02', liveChannelSku: 'WIRING-OWN-IT' }),
      twoOffers: await make('wiring-two', { externalListingId: 'B0WIRING03' }, [['WIRING-TWO-A', 'FBA'], ['WIRING-TWO-B', 'FBM']]),
      disagree: await make('wiring-disagree', { externalListingId: 'B0WIRING04', platformAttributes: { seller_sku: 'WIRING-ATTR' } }, [['WIRING-OFFER', 'FBM']]),
    }
  })
  expect(((await scoped(() => amazonContentOurs(ids.own))) as any).ours.sku).toBe('WIRING-OWN-IT')
  expect(await scoped(() => amazonContentOurs(ids.twoOffers))).toEqual({ ok: false, reason: 'several active seller SKUs — the builder would refuse' })
  expect(await scoped(() => amazonContentOurs(ids.disagree))).toEqual({ ok: false,
    reason: 'no single seller SKU — wiring-disagree: conflicting Amazon seller SKUs. Reconcile this listing\'s identity before publishing.' })
})
