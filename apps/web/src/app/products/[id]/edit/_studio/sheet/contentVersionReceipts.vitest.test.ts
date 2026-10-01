import { describe, expect, it } from 'vitest'
import { adoptContentVersions, contentWriteProof, preserveContentVersions } from './contentVersions'

/**
 * Qualified content receipts (`contentVersionReceipts`, API `pim/content-version-receipts.ts`): a save names every content
 * row it actually wrote — its own edits, its formulas', the shared-text cascade's — with the owner/content pair before
 * and after. A cell adopts the after pair only when its own confirmed pair is the receipt's before pair.
 */
type Pair = { ownerVersion: number; contentVersion: number }
const snapshot = (listingId: string, ownerVersion = 10, contentVersion = 4) => ({
  id: 'product-a', version: 30, listing: { id: listingId, version: ownerVersion },
  values: {
    name: { value: 'Name A', contentAddress: { tier: 'pin', language: 'de' }, contentVersion },
    french: { value: 'French name', contentAddress: { tier: 'pin', language: 'fr' }, contentVersion: 2 },
    shared: { value: 'Shared name', contentAddress: { tier: 'language', language: 'de' }, contentVersion: 3 },
  } as Record<string, { value: string; contentAddress: { tier: string; language: string }; contentVersion: number }>,
})
const pinReceipt = (listingId: string, beforeOwner = 10, beforeContent = 4, afterOwner = 11, afterContent = 5) => ({
  productId: 'product-a', tier: 'pin', listingId, language: 'de',
  before: { ownerVersion: beforeOwner, contentVersion: beforeContent } as Pair, after: { ownerVersion: afterOwner, contentVersion: afterContent } as Pair,
})

