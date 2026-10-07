/**
 * Economics feed, 2026-10-07 — the Data Kiosk poll reaches a new day's query even when old queries keep failing.
 *
 * The poll takes `limit` open jobs, least recently polled first. A new job has lastPolledAt = null and Postgres sorts
 * NULL LAST in ascending order, so with `limit` old jobs that fail on every poll (they stay IN_PROGRESS and are polled
 * again) the new job was never picked: no new economics day was ever ingested. The fake below sorts as Postgres does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Job = { id: string; externalQueryId: string; status: string; lastPolledAt: Date | null; createdAt: Date }
type Order = { sort: 'asc' | 'desc'; nulls?: 'first' | 'last' } | 'asc' | 'desc'

const state = vi.hoisted(() => ({ jobs: [] as Array<Record<string, unknown>>, statusCalls: [] as string[] }))

/** Postgres ordering: NULLS LAST for asc and NULLS FIRST for desc unless `nulls` says otherwise. */
function pgCompare(a: Job, b: Job, orderBy: Array<Record<string, Order>>): number {
  for (const term of orderBy) {
    const [field, spec] = Object.entries(term)[0] as [keyof Job, Order]
    const sort = typeof spec === 'string' ? spec : spec.sort
    const nulls = typeof spec === 'string' ? (sort === 'asc' ? 'last' : 'first') : (spec.nulls ?? (sort === 'asc' ? 'last' : 'first'))
    const x = a[field] as Date | null
    const y = b[field] as Date | null
    if (x === null && y === null) continue
    if (x === null) return nulls === 'first' ? -1 : 1
    if (y === null) return nulls === 'first' ? 1 : -1
    const d = x.getTime() - y.getTime()
    if (d !== 0) return sort === 'asc' ? d : -d
  }
  return 0
}

vi.mock('../../db.js', () => ({
  default: {
    dataKioskQueryJob: {
      findMany: async (args: { orderBy: Array<Record<string, Order>>; take: number }) =>
        (state.jobs as Job[])
          .filter((j) => ['PENDING', 'IN_PROGRESS'].includes(j.status))
          .sort((a, b) => pgCompare(a, b, args.orderBy))
          .slice(0, args.take),
      update: async () => ({}),
    },
  },
}))

vi.mock('../../lib/amazon-sp-client.js', () => ({
  amazonSpClient: {},
  getAmazonSpClient: async () => ({
    callAPI: async ({ api_path }: { api_path: string }) => {
      const queryId = api_path.split('/').pop()!
      state.statusCalls.push(queryId)
      if (queryId.startsWith('old-')) throw new Error('InternalFailure')
      return { processingStatus: 'IN_PROGRESS' }
    },
  }),
}))

import { runDataKioskPollCycle } from './data-kiosk.service.js'

beforeEach(() => {
  state.statusCalls = []
  const day = (d: number) => new Date(Date.UTC(2026, 8, d))
  // Ten old queries that fail on every poll, each polled before, and today's query, never polled.
  state.jobs = [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `j${i}`, externalQueryId: `old-${i}`, status: 'IN_PROGRESS', lastPolledAt: day(20 + i), createdAt: day(10 + i) })),
    { id: 'today', externalQueryId: 'new-today', status: 'IN_PROGRESS', lastPolledAt: null, createdAt: day(30) },
  ]
})

describe('Data Kiosk poll order', () => {
  it('a query never polled is polled first, even behind ten old ones that keep failing', async () => {
    const out = await runDataKioskPollCycle(10)
    expect(state.statusCalls[0]).toBe('new-today')
    expect(state.statusCalls).toHaveLength(10)
    expect(out.stillRunning).toBe(1)
    expect(out.errors).toHaveLength(9)
  })

  it('among jobs polled before, the least recently polled goes first', async () => {
    state.jobs = state.jobs.filter((j) => j.id !== 'today')
    await runDataKioskPollCycle(3)
    expect(state.statusCalls).toEqual(['old-0', 'old-1', 'old-2'])
  })
})
