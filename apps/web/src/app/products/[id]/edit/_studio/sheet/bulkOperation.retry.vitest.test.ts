import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CellSaveTracker } from '@/design-system/grid/editors/roundTrip'
import { SheetWriter, type SheetWriteRequest, type SheetWriteResult } from '@/design-system/grid/editors/sheetWriter'
import { postBulkSave, runBulkOperation, type BulkAnswer, type BulkSaveUnitWire, type BulkSend } from './bulkOperation'

vi.mock('@/lib/backend-url', () => ({ getBackendUrl: () => 'http://api.test' }))

type Row = { id: string }
const req: SheetWriteRequest<Row> = { rowId: 'row', row: { id: 'row' }, cells: [{ colId: 'name', value: 'first', intent: 'set' }], expectedVersion: 7 }
const busy = { error: 'Database busy. Nothing was saved.', retryable: true, nothingSaved: true }
const reply = (status: number, body: unknown, retryAfter?: string): BulkAnswer & { retryAfter?: string } => ({ status, ok: status >= 200 && status < 300, json: async () => body, retryAfter })
const saved = (units: BulkSaveUnitWire[]) => reply(200, { units: units.map(unit => ({ key: unit.key, status: 200, body: { version: Number(unit.expectedVersion) + 1 } })) })
const commit = async (request: SheetWriteRequest<Row>, send: BulkSend): Promise<SheetWriteResult> => {
  const response = await send({ expectedVersion: request.expectedVersion, changes: request.cells.map(cell => ({ id: request.rowId, field: cell.colId, value: cell.value })) })
  const body = await response.json()
  return response.ok ? { ok: true, version: body.version } : { ok: false, reason: body?.error ?? 'Unknown result', unreachable: response.status >= 500 && body?.nothingSaved !== true }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('confirmed rolled-back busy operations', () => {
  it('waits for Retry-After then sends exactly the same operation ID, unit keys and payload', async () => {
    const posts: Array<{ id: string; body: string }> = []
    const post = vi.fn(async (id: string, units: BulkSaveUnitWire[]) => {
      posts.push({ id, body: JSON.stringify(units) })
      return posts.length === 1 ? reply(503, busy, '2') : saved(units)
    })
    const result = runBulkOperation([req], commit, { post, operationId: 'stable' })
    await vi.advanceTimersByTimeAsync(1)
    expect(posts).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1998)
    expect(posts).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2)
    expect((await result).get('row')).toEqual({ ok: true, version: 8 })
    expect(posts).toHaveLength(2)
    expect(posts[1]).toEqual(posts[0])
    expect(posts[0].id).toBe('stable:1:0')
  })


  it('takes one wire snapshot even if an input object is changed during the wait', async () => {
    const value = { nested: ['first'] }
    const bodies: string[] = []
    const post = vi.fn(async (_id: string, units: BulkSaveUnitWire[]) => {
      bodies.push(JSON.stringify(units))
      if (bodies.length === 1) { value.nested[0] = 'later'; return reply(503, busy, '2') }
      return saved(units)
    })
    const result = runBulkOperation([{ ...req, cells: [{ colId: 'value', value, intent: 'set' }] }], commit, { post })
    await vi.runAllTimersAsync()
    expect((await result).get('row')?.ok).toBe(true)
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toBe(bodies[0])
    expect(JSON.parse(bodies[1])[0].changes[0].value).toEqual({ nested: ['first'] })
  })

  it('does not retry again when the next answer is an unknown 503', async () => {
    let calls = 0
    const post = vi.fn(async () => ++calls === 1 ? reply(503, busy, '2') : reply(503, { error: 'Proxy unavailable' }))
    const result = runBulkOperation([req], commit, { post })
    await vi.runAllTimersAsync()
    expect((await result).get('row')?.unreachable).toBe(true)
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('stops after two retries and returns the truthful refusal', async () => {
    const post = vi.fn(async () => reply(503, busy, '2'))
    const result = runBulkOperation([req], commit, { post })
    await vi.runAllTimersAsync()
    expect(post).toHaveBeenCalledTimes(3)
    expect((await result).get('row')).toEqual({ ok: false, reason: busy.error, unreachable: false })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    [503, {}, '2'], [503, { nothingSaved: true }, '2'], [503, { retryable: true }, '2'],
    [503, { ...busy, nothingSaved: 'true' }, '2'], [503, { ...busy, saved: 1 }, '2'],
    [503, { ...busy, units: [] }, '2'], [503, busy, undefined], [503, busy, 'invalid'],
    [503, busy, '31'], [503, busy, '-1'], [409, busy, '2'], [500, busy, '2'], [502, busy, '2'],
    [200, { units: [{ key: 'row#1', status: 503, body: busy }] }, '2'],
  ])('does not replay status %s with incomplete, contradictory or non-retryable claims %j', async (status, body, retryAfter) => {
    const post = vi.fn(async () => reply(status as number, body, retryAfter as string | undefined))
    const result = runBulkOperation([req], commit, { post })
    await vi.runAllTimersAsync()
    await result
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('does not replay a dropped connection or unreadable proxy answer', async () => {
    for (const post of [vi.fn(async () => { throw new TypeError('Failed to fetch') }), vi.fn(async () => ({ status: 503, ok: false, json: async () => { throw new Error('bad JSON') } }))]) {
      const result = runBulkOperation([req], commit, { post })
      await vi.runAllTimersAsync()
      expect((await result).get('row')?.unreachable).toBe(true)
      expect(post).toHaveBeenCalledTimes(1)
    }
  })

  it('cancels a scheduled retry on disposal without turning the known refusal into an unknown result', async () => {
    const controller = new AbortController()
    const post = vi.fn(async () => reply(503, busy, '2'))
    const result = runBulkOperation([req], commit, { post, retrySignal: controller.signal })
    await vi.advanceTimersByTimeAsync(1)
    controller.abort()
    await vi.runAllTimersAsync()
    expect(post).toHaveBeenCalledTimes(1)
    expect((await result).get('row')).toEqual({ ok: false, reason: busy.error, unreachable: false })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('accepts an HTTP date Retry-After without replaying before that date', async () => {
    vi.setSystemTime(new Date('2026-09-30T12:00:00Z'))
    let calls = 0
    const post = vi.fn(async (_id: string, units: BulkSaveUnitWire[]) => ++calls === 1 ? reply(503, busy, 'Wed, 30 Sep 2026 12:00:02 GMT') : saved(units))
    const result = runBulkOperation([req], commit, { post })
    await vi.advanceTimersByTimeAsync(1999)
    expect(post).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect((await result).get('row')?.ok).toBe(true)
    expect(post).toHaveBeenCalledTimes(2)
  })
})

describe('the real writer during busy retry', () => {

  it.each(['discard', 'destroy'] as const)('%s cancels the retry and re-arming cannot revive the old operation', async action => {
    const post = vi.fn(async () => reply(503, busy, '2'))
    const tracker = new CellSaveTracker()
    const writer: SheetWriter<Row> = new SheetWriter<Row>({ tracker, getApi: () => null, commit: async () => ({ ok: true }), flushMs: 5,
      commitBatch: requests => runBulkOperation(requests, commit, { post, retrySignal: writer.retrySignal }) })
    writer.seed([{ id: 'row', version: 7 }])
    writer.set('row', 'name', 'first')
    const captured = writer.retrySignal
    await vi.advanceTimersByTimeAsync(10)
    expect(post).toHaveBeenCalledTimes(1)
    expect(writer.pending).toBe(1)
    writer[action]()
    expect(captured.aborted).toBe(true)
    writer.arm()
    expect(writer.retrySignal.aborted).toBe(false)
    expect(writer.retrySignal).not.toBe(captured)
    await vi.runAllTimersAsync()
    expect(post).toHaveBeenCalledTimes(1)
    expect(writer.pending).toBe(0)
    writer.destroy()
  })

  it('keeps Saving and newer edits queued, then sends the newer value with the confirmed version', async () => {
    const posts: Array<{ id: string; units: BulkSaveUnitWire[] }> = []
    const post = vi.fn(async (id: string, units: BulkSaveUnitWire[]) => {
      posts.push({ id, units: structuredClone(units) })
      return posts.length === 1 ? reply(503, busy, '2') : saved(units)
    })
    const tracker = new CellSaveTracker()
    const writer: SheetWriter<Row> = new SheetWriter<Row>({ tracker, getApi: () => null, commit: async () => ({ ok: true }), flushMs: 5, commitBatch: requests => runBulkOperation(requests, commit, { post }) })
    writer.seed([{ id: 'row', version: 7 }])
    writer.set('row', 'name', 'first')
    await vi.advanceTimersByTimeAsync(10)
    expect(writer.pending).toBe(1)
    expect(tracker.get('row', 'name')?.state).toBe('saving')
    writer.set('row', 'name', 'newer')
    await vi.advanceTimersByTimeAsync(1000)
    expect(posts).toHaveLength(1)
    expect(writer.pending).toBe(2)
    await vi.advanceTimersByTimeAsync(1020)
    expect(posts).toHaveLength(3)
    expect(posts[1]).toEqual(posts[0])
    expect(posts[2].id).not.toBe(posts[0].id)
    expect(posts[2].units[0]).toMatchObject({ expectedVersion: 8, changes: [{ id: 'row', field: 'name', value: 'newer' }] })
    expect(writer.versionOf('row')).toBe(9)
    expect(writer.pending).toBe(0)
    expect(tracker.get('row', 'name')?.state).toBe('saved')
    writer.destroy()
  })

  it('leaves a refused edit available for a successful manual retry after exhaustion', async () => {
    let allowSave = false
    const post = vi.fn(async (_id: string, units: BulkSaveUnitWire[]) => allowSave ? saved(units) : reply(503, busy, '2'))
    const tracker = new CellSaveTracker()
    const writer: SheetWriter<Row> = new SheetWriter<Row>({ tracker, getApi: () => null, commit: async () => ({ ok: true }), flushMs: 5, commitBatch: requests => runBulkOperation(requests, commit, { post }) })
    writer.seed([{ id: 'row', version: 7 }])
    writer.set('row', 'name', 'first')
    await vi.runAllTimersAsync()
    expect(post).toHaveBeenCalledTimes(3)
    expect(writer.failedCount).toBe(1)
    expect(tracker.get('row', 'name')?.state).toBe('refused')
    expect(writer.versionOf('row')).toBe(7)
    allowSave = true
    expect(writer.retryFailed()).toBe(1)
    await vi.advanceTimersByTimeAsync(10)
    expect(post).toHaveBeenCalledTimes(4)
    expect(writer.failedCount).toBe(0)
    expect(tracker.get('row', 'name')?.state).toBe('saved')
    writer.destroy()
  })
})


it('carries the real response Retry-After through the keyed request transport', async () => {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(busy), { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '2' } }))
  vi.stubGlobal('fetch', fetch)
  try {
    const result = await postBulkSave('unchanged-key', [{ key: 'row#1', changes: [{ id: 'row', field: 'name', value: 'first' }] }])
    expect(result.retryAfter).toBe('2')
    expect(await result.json()).toEqual(busy)
    const init = fetch.mock.calls[0][1] as RequestInit
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe('unchanged-key')
    expect(JSON.parse(init.body as string).operationId).toBe('unchanged-key')
  } finally { vi.unstubAllGlobals() }
})