describe('qualified receipts move only a cell whose confirmed pair is the before pair', () => {
  it('moves only the exact follower listing and language, with its own listing owner', () => {
    const saved = snapshot('listing-primary'), alias = snapshot('listing-alias'), otherAccount = snapshot('listing-other-account')
    for (const row of [saved, alias, otherAccount]) preserveContentVersions(undefined, row)
    const body = { updated: 1, currentVersion: 31, versionOf: 'product', contentVersionReceipts: [pinReceipt('listing-alias')] }
    expect(adoptContentVersions(saved, body, [saved, alias, otherAccount])).toEqual(['name'])
    expect(alias.listing.version).toBe(11)
    expect(alias.values.name).toMatchObject({ value: 'Name A', contentVersion: 5 })
    expect(alias.values.french.contentVersion).toBe(2)
    expect(alias.values.shared.contentVersion).toBe(3)
    expect(saved.listing.version).toBe(10)
    expect(otherAccount.listing.version).toBe(10)
    expect(saved.values.name.contentVersion).toBe(4)
    expect(otherAccount.values.name.contentVersion).toBe(4)
    // The next pin save on the alias is proved by the adopted pair, with its own listing owner.
    const proof = contentWriteProof(alias, [alias.values.name], 'channelListing', alias.listing.version)
    expect(proof).toMatchObject({ ok: true, proof: { expectedVersion: 11 } })
  })

  it('keeps an unseen external Name B stale when a shared formula later advances its follower pin', () => {
    const row = snapshot('listing-primary')
    preserveContentVersions(undefined, row)
    // External Name B owns 11/5. This operation only changed shared data, then the follower became 12/6.
    expect(adoptContentVersions(row, { contentVersionReceipts: [pinReceipt('listing-primary', 11, 5, 12, 6)] })).toEqual([])
    expect(row.listing.version).toBe(10)
    expect(row.values.name).toMatchObject({ value: 'Name A', contentVersion: 4 })
    expect(contentWriteProof(row, [row.values.name], 'channelListing', row.listing.version)).toMatchObject({ ok: true, proof: { expectedVersion: 10 } })
  })

  it('does not treat a diagnostic owner version as a confirmed before pair', () => {
    const row = snapshot('listing-primary')
    preserveContentVersions(undefined, row)
    row.listing.version = 11 // A 409 can report the owner without confirming its unseen content.
    expect(adoptContentVersions(row, { contentVersionReceipts: [pinReceipt('listing-primary', 11, 4, 12, 5)] })).toEqual([])
    expect(row.listing.version).toBe(11)
    expect(row.values.name.contentVersion).toBe(4)
  })

  it('does not let a fresh sibling launder an older busy cell\'s confirmation through a row copy', () => {
    const old = snapshot('listing-primary')
    preserveContentVersions(undefined, old)
    const fresh = snapshot('listing-primary', 11, 5)
    fresh.values.name.value = 'Name B'
    preserveContentVersions(undefined, fresh)
    // A quiet read kept the operator's busy old Name but accepted a fresh Description on the same content row.
    const mixed = { ...fresh, values: { ...fresh.values, name: { ...old.values.name }, description: { ...fresh.values.name, value: 'Fresh description' } } }
    const copy = { ...mixed, values: { ...mixed.values, name: { ...mixed.values.name } } }
    preserveContentVersions(mixed, copy)
    expect(copy.values.name).toMatchObject({ value: 'Name A', contentVersion: 4 })
    expect(copy.values.description.contentVersion).toBe(5)
    adoptContentVersions(copy, { contentVersionReceipts: [pinReceipt('listing-primary', 11, 5, 12, 6)] })
    expect(copy.values.name).toMatchObject({ value: 'Name A', contentVersion: 4 })
    expect(copy.values.description.contentVersion).toBe(6)
  })

  it('does not let a legacy entry bypass a qualified receipt that failed its before check', () => {
    const row = snapshot('listing-primary')
    preserveContentVersions(undefined, row)
    const body = { updated: 1, currentVersion: 12, versionOf: 'channelListing',
      contentVersions: [{ id: row.id, tier: 'pin', language: 'de', version: 6 }],
      contentVersionReceipts: [pinReceipt('listing-primary', 11, 5, 12, 6)] }
    expect(adoptContentVersions(row, body)).toEqual([])
    expect(row.listing.version).toBe(10)
    expect(row.values.name.contentVersion).toBe(4)
  })

  it('accepts a recreated translation from its matched pair and ignores a late older receipt', () => {
    const row = snapshot('listing-primary')
    preserveContentVersions(undefined, row)
    expect(adoptContentVersions(row, { contentVersionReceipts: [pinReceipt('listing-primary', 10, 4, 12, 1)] })).toEqual(['name'])
    expect(row.listing.version).toBe(12)
    expect(row.values.name.contentVersion).toBe(1)
    expect(adoptContentVersions(row, { contentVersionReceipts: [pinReceipt('listing-primary', 9, 3, 10, 4)] })).toEqual([])
    // The same receipt answered twice (a late duplicate) changes nothing either.
    expect(adoptContentVersions(row, { contentVersionReceipts: [pinReceipt('listing-primary', 10, 4, 12, 1)] })).toEqual([])
    expect(row.listing.version).toBe(12)
    expect(row.values.name.contentVersion).toBe(1)
  })

  it('adopts shared language receipts across aliases without borrowing listing versions', () => {
    const primary = snapshot('listing-primary'), alias = snapshot('listing-alias'), otherProduct = { ...snapshot('listing-other'), id: 'product-b' }
    for (const row of [primary, alias, otherProduct]) preserveContentVersions(undefined, row)
    const body = { currentVersion: 11, versionOf: 'channelListing', contentVersionReceipts: [{
      productId: 'product-a', tier: 'language', language: 'de',
      before: { ownerVersion: 30, contentVersion: 3 }, after: { ownerVersion: 32, contentVersion: 4 },
    }] }
    expect(adoptContentVersions(primary, body, [alias, otherProduct])).toEqual(['shared'])
    expect(primary.version).toBe(32)
    expect(alias.version).toBe(32)
    expect(primary.values.shared.contentVersion).toBe(4)
    expect(alias.values.shared.contentVersion).toBe(4)
    expect(otherProduct.version).toBe(30)
    expect(otherProduct.values.shared.contentVersion).toBe(3)
    expect(primary.listing.version).toBe(10)
  })
})

