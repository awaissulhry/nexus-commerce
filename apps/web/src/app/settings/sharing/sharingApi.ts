/**
 * Shared products (AE.2 + AE.3) — the calls this page makes and the shapes they answer with.
 * Routes: apps/api/src/routes/assortments.routes.ts. Plan: docs/2026-09-16-assortment-engine-plan.md §19.
 *
 * The installed fetch (lib/auth/install-fetch.ts) adds the business from the page URL, the session and
 * the CSRF token, so these calls carry nothing of their own.
 */
import { getBackendUrl } from '@/lib/backend-url'

export type Selection = 'list' | 'all'
export interface Assortment {
  id: string
  name: string
  description: string | null
  selection: Selection
  version: number
  memberCount: number
  openShareCount: number
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}
export interface AssortmentMember { productId: string; sku: string; name: string; mode: 'include' | 'exclude'; addedAt: string }

export type ShareStatus = 'pending' | 'active' | 'paused' | 'declined' | 'revoked'
export interface Share {
  id: string
  assortmentId: string
  /** Null when this business can no longer read the assortment (an ended share, on the receiving side). */
  assortmentName: string | null
  ownerWorkspaceId: string
  ownerWorkspaceName: string
  workspaceId: string
  workspaceName: string
  status: ShareStatus
  fieldGroups: string[]
  version: number
  createdAt: string
  respondedAt: string | null
  pausedAt: string | null
  endedAt: string | null
  endedBySide: 'owner' | 'follower' | null
  linkedProducts: number
}

export type RunState = 'preparing' | 'reviewing' | 'finishing' | 'done' | 'partial' | 'failed' | 'abandoned'
export interface RunCounts {
  linked: number; alreadyLinked: number; notSaved: number; linkRefused: number; managedApplied: number; managedFailed: number
  imagesCopied: number; imagesReused: number; imagesAddressed: number; imagesFailed: number; mediaNotCopied: number
}
export interface CopyRunSummary {
  id: string
  state: RunState
  market: string
  products: number
  skipped: number
  counts: RunCounts | null
  error: string | null
  createdAt: string
  finishedAt: string | null
}
export interface CopyRun {
  id: string
  shareId: string
  market: string
  state: RunState
  transferJobId: string | null
  transferJob: { state: string } | null
  counts: RunCounts | null
  error: string | null
  createdAt: string
  finishedAt: string | null
}

export type ProductOutcome =
  | { kind: 'new'; sku: string; sourceProductId: string; parentSku: string | null }
  | { kind: 'match'; sku: string; sourceProductId: string; parentSku: string | null; followerProductId: string; followerName: string }
  | { kind: 'linked'; sku: string; sourceProductId: string; parentSku: string | null; followerProductId: string }
  | { kind: 'blocked'; sku: string; sourceProductId: string; parentSku: string | null; reason: string }
export interface CopyPreview {
  shareId: string
  shareVersion: number
  market: string
  fieldGroups: string[]
  counts: { new: number; match: number; linked: number; blocked: number; images: number; mediaNotCopied: number }
  products: ProductOutcome[]
  create: {
    families: Array<{ code: string; label: string }>
    attributeGroups: Array<{ code: string; label: string }>
    attributes: Array<{ code: string; label: string; type: string }>
    options: Array<{ attributeCode: string; code: string; label: string }>
    familyAttributes: Array<{ familyCode: string; attributeCode: string }>
    categories: Array<{ path: string[]; names: string[] }>
  }
  conflicts: Array<{ kind: 'attribute_type'; code: string; label: string; source: string; follower: string }>
  /** Exactly one of `group` (not offered) and `reason` (never shared) is set. */
  excluded: Array<{ field: string; label: string; group: string | null; reason: string | null; rows: number }>
  imageBytes: number | null
  fingerprint: string
}

export class SharingError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) { super(message) }
}

/** GET without a body, POST with one. A refusal carries the API's own sentence and code. */
export async function sharingApi<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${getBackendUrl()}/api/${path}`, body === undefined
    ? { cache: 'no-store', signal }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.success === false) throw new SharingError(data.error ?? 'That could not be completed. Try again.', data.code, response.status)
  return data as T
}
