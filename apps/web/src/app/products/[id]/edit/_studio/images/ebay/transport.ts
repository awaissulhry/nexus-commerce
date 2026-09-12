import { ebayMediaWorkspaceSchema } from '@nexus/shared/ebay-media'
import { getBackendUrl } from '@/lib/backend-url'

export class MediaRequestError extends Error {
  constructor(message: string, readonly status = 0) { super(message) }
}

export async function mediaRequest(path: string, method: 'GET' | 'PUT' | 'POST' = 'GET', body?: unknown, signal?: AbortSignal): Promise<unknown> {
  let response: Response
  try {
    const timeout = AbortSignal.timeout(method === 'GET' ? 45_000 : 120_000)
    response = await fetch(`${getBackendUrl()}${path}`, { method, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, credentials: 'include', cache: 'no-store',
      headers: body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
      body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body) })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new MediaRequestError(method === 'GET' ? 'The gallery could not be reached. Please retry.'
      : 'The connection was interrupted. The result is unknown: the server may have saved your changes. Keep your edits and reload the saved gallery before retrying.')
  }
  let data: unknown
  try { data = await response.json() } catch {
    throw new MediaRequestError(method === 'GET' ? 'The gallery response could not be read. Please retry.'
      : 'The server response could not be read. The save result is unknown; reload the saved gallery before retrying.', method === 'GET' ? response.status : 0)
  }
  if (!response.ok) {
    const error = data as { message?: unknown; error?: unknown }
    throw new MediaRequestError(typeof error.message === 'string' ? error.message : typeof error.error === 'string' ? error.error : `The request failed (${response.status}).`, response.status)
  }
  return data
}

export async function requestWorkspace(path: string, body?: unknown, signal?: AbortSignal) {
  const result = ebayMediaWorkspaceSchema.safeParse(await mediaRequest(path, body === undefined ? 'GET' : 'PUT', body, signal))
  if (!result.success) throw new MediaRequestError(body === undefined ? 'The server returned an incomplete gallery. Please retry.'
    : 'The saved gallery could not be verified from the response. Reload before retrying.')
  const requestedProduct = /^\/api\/products\/([^/]+)\//.exec(path)?.[1]
  if (requestedProduct && result.data.productId !== decodeURIComponent(requestedProduct)) throw new MediaRequestError('The response belongs to a different product. Reload the gallery before continuing.')
  const query = new URLSearchParams(path.split('?')[1] ?? '')
  const destination = result.data.destination
  if ((query.has('accountId') && query.get('accountId') !== destination.accountId)
    || (query.has('market') && query.get('market') !== destination.marketplace)
    || (query.has('listingId') && query.get('listingId') !== destination.listingId))
    throw new MediaRequestError('The response belongs to a different listing destination. Reload the gallery before continuing.')
  return result.data
}
