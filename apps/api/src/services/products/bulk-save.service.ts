/**
 * One sheet OPERATION — a fill, a paste, an undo — saved as ONE request and ONE transaction.
 *
 * Why this exists (measured 2026-09-29 on a 250-variation family, eBay · IT, "Description theme"): the sheet saved a
 * fill as one `PATCH /api/products/bulk` per row, all at once. Every one of those requests rebuilt the WHOLE family's
 * readiness inside its own Serializable transaction, so 250 requests rewrote the same 251 readiness rows at the same
 * time: 42 deadlocks (P2034), 56 aborted transactions (P2039 / 25P02), 85 pool timeouts (P2028), 163 client timeouts,
 * 26 confirmed saves — and 15 rows saved while the browser was told they failed.
 *
 * Here the same rows are ONE transaction:
 *   - each UNIT is exactly what one `PATCH /api/products/bulk` carried (its changes, its destination, its own version
 *     token), and runs through the SAME writer (`applyProductBulkEdits`) — no second implementation of a cell write;
 *   - independent platform values share the row writer's validation and one guarded set write; each unit keeps its
 *     original token and receipt. An unsupported or failed batch rolls back before the original units run separately;
 *   - other units run in their own SAVEPOINT (`inSavepoint`): a refused unit is undone alone and reported;
 *   - work the units share happens ONCE at commit: the family readiness rebuild (the producers are keyed by family)
 *     and the read-cache refresh (`afterDatabaseCommitBatch`);
 *   - a lost race with ANOTHER writer restarts the whole transaction (`inDatabaseTransaction`), never half of it.
 *
 * Each unit's answer is the status and body its own PATCH would have answered, so the sheet reads a unit exactly as it
 * reads the single-row route today: per-cell `errors[]`, `409` with `currentVersion` / `versionOf`, `createdListings`.
 * One difference, on purpose: a unit that failed unexpectedly answers 500 with `nothingSaved: true`, because its
 * savepoint was rolled back — the single-row route's 500 could not promise that, so the client had to guess.
 *
 * One addition: `contentVersionReceipts` (`pim/content-version-receipts.ts`) on a saved unit — every content row the
 * unit actually wrote, its own edits, its formulas' and the shared-text cascade's alike, with the owner/content pair
 * before the unit's first write and the pair at the END of the operation, read once for all units inside this
 * transaction after every unit ran. A refused unit has none; a restarted attempt starts with none.
 */
import prisma from '../../db.js'
import { inDatabaseTransaction, inSavepoint } from '../../lib/database-context.js'
import { applyProductBulkEdits, ProductBulkError, type ProductBulkContext, type ProductBulkInput } from './bulk-edit.service.js'
import { platformBatchGroup, UnsupportedPlatformBatch, writePlatformBatch } from './bulk-edit-platform-batch.js'
import { EbayFamilyClearOperation } from './ebay-family-clear.js'
import { ContentReceiptLedger } from '../pim/content-version-receipts.js'
import { collectContentReceipts, readFinalContentPairs } from '../pim/content-version-receipt-capture.js'

/** A 500-row fill of 2 languages is 1,000 units; anything far beyond a sheet's page is not a sheet operation. */
export const BULK_SAVE_MAX_UNITS = 2_000
export const BULK_SAVE_MAX_CHANGES = 10_000
/** One operation may hold many rows; the row writer's own 60 s bound was set for one row. */
const BULK_SAVE_TIMEOUT_MS = 120_000

export interface BulkSaveUnit extends ProductBulkInput {
  /** The client's name for this unit (row + destination); echoed back so the client needs no ordering contract. */
  key: string
}

export interface BulkSaveInput {
  /** The client's id for this operation (also its Idempotency-Key); echoed back. */
  operationId?: string
  units: BulkSaveUnit[]
}

export interface BulkSaveUnitResult {
  key: string
  /** What this unit's own `PATCH /api/products/bulk` would have answered. */
  status: number
  body: Record<string, unknown>
}

export interface BulkSaveResult {
  operationId: string | null
  /** Units that committed (their `body.errors` may still refuse single cells, exactly as a 200 PATCH can). */
  saved: number
  /** Units that were undone and answered with a refusal. */
  failed: number
  elapsedMs: number
  units: BulkSaveUnitResult[]
}

export class BulkSaveError extends Error {
  constructor(readonly statusCode: number, readonly details: Record<string, unknown>) {
    super(typeof details.error === 'string' ? details.error : 'Bulk save failed')
  }
}

