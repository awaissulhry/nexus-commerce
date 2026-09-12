/**
 * PES.6 — the mapping engine's fetchers.
 *
 * Every call is client-side: the API session cookie is cross-site, so a server fetch can never
 * authenticate (the same reason CE.1's loader is a client component). Each returns parsed JSON
 * or throws an Error carrying the server's own message — a screen that says "failed" without
 * saying what failed is the thing this page exists to replace.
 */

import { getBackendUrl } from '@/lib/backend-url'
import type {
  AiSuggestResult, CategoryMappingRow, CloneResult, ExprFunctionDoc, ExpressionRow,
  FieldCatalogue, FieldMappingRule, PreviewSku, ResolveBatchResult, SuggestResult, TemplateRow,
} from './contracts'

const base = () => `${getBackendUrl()}/api/pim`

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  // Declare a JSON content-type ONLY when there is a body. Fastify rejects a bodyless request
  // that claims `application/json` with `FST_ERR_CTP_EMPTY_JSON_BODY` (400), which silently
  // broke every DELETE on this page — unmapping a field, removing a category mapping, deleting
  // a business rule. The button fired, the request went out, and the server refused it before
  // the handler ever ran.
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) }
  if (init?.body != null && !headers['Content-Type']) headers['Content-Type'] = 'application/json'

  const r = await fetch(url, { credentials: 'include', ...init, headers })
  const text = await r.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { /* non-JSON error page */ }
  if (!r.ok) {
    const detail =
      body?.message ??
      (Array.isArray(body?.details) ? body.details.join('; ') : body?.details) ??
      body?.error ??
      text.slice(0, 200) ??
      `${r.status}`
    const err = new Error(detail) as Error & { status?: number; body?: unknown }
    err.status = r.status
    err.body = body
    throw err
  }
  return body as T
}

export const fetchTemplates = () =>
  json<{ templates: TemplateRow[] }>(`${base()}/channel-mapping/templates`).then((r) => r.templates)

export const fetchFunctions = () =>
  json<{ functions: ExprFunctionDoc[] }>(`${base()}/channel-mapping/functions`).then((r) => r.functions)

export const fetchCatalogue = (channel: string, code: string, productType?: string | null, accountId?: string | null) =>
  json<FieldCatalogue>(
    `${base()}/channel-mapping/${channel}/${code}/fields?${new URLSearchParams({ ...(productType ? { productType } : {}), ...(accountId ? { accountId } : {}) })}`,
  )

export const resolvePreview = (
  channel: string, code: string,
  body: { channelConnectionId?: string | null; aliasKey?: string; productIds: string[]; productType?: string | null; fieldKeys?: string[]; locale?: string; includeCatalogue?: boolean; candidate?: { fieldKey: string; rule: FieldMappingRule; expectedToken: string } },
) =>
  json<ResolveBatchResult>(`${base()}/channel-mapping/${channel}/${code}/resolve`, {
    method: 'POST',
    body: JSON.stringify(body),
  })

export interface MappingImpact {
  jobId: string; state: string; total: number; processed: number; page: number; pages: number
  channel: string; market: string; category: string | null; version: number; createdAt: string
  counts: { scanned: number; matchedProducts: number; affectedListings: number; matchedListings?: number; missing?: number; conflicts?: number; changed: number; preservedOverrides: number; invalid: number; introducedInvalid: number; excluded: number }
  rows: { productId: string; sku: string; listingId: string | null; accountId: string | null; aliasKey: string; market?: string; language?: string; field: string; before: unknown; after: unknown; source: string; changed: boolean; preserved: boolean; errors: string[] }[]
  restoreRevision?: { id: string; version: number }
  presentationChange?: { id: string; rule: PresentationRule | null };
  inputPolicy?: string; expression?: { name: string }; categoryChange?: { categoryId: string }; cloneSource?: { channel: string; market: string; cloned: number; skippedFields: string[] }
  errors?: { message: string }[]
}
export const createImpact = (channel: string, market: string, category: string | null, changes: { fieldKey: string; rule: FieldMappingRule | null }[], expectedToken: string) =>
  json<{ jobId: string }>(`${base()}/channel-mapping/${channel}/${market}/impact`, { method: 'POST', body: JSON.stringify({ category, changes, expectedToken }) })
