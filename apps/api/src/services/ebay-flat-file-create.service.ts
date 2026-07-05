/**
 * P1.2 — eBay flat-file create/reparent prisma execution layer.
 *
 * Consumes the pure plan produced by P1.1 (ebay-flat-file-create.logic.ts)
 * and executes product creates + reparents against the database.
 *
 * Called as a PRE-PASS from PATCH /api/ebay/flat-file/rows so newly-created
 * products are available (via the returned idMap) before the per-row
 * ChannelListing loop runs. The ChannelListing find-or-create loop is NOT
 * duplicated here — it continues to run unchanged for every productId,
 * including newly-created ones.
 */
import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import {
  planEbayFamilyCreates,
  buildEbayProductCreateInput,
  type EbayRow,
} from './ebay-flat-file-create.logic.js'

// ──────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────

export type CreateResult = {
  /** tempRowId + sku → real productId; for client temp→real reconciliation (reparents go to `reparented`, not here) */
  idMap: Array<{ tempRowId?: string; sku: string; productId: string }>
  reparented: Array<{ sku: string; productId: string; newParentId: string | null }>
  errors: Array<{ sku?: string; tempRowId?: string; reason: string }>
  warnings: Array<{ sku?: string; reason: string }>
}

// ──────────────────────────────────────────────────────────────────────
// Minimal prisma interface — satisfied by both PrismaClient and the test mock
// ──────────────────────────────────────────────────────────────────────

/** Minimal product-table operations needed by this service. */
interface ProductTable {
  findMany(args: unknown): Promise<unknown[]>
  findFirst(args: unknown): Promise<unknown>
  create(args: unknown): Promise<{ id: string }>
  update(args: unknown): Promise<unknown>
}

/** Minimal prisma interface — satisfied by PrismaClient and the test mock. */
export interface EbayCreatePrisma {
  product: ProductTable
  $transaction(fn: (tx: { product: ProductTable }) => Promise<void>): Promise<void>
}

// ──────────────────────────────────────────────────────────────────────
// Main export
// ──────────────────────────────────────────────────────────────────────

/**
 * Execute all eBay flat-file product creates + reparents for a PATCH /rows request.
 *
 * Steps:
 *  1. Query DB facts: existingBySku (by sku) + existingParentById (by platformProductId).
 *  2. Plan via planEbayFamilyCreates (pure).
 *  3. Execute per-family $transaction: parent first, then children.
 *     • P2002 on sku → idempotent recovery: look up existing product (double-submit safe).
 *  4. Reparents — validate newParentId before updating; skip + record error if not found.
 *  5. Return idMap + reparented + errors + warnings.
 *
 * @param prisma  PrismaClient (or test-injectable mock matching EbayCreatePrisma).
 * @param rows    Flat rows as received by PATCH /rows — same array the handler loops over.
 */
