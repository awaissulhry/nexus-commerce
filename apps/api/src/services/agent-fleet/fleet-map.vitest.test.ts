/**
 * NAF.SB.M-S9R — the map endpoint, against the states a healthy fleet cannot
 * show you.
 *
 * This file exists because Section 9 found that the only verification this
 * endpoint has ever had is `scripts/_sbm-map-check.mts` — thirteen assertions
 * written on the day it shipped, by the same person who wrote the bug Section 7
 * later found. It asserts what the service produces from real data, which means
 * it can only ever check the states production happens to be in.
 *
 * A degraded read is not one of those states. So it is forced here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    agentRun: { groupBy: vi.fn(async () => []), findMany: vi.fn(async () => []) },
    agentFinding: { findMany: vi.fn(async () => []) },
    agentPlan: { findMany: vi.fn(async () => []) },
    agentApproval: { findMany: vi.fn(async () => []) },
  },
}))
vi.mock('./charter-registry.js', () => ({ listCharters: vi.fn(async () => []) }))
vi.mock('./fleet-labels.service.js', () => ({ resolveFleetLabels: vi.fn(async () => new Map()) }))
vi.mock('./fleet-schedule.service.js', () => ({ getFleetSchedule: vi.fn() }))
vi.mock('./fleet-state.service.js', () => ({ getFleetState: vi.fn() }))
vi.mock('./workflow-registry.service.js', () => ({ getEffectiveWiring: vi.fn(async () => []) }))

import { getFleetSchedule } from './fleet-schedule.service.js'
import { getFleetState } from './fleet-state.service.js'
import { getFleetMap } from './fleet-map.service.js'

const schedule = vi.mocked(getFleetSchedule)
const state = vi.mocked(getFleetState)

beforeEach(() => {
  vi.clearAllMocks()
  state.mockResolvedValue({
    halted: false,
    haltedAt: null,
    haltReason: null,
    haltedBy: null,
    dailyCeilingUSD: 2,
    updatedAt: new Date(),
  } as never)
  schedule.mockResolvedValue({ jobs: [] } as never)
})

describe('S9.a — a schedule that cannot be read says so', () => {
  it('still returns the rest of the map', async () => {
    schedule.mockRejectedValue(new Error('forced: schedule unreadable'))
    const m = await getFleetMap('7d')
    // Degrading is the right call: an unreadable schedule is no reason to deny
    // the operator the workers, the edges and the spend figure.
    expect(m.schedule).toEqual([])
    expect(m.state.dailyCeilingUSD).toBe(2)
  })

  it('pushes a warning, so absence and failure do not look alike', async () => {
    schedule.mockRejectedValue(new Error('forced: schedule unreadable'))
    const m = await getFleetMap('7d')
    expect(
      m.warnings.some((w) => w.includes('schedule could not be read')),
      'an unreadable schedule rendered identically to a fleet with nothing scheduled',
    ).toBe(true)
  })

  it('says nothing when the schedule is merely empty', async () => {
    schedule.mockResolvedValue({ jobs: [] } as never)
    const m = await getFleetMap('7d')
    expect(m.schedule).toEqual([])
    expect(m.warnings.some((w) => w.includes('schedule could not be read'))).toBe(false)
  })
})
