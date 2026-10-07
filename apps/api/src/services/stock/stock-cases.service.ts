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
 * Who calls what:
 *   keepCasesInTx — every unit movement (stock-movement.service.ts), the bulk stock import (stock-import.service.ts) and
 *                   the shared-stock door settle (stock-pool/pool-tasks.ts). The caller already holds the product lock.
 *                   A sale takes loose units first, then opens a case: after a decrease the count is clamped to
 *                   floor(units / unitsPerCase). Whole cases moved (Step 4) pass `casesChange`.
 *   setCasesInTx  — the stock editor's absolute count at one location (Part B, `adjustOneLocation`).
 *   setCasePacks  — the Matrix Case pop-up (Part B, `PUT /api/stock/case-packs`).
 *   setFbaOwnersIfUnset — Step 4 Send to FBA: the dialog's "Prep by / Labels by" for SKUs that had none (owners only).
 *   sealedByLevel — the readers.
 *
 * The signatures are FROZEN (Step 3 Part A stage 1): Part B imports them.
 */
import type { Prisma } from '@prisma/client'
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../db.js'
import { lockProductStock } from '../stock-lock.js'
import { publishEvent } from '../../lib/events/publish.js'
import { auditLogService, type AuditWriteInput } from '../audit-log.service.js'
import {
  CASE_COPY, caseCountProblem, casesAfterMove, isCaseOwner, packProblem, sealedCases,
  type CaseOwner, type CasePackValues, type CaseProblemCode,
} from '@nexus/shared/stock-cases'
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

/** The most SKUs one case-pack save may change (the Matrix family pop-up; the route checks it too). */
const MAX_PACK_PRODUCTS = 200

/**
 * THE invariant keeper. The caller already holds lockProductStock for every product named (all three callers do).
 * Reads the case rows of these levels with their product's unitsPerCase, applies casesAfterMove, writes only rows
 * that change. No case row or no case size → nothing to do.
 *
 * The answer has one entry per level that holds a case count (before → after; equal when no case opened).
 * Refusals (only with `casesChange`, whole cases moved): `NOT_A_WAREHOUSE`, `NO_CASE_SIZE`, `INVALID_CASES` (more
 * cases leave than are sealed, or not a whole number), `CASES_EXCEED_UNITS` — thrown as CaseCountError, so the
 * caller's transaction (the movement itself) rolls back.
 *
 * Cost on the hot path (every sale): one indexed read of StockCaseCount; nothing more when the level has no row.
 */
export async function keepCasesInTx(tx: Prisma.TransactionClient,
  levels: ReadonlyArray<{ stockLevelId: string; quantityAfter: number; casesChange?: number }>): Promise<Map<string, { before: number; after: number }>> {
  const out = new Map<string, { before: number; after: number }>()
  if (levels.length === 0) return out
  const moves = (level: { casesChange?: number }) => level.casesChange !== undefined && level.casesChange !== 0
  const ids = [...new Set(levels.map((level) => level.stockLevelId))]
  const rows = await tx.stockCaseCount.findMany({ where: { stockLevelId: { in: ids } }, select: { id: true, stockLevelId: true, cases: true } })
  const explicit = levels.some(moves)
  if (rows.length === 0 && !explicit) return out

  // Only the levels that matter: those with a row, and (whole cases moved) those named with casesChange.
  const wanted = [...new Set([...rows.map((row) => row.stockLevelId), ...levels.filter(moves).map((level) => level.stockLevelId)])]
  const levelRows = await tx.stockLevel.findMany({ where: { id: { in: wanted } }, select: { id: true, productId: true, location: { select: { type: true } } } })
  const levelOf = new Map(levelRows.map((level) => [level.id, level]))
  const packs = await tx.productPackage.findMany({
    where: { productId: { in: [...new Set(levelRows.map((level) => level.productId))] }, unitsPerCase: { not: null } },
    select: { productId: true, unitsPerCase: true },
  })
  const sizeOf = new Map(packs.map((pack) => [pack.productId, pack.unitsPerCase]))
  const stored = new Map(rows.map((row) => [row.stockLevelId, { id: row.id, cases: row.cases }]))

  for (const level of levels) {
    const row = stored.get(level.stockLevelId)
    const moved = moves(level)
    if (!row && !moved) continue
    const info = levelOf.get(level.stockLevelId)
    if (!info) continue // the level is gone with its rows (ON DELETE CASCADE)
    if (moved && info.location.type !== 'WAREHOUSE') throw new CaseCountError('NOT_A_WAREHOUSE', CASE_COPY.notHere)
    const size = sizeOf.get(info.productId) ?? null
    if (size === null) {
      if (moved) throw new CaseCountError('NO_CASE_SIZE', CASE_COPY.noSize)
      continue // no case size: the count means nothing (setCasePacks removes rows when the size changes)
    }
    const before = row?.cases ?? 0
    const next = casesAfterMove({ cases: before, quantityAfter: level.quantityAfter, unitsPerCase: size, casesChange: moved ? level.casesChange : undefined })
    if ('refused' in next) throw new CaseCountError(next.refused.code, next.refused.message)
    if (next.cases !== before) {
      if (row) {
        await tx.stockCaseCount.update({ where: { id: row.id }, data: { cases: next.cases } })
        row.cases = next.cases
      } else {
        const created = await tx.stockCaseCount.create({ data: { stockLevelId: level.stockLevelId, cases: next.cases }, select: { id: true } })
        stored.set(level.stockLevelId, { id: created.id, cases: next.cases })
      }
    }
    out.set(level.stockLevelId, { before: out.get(level.stockLevelId)?.before ?? before, after: next.cases })
  }
  return out
}

