import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchStudioRead, StudioReadError, studioReadMessage } from './studio-read'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('editor read recovery', () => {
  it.each([502, 503, 504])('recovers once from HTTP %s and keeps credentials and the request deadline', async status => {
    vi.useFakeTimers()
    const fetch = vi.fn().mockResolvedValueOnce(new Response('Unavailable', { status })).mockResolvedValueOnce(new Response('{}'))
    vi.stubGlobal('fetch', fetch)
    const read = fetchStudioRead('/api/products/p/studio/sheet')
    await vi.advanceTimersByTimeAsync(300)
    expect((await read).status).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: 'include', cache: 'no-store' })
    expect(fetch.mock.calls[0][1].signal).toBe(fetch.mock.calls[1][1].signal)
  })

  it('recovers once from a dropped connection', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(new Response('{}'))
    vi.stubGlobal('fetch', fetch)
    const read = fetchStudioRead('/sheet')
    await vi.advanceTimersByTimeAsync(300)
    expect((await read).ok).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([400, 401, 403, 404, 409, 429, 500])('does not retry an HTTP %s refusal', async status => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status }))
    vi.stubGlobal('fetch', fetch)
    expect((await fetchStudioRead('/sheet')).status).toBe(status)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('stops retrying when the operator changes products or scopes', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn().mockResolvedValue(new Response('Unavailable', { status: 503 }))
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    const read = fetchStudioRead('/sheet', controller.signal)
    const rejected = expect(read).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(1)
    controller.abort()
    await rejected
    await vi.advanceTimersByTimeAsync(300)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('does not extend a timed out read with another attempt', async () => {
    const fetch = vi.fn().mockRejectedValue(new DOMException('deadline', 'TimeoutError'))
    vi.stubGlobal('fetch', fetch)
    await expect(fetchStudioRead('/sheet')).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('distinguishes latency, connection loss, access, and a deleted product without exposing database errors', () => {
    expect(studioReadMessage(new DOMException('deadline', 'TimeoutError'))).toContain('took too long')
    expect(studioReadMessage(new TypeError('Failed to fetch'))).toContain('could not be reached')
    expect(new StudioReadError(403, {}).message).toContain('do not have access')
    const removed = new StudioReadError(404, { error: 'unknown_product' })
    expect(removed.backendMissing).toBe(false)
    expect(removed.message).toContain('moved to the bin')
    expect(new StudioReadError(500, { message: 'postgres secret query' }).message).not.toContain('postgres')
  })
})