/** Shape check only: every unit's CONTENT is judged by the row writer, which owns those rules. */
export function parseBulkSaveInput(body: unknown): BulkSaveInput {
  const input = body as { operationId?: unknown; units?: unknown } | null
  if (!input || typeof input !== 'object') throw new BulkSaveError(400, { error: 'Send { units: [...] }.' })
  if (input.operationId !== undefined && (typeof input.operationId !== 'string' || !input.operationId.trim() || input.operationId.length > 200)) {
    throw new BulkSaveError(400, { error: 'operationId must be a short non-empty string, or be omitted.' })
  }
  if (!Array.isArray(input.units) || input.units.length === 0) throw new BulkSaveError(400, { error: 'units must be a non-empty array.' })
  if (input.units.length > BULK_SAVE_MAX_UNITS) {
    throw new BulkSaveError(413, { error: `One save may hold at most ${BULK_SAVE_MAX_UNITS} rows; this one has ${input.units.length}.` })
  }
  const keys = new Set<string>()
  let changes = 0
  for (const [index, raw] of input.units.entries()) {
    const unit = raw as { key?: unknown; changes?: unknown } | null
    if (!unit || typeof unit !== 'object') throw new BulkSaveError(400, { error: `units[${index}] must be an object.` })
    if (typeof unit.key !== 'string' || !unit.key.trim()) throw new BulkSaveError(400, { error: `units[${index}].key must be a non-empty string.` })
    if (keys.has(unit.key)) throw new BulkSaveError(400, { error: `units[${index}].key "${unit.key}" is used twice.` })
    keys.add(unit.key)
    if (!Array.isArray(unit.changes) || unit.changes.length === 0) throw new BulkSaveError(400, { error: `units[${index}].changes must be a non-empty array.` })
    changes += unit.changes.length
  }
  if (changes > BULK_SAVE_MAX_CHANGES) {
    throw new BulkSaveError(413, { error: `One save may hold at most ${BULK_SAVE_MAX_CHANGES} cells; this one has ${changes}.` })
  }
  return { operationId: typeof input.operationId === 'string' ? input.operationId : undefined, units: input.units as BulkSaveUnit[] }
}

/**
 * A saved unit of facts only, guarded by the caller's token on the Product (`versionOf: 'product'` with the version read
 * back): the row writer's compare-and-swap passed at that token, so the Product held it when the unit began. A formula
 * the facts fed then wrote content after the fact had moved the Product; its receipts start from the caller's token.
 * A unit with content edits proves its own owners where it writes them (`content-bulk-write.ts`).
 */
function proveFactOwner(ledger: ContentReceiptLedger, unit: ProductBulkInput, body: Record<string, unknown>): void {
  const productId = unit.changes[0]?.id
  if (ledger.isEmpty || unit.expectedVersion === undefined || !productId || body.versionOf !== 'product' || typeof body.currentVersion !== 'number' || !((body.updated as number) > 0)) return
  if (unit.changes.some(change => change.id !== productId || change.contentAddress !== undefined)) return
  ledger.ownerVerifiedAt({ kind: 'product', id: productId }, unit.expectedVersion)
}

/** The error a unit answers when the writer failed in a way it did not name (logged with the unit's key). */
const UNEXPECTED = 'This row could not be saved. The other rows of this change were saved; try this row again.'

