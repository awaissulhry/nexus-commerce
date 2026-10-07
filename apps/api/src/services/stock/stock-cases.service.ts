/**
 * Step 3 cases (Owner D2 = B) — sealed cases and loose units per location, and each SKU's case pack.
 *
 * `StockLevel.quantity` stays the UNIT total; `StockCaseCount.cases` = the sealed cases at that level; loose =
 * quantity − cases × unitsPerCase. The invariant cases × unitsPerCase ≤ quantity has no database CHECK (test and fresh
 * databases are built from schema.prisma, which carries none): it lives HERE, in the one keeper every stock path calls,
 * and in the pure rule `@nexus/shared/stock-cases` the screens share.
 *
 * This is the ONLY writer of `StockCaseCount` and `ProductPackage` (scripts/check-stock-writer-lock.mjs, `caseFiles`).
 * Case rows are written with the scalar `stockLevelId`, never a nested `stockLevel: { connect }`.
 *
 * STAGE 1 (the contract): the signatures below are FROZEN — other parts import them. `sealedByLevel` reads; the three
 * writers are built in Part A commit 2 and throw until then.
 */
import type { Prisma } from '@prisma/client'
import { sealedCases, type CasePackValues, type CaseProblemCode } from '@nexus/shared/stock-cases'
import type { AdjustReason } from './location-adjust.service.js'

/** A refusal from a case write. `SEALED_CASES` carries `detail: SealedCasesDetail[]` (the cases a case-size change would open). */
export class CaseCountError extends Error {
  constructor(readonly code: CaseProblemCode | 'SEALED_CASES', message: string, readonly detail?: unknown) {
    super(message)
    this.name = 'CaseCountError'
  }
}

/** One level whose sealed cases a case-size change would open (`CaseCountError('SEALED_CASES').detail` is a list of these). */
export interface SealedCasesDetail { productId: string; sku: string; locationCode: string; cases: number }

const NOT_BUILT = 'stock-cases.service: not built yet (Step 3 Part A commit 2)'

/**
 * THE invariant keeper. The caller already holds lockProductStock for every product named (all three callers do).
 * Reads the case rows of these levels with their product's unitsPerCase, applies casesAfterMove, writes only rows
 * that change. No case row or no case size → nothing to do.
 */
export async function keepCasesInTx(tx: Prisma.TransactionClient,
  levels: ReadonlyArray<{ stockLevelId: string; quantityAfter: number; casesChange?: number }>): Promise<Map<string, { before: number; after: number }>> {
  void tx
  if (levels.length === 0) return new Map()
  throw new Error(NOT_BUILT)
}

/** The stock editor's absolute sealed count at one location. Locks the product itself. A change writes a 0-unit
 *  StockMovement (the batch reason, referenceType 'CaseCount', notes "Sealed cases 4 → 3 · 12 / case") and
 *  publishes inventory.cases_changed. Equal → noop. */
export async function setCasesInTx(tx: Prisma.TransactionClient, a: { productId: string; locationId: string; cases: number; reason: AdjustReason; notes?: string; actor: string }): Promise<{ noop: boolean; before: number; after: number }> {
  void tx
  void a
  throw new Error(NOT_BUILT)
}

/** Case size, dims, weight, prep/label owner for 1..200 SKUs, absolute. Locks the products. Changing or clearing
 *  unitsPerCase while any level of that SKU holds sealed cases throws CaseCountError('SEALED_CASES', detail: [{productId,
 *  sku, locationCode, cases}]) unless openSealedCases — then those case rows are deleted (cases become loose, units
 *  unchanged, nothing is pushed). Audit: AuditLogService.writeMany (entityType 'ProductPackage', before/after).
 *  Publishes inventory.cases_changed (locationId null) per product changed. */
export async function setCasePacks(a: { productIds: string[]; values: CasePackValues; openSealedCases?: boolean; actor: string; userId?: string | null }): Promise<Array<{ productId: string; ok: boolean; noop?: boolean; opened?: Array<{ locationCode: string; cases: number }>; error?: string }>> {
  void a
  throw new Error(NOT_BUILT)
}

/** What `sealedByLevel` reads: the client or a transaction. */
type CaseReadDb = Pick<Prisma.TransactionClient, 'stockCaseCount' | 'productPackage'>

/** Readers: the sealed count each level shows (stored, clamped by units). */
export async function sealedByLevel(db: CaseReadDb, levels: ReadonlyArray<{ id: string; productId: string; quantity: number }>): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (levels.length === 0) return out
  const productIds = [...new Set(levels.map((level) => level.productId))]
  const [packs, counts] = await Promise.all([
    db.productPackage.findMany({ where: { productId: { in: productIds }, unitsPerCase: { not: null } }, select: { productId: true, unitsPerCase: true } }),
    db.stockCaseCount.findMany({ where: { stockLevelId: { in: levels.map((level) => level.id) } }, select: { stockLevelId: true, cases: true } }),
  ])
  const sizeOf = new Map(packs.map((pack) => [pack.productId, pack.unitsPerCase]))
  const storedOf = new Map(counts.map((row) => [row.stockLevelId, row.cases]))
  for (const level of levels) {
    out.set(level.id, sealedCases(storedOf.get(level.id) ?? 0, level.quantity, sizeOf.get(level.productId) ?? null))
  }
  return out
}