/** The stock editor's absolute sealed count at one location. Locks the product itself. A change writes a 0-unit
 *  StockMovement (the batch reason, referenceType 'CaseCount', notes "Sealed cases 4 → 3 · 12 / case") and
 *  publishes inventory.cases_changed. Equal → noop.
 *
 *  Checked against the units in THIS transaction (after a units change the caller made first): `caseCountProblem` —
 *  NOT_A_WAREHOUSE (FBA and Shopify locations never hold cases), INVALID_CASES, NO_CASE_SIZE, CASES_EXCEED_UNITS.
 *  `before` is what a reader shows (the stored count clamped by the units). Nothing is pushed: units do not change. */
export async function setCasesInTx(tx: Prisma.TransactionClient, a: { productId: string; locationId: string; cases: number; reason: AdjustReason; notes?: string; actor: string }): Promise<{ noop: boolean; before: number; after: number }> {
  await lockProductStock(tx, [a.productId])
  const location = await tx.stockLocation.findUnique({ where: { id: a.locationId }, select: { type: true } })
  if (!location) throw new CaseCountError('NOT_A_WAREHOUSE', 'Location not found')
  const level = await tx.stockLevel.findFirst({ where: { productId: a.productId, locationId: a.locationId, variationId: null }, select: { id: true, quantity: true } })
  const pack = await tx.productPackage.findUnique({ where: { workspace_productId: workspaceKey({ productId: a.productId }) }, select: { unitsPerCase: true } })
  const size = pack?.unitsPerCase ?? null
  const quantity = level?.quantity ?? 0
  const problem = caseCountProblem({ cases: a.cases, quantity, unitsPerCase: size, locationType: location.type })
  if (problem) throw new CaseCountError(problem.code, problem.message)

  const row = level ? await tx.stockCaseCount.findUnique({ where: { workspace_stockLevelId: workspaceKey({ stockLevelId: level.id }) }, select: { id: true, cases: true } }) : null
  const before = sealedCases(row?.cases ?? 0, quantity, size)
  if (a.cases === before) return { noop: true, before, after: before }
  // Here a count changes, so there is a level and a case size: cases > 0 needs units (caseCountProblem), and a
  // count of 0 differs from `before` only when cases are sealed, which needs both.
  if (!level || size === null) throw new CaseCountError('NO_CASE_SIZE', CASE_COPY.noSize)

  const caseRow = await tx.stockCaseCount.upsert({
    where: { workspace_stockLevelId: workspaceKey({ stockLevelId: level.id }) },
    create: { stockLevelId: level.id, cases: a.cases, updatedBy: a.actor },
    update: { cases: a.cases, updatedBy: a.actor },
    select: { id: true },
  })
  const note = `Sealed cases ${before} → ${a.cases} · ${CASE_COPY.perCase(size)}`
  await tx.stockMovement.create({
    data: {
      productId: a.productId,
      variationId: null,
      warehouseId: null,
      locationId: a.locationId,
      change: 0,
      balanceAfter: quantity,
      quantityBefore: quantity,
      reason: a.reason,
      referenceType: 'CaseCount',
      referenceId: caseRow.id,
      notes: a.notes ? `${note} · ${a.notes}` : note,
      actor: a.actor,
    },
  })
  await publishEvent(tx, 'inventory.cases_changed', {
    productId: a.productId,
    locationId: a.locationId,
    casesBefore: before,
    casesAfter: a.cases,
    unitsPerCase: size,
    reason: 'count',
  })
  return { noop: false, before, after: a.cases }
}

