/**
 * Step 3 cases (Owner D2 = B; several case sizes per SKU, Owner 2026-10-08) — sealed cases and loose units per
 * location, and each SKU's case sizes and FBA prep/label owner.
 *
 * `StockLevel.quantity` stays the UNIT total; `StockCaseCount` = the sealed cases of one case size at that level (one
 * row per size); loose = quantity − Σ cases × unitsPerCase. The invariant Σ cases × unitsPerCase ≤ quantity has no
 * database CHECK (test and fresh databases are built from schema.prisma, which carries none): it lives HERE, in the one
 * keeper every stock path calls, and in the pure rule `@nexus/shared/stock-cases` the screens share. A sale takes loose
 * units first, then opens the SMALLEST case.
 *
 * This is the ONLY writer of `StockCaseCount`, `ProductCaseSize` and `ProductPackage` (scripts/check-stock-writer-lock.mjs,
 * `caseFiles`). Case rows are written with the scalar `stockLevelId` / `caseSizeId`, never a nested `connect`.
 *
 * Who calls what:
 *   keepCasesInTx — every unit movement (stock-movement.service.ts), the bulk stock import (stock-import.service.ts) and
 *                   the shared-stock door settle (stock-pool/pool-tasks.ts). The caller already holds the product lock.
 *                   After a decrease the counts are clamped (the smallest case opens first). Whole cases moved (Step 4)
 *                   pass `casesChange`, per size.
 *   setCasesInTx  — the stock editor's absolute counts at one location, per size (`adjustOneLocation`).
 *   setCasePacks  — the Matrix Case pop-up (`PUT /api/stock/case-packs`): the case sizes and the owners.
 *   setFbaOwnersIfUnset — Step 4 Send to FBA: the dialog's "Prep by / Labels by" for SKUs that had none (owners only).
 *   sealedByLevel, caseSizesOf — the readers.
 */
import type { Prisma } from '@prisma/client'
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../db.js'
import { lockProductStock } from '../stock-lock.js'
import { publishEvent } from '../../lib/events/publish.js'
import { auditLogService, type AuditWriteInput } from '../audit-log.service.js'
import {
  CASE_COPY, caseCountProblem, casesAfterMove, countsFor, isCaseOwner, isCaseSize, ownersProblem, sealedCases, sizesProblem, withCounts,
  type CaseChange, type CaseCount, type CaseOwner, type CaseOwnerValues, type CaseProblemCode, type CaseSizeValues,
} from '@nexus/shared/stock-cases'
import type { AdjustReason } from './location-adjust.service.js'

/** A refusal from a case write. `SEALED_CASES` carries `detail: SealedCasesDetail[]` (the cases a case-size change would open). */
export class CaseCountError extends Error {
  constructor(readonly code: CaseProblemCode | 'SEALED_CASES', message: string, readonly detail?: unknown) {
    super(message)
    this.name = 'CaseCountError'
  }
}

/** One level and size whose sealed cases a case-size change would open (`CaseCountError('SEALED_CASES').detail` lists them). */
export interface SealedCasesDetail { productId: string; sku: string; locationCode: string; unitsPerCase: number; cases: number }

/** The most SKUs one case-pack save may change (the Matrix family pop-up; the route checks it too). */
const MAX_PACK_PRODUCTS = 200

const byUnitsDesc = (a: { unitsPerCase: number }, b: { unitsPerCase: number }) => b.unitsPerCase - a.unitsPerCase
const sameCounts = (a: readonly CaseCount[], b: readonly CaseCount[]) =>
  a.length === b.length && a.every((c, k) => c.unitsPerCase === b[k].unitsPerCase && c.cases === b[k].cases)

/**
 * THE invariant keeper. The caller already holds lockProductStock for every product named (all three callers do).
 * Reads the case rows of these levels with their product's case sizes, applies casesAfterMove, writes only rows that
 * change. No case row or no case size → nothing to do.
 *
 * The answer has one entry per level that holds a case count (stored before → after, every size, biggest first).
 * Refusals (only with `casesChange`, whole cases moved): `NOT_A_WAREHOUSE`, `NO_CASE_SIZE` (no sizes, or a size the SKU
 * does not have), `INVALID_CASES` (more cases of a size leave than are sealed, or not a whole number),
 * `CASES_EXCEED_UNITS` — thrown as CaseCountError, so the caller's transaction (the movement itself) rolls back.
 *
 * Cost on the hot path (every sale): one indexed read of StockCaseCount; nothing more when the level has no row.
 */
