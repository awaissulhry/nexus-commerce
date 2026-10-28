import { readCookie } from '../cookies'
import { createApiClient, CSRF_COOKIE, type ApiClient } from './client'

/**
 * The client for browser code: same-origin `/api/*` (proxied to the factory API by next.config.ts), the CSRF token read
 * from the API's cookie at each unsafe call, the office's company when given.
 */
export function browserApi(options: { company?: string | null; linkToken?: string | null } = {}): ApiClient {
  return createApiClient({
    baseUrl: '/api',
    company: options.company ?? null,
    linkToken: options.linkToken ?? null,
    csrfToken: () => readCookie(CSRF_COOKIE),
  })
}