export const readImpact = (id: string, page = 0, signal?: AbortSignal) => json<MappingImpact>(`${base()}/channel-mapping/impact/${encodeURIComponent(id)}?page=${page}`, { signal })
export const activateImpact = (id: string) => json<{ applied: boolean }>(`${base()}/channel-mapping/impact/${encodeURIComponent(id)}/activate`, { method: 'POST' })

export const searchPreviewSkus = (channel: string, code: string, q: string, productId?: string) =>
  json<{ skus: PreviewSku[] }>(
    `${base()}/channel-mapping/${channel}/${code}/preview-skus?q=${encodeURIComponent(q)}&limit=25${productId ? `&productId=${encodeURIComponent(productId)}` : ''}`,
  ).then((r) => r.skus)

export const fetchCategoryMappings = (channel: string, code: string) =>
  json<{ token: string; rows: CategoryMappingRow[]; counts: { total: number; mapped: number; inherited: number } }>(
    `${base()}/channel-mapping/${channel}/${code}/categories`,
  )

export const fetchChannelCategories = (channel: string, code: string) =>
  json<{ options: Array<{ id: string; label: string; hasSchema: boolean }>; note: string }>(
    `${base()}/channel-mapping/${channel}/${code}/channel-categories`,
  )

export const saveCategoryMapping = (
  channel: string, code: string, categoryId: string,
  body: { channelCategoryId: string; channelCategoryPath?: string | null; browseNodeId?: string | null; marketplace?: string },
) =>
  json<{ ok: true }>(`${base()}/channel-mapping/${channel}/${code}/categories/${categoryId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })

export const deleteCategoryMapping = (channel: string, code: string, categoryId: string) =>
  json<{ ok: true }>(`${base()}/channel-mapping/${channel}/${code}/categories/${categoryId}`, { method: 'DELETE' })

export const fetchExpressions = (channel: string, code: string) =>
  json<{ token: string; expressions: ExpressionRow[] }>(`${base()}/channel-mapping/${channel}/${code}/expressions`)

export const saveExpression = (channel: string, code: string, name: string, expr: string) =>
  json<{ ok: true; expressions: Record<string, string> }>(
    `${base()}/channel-mapping/${channel}/${code}/expressions/${encodeURIComponent(name)}`,
    { method: 'PUT', body: JSON.stringify({ expr }) },
  )

export const renameExpression = (channel: string, code: string, name: string, to: string) =>
  json<{ ok: true }>(
    `${base()}/channel-mapping/${channel}/${code}/expressions/${encodeURIComponent(name)}/rename`,
    { method: 'POST', body: JSON.stringify({ to }) },
  )

export const deleteExpression = (channel: string, code: string, name: string, force = false) =>
  json<{ ok: true }>(
    `${base()}/channel-mapping/${channel}/${code}/expressions/${encodeURIComponent(name)}${force ? '?force=true' : ''}`,
    { method: 'DELETE' },
  )

export const validateExpression = (expr: string) =>
  json<{ ok: boolean; error: { message: string; pos: number } | null; dependencies: { attributes: string[]; rules: string[] } | null }>(
    `${base()}/channel-mapping/expressions/validate`,
    { method: 'POST', body: JSON.stringify({ expr }) },
  )

// ── Rule writes reuse the EXISTING endpoints, so every edit still records a MappingRevision
//    and stays rollback-able. PES.6 adds no second write path.
export const saveRule = (
  channel: string, code: string, fieldKey: string, rule: FieldMappingRule, productType?: string | null,
) =>
  json<{ ok: true; rule: FieldMappingRule }>(
    `${base()}/mappings/${channel}/${code}/${encodeURIComponent(fieldKey)}${productType ? `?productType=${encodeURIComponent(productType)}` : ''}`,
    { method: 'PUT', body: JSON.stringify(rule) },
  )

export const deleteRule = (channel: string, code: string, fieldKey: string, productType?: string | null) =>
  json<{ ok: true }>(
    `${base()}/mappings/${channel}/${code}/${encodeURIComponent(fieldKey)}${productType ? `?productType=${encodeURIComponent(productType)}` : ''}`,
    { method: 'DELETE' },
  )

export interface SourceOption {
  path: string
  group: string
  source: string
  sampleValue: string | null
  hasValue: boolean
}

/** What an operator can map FROM, read off a real product through the same resolver the rules
 *  use — so every path offered is one that will actually resolve. */
export const fetchSources = (channel: string, code: string, productId?: string | null) =>
  json<{
    sources: SourceOption[]
    sampledFrom: { productId: string; sku: string; name: string | null } | null
    note: string | null
  }>(
    `${base()}/channel-mapping/${channel}/${code}/sources${productId ? `?productId=${encodeURIComponent(productId)}` : ''}`,
  )

// ── Auto-map (6.24) ────────────────────────────────────────────────
// Both halves are READ-ONLY proposals. Nothing is written until the operator applies the
// selection through the bulk endpoint below — that is what "review-gated" means here.

export const fetchSuggestions = (channel: string, code: string, productType?: string | null, productId?: string | null) =>
  json<SuggestResult>(
    `${base()}/mappings/${channel}/${code}/suggest?${new URLSearchParams({ ...(productType ? { productType } : {}), ...(productId ? { productId } : {}) })}`,
  )

export const fetchAiSuggestions = (channel: string, code: string, productType?: string | null, productId?: string | null) =>
  json<AiSuggestResult>(
    `${base()}/mappings/${channel}/${code}/suggest-ai?${new URLSearchParams({ ...(productType ? { productType } : {}), ...(productId ? { productId } : {}) })}`,
    { method: 'POST', body: JSON.stringify({}) },
  )

/** Apply many rules in ONE revision — so an auto-map is a single rollback point, not N. */
export const applyRules = (
  channel: string, code: string,
  rules: Array<{ fieldKey: string; rule: FieldMappingRule }>,
  productType?: string | null,
) =>
  json<{ ok: true; count: number }>(
    `${base()}/mappings/${channel}/${code}/bulk${productType ? `?productType=${encodeURIComponent(productType)}` : ''}`,
    { method: 'POST', body: JSON.stringify({ rules }) },
  )

// ── Clone to other markets (6.26) ──────────────────────────────────
export const cloneMapping = (body: {
  from: { channel: string; code: string }
  targets: Array<{ channel: string; code: string }>
  productType?: string | null
  addTranslate?: boolean
}) =>
  json<CloneResult>(`${base()}/mappings/clone`, { method: 'POST', body: JSON.stringify(body) })

export const createConfigurationImpact = (channel: string, market: string, expectedToken: string, draft: {
  restoreRevisionId?: string
  expression?: { name: string; expr: string | null; previousName?: string }
  categoryChange?: { categoryId: string; channelCategoryId: string | null; expectedTaxonomySnapshotId?: string }
  clone?: { channel: string; market: string; token: string; addTranslate?: boolean }
  category?: string | null
}) => json<{ jobId: string }>(`${base()}/channel-mapping/${channel}/${market}/impact`, { method: 'POST', body: JSON.stringify({ expectedToken, ...draft }) })

export interface PresentationRule {
  id: string; name: string; version: number; priority: number
  scope: { accountId?: string; familyId?: string; sharedCategoryId?: string; marketplaceCategoryId?: string }
  themeId?: string
  order?: { axes: string[]; values: Record<string, string[]> }
}
export const fetchPresentationRules = (market: string, signal?: AbortSignal) => json<{ token: string; rules: PresentationRule[]; orderActivationAvailable: boolean }>(`${base()}/channel-mapping/EBAY/${encodeURIComponent(market)}/presentation`, { signal })
export const reviewPresentationRule = (market: string, expectedToken: string, id: string, rule: PresentationRule | null) => json<{ jobId: string }>(`${base()}/channel-mapping/EBAY/${encodeURIComponent(market)}/impact`, { method: 'POST', body: JSON.stringify({ expectedToken, presentationChange: { id, rule } }) })
export const reviewOneTimeAssignment = (id: string) => json<{ jobId: string; href: string }>(`${base()}/channel-mapping/impact/${encodeURIComponent(id)}/assign-once`, { method: 'POST' })

export const fetchMappingHistory = (channel: string, code: string) => json<{
  revisions: { id: string; version: number; changedBy: string | null; reason: string | null; createdAt: string }[]
  reviews: { id: string; status: string; createdAt: string; total: number; processed: number }[]
}>(`${base()}/mappings/${channel}/${code}/revisions`)

export interface PreviewListing { id: string; channel: string; marketplace: string; channelConnectionId: string | null; aliasKey: string; accountName: string | null }
export const fetchPreviewListings = (productId: string) => json<{ listings: PreviewListing[] }>(`${getBackendUrl()}/api/products/${encodeURIComponent(productId)}/listings`).then(r => r.listings)
