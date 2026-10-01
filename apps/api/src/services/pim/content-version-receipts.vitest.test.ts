import { describe, expect, it } from 'vitest'
import { ContentReceiptLedger, contentIdentityKey, type ContentIdentity, type ContentPair } from './content-version-receipts.js'

/**
 * Qualified content receipts, the pure part (product sheet, 2026-10-01): which content rows ONE unit of a sheet operation
 * actually wrote, the owner/content pair each held before that unit's first write, and the pair each holds at the end.
 * The database side (capture at the canonical writers, the final read inside the Serializable transaction) is proven in
 * content-version-receipts-capture.vitest.test.ts and the real-PostgreSQL suite.
 */
const german: ContentIdentity = { tier: 'language', productId: 'product-a', language: 'de' }
const pin = (listingId: string, language = 'de', productId = 'product-a'): ContentIdentity => ({ tier: 'pin', productId, listingId, language })
const pair = (ownerVersion: number, contentVersion: number): ContentPair => ({ ownerVersion, contentVersion })
const finals = (entries: Array<[ContentIdentity, ContentPair]>) => {
  const byKey = new Map(entries.map(([identity, final]) => [contentIdentityKey(identity), final]))
  return (identity: ContentIdentity) => byKey.get(contentIdentityKey(identity))
}

