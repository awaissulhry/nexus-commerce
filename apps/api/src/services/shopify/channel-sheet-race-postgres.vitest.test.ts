/**
 * Real PostgreSQL, several connections (Lane B slice B1, docs/shopify-metafields/PLAN-2026-09-28.md §7, quality line Q5/Q8):
 * two draft saves of the Shopify sheet racing on one family never lose an edit and never both "win" silently.
 *
 * The save is guarded twice — a Serializable transaction and a versioned write of the listing row
 * (`linked-products.service.ts` `linkedTransaction` / `writeLinkedState`) — plus the cell's own draft token. Whichever of
 * those catches the loser, the rule this suite holds is the one the operator sees: every save reported as saved is in the
 * draft, every refused save is not, and the listing version moves once per saved call. The Shopify calls are stand-ins
 * (no store is contacted); the transaction, the rows and the race are real.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { emptyShopifyLinkedDraft } from '@nexus/shared/shopify-linked-products'
import { informationRegistry, informationStoredValue } from '@nexus/shared/shopify-information'
import { LAB_SCHEMA, LAB_STORE_FIELDS } from '@nexus/shared/shopify-lab-store'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'
import { shopifyCellToken } from './channel-sheet-projection.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
const s = vi.hoisted(() => ({ destination: null as any, snapshot: null as any }))
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => (database.client as any)[key] }) }))
vi.mock('../pim/channel-specs/shopify.js', () => ({ readShopifyMappingSchema: async () => ({ ...LAB_SCHEMA, definitions: LAB_STORE_FIELDS }) }))
vi.mock('./admin-client.js', () => ({ shopifyAdmin: async () => ({ graphql: async () => { throw new Error('No Shopify call is expected on a draft save') } }) }))
vi.mock('./information-gateway.js', () => ({ readInformation: async () => s.snapshot }))
vi.mock('./content-workspace.service.js', async importOriginal => ({ ...(await importOriginal<object>()), contentDestination: async () => s.destination }))
const { saveShopifySheetCells } = await import('./channel-sheet.service.js')
const { getLinkedWorkspace } = await import('./linked-products.service.js')

const WORKSPACE = 'nexus_legacy_workspace'
const inWorkspace = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: WORKSPACE, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const product = 'gid://shopify/Product/10'
const schema = { ...LAB_SCHEMA, definitions: LAB_STORE_FIELDS }
const field = (key: string) => informationRegistry(schema).find(f => f.definition?.key === key)!
const scope = () => ({ accountId: s.destination.accountId, listingId: s.destination.listing.id, market: 'GLOBAL' as const })
type Outcome = { saved: boolean; value: string; reason?: string }

async function cell(key: string, value: string) {
  const f = field(key), row = s.snapshot.rows[0]
  const workspace = await inWorkspace(() => getLinkedWorkspace(s.destination.familyId, scope()))
  return { colId: f.id, ownerId: product, fieldId: f.id, value, token: shopifyCellToken(workspace, product, f, row.locale), baseline: informationStoredValue(row, f), intent: 'set' as const }
}
const save = (cells: Awaited<ReturnType<typeof cell>>[]): Promise<Outcome[]> => inWorkspace(() => saveShopifySheetCells(s.destination.familyId, scope(), { cells }, null))
  .then(result => cells.map(c => ({ saved: result.cells[c.colId]?.ok === true, value: c.value!, reason: result.cells[c.colId]?.reason })),
    error => cells.map(c => ({ saved: false, value: c.value!, reason: (error as Error).message })))
const listingNow = async () => (await database.pool.query('SELECT version, "platformAttributes" AS pa FROM "ChannelListing" WHERE id = $1', [s.destination.listing.id])).rows[0]
const drafted = (pa: any, key: string) => (pa._nexusLinkedProducts?.edits ?? []).find((e: any) => e.key === key)?.nextValue

describe.skipIf(!concurrentDatabaseUrl())('Shopify draft saves racing on real PostgreSQL', () => {
  beforeAll(async () => {
    database = await concurrentDatabase()
    await inWorkspace(async () => {
      const connection = await database.client.channelConnection.create({ data: { channelType: 'SHOPIFY' } })
      const family = await database.client.product.create({ data: { sku: 'LAB-RACE', name: 'Race family', basePrice: 10 } })
      const draft = { ...emptyShopifyLinkedDraft(), informationOnly: true, members: [{ id: product, title: 'Listed title', handle: 'listed', image: null }] }
      const listing = await database.client.channelListing.create({ data: { productId: family.id, channel: 'SHOPIFY', channelMarket: 'SHOPIFY_GLOBAL', region: 'GLOBAL', marketplace: 'GLOBAL',
        channelConnectionId: connection.id, aliasKey: '', externalListingId: '10', platformAttributes: { _nexusLinkedProducts: draft } } })
      s.destination = { productId: family.id, familyId: family.id, accountId: connection.id, aliasKey: null, marketplace: 'GLOBAL', listing: { id: listing.id, productId: family.id } }
    })
    s.snapshot = { currency: 'EUR', timezone: 'Europe/Rome', rows: [
      { id: product, productId: product, kind: 'PRODUCT', title: 'Listed title', handle: 'listed', image: null, media: [], fields: [], values: { title: 'Listed title', category: null } },
    ] }
  }, 180_000)
  afterAll(async () => { await database?.close() }, 60_000)

  it('two saves of the SAME cell: one wins, the other is refused, nothing is lost or mixed', async () => {
    for (let round = 0; round < 5; round++) {
      const before = await listingNow()
      const [a, b] = await Promise.all([cell('variation_label', `Black ${round}`), cell('variation_label', `Navy ${round}`)])
      const outcomes = (await Promise.all([save([a]), save([b])])).flat()
      const after = await listingNow()
      const saved = outcomes.filter(o => o.saved)
      expect(saved, JSON.stringify(outcomes)).toHaveLength(1)
      expect(drafted(after.pa, 'variation_label')).toBe(saved[0].value)
      expect(after.version).toBe(before.version + 1)
      const loser = outcomes.find(o => !o.saved)!
      expect(loser.reason).toMatch(/Another editor changed this (family|draft cell)/)
    }
  })
  it('two saves of DIFFERENT cells: every save reported as saved is in the draft, every refused one is not', async () => {
    for (let round = 0; round < 5; round++) {
      const before = await listingNow()
      const [a, b] = await Promise.all([cell('swatch_app_settings', `Setting ${round}`), cell('rating_count', String(round + 1))])
      const outcomes = (await Promise.all([save([a]), save([b])])).flat()
      const after = await listingNow()
      const keys = ['swatch_app_settings', 'rating_count']
      for (const [i, outcome] of outcomes.entries()) {
        if (outcome.saved) expect(drafted(after.pa, keys[i])).toBe(outcome.value)
        else { expect(drafted(after.pa, keys[i])).not.toBe(outcome.value); expect(outcome.reason).toMatch(/Another editor changed this/) }
      }
      expect(after.version - before.version).toBe(outcomes.filter(o => o.saved).length)
      expect(outcomes.some(o => o.saved)).toBe(true)
    }
  })
})
