/** RT.2 — outbound-enqueue helper: tag → createMany → re-read → fire, delay = holdUntil. */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'

const addCalls: Array<{ data: Record<string, unknown>; opts: Record<string, unknown> }> = []
vi.mock('../lib/queue.js', () => ({
  outboundSyncQueue: { name: 'outbound-sync' },
  addJobSafely: vi.fn(async (_q: unknown, _n: unknown, data: Record<string, unknown>, opts: Record<string, unknown>) => {
    addCalls.push({ data, opts })
    return { enqueued: true }
  }),
}))

import { enqueueOutboundRowsInstant, fireOutboundJobs } from './outbound-enqueue.js'

let savedFlag: string | undefined
beforeAll(() => { savedFlag = process.env.ENABLE_QUEUE_WORKERS; process.env.ENABLE_QUEUE_WORKERS = '1' })
afterAll(() => { if (savedFlag === undefined) delete process.env.ENABLE_QUEUE_WORKERS; else process.env.ENABLE_QUEUE_WORKERS = savedFlag })

describe('RT.2 — enqueueOutboundRowsInstant', () => {
  it('tags rows, re-reads by tag, fires one job per row with holdUntil as delay', async () => {
    addCalls.length = 0
    let taggedData: Array<{ payload: { enqueueBatch?: string } }> = []
    const hold = new Date(Date.now() + 30_000)
    const db = {
      outboundSyncQueue: {
        createMany: vi.fn(async ({ data }: { data: typeof taggedData }) => { taggedData = data; return { count: data.length } }),
        findMany: vi.fn(async ({ where }: { where: { payload: { equals: string } } }) => {
          // every row got the same batch tag, and the re-read filters by it
          expect(taggedData.every((r) => r.payload.enqueueBatch === where.payload.equals)).toBe(true)
          return [
            { id: 'row1', productId: 'p1', syncType: 'QUANTITY_UPDATE', holdUntil: hold },
            { id: 'row2', productId: 'p1', syncType: 'PRICE_UPDATE', holdUntil: null },
          ]
        }),
      },
    }
    const entries = await enqueueOutboundRowsInstant(db, [
      { productId: 'p1', syncType: 'QUANTITY_UPDATE', payload: { quantity: 5 }, holdUntil: hold },
      { productId: 'p1', syncType: 'PRICE_UPDATE', payload: { price: 9 } },
    ], { source: 'TEST' })

    expect(entries).toHaveLength(2)
    expect(addCalls).toHaveLength(2)
    expect(addCalls[0].opts.jobId).toBe('row1')
    const d0 = Number(addCalls[0].opts.delay)
    expect(d0).toBeGreaterThan(28_000) // ~30s hold honored
    expect(d0).toBeLessThanOrEqual(30_000)
    expect(addCalls[1].opts.delay).toBe(0) // null holdUntil ⇒ immediate
    expect(addCalls[1].data.syncType).toBe('PRICE_UPDATE')
  })

  it('empty rows: no createMany, no jobs', async () => {
    addCalls.length = 0
    const db = { outboundSyncQueue: { createMany: vi.fn(), findMany: vi.fn() } }
    const entries = await enqueueOutboundRowsInstant(db, [])
    expect(entries).toEqual([])
    expect(db.outboundSyncQueue.createMany).not.toHaveBeenCalled()
    expect(addCalls).toHaveLength(0)
  })

  it('fireOutboundJobs: past holdUntil clamps to 0', async () => {
    addCalls.length = 0
    await fireOutboundJobs([{ id: 'x', holdUntil: new Date(Date.now() - 60_000) }])
    expect(addCalls).toHaveLength(1)
    expect(addCalls[0].opts.delay).toBe(0)
  })
})
