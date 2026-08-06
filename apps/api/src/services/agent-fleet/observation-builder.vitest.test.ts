/**
 * NAF.A — observation builder: deterministic evidence, TTL-cached into
 * AgentObservation so twenty agents reading the same evidence trigger one
 * computation (docs/AGENT_FLEET.md 9.2 §4).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    agentObservation: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    cronRun: {
      groupBy: vi.fn(),
    },
  },
}))

import prisma from '../../db.js'
import { getObservation } from './observation-builder.js'
import { cronHealthBuilder } from './observations/cron-health.observation.js'

const findFirst = vi.mocked(prisma.agentObservation.findFirst)
const create = vi.mocked(prisma.agentObservation.create)
const update = vi.mocked(prisma.agentObservation.update)
const groupBy = vi.mocked(prisma.cronRun.groupBy)

beforeEach(() => {
  vi.clearAllMocks()
})

const FUTURE = new Date(Date.now() + 10 * 60_000)
const PAST = new Date(Date.now() - 10 * 60_000)

describe('getObservation', () => {
  it('throws a typed error for an unknown builder key', async () => {
    await expect(getObservation('no-such-evidence')).rejects.toThrow(
      /unknown observation builder/,
    )
  })

  it('returns the cached row and never computes when fresh', async () => {
    findFirst.mockResolvedValue({
      id: 'obs_1',
      payload: { jobs: [] },
      dataVintage: PAST,
      computedAt: PAST,
      expiresAt: FUTURE,
    } as never)
    const r = await getObservation('cron-health')
    expect(r.cached).toBe(true)
    expect(r.id).toBe('obs_1')
    expect(groupBy).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('recomputes and updates in place when the row is expired', async () => {
    findFirst.mockResolvedValue({
      id: 'obs_1',
      payload: { jobs: [] },
      dataVintage: PAST,
      computedAt: PAST,
      expiresAt: PAST,
    } as never)
    groupBy.mockResolvedValue([] as never)
    update.mockImplementation(
      (args: never) =>
        Promise.resolve({
          id: 'obs_1',
          computedAt: new Date(),
          ...(args as { data: object }).data,
        }) as never,
    )
    const r = await getObservation('cron-health')
    expect(r.cached).toBe(false)
    expect(r.id).toBe('obs_1')
    expect(update).toHaveBeenCalledTimes(1)
    expect(create).not.toHaveBeenCalled()
  })

  it('creates the row on first computation', async () => {
    findFirst.mockResolvedValue(null)
    groupBy.mockResolvedValue([] as never)
    create.mockImplementation(
      (args: never) =>
        Promise.resolve({
          id: 'obs_new',
          computedAt: new Date(),
          ...(args as { data: object }).data,
        }) as never,
    )
    const r = await getObservation('cron-health')
    expect(r.cached).toBe(false)
    expect(r.id).toBe('obs_new')
    expect(create).toHaveBeenCalledTimes(1)
  })
})

describe('cronHealthBuilder', () => {
  it('shapes failures, staleness and stuck-running from grouped rows', async () => {
    const now = Date.now()
    const h = (n: number) => new Date(now - n * 3600_000)
    groupBy.mockResolvedValue([
      // healthy frequent job
      { jobName: 'ads-sync', status: 'SUCCESS', _count: { _all: 40 }, _max: { startedAt: h(0.2) } },
      // failing job: 9 failures, no successes
      { jobName: 'ads-tos-is-ingest', status: 'FAILED', _count: { _all: 9 }, _max: { startedAt: h(2) } },
      // stale job: last run 20h ago
      { jobName: 'forecast', status: 'SUCCESS', _count: { _all: 1 }, _max: { startedAt: h(20) } },
      // stuck RUNNING for 5h
      { jobName: 'report-poll', status: 'RUNNING', _count: { _all: 1 }, _max: { startedAt: h(5) } },
      { jobName: 'report-poll', status: 'SUCCESS', _count: { _all: 60 }, _max: { startedAt: h(6) } },
    ] as never)

    const { payload, dataVintage } = await cronHealthBuilder.build({})
    const p = payload as {
      windowHours: number
      totalJobs: number
      healthyOmitted: number
      jobs: Array<Record<string, unknown>>
    }
    expect(dataVintage).toBeInstanceOf(Date)
    expect(p.windowHours).toBe(24)
    expect(p.totalJobs).toBe(4)

    const byName = new Map(p.jobs.map((j) => [j.jobName, j]))
    const failing = byName.get('ads-tos-is-ingest')!
    expect(failing.failures).toBe(9)
    expect(failing.runs).toBe(9)
    expect(failing.lastStatus).toBe('FAILED')

    const stale = byName.get('forecast')!
    expect(stale.staleHours).toBeGreaterThanOrEqual(19)

    const stuck = byName.get('report-poll')!
    expect(stuck.stuckRunning).toBe(1)
    // RUNNING at h(5) is the latest row for report-poll
    expect(stuck.lastStatus).toBe('RUNNING')

    // the healthy frequent job is omitted from the interesting list…
    expect(byName.has('ads-sync')).toBe(false)
    // …but counted, so the analyst knows the omission is screening, not absence
    expect(p.healthyOmitted).toBe(1)
  })
})
