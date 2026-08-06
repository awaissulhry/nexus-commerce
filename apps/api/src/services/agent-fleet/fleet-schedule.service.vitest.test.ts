/**
 * FX.1 — the cron next-fire evaluator: exact times for the fleet's two
 * schedules, standard dom/dow semantics, honest null on junk.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: { cronRun: { findFirst: vi.fn() } },
}))

import prisma from '../../db.js'
import { getFleetSchedule, nextCronFire } from './fleet-schedule.service.js'

const db = vi.mocked(prisma, true)

beforeEach(() => {
  vi.clearAllMocks()
  db.cronRun.findFirst.mockResolvedValue(null as never)
})

describe('nextCronFire', () => {
  it("the sweep ('45 4 * * *') from mid-day fires tomorrow 04:45Z", () => {
    const next = nextCronFire('45 4 * * *', new Date('2026-08-06T20:00:00Z'))
    expect(next?.toISOString()).toBe('2026-08-07T04:45:00.000Z')
  })

  it('from just before the slot, fires the same day', () => {
    const next = nextCronFire('45 4 * * *', new Date('2026-08-06T04:00:00Z'))
    expect(next?.toISOString()).toBe('2026-08-06T04:45:00.000Z')
  })

  it("the council ('15 5 * * 1') fires next Monday", () => {
    // 2026-08-06 is a Thursday → next Monday is 2026-08-10.
    const next = nextCronFire('15 5 * * 1', new Date('2026-08-06T20:00:00Z'))
    expect(next?.toISOString()).toBe('2026-08-10T05:15:00.000Z')
  })

  it('exactly at the slot does NOT match the same minute (next occurrence)', () => {
    const next = nextCronFire('45 4 * * *', new Date('2026-08-06T04:45:00Z'))
    expect(next?.toISOString()).toBe('2026-08-07T04:45:00.000Z')
  })

  it('steps and ranges parse', () => {
    const next = nextCronFire('*/15 9-17 * * *', new Date('2026-08-06T09:07:00Z'))
    expect(next?.toISOString()).toBe('2026-08-06T09:15:00.000Z')
  })

  it('junk expressions return null, never a guess', () => {
    expect(nextCronFire('not a cron', new Date())).toBeNull()
    expect(nextCronFire('99 4 * * *', new Date())).toBeNull()
  })
})

describe('getFleetSchedule', () => {
  it('reports both jobs with enablement and last runs', async () => {
    process.env.NEXUS_ENABLE_FLEET_SWEEP_CRON = '1'
    db.cronRun.findFirst.mockResolvedValue({
      startedAt: new Date('2026-08-06T04:45:01Z'),
      status: 'SUCCESS',
      outputSummary: 'started=0 ok=0 skipped=4',
    } as never)
    const s = await getFleetSchedule(new Date('2026-08-06T20:00:00Z'))
    expect(s.jobs.map((j) => j.key)).toEqual(['fleet-sweep', 'fleet-council'])
    expect(s.jobs[0]!.nextFireAt?.toISOString()).toBe('2026-08-07T04:45:00.000Z')
    expect(s.jobs[0]!.lastRun?.status).toBe('SUCCESS')
  })

  it('disabled flag → no next fire claimed', async () => {
    process.env.NEXUS_ENABLE_FLEET_SWEEP_CRON = '0'
    const s = await getFleetSchedule(new Date('2026-08-06T20:00:00Z'))
    expect(s.jobs[0]!.enabled).toBe(false)
    expect(s.jobs[0]!.nextFireAt).toBeNull()
  })
})