export async function keepCasesInTx(tx: Prisma.TransactionClient,
  levels: ReadonlyArray<{ stockLevelId: string; quantityAfter: number; casesChange?: readonly CaseChange[] }>): Promise<Map<string, { before: CaseCount[]; after: CaseCount[] }>> {
  const out = new Map<string, { before: CaseCount[]; after: CaseCount[] }>()
  if (levels.length === 0) return out
  const moves = (level: { casesChange?: readonly CaseChange[] }) => (level.casesChange ?? []).some((c) => c.change !== 0)
  const ids = [...new Set(levels.map((level) => level.stockLevelId))]
  const rows = await tx.stockCaseCount.findMany({ where: { stockLevelId: { in: ids } }, select: { id: true, stockLevelId: true, caseSizeId: true, cases: true } })
  const explicit = levels.some(moves)
  if (rows.length === 0 && !explicit) return out

  // Only the levels that matter: those with a row, and (whole cases moved) those named with casesChange.
  const wanted = [...new Set([...rows.map((row) => row.stockLevelId), ...levels.filter(moves).map((level) => level.stockLevelId)])]
  const levelRows = await tx.stockLevel.findMany({ where: { id: { in: wanted } }, select: { id: true, productId: true, location: { select: { type: true } } } })
  const levelOf = new Map(levelRows.map((level) => [level.id, level]))
  const sizeRows = await tx.productCaseSize.findMany({
    where: { productId: { in: [...new Set(levelRows.map((level) => level.productId))] } },
    select: { id: true, productId: true, unitsPerCase: true },
  })
  const sizesOf = new Map<string, Array<{ id: string; unitsPerCase: number }>>()
  for (const size of sizeRows) sizesOf.set(size.productId, [...(sizesOf.get(size.productId) ?? []), size])
  // stockLevelId → caseSizeId → its row
  const stored = new Map<string, Map<string, { id: string; cases: number }>>()
  for (const row of rows) {
    const here = stored.get(row.stockLevelId) ?? new Map<string, { id: string; cases: number }>()
    here.set(row.caseSizeId, { id: row.id, cases: row.cases })
    stored.set(row.stockLevelId, here)
  }

  for (const level of levels) {
    const here = stored.get(level.stockLevelId)
    const moved = moves(level)
    if (!here && !moved) continue
    const info = levelOf.get(level.stockLevelId)
    if (!info) continue // the level is gone with its rows (ON DELETE CASCADE)
    if (moved && info.location.type !== 'WAREHOUSE') throw new CaseCountError('NOT_A_WAREHOUSE', CASE_COPY.notHere)
    const sizes = [...(sizesOf.get(info.productId) ?? [])].sort(byUnitsDesc)
    if (sizes.length === 0) {
      if (moved) throw new CaseCountError('NO_CASE_SIZE', CASE_COPY.noSize)
      continue // no case size: a count means nothing (a removed size takes its rows with it)
    }
    const before = sizes.map((size) => ({ unitsPerCase: size.unitsPerCase, cases: here?.get(size.id)?.cases ?? 0 }))
    const next = casesAfterMove({ cases: before, quantityAfter: level.quantityAfter, casesChange: moved ? level.casesChange : undefined })
    if ('refused' in next) throw new CaseCountError(next.refused.code, next.refused.message)
    for (const size of sizes) {
      const after = next.cases.find((c) => c.unitsPerCase === size.unitsPerCase)?.cases ?? 0
      const row = here?.get(size.id)
      if ((row?.cases ?? 0) === after) continue
      if (row) {
        await tx.stockCaseCount.update({ where: { id: row.id }, data: { cases: after } })
        row.cases = after
      } else {
        const created = await tx.stockCaseCount.create({ data: { stockLevelId: level.stockLevelId, caseSizeId: size.id, cases: after }, select: { id: true } })
        const map = stored.get(level.stockLevelId) ?? new Map<string, { id: string; cases: number }>()
        map.set(size.id, { id: created.id, cases: after })
        stored.set(level.stockLevelId, map)
      }
    }
    out.set(level.stockLevelId, { before: out.get(level.stockLevelId)?.before ?? before, after: next.cases })
  }
  return out
}