/** Decimal(6,1) sides and Decimal(6,2) weight, as the columns keep them — so an equal save is a noop. */
const round = (value: number | null, places: number): number | null =>
  value === null || !Number.isFinite(value) ? value : Math.round(value * 10 ** places) / 10 ** places

function normalised(v: CasePackValues): CasePackValues {
  return {
    unitsPerCase: v.unitsPerCase ?? null,
    caseLengthCm: round(v.caseLengthCm ?? null, 1),
    caseWidthCm: round(v.caseWidthCm ?? null, 1),
    caseHeightCm: round(v.caseHeightCm ?? null, 1),
    caseWeightKg: round(v.caseWeightKg ?? null, 2),
    fbaPrepOwner: v.fbaPrepOwner ?? null,
    fbaLabelOwner: v.fbaLabelOwner ?? null,
  }
}

type StoredPack = {
  unitsPerCase: number | null
  caseLengthCm: Prisma.Decimal | null
  caseWidthCm: Prisma.Decimal | null
  caseHeightCm: Prisma.Decimal | null
  caseWeightKg: Prisma.Decimal | null
  fbaPrepOwner: string | null
  fbaLabelOwner: string | null
}

const NO_PACK: CasePackValues = { unitsPerCase: null, caseLengthCm: null, caseWidthCm: null, caseHeightCm: null, caseWeightKg: null, fbaPrepOwner: null, fbaLabelOwner: null }
const num = (value: Prisma.Decimal | null): number | null => (value === null ? null : Number(value))

function valuesOf(row: StoredPack | undefined): CasePackValues {
  if (!row) return NO_PACK
  return {
    unitsPerCase: row.unitsPerCase,
    caseLengthCm: num(row.caseLengthCm),
    caseWidthCm: num(row.caseWidthCm),
    caseHeightCm: num(row.caseHeightCm),
    caseWeightKg: num(row.caseWeightKg),
    fbaPrepOwner: isCaseOwner(row.fbaPrepOwner) ? row.fbaPrepOwner : null,
    fbaLabelOwner: isCaseOwner(row.fbaLabelOwner) ? row.fbaLabelOwner : null,
  }
}

const PACK_KEYS = Object.keys(NO_PACK) as Array<keyof CasePackValues>
const samePack = (a: CasePackValues, b: CasePackValues) => PACK_KEYS.every((key) => a[key] === b[key])
const emptyPack = (v: CasePackValues) => PACK_KEYS.every((key) => v[key] === null)

/** "4 sealed cases at IT-MAIN become loose units. …" — one sentence for every level a size change opens. */
function sealedMessage(sealed: SealedCasesDetail[]): string {
  const total = sealed.reduce((sum, s) => sum + s.cases, 0)
  const where = [...new Set(sealed.map((s) => s.locationCode))].join(', ')
  return CASE_COPY.sealedOpen(total, where)
}

/** Case size, dims, weight, prep/label owner for 1..200 SKUs, absolute. Locks the products. Changing or clearing
 *  unitsPerCase while any level of that SKU holds sealed cases throws CaseCountError('SEALED_CASES', detail: [{productId,
 *  sku, locationCode, cases}]) unless openSealedCases — then those case rows are deleted (cases become loose, units
 *  unchanged, nothing is pushed). Audit: AuditLogService.writeMany (entityType 'ProductPackage', before/after).
 *  Publishes inventory.cases_changed (locationId null) per product changed.
 *
 *  Values that `packProblem` refuses → every product answers `{ ok: false, error }` and nothing is written. A product
 *  this business does not have → `{ ok: false, error: 'Product not found' }`; the others still save. Clearing every
 *  value removes the row (absent row = no case pack). A size change removes the product's case rows at every level,
 *  so a count kept for the old size can never be read with the new one. */
