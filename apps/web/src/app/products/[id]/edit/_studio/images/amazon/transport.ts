import { amazonMediaWorkspaceSchema, amazonMediaRunSchema } from '@nexus/shared/amazon-media'
import { mediaRequest, MediaRequestError } from '../ebay/transport'
import { z } from 'zod'
import { getBackendUrl } from '@/lib/backend-url'

export async function requestAmazonSafetyArchive(path: string, expectedRevision: string, listingIds: string[]) {
  let response: Response
  try {
    response = await fetch(`${getBackendUrl()}${amazonMediaPath(path, '/safety-export')}`, { method: 'POST', credentials: 'include', cache: 'no-store',
      signal: AbortSignal.timeout(150_000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision, listingIds }) })
  } catch { throw new MediaRequestError('The safety archive could not be downloaded. Your saved images are unchanged; try again.') }
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new MediaRequestError(typeof body?.error === 'string' ? body.error : 'The safety archive could not be generated.', response.status)
  }
  if (!response.headers.get('content-type')?.includes('application/zip')) throw new MediaRequestError('The server did not return a safety image archive.')
  const blob = await response.blob()
  const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer())
  if (signature.length !== 4 || signature[0] !== 0x50 || signature[1] !== 0x4b || signature[2] !== 3 || signature[3] !== 4) throw new MediaRequestError('The returned safety archive was empty or unreadable.')
  return blob
}

export async function requestAmazonDestinations(path: string, signal?: AbortSignal) {
  const parsed = z.object({ listings: z.array(z.object({ id: z.string(), label: z.string() })) }).safeParse(await mediaRequest(amazonMediaPath(path, '/destinations'), 'GET', undefined, signal))
  if (!parsed.success) throw new MediaRequestError('The Amazon listing choices could not be read.')
  return parsed.data.listings
}

export function amazonMediaPath(path: string, suffix: string) {
  const [base, query] = path.split('?')
  return `${base}${suffix}${query ? `?${query}` : ''}`
}
export async function requestAmazonWorkspace(path: string, method: 'GET' | 'PUT' | 'POST' = 'GET', body?: unknown, signal?: AbortSignal) {
  const parsed = amazonMediaWorkspaceSchema.safeParse(await mediaRequest(path, method, body, signal))
  if (!parsed.success) throw new MediaRequestError('The Amazon gallery response is incomplete. Reload before continuing.')
  const query = new URLSearchParams(path.split('?')[1])
  const w = parsed.data
  const productId = decodeURIComponent(/^\/api\/products\/([^/]+)/.exec(path)?.[1] ?? '')
  if (w.productId !== productId || w.destination.accountId !== query.get('accountId') || w.destination.marketplace !== query.get('market')
    || (query.has('listingId') && w.destination.listingId !== query.get('listingId'))) throw new MediaRequestError('The Amazon response belongs to a different listing destination.')
  return w
}
export async function requestAmazonRun(path: string, suffix: string, body?: unknown, signal?: AbortSignal) {
  const parsed = amazonMediaRunSchema.safeParse(await mediaRequest(amazonMediaPath(path, suffix), body ? 'POST' : 'GET', body, signal))
  if (!parsed.success) throw new MediaRequestError('The publication receipt could not be read. Reload it before trying again.')
  const expectedId = /^\/runs\/([^/]+)/.exec(suffix)?.[1]
  if (expectedId && parsed.data.id !== expectedId) throw new MediaRequestError('The server returned a different publication receipt.')
  return parsed.data
}
