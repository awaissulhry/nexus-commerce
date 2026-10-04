/**
 * Amazon sheet gaps U4b (design-draft-and-remote §A fact 4) — the old page's Amazon pull merges Amazon's `attributes`
 * into the listing's `platformAttributes` instead of replacing the whole bag. It used to write `{ attributes }` alone,
 * wiping the offer draft (`amazonOfferDraft`), the live offer and fulfilment stores (`amazonOffer`,
 * `amazonFulfillment`), the media workspace and the top-level fulfilment mirrors the fulfilment door writes.
 *
 * On an in-process PostgreSQL (PGlite) with the generated schema and the production row policies. Amazon is faked.
 * Every id is invented.
 *
 * Run: DATABASE_URL=postgresql://nexus@127.0.0.1:1/nexus_unit_test npx vitest run src/services/amazon/flat-file-pull.platform-attributes-merge.vitest.test.ts
 * and again with NEXUS_WORKSPACES_ENABLED=1.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, amazon: new Map<string, unknown>() }))
vi.mock('@nexus/database', async importOriginal => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { ...await importOriginal<any>(), default: state.db.client, prisma: state.db.client }
})
vi.mock('../marketplaces/amazon.service.js', () => ({
  AMAZON_MARKETPLACE_CODE_TO_ID: { IT: 'APJ6JRA9NG5V4' },
  AmazonService: class { async fetchListingForFlatFile(sku: string) { return state.amazon.get(sku) ?? null } },
}))
vi.mock('../categories/schema-sync.service.js', () => ({
  CategorySchemaService: class { async getSchema() { throw new Error('no schema in this test') } },
}))
vi.mock('../product-event.service.js', () => ({ productEventService: { emitMany: vi.fn(async () => undefined) } }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { getJobStatus, startPullJob } from './flat-file-pull.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids: Record<string, string> = {}

const IT = 'APJ6JRA9NG5V4'
const DRAFT = { v: 1, leaves: { lead_time_to_ship_max_days: { value: 5, base: 2, savedAt: '2026-10-01T00:00:00Z', savedBy: 'u' } } }
const KEPT = {
  amazonOfferDraft: DRAFT,
  amazonOffer: { minimum_seller_allowed_price: 30, maximum_seller_allowed_price: 60, map_price: 40 },
  amazonFulfillment: { lead_time_to_ship_max_days: 2, restock_date: '2026-11-01' },
  _amazonMediaWorkspace: { slots: { MAIN: 'img-1' } },
  fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', lead_time_to_ship_max_days: 2 }],
  purchasable_offer: [{ marketplace_id: IT, currency: 'EUR', our_price: [{ schedule: [{ value_with_tax: 49.9 }] }] }],
  browseNodeId: '1234',
}
// What Amazon's getListingsItem reports now.
const REPORTED = {
  item_name: [{ value: 'Guanti moto', language_tag: 'it_IT', marketplace_id: IT }],
  purchasable_offer: [{ marketplace_id: IT, currency: 'EUR', our_price: [{ schedule: [{ value_with_tax: 52 }] }] }],
  fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 3, lead_time_to_ship_max_days: 2 }],
}

async function pull(): Promise<void> {
  const jobId = await scoped(async () => startPullJob('IT', 'GLOVES'))
  for (let i = 0; i < 200; i++) {
    const job = getJobStatus(jobId)
    if (job && job.status !== 'running') {
      expect(job.fatalError, job.fatalError).toBeUndefined()
      expect(job.errors).toEqual([])
      return
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('the pull did not finish')
}
const bagOf = (productId: string) => scoped(async () =>
  (await prisma.channelListing.findFirstOrThrow({ where: { productId, channel: 'AMAZON', marketplace: 'IT' } })).platformAttributes as Record<string, unknown>)

afterAll(async () => { await state.db?.close() })

beforeAll(async () => {
  await scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon IT', currency: 'EUR', region: 'EU', language: 'it', isActive: true } })
    ids.account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'primary', isActive: true, isPrimary: true,
      externalAccountId: 'SELLER-1', authStatus: 'connected', managedBy: 'oauth' } as never })).id
    ids.kept = (await prisma.product.create({ data: { sku: 'PULL-KEPT', name: 'kept', basePrice: 10, productType: 'GLOVES' } })).id
    ids.fresh = (await prisma.product.create({ data: { sku: 'PULL-FRESH', name: 'fresh', basePrice: 10, productType: 'GLOVES' } })).id
    ids.fba = (await prisma.product.create({ data: { sku: 'PULL-FBA', name: 'fba', basePrice: 10, productType: 'GLOVES' } })).id
    await prisma.channelListing.create({ data: { productId: ids.fba, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'IT',
      channelConnectionId: ids.account, isPublished: true, listingStatus: 'ACTIVE', externalListingId: 'B0FBA', quantity: 4,
      platformAttributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] } } as never })
    await prisma.channelListing.create({ data: { productId: ids.kept, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'IT',
      channelConnectionId: ids.account, isPublished: true, listingStatus: 'ACTIVE', externalListingId: 'B0KEPT',
      platformAttributes: { ...KEPT, attributes: { item_name: [{ value: 'stale', marketplace_id: IT }], stale_attribute: [{ value: 'gone' }] } } } as never })
  })
  state.amazon.set('PULL-KEPT', { asin: 'B0KEPT', attributes: REPORTED, title: 'Guanti moto', listingStatus: 'ACTIVE', productType: 'GLOVES', relationships: [] })
  state.amazon.set('PULL-FRESH', { asin: 'B0FRESH', attributes: REPORTED, title: 'Guanti moto', listingStatus: 'ACTIVE', productType: 'GLOVES', relationships: [] })
  state.amazon.set('PULL-FBA', { asin: 'B0FBA', attributes: REPORTED, title: 'Guanti moto', listingStatus: 'ACTIVE', productType: 'GLOVES', relationships: [] })
  await pull()
}, 60_000)

describe('the Amazon pull keeps the listing\'s bag', () => {
  it('Amazon\'s report replaces `attributes` (stale keys go); the draft, the live stores, the media workspace and the top-level mirrors stay', async () => {
    expect(await bagOf(ids.kept)).toEqual({ ...KEPT, attributes: REPORTED })
  })

  it('a listing the pull creates holds the report', async () => {
    expect(await bagOf(ids.fresh)).toEqual({ attributes: REPORTED })
  })
})

describe('the snapshot the pull rebuilds shows the live facts (the old page\'s rows)', () => {
  const snapshotOf = (productId: string) => scoped(async () =>
    (await prisma.channelListing.findFirstOrThrow({ where: { productId, channel: 'AMAZON', marketplace: 'IT' } })).flatFileSnapshot as Record<string, unknown>)

  it('the offer and fulfilment cells come from the live stores, never the draft (handling time 2, not the saved 5)', async () => {
    expect(await snapshotOf(ids.kept)).toMatchObject({
      purchasable_offer__minimum_seller_allowed_price__schedule__value_with_tax: '30',
      purchasable_offer__maximum_seller_allowed_price__schedule__value_with_tax: '60',
      purchasable_offer__map_price__schedule__value_with_tax: '40',
      fulfillment_availability__fulfillment_channel_code: 'DEFAULT',
      fulfillment_availability__lead_time_to_ship_max_days: '2',
      fulfillment_availability__restock_date: '2026-11-01',
    })
  })

  it('an FBA code the fulfilment door keeps wins over a merchant code in Amazon\'s report: FBA row, no quantity', async () => {
    expect(await snapshotOf(ids.fba)).toMatchObject({ fulfillment_availability__fulfillment_channel_code: 'AMAZON_EU', fulfillment_availability__quantity: '' })
  })
})
