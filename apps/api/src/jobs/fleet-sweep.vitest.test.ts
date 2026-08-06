/**
 * NAF.B — sweep job: orchestrate → grade → summarize, with an overlap guard.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../db.js', () => ({
  default: { agentRun: { findMany: vi.fn() } },
}))
vi.mock('../services/agent-fleet/orchestrator.js', () => ({
  runFleet: vi.fn(),
  reclaimStuckRuns: vi.fn(async () => 0),
}))
vi.mock('../services/agent-fleet/shadow-grade.service.js', () => ({
  gradeFindings: vi.fn(),
}))

import prisma from '../db.js'
import { runFleet } from '../services/agent-fleet/orchestrator.js'
import { gradeFindings } from '../services/agent-fleet/shadow-grade.service.js'
import { runFleetSweepOnce } from './fleet-sweep.job.js'

const db = vi.mocked(prisma, true)
const fleet = vi.mocked(runFleet)
const grade = vi.mocked(gradeFindings)

beforeEach(() => {
  vi.clearAllMocks()
  fleet.mockResolvedValue({
    orchestrationId: 'orch_1',
    started: 4,
    succeeded: 3,
    failed: 0,
    skipped: 1,
  } as never)
  db.agentRun.findMany.mockResolvedValue([
    { id: 'r1', costUSD: 0.014 },
    { id: 'r2', costUSD: 0.02 },
  ] as never)
  grade.mockResolvedValue({ graded: 5, skipped: 1 } as never)
})

describe('runFleetSweepOnce', () => {
  it('orchestrates a sweep, grades its runs, and summarizes honestly', async () => {
    const summary = await runFleetSweepOnce()
    expect(fleet).toHaveBeenCalledWith('sweep')
    expect(grade).toHaveBeenCalledWith(['r1', 'r2'])
    expect(summary).toContain('started=4')
    expect(summary).toContain('ok=3')
    expect(summary).toContain('skipped=1')
    expect(summary).toContain('graded=5')
    expect(summary).toContain('cost=$0.0340')
  })

  it('carries a halt reason into the summary', async () => {
    fleet.mockResolvedValue({
      orchestrationId: 'orch_2',
      started: 0,
      succeeded: 0,
      failed: 0,
      skipped: 4,
      haltedReason: 'fleet_halted: operator stop',
    } as never)
    const summary = await runFleetSweepOnce()
    expect(summary).toContain('halted=fleet_halted')
  })

  it('a second concurrent invocation is skipped by the overlap guard', async () => {
    let release!: () => void
    fleet.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              orchestrationId: 'orch_3',
              started: 1,
              succeeded: 1,
              failed: 0,
              skipped: 0,
            } as never)
        }),
    )
    const first = runFleetSweepOnce()
    const second = await runFleetSweepOnce()
    expect(second).toBe('skipped=overlap')
    // the first invocation awaits the stuck-run reclaim before runFleet —
    // wait until it has actually armed the release
    await vi.waitFor(() => expect(fleet).toHaveBeenCalled())
    release()
    await first
    expect(fleet).toHaveBeenCalledTimes(1)
  })
})
