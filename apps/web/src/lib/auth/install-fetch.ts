/**
 * Phase S3 — scoped global fetch wrapper.
 *
 * 623 files call the API with raw `fetch()`; editing each to send the
 * session cookie is infeasible, and on the interim cross-site setup
 * (vercel.app ↔ railway.app) cookies only ride when a request opts into
 * `credentials: 'include'`. So we patch window.fetch ONCE to, for requests
 * to the API origin only:
 *   • set credentials: 'include' (send the session + CSRF cookies), and
 *   • add the x-nexus-csrf header on mutating methods (double-submit).
 * Non-API requests pass through untouched. Idempotent + client-only.
 * EventSource and XMLHttpRequest get the same rule below (streams; uploads).
 *
 * Under Option A (custom same-site domain) the credentials part becomes
 * unnecessary, but keeping it is harmless.
 */

import { getBackendUrl } from '@/lib/backend-url'
import { getCsrfToken } from './csrf-store'
import { browserWorkspaceId, WORKSPACES_ENABLED } from '../workspaces/paths'

let installed = false
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** The headers an API call carries: the business, and on a mutating method the CSRF token. One rule for fetch and XHR. */
function apiHeaders(method: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const workspaceId = browserWorkspaceId()
  if (WORKSPACES_ENABLED && workspaceId) out.push(['x-nexus-workspace-id', workspaceId])
  if (MUTATING.has(method.toUpperCase())) {
    const token = getCsrfToken()
    if (token) out.push(['x-nexus-csrf', token])
  }
  return out
}

export function installAuthFetch(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  const original = window.fetch.bind(window)
  let apiOrigin: string
  try {
    apiOrigin = new URL(getBackendUrl()).origin
  } catch {
    return // can't determine API origin — leave fetch untouched
  }

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
      const resolved = new URL(rawUrl, window.location.href)
      if (resolved.origin === apiOrigin) {
        const opts: RequestInit = { ...(init ?? {}) }
        opts.credentials = 'include'
        const headers = new Headers(opts.headers ?? (input instanceof Request ? input.headers : undefined))
        const method = opts.method ?? (input instanceof Request ? input.method : 'GET')
        for (const [name, value] of apiHeaders(method)) if (!headers.has(name)) headers.set(name, value)
        opts.headers = headers
        return original(input, opts)
      }
    } catch {
      /* fall through to the untouched call */
    }
    return original(input, init)
  }

  // EventSource isn't window.fetch, so the wrapper above doesn't cover the
  // 26+ SSE streams. Under enforce a cross-site EventSource must set
  // withCredentials to send the (Partitioned) session cookie — otherwise it
  // connects anonymously and 401s. Patch the constructor once so every
  // API-origin stream is credentialed, without editing each callsite.
  const OrigES = window.EventSource
  if (OrigES) {
    const PatchedES = function (this: unknown, url: string | URL, opts?: EventSourceInit) {
      try {
        if (new URL(url, window.location.href).origin === apiOrigin) {
          const resolved = new URL(url, window.location.href)
          const workspaceId = browserWorkspaceId()
          if (WORKSPACES_ENABLED && workspaceId && !resolved.searchParams.has('workspaceId')) resolved.searchParams.set('workspaceId', workspaceId)
          return new OrigES(resolved, { ...(opts ?? {}), withCredentials: true })
        }
      } catch {
        /* fall through */
      }
      return new OrigES(url, opts)
    } as unknown as typeof EventSource
    const P = PatchedES as unknown as Record<string, unknown>
    P.prototype = OrigES.prototype
    P.CONNECTING = OrigES.CONNECTING
    P.OPEN = OrigES.OPEN
    P.CLOSED = OrigES.CLOSED
    window.EventSource = PatchedES
  }

  // XMLHttpRequest isn't window.fetch either. The uploads use it for byte progress (media library files and ZIPs,
  // purchase-order attachments), so they left without the CSRF token and the business, and the API refused every
  // one: 403 "Refresh this page and try again". Same rule as fetch, patched once on the prototype.
  const XHR = window.XMLHttpRequest
  if (XHR) {
    const apiMethod = new WeakMap<XMLHttpRequest, string>()   // the method of an open API-origin request
    const ownHeaders = new WeakMap<XMLHttpRequest, Set<string>>()
    const { open, send, setRequestHeader } = XHR.prototype
    XHR.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      apiMethod.delete(this)
      ownHeaders.delete(this)
      try {
        if (new URL(url, window.location.href).origin === apiOrigin) apiMethod.set(this, method)
      } catch {
        /* not a URL we can read: leave the request untouched */
      }
      return (open as (...args: unknown[]) => void).call(this, method, url, ...rest)
    } as XMLHttpRequest['open']
    XHR.prototype.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
      const own = ownHeaders.get(this) ?? new Set<string>()
      own.add(name.toLowerCase())
      ownHeaders.set(this, own)
      return setRequestHeader.call(this, name, value)
    }
    XHR.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const method = apiMethod.get(this)
      if (method !== undefined) {
        this.withCredentials = true
        const own = ownHeaders.get(this)
        for (const [name, value] of apiHeaders(method)) if (!own?.has(name)) setRequestHeader.call(this, name, value)
      }
      return send.call(this, body)
    }
  }
}