/** `Sealed cases 4×12 → 5×12 · 1×6 → 0×6` — the sizes whose count changed. */
function countNote(before: readonly CaseCount[], after: readonly CaseCount[]): string {
  const changed = after.filter((a) => (before.find((b) => b.unitsPerCase === a.unitsPerCase)?.cases ?? 0) !== a.cases)
  return `Sealed cases ${changed.map((a) => `${before.find((b) => b.unitsPerCase === a.unitsPerCase)?.cases ?? 0}×${a.unitsPerCase} → ${a.cases}×${a.unitsPerCase}`).join(' · ')}`
}

/** The stock editor's absolute sealed counts at one location, per named size (the sizes not named keep theirs). Locks
 *  the product itself. A change writes ONE 0-unit StockMovement (the batch reason, referenceType 'CaseCount', notes
 *  "Sealed cases 4×12 → 3×12 · 1×6 → 0×6") and publishes ONE inventory.cases_changed with every size that changed.
 *  Equal → noop.
 *
 *  Checked against the units in THIS transaction (after a units change the caller made first): `caseCountProblem` —
 *  NOT_A_WAREHOUSE (FBA and Shopify locations never hold cases), INVALID_CASES, NO_CASE_SIZE (a size the SKU does not
 *  have), CASES_EXCEED_UNITS. `before` is what a reader shows (the stored counts clamped by the units). Nothing is
 *  pushed: units do not change. */
export async function setCasesInTx(tx: Prisma.TransactionClient, a: { productId: string; locationId: string; cases: readonly CaseCount[]; reason: AdjustReason; notes?: string; actor: string }): Promise<{ noop: boolean; before: CaseCount[]; after: CaseCount[] }> {
  await lockProductStock(tx, [a.productId])
  const location = await tx.stockLocation.findUnique({ where: { id: a.locationId }, select: { type: true } })
  if (!location) throw new CaseCountError('NOT_A_WAREHOUSE', 'Location not found')
  const level = await tx.stockLevel.findFirst({ where: { productId: a.productId, locationId: a.locationId, variationId: null }, select: { id: true, quantity: true } })
  const sizes = (await tx.productCaseSize.findMany({ where: { productId: a.productId }, select: { id: true, unitsPerCase: true } })).sort(byUnitsDesc)
  const quantity = level?.quantity ?? 0
  const rows = level ? await tx.stockCaseCount.findMany({ where: { stockLevelId: level.id }, select: { id: true, caseSizeId: true, cases: true } }) : []
  const units = sizes.map((size) => size.unitsPerCase)
  const before = sealedCases(countsFor(units, sizes.map((size) => ({ unitsPerCase: size.unitsPerCase, cases: rows.find((row) => row.caseSizeId === size.id)?.cases ?? 0 }))), quantity)
  const typed = [...a.cases]
  if (typed.some((c) => !isCaseSize(c.unitsPerCase))) throw new CaseCountError('INVALID_CASES', 'Each sealed count names its case size (units per case)')
  const after = withCounts(before, typed)
  // A typed size the SKU does not have is checked too (refused when it asks for sealed cases).
  const unknown = typed.filter((c) => !units.includes(c.unitsPerCase))
  const problem = caseCountProblem({ cases: [...after, ...unknown], quantity, sizes: units, locationType: location.type })
  if (problem) throw new CaseCountError(problem.code, problem.message)
  if (sameCounts(before, after)) return { noop: true, before, after }
  // Here a count changes, so there is a level and a case size: a count > 0 needs units (caseCountProblem), and a
  // count of 0 differs from `before` only when cases are sealed, which needs both.
  if (!level || sizes.length === 0) throw new CaseCountError('NO_CASE_SIZE', CASE_COPY.noSize)

  let referenceId: string | null = null
  for (const size of sizes) {
    const was = before.find((c) => c.unitsPerCase === size.unitsPerCase)?.cases ?? 0
    const now = after.find((c) => c.unitsPerCase === size.unitsPerCase)?.cases ?? 0
    // The stored row may hold more than `before` shows (clamped by the units): a size whose shown count does not
    // change is still written, so the row says what the screen showed.
    const row = rows.find((r) => r.caseSizeId === size.id)
    if (was === now && (row?.cases ?? 0) === now) continue
    const saved = await tx.stockCaseCount.upsert({
      where: { stockLevelId_caseSizeId: workspaceKey({ stockLevelId: level.id, caseSizeId: size.id }) },
      create: { stockLevelId: level.id, caseSizeId: size.id, cases: now, updatedBy: a.actor },
      update: { cases: now, updatedBy: a.actor },
      select: { id: true },
    })
    if (was !== now) referenceId ??= saved.id
  }
  const note = countNote(before, after)
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
      referenceId,
      notes: a.notes ? `${note} · ${a.notes}` : note,
      actor: a.actor,
    },
  })
  await publishEvent(tx, 'inventory.cases_changed', {
    productId: a.productId,
    locationId: a.locationId,
    counts: after
      .map((c) => ({ unitsPerCase: c.unitsPerCase, before: before.find((b) => b.unitsPerCase === c.unitsPerCase)?.cases ?? 0, after: c.cases }))
      .filter((c) => c.before !== c.after),
    sizes: units,
    reason: 'count',
  })
  return { noop: false, before, after }
}

