/**
 * S10 (docs/sheet-ids-sku-rows/PLAN.md) — what Nexus reads back about a removed listing row (`readListingDeletions`), on
 * PGlite with the production schema and policies:
 *   - `sku`: the seller SKU the channel held, as the Delete's own record names it (the engine keeps it as `sku`); an
 *     unlink's record names none, so it is unknown (null) — never guessed from the product.
 *   - `unlinked`: an accepted unlink (Item ID control) is read like a removal, but marked: the listing may still be live
 *     there. Such a row is never listed as new — its choice reads Not listed whatever it or its main row chose
 *     (`newListingChoices`), and its words never say "set Status to Active and Publish" (that made a second eBay item).
 * Every id is invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property) }) }
})

import { readListingDeletions } from './listing-deletions.js'
import { newListingChoices } from './new-listing-choices.js'
import { deletedPublishSkip, deletedStatusReason, newListingSentence, sharedRemovedRefusal, statusOptionsFor } from '@nexus/shared/listing-actions'

const inside = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const db = () => database.client as any
const ids: Record<string, string> = {}
const DELETED_AT = new Date('2026-10-04T12:00:00.000Z')
const UNLINKED_AT = new Date('2026-10-05T09:00:00.000Z')

/** A row in the draft shape a Delete or an unlink leaves (no channel number, DRAFT, unpublished, paused). */
async function removedRow(key: string, sku: string, channel: string, parentId: string | null, sellingTarget: string | null = null) {
  const product = await db().product.create({ data: { sku, name: sku, basePrice: 10, ...(parentId ? { parentId } : { isParent: key === 'main' }) } })
  ids[`${key}Product`] = product.id
  const listing = await db().channelListing.create({ data: { productId: product.id, channel, marketplace: 'IT', channelMarket: `${channel}_IT`, region: 'EU',
    externalListingId: null, listingStatus: 'DRAFT', isPublished: false, syncPaused: true, platformAttributes: {},
    ...(sellingTarget ? { sellingTarget, sellingTargetAt: new Date('2026-10-05T10:00:00.000Z') } : {}) } })
  ids[key] = listing.id
  return listing
}

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    // Amazon: deleted by the engine's Delete, whose record names the SKU it deleted (a listing with its own SKU).
    const amazon = await removedRow('amazon', 'DEL-JKT-M', 'AMAZON', null)
    await db().channelListingSnapshot.create({ data: { channelListingId: amazon.id, channel: 'AMAZON', marketplace: 'IT', aliasKey: '', reason: 'delete',
      outcome: 'ACCEPTED', acceptedAt: DELETED_AT, payload: { kind: 'listing-action', action: 'delete', sku: ' DEL-JKT-M-IT ', evidence: { oldExternalListingId: 'B0OLD00001' } } } })
    // eBay: a family unlinked from its item (both rows), the main row and its variation both choosing Active since.
    const main = await removedRow('main', 'UNL-JKT', 'EBAY', null, 'ACTIVE')
    const variation = await removedRow('variation', 'UNL-JKT-S', 'EBAY', main.productId, 'ACTIVE')
    for (const row of [main, variation]) {
      await db().channelListingSnapshot.create({ data: { channelListingId: row.id, channel: 'EBAY', marketplace: 'IT', aliasKey: '', reason: 'unlink',
        outcome: 'ACCEPTED', acceptedAt: UNLINKED_AT, payload: { kind: 'channel-id-unlink', __capturedFrom: 'listing-state', state: {}, evidence: { oldExternalListingId: '520000000001' } } } })
    }
  })
}, 60_000)
afterAll(async () => { await database?.close() })

const candidates = (keys: string[], channel: string) => keys.map(key => ({ id: ids[key], channel, marketplace: 'IT', externalListingId: null, listingStatus: 'DRAFT', isPublished: false }))

describe('a removal names the SKU the channel held, and says when it was an unlink', () => {
  it('a Delete: the SKU its record names (trimmed); not unlinked', async () => {
    const removed = await inside(() => readListingDeletions(candidates(['amazon'], 'AMAZON')))
    expect(removed.get(ids.amazon)).toEqual({ at: DELETED_AT.toISOString(), where: 'Amazon · IT', oldReference: 'B0OLD00001', relistChosenAt: null, sku: 'DEL-JKT-M-IT' })
  })

  it('an unlink: unlinked, its old item named, its SKU unknown (null) — never the product SKU', async () => {
    const removed = await inside(() => readListingDeletions(candidates(['main', 'variation'], 'EBAY')))
    expect(removed.get(ids.main)).toEqual({ at: UNLINKED_AT.toISOString(), where: 'eBay · IT', oldReference: '520000000001', relistChosenAt: null, sku: null, unlinked: true })
    expect(removed.get(ids.variation)?.unlinked).toBe(true)
  })
})

describe('an unlinked row is never listed as new', () => {
  it('its choice reads Not listed although it and its main row chose Active; a deleted row keeps its own choice', async () => {
    const deletions = await inside(() => readListingDeletions([...candidates(['main', 'variation'], 'EBAY')]))
    const listings = [
      { id: ids.main, productId: ids.mainProduct, externalListingId: null, listingStatus: 'DRAFT', isPublished: false, sellingTarget: 'ACTIVE', sellingTargetAt: new Date('2026-10-05T10:00:00.000Z') },
      { id: ids.variation, productId: ids.variationProduct, externalListingId: null, listingStatus: 'DRAFT', isPublished: false, sellingTarget: 'ACTIVE', sellingTargetAt: new Date('2026-10-05T10:00:00.000Z') },
    ]
    const products = [{ id: ids.mainProduct, parentId: null }, { id: ids.variationProduct, parentId: ids.mainProduct }]
    const choices = newListingChoices({ channel: 'EBAY', aliasKey: '', familyId: ids.mainProduct, products, listings, deletions } as never)
    for (const id of [ids.mainProduct, ids.variationProduct]) expect(choices.get(id)).toMatchObject({ target: 'not_listed', source: 'default', own: null })
    // The same rows deleted (not unlinked): their own Active lists them again, as before.
    const deleted = new Map([...deletions].map(([id, d]) => [id, { ...d, unlinked: undefined }]))
    const again = newListingChoices({ channel: 'EBAY', aliasKey: '', familyId: ids.mainProduct, products, listings, deletions: deleted } as never)
    expect(again.get(ids.mainProduct)).toMatchObject({ target: 'active', source: 'own' })
  })

  it('every word the sheet and Publish read says the unlink\'s truth', async () => {
    const unlinked = (await inside(() => readListingDeletions(candidates(['main'], 'EBAY')))).get(ids.main)!
    const now = Date.parse('2026-10-05T15:00:00Z')
    const head = 'Unlinked from eBay · IT on 5 Oct: the item may still be live there, and Nexus no longer updates it.'
    expect(deletedStatusReason(unlinked, now)).toBe(`${head} Link its Item ID again on the main row; listing it as new makes a second item.`)
    expect(deletedPublishSkip(unlinked, now)).toBe(`${head} Publish leaves it out: link its Item ID again on the main row; listing it as new makes a second item.`)
    expect(newListingSentence({ target: 'not_listed', source: 'default' }, { deleted: unlinked, now })).not.toMatch(/set Status to Active/)
    expect(statusOptionsFor('not_listed', 'ebay-trading', { deleted: unlinked }).filter(o => o.offered).map(o => o.target)).toEqual(['not_listed'])
    expect(sharedRemovedRefusal(unlinked)).toBe('Unlinked from eBay · IT: the item may still be live there, and Nexus no longer updates it. Link its Item ID again in the eBay · IT sheet.')
  })
})
