/**
 * The Listing window's calls to the API that are not readiness reads: the listing's own read and its two price edits,
 * a suppression's record and its diagnosis, a listing's pushes and reads. Unlike `transferApi` it never throws on an
 * answer: the caller needs the status (a 403 holds the button that sent it, with the API's own words).
 * `install-fetch` adds the credentials, the CSRF header and the business on the way out.
 */
import { getBackendUrl } from '@/lib/backend-url'

export interface ApiAnswer<T = unknown> { ok: boolean; status: number; json: T }

export async function listingCall<T = unknown>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<ApiAnswer<T>> {
  const response = await fetch(`${getBackendUrl()}/api/${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    cache: 'no-store',
    signal: init.signal,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body), headers: { 'Content-Type': 'application/json' } } : {}),
  })
  const json = (await response.json().catch(() => ({}))) as T
  return { ok: response.ok, status: response.status, json }
}
