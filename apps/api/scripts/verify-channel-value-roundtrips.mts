/** Real Prisma/database round trips on unpublished fixtures; the transaction always rolls back. */
import assert from 'node:assert/strict'
import prisma from '../src/db.js'
import { channelValuePatch, storedChannelState, type ValueRecord } from '../src/services/pim/channel-value-mutation.js'
import type { ChannelStore } from '../src/services/pim/channel-specs/types.js'

const sku = `NEXUS-CHANNEL-VERIFY-${Date.now()}`
const rollback = new Error('ROLLBACK_CHANNEL_VALUE_VERIFICATION')
const cases: Array<{ name: string; store?: ChannelStore; keys: string[]; value: unknown }> = [
  { name: 'text', keys: ['fixture_material'], value: 'Fixture fabric' },
  { name: 'false boolean', keys: ['fixture_flag'], value: false },
  { name: 'zero price', store: { kind: 'listingColumn', column: 'price', followFlag: 'followMasterPrice' }, keys: ['price'], value: 0 },
  { name: 'title', store: { kind: 'listingColumn', column: 'title', followFlag: 'followMasterTitle' }, keys: ['title', 'item_name'], value: 'Fixture title' },
  { name: 'list positions', store: { kind: 'listingColumn', column: 'bulletPointsOverride', followFlag: 'followMasterBulletPoints' }, keys: ['bulletPoints', 'bullet_point'], value: ['First', '', 'Third'] },
  { name: 'zero measure', store: { kind: 'platformAttributes', path: ['fixture', 'weight'], unitPath: ['fixture', 'unit'] }, keys: ['fixture_weight'], value: { value: 0, unit: 'kg' } },
  { name: 'platform path', store: { kind: 'platformAttributes', path: ['itemSpecifics', 'Fixture'] }, keys: ['fixture_specific'], value: 'Fixture value' },
]
const checks: string[] = []
try {
  try {
    await prisma.$transaction(async tx => {
      const product = await tx.product.create({ data: { sku, name: 'Channel verification fixture', basePrice: 0, status: 'DRAFT' } })
      const createListing = (marketplace: string) => tx.channelListing.create({ data: {
        productId: product.id, channel: 'AMAZON', marketplace, region: marketplace, channelMarket: `AMAZON_${marketplace}`,
        aliasKey: '', listingStatus: 'DRAFT', isPublished: false, syncPaused: true,
        overrideData: { retained: 'keep' }, platformAttributes: { retained: 'keep' },
      } })
      let listing = await createListing('IT')
      const otherMarket = await createListing('DE')
      for (const test of cases) {
        for (const action of ['SET', 'CLEAR', 'INHERIT'] as const) {
          const patch = channelValuePatch(listing as unknown as ValueRecord, test.store, test.keys, action, test.value)
          listing = await tx.channelListing.update({ where: { id: listing.id, version: listing.version }, data: { ...patch, version: { increment: 1 } } as any })
          const persisted = await tx.channelListing.findUniqueOrThrow({ where: { id: listing.id } })
          const state = storedChannelState(persisted as unknown as ValueRecord, test.store, test.keys)
          if (test.name === 'zero price' && state.value !== null) state.value = Number(state.value)
          const cleared = test.name === 'list positions' ? [] : null
          assert.deepEqual(state, action === 'INHERIT' ? { state: 'inherited', value: null }
            : { state: 'stored', value: action === 'CLEAR' ? cleared : test.value }, `${test.name}: ${action}`)
          assert.equal(persisted.isPublished, false)
          assert.equal(persisted.syncPaused, true)
          assert.equal((persisted.overrideData as ValueRecord).retained, 'keep')
          assert.equal((persisted.platformAttributes as ValueRecord).retained, 'keep')
          checks.push(`${test.name}: ${action} → database read`)
        }
      }
      assert.deepEqual(await tx.channelListing.findUniqueOrThrow({ where: { id: otherMarket.id } }), otherMarket)
      const stale = await tx.channelListing.updateMany({ where: { id: listing.id, version: listing.version - 1 }, data: { title: 'stale write' } })
      assert.equal(stale.count, 0)
      checks.push('other market unchanged', 'stale version refused')
      throw rollback
    }, { timeout: 60_000 })
  } catch (error) { if (error !== rollback) throw error }
  assert.equal(checks.length, 23)
  assert.equal(await prisma.product.count({ where: { sku } }), 0)
  checks.push('fixture rolled back')
  console.log(JSON.stringify({ passed: true, checks, persistedTestProducts: 0, marketplaceWrites: 0 }, null, 2))
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await prisma.$disconnect()
}
