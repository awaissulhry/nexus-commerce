/**
 * Qualified content receipts (product sheet, 2026-10-01) — the pure part.
 *
 * A content row's write token is a PAIR: its owner's version (Product for shared language text, the exact
 * ChannelListing for a pin) and the content row's own version (0 = no row). A save can move content rows the operator
 * did not edit: a fact feeds a German formula, a shared write cascades to the listings that follow it. The legacy
 * `contentVersions` answer cannot describe those safely, so the sheet re-read before it could save there again.
 *
 * A receipt names one content row exactly (product + language, or product + physical listing + language), the pair it
 * held BEFORE this unit's first write to it, and the pair it holds at the END of the operation. A reader may adopt the
 * `after` pair only for a cell whose own confirmed pair equals `before`: everything between the two was this
 * operation's own work. A cell that saw an older state (someone else's Name B in between) stays stale and refuses.
 *
 * This module only keeps that evidence. It grants no compare-and-swap, infers no owner, reads no database: the
 * canonical writers supply each actual write and its before pair, and the operation supplies the final pairs it read
 * inside its own Serializable transaction (`content-version-receipt-capture.ts`).
 */
export interface ContentPair { ownerVersion: number; contentVersion: number }
export type ContentIdentity =
  | { tier: 'language'; productId: string; language: string }
  | { tier: 'pin'; productId: string; listingId: string; language: string }
export type ContentVersionReceipt = ContentIdentity & { before: ContentPair; after: ContentPair }
/** The row whose version is a content identity's owner version. */
export type ContentOwner = { kind: 'product' | 'listing'; id: string }

const counter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0

function checkedPair(pair: ContentPair, what: string): ContentPair {
  if (!pair || !counter(pair.ownerVersion) || !counter(pair.contentVersion)) throw new Error(`A content receipt's ${what} pair needs whole, non-negative versions.`)
  return Object.freeze({ ownerVersion: pair.ownerVersion, contentVersion: pair.contentVersion })
}

function checkedIdentity(identity: ContentIdentity): ContentIdentity {
  if (identity?.tier === 'language' && text(identity.productId) && text(identity.language)) {
    return Object.freeze({ tier: 'language', productId: identity.productId, language: identity.language })
  }
  if (identity?.tier === 'pin' && text(identity.productId) && text(identity.listingId) && text(identity.language)) {
    return Object.freeze({ tier: 'pin', productId: identity.productId, listingId: identity.listingId, language: identity.language })
  }
  throw new Error('A content receipt needs an exact product and language, and for a pin its listing.')
}

/** One key per exact identity, from a tuple: no two different identities share one, whatever their text holds. */
export const contentIdentityKey = (identity: ContentIdentity): string => JSON.stringify(identity.tier === 'language'
  ? ['language', identity.productId, identity.language] : ['pin', identity.productId, identity.listingId, identity.language])
export const contentOwnerOf = (identity: ContentIdentity): ContentOwner =>
  identity.tier === 'language' ? { kind: 'product', id: identity.productId } : { kind: 'listing', id: identity.listingId }
const ownerKey = (owner: ContentOwner) => JSON.stringify([owner.kind, owner.id])

type Entry = { identity: ContentIdentity; before: ContentPair }

/**
 * The content rows one unit attempt actually wrote, each with the pair it held before the unit's first write. Built
 * inside the attempt; a nested write gets a `fork()` that joins its parent only when it succeeded (`merge()`), or
 * contributes nothing (`discard()`). A new attempt builds a new ledger.
 */
export class ContentReceiptLedger {
  private readonly entries = new Map<string, Entry>()
  private readonly ownerStarts = new Map<string, number>()
  private finished = false
  private parent: ContentReceiptLedger | null = null

  get isEmpty(): boolean { return this.entries.size === 0 }

  private open(): void {
    if (this.finished) throw new Error('This content receipt ledger is finished; a new write needs a new ledger.')
  }

  /** An actual, successful write of `identity`; `before` is the pair it held just before that write. The first write wins. */
  wrote(identity: ContentIdentity, before: ContentPair): void {
    this.open()
    const exact = checkedIdentity(identity), pair = checkedPair(before, 'before')
    const key = contentIdentityKey(exact)
    if (!this.entries.has(key)) this.entries.set(key, { identity: exact, before: pair })
  }

  /**
   * The unit's own compare-and-swap on the CALLER's token for `owner` passed: the owner held `version` when the unit
   * began. A version is never produced outside its transaction before commit, so a caller's token cannot name one this
   * unit made. Its receipts on that owner then start from `version` (a fact the unit wrote first moved the owner before
   * a formula wrote the content row). Two different proofs for one owner cannot both hold.
   */
  ownerVerifiedAt(owner: ContentOwner, version: number): void {
    this.open()
    if ((owner?.kind !== 'product' && owner?.kind !== 'listing') || !text(owner.id) || !counter(version)) throw new Error('An owner proof needs an exact owner and a whole version.')
    const key = ownerKey(owner), known = this.ownerStarts.get(key)
    if (known !== undefined && known !== version) throw new Error('Two different owner versions were proved for one owner in one unit.')
    this.ownerStarts.set(key, version)
  }

  /** A ledger for a nested write inside this one. */
  fork(): ContentReceiptLedger {
    this.open()
    const child = new ContentReceiptLedger()
    child.parent = this
    return child
  }

  /** The nested write succeeded: its writes join its parent (the parent's own earlier write of an identity wins). */
  merge(): void {
    this.open()
    if (!this.parent) throw new Error('Only a nested ledger merges into its parent.')
    for (const [owner, version] of this.ownerStarts) {
      const [kind, id] = JSON.parse(owner) as [ContentOwner['kind'], string]
      this.parent.ownerVerifiedAt({ kind, id }, version)
    }
    for (const [key, entry] of this.entries) if (!this.parent.entries.has(key)) this.parent.entries.set(key, entry)
    this.finished = true
  }

  /** The nested write failed: nothing of it counts. */
  discard(): void {
    this.open()
    this.finished = true
  }

  /** The identities whose final pairs the operation must read. */
  identities(): ContentIdentity[] {
    return [...this.entries.values()].map(entry => ({ ...entry.identity }))
  }

  /**
   * Each receipt with the final pair `finalOf` read for it. Both after counters come from that one final pair; a missing
   * one is refused rather than filled from an earlier write.
   */
  receipts(finalOf: (identity: ContentIdentity) => ContentPair | undefined): ContentVersionReceipt[] {
    return [...this.entries.values()].map(({ identity, before }) => {
      const found = finalOf({ ...identity })
      if (!found) throw new Error('A written content row is missing from the final version read.')
      const after = checkedPair(found, 'final')
      // Only an owner start at or below what the write itself saw can be the same owner earlier in this unit.
      const start = this.ownerStarts.get(ownerKey(contentOwnerOf(identity)))
      const from = start !== undefined && start <= before.ownerVersion ? { ownerVersion: start, contentVersion: before.contentVersion } : before
      if (after.ownerVersion < from.ownerVersion) throw new Error('A content row\'s owner version went back inside one operation.')
      return { ...identity, before: { ...from }, after: { ...after } }
    })
  }
}
