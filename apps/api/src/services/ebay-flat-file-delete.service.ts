/**
 * P2.D1 — eBay flat-file soft-delete service.
 *
 * runEbayFlatFileDelete(prisma, targets, opts?)
 *
 * Three intents:
 *
 *   remove-listing — delete one SharedListingMembership row (by
 *     (marketplace, sku, itemId) or by (marketplace, parentSku, sku));
 *     best-effort delist that eBay item; Product is NOT soft-deleted.
 *
 *   delete-product — soft-delete one Product (set deletedAt) and all its
 *     SharedListingMembership rows; best-effort delist. Idempotent.
 *
 *   delete-family  — soft-delete the parent Product AND every non-deleted
 *     child (parentId === parent.id, deletedAt: null) in one transaction;
 *     delete memberships for all of them; best-effort delist. Idempotent.
 *
 * Each target's DB writes run inside a prisma.$transaction. Targets are
 * processed sequentially — one failure does NOT abort the others. Delist
 * is always best-effort: a channel error is logged and surfaced in the
 * per-target result but never rolls back the committed soft-delete.
 *
 * HARD DELETE IS NEVER PERFORMED.
 */

import { logger } from '../utils/logger.js'
import {
  dispatchChannelDelist,
  type ChannelDelistJob,
} from './channel-delist.service.js'

// ── Public types ───────────────────────────────────────────────────────────

export type DeleteIntent =
  | 'delete-product'
  | 'delete-family'
  | 'remove-listing'

export interface DeleteTarget {
  /** Nexus Product.id — preferred identifier; falls back to sku when omitted. */
  productId?: string
  /** Product.sku / SharedListingMembership.sku */
  sku: string
  /** eBay marketplace code: 'IT' | 'DE' | 'FR' | 'ES' | 'UK' */
  marketplace: string
  /** eBay ItemID — drives the membership lookup for remove-listing. */
  itemId?: string
  /**
   * parentSku fallback when itemId is not yet known.
   * Matches SharedListingMembership.parentSku.
   */
  parentSku?: string
  intent: DeleteIntent
}

export interface DeleteTargetResult {
  sku: string
  intent: DeleteIntent
  /** Product IDs that were soft-deleted (deletedAt set). */
  softDeleted: string[]
  membershipsRemoved: number
  /** Whether the channel delist call succeeded (false = not implemented yet for eBay). */
  delisted: boolean
  /** Present only when this target errored; other targets are unaffected. */
  error?: string
}

// ── Minimal prisma interface (injectable for tests) ────────────────────────

interface ProductTable {
  findFirst(args: unknown): Promise<unknown>
  findMany(args: unknown): Promise<unknown[]>
  update(args: unknown): Promise<unknown>
  updateMany(args: unknown): Promise<{ count: number }>
}

interface MembershipTable {
  delete(args: unknown): Promise<unknown>
  deleteMany(args: unknown): Promise<{ count: number }>
  findMany(args: unknown): Promise<unknown[]>
}

export interface EbayDeletePrisma {
  product: ProductTable
  sharedListingMembership: MembershipTable
  $transaction<T>(
    fn: (tx: {
      product: ProductTable
      sharedListingMembership: MembershipTable
    }) => Promise<T>,
  ): Promise<T>
}

// ── Internal shape ─────────────────────────────────────────────────────────

type ProductRow = {
  id: string
  sku: string
  deletedAt: Date | null
  parentId?: string | null
  ebayItemId?: string | null
}

// ── Delist helper (best-effort, never throws) ──────────────────────────────