/** Decimal(6,1) sides and Decimal(6,2) weight, as the columns keep them — so an equal save is a noop. */
const round = (value: number | null, places: number): number | null =>
  value === null || !Number.isFinite(value) ? value : Math.round(value * 10 ** places) / 10 ** places

function normalisedSize(v: CaseSizeValues): CaseSizeValues {
  return {
    unitsPerCase: v.unitsPerCase,
    caseLengthCm: round(v.caseLengthCm ?? null, 1),
    caseWidthCm: round(v.caseWidthCm ?? null, 1),
    caseHeightCm: round(v.caseHeightCm ?? null, 1),
    caseWeightKg: round(v.caseWeightKg ?? null, 2),
  }
}

type StoredSize = {
  id: string
  productId: string
  unitsPerCase: number
  caseLengthCm: Prisma.Decimal | null
  caseWidthCm: Prisma.Decimal | null
  caseHeightCm: Prisma.Decimal | null
  caseWeightKg: Prisma.Decimal | null
}

const num = (value: Prisma.Decimal | null): number | null => (value === null ? null : Number(value))

/** A stored case size as the values a save compares (Decimals as numbers). */
export function sizeValuesOf(row: Omit<StoredSize, 'id' | 'productId'>): CaseSizeValues {
  return {
    unitsPerCase: row.unitsPerCase,
    caseLengthCm: num(row.caseLengthCm),
    caseWidthCm: num(row.caseWidthCm),
    caseHeightCm: num(row.caseHeightCm),
    caseWeightKg: num(row.caseWeightKg),
  }
}

const SIZE_SELECT = {
  id: true, productId: true, unitsPerCase: true, caseLengthCm: true, caseWidthCm: true, caseHeightCm: true, caseWeightKg: true,
} as const
const sameSize = (a: CaseSizeValues, b: CaseSizeValues) =>
  a.unitsPerCase === b.unitsPerCase && a.caseLengthCm === b.caseLengthCm && a.caseWidthCm === b.caseWidthCm
  && a.caseHeightCm === b.caseHeightCm && a.caseWeightKg === b.caseWeightKg
const sameSizes = (a: readonly CaseSizeValues[], b: readonly CaseSizeValues[]) => a.length === b.length && a.every((v, k) => sameSize(v, b[k]))
const ownerOf = (value: string | null | undefined): CaseOwner | null => (isCaseOwner(value) ? value : null)

/** One SKU's case pack as a save and its audit see it: the sizes (biggest first) and the owners. */
export interface CasePackState extends CaseOwnerValues { sizes: CaseSizeValues[] }

/** "4 sealed cases at IT-MAIN become loose units. …" — one sentence for every level a size change opens. */
function sealedMessage(sealed: SealedCasesDetail[]): string {
  const total = sealed.reduce((sum, s) => sum + s.cases, 0)
  const where = [...new Set(sealed.map((s) => s.locationCode))].join(', ')
  return CASE_COPY.sealedOpen(total, where)
}

export interface SetCasePacksInput {
  productIds: string[]
  /** Absent = each SKU keeps its sizes. Present = each SKU's list becomes exactly this (matched by unitsPerCase). */
  sizes?: CaseSizeValues[]
  /** Absent = keep; null = clear. */
  fbaPrepOwner?: CaseOwner | null
  fbaLabelOwner?: CaseOwner | null
  openSealedCases?: boolean
  actor: string
  userId?: string | null
}

