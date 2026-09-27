import { z } from 'zod'
import type { MediaOp, MediaSetRef } from '@nexus/shared/media-plan'
import type { ProductMediaQuery } from '@nexus/shared/product-media'
import { getBackendUrl } from '@/lib/backend-url'

/**
 * Images rebuild P3c — copy, paste and fill of the "Product media" cell for a family on the photo plan (PLAN.md §5.7).
 * The cell of a plan row stands for ONE set (Common on the parent, the value's set or the SKU's own set on a variant);
 * copying it copies that set's photos, pasting writes them into the target row's set on the sheet's layer. The older
 * gallery clipboard (`NEXUS_PRODUCT_MEDIA_V1:`) and this one never mix: their photo ids live in different stores.
 */

const PREFIX = 'NEXUS_MEDIA_PLAN_V1:'
const snapshotSchema = z.object({
  productId: z.string().min(1).max(256),
  set: z.string().min(1).max(320),
  label: z.string().max(300),
  items: z.array(z.string().min(1).max(256)).max(250),
}).strict()
export type PlanCellSnapshot = z.infer<typeof snapshotSchema>

/** The row's own photos: a variant's Common photos are shown muted and are not part of its set. */
export function planCellSnapshot(row: { id: string; productId?: string; productMedia?: Array<{ id: string; muted?: boolean }>; productMediaSet?: { ref: string; label: string } }): PlanCellSnapshot | null {
  if (!row.productMediaSet) return null
  return { productId: row.productId ?? row.id, set: row.productMediaSet.ref, label: row.productMediaSet.label, items: (row.productMedia ?? []).filter(item => !item.muted).map(item => item.id) }
}
export function planClipboardValue(value: PlanCellSnapshot) { return PREFIX + JSON.stringify(value) }
export function readPlanClipboard(value: unknown): PlanCellSnapshot | null {
  if (typeof value !== 'string' || !value.startsWith(PREFIX) || value.length > 100000) return null
  try { return snapshotSchema.parse(JSON.parse(value.slice(PREFIX.length))) } catch { return null }
}

export type PlanAddress = { layer: 'SHARED' } | { layer: 'LISTING'; channel: string; marketplace: string; accountId: string; aliasKey: string }
/** The layer a sheet edits: Shared on the product (master) sheet, the listing's own layer on a channel sheet. */
export function planAddress(context: ProductMediaQuery): PlanAddress | null {
  if (context.scope === 'MASTER') return { layer: 'SHARED' }
  if (!context.accountId) return null
  return { layer: 'LISTING', channel: context.scope, marketplace: context.market, accountId: context.accountId, aliasKey: context.aliasKey ?? '' }
}

/** Paste = the target set gets exactly the source's photos, in order. Nothing to do when it already has them. */
export function pasteOps(source: PlanCellSnapshot, target: PlanCellSnapshot): MediaOp[] {
  if (JSON.stringify(source.items) === JSON.stringify(target.items)) return []
  return [{ op: 'replace', set: target.set as MediaSetRef, assetIds: source.items }]
}

export async function sendPlanOps(productId: string, address: PlanAddress, ops: MediaOp[]) {
  const res = await fetch(`${getBackendUrl()}/api/products/${encodeURIComponent(productId)}/media/ops`, {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address, ops }), signal: AbortSignal.timeout(30000),
  })
  const value = await res.json().catch(() => null)
  if (!res.ok || !value) throw new Error(value?.error ?? 'The photo change could not be confirmed. Reload the sheet before trying again.')
  return value as { rootId: string; key: string; revision: number }
}