export async function setCasePacks(a: { productIds: string[]; values: CasePackValues; openSealedCases?: boolean; actor: string; userId?: string | null }): Promise<Array<{ productId: string; ok: boolean; noop?: boolean; opened?: Array<{ locationCode: string; cases: number }>; error?: string }>> {
  const productIds = [...new Set(a.productIds)].filter((id) => typeof id === 'string' && id.length > 0)
  if (productIds.length === 0) return []
  if (productIds.length > MAX_PACK_PRODUCTS) throw new Error(`setCasePacks: at most ${MAX_PACK_PRODUCTS} products in one save, got ${productIds.length}`)
  const values = normalised(a.values)
  const problem = packProblem(values)
  if (problem) return productIds.map((productId) => ({ productId, ok: false, error: problem }))

  const audit: AuditWriteInput[] = []
  const results = await prisma.$transaction(async (tx) => {
    await lockProductStock(tx, productIds)
    const products = await tx.product.findMany({ where: { id: { in: productIds } }, select: { id: true, sku: true } })
    const skuOf = new Map(products.map((product) => [product.id, product.sku]))
    const packRows = await tx.productPackage.findMany({
      where: { productId: { in: productIds } },
      select: { productId: true, unitsPerCase: true, caseLengthCm: true, caseWidthCm: true, caseHeightCm: true, caseWeightKg: true, fbaPrepOwner: true, fbaLabelOwner: true },
    })
    const packOf = new Map(packRows.map((row) => [row.productId, row]))
    const caseRows = await tx.stockCaseCount.findMany({
      where: { stockLevel: { productId: { in: productIds } } },
      select: { id: true, cases: true, stockLevel: { select: { productId: true, quantity: true, location: { select: { code: true } } } } },
    })

    // Plan first: nothing is written until every product is known to be allowed.
    type Plan = { productId: string; before: CasePackValues; sizeChanged: boolean; caseRowIds: string[]; opened: SealedCasesDetail[] }
    const plans: Plan[] = []
    const answers = new Map<string, { productId: string; ok: boolean; noop?: boolean; opened?: Array<{ locationCode: string; cases: number }>; error?: string }>()
    for (const productId of productIds) {
      const sku = skuOf.get(productId)
      if (sku === undefined) { answers.set(productId, { productId, ok: false, error: 'Product not found' }); continue }
      const before = valuesOf(packOf.get(productId))
      if (samePack(before, values)) { answers.set(productId, { productId, ok: true, noop: true }); continue }
      const sizeChanged = before.unitsPerCase !== values.unitsPerCase
      const own = sizeChanged ? caseRows.filter((row) => row.stockLevel.productId === productId) : []
      const opened = own
        .map((row) => ({ productId, sku, locationCode: row.stockLevel.location.code, cases: sealedCases(row.cases, row.stockLevel.quantity, before.unitsPerCase) }))
        .filter((s) => s.cases > 0)
      plans.push({ productId, before, sizeChanged, caseRowIds: own.map((row) => row.id), opened })
    }
    const sealed = plans.flatMap((plan) => plan.opened)
    if (sealed.length > 0 && !a.openSealedCases) throw new CaseCountError('SEALED_CASES', sealedMessage(sealed), sealed)

    const caseRowIds = plans.flatMap((plan) => plan.caseRowIds)
    if (caseRowIds.length > 0) await tx.stockCaseCount.deleteMany({ where: { id: { in: caseRowIds } } })
    for (const plan of plans) {
      const data = { ...values, updatedBy: a.actor }
      if (emptyPack(values)) await tx.productPackage.deleteMany({ where: { productId: plan.productId } })
      else await tx.productPackage.upsert({ where: { workspace_productId: workspaceKey({ productId: plan.productId }) }, create: { productId: plan.productId, ...data }, update: data })
      await publishEvent(tx, 'inventory.cases_changed', {
        productId: plan.productId,
        locationId: null,
        casesBefore: null,
        casesAfter: null,
        unitsPerCase: values.unitsPerCase,
        reason: 'case-pack',
      })
      const opened = plan.opened.map((s) => ({ locationCode: s.locationCode, cases: s.cases }))
      audit.push({
        userId: a.userId ?? null,
        entityType: 'ProductPackage',
        entityId: plan.productId,
        action: 'update',
        before: plan.before,
        after: values,
        metadata: { actor: a.actor, ...(opened.length ? { openedSealedCases: opened } : {}) },
      })
      answers.set(plan.productId, { productId: plan.productId, ok: true, ...(plan.sizeChanged ? { opened } : {}) })
    }
    return productIds.map((productId) => answers.get(productId)!)
  }, { isolationLevel: 'ReadCommitted', maxWait: 5_000, timeout: 30_000 })

  // Fail-open, after the commit (auditing never rolls a save back).
  await auditLogService.writeMany(audit)
  return results
}

