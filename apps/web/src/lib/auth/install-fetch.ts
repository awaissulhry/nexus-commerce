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
 *
 * Under Option A (custom same-site domain) the credentials part becomes
 * unnecessary, but keeping it is harmless.
 */

import { getBackendUrl } from '@/lib/backend-url'
import { getCsrfToken } from './csrf-store'

let installed = false
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

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
        const method = (opts.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
        if (MUTATING.has(method)) {
          const token = getCsrfToken()
          if (token) {
            const headers = new Headers(
              opts.headers ?? (input instanceof Request ? input.headers : undefined),
            )
            if (!headers.has('x-nexus-csrf')) headers.set('x-nexus-csrf', token)
            opts.headers = headers
          }
        }
        return original(input, opts)
      }
    } catch {
      /* fall through to the untouched call */
    }
    return original(input, init)
  }
}