describe('a unit ledger', () => {
  it('keeps the pair before the unit\'s first write and reports the exact final pair', () => {
    const ledger = new ContentReceiptLedger()
    ledger.wrote(german, pair(10, 4))
    // A later formula on the same row: the pair before THAT write is not the unit's before.
    ledger.wrote(german, pair(11, 5))
    expect(ledger.receipts(finals([[german, pair(12, 6)]]))).toEqual([
      { tier: 'language', productId: 'product-a', language: 'de', before: pair(10, 4), after: pair(12, 6) },
    ])
  })

  it('keeps identities exact: product, listing (account and alias), language and tier never collide', () => {
    const ledger = new ContentReceiptLedger()
    const identities: ContentIdentity[] = [german, { ...german, language: 'fr' }, { ...german, productId: 'product-b' },
      pin('listing-primary'), pin('listing-alias'), pin('listing-primary', 'fr'), pin('listing-primary', 'de', 'product-b'),
      // Components that would collide if the key were joined with a delimiter.
      { tier: 'language', productId: 'a:b', language: 'c' }, { tier: 'language', productId: 'a', language: 'b:c' }]
    identities.forEach((identity, i) => ledger.wrote(identity, pair(i, i)))
    const receipts = ledger.receipts(identity => pair(100 + identities.findIndex(other => contentIdentityKey(other) === contentIdentityKey(identity)), 0))
    expect(receipts).toHaveLength(identities.length)
    receipts.forEach((receipt, i) => {
      expect(receipt).toEqual({ ...identities[i], before: pair(i, i), after: pair(100 + i, 0) })
    })
    expect(new Set(identities.map(contentIdentityKey)).size).toBe(identities.length)
  })

  it('never splices a final owner onto an earlier content counter: both after counters come from the one final pair', () => {
    const ledger = new ContentReceiptLedger()
    ledger.wrote(pin('listing-primary'), pair(7, 2))
    // The owner moved again after the content write (a later fact on the listing): the final pair carries both.
    expect(ledger.receipts(finals([[pin('listing-primary'), pair(9, 3)]]))[0].after).toEqual(pair(9, 3))
    // Only what the final read supplies; nothing is guessed from the earlier write.
    expect(ledger.receipts(finals([[pin('listing-primary'), pair(9, 2)]]))[0].after).toEqual(pair(9, 2))
  })

  it('accepts a lower or recreated content counter under its newer owner, and a final absence as content 0', () => {
    const ledger = new ContentReceiptLedger()
    ledger.wrote(german, pair(10, 4))
    ledger.wrote(pin('listing-primary'), pair(3, 0))
    const receipts = ledger.receipts(finals([[german, pair(13, 1)], [pin('listing-primary'), pair(5, 0)]]))
    expect(receipts.map(receipt => receipt.after)).toEqual([pair(13, 1), pair(5, 0)])
    expect(receipts[1].before).toEqual(pair(3, 0))
  })

  it('refuses a missing final pair instead of reusing a write result', () => {
    const ledger = new ContentReceiptLedger()
    ledger.wrote(german, pair(10, 4))
    ledger.wrote(pin('listing-primary'), pair(3, 1))
    expect(() => ledger.receipts(finals([[german, pair(11, 5)]]))).toThrow(/final/)
  })

  it('refuses an owner that went back, and counters that are not whole numbers', () => {
    const ledger = new ContentReceiptLedger()
    ledger.wrote(german, pair(10, 4))
    expect(() => ledger.receipts(finals([[german, pair(9, 5)]]))).toThrow(/owner/)
    for (const bad of [pair(-1, 0), pair(1.5, 0), pair(0, Number.NaN), { ownerVersion: '1', contentVersion: 0 } as unknown as ContentPair]) {
      expect(() => new ContentReceiptLedger().wrote(german, bad)).toThrow()
      expect(() => ledger.receipts(finals([[german, bad]]))).toThrow()
    }
    for (const identity of [{ ...german, productId: '' }, { ...german, language: '' }, { ...pin('x'), listingId: '' }, { tier: 'source', productId: 'a', language: 'it' }]) {
      expect(() => new ContentReceiptLedger().wrote(identity as ContentIdentity, pair(1, 1))).toThrow()
    }
  })

  it('uses the owner version the unit\'s own compare-and-swap proved at its start, never a later or invented one', () => {
    const ledger = new ContentReceiptLedger()
    // Own fact write 10 → 11, then a formula wrote the German row: the write saw owner 11.
    ledger.wrote(german, pair(11, 4))
    ledger.ownerVerifiedAt({ kind: 'product', id: 'product-a' }, 10)
    // Another owner proof does not move a listing's receipt, and a proof above the observed owner is ignored.
    ledger.wrote(pin('listing-primary'), pair(5, 2))
    ledger.ownerVerifiedAt({ kind: 'listing', id: 'listing-other' }, 1)
    ledger.wrote(pin('listing-late'), pair(5, 2))
    ledger.ownerVerifiedAt({ kind: 'listing', id: 'listing-late' }, 6)
    const receipts = ledger.receipts(identity => identity.tier === 'language' ? pair(12, 5) : pair(7, 3))
    expect(receipts.map(receipt => receipt.before)).toEqual([pair(10, 4), pair(5, 2), pair(5, 2)])
    // Two different proofs for one owner in one unit cannot both be true.
    expect(() => ledger.ownerVerifiedAt({ kind: 'product', id: 'product-a' }, 9)).toThrow(/owner/)
    ledger.ownerVerifiedAt({ kind: 'product', id: 'product-a' }, 10)
  })

  it('a nested write merges into its own parent only when it succeeded; a discarded one contributes nothing', () => {
    const unit = new ContentReceiptLedger()
    const failed = unit.fork()
    failed.wrote(pin('listing-primary'), pair(3, 1))
    failed.ownerVerifiedAt({ kind: 'listing', id: 'listing-primary' }, 3)
    failed.discard()
    const succeeded = unit.fork()
    succeeded.wrote(german, pair(10, 4))
    const grandchild = succeeded.fork()
    grandchild.wrote({ ...german, language: 'fr' }, pair(11, 2))
    grandchild.merge()
    succeeded.merge()
    expect(unit.identities()).toEqual([german, { ...german, language: 'fr' }])
    // An earlier parent write keeps its before pair over a later nested one.
    const parent = new ContentReceiptLedger()
    parent.wrote(german, pair(10, 4))
    const later = parent.fork()
    later.wrote(german, pair(11, 5))
    later.merge()
    expect(parent.receipts(() => pair(12, 6))[0].before).toEqual(pair(10, 4))
    // A finished ledger cannot be written, merged or discarded again.
    expect(() => failed.wrote(german, pair(1, 1))).toThrow(/finished/)
    expect(() => succeeded.merge()).toThrow(/finished/)
    expect(() => later.discard()).toThrow(/finished/)
  })

  it('a unit that failed, or a new attempt, starts empty: separate ledgers never share a before pair', () => {
    const first = new ContentReceiptLedger(), second = new ContentReceiptLedger()
    first.wrote(german, pair(10, 4))
    second.wrote(german, pair(12, 5))
    const after = () => pair(14, 6)
    expect(first.receipts(after)[0]).toMatchObject({ before: pair(10, 4), after: pair(14, 6) })
    expect(second.receipts(after)[0]).toMatchObject({ before: pair(12, 5), after: pair(14, 6) })
    const retry = new ContentReceiptLedger()
    expect(retry.isEmpty).toBe(true)
    expect(retry.identities()).toEqual([])
    expect(retry.receipts(() => { throw new Error('an empty ledger reads nothing') })).toEqual([])
  })

  it('keeps its evidence immutable: caller objects and returned receipts cannot change it', () => {
    const ledger = new ContentReceiptLedger()
    const identity = { ...german }, before = pair(10, 4)
    ledger.wrote(identity, before)
    identity.productId = 'changed'
    before.ownerVersion = 99
    const [receipt] = ledger.receipts(() => pair(11, 5))
    receipt.before.ownerVersion = 1
    receipt.productId = 'changed again'
    const listed = ledger.identities()
    ;(listed[0] as { language: string }).language = 'xx'
    const final = pair(11, 5)
    const [again] = ledger.receipts(() => final)
    final.contentVersion = 77
    expect(again).toEqual({ tier: 'language', productId: 'product-a', language: 'de', before: pair(10, 4), after: pair(11, 5) })
    expect(ledger.identities()).toEqual([german])
  })
})
