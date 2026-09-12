'use client'

/**
 * PES.2 / F2 — the family WRITE endpoints, described as they actually behave.
 *
 * Existing endpoints retain their wire paths and per-child attach results. Relationship writes
 * validate current membership and alias ownership in a transaction. Empty parents retain their
 * role; explicit demotion detaches only the exact children reviewed by the operator. Unlink keeps
 * axis values. Child deletion is local only and refuses remote listings or alias ownership.
 */

import { getBackendUrl } from '@/lib/backend-url'

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${getBackendUrl()}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const parsed = await res.json().catch(() => null)
  // The server's own words, never a rewrite — a family verb fails for reasons an operator can act
  // on ("GALE-JACKET is itself a child — pick a top-level parent") and paraphrasing loses them.
  if (!res.ok) throw new Error(parsed?.error?.message || parsed?.error || `HTTP ${res.status}`)
  return parsed as T
}

export interface AttachResult {
  success: boolean
  /** How many actually landed. Never assume this equals what you sent. */
  attached: number
  errors: Array<{ productId: string; error: string }>
  parentId: string
}

export interface UnlinkResult {
  success: boolean
  /** Rows the WHERE matched. A row already detached counts here, so this is not "rows changed". */
  detached: number
}

export interface ReparentResult {
  success: boolean
  productId: string
  newParentId: string
  /** The previous parent retains its role, even when its last child moves. */
  oldParentId: string | null
}

export interface PromoteResult { success: boolean; productId: string }

export interface DeleteVariantResult { success: boolean }

export interface AddVariationResult {
  success: boolean
  /** The created product, when the server returns it. */
  data?: { id?: string; sku?: string }
}

export interface DemoteResult { success: boolean; productId: string }

/**
 * One channel listing, as much of it as a preflight needs.
 *
 * 🔴 `externalListingId` is the field that decides whether something real exists on the
 * marketplace — Amazon's ASIN, eBay's ItemID. `status` is NOT that field, and PES.3 measured the
 * gap: all 20 of a family's non-ACTIVE eBay rows still carried a real ItemID. A preflight that
 * asked `status === 'ACTIVE'` would have reported 20 live listings as safe to destroy.
 */
export interface ListingRow {
  channel: string
  marketplace: string
  listingStatus: string | null
  externalListingId: string | null
  isPublished: boolean | null
}

export interface FamilyOps {
  /**
   * What this product carries on the channels — the preflight read behind the delete confirm.
   *
   * `/products/:id/listings` exists and is the obvious choice; it is NOT used, because it selects
   * a whitelist that omits `externalListingId`. A confirm built on it could only ask about status,
   * which is the exact field that lies here.
   */
  listings(productId: string): Promise<ListingRow[]>
  attach(parentId: string, productIds: string[], axisValues?: Record<string, Record<string, string>>): Promise<AttachResult>
  unlink(productIds: string[], expectedParentId?: string): Promise<UnlinkResult>
  reparent(productId: string, newParentId: string, expectedParentId?: string): Promise<ReparentResult>
  promote(productId: string, variationTheme?: string, variationAxes?: string[]): Promise<PromoteResult>
  /**
   * Create a variation under this parent.
   *
   * 🔴 The new product is created as a draft with channel sync disabled — a
   * child must be reviewed before publication. Nothing in the verb's name says so,
   * which is why the confirmation does.
   *
   * `copyFromProductId` clones a sibling's channel listings (content + attributes, with the
   * axis-specific SP-API fields stripped) so a new variation starts with shared content and its
   * own identifiers.
   */
  addVariation(parentId: string, body: {
    sku: string
    name: string
    basePrice?: number
    totalStock?: number
    variantAttributes?: Record<string, string>
    copyFromProductId?: string
    copyGroups?: string[]
  }): Promise<AddVariationResult>
  /** Hard deletion is refused while alias or remote listing records remain. */
  deleteVariant(parentId: string, childId: string): Promise<DeleteVariantResult>
  /** 409s when children exist unless `force` — and `force` ORPHANS every one of them. */
  demoteParent(productId: string, force?: boolean, expectedChildIds?: string[]): Promise<DemoteResult>
}

/** The server's cap, mirrored so the client can refuse before spending a round trip saying so. */
export const ATTACH_MAX = 200
export const UNLINK_MAX = 200

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${getBackendUrl()}${path}`, { credentials: 'include', cache: 'no-store' })
  const parsed = await res.json().catch(() => null)
  if (!res.ok) throw new Error(parsed?.error?.message || parsed?.error || `HTTP ${res.status}`)
  return parsed as T
}

async function del<T>(path: string): Promise<T> {
  // No body and no Content-Type: a bodyless DELETE sent with a JSON content-type 400s in Fastify,
  // and the symptom is "the button did nothing" (reference_fastify_route_param_and_delete_traps).
  const res = await fetch(`${getBackendUrl()}${path}`, { method: 'DELETE', credentials: 'include' })
  const parsed = await res.json().catch(() => null)
  if (!res.ok) throw new Error(parsed?.error?.message || parsed?.error?.message || parsed?.error || `HTTP ${res.status}`)
  return parsed as T
}

export const familyOps: FamilyOps = {
  listings: async (productId) => {
    // Grouped by channel, so it is flattened here rather than by every caller.
    const grouped = await get<Record<string, ListingRow[]>>(`/api/products/${encodeURIComponent(productId)}/all-listings`)
    return Object.values(grouped ?? {}).flat().filter((l): l is ListingRow => !!l)
  },

  attach: (parentId, productIds, axisValues) =>
    post<AttachResult>('/api/pim/attach-to-parent', { parentId, productIds, ...(axisValues ? { axisValues } : {}) }),

  // 🔴 /api/amazon, not /api/pim. See the header — there is no PIM-namespaced unlink.
  unlink: (productIds, expectedParentId) => post<UnlinkResult>('/api/amazon/pim/unlink-child', { productIds, expectedParentId }),

  reparent: (productId, newParentId, expectedParentId) => post<ReparentResult>('/api/pim/reparent', { productId, newParentId, expectedParentId }),

  // 🔴 /api/catalog, not /api/products — same prefix trap as the delete below.
  addVariation: (parentId, body) =>
    post<AddVariationResult>(`/api/catalog/products/${encodeURIComponent(parentId)}/children`, body),

  // 🔴 /api/catalog, not /api/products. See the header — the handler's own comment is wrong.
  deleteVariant: (parentId, childId) =>
    del<DeleteVariantResult>(`/api/catalog/products/${encodeURIComponent(parentId)}/children/${encodeURIComponent(childId)}`),

  demoteParent: (productId, force, expectedChildIds) => post<DemoteResult>('/api/pim/demote-parent', { productId, ...(force ? { force: true, expectedChildIds } : {}) }),

  promote: (productId, variationTheme, variationAxes) =>
    post<PromoteResult>('/api/pim/promote-to-parent', {
      productId,
      ...(variationTheme ? { variationTheme } : {}),
      ...(variationAxes?.length ? { variationAxes } : {}),
    }),
}
