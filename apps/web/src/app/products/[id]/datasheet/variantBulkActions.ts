'use server'

/**
 * VR.9 — Server actions for bulk variant operations.
 *
 * Today: bulk status toggle (ACTIVE ↔ INACTIVE) on selected child
 * variants. The most reversible bulk action — one Product field,
 * trivial to undo. Bulk pricing changes and bulk create-stub-
 * listings (deferred from VR.5) land in follow-up phases because
 * each carries enough domain risk to deserve its own server
 * action + confirmation UX.
 *
 * Authorization: this hub page is reachable from any authenticated
 * operator session today. When per-user permission scopes land
 * (settings/security work), gate this action on the equivalent of
 * "products.write". For now: the existing session middleware that
 * protects /products/[id]/datasheet protects this action too.
 *
 * Audit: writes a single batched updateMany with the same
 * timestamp on every affected row so `Product.updatedAt` reflects
 * the bulk operation cleanly. The version field bumps via Prisma's
 * Int @default(1) + manual increment so optimistic-concurrency
 * (NN.1) sees the change. ChangeLog substrate (ATM.12) will pick
 * up the trail when it lands.
 */

import { prisma } from '@nexus/database'
import { revalidatePath } from 'next/cache'

export type BulkStatus = 'ACTIVE' | 'INACTIVE'

export interface BulkStatusResult {
  ok: boolean
  affected: number
  error?: string
}

/**
 * Flip status across a set of variants in one transaction. The
 * parentId check prevents an operator from accidentally (or
 * maliciously) flipping unrelated products by tampering with the
 * variantIds payload from a different SKU's URL.
 */
export async function bulkSetVariantStatus(
  parentId: string,
  variantIds: string[],
  newStatus: BulkStatus,
): Promise<BulkStatusResult> {
  if (variantIds.length === 0) {
    return { ok: false, affected: 0, error: 'No variants selected' }
  }
  // Hard cap: refuse if the operator selects more than 200. Bulk at
  // catalog scale should go through /bulk-operations, not here.
  if (variantIds.length > 200) {
    return {
      ok: false,
      affected: 0,
      error: 'Selection exceeds 200 variants — use Bulk Operations',
    }
  }

  try {
    const result = await prisma.product.updateMany({
      where: {
        id: { in: variantIds },
        // Defensive scope guard: only flip variants that actually
        // belong to this parent. A tampered payload that includes
        // foreign IDs gets silently filtered to the legitimate set.
        parentId,
      },
      data: {
        status: newStatus,
        // NN.1 — bump version for optimistic-concurrency clients.
        version: { increment: 1 },
      },
    })

    // Revalidate the hub page so the variant rows pick up the new
    // status on the next render. The path includes [id] which Next
    // expands to the actual parent when called.
    revalidatePath(`/products/${parentId}/datasheet`)

    return { ok: true, affected: result.count }
  } catch (e: unknown) {
    console.error('[vr.9] bulkSetVariantStatus failed', e)
    const msg = e instanceof Error ? e.message : 'Bulk update failed'
    return { ok: false, affected: 0, error: msg }
  }
}
