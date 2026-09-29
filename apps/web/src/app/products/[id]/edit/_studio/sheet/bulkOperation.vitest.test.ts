import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/backend-url', () => ({ getBackendUrl: () => 'http://api.test' }))

import { runBulkOperation, type BulkAnswer, type BulkSaveUnitWire, type BulkSend } from './bulkOperation'
import type { SheetWriteRequest, SheetWriteResult } from '@/design-system/grid'

/**
 * `runBulkOperation` — every row runs its OWN commit, and the operation leaves as ONE request per round.
 * The row commits here are stand-ins that do what the real ones do with a send: post a body, read the answer.
 */
type Row = { id: string }
const request = (rowId: string): SheetWriteRequest<Row> => ({ rowId, row: { id: rowId }, cells: [{ colId: 'theme', value: 'clean', intent: 'set' }], expectedVersion: 1 })
const reply = (status: number, body: unknown): BulkAnswer => ({ status, ok: status >= 200 && status < 300, json: async () => body })

/** A server stand-in: records each POST and answers every unit 200 unless `unitStatus` says otherwise. */
function server(unitStatus: (unit: BulkSaveUnitWire) => number | null = () => 200) {
  const posts: Array<{ operationId: string; units: BulkSaveUnitWire[] }> = []
  const post = vi.fn(async (operationId: string, units: BulkSaveUnitWire[]) => {
    posts.push({ operationId, units })
    return reply(200, { units: units.flatMap((u) => { const status = unitStatus(u); return status === null ? [] : [{ key: u.key, status, body: { updated: 1, row: (u.changes as Array<{ id: string }>)[0].id } }] }) })
  })
  return { posts, post }
}

/** The shape of the real commits: build a body, send it, read status and body. */
const oneSend = async (req: SheetWriteRequest<Row>, send: BulkSend): Promise<SheetWriteResult> => {
  const res = await send({ changes: [{ id: req.rowId, field: 'attr_theme', value: 'clean' }] })
  const body = await res.json()
  return res.ok ? { ok: true, reason: body.row } : { ok: false, reason: `HTTP ${res.status}`, unreachable: res.status >= 500 }
}

describe('runBulkOperation', () => {
  it('sends every row of the operation as ONE request and hands each row its own answer', async () => {
    const { posts, post } = server()
    const results = await runBulkOperation(['a', 'b', 'c'].map(request), oneSend, { post, operationId: 'op-1' })
    expect(posts).toHaveLength(1)
    expect(posts[0].operationId).toBe('op-1:1:0')
    expect(posts[0].units.map((u) => (u.changes as Array<{ id: string }>)[0].id)).toEqual(['a', 'b', 'c'])
    expect([...results].map(([rowId, r]) => [rowId, r.ok, r.reason])).toEqual([['a', true, 'a'], ['b', true, 'b'], ['c', true, 'c']])
  })

  it('a row that must send again (its second language, a retry) waits for the NEXT round; the others do not resend', async () => {
    const { posts, post } = server()
    const twice = async (req: SheetWriteRequest<Row>, send: BulkSend): Promise<SheetWriteResult> => {
      await send({ changes: [{ id: req.rowId, field: 'title@it' }] })
      if (req.rowId === 'b') await send({ changes: [{ id: req.rowId, field: 'title@de' }] })
      return { ok: true }
    }
    await runBulkOperation(['a', 'b', 'c'].map(request), twice, { post })
    expect(posts.map((p) => p.units.map((u) => (u.changes as Array<{ field: string }>)[0].field))).toEqual([['title@it', 'title@it', 'title@it'], ['title@de']])
  })

  it('waits for a row that is still busy elsewhere before posting, so the operation stays one request', async () => {
    const { posts, post } = server()
    const slowFirst = async (req: SheetWriteRequest<Row>, send: BulkSend): Promise<SheetWriteResult> => {
      if (req.rowId === 'a') await new Promise((resolve) => setTimeout(resolve, 20)) // e.g. its variation-theme route first
      return oneSend(req, send)
    }
    await runBulkOperation(['a', 'b'].map(request), slowFirst, { post })
    expect(posts).toHaveLength(1)
    expect(posts[0].units).toHaveLength(2)
  })

  it('a unit the answer does not name is NOT saved: the row hears 502 (no answer)', async () => {
    const { post } = server((u) => ((u.changes as Array<{ id: string }>)[0].id === 'b' ? null : 200))
    const results = await runBulkOperation(['a', 'b'].map(request), oneSend, { post })
    expect(results.get('a')).toMatchObject({ ok: true })
    expect(results.get('b')).toMatchObject({ ok: false, reason: 'HTTP 502', unreachable: true })
  })

  it('a whole-operation refusal reaches every row with the operation\'s own status and body', async () => {
    const post = vi.fn(async () => reply(503, { error: 'The database was busy. Nothing of this change was saved. Try again.', nothingSaved: true }))
    const seen: unknown[] = []
    await runBulkOperation(['a', 'b'].map(request), async (req, send) => {
      const res = await send({ changes: [{ id: req.rowId }] })
      seen.push([res.status, await res.json()])
      return { ok: false }
    }, { post })
    expect(post).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([[503, expect.objectContaining({ nothingSaved: true })], [503, expect.objectContaining({ nothingSaved: true })]])
  })

  it('a dropped connection is an UNKNOWN outcome for every row, never a refusal', async () => {
    const post = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    const results = await runBulkOperation(['a', 'b'].map(request), oneSend, { post })
    expect([...results.values()].every((r) => r.ok === false && r.unreachable === true)).toBe(true)
  })

  it('an operation beyond the server bound leaves as consecutive requests of one round', async () => {
    const { posts, post } = server()
    const ids = Array.from({ length: 2_001 }, (_, i) => `r${i}`)
    const results = await runBulkOperation(ids.map(request), oneSend, { post, operationId: 'big' })
    expect(posts.map((p) => [p.operationId, p.units.length])).toEqual([['big:1:0', 2_000], ['big:1:1', 1]])
    expect([...results.values()].every((r) => r.ok)).toBe(true)
  })
})