export async function applyProductBulkSave(input: BulkSaveInput, context: ProductBulkContext): Promise<BulkSaveResult> {
  const t0 = Date.now()
  const units = await inDatabaseTransaction(prisma, async () => {
    // Built inside the transaction: a restarted attempt starts from an empty list.
    const results: BulkSaveUnitResult[] = []
    const familyOperation = new EbayFamilyClearOperation()
    const replyOwners = new Map<string, string>()
    // Each saved unit's content writes (built inside this attempt, so a restarted attempt starts with none).
    const ledgers = new Map<BulkSaveUnitResult, ContentReceiptLedger>()
    for (let index = 0; index < input.units.length; index++) {
      // Once a family clear has moved sibling owners, later units need their original per-owner proof.
      // The no-clear path retains its existing independent set-write batch.
      const group = familyOperation.hasEffects ? [] : platformBatchGroup(input.units, index)
      if (group.length) {
        const batch = await inSavepoint(async () => {
          let prepared: BulkSaveUnitResult[] | undefined
          await applyProductBulkEdits({ ...group[0], expectedVersion: undefined, changes: group.flatMap(unit => unit.changes) },
            { ...context, contentPerRow: true, ifMatch: undefined, formulaWriteToken: undefined, formulaCascade: false }, async plan => {
              prepared = await writePlatformBatch(group, plan, context)
              return { success: true, updated: plan.changes.length }
            })
          if (!prepared) throw new UnsupportedPlatformBatch('The row writer did not prepare this group.')
          return prepared
        })
        if ('value' in batch) {
          results.push(...batch.value)
          index += group.length - 1
          continue
        }
        if (!(batch.error instanceof UnsupportedPlatformBatch) && !(batch.error instanceof ProductBulkError && batch.error.statusCode < 500)) {
          context.logger.warn({ err: batch.error }, '[products/bulk-save] batch rolled back; retrying its original units separately')
        }
        // Savepoint rollback restores reads and commit effects too. Preserve every original unit/token for fallback.
        // Do not retry an unsupported suffix on every row of the same group.
        for (const { key, ...unit } of group) results.push(await saveUnit(key, unit))
        index += group.length - 1
        continue
      }
      const { key, ...unit } = input.units[index]
      results.push(await saveUnit(key, unit))
    }
    async function saveUnit(key: string, unit: ProductBulkInput): Promise<BulkSaveUnitResult> {
      const pendingFamily = familyOperation.fork()
      // The unit's own ledger: kept only when its savepoint held, so a refused unit contributes nothing.
      const ledger = new ContentReceiptLedger()
      const outcome = await collectContentReceipts(ledger, () => inSavepoint(() => applyProductBulkEdits(unit, { ...context, contentPerRow: true, ifMatch: undefined, formulaWriteToken: undefined, formulaCascade: false,
        ebayFamilyOperation: pendingFamily })))
      if ('value' in outcome) {
        const result = { key, status: 200, body: outcome.value as Record<string, unknown> }
        if (!unit.dryRun) {
          familyOperation.commit(pendingFamily)
          if (pendingFamily.answerListingId) replyOwners.set(key, pendingFamily.answerListingId)
          proveFactOwner(ledger, unit, result.body)
          if (!ledger.isEmpty) ledgers.set(result, ledger)
        }
        return result
      }
      const error = outcome.error
      if (error instanceof ProductBulkError && error.statusCode < 500) {
        return { key, status: error.statusCode, body: error.details }
      }
      // Rolled back to its savepoint, so the client may say "not saved" (never "unknown"); the raw text stays in `detail`.
      context.logger.error({ err: error, unit: key }, '[products/bulk-save] a unit failed unexpectedly and was rolled back')
      const detail = error instanceof ProductBulkError ? String(error.details.message ?? error.message) : error instanceof Error ? error.message : String(error)
      return { key, status: 500, body: { error: UNEXPECTED, detail, nothingSaved: true } }
    }
    // After every unit, still inside the transaction: each receipt's final pair, one read per table for all units.
    if (ledgers.size) {
      const finalOf = await readFinalContentPairs([...ledgers.values()].flatMap(ledger => ledger.identities()))
      for (const [result, ledger] of ledgers) {
        // A receipt is never needed to save: one that cannot be completed is withheld (the sheet keeps its old pairs,
        // which refuse until it reads), never allowed to fail the operation.
        try { result.body.contentVersionReceipts = ledger.receipts(finalOf) }
        catch (error) { context.logger.warn({ err: error, unit: result.key }, '[products/bulk-save] content receipts withheld') }
      }
    }
    if (familyOperation.hasEffects) {
      const versions = new Map((await prisma.channelListing.findMany({ where: { id: { in: familyOperation.affectedListingIds() } }, select: { id: true, version: true } }))
        .map(row => [row.id, row.version]))
      for (const result of results) if (result.status === 200) {
        const owner = replyOwners.get(result.key), version = owner ? versions.get(owner) : undefined
        if (version !== undefined && result.body.versionOf === 'channelListing') result.body.currentVersion = version
        if (Array.isArray(result.body.familyListings)) result.body.familyListings = result.body.familyListings.map(row => {
          const receipt = row as { listingId: string; version: number }
          return versions.has(receipt.listingId) ? { ...receipt, version: versions.get(receipt.listingId) } : receipt
        })
      }
    }
    return results
  }, { timeoutMs: BULK_SAVE_TIMEOUT_MS, memoReads: true })
  const failed = units.filter(unit => unit.status >= 400).length
  return { operationId: input.operationId ?? null, saved: units.length - failed, failed, elapsedMs: Date.now() - t0, units }
}