describe('the own fact that fed a German formula', () => {
  const master = () => ({ id: 'product-a', version: 10, values: {
    name: { value: 'German name', contentAddress: { tier: 'language', language: 'de' }, contentVersion: 4 },
    description: { value: 'Old description', contentAddress: { tier: 'language', language: 'de' }, contentVersion: 4 },
    french: { value: 'French name', contentAddress: { tier: 'language', language: 'fr' }, contentVersion: 2 },
    brand: { value: 'Brand' },
  } as Record<string, { value: string; contentAddress?: { tier: string; language: string }; contentVersion?: number }> })

  it('adopts the German pair from the caller\'s own token; untouched languages keep their counter under the new owner', () => {
    const row = master()
    const selection = contentWriteProof(row, [row.values.brand], 'product', 10)
    expect(selection.ok).toBe(true)
    const body = { updated: 1, currentVersion: 12, versionOf: 'product', contentVersionReceipts: [{ productId: 'product-a', tier: 'language', language: 'de',
      before: { ownerVersion: 10, contentVersion: 4 }, after: { ownerVersion: 12, contentVersion: 5 } }] }
    expect(adoptContentVersions(row, body, [], selection.ok ? selection.proof : undefined).sort()).toEqual(['description', 'name'])
    const next = contentWriteProof(row, [row.values.name], 'product', 12)
    expect(next).toMatchObject({ ok: true, proof: { expectedVersion: 12 } })
    expect(row.values.name.contentVersion).toBe(5)
    expect(contentWriteProof(row, [row.values.french], 'product', 12)).toMatchObject({ ok: true, proof: { expectedVersion: 12 } })
    expect(row.values.french.contentVersion).toBe(2)
  })

  it('without a receipt the German cells keep their old counter, so a save refuses until a read (the earlier behaviour)', () => {
    const row = master()
    const selection = contentWriteProof(row, [row.values.brand], 'product', 10)
    adoptContentVersions(row, { updated: 1, currentVersion: 12, versionOf: 'product' }, [], selection.ok ? selection.proof : undefined)
    expect(row.values.name.contentVersion).toBe(4)
  })
})

describe('a receipt list that cannot be trusted adopts nothing', () => {
  const valid = () => pinReceipt('listing-primary')
  it.each([
    ['not a list', { versions: 'nope' }],
    ['a missing listing', { ...valid(), listingId: undefined }],
    ['an unknown tier', { ...valid(), tier: 'source' }],
    ['a negative counter', { ...valid(), before: { ownerVersion: -1, contentVersion: 4 } }],
    ['a fractional counter', { ...valid(), after: { ownerVersion: 11.5, contentVersion: 5 } }],
    ['an owner that did not move', { ...valid(), after: { ownerVersion: 10, contentVersion: 5 } }],
    ['a missing language', { ...valid(), language: '' }],
  ])('%s: no receipt, no legacy entry and no owner advance', (_label, bad) => {
    const row = snapshot('listing-primary')
    preserveContentVersions(undefined, row)
    const selection = contentWriteProof(row, [row.values.name], 'channelListing', 10)
    const body = { updated: 1, currentVersion: 11, versionOf: 'channelListing', contentVersions: [{ id: row.id, tier: 'pin', language: 'de', version: 5 }],
      contentVersionReceipts: Array.isArray((bad as { versions?: unknown }).versions) || 'versions' in (bad as object) ? (bad as { versions: unknown }).versions : [valid(), bad] }
    expect(adoptContentVersions(row, body, [], selection.ok ? selection.proof : undefined)).toEqual([])
    expect(row.values.name.contentVersion).toBe(4)
    expect(row.values.french.contentVersion).toBe(2)
    expect(contentWriteProof(row, [row.values.french], 'channelListing', 11)).toMatchObject({ ok: true, proof: { expectedVersion: 10 } })
  })

  it('two different receipts for one content row adopt neither, and keep the legacy entry out', () => {
    const row = snapshot('listing-primary')
    preserveContentVersions(undefined, row)
    const body = { contentVersions: [{ id: row.id, tier: 'pin', language: 'de', version: 5 }],
      contentVersionReceipts: [pinReceipt('listing-primary'), pinReceipt('listing-primary', 10, 4, 12, 6)] }
    expect(adoptContentVersions(row, body)).toEqual([])
    expect(row.values.name.contentVersion).toBe(4)
  })
})