function buildDelistJob(
  itemId: string,
  marketplace: string,
  productId: string | null,
): ChannelDelistJob {
  return {
    // queueId is used only by applyDelistResultToQueue; passing a synthetic value
    // is safe since we never write to OutboundSyncQueue from this path.
    queueId: `p2d1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    productId,
    channelListingId: null,
    targetChannel: 'EBAY',
    targetRegion: marketplace,
    externalListingId: itemId,
    syncType: 'DELETE_LISTING',
    payload: { channelAction: 'delete' },
  }
}

async function tryDelist(
  itemId: string | null | undefined,
  marketplace: string,
  productId: string | null = null,
): Promise<boolean> {
  if (!itemId) return false
  try {
    const result = await dispatchChannelDelist(
      buildDelistJob(itemId, marketplace, productId),
    )
    if (!result.success) {
      logger.warn(
        'ebay-flat-file-delete: best-effort delist failed (non-fatal)',
        {
          itemId,
          marketplace,
          error: result.error,
          errorCode: result.errorCode,
        },
      )
    }
    return result.success
  } catch (err: unknown) {
    logger.warn('ebay-flat-file-delete: delist threw (non-fatal)', {
      itemId,
      marketplace,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

// ── Main export ────────────────────────────────────────────────────────────

/**
 * Execute one or more delete targets. Results are collected per-target;
 * a single target failing never aborts the remaining targets.
 */
export async function runEbayFlatFileDelete(
  prisma: EbayDeletePrisma,
  targets: DeleteTarget[],
  _opts?: Record<string, unknown>,
): Promise<DeleteTargetResult[]> {
  const results: DeleteTargetResult[] = []

  for (const target of targets) {
    try {
      const result = await processTarget(prisma, target)
      results.push(result)
    } catch (err: unknown) {
      results.push({
        sku: target.sku,
        intent: target.intent,
        softDeleted: [],
        membershipsRemoved: 0,
        delisted: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return results
}

// ── Intent dispatch ────────────────────────────────────────────────────────

async function processTarget(
  prisma: EbayDeletePrisma,
  target: DeleteTarget,
): Promise<DeleteTargetResult> {
  switch (target.intent) {
    case 'remove-listing':
      return handleRemoveListing(prisma, target)
    case 'delete-product':
      return handleDeleteProduct(prisma, target)
    case 'delete-family':
      return handleDeleteFamily(prisma, target)
    default: {
      // TypeScript exhaustiveness guard — unreachable at runtime if callers
      // validate before calling.
      const bad: never = target.intent
      return {
        sku: target.sku,
        intent: target.intent as DeleteIntent,
        softDeleted: [],
        membershipsRemoved: 0,
        delisted: false,
        error: `Unknown intent: ${bad}`,
      }
    }
  }
}

// ── remove-listing ─────────────────────────────────────────────────────────

async function handleRemoveListing(
  prisma: EbayDeletePrisma,
  target: DeleteTarget,
): Promise<DeleteTargetResult> {
  const { sku, marketplace, itemId, parentSku } = target

  if (!itemId && !parentSku) {
    return {
      sku,
      intent: 'remove-listing',
      softDeleted: [],
      membershipsRemoved: 0,
      delisted: false,
      error: 'remove-listing requires itemId or parentSku',
    }
  }

  let resolvedItemId: string | null = itemId ?? null
  let membershipsRemoved = 0

  if (itemId) {
    // Exact unique-key match: (marketplace, itemId, sku)
    await prisma.$transaction(async (tx) => {
      const del = await tx.sharedListingMembership.deleteMany({
        where: { marketplace, itemId, sku },
      } as any)
      membershipsRemoved = (del as { count: number }).count
    })
  } else {
    // itemId unknown — find via (marketplace, parentSku, sku) to get itemId for delist.
    const found = (await prisma.sharedListingMembership.findMany({
      where: { marketplace, parentSku: parentSku!, sku },
      select: { itemId: true },
    } as any)) as Array<{ itemId: string }>

    if (found.length > 0) resolvedItemId = found[0].itemId

    await prisma.$transaction(async (tx) => {
      const del = await tx.sharedListingMembership.deleteMany({
        where: { marketplace, parentSku: parentSku!, sku },
      } as any)
      membershipsRemoved = (del as { count: number }).count
    })
  }

  // Best-effort delist — Product is NOT soft-deleted.
  const delisted = await tryDelist(resolvedItemId, marketplace)

  return {
    sku,
    intent: 'remove-listing',
    softDeleted: [],
    membershipsRemoved,
    delisted,
  }
}

// ── delete-product ─────────────────────────────────────────────────────────

async function handleDeleteProduct(
  prisma: EbayDeletePrisma,
  target: DeleteTarget,
): Promise<DeleteTargetResult> {
  const { sku, marketplace, productId } = target
  const now = new Date()

  // Resolve — prefer productId FK, fall back to unique sku.
  const product = (await prisma.product.findFirst({
    where: productId ? { id: productId } : { sku },
    select: { id: true, sku: true, deletedAt: true, ebayItemId: true },
  } as any)) as ProductRow | null

  if (!product) {
    return {
      sku,
      intent: 'delete-product',
      softDeleted: [],
      membershipsRemoved: 0,
      delisted: false,
      error: `Product not found: ${productId ?? sku}`,
    }
  }

  // Idempotent — already soft-deleted → skip silently.
  if (product.deletedAt !== null) {
    return {
      sku: product.sku,
      intent: 'delete-product',
      softDeleted: [],
      membershipsRemoved: 0,
      delisted: false,
    }
  }

  // Collect item IDs for delist BEFORE the transaction deletes the memberships.
  // SKUs are unique in the Product table so sku-scoped deleteMany is unambiguous.
  const memberships = (await prisma.sharedListingMembership.findMany({
    where: { sku: product.sku },
    select: { itemId: true },
  } as any)) as Array<{ itemId: string }>

  let membershipsRemoved = 0

  await prisma.$transaction(async (tx) => {
    await tx.product.update({
      where: { id: product.id },
      data: { deletedAt: now },
    } as any)
    const del = await tx.sharedListingMembership.deleteMany({
      where: { sku: product.sku },
    } as any)
    membershipsRemoved = (del as { count: number }).count
  })

  // Best-effort delist for every eBay ItemID associated with this product.
  const delistIds = new Set<string>(
    [
      ...memberships.map((m) => m.itemId),
      product.ebayItemId ?? null,
    ].filter((x): x is string => Boolean(x)),
  )

  let delisted = false
  for (const iid of delistIds) {
    const ok = await tryDelist(iid, marketplace, product.id)
    if (ok) delisted = true
  }

  return {
    sku: product.sku,
    intent: 'delete-product',
    softDeleted: [product.id],
    membershipsRemoved,
    delisted,
  }
}

// ── delete-family ──────────────────────────────────────────────────────────

async function handleDeleteFamily(
  prisma: EbayDeletePrisma,
  target: DeleteTarget,
): Promise<DeleteTargetResult> {
  const { sku, marketplace, productId } = target
  const now = new Date()

  // Resolve parent — prefer productId FK, fall back to sku.
  const parent = (await prisma.product.findFirst({
    where: productId ? { id: productId } : { sku },
    select: { id: true, sku: true, deletedAt: true, ebayItemId: true },
  } as any)) as ProductRow | null

  if (!parent) {
    return {
      sku,
      intent: 'delete-family',
      softDeleted: [],
      membershipsRemoved: 0,
      delisted: false,
      error: `Product not found: ${productId ?? sku}`,
    }
  }

  // Idempotent — already soft-deleted → skip silently.
  if (parent.deletedAt !== null) {
    return {
      sku: parent.sku,
      intent: 'delete-family',
      softDeleted: [],
      membershipsRemoved: 0,
      delisted: false,
    }
  }

  // Find all non-deleted children (parentId = parent.id).
  const children = (await prisma.product.findMany({
    where: { parentId: parent.id, deletedAt: null },
    select: { id: true, sku: true, ebayItemId: true },
  } as any)) as Array<{ id: string; sku: string; ebayItemId?: string | null }>

  const childIds = children.map((c) => c.id)
  const allSkus = [parent.sku, ...children.map((c) => c.sku)]

  // Collect item IDs for delist BEFORE the transaction.
  const memberships = (await prisma.sharedListingMembership.findMany({
    where: { sku: { in: allSkus } },
    select: { itemId: true },
  } as any)) as Array<{ itemId: string }>

  let membershipsRemoved = 0

  await prisma.$transaction(async (tx) => {
    // Soft-delete parent.
    await tx.product.update({
      where: { id: parent.id },
      data: { deletedAt: now },
    } as any)

    // Soft-delete all non-deleted children in one shot (may be empty).
    if (childIds.length > 0) {
      await tx.product.updateMany({
        where: { id: { in: childIds } },
        data: { deletedAt: now },
      } as any)
    }

    // Delete memberships for parent + all children.
    const del = await tx.sharedListingMembership.deleteMany({
      where: { sku: { in: allSkus } },
    } as any)
    membershipsRemoved = (del as { count: number }).count
  })

  const softDeleted = [parent.id, ...childIds]

  // Best-effort delist for every eBay ItemID found.
  const delistIds = new Set<string>(
    [
      ...memberships.map((m) => m.itemId),
      parent.ebayItemId ?? null,
      ...children.map((c) => c.ebayItemId ?? null),
    ].filter((x): x is string => Boolean(x)),
  )

  let delisted = false
  for (const iid of delistIds) {
    const ok = await tryDelist(iid, marketplace)
    if (ok) delisted = true
  }

  return {
    sku: parent.sku,
    intent: 'delete-family',
    softDeleted,
    membershipsRemoved,
    delisted,
  }
}
