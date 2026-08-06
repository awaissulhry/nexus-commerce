/**
 * Pre-F hardening: a builder hang or process death mid-run leaves an
 * AgentRun stuck 'running' forever (observed risk in the Phase B
 * supervised runs — no executor timeout exists). The sweep and council
 * reclaim fleet runs stuck past the cutoff: done, not-ok, reason
 * recorded — never silently deleted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: { agentRun: { updateMany: vi.fn() } },
}))

import prisma from '../../db.js'
import { reclaimStuckRuns } from './orchestrator.js'

const db = vi.mocked(prisma, true)

beforeEach(() => {
  vi.clearAllMocks()
  db.agentRun.updateMany.mockResolvedValue({ count: 2 } as never)
})

describe('reclaimStuckRuns', () => {
  it('closes fleet runs stuck running past the cutoff, with the reason on the row', async () => {
    const n = await reclaimStuckRuns(2)
    expect(n).toBe(2)
    const args = db.agentRun.updateMany.mock.calls[0]![0]! as {
      where: Record<string, unknown>
      data: Record<string, unknown>
    }
    expect(args.where.status).toBe('running')
    expect(args.where.mode).toEqual({ not: null }) // fleet runs only — ACP copilot untouched
    expect((args.where.createdAt as { lt: Date }).lt).toBeInstanceOf(Date)
    expect(args.data.status).toBe('done')
    expect(args.data.ok).toBe(false)
    expect(String(args.data.haltedReason)).toMatch(/orphaned/)
    expect(args.data.endedAt).toBeInstanceOf(Date)
  })
})