export interface CasePackResult {
  productId: string
  ok: boolean
  noop?: boolean
  opened?: Array<{ locationCode: string; unitsPerCase: number; cases: number }>
  error?: string
}

/** Case sizes and prep/label owner for 1..200 SKUs. Locks the products.
 *  - `sizes` present: each SKU's list becomes exactly this list, matched by units per case — a size with the same units
 *    keeps its sealed counts (its case size and weight are updated); a size not in the list is removed with its counts;
 *    a new units value is added. Removing a size while any level of that SKU holds sealed cases of it throws
 *    CaseCountError('SEALED_CASES', detail: [{ productId, sku, locationCode, unitsPerCase, cases }]) unless
 *    openSealedCases — then those cases become loose units (units unchanged, nothing is pushed).
 *  - An owner absent keeps it; null clears it. Both owners null and no row → no row (absent row = not set).
 *  Values that `sizesProblem` / `ownersProblem` refuse → every product answers `{ ok: false, error }`, nothing is
 *  written. A product this business does not have → `{ ok: false, error: 'Product not found' }`; the others still save.
 *  Audit: AuditLogService.writeMany (entityType 'ProductPackage', before/after = { sizes, fbaPrepOwner, fbaLabelOwner }).
 *  Publishes inventory.cases_changed (locationId null, counts [], the sizes after) per product changed. */
