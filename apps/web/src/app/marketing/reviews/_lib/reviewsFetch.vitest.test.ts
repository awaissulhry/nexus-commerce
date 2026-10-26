import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDEMPOTENCY_KEY_HEADER } from '@/lib/command-key'
import { UNREACHABLE_WORDS, errorWords, reviewsGet, reviewsSend, reviewsUrl } from './reviewsFetch'

afterEach(() => vi.unstubAllGlobals())

const answer = (status: number, body: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('reviews fetch', () => {
  it('says a failure in words, never a key or a status code', () => {
    expect(errorWords(400, { error: 'invalid_status' })).toBe('Nexus could not do this. Check what you entered, then try again.')
    expect(errorWords(400, { error: 'import_failed', message: 'The file has no review text column.' })).toBe('The file has no review text column.')
    expect(errorWords(401, { error: 'Unauthorized access here' })).toMatch(/Sign in again/)
    expect(errorWords(403, null)).toBe('You do not have permission to do this here.')
    expect(errorWords(404, null)).toMatch(/could not find/)
    expect(errorWords(503, 'Bad gateway')).toMatch(/Try again in a moment/)
    for (const words of [errorWords(500, { error: 'P2025' }), errorWords(422, { error: 'bad_input' })]) expect(words).not.toMatch(/P2025|bad_input|\d{3}/)
  })

  it('reads on the API address with the query', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => answer(200, { rows: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await reviewsGet<{ rows: unknown[] }>('/reviews/inbox', { status: 'NEW', q: '' })
    expect(result).toEqual({ data: { rows: [] }, error: null, status: 200 })
    expect(fetchMock.mock.calls[0][0]).toBe(reviewsUrl('/reviews/inbox', { status: 'NEW' }))
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/reviews\/inbox\?status=NEW$/)
  })

  it('answers a dropped connection in words', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    expect(await reviewsGet('/reviews/inbox')).toEqual({ data: null, error: UNREACHABLE_WORDS, status: 0 })
    expect(await reviewsSend('POST', '/reviews/x/reply/send', { text: 'Thanks' })).toEqual({ data: null, error: UNREACHABLE_WORDS, status: 0 })
  })

  it('sends an Idempotency-Key only when asked, and keeps it after a dropped answer', async () => {
    const seen: (string | null)[] = []
    let fail = true
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers).get(IDEMPOTENCY_KEY_HEADER))
      if (fail) { fail = false; throw new TypeError('Failed to fetch') }
      return answer(200, { ok: true })
    }))
    await reviewsSend('PATCH', '/reviews/r1/triage', { status: 'RESOLVED' })
    expect(seen[0]).toBeNull()
    fail = true
    await expect(reviewsSend('POST', '/reviews/r1/reply/send', { text: 'Thanks' }, { idempotent: true })).resolves.toMatchObject({ error: UNREACHABLE_WORDS })
    const retry = await reviewsSend('POST', '/reviews/r1/reply/send', { text: 'Thanks' }, { idempotent: true })
    expect(retry.error).toBeNull()
    expect(seen[1]).toBeTruthy()
    expect(seen[2]).toBe(seen[1])
  })
})
