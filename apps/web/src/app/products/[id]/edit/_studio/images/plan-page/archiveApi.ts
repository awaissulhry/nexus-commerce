import type { AmazonArchiveKind } from '@nexus/shared/media-plan-archive'
import { getBackendUrl } from '@/lib/backend-url'

import { MediaRequestError } from '../ebay/transport'
import { archivePreviewSchema, type ArchivePreview } from './archiveModel'

/**
 * Images rebuild P4d — the Amazon ZIP for Seller Central: the preview (every file, what is left out), then the ZIP bound
 * to that preview by its digest. The server refuses a digest that no longer matches (409): the photos changed.
 * The ZIP's own sentences (not the gallery's): every failure says that no ZIP was saved.
 */
export interface ArchiveQuery { accountId: string; market: string; kind: AmazonArchiveKind }

const path = (productId: string, suffix: string, query: Record<string, string>) =>
  `/api/products/${encodeURIComponent(productId)}/media/amazon-archive${suffix}?${new URLSearchParams(query)}`

/** The server's own sentence, or one for a proxy's error page (Vercel answers 502/504 when the API does not start in 120 s). */
async function refusal(response: Response, what: string): Promise<MediaRequestError> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null
  if (typeof body?.error === 'string') return new MediaRequestError(body.error, response.status)
  if (response.status === 502 || response.status === 504) return new MediaRequestError(`The server took too long to answer, so the connection was closed. ${what}`, response.status)
  return new MediaRequestError(`The server refused the request (${response.status}). ${what}`, response.status)
}

export async function requestArchivePreview(productId: string, query: ArchiveQuery, signal?: AbortSignal): Promise<ArchivePreview> {
  let response: Response
  try {
    const timeout = AbortSignal.timeout(45_000)
    response = await fetch(`${getBackendUrl()}${path(productId, '', { ...query })}`, { credentials: 'include', cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new MediaRequestError('The list of files could not be loaded: the server did not answer. Check again.')
  }
  if (!response.ok) throw await refusal(response, 'Check again.')
  const parsed = archivePreviewSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) throw new MediaRequestError('The list of files could not be read. Check again.')
  if (parsed.data.market !== query.market.toUpperCase() || parsed.data.kind !== query.kind) throw new MediaRequestError('The list of files belongs to another choice. Check again.')
  return parsed.data
}

/**
 * The ZIP as a file, or the server's own sentence. A ZIP starts with "PK\x03\x04"; anything else is refused. The time
 * limit covers the wait for the server's answer (it stops making the ZIP at 90 s); the file itself then takes as long as
 * the connection needs.
 */
export async function downloadArchive(productId: string, query: ArchiveQuery & { digest: string }): Promise<Blob> {
  const unsaved = 'No ZIP was saved; try again.'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 130_000)
  let response: Response
  try {
    response = await fetch(`${getBackendUrl()}${path(productId, '/file', { ...query })}`, { credentials: 'include', cache: 'no-store', signal: controller.signal })
  } catch { throw new MediaRequestError(`The server did not answer. ${unsaved}`) } finally { clearTimeout(timer) }
  if (!response.ok) throw await refusal(response, unsaved)
  let blob: Blob
  try { blob = await response.blob() } catch { throw new MediaRequestError(`The download was cut off. ${unsaved}`) }
  const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer())
  if (!response.headers.get('content-type')?.includes('application/zip') || signature.length !== 4 || signature[0] !== 0x50 || signature[1] !== 0x4b || signature[2] !== 3 || signature[3] !== 4)
    throw new MediaRequestError(`The server did not send a readable ZIP. ${unsaved}`)
  return blob
}
