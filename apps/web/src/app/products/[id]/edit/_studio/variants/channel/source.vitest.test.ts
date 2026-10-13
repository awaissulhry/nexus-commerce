/**
 * 2.4 — the live source tells a refusal from NO verdict. A dropped connection, a timeout or a 5xx may have landed, so it
 * is `unknown` (the page reads again before its next write); a 4xx is a refusal; a 409 with the page is a conflict.
 * `fetch` is stubbed: nothing leaves the test.
 */
import { afterEach, expect, it, vi } from 'vitest'

import { liveSource } from './source'

const coord = { productId: 'p1', channel: 'EBAY', market: 'IT', accountId: 'acc-1' }
const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))

afterEach(() => { vi.unstubAllGlobals() })

it('a dropped connection is no verdict, not a refusal', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
  expect(await liveSource(coord).setIncluded(5, [{ id: 'c1', included: true }])).toEqual({ ok: false, conflict: false, unknown: true, reason: 'Failed to fetch' })
})

it('a server failure (5xx) is no verdict either: it may have failed after its commit', async () => {
  vi.stubGlobal('fetch', answer(500, { error: 'studio_request_failed', message: 'The read after the save failed.' }))
  expect(await liveSource(coord).saveMapping(5, { mapping: [], split: { mode: 'single' } }))
    .toEqual({ ok: false, conflict: false, unknown: true, reason: 'The read after the save failed.', code: 'studio_request_failed' })
})

it('a 4xx stays a refusal, with the server\'s sentence and code', async () => {
  vi.stubGlobal('fetch', answer(400, { error: 'bad_projection_request', message: 'Reorder the existing axes without adding or removing dimensions' }))
  const result = await liveSource(coord).saveMapping(5, { mapping: [], split: { mode: 'single' } })
  expect(result).toEqual({ ok: false, conflict: false, reason: 'Reorder the existing axes without adding or removing dimensions', code: 'bad_projection_request' })
})