/**
 * Step 4 Send to FBA (Owner 2026-10-07) — "Prep by / Labels by", asked once in the dialog when a SKU has them "not set",
 * remembered for those SKUs. Inside the plan's transaction (the caller holds the product locks; taken again here, which
 * is a no-op in the same transaction). Writes ONLY the owner columns, and only where they are null: a SKU whose owner is
 * set keeps it, and no case size, dimension or weight is touched. A SKU with no case pack row gets one with only the
 * owners. Publishes `inventory.cases_changed` (reason `case-pack`, locationId null) per SKU changed, so the Matrix Case
 * column re-reads. Answers the SKUs changed with their owners before → after (the caller audits after its commit).
 */
export async function setFbaOwnersIfUnset(tx: Prisma.TransactionClient, a: { productIds: string[]; prepOwner: CaseOwner; labelOwner: CaseOwner; actor: string }): Promise<Array<{ productId: string; before: { fbaPrepOwner: CaseOwner | null; fbaLabelOwner: CaseOwner | null }; after: { fbaPrepOwner: CaseOwner | null; fbaLabelOwner: CaseOwner | null } }>> {
  const productIds = [...new Set(a.productIds)].filter((id) => typeof id === 'string' && id.length > 0)
  if (productIds.length === 0) return []
  if (!isCaseOwner(a.prepOwner) || !isCaseOwner(a.labelOwner)) throw new Error('setFbaOwnersIfUnset: prep and label owner must be AMAZON or SELLER')
  await lockProductStock(tx, productIds)
  const rows = await tx.productPackage.findMany({ where: { productId: { in: productIds } }, select: { productId: true, unitsPerCase: true, fbaPrepOwner: true, fbaLabelOwner: true } })
  const rowOf = new Map(rows.map((row) => [row.productId, row]))
  const missing = productIds.filter((productId) => !rowOf.has(productId))
  if (missing.length > 0) {
    await tx.productPackage.createMany({ data: missing.map((productId) => ({ productId, fbaPrepOwner: a.prepOwner, fbaLabelOwner: a.labelOwner, updatedBy: a.actor })) })
  }
  const withRow = productIds.filter((productId) => rowOf.has(productId))
  if (withRow.length > 0) {
    await tx.productPackage.updateMany({ where: { productId: { in: withRow }, fbaPrepOwner: null }, data: { fbaPrepOwner: a.prepOwner, updatedBy: a.actor } })
    await tx.productPackage.updateMany({ where: { productId: { in: withRow }, fbaLabelOwner: null }, data: { fbaLabelOwner: a.labelOwner, updatedBy: a.actor } })
  }
  const changed: Array<{ productId: string; before: { fbaPrepOwner: CaseOwner | null; fbaLabelOwner: CaseOwner | null }; after: { fbaPrepOwner: CaseOwner | null; fbaLabelOwner: CaseOwner | null } }> = []
  for (const productId of productIds) {
    const row = rowOf.get(productId)
    const prepBefore = row && isCaseOwner(row.fbaPrepOwner) ? row.fbaPrepOwner : null
    const labelBefore = row && isCaseOwner(row.fbaLabelOwner) ? row.fbaLabelOwner : null
    // A stored value that is not AMAZON/SELLER reads "not set" but is not overwritten (only null columns are written).
    const prepAfter = row ? (row.fbaPrepOwner === null ? a.prepOwner : prepBefore) : a.prepOwner
    const labelAfter = row ? (row.fbaLabelOwner === null ? a.labelOwner : labelBefore) : a.labelOwner
    if (prepAfter === prepBefore && labelAfter === labelBefore) continue
    changed.push({ productId, before: { fbaPrepOwner: prepBefore, fbaLabelOwner: labelBefore }, after: { fbaPrepOwner: prepAfter, fbaLabelOwner: labelAfter } })
    await publishEvent(tx, 'inventory.cases_changed', {
      productId,
      locationId: null,
      casesBefore: null,
      casesAfter: null,
      unitsPerCase: row?.unitsPerCase ?? null,
      reason: 'case-pack',
    })
  }
  return changed
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
