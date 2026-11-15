import { describe, expect, it } from 'vitest'
import { FORWARDED_FOR, RECEIVED_FORWARDED_FOR } from './forwarded'
import { answerHeaders, apiTarget, hasBody, proxyToApi, upstreamHeaders } from './proxy'

// B-W2b-F57: the /api proxy route passes a browser call on as it came, with the browser's address.
const API = 'http://127.0.0.1:8190'

interface Seen {
  url: string
  init: RequestInit & { duplex?: string }
}

function fakeApi(answer: () => Response): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = []
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} })
    return answer()
  }) as typeof globalThis.fetch
  return { fetch, seen }
}

describe('where a call goes', () => {
  it('drops the /api prefix and keeps the path and query as sent', () => {
    expect(apiTarget(API, 'http://localhost:3200/api/auth/office/me')).toBe(`${API}/auth/office/me`)
    expect(apiTarget(API, 'http://localhost:3200/api/files/a%2Fb/download?x=1&y=%C3%A8')).toBe(`${API}/files/a%2Fb/download?x=1&y=%C3%A8`)
    expect(apiTarget(API, 'http://localhost:3200/api')).toBe(`${API}/`)
    expect(apiTarget(API, 'http://localhost:3200/apiary/x')).toBe(`${API}/apiary/x`)
  })
})

describe('what is sent on', () => {
  it("keeps the browser's headers, never the hop-by-hop ones, Host, a received address or Next.js's own", () => {
    const sent = upstreamHeaders(
      new Headers({
        cookie: '__Host-factory_session=s; __Host-factory_csrf=c',
        'x-csrf-token': 'c',
        'x-factory-company': 'SCA',
        'idempotency-key': 'k-1',
        'content-type': 'application/json',
        origin: 'http://localhost:3200',
        'user-agent': 'a browser',
        host: 'localhost:3200',
        connection: 'keep-alive',
        'transfer-encoding': 'chunked',
        'content-length': '12',
        'accept-encoding': 'gzip, br',
        [FORWARDED_FOR]: '127.0.0.1',
        [RECEIVED_FORWARDED_FOR]: '192.0.2.66',
        'x-real-ip': '192.0.2.67',
        forwarded: 'for=192.0.2.68',
        'x-middleware-subrequest': 'x',
      }),
      '198.51.100.7',
    )
    expect(Object.fromEntries(sent)).toEqual({
      cookie: '__Host-factory_session=s; __Host-factory_csrf=c',
      'x-csrf-token': 'c',
      'x-factory-company': 'SCA',
      'idempotency-key': 'k-1',
      'content-type': 'application/json',
      origin: 'http://localhost:3200',
      'user-agent': 'a browser',
      'accept-encoding': 'identity',
      [FORWARDED_FOR]: '198.51.100.7',
    })
    expect(upstreamHeaders(new Headers({ [FORWARDED_FOR]: '192.0.2.1' }), null).has(FORWARDED_FOR)).toBe(false)
  })

  it('sends a body only when the browser sent one', () => {
    expect(hasBody('GET', new Headers({ 'content-length': '5' }))).toBe(false)
    expect(hasBody('POST', new Headers())).toBe(false)
    expect(hasBody('POST', new Headers({ 'content-length': '0' }))).toBe(false)
    expect(hasBody('POST', new Headers({ 'content-length': '2' }))).toBe(true)
    expect(hasBody('PUT', new Headers({ 'transfer-encoding': 'chunked' }))).toBe(true)
  })
})

