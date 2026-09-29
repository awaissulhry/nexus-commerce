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
 *   - each unit runs in its own SAVEPOINT (`inSavepoint`): a unit that is refused (a stale version, an invalid value,
 *     a product this business cannot see) is undone alone and reported; every other unit stays saved;
 *   - work the units share happens ONCE at commit: the family readiness rebuild (the producers are keyed by family)
 *     and the read-cache refresh (`afterDatabaseCommitBatch`);
 *   - a lost race with ANOTHER writer restarts the whole transaction (`inDatabaseTransaction`), never half of it.
 *
 * Each unit's answer is the status and body its own PATCH would have answered, so the sheet reads a unit exactly as it
 * reads the single-row route today: per-cell `errors[]`, `409` with `currentVersion` / `versionOf`, `createdListings`.
 * One difference, on purpose: a unit that failed unexpectedly answers 500 with `nothingSaved: true`, because its
 * savepoint was rolled back — the single-row route's 500 could not promise that, so the client had to guess.
 */
import prisma from '../../db.js'
import { inDatabaseTransaction, inSavepoint } from '../../lib/database-context.js'
import { applyProductBulkEdits, ProductBulkError, type ProductBulkContext, type ProductBulkInput } from './bulk-edit.service.js'

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

/** The error a unit answers when the writer failed in a way it did not name (logged with the unit's key). */
const UNEXPECTED = 'This row could not be saved. The other rows of this change were saved; try this row again.'

export async function applyProductBulkSave(input: BulkSaveInput, context: ProductBulkContext): Promise<BulkSaveResult> {
  const t0 = Date.now()
  const units = await inDatabaseTransaction(prisma, async () => {
    // Built inside the transaction: a restarted attempt starts from an empty list.
    const results: BulkSaveUnitResult[] = []
    for (const { key, ...unit } of input.units) {
      const outcome = await inSavepoint(() => applyProductBulkEdits(unit, { ...context, contentPerRow: true, ifMatch: undefined, formulaWriteToken: undefined, formulaCascade: false }))
      if ('value' in outcome) {
        results.push({ key, status: 200, body: outcome.value as Record<string, unknown> })
        continue
      }
      const error = outcome.error
      if (error instanceof ProductBulkError && error.statusCode < 500) {
        results.push({ key, status: error.statusCode, body: error.details })
        continue
      }
      // Rolled back to its savepoint, so the client may say "not saved" (never "unknown"); the raw text stays in `detail`.
      context.logger.error({ err: error, unit: key }, '[products/bulk-save] a unit failed unexpectedly and was rolled back')
      const detail = error instanceof ProductBulkError ? String(error.details.message ?? error.message) : error instanceof Error ? error.message : String(error)
      results.push({ key, status: 500, body: { error: UNEXPECTED, detail, nothingSaved: true } })
    }
    return results
  }, { timeoutMs: BULK_SAVE_TIMEOUT_MS })
  const failed = units.filter(unit => unit.status >= 400).length
  return { operationId: input.operationId ?? null, saved: units.length - failed, failed, elapsedMs: Date.now() - t0, units }
}
