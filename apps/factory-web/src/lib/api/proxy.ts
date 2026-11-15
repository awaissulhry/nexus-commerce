import { FORWARDED_FOR, RECEIVED_FORWARDED_FOR } from './forwarded'

/**
 * The `/api/*` proxy (B-W2b-F57; src/app/api/[...path]/route.ts): one browser call to the factory API, passed on as the
 * browser sent it — method, path, query, headers and body streamed — and the API's answer passed back as it came —
 * status, headers (each Set-Cookie on its own), body streamed (the live screens' event stream too). It replaces the
 * rewrite of next.config.ts, which could not say whose call it was: the one header the web writes itself is
 * X-Forwarded-For (lib/api/forwarded.ts). Never sent on: hop-by-hop headers, Host (the API's own), a received
 * X-Forwarded-For or X-Real-IP or Forwarded (the address travels only as the web decided), Next.js's internal headers.
 */

export interface ProxyOptions {
  /** FACTORY_API_URL (lib/api-url.ts), without a trailing slash. */
  readonly apiUrl: string
  /** The X-Forwarded-For to send (lib/api/forwarded.ts `forwardedForOf`); null sends none. */
  readonly forwardedFor: string | null
  readonly fetch?: typeof fetch
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
const NOT_SENT = new Set([...HOP_BY_HOP, 'host', 'content-length', 'accept-encoding', 'expect', FORWARDED_FOR, RECEIVED_FORWARDED_FOR, 'x-real-ip', 'forwarded'])
const NO_BODY_STATUS = new Set([204, 205, 304])

/**
 * Whether the browser sent a body: a length above zero, or a chunked one. A bodiless POST (sign-out) stays bodiless, as the
 * browser sent it: a body of nothing, streamed, would reach the API as a chunked body without a content type.
 */
export function hasBody(method: string, headers: Headers): boolean {
  if (method === 'GET' || method === 'HEAD') return false
  return Number(headers.get('content-length') ?? '0') > 0 || headers.has('transfer-encoding')
}

/** The API's own path and query of a `/api/<route>` URL (the API's routes carry no `/api` prefix). */
export function apiTarget(apiUrl: string, requestUrl: string): string {
  const url = new URL(requestUrl)
  const path = url.pathname.replace(/^\/api(?=\/|$)/, '')
  return `${apiUrl}${path === '' ? '/' : path}${url.search}`
}

/** The headers sent to the API: the browser's, less what never travels on, plus X-Forwarded-For. */
export function upstreamHeaders(request: Headers, forwardedFor: string | null): Headers {
  const headers = new Headers()
  request.forEach((value, name) => {
    if (NOT_SENT.has(name) || name.startsWith('x-middleware-')) return
    headers.set(name, value)
  })
  // Between the web and the API nothing is compressed (Next.js compresses the answer to the browser itself).
  headers.set('accept-encoding', 'identity')
  if (forwardedFor !== null) headers.set(FORWARDED_FOR, forwardedFor)
  return headers
}

/** The headers sent back to the browser: the API's, less hop-by-hop ones, each Set-Cookie kept apart. */
export function answerHeaders(upstream: Headers): Headers {
  const headers = new Headers()
  // fetch decodes a compressed body itself: its encoding and length no longer describe what is passed on.
  const decoded = upstream.has('content-encoding')
  upstream.forEach((value, name) => {
    if (HOP_BY_HOP.has(name) || name === 'set-cookie') return
    if (decoded && (name === 'content-encoding' || name === 'content-length')) return
    headers.set(name, value)
  })
  for (const cookie of upstream.getSetCookie()) headers.append('set-cookie', cookie)
  return headers
}

/** The answer when the API does not answer at all (the web's api client reads 502 as "unavailable, try again"). */
function unreachable(): Response {
  return Response.json(
    { error: { code: 'api_unreachable', message: 'The factory API could not be reached.', requestId: null } },
    { status: 502, headers: { 'cache-control': 'no-store' } },
  )
}

export async function proxyToApi(request: Request, options: ProxyOptions): Promise<Response> {
  const doFetch = options.fetch ?? globalThis.fetch
  const method = request.method.toUpperCase()
  const body = hasBody(method, request.headers) ? request.body : null
  let upstream: Response
  try {
    upstream = await doFetch(apiTarget(options.apiUrl, request.url), {
      method,
      headers: upstreamHeaders(request.headers, options.forwardedFor),
      body,
      // A streamed request body (Node's fetch needs it said); the API refuses one above 1 MiB itself.
      ...(body === null ? {} : { duplex: 'half' }),
      redirect: 'manual',
      cache: 'no-store',
      signal: request.signal,
    } as RequestInit)
  } catch {
    return unreachable()
  }
  const empty = method === 'HEAD' || NO_BODY_STATUS.has(upstream.status)
  return new Response(empty ? null : upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: answerHeaders(upstream.headers) })
}