describe('a call through the proxy', () => {
  it('passes a POST on with its body streamed, and the answer back as it came (each Set-Cookie apart)', async () => {
    const answer = new Headers({ 'content-type': 'application/json', 'x-request-id': 'r-1', 'cache-control': 'no-store', connection: 'close' })
    answer.append('set-cookie', '__Host-factory_session=s; Path=/; HttpOnly; Secure; SameSite=Lax')
    answer.append('set-cookie', '__Host-factory_csrf=c; Path=/; Secure; SameSite=Lax')
    const api = fakeApi(() => new Response('{"status":"signed_in"}', { status: 200, headers: answer }))
    const body = JSON.stringify({ tenant: 'seed', email: 'someone@example.com' })
    const request = new Request('http://localhost:3200/api/auth/office/sign-in', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', 'content-length': String(body.length), [FORWARDED_FOR]: '127.0.0.1' },
    })
    const response = await proxyToApi(request, { apiUrl: API, forwardedFor: '198.51.100.7', fetch: api.fetch })

    expect(api.seen).toHaveLength(1)
    const [{ url, init }] = api.seen
    expect(url).toBe(`${API}/auth/office/sign-in`)
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('manual')
    expect(init.duplex).toBe('half')
    expect(new Headers(init.headers).get(FORWARDED_FOR)).toBe('198.51.100.7')
    expect(await new Response(init.body).text()).toBe(body)
    expect(init.signal).toBe(request.signal)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('{"status":"signed_in"}')
    expect(response.headers.get('x-request-id')).toBe('r-1')
    expect(response.headers.get('connection')).toBeNull()
    expect(response.headers.getSetCookie()).toEqual(['__Host-factory_session=s; Path=/; HttpOnly; Secure; SameSite=Lax', '__Host-factory_csrf=c; Path=/; Secure; SameSite=Lax'])
  })

  it('sends a bodiless POST without a body, and a GET never with one', async () => {
    const api = fakeApi(() => new Response(null, { status: 204 }))
    const signOut = await proxyToApi(new Request('http://localhost:3200/api/auth/office/sign-out', { method: 'POST' }), { apiUrl: API, forwardedFor: null, fetch: api.fetch })
    expect(signOut.status).toBe(204)
    expect(await signOut.text()).toBe('')
    await proxyToApi(new Request('http://localhost:3200/api/auth/office/me'), { apiUrl: API, forwardedFor: null, fetch: api.fetch })
    expect(api.seen.map(({ init }) => [init.method, init.body ?? null, init.duplex ?? null])).toEqual([
      ['POST', null, null],
      ['GET', null, null],
    ])
  })

  it('streams the answer (a live event stream) without reading it whole', async () => {
    let push: ((text: string) => void) | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (text) => controller.enqueue(new TextEncoder().encode(text))
      },
    })
    const api = fakeApi(() => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform' } }))
    const response = await proxyToApi(new Request('http://localhost:3200/api/live'), { apiUrl: API, forwardedFor: '198.51.100.7', fetch: api.fetch })
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform')
    const reader = response.body!.getReader()
    push!('event: ready\ndata: {}\n\n')
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('event: ready\ndata: {}\n\n')
    await reader.cancel()
  })

  it('passes a redirect and an error answer back as they came', async () => {
    const redirect = await proxyToApi(new Request('http://localhost:3200/api/files/f-1/download'), {
      apiUrl: API,
      forwardedFor: null,
      fetch: fakeApi(() => new Response(null, { status: 302, headers: { location: 'https://files.example.com/f-1' } })).fetch,
    })
    expect(redirect.status).toBe(302)
    expect(redirect.headers.get('location')).toBe('https://files.example.com/f-1')
    const limited = await proxyToApi(new Request('http://localhost:3200/api/views'), {
      apiUrl: API,
      forwardedFor: null,
      fetch: fakeApi(() => Response.json({ error: { code: 'rate_limited' } }, { status: 429, headers: { 'retry-after': '30' } })).fetch,
    })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('30')
    expect(await limited.json()).toEqual({ error: { code: 'rate_limited' } })
  })

  it('answers 502 in the API error shape when the API does not answer', async () => {
    const response = await proxyToApi(new Request('http://localhost:3200/api/auth/office/me'), {
      apiUrl: API,
      forwardedFor: null,
      fetch: (async () => {
        throw new TypeError('fetch failed')
      }) as typeof fetch,
    })
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: { code: 'api_unreachable', message: 'The factory API could not be reached.', requestId: null } })
  })

  it('drops a decoded body encoding and its length', () => {
    const out = answerHeaders(new Headers({ 'content-encoding': 'gzip', 'content-length': '10', 'content-type': 'application/pdf' }))
    expect(Object.fromEntries(out)).toEqual({ 'content-type': 'application/pdf' })
    expect(Object.fromEntries(answerHeaders(new Headers({ 'content-length': '10' })))).toEqual({ 'content-length': '10' })
  })
})
