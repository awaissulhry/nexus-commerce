import type { ZodType } from 'zod'
import { ApiError, apiErrorFrom, networkError } from './errors'

/**
 * The typed client for the factory API — the ONE way this web calls it.
 *
 * Rules (apps/factory-api/CLAUDE.md):
 *  - It only ever reaches the factory API: the browser through this app's own `/api/*` (next.config.ts proxies it to
 *    FACTORY_API_URL, so the session cookie stays first-party); a server component straight at FACTORY_API_URL, which
 *    has no fallback (lib/api-url.ts). Never the Commerce API.
 *  - Every unsafe call (POST, PUT, PATCH, DELETE) of a cookie session sends `x-csrf-token` = the `__Host-factory_csrf`
 *    cookie (the double submit). Sign-in, sign-out and invitation accept need it too.
 *  - `x-factory-company` names the company the office works in (the URL's `/w/<company>`); the API checks it is one of
 *    the tenant's, active, and answers 403 otherwise.
 *  - A one-off link's token travels ONLY in `x-factory-link` (the web reads it from the URL fragment, which no server
 *    log holds), never in a path or query.
 *  - Writes that the API makes idempotent take an `Idempotency-Key` (link answers, floor and office creates).
 *  - Errors come back as `ApiError` with a kind a screen acts on (errors.ts); an answer that does not match its schema
 *    is a `contract` error, never half-read.
 */

export const CSRF_HEADER = 'x-csrf-token'
export const COMPANY_HEADER = 'x-factory-company'
export const LINK_HEADER = 'x-factory-link'
export const IDEMPOTENCY_HEADER = 'idempotency-key'
/** The API's readable CSRF cookie. */
export const CSRF_COOKIE = '__Host-factory_csrf'
/** The API's session cookies, the only cookies a server component forwards. */
export const API_COOKIES = ['__Host-factory_session', '__Host-factory_csrf'] as const

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface ApiClientOptions {
  /** `/api` in the browser; FACTORY_API_URL on the server. */
  baseUrl: string
  fetch?: typeof fetch
  /** The company code or id for `x-factory-company`. */
  company?: string | null
  /** The CSRF token for unsafe methods (the browser reads the cookie each time). */
  csrfToken?: () => string | null | undefined
  /** A server component's forwarded `Cookie` header (the API's cookies only). */
  cookie?: string | null
  /** A one-off link's token, for `x-factory-link`. */
  linkToken?: string | null
}

export interface RequestOptions<T> {
  query?: Readonly<Record<string, string | number | boolean | null | undefined>>
  body?: unknown
  /** Validates the answer; without it the answer is returned as parsed JSON. */
  schema?: ZodType<T>
  /** For the API's idempotent writes. */
  idempotencyKey?: string
  signal?: AbortSignal
}

export interface ApiClient {
  request<T>(method: HttpMethod, path: string, options?: RequestOptions<T>): Promise<T>
  get<T>(path: string, options?: RequestOptions<T>): Promise<T>
  post<T>(path: string, options?: RequestOptions<T>): Promise<T>
  /** A GET whose answer is a file the API makes (a PDF): its bytes; an error answer is an ApiError as for JSON. */
  bytes(path: string, options?: Pick<RequestOptions<unknown>, 'query' | 'signal'>): Promise<Uint8Array>
}

const UNSAFE: ReadonlySet<HttpMethod> = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** A fresh key for one idempotent write. */
export function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID()
}

/** The URL of an API route under the client's base. Paths are the API's own (`/auth/office/me`). */
export function apiUrl(baseUrl: string, path: string, query?: RequestOptions<unknown>['query']): string {
  if (!path.startsWith('/') || path.startsWith('//')) throw new TypeError(`an API path starts with one slash: ${path}`)
  const search = new URLSearchParams()
  for (const [name, value] of Object.entries(query ?? {})) if (value !== undefined && value !== null) search.set(name, String(value))
  const qs = search.toString()
  return `${baseUrl.replace(/\/+$/, '')}${path}${qs ? `?${qs}` : ''}`
}

/** The headers of one call. Exported for the tests. */
export function requestHeaders(options: ApiClientOptions, method: HttpMethod, request: Pick<RequestOptions<unknown>, 'body' | 'idempotencyKey'>): Headers {
  const headers = new Headers({ accept: 'application/json' })
  if (request.body !== undefined) headers.set('content-type', 'application/json')
  if (options.company) headers.set(COMPANY_HEADER, options.company)
  if (options.linkToken) headers.set(LINK_HEADER, options.linkToken)
  if (options.cookie) headers.set('cookie', options.cookie)
  if (request.idempotencyKey) headers.set(IDEMPOTENCY_HEADER, request.idempotencyKey)
  if (UNSAFE.has(method)) {
    const token = options.csrfToken?.()
    if (token) headers.set(CSRF_HEADER, token)
  }
  return headers
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)

  async function request<T>(method: HttpMethod, path: string, request: RequestOptions<T> = {}): Promise<T> {
    let response: Response
    try {
      response = await doFetch(apiUrl(options.baseUrl, path, request.query), {
        method,
        headers: requestHeaders(options, method, request),
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        credentials: 'same-origin',
        cache: 'no-store',
        signal: request.signal,
      })
    } catch (cause) {
      if ((cause as { name?: string } | null)?.name === 'AbortError') throw cause
      throw networkError(cause)
    }
    const text = await response.text()
    let body: unknown = undefined
    if (text !== '') {
      try {
        body = JSON.parse(text)
      } catch {
        if (response.ok) throw new ApiError('contract', response.status, 'contract', 'The factory API answered something that is not JSON.')
      }
    }
    if (!response.ok) throw apiErrorFrom(response.status, body)
    if (!request.schema) return body as T
    const parsed = request.schema.safeParse(body)
    if (!parsed.success) throw new ApiError('contract', response.status, 'contract', 'The factory API answered in a shape this web does not know.')
    return parsed.data
  }

  function get<T>(path: string, options?: RequestOptions<T>): Promise<T> {
    return request<T>('GET', path, options)
  }
  function post<T>(path: string, options?: RequestOptions<T>): Promise<T> {
    return request<T>('POST', path, options)
  }
  async function bytes(path: string, read: Pick<RequestOptions<unknown>, 'query' | 'signal'> = {}): Promise<Uint8Array> {
    let response: Response
    try {
      const headers = requestHeaders(options, 'GET', {})
      headers.set('accept', 'application/pdf, application/json')
      response = await doFetch(apiUrl(options.baseUrl, path, read.query), { method: 'GET', headers, credentials: 'same-origin', cache: 'no-store', signal: read.signal })
    } catch (cause) {
      if ((cause as { name?: string } | null)?.name === 'AbortError') throw cause
      throw networkError(cause)
    }
    if (!response.ok) {
      const text = await response.text()
      let body: unknown = undefined
      try {
        body = text === '' ? undefined : JSON.parse(text)
      } catch {
        body = undefined
      }
      throw apiErrorFrom(response.status, body)
    }
    return new Uint8Array(await response.arrayBuffer())
  }
  return { request, get, post, bytes }
}
