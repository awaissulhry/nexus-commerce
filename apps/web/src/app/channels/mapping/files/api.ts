/**
 * CHMAP — the File mappings view's fetchers (`apps/api/src/routes/channel-mapping-sets.routes.ts`).
 *
 * Client-side only, through the page's own `json` helper: the session cookie is cross-site, and the
 * helper already throws an Error carrying the server's own sentence (`{ error }`) and its HTTP status —
 * which is what the screen shows, verbatim. A 409 (the version is not a draft, or a required column
 * is open) is therefore an ordinary thrown error with `status === 409`.
 */
import { getBackendUrl } from '@/lib/backend-url'
import type { MappingDiff, MappingPushImpact, MappingSetDetail, MappingSetSummary } from '@nexus/shared/channel-mapping'
import { json } from '../_shared/api'
import { filenameFromDisposition, parseExportSummary, type DecisionBody, type ExportSummary, type ShopifyFilePreview, type TemplateUploadResult } from './model'

const base = () => `${getBackendUrl()}/api/pim/channel-mapping-sets`
const id = (value: string) => encodeURIComponent(value)

/** A field a column can be mapped to: the channel spec of every product type (or category) of the form. */
export interface MappingTarget {
  key: string
  label: string
  englishLabel: string | null
  requirement: string
  shape: string
  kind: string
  productTypes: string[]
}

/** One import, export or push that read a version. `detail` holds what that run recorded (rows, excluded, refused…). */
export interface MappingUse {
  id: string
  action: string
  reference: string | null
  detail: unknown
  createdAt: string
}

export const listMappingSets = (signal?: AbortSignal) =>
  json<{ sets: MappingSetSummary[] }>(base(), { signal }).then(r => r.sets)

export const readMappingSet = (setId: string, signal?: AbortSignal) =>
  json<{ set: MappingSetDetail; uses: MappingUse[] }>(`${base()}/${id(setId)}`, { signal })

/** `older` is read as the earlier version: `added` = columns `newer` has and `older` has not. */
export const diffMappingSets = (newerId: string, olderId: string, signal?: AbortSignal) =>
  json<{ diff: MappingDiff }>(`${base()}/${id(newerId)}/diff/${id(olderId)}`, { signal }).then(r => r.diff)

export const readMappingTargets = (setId: string, signal?: AbortSignal) =>
  json<{ targets: MappingTarget[]; missingSchemas: string[] }>(`${base()}/${id(setId)}/targets`, { signal })

export const decideMappingField = (setId: string, body: DecisionBody) =>
  json<{ set: MappingSetDetail }>(`${base()}/${id(setId)}/fields`, { method: 'PATCH', body: JSON.stringify(body) }).then(r => r.set)

export const newMappingVersion = (setId: string) =>
  json<{ set: MappingSetDetail }>(`${base()}/${id(setId)}/versions`, { method: 'POST' }).then(r => r.set)

/** What the push starts or stops sending if this version replaces the form's active one, or is retired (read only). */
export const readPushImpact = (setId: string, on: 'activate' | 'retire' = 'activate', signal?: AbortSignal) =>
  json<{ impact: MappingPushImpact }>(`${base()}/${id(setId)}/push-impact${on === 'retire' ? '?on=retire' : ''}`, { signal }).then(r => r.impact)

export const activateMappingSet = (setId: string) =>
  json<{ set: MappingSetDetail }>(`${base()}/${id(setId)}/activate`, { method: 'POST' }).then(r => r.set)

export const retireMappingSet = (setId: string) =>
  json<{ set: MappingSetDetail }>(`${base()}/${id(setId)}/retire`, { method: 'POST' }).then(r => r.set)

/** A refusal from a response that is not the page's JSON helper: the server's `{ error }` sentence, verbatim. */
async function refusal(r: Response): Promise<Error & { status: number }> {
  const text = await r.text().catch(() => '')
  let body: { error?: unknown; message?: unknown } | null = null
  try { body = text ? JSON.parse(text) : null } catch { /* not JSON */ }
  const message = typeof body?.error === 'string' ? body.error : typeof body?.message === 'string' ? body.message : text.slice(0, 200) || `${r.status} ${r.statusText}`
  return Object.assign(new Error(message), { status: r.status })
}

export interface ExportedFile { blob: Blob; filename: string | null; summary: ExportSummary | null }

/**
 * Write a channel file through an ACTIVE version. The body is the file; what it holds comes back in
 * `X-Nexus-Export-Summary` and its name in `Content-Disposition` — both null when the response does not
 * carry them (or a cross-origin response does not expose them), never guessed.
 */
export async function exportMappingSet(setId: string, body: { skus: string[]; includePrices?: boolean }): Promise<ExportedFile> {
  const r = await fetch(`${base()}/${id(setId)}/export`, {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!r.ok) throw await refusal(r)
  return {
    blob: await r.blob(),
    filename: filenameFromDisposition(r.headers.get('Content-Disposition')),
    summary: parseExportSummary(r.headers.get('X-Nexus-Export-Summary')),
  }
}

/** Store an Amazon template once (multipart field `file`); the answer names the version it reads with. */
export async function uploadAmazonTemplate(file: File): Promise<TemplateUploadResult> {
  const form = new FormData()
  form.append('file', file)
  // No Content-Type: the browser writes the multipart boundary itself.
  const r = await fetch(`${base()}/templates`, { method: 'POST', credentials: 'include', body: form })
  if (!r.ok) throw await refusal(r)
  return ((await r.json()) as { template: TemplateUploadResult }).template
}

/** NCF — the connected Shopify stores (a Shopify product CSV names none). */
export const listShopifyStores = (signal?: AbortSignal) =>
  json<{ stores: { id: string; label: string }[] }>(`${base()}/shopify-stores`, { signal }).then(r => r.stores)

/**
 * NCF — read Shopify's product CSV for its preview: the version it reads with and what an import would do. Nothing
 * else is saved. `accountId` is sent BEFORE the file, so the server sees it with the file part.
 */
export async function uploadShopifyFile(file: File, accountId?: string): Promise<ShopifyFilePreview> {
  const form = new FormData()
  if (accountId) form.append('accountId', accountId)
  form.append('file', file)
  const r = await fetch(`${base()}/shopify-files`, { method: 'POST', credentials: 'include', body: form })
  if (!r.ok) throw await refusal(r)
  return ((await r.json()) as { preview: ShopifyFilePreview }).preview
}

/** Hand a file to the browser's download. Feature-local: this branch has no shared download helper. */
export function saveFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** The message a thrown fetch error carries — the server's own sentence when it sent one. */
export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
/** The HTTP status a thrown fetch error carries, when it came from a response. */
export const errorStatus = (error: unknown) => (error as { status?: number } | null)?.status
