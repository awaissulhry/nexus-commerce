import { afterEach, expect, it, vi } from 'vitest'
import { publicationRequest, requestFailure } from './request'

vi.mock('@/lib/backend-url', () => ({ getBackendUrl: () => 'http://publication.test' }))
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('ends a stalled submit with an uncertain outcome and never sends it twice', async () => {
  vi.useFakeTimers()
  const fetch = vi.fn((_url, input) => new Promise((_resolve, reject) => {
    input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })
  }))
  vi.stubGlobal('fetch', fetch)
  const request = publicationRequest('/review-42/submit', 'POST', {})
  const rejected = expect(request).rejects.toThrow('Check publication status')
  await vi.advanceTimersByTimeAsync(120_000)
  await rejected
  expect(fetch).toHaveBeenCalledOnce()
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true)
})

it('cancels an obsolete preview and keeps HTTP refusals distinguishable from missing confirmation', async () => {
  const controller = new AbortController()
  const fetch = vi.fn((_url, input) => new Promise((_resolve, reject) => {
    input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })
  }))
  vi.stubGlobal('fetch', fetch)
  const request = publicationRequest('/preview', 'POST', {}, controller.signal)
  const cancelled = expect(request).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort(); await cancelled
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Review expired' }), { status: 409 }) as never)
  await expect(publicationRequest('/submit', 'POST', {})).rejects.toMatchObject({ status: 409, message: 'Review expired' })
})

it('keeps the server\'s machine code on a refusal (409 changed reloads the plan) and sends a PUT body', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: 'changed', message: 'GALE-S: its waiting value changed since the review. Review again.' }), { status: 409 }) as never)
    .mockResolvedValueOnce(new Response(JSON.stringify({ applied: ['l1'], refused: [], conflicts: [] }), { status: 200 }) as never)
  vi.stubGlobal('fetch', fetch)
  const refused = await publicationRequest('/api/publication-batches', 'POST', { plan: {} }).catch(e => e)
  expect(requestFailure(refused)).toEqual({ status: 409, code: 'changed' })
  expect(requestFailure(new Error('offline'))).toEqual({ status: null, code: null })
  await expect(publicationRequest('/status/active', 'PUT', { listingIds: ['l1'] })).resolves.toEqual({ applied: ['l1'], refused: [], conflicts: [] })
  expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ listingIds: ['l1'] }) })
})