export async function runEbayFlatFileCreates(
  prisma: EbayCreatePrisma | PrismaClient,
  rows: EbayRow[],
  opts?: { sharedFamilyKeys?: Set<string> },
): Promise<CreateResult> {
  const p = prisma as EbayCreatePrisma

  const idMap: CreateResult['idMap'] = []
  const reparented: CreateResult['reparented'] = []
  const errors: CreateResult['errors'] = []
  const warnings: CreateResult['warnings'] = []

  if (!rows.length) return { idMap, reparented, errors, warnings }

  // ── Step 1: Gather DB facts ──────────────────────────────────────────
  const skusInPayload = [
    ...new Set(rows.map(r => String(r.sku ?? '').trim()).filter(Boolean)),
  ]

  const existingProductRows = skusInPayload.length
    ? (await p.product.findMany({
        where: { sku: { in: skusInPayload }, deletedAt: null },
        select: { id: true, sku: true, parentId: true, variationTheme: true, isParent: true },
      })) as Array<{ id: string; sku: string; parentId: string | null; variationTheme: string | null; isParent: boolean }>
    : []

  const existingBySku = new Map(existingProductRows.map(row => [row.sku, row]))

  // Collect all non-empty platformProductId values — these are candidate real parent ids.
  // Temp client _rowId values (cuid/nanoid) won't match real product ids in the DB findMany,
  // so including them is harmless and avoids excluding a real parent whose id happens to be
  // present as a _rowId (e.g. when buildFlatRow sets _rowId = product.id for existing products).
  const candidateParentIds = [
    ...new Set(
      rows.map(r => String(r.platformProductId ?? '').trim()).filter(Boolean),
    ),
  ]

  const existingParentRows = candidateParentIds.length
    ? (await p.product.findMany({
        where: { id: { in: candidateParentIds }, deletedAt: null },
        select: { id: true, variationTheme: true, isParent: true },
      })) as Array<{ id: string; variationTheme: string | null; isParent: boolean }>
    : []

  const existingParentById = new Map(existingParentRows.map(r => [r.id, r]))

  // ── Step 2: Plan ──────────────────────────────────────────────────────
  const plan = planEbayFamilyCreates({
    rows,
    existingBySku,
    existingParentById,
    sharedFamilyKeys: opts?.sharedFamilyKeys ?? new Set(),
  })

  errors.push(...plan.errors)
  warnings.push(...plan.warnings)

  // ── Step 3: Organise childCreates by parent reference ─────────────────
  const childrenByTempParent = new Map<string, typeof plan.childCreates>()
  const childrenByExistingParent = new Map<string, typeof plan.childCreates>()

  for (const child of plan.childCreates) {
    if (child.parentRef.kind === 'temp') {
      const arr = childrenByTempParent.get(child.parentRef.tempRowId) ?? []
      arr.push(child)
      childrenByTempParent.set(child.parentRef.tempRowId, arr)
    } else {
      const arr = childrenByExistingParent.get(child.parentRef.productId) ?? []
      arr.push(child)
      childrenByExistingParent.set(child.parentRef.productId, arr)
    }
  }

  // Shared temp→real id map — populated during executes, used for reparent validation.
  const tempToRealId = new Map<string, string>()

  // ── Step 4a: New parent + its children — one $transaction per family ──
  for (const parentEntry of plan.parentCreates) {
    const children = childrenByTempParent.get(parentEntry.tempRowId) ?? []
    const allSkusInFamily = [parentEntry.sku, ...children.map(c => c.sku)]

    // Map built inside the transaction callback; populated for idMap on success.
    const familyTempToId = new Map<string, string>()

    try {
      await p.$transaction(async tx => {
        // Create parent first.
        const parentData = buildEbayProductCreateInput(parentEntry.row, {
          parentId: null,
          variationTheme: parentEntry.variationTheme,
          isParent: true,
        })
        const createdParent = await tx.product.create({
          data: {
            ...parentData,
            basePrice: new Prisma.Decimal(parentData.basePrice),
            importedAt: new Date(),
          },
          select: { id: true },
        })
        familyTempToId.set(parentEntry.tempRowId, createdParent.id)

        // Create children, resolving parentId from the just-created parent.
        for (const child of children) {
          const childData = buildEbayProductCreateInput(child.row, {
            parentId: createdParent.id,
            variationTheme: child.variationTheme,
            isParent: false,
          })
          const createdChild = await tx.product.create({
            data: {
              ...childData,
              basePrice: new Prisma.Decimal(childData.basePrice),
              importedAt: new Date(),
            },
            select: { id: true },
          })
          familyTempToId.set(child.tempRowId, createdChild.id)
        }
      })

      // Transaction succeeded — populate shared maps + idMap.
      const parentRealId = familyTempToId.get(parentEntry.tempRowId)!
      tempToRealId.set(parentEntry.tempRowId, parentRealId)
      idMap.push({ tempRowId: parentEntry.tempRowId, sku: parentEntry.sku, productId: parentRealId })

      for (const child of children) {
        const childRealId = familyTempToId.get(child.tempRowId)!
        tempToRealId.set(child.tempRowId, childRealId)
        idMap.push({ tempRowId: child.tempRowId, sku: child.sku, productId: childRealId })
      }
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code
      const t = (err as { meta?: { target?: unknown } })?.meta?.target
      const isSkuP2002 = code === 'P2002' && (Array.isArray(t) ? t.includes('sku') : String(t ?? '').includes('sku'))
      if (isSkuP2002) {
        // Double-submit: idempotent recovery — look up all products in this family by SKU.
        const found = (await p.product.findMany({
          where: { sku: { in: allSkusInFamily }, deletedAt: null },
          select: { id: true, sku: true },
        })) as Array<{ id: string; sku: string }>

        const foundBySku = new Map(found.map(f => [f.sku, f.id]))

        const parentRealId = foundBySku.get(parentEntry.sku)
        if (parentRealId) {
          tempToRealId.set(parentEntry.tempRowId, parentRealId)
          idMap.push({ tempRowId: parentEntry.tempRowId, sku: parentEntry.sku, productId: parentRealId })
        }
        for (const child of children) {
          const childRealId = foundBySku.get(child.sku)
          if (childRealId) {
            tempToRealId.set(child.tempRowId, childRealId)
            idMap.push({ tempRowId: child.tempRowId, sku: child.sku, productId: childRealId })
          }
        }
      } else {
        errors.push({
          sku: parentEntry.sku,
          tempRowId: parentEntry.tempRowId,
          reason: `Create failed: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }
  }

  // ── Step 4b: New children under an EXISTING parent — one $transaction per parent ──
  for (const [existingParentId, children] of childrenByExistingParent) {
    const allChildSkus = children.map(c => c.sku)
    const childTempToId = new Map<string, string>()

    try {
      await p.$transaction(async tx => {
        for (const child of children) {
          const childData = buildEbayProductCreateInput(child.row, {
            parentId: existingParentId,
            variationTheme: child.variationTheme,
            isParent: false,
          })
          const created = await tx.product.create({
            data: {
              ...childData,
              basePrice: new Prisma.Decimal(childData.basePrice),
              importedAt: new Date(),
            },
            select: { id: true },
          })
          childTempToId.set(child.tempRowId, created.id)
        }
      })

      // Success — populate maps + idMap.
      for (const child of children) {
        const childRealId = childTempToId.get(child.tempRowId)!
        tempToRealId.set(child.tempRowId, childRealId)
        idMap.push({ tempRowId: child.tempRowId, sku: child.sku, productId: childRealId })
      }
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code
      const t = (err as { meta?: { target?: unknown } })?.meta?.target
      const isSkuP2002 = code === 'P2002' && (Array.isArray(t) ? t.includes('sku') : String(t ?? '').includes('sku'))
      if (isSkuP2002) {
        // Idempotent recovery for existing-parent family.
        const found = (await p.product.findMany({
          where: { sku: { in: allChildSkus }, deletedAt: null },
          select: { id: true, sku: true },
        })) as Array<{ id: string; sku: string }>

        const foundBySku = new Map(found.map(f => [f.sku, f.id]))
        for (const child of children) {
          const childRealId = foundBySku.get(child.sku)
          if (childRealId) {
            tempToRealId.set(child.tempRowId, childRealId)
            idMap.push({ tempRowId: child.tempRowId, sku: child.sku, productId: childRealId })
          }
        }
      } else {
        errors.push({
          reason: `Create failed for children of existing parent ${existingParentId}: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }
  }

  // ── Step 5: Reparents ────────────────────────────────────────────────
  for (const reparentEntry of plan.reparents) {
    // Temp-reparent: parent was created in this same save (batch or synthetic parent).
    // tempToRealId is fully populated by now (all parentCreates ran above in Step 4a).
    if (reparentEntry.newParentTempRowId) {
      const realParentId = tempToRealId.get(reparentEntry.newParentTempRowId)
      if (!realParentId) {
        errors.push({
          sku: reparentEntry.sku,
          reason: `Reparent skipped: temp parent ${reparentEntry.newParentTempRowId} could not be resolved to a real id`,
        })
        continue
      }
      try {
        await p.product.update({
          where: { id: reparentEntry.productId },
          data: { parentId: realParentId },
        })
        reparented.push({
          sku: reparentEntry.sku,
          productId: reparentEntry.productId,
          newParentId: realParentId,
        })
      } catch (err: unknown) {
        errors.push({
          sku: reparentEntry.sku,
          reason: `Reparent failed: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
      continue
    }

    // Null-reparent: detach from parent → standalone (no parent validation needed).
    if (reparentEntry.newParentId === null) {
      try {
        await p.product.update({ where: { id: reparentEntry.productId }, data: { parentId: null } })
        reparented.push({ sku: reparentEntry.sku, productId: reparentEntry.productId, newParentId: null })
      } catch (err) {
        errors.push({ sku: reparentEntry.sku, reason: `detach failed: ${err instanceof Error ? err.message : String(err)}` })
      }
      continue
    }

    // Validate that newParentId exists: check existingParentById, then idMap (newly created), then fresh DB lookup.
    const isKnownExisting = existingParentById.has(reparentEntry.newParentId)
    const isNewlyCreated = idMap.some(e => e.productId === reparentEntry.newParentId)

    let parentValid = isKnownExisting || isNewlyCreated

    if (!parentValid) {
      // Fresh lookup — covers edge cases where existingParentById didn't include this id.
      const fresh = await p.product.findFirst({
        where: { id: reparentEntry.newParentId, deletedAt: null },
        select: { id: true },
      })
      parentValid = !!fresh
    }

    if (!parentValid) {
      errors.push({
        sku: reparentEntry.sku,
        reason: `Reparent skipped: newParentId ${reparentEntry.newParentId} not found`,
      })
      continue
    }

    try {
      await p.product.update({
        where: { id: reparentEntry.productId },
        data: { parentId: reparentEntry.newParentId },
      })
      reparented.push({
        sku: reparentEntry.sku,
        productId: reparentEntry.productId,
        newParentId: reparentEntry.newParentId,
      })
    } catch (err: unknown) {
      errors.push({
        sku: reparentEntry.sku,
        reason: `Reparent failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  return { idMap, reparented, errors, warnings }
}
