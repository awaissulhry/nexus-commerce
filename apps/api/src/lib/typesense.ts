/**
 * Typesense client + collection definition for the PIM read engine.
 *
 * Why a thin fetch wrapper instead of the official `typesense` package:
 *   • Zero new runtime dependency — keeps the build green and the boot
 *     path clean. The surface we need (health / collections / upsert /
 *     bulk import / delete / search) is a handful of REST calls.
 *   • Mirrors the lazy-Redis discipline in lib/queue.ts: nothing dials
 *     out at module load, so the API boots fine when Typesense is
 *     unreachable. The search path is feature-gated and falls back to
 *     ProductReadCache, so an outage is degraded-but-correct, never fatal.
 *
 * Config (all required for the engine to be considered "configured"):
 *   TYPESENSE_HOST  TYPESENSE_PORT  TYPESENSE_PROTOCOL  TYPESENSE_API_KEY
 * Master gate:
 *   SEARCH_ENGINE_ENABLED=1   (also gates the indexer enqueue + worker)
 */

import { logger } from '../utils/logger.js'

export const PRODUCTS_COLLECTION = 'products'

/** True when SEARCH_ENGINE_ENABLED=1 AND all connection vars are present. */
export function isSearchConfigured(): boolean {
  return (
    process.env.SEARCH_ENGINE_ENABLED === '1' &&
    !!process.env.TYPESENSE_HOST &&
    !!process.env.TYPESENSE_API_KEY
  )
}

function baseUrl(): string {
  const protocol = process.env.TYPESENSE_PROTOCOL || 'http'
  const host = process.env.TYPESENSE_HOST || 'localhost'
  const port = process.env.TYPESENSE_PORT || '8108'
  return `${protocol}://${host}:${port}`
}

async function ts(
  path: string,
  init: RequestInit & { rawBody?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'X-TYPESENSE-API-KEY': process.env.TYPESENSE_API_KEY || '',
    ...(init.headers as Record<string, string> | undefined),
  }
  if (!init.rawBody && init.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json'
  }
  return fetch(`${baseUrl()}${path}`, {
    ...init,
    headers,
    body: init.rawBody ?? init.body,
    // Don't let a hung Typesense wedge a request worker.
    signal: AbortSignal.timeout(Number(process.env.TYPESENSE_TIMEOUT_MS) || 5000),
  })
}

/** GET /health → true when the node answers ok. Never throws. */
export async function searchHealthy(): Promise<boolean> {
  if (!isSearchConfigured()) return false
  try {
    const res = await ts('/health', { method: 'GET' })
    if (!res.ok) return false
    const body = (await res.json()) as { ok?: boolean }
    return body.ok === true
  } catch {
    return false
  }
}

// ── Collection schema ────────────────────────────────────────────────────
// Mirrors ProductReadCache columns 1:1 (plus name_it for Italian search) so
// the Typesense doc and the Postgres fallback row are interchangeable.
const PRODUCTS_SCHEMA = {
  name: PRODUCTS_COLLECTION,
  default_sorting_field: 'updatedAt',
  enable_nested_fields: false,
  fields: [
    { name: 'sku', type: 'string', sort: true },
    { name: 'name', type: 'string', sort: true },
    { name: 'name_it', type: 'string', optional: true },
    { name: 'brand', type: 'string', facet: true, optional: true },
    { name: 'productType', type: 'string', facet: true, optional: true },
    { name: 'status', type: 'string', facet: true },
    { name: 'fulfillmentMethod', type: 'string', facet: true, optional: true },
    { name: 'isParent', type: 'bool', facet: true },
    // Derived: parentId != null. Lets the grid's default "hide children"
    // view filter isChild:=false (optional parentId can't be null-filtered).
    { name: 'isChild', type: 'bool', facet: true },
    { name: 'parentId', type: 'string', facet: true, optional: true },
    { name: 'familyId', type: 'string', facet: true, optional: true },
    { name: 'workflowStageId', type: 'string', facet: true, optional: true },
    { name: 'channelKeys', type: 'string[]', facet: true },
    { name: 'categoryIds', type: 'string[]', facet: true },
    { name: 'primaryCategoryId', type: 'string', facet: true, optional: true },
    { name: 'hasPhotos', type: 'bool', facet: true },
    { name: 'hasDescription', type: 'bool', facet: true },
    { name: 'hasBrand', type: 'bool', facet: true },
    { name: 'hasGtin', type: 'bool', facet: true },
    { name: 'driftCount', type: 'int32', facet: true },
    { name: 'photoCount', type: 'int32' },
    { name: 'channelCount', type: 'int32' },
    { name: 'variantCount', type: 'int32' },
    { name: 'childCount', type: 'int32' },
    { name: 'basePrice', type: 'float', optional: true },
    { name: 'totalStock', type: 'int32' },
    { name: 'imageUrl', type: 'string', optional: true },
    { name: 'createdAt', type: 'int64' },
    { name: 'updatedAt', type: 'int64' },
    // 0 when not soft-deleted; the search route filters deletedAt:=0.
    { name: 'deletedAt', type: 'int64' },
  ],
}

