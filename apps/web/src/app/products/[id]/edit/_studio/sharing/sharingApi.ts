/**
 * Sharing studio step 2 — the "Other businesses" page's backend calls and the shapes they answer
 * (`apps/api/src/services/assortment/product-sharing.service.ts`, read through `GET /api/products/:id/sharing`).
 */
import type { LayoutGroupResult, ListingLayout } from '@/app/settings/sharing/layoutWords'
import { apiGet, apiSend, type ApiResult } from '../images/api'

export interface FollowedLink {
  id: string
  shareId: string
  sourceBusiness: string | null
  /** 'created': copied from the other business; 'matched': a product of this business linked by its SKU. */
  linkedBy: string
  status: string
  detachedReason: string | null
  heldSku: string | null
  heldReason: string | null
  heldAt: string | null
  lastSyncedAt: string | null
  lastSyncError: string | null
}

export interface SharedField {
  key: string
  label: string
  group: string
  locale: string | null
  state: 'follow' | 'override'
}

export interface AssortmentPlace {
  id: string
  name: string
  selection: 'list' | 'all'
  version: number
  holds: boolean
  openShares: number
}

export type CopyState = 'following' | 'detached' | 'not-copied'

export interface ShareCopy {
  shareId: string
  assortmentId: string
  assortmentName: string
  businessId: string
  businessName: string
  shareStatus: string
  copy: CopyState
  heldSku: string | null
  heldReason: string | null
  lastSyncedAt: string | null
  lastSyncError: string | null
  detachedReason: string | null
}

export interface LentUsage {
  workspaceId: string
  businessName: string
  heldNow: number
  sold30d: number
  putBack30d: number
}

export interface ProductSharing {
  product: { id: string; sku: string; rootId: string; rootSku: string; isVariation: boolean }
  following: { link: FollowedLink; fields: SharedField[] } | null
  sharedOut: { assortments: AssortmentPlace[]; businesses: ShareCopy[] }
  stock: {
    source: { kind: 'own' } | { kind: 'pool'; lenderName: string; available: number; products: number }
    lentTo: LentUsage[]
  }
}

export async function readSharing(productId: string, signal?: AbortSignal): Promise<ApiResult<ProductSharing>> {
  const result = await apiGet<{ sharing: ProductSharing }>(`/api/products/${encodeURIComponent(productId)}/sharing`, signal)
  return result.ok ? { ok: true, data: result.data.sharing } : result
}

/** "Follow again": stop keeping these fields (or every kept field); the next sync applies the other business's values. */
export function followAgain(linkId: string, fields: string[] | 'all') {
  return apiSend<{ success: true }>(`/api/catalog-links/${encodeURIComponent(linkId)}/follow-again`, 'POST', { fields })
}

/** Put the product into an assortment, or take it out, whatever the assortment's rule. */
export function setInAssortment(assortmentId: string, productId: string, holds: boolean, expectedVersion: number) {
  return apiSend<{ holds: boolean; version: number }>(`/api/assortments/${encodeURIComponent(assortmentId)}/product`, 'POST', { productId, holds, expectedVersion })
}

// ── Sharing studio step 3 — the shared product's listing layout, made here as drafts ─────────────────────────────

export async function readLayout(productId: string, signal?: AbortSignal): Promise<ApiResult<ListingLayout>> {
  const result = await apiGet<{ layout: ListingLayout }>(`/api/products/${encodeURIComponent(productId)}/sharing/layout`, signal)
  return result.ok ? { ok: true, data: result.data.layout } : result
}

/** Make the chosen groups here as drafts: per group, an account of this business or null (not made). */
export function applyLayout(productId: string, choices: Array<{ key: string; accountId: string | null }>) {
  return apiSend<{ results: LayoutGroupResult[] }>(`/api/products/${encodeURIComponent(productId)}/sharing/layout`, 'POST', { choices })
}
