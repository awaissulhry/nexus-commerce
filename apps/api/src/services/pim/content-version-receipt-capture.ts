/**
 * Qualified content receipts (product sheet, 2026-10-01) — where the canonical writers report their writes, and where an
 * operation reads the final pairs. The evidence itself is `content-version-receipts.ts`.
 *
 * A sheet operation (`bulk-save.service.ts`) opens one ledger per unit, inside its transaction attempt. The canonical
 * content writers report each actual write with the pair it held just before (`recordContentWrite`): the sheet's own
 * content writes and a formula's (`content-bulk-write.ts`, which every content write of a unit passes through, the
 * formula's own write included), and the shared-text cascade to the listings that follow it (`master-content.service.ts`).
 * Outside an operation no ledger is open and reporting costs nothing.
 *
 * Ledgers are kept per transaction attempt, keyed by that attempt's own client: a restarted attempt has a new client and
 * never sees the ledgers of the attempt before it, and two requests never share one. A formula's write reaches the
 * writer through an internal request (`cell-formula.routes.ts`) that re-enters the SAME transaction, so its writes
 * reach the unit's ledger, through a fork that counts only if that write succeeded (`nestedContentReceipts`).
 */
import prisma from '../../db.js'
import { activeDatabaseTransaction } from '../../lib/database-context.js'
import { ContentReceiptLedger, contentIdentityKey, type ContentIdentity, type ContentOwner, type ContentPair } from './content-version-receipts.js'

const openLedgers = new WeakMap<object, ContentReceiptLedger[]>()

function currentLedger(): ContentReceiptLedger | undefined {
  const transaction = activeDatabaseTransaction()
  return transaction ? openLedgers.get(transaction)?.at(-1) : undefined
}

/** Run `work` with `ledger` collecting the content writes made inside it. Needs the operation's transaction. */
export async function collectContentReceipts<T>(ledger: ContentReceiptLedger, work: () => Promise<T>): Promise<T> {
  const transaction = activeDatabaseTransaction()
  if (!transaction) throw new Error('Content receipts are collected inside the operation\'s transaction.')
  const stack = openLedgers.get(transaction) ?? []
  openLedgers.set(transaction, stack)
  stack.push(ledger)
  try {
    return await work()
  } finally {
    const at = stack.lastIndexOf(ledger)
    if (at >= 0) stack.splice(at, 1)
  }
}

/** A nested write (a formula's own write inside a unit): its writes join the unit only if it succeeded. */
export async function nestedContentReceipts<T>(work: () => Promise<T>): Promise<T> {
  const parent = currentLedger()
  if (!parent) return work()
  const child = parent.fork()
  let value: T
  try {
    value = await collectContentReceipts(child, work)
  } catch (error) {
    child.discard()
    throw error
  }
  child.merge()
  return value
}

/** An actual, successful write of a content row, with the pair it held just before. Nothing when no operation collects. */
export function recordContentWrite(identity: ContentIdentity, before: ContentPair): void {
  currentLedger()?.wrote(identity, before)
}

/** This unit's compare-and-swap on the caller's own token for `owner` passed (see `ownerVerifiedAt`). */
export function recordOwnerProof(owner: ContentOwner, version: number): void {
  currentLedger()?.ownerVerifiedAt(owner, version)
}

/**
 * The final pair of every identity, read inside the operation's transaction after all of its writes: one read per table
 * it needs (owners by id; content rows by owner and language, never by an earlier row id, so a deleted and recreated
 * row is read as it is now). A missing content row is content 0; a missing owner has no final pair.
 */
export async function readFinalContentPairs(identities: ContentIdentity[]): Promise<(identity: ContentIdentity) => ContentPair | undefined> {
  const languages = identities.filter(identity => identity.tier === 'language')
  const pins = identities.filter((identity): identity is Extract<ContentIdentity, { tier: 'pin' }> => identity.tier === 'pin')
  const unique = (values: string[]) => [...new Set(values)]
  const productIds = unique(languages.map(identity => identity.productId)), listingIds = unique(pins.map(identity => identity.listingId))
  // One after another on the transaction's one connection, so a lost race surfaces as itself, not as a sibling's 25P02.
  const products = productIds.length ? await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, version: true } }) : []
  const productTexts = productIds.length ? await prisma.productTranslation.findMany({ where: { productId: { in: productIds }, language: { in: unique(languages.map(identity => identity.language)) } },
    select: { productId: true, language: true, version: true } }) : []
  const listings = listingIds.length ? await prisma.channelListing.findMany({ where: { id: { in: listingIds } }, select: { id: true, productId: true, version: true } }) : []
  const listingTexts = listingIds.length ? await prisma.channelListingTranslation.findMany({ where: { channelListingId: { in: listingIds }, language: { in: unique(pins.map(identity => identity.language)) } },
    select: { channelListingId: true, language: true, version: true } }) : []
  const owners = new Map<string, { productId?: string; version: number }>([...products.map(row => [`product:${row.id}`, { version: row.version }] as const),
    ...listings.map(row => [`listing:${row.id}`, { productId: row.productId, version: row.version }] as const)])
  const texts = new Map<string, number>([...productTexts.map(row => [JSON.stringify(['product', row.productId, row.language]), row.version] as const),
    ...listingTexts.map(row => [JSON.stringify(['listing', row.channelListingId, row.language]), row.version] as const)])
  const finals = new Map<string, ContentPair>()
  for (const identity of identities) {
    const owner = identity.tier === 'language' ? owners.get(`product:${identity.productId}`) : owners.get(`listing:${identity.listingId}`)
    // A pin's listing must still be this product's: the identity names both.
    if (!owner || (identity.tier === 'pin' && owner.productId !== identity.productId)) continue
    const text = identity.tier === 'language' ? texts.get(JSON.stringify(['product', identity.productId, identity.language]))
      : texts.get(JSON.stringify(['listing', identity.listingId, identity.language]))
    finals.set(contentIdentityKey(identity), { ownerVersion: owner.version, contentVersion: text ?? 0 })
  }
  return identity => finals.get(contentIdentityKey(identity))
}