/** Create the products collection if it doesn't exist. Idempotent. */
export async function ensureCollection(): Promise<void> {
  if (!isSearchConfigured()) return
  const existing = await ts(`/collections/${PRODUCTS_COLLECTION}`, {
    method: 'GET',
  })
  if (existing.ok) return
  if (existing.status !== 404) {
    logger.warn('[typesense] unexpected status checking collection', {
      status: existing.status,
    })
  }
  const created = await ts('/collections', {
    method: 'POST',
    body: JSON.stringify(PRODUCTS_SCHEMA),
  })
  if (!created.ok && created.status !== 409) {
    throw new Error(
      `[typesense] failed to create collection: ${created.status} ${await created.text()}`,
    )
  }
}

export type ProductSearchDoc = {
  id: string
  sku: string
  name: string
  name_it?: string
  brand?: string
  productType?: string
  status: string
  fulfillmentMethod?: string
  isParent: boolean
  isChild: boolean
  parentId?: string
  familyId?: string
  workflowStageId?: string
  channelKeys: string[]
  categoryIds: string[]
  primaryCategoryId?: string
  hasPhotos: boolean
  hasDescription: boolean
  hasBrand: boolean
  hasGtin: boolean
  driftCount: number
  photoCount: number
  channelCount: number
  variantCount: number
  childCount: number
  basePrice?: number
  totalStock: number
  imageUrl?: string
  createdAt: number
  updatedAt: number
  deletedAt: number
}

/** Upsert a single document. */
export async function upsertDocument(doc: ProductSearchDoc): Promise<void> {
  const res = await ts(
    `/collections/${PRODUCTS_COLLECTION}/documents?action=upsert`,
    { method: 'POST', body: JSON.stringify(doc) },
  )
  if (!res.ok) {
    throw new Error(
      `[typesense] upsert failed: ${res.status} ${await res.text()}`,
    )
  }
}

/** Bulk upsert via the JSONL import endpoint. Returns failed-line count. */
export async function importDocuments(
  docs: ProductSearchDoc[],
): Promise<number> {
  if (docs.length === 0) return 0
  const jsonl = docs.map((d) => JSON.stringify(d)).join('\n')
  const res = await ts(
    `/collections/${PRODUCTS_COLLECTION}/documents/import?action=upsert`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      rawBody: jsonl,
    },
  )
  if (!res.ok) {
    throw new Error(
      `[typesense] import failed: ${res.status} ${await res.text()}`,
    )
  }
  // Import returns one JSON result per line; count any with success=false.
  const text = await res.text()
  let failed = 0
  for (const line of text.split('\n')) {
    if (line && line.includes('"success":false')) failed++
  }
  return failed
}

/** Delete a single document. 404 is treated as success (already gone). */
export async function deleteDocument(id: string): Promise<void> {
  const res = await ts(
    `/collections/${PRODUCTS_COLLECTION}/documents/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  )
  if (!res.ok && res.status !== 404) {
    throw new Error(
      `[typesense] delete failed: ${res.status} ${await res.text()}`,
    )
  }
}

export type TypesenseSearchResult = {
  found: number
  page: number
  hits: Array<{ document: ProductSearchDoc }>
  facet_counts?: Array<{
    field_name: string
    counts: Array<{ value: string; count: number }>
  }>
}

/** Run a search. `params` is the Typesense search querystring object. */
export async function searchProducts(
  params: Record<string, string | number | boolean>,
): Promise<TypesenseSearchResult> {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v))
  const res = await ts(
    `/collections/${PRODUCTS_COLLECTION}/documents/search?${qs.toString()}`,
    { method: 'GET' },
  )
  if (!res.ok) {
    throw new Error(
      `[typesense] search failed: ${res.status} ${await res.text()}`,
    )
  }
  return (await res.json()) as TypesenseSearchResult
}

/** Count of indexed documents (for backfill verification). */
export async function documentCount(): Promise<number> {
  const res = await ts(`/collections/${PRODUCTS_COLLECTION}`, { method: 'GET' })
  if (!res.ok) return -1
  const body = (await res.json()) as { num_documents?: number }
  return body.num_documents ?? -1
}
