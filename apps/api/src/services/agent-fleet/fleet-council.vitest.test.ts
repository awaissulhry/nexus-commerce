/**
 * NAF.C — council post-processing: deterministic enforcement over the
 * critic's verdict, queueing through the real gate seam, stale-approval
 * expiry. Includes the spec's seeded adversarial case: a plan containing
 * a protected-term negation is blocked whatever the model said.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    agentApproval: { updateMany: vi.fn(), findMany: vi.fn() },
    agentRun: { findFirst: vi.fn() },
    agentPlan: { findUnique: vi.fn(), update: vi.fn() },
    agentFinding: { findMany: vi.fn() },
    adTarget: { findMany: vi.fn() },
  },
}))
vi.mock('./orchestrator.js', () => ({ runFleet: vi.fn() }))
vi.mock('../agents/approval-gate.service.js', () => ({
  runOrQueueTool: vi.fn(),
}))
vi.mock('../agents/tool-registry.js', () => ({ getTool: vi.fn() }))

import prisma from '../../db.js'
import { runOrQueueTool } from '../agents/approval-gate.service.js'
import { getTool } from '../agents/tool-registry.js'
import { runFleetCouncilOnce } from './fleet-council.service.js'
import { runFleet } from './orchestrator.js'

const db = vi.mocked(prisma, true)
const fleet = vi.mocked(runFleet)
const queueTool = vi.mocked(runOrQueueTool)
const toolLookup = vi.mocked(getTool)

const ITEM = {
  findingId: 'f1',
  rank: 1,
  tool: 'create-negative-keyword',
  args: { externalCampaignId: 'ec1', keywordText: 'giacca pelle', matchType: 'NEGATIVE_EXACT', scope: 'AD_GROUP' },
  expectedEffect: { metric: 'spend', direction: 'decrease', magnitudePct: 4, horizonDays: 14, basis: 'engine candidate, €40/0 orders' },
  dependsOn: [],
  reversible: true,
}

function plan(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    status: 'critiqued',
    criticVerdict: 'pass',
    criticNotes: { blockedItems: [] },
    items: [ITEM],
    conflicts: [],
    droppedItems: [],
    ...overrides,
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  db.agentApproval.updateMany.mockResolvedValue({ count: 2 } as never)
  db.agentApproval.findMany.mockResolvedValue([] as never)
  fleet.mockResolvedValue({
    orchestrationId: 'orch_c',
    started: 6,
    succeeded: 5,
    failed: 0,
    skipped: 1,
  } as never)
  db.agentRun.findFirst.mockResolvedValue({
    id: 'run_dir',
    output: { planId: 'p1' },
  } as never)
  db.agentPlan.findUnique.mockResolvedValue(plan())
  db.agentPlan.update.mockResolvedValue({} as never)
  db.agentFinding.findMany.mockResolvedValue([
    { id: 'f1', status: 'open', expiresAt: new Date(Date.now() + 3600_000), dataVintage: new Date() },
  ] as never)
  db.adTarget.findMany.mockResolvedValue([] as never)
  toolLookup.mockReturnValue({
    handler: vi.fn(async () => ({ ok: true, preview: { fine: true } })),
  } as never)
  queueTool.mockResolvedValue({ ok: true, mode: 'queued', approvalId: 'ap1' } as never)
})

describe('runFleetCouncilOnce', () => {
  it('queues a passing plan through the gate with the DIRECTOR run id', async () => {
    const r = await runFleetCouncilOnce()
    expect(r.finalVerdict).toBe('pass')
    expect(r.queued).toBe(1)
    expect(queueTool).toHaveBeenCalledWith(
      'create-negative-keyword',
      ITEM.args,
      { userId: null },
      'run_dir',
    )
    const upd = db.agentPlan.update.mock.calls.at(-1)![0]! as { data: Record<string, unknown> }
    expect(upd.data.status).toBe('queued')
    expect(upd.data.approvalIds).toEqual(['ap1'])
  })

  it('SEEDED ADVERSARIAL: a protected-term negation is force-blocked over a passing critic', async () => {
    toolLookup.mockReturnValue({
      handler: vi.fn(async () => ({
        ok: false,
        error: '"giacca pelle" is whitelisted against negation (brand core term)',
      })),
    } as never)
    const r = await runFleetCouncilOnce()
    expect(r.finalVerdict).toBe('block')
    expect(r.queued).toBe(0)
    expect(queueTool).not.toHaveBeenCalled()
    // verdict override written with the forced blocks
    const upd = db.agentPlan.update.mock.calls[0]![0]! as { data: Record<string, unknown> }
    expect(upd.data.criticVerdict).toBe('block')
    expect(JSON.stringify(upd.data.criticNotes)).toContain('respects_protected_terms')
  })

  it('a critic block queues nothing', async () => {
    db.agentPlan.findUnique.mockResolvedValue(plan({ criticVerdict: 'block' }))
    const r = await runFleetCouncilOnce()
    expect(r.finalVerdict).toBe('block')
    expect(r.queued).toBe(0)
    expect(queueTool).not.toHaveBeenCalled()
  })

  it('critic-blocked items are skipped inside a passing plan', async () => {
    db.agentPlan.findUnique.mockResolvedValue(
      plan({ criticNotes: { blockedItems: ['f1'] } }),
    )
    const r = await runFleetCouncilOnce()
    expect(r.queued).toBe(0)
    expect(r.blocked).toBe(1)
  })

  // NAF.AP.5 — expiry moved out of the council to runApprovalMaintenance,
  // which owns the single `expiresAt` clock. The council still reports what
  // was swept; it no longer keeps a private cutoff of its own.
  it('delegates expiry to the one clock and still reports it', async () => {
    const r = await runFleetCouncilOnce()
    expect(r.expired).toBe(2)
    const where = db.agentApproval.updateMany.mock.calls[0]![0]!.where as Record<string, never>
    expect(where.status).toBe('pending')
    expect((where.expiresAt as { lt: Date }).lt).toBeInstanceOf(Date)
    // The retired second clock must not come back.
    expect(where.requestedAt).toBeUndefined()
    expect(where.toolName).toBeUndefined()
  })

  it('no director plan → honest no-op', async () => {
    db.agentRun.findFirst.mockResolvedValue(null as never)
    const r = await runFleetCouncilOnce()
    expect(r.planId).toBeNull()
    expect(r.queued).toBe(0)
    expect(queueTool).not.toHaveBeenCalled()
  })

  it('a stale referenced finding forces a block (evidence integrity)', async () => {
    db.agentFinding.findMany.mockResolvedValue([
      { id: 'f1', status: 'open', expiresAt: new Date(Date.now() - 1000), dataVintage: new Date() },
    ] as never)
    const r = await runFleetCouncilOnce()
    expect(r.finalVerdict).toBe('block')
    expect(queueTool).not.toHaveBeenCalled()
  })
})
