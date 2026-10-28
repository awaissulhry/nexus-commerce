import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { cookieValue } from '../cookies'
import { linkTokenFromHash } from '../links/token'
import { apiUrl, createApiClient, requestHeaders, type ApiClientOptions } from './client'
import { ApiError, apiErrorFrom, errorKindFor } from './errors'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function client(answer: Response | Error, options: Partial<ApiClientOptions> = {}) {
  const fetch = vi.fn(async () => {
    if (answer instanceof Error) throw answer
    return answer
  })
  return { api: createApiClient({ baseUrl: '/api', fetch: fetch as unknown as typeof globalThis.fetch, csrfToken: () => 'csrf-1', ...options }), fetch }
}

describe('the API client', () => {
  it('reaches only its base: the API route under /api (browser) or FACTORY_API_URL (server)', () => {
    expect(apiUrl('/api', '/auth/office/me')).toBe('/api/auth/office/me')
    expect(apiUrl('http://127.0.0.1:8190/', '/links', { recordType: 'Quote', recordId: 'x', empty: undefined })).toBe('http://127.0.0.1:8190/links?recordType=Quote&recordId=x')
    expect(() => apiUrl('/api', 'https://elsewhere.example/x')).toThrow()
    expect(() => apiUrl('/api', '//elsewhere.example/x')).toThrow()
  })

  it('sends the CSRF token on unsafe methods only', () => {
    const options: ApiClientOptions = { baseUrl: '/api', csrfToken: () => 'csrf-1' }
    expect(requestHeaders(options, 'POST', { body: {} }).get('x-csrf-token')).toBe('csrf-1')
    expect(requestHeaders(options, 'DELETE', {}).get('x-csrf-token')).toBe('csrf-1')
    expect(requestHeaders(options, 'GET', {}).get('x-csrf-token')).toBeNull()
  })

  it('names the company, the link and the idempotency key in their headers', () => {
    const headers = requestHeaders({ baseUrl: '/api', company: 'DEMO', linkToken: 'a.b.c.d', cookie: '__Host-factory_session=s' }, 'POST', { body: {}, idempotencyKey: 'k1' })
    expect(headers.get('x-factory-company')).toBe('DEMO')
    expect(headers.get('x-factory-link')).toBe('a.b.c.d')
    expect(headers.get('idempotency-key')).toBe('k1')
    expect(headers.get('cookie')).toBe('__Host-factory_session=s')
    expect(headers.get('content-type')).toBe('application/json')
  })

  it('validates an answer against its schema', async () => {
    const { api, fetch } = client(json(200, { ok: true, extra: 1 }))
    await expect(api.get('/x', { schema: z.object({ ok: z.boolean() }) })).resolves.toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledWith('/api/x', expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store' }))
    await expect(client(json(200, { ok: 'yes' })).api.get('/x', { schema: z.object({ ok: z.boolean() }) })).rejects.toMatchObject({ kind: 'contract' })
  })

  it('maps error answers to what a screen does', async () => {
    await expect(client(json(401, { error: { code: 'unauthenticated', message: 'm', requestId: 'r1' } })).api.get('/x')).rejects.toMatchObject({ kind: 'signed_out', status: 401, requestId: 'r1' })
    await expect(client(json(404, { error: { code: 'LINK_UNAVAILABLE', message: 'm' } })).api.post('/link/open', { body: {} })).rejects.toMatchObject({ kind: 'not_found', code: 'LINK_UNAVAILABLE' })
    await expect(client(new TypeError('fetch failed')).api.get('/x')).rejects.toMatchObject({ kind: 'unavailable', code: 'network' })
    await expect(client(new Response('<html>', { status: 502 })).api.get('/x')).rejects.toMatchObject({ kind: 'unavailable', status: 502 })
  })

  it('tells a step-up request from a plain refusal', () => {
    expect(errorKindFor(403, [{ path: ['stepUp'] }])).toBe('step_up')
    expect(errorKindFor(403)).toBe('forbidden')
    expect(errorKindFor(409)).toBe('conflict')
    expect(errorKindFor(422)).toBe('invalid')
    expect(errorKindFor(429)).toBe('rate_limited')
    expect(errorKindFor(500)).toBe('internal')
    expect(apiErrorFrom(500, 'not an envelope')).toBeInstanceOf(ApiError)
  })
})

describe('a link token travels from the fragment into a header, never a URL', () => {
  const token = '0190f0e2-1111-7000-8000-000000000001.0190f0e2-1111-7000-8000-000000000002.0190f0e2-1111-7000-8000-000000000003.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd'

  it('reads #token=… and refuses anything that is not a token', () => {
    expect(linkTokenFromHash(`#token=${token}`)).toBe(token)
    expect(linkTokenFromHash(`token=${token}`)).toBe(token)
    expect(linkTokenFromHash('#token=nope')).toBeNull()
    expect(linkTokenFromHash('#token=a.b.c.d<script>')).toBeNull()
    expect(linkTokenFromHash('')).toBeNull()
  })

  it('reads a cookie from a Cookie header', () => {
    expect(cookieValue('a=1; __Host-factory_csrf=tok%3D; b=2', '__Host-factory_csrf')).toBe('tok=')
    expect(cookieValue('a=1', 'b')).toBeUndefined()
  })
})
