import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:net'

import { commitMasterRow, type MasterCommitContext } from './masterWrite'
import type { SheetColumn, StudioSheet, StudioRow } from './types'
import { SheetWriter, type SheetWriteRequest } from '@/design-system/grid/editors/sheetWriter'
import { getBackendUrl } from '@/lib/backend-url'

/**
 * 🔴 THE REAL COMMIT AGAINST A CLOSED PORT (hub ruling #641, per #636).
 *
 * Every other test of this path mocks `commit`. That is exactly how the `unknown` state shipped
 * unreachable: a unit test handed the writer a commit that REJECTED, and the real one catches its
 * own network error and RETURNS `{ ok: false }`, so the writer's catch never ran and a dropped
 * connection painted `refused`. **A unit test that mocks a collaborator cannot see that the real
 * collaborator behaves differently.** So this one mocks nothing — a real `fetch`, at a real port
 * with nothing listening, through the real function.
 *
 * ⚠️ SAFETY: `getBackendUrl()` falls back to the PRODUCTION api when `NEXT_PUBLIC_API_URL` is
 * unset, and this file issues real PATCHes. Every test asserts the backend is loopback BEFORE it
 * writes anything. A missing env var must fail this file, never reach prod.
 */

let deadPort = 0

const col = (key: string, over: Partial<SheetColumn> = {}): SheetColumn =>
  ({ key, label: key, group: 'g', requiredBy: [], storage: 'categoryAttributes', ...over } as SheetColumn)

const sheet = {
  scope: { kind: 'master', label: 'Master · DE', marketplace: 'DE', locale: 'de' },
  columns: [col('name', { storage: 'column', writeField: 'name' })],
} as unknown as StudioSheet

const ctx: MasterCommitContext = { sheet, opts: {}, locale: 'de', market: 'DE' }
const req = {
  rowId: 'p1',
  row: {} as StudioRow,
  cells: [{ colId: 'name', value: 'Merino Throw' }],
  expectedVersion: 21,
} as SheetWriteRequest<StudioRow>

/** A port that was bound and released: closed for certain, rather than closed by assumption. */
const findClosedPort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      if (typeof addr === 'string' || addr === null) return reject(new Error('no port'))
      s.close(() => resolve(addr.port))
    })
  })

const prev = process.env.NEXT_PUBLIC_API_URL

beforeAll(async () => {
  deadPort = await findClosedPort()
  process.env.NEXT_PUBLIC_API_URL = `http://127.0.0.1:${deadPort}`
})
afterAll(() => {
  if (prev === undefined) delete process.env.NEXT_PUBLIC_API_URL
  else process.env.NEXT_PUBLIC_API_URL = prev
})

const loopbackOnly = () => {
  // The check that keeps this file off the production API. It is an assertion, not a comment.
  expect(getBackendUrl()).toBe(`http://127.0.0.1:${deadPort}`)
}

describe('commitMasterRow — nothing listening', () => {
  it('🔴 returns `unreachable`, not a refusal — the server was never reached', async () => {
    loopbackOnly()
    const result = await commitMasterRow(req, ctx)
    expect(result.ok).toBe(false)
    expect(result.unreachable).toBe(true)
    // And it did not silently succeed at nothing: a real connection error is the reason given.
    expect(String(result.reason)).toMatch(/fetch|ECONNREFUSED|failed/i)
  })

  it('still reports the write as finished, so the host is not left holding a write id', async () => {
    // `onWriteStart`/`onWriteEnd` bracket the nav guard. An unreachable write that never ended
    // would leave the guard armed forever and block navigation off a page nothing is writing.
    loopbackOnly()
    const started = vi.fn()
    const ended = vi.fn()
    await commitMasterRow(req, { ...ctx, opts: { onWriteStart: started, onWriteEnd: ended } })
    expect(started).toHaveBeenCalledTimes(1)
    expect(ended).toHaveBeenCalledTimes(1)
    expect(ended.mock.calls[0]?.[0]).toBe(started.mock.calls[0]?.[0])
  })
})

describe('the whole write path against a closed port — no mocks between the cell and the socket', () => {
  const tracker = () => {
    const m = new Map<string, { state: string; reason?: string }>()
    return {
      map: m,
      set: (r: string, c: string, state: string, reason?: string) => m.set(`${r}:${c}`, { state, reason }),
      get: (r: string, c: string) => m.get(`${r}:${c}`),
      clear: (r: string, c: string) => m.delete(`${r}:${c}`),
    }
  }

  it('🔴 paints UNKNOWN, raises the outage, and keeps the row — nothing is torn down', async () => {
    loopbackOnly()
    const t = tracker()
    const w = new SheetWriter<StudioRow>({
      commit: (r) => commitMasterRow(r, ctx),
      tracker: t as never,
      getApi: () => null as never,
      readRow: async () => null, // the read cannot answer either — the server is away
    })
    w.set('p1', 'name', 'Merino Throw', { row: {} as StudioRow })
    await vi.waitFor(() => expect(t.get('p1', 'name')?.state).toBe('unknown'), { timeout: 4_000 })
    expect(t.get('p1', 'name')?.state).not.toBe('refused')
    // The typed value is still the writer's, and the outage is stated once for the header.
    await vi.waitFor(() => expect(w.unreachable).toBe(true), { timeout: 4_000 })
    w.destroy()
  }, 15_000)

  it('🔴 resolves from the READ-BACK when the server returns: the DB holds it → saved', async () => {
    loopbackOnly()
    const t = tracker()
    const w = new SheetWriter<StudioRow>({
      commit: (r) => commitMasterRow(r, ctx),
      tracker: t as never,
      getApi: () => null as never,
      // The server is back and the row holds the typed value: the PATCH did land, and the answer
      // is the thing that died. Telling the operator "not saved" here is the failure this exists
      // to prevent.
      readRow: async () => ({ name: 'Merino Throw' }),
    })
    w.set('p1', 'name', 'Merino Throw', { row: {} as StudioRow })
    await vi.waitFor(() => expect(t.get('p1', 'name')?.state).toBe('saved'), { timeout: 8_000 })
    expect(w.unreachable).toBe(false)
    w.destroy()
  }, 15_000)

  it('🔴 the DB holds the old value → refused, with the sentence that says what to do', async () => {
    loopbackOnly()
    const t = tracker()
    const w = new SheetWriter<StudioRow>({
      commit: (r) => commitMasterRow(r, ctx),
      tracker: t as never,
      getApi: () => null as never,
      readRow: async () => ({ name: 'Alpaca Throw' }),
    })
    w.set('p1', 'name', 'Merino Throw', { row: {} as StudioRow })
    await vi.waitFor(() => expect(t.get('p1', 'name')?.state).toBe('refused'), { timeout: 8_000 })
    expect(t.get('p1', 'name')?.reason).toMatch(/stored value differs.*review/i)
    expect(w.unreachable).toBe(false)
    w.destroy()
  }, 15_000)
})