export async function setCasePacks(a: SetCasePacksInput): Promise<CasePackResult[]> {
  const productIds = [...new Set(a.productIds)].filter((id) => typeof id === 'string' && id.length > 0)
  if (productIds.length === 0) return []
  if (productIds.length > MAX_PACK_PRODUCTS) throw new Error(`setCasePacks: at most ${MAX_PACK_PRODUCTS} products in one save, got ${productIds.length}`)
  const sizes = a.sizes === undefined ? undefined : a.sizes.map(normalisedSize).sort(byUnitsDesc)
  const problem = (sizes ? sizesProblem(sizes) : null) ?? ownersProblem({ fbaPrepOwner: a.fbaPrepOwner ?? null, fbaLabelOwner: a.fbaLabelOwner ?? null })
  if (problem) return productIds.map((productId) => ({ productId, ok: false, error: problem }))

  const audit: AuditWriteInput[] = []
  const results = await prisma.$transaction(async (tx) => {
    await lockProductStock(tx, productIds)
    const products = await tx.product.findMany({ where: { id: { in: productIds } }, select: { id: true, sku: true } })
    const skuOf = new Map(products.map((product) => [product.id, product.sku]))
    const packRows = await tx.productPackage.findMany({ where: { productId: { in: productIds } }, select: { productId: true, fbaPrepOwner: true, fbaLabelOwner: true } })
    const packOf = new Map(packRows.map((row) => [row.productId, row]))
    const sizeRows = (await tx.productCaseSize.findMany({ where: { productId: { in: productIds } }, select: SIZE_SELECT })).sort(byUnitsDesc)
    const sizeRowsOf = (productId: string) => sizeRows.filter((row) => row.productId === productId)
    const caseRows = sizes === undefined ? [] : await tx.stockCaseCount.findMany({
      where: { caseSize: { productId: { in: productIds } } },
      select: { stockLevelId: true, caseSizeId: true, cases: true, stockLevel: { select: { productId: true, quantity: true, location: { select: { code: true } } } } },
    })

    // Plan first: nothing is written until every product is known to be allowed.
    type Plan = {
      productId: string
      before: CasePackState
      after: CasePackState
      removeIds: string[]
      update: Array<{ id: string; values: CaseSizeValues }>
      create: CaseSizeValues[]
      ownersChanged: boolean
      opened: SealedCasesDetail[]
    }
    const plans: Plan[] = []
    const answers = new Map<string, CasePackResult>()
    for (const productId of productIds) {
      const sku = skuOf.get(productId)
      if (sku === undefined) { answers.set(productId, { productId, ok: false, error: 'Product not found' }); continue }
      const own = sizeRowsOf(productId)
      const pack = packOf.get(productId)
      const before: CasePackState = { sizes: own.map(sizeValuesOf), fbaPrepOwner: ownerOf(pack?.fbaPrepOwner), fbaLabelOwner: ownerOf(pack?.fbaLabelOwner) }
      const after: CasePackState = {
        sizes: sizes ?? before.sizes,
        fbaPrepOwner: a.fbaPrepOwner === undefined ? before.fbaPrepOwner : a.fbaPrepOwner,
        fbaLabelOwner: a.fbaLabelOwner === undefined ? before.fbaLabelOwner : a.fbaLabelOwner,
      }
      const ownersChanged = after.fbaPrepOwner !== before.fbaPrepOwner || after.fbaLabelOwner !== before.fbaLabelOwner
      if (!ownersChanged && sameSizes(before.sizes, after.sizes)) { answers.set(productId, { productId, ok: true, noop: true }); continue }
      const keptUnits = new Set(after.sizes.map((v) => v.unitsPerCase))
      const removed = own.filter((row) => !keptUnits.has(row.unitsPerCase))
      const update = own.flatMap((row) => {
        const next = after.sizes.find((v) => v.unitsPerCase === row.unitsPerCase)
        return next && !sameSize(sizeValuesOf(row), next) ? [{ id: row.id, values: next }] : []
      })
      const create = after.sizes.filter((v) => !own.some((row) => row.unitsPerCase === v.unitsPerCase))
      // What a removed size holds now, as a reader shows it (every size of the level clamped by its units).
      const opened: SealedCasesDetail[] = []
      if (removed.length > 0) {
        const levels = new Map<string, { quantity: number; code: string; stored: CaseCount[] }>()
        for (const row of caseRows) {
          if (row.stockLevel.productId !== productId) continue
          const size = own.find((s) => s.id === row.caseSizeId)
          if (!size) continue
          const at = levels.get(row.stockLevelId) ?? { quantity: row.stockLevel.quantity, code: row.stockLevel.location.code, stored: [] }
          at.stored.push({ unitsPerCase: size.unitsPerCase, cases: row.cases })
          levels.set(row.stockLevelId, at)
        }
        for (const level of levels.values()) {
          const shown = sealedCases(countsFor(own.map((s) => s.unitsPerCase), level.stored), level.quantity)
          for (const size of removed) {
            const cases = shown.find((c) => c.unitsPerCase === size.unitsPerCase)?.cases ?? 0
            if (cases > 0) opened.push({ productId, sku, locationCode: level.code, unitsPerCase: size.unitsPerCase, cases })
          }
        }
      }
      plans.push({ productId, before, after, removeIds: removed.map((row) => row.id), update, create, ownersChanged, opened })
    }
    const sealed = plans.flatMap((plan) => plan.opened)
    if (sealed.length > 0 && !a.openSealedCases) throw new CaseCountError('SEALED_CASES', sealedMessage(sealed), sealed)

    const removeIds = plans.flatMap((plan) => plan.removeIds)
    // Removing a size removes its counts too (ON DELETE CASCADE): those cases become loose units.
    if (removeIds.length > 0) await tx.productCaseSize.deleteMany({ where: { id: { in: removeIds } } })
    for (const plan of plans) {
      for (const change of plan.update) {
        await tx.productCaseSize.update({ where: { id: change.id }, data: { ...change.values, updatedBy: a.actor } })
      }
      if (plan.create.length > 0) {
        await tx.productCaseSize.createMany({ data: plan.create.map((values) => ({ productId: plan.productId, ...values, updatedBy: a.actor })) })
      }
      if (plan.ownersChanged) {
        const owners = { fbaPrepOwner: plan.after.fbaPrepOwner, fbaLabelOwner: plan.after.fbaLabelOwner }
        if (owners.fbaPrepOwner === null && owners.fbaLabelOwner === null) await tx.productPackage.deleteMany({ where: { productId: plan.productId } })
        else await tx.productPackage.upsert({ where: { workspace_productId: workspaceKey({ productId: plan.productId }) }, create: { productId: plan.productId, ...owners, updatedBy: a.actor }, update: { ...owners, updatedBy: a.actor } })
      }
      await publishEvent(tx, 'inventory.cases_changed', {
        productId: plan.productId,
        locationId: null,
        counts: [],
        sizes: plan.after.sizes.map((v) => v.unitsPerCase),
        reason: 'case-pack',
      })
      const opened = plan.opened.map((s) => ({ locationCode: s.locationCode, unitsPerCase: s.unitsPerCase, cases: s.cases }))
      audit.push({
        userId: a.userId ?? null,
        entityType: 'ProductPackage',
        entityId: plan.productId,
        action: 'update',
        before: plan.before,
        after: plan.after,
        metadata: { actor: a.actor, ...(opened.length ? { openedSealedCases: opened } : {}) },
      })
      answers.set(plan.productId, { productId: plan.productId, ok: true, ...(plan.removeIds.length ? { opened } : {}) })
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
 * set keeps it, and no case size is touched. A SKU with no owners row gets one. Publishes `inventory.cases_changed`
 * (reason `case-pack`, locationId null, counts []) per SKU changed, so the Matrix Case column re-reads. Answers the SKUs
 * changed with their owners before → after (the caller audits after its commit).
 */
export async function setFbaOwnersIfUnset(tx: Prisma.TransactionClient, a: { productIds: string[]; prepOwner: CaseOwner; labelOwner: CaseOwner; actor: string }): Promise<Array<{ productId: string; before: { fbaPrepOwner: CaseOwner | null; fbaLabelOwner: CaseOwner | null }; after: { fbaPrepOwner: CaseOwner | null; fbaLabelOwner: CaseOwner | null } }>> {
  const productIds = [...new Set(a.productIds)].filter((id) => typeof id === 'string' && id.length > 0)
  if (productIds.length === 0) return []
  if (!isCaseOwner(a.prepOwner) || !isCaseOwner(a.labelOwner)) throw new Error('setFbaOwnersIfUnset: prep and label owner must be AMAZON or SELLER')
  await lockProductStock(tx, productIds)
  const rows = await tx.productPackage.findMany({ where: { productId: { in: productIds } }, select: { productId: true, fbaPrepOwner: true, fbaLabelOwner: true } })
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
  const sizeRows = await tx.productCaseSize.findMany({ where: { productId: { in: productIds } }, select: { productId: true, unitsPerCase: true } })
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
      counts: [],
      sizes: sizeRows.filter((s) => s.productId === productId).map((s) => s.unitsPerCase).sort((x, y) => y - x),
      reason: 'case-pack',
    })
  }
  return changed
}

/** What the readers read: the client or a transaction. */
type CaseReadDb = Pick<Prisma.TransactionClient, 'stockCaseCount' | 'productCaseSize'>

/** One case size as the readers hand it on: units per case, case size (cm) and weight (kg) as numbers; biggest first. */
export interface CaseSizeRow extends CaseSizeValues { id: string }

/** Readers: each product's case sizes, biggest first (absent = none). */
export async function caseSizesOf(db: Pick<Prisma.TransactionClient, 'productCaseSize'>, productIds: readonly string[]): Promise<Map<string, CaseSizeRow[]>> {
  const out = new Map<string, CaseSizeRow[]>()
  const ids = [...new Set(productIds)]
  if (ids.length === 0) return out
  const rows = (await db.productCaseSize.findMany({ where: { productId: { in: ids } }, select: SIZE_SELECT })).sort(byUnitsDesc)
  for (const row of rows) out.set(row.productId, [...(out.get(row.productId) ?? []), { id: row.id, ...sizeValuesOf(row) }])
  return out
}

/** Readers: the sealed counts each level shows — every size of its SKU, stored and clamped by the units, biggest
 *  first ([] when the SKU has no case size). */
export async function sealedByLevel(db: CaseReadDb, levels: ReadonlyArray<{ id: string; productId: string; quantity: number }>): Promise<Map<string, CaseCount[]>> {
  const out = new Map<string, CaseCount[]>()
  if (levels.length === 0) return out
  const productIds = [...new Set(levels.map((level) => level.productId))]
  const [sizes, counts] = await Promise.all([
    db.productCaseSize.findMany({ where: { productId: { in: productIds } }, select: { id: true, productId: true, unitsPerCase: true } }),
    db.stockCaseCount.findMany({ where: { stockLevelId: { in: levels.map((level) => level.id) } }, select: { stockLevelId: true, caseSizeId: true, cases: true } }),
  ])
  const unitsOfSize = new Map(sizes.map((size) => [size.id, size.unitsPerCase]))
  for (const level of levels) {
    const units = sizes.filter((size) => size.productId === level.productId).map((size) => size.unitsPerCase)
    const stored = counts
      .filter((row) => row.stockLevelId === level.id && unitsOfSize.has(row.caseSizeId))
      .map((row) => ({ unitsPerCase: unitsOfSize.get(row.caseSizeId)!, cases: row.cases }))
    out.set(level.id, sealedCases(countsFor(units, stored), level.quantity))
  }
  return out
}
