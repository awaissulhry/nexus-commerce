/**
 * CM-33 / CC-24 — one create of the same thing at a time, across every API replica.
 *
 * The create dedupe (`createKeywordLocal` "is this keyword already here?", `createTargetLocal`, the product-ad lookup)
 * was a plain `findFirst` followed by the Amazon call: two adds of the same keyword at the same moment — two tabs, the
 * Add modal sending a keyword listed twice, a person and the harvest engine — both found nothing, both sent it, and
 * Amazon refused the second as a duplicate. Campaign names had no check at all.
 *
 * `withCreateClaim(identity, work, onBusy)` makes the check-then-create one step: the claim is a row in the durable
 * command-receipt table (`CommandReceipt`, the table that already makes an Idempotency-Key one run across replicas),
 * whose unique key admits one holder per business. A second create of the same identity waits for the first to finish
 * and then runs its own dedupe, which now sees the first one's row ("already there"). It never holds a database
 * transaction across the Amazon call (the reason `claimEntityWrite` settled on a short lock + token); the row IS the
 * token. A holder that died lets go when its claim expires; the data-retention sweep removes expired receipts.
 *
 * Fails open, like `claimEntityWrite`: if the claim cannot be written the create runs as it did before, because a create
 * blocked by failed bookkeeping would be neither visible nor retryable.
 */
import { createHash, randomUUID } from 'node:crypto'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

const SCOPE = 'ads-create-claim'
/** Longer than any create with its read-backs; a holder that died lets go after this. */
const HOLD_MS = 5 * 60_000
/** How long a second create of the same thing waits for the first before giving up. */
const WAIT_MS = 30_000
const POLL_MS = 250

let sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
/** Test seam: the wait between two looks at a held claim. */
export function setCreateClaimSleepForTests(fn: ((ms: number) => Promise<void>) | null): void {
  sleep = fn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

/** The identity of a create: what makes two of them the same thing on Amazon. Case and outer spaces do not count. */
export function createIdentity(kind: string, ...parts: Array<string | null | undefined>): string {
  return [kind, ...parts.map((p) => String(p ?? '').trim().toLowerCase())].join('|')
}

/** Run `work` as the only create of `identity` in this business right now; `onBusy` when another holds it too long. */
export async function withCreateClaim<T>(identity: string, work: () => Promise<T>, onBusy: () => T | Promise<T>): Promise<T> {
  const keyHash = sha256(identity)
  const deadline = Date.now() + WAIT_MS
  for (;;) {
    const id = randomUUID()
    let claimed: boolean
    try {
      const made = await prisma.commandReceipt.createMany({
        data: [{ id, scope: SCOPE, keyHash, requestHash: keyHash, actorUserId: null, expiresAt: new Date(Date.now() + HOLD_MS) }],
        skipDuplicates: true,
      })
      claimed = made.count === 1
      // A holder that died: its claim has expired, so it is taken away and the next round claims it.
      if (!claimed) await prisma.commandReceipt.deleteMany({ where: { scope: SCOPE, keyHash, expiresAt: { lte: new Date() } } })
    } catch (error) {
      logger.warn('[CM-33] create claim unavailable — creating unserialised', { error: error instanceof Error ? error.message : String(error) })
      return work()
    }
    if (claimed) {
      try {
        return await work()
      } finally {
        await prisma.commandReceipt.deleteMany({ where: { id } }).catch((error: unknown) => {
          logger.warn('[CM-33] create claim not released — it lapses on its own', { error: error instanceof Error ? error.message : String(error) })
        })
      }
    }
    if (Date.now() >= deadline) return onBusy()
    await sleep(POLL_MS)
  }
}
