/**
 * NAF.B — sweep report: the acceptance evidence, queryable. Validation
 * failures and retries come from AgentStep (A2-V7: one model + one
 * validation step per attempt); key stability from finding dedupeKeys;
 * agreement from AgentShadowGrade.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    agentRun: { findMany: vi.fn() },
    agentStep: { findMany: vi.fn() },
    agentFinding: { findMany: vi.fn() },
    agentShadowGrade: { groupBy: vi.fn() },
  },
}))

import prisma from '../../db.js'
import { getSweepReport } from './sweep-report.service.js'

const db = vi.mocked(prisma, true)

beforeEach(() => {
  vi.clearAllMocks()
  db.agentRun.findMany.mockResolvedValue([
    // sweep 1 — two runs, one clean, one that retried validation
    { id: 'r1', orchestrationId: 'o1', createdAt: new Date('2026-08-07T04:45:10Z'), status: 'done', ok: true, findingCount: 4, costUSD: 0.014, agentKey: 'amazon-negative-miner' },
    { id: 'r2', orchestrationId: 'o1', createdAt: new Date('2026-08-07T04:45:12Z'), status: 'done', ok: true, findingCount: 2, costUSD: 0.03, agentKey: 'amazon-bid-tuner' },
    // sweep 2 — one failed run
    { id: 'r3', orchestrationId: 'o2', createdAt: new Date('2026-08-08T04:45:09Z'), status: 'failed', ok: false, findingCount: 0, costUSD: 0.02, agentKey: 'amazon-bid-tuner' },
  ] as never)
  // The service queries WHERE type='validation' AND ok=false — the mock
  // must model the DB contract and return only matching rows.
  db.agentStep.findMany.mockResolvedValue([
    { agentRunId: 'r2', type: 'validation', ok: false },
    { agentRunId: 'r3', type: 'validation', ok: false },
    { agentRunId: 'r3', type: 'validation', ok: false },
  ] as never)
  db.agentFinding.findMany.mockResolvedValue([
    { charterKey: 'amazon-negative-miner', entityType: 'SEARCH_TERM', entityId: 'ec1:a', dedupeKey: 'waste_term:ec1:a' },
    // the drift case: same entity, two key families
    { charterKey: 'amazon-bid-tuner', entityType: 'AD_TARGET', entityId: 't1', dedupeKey: 'bid_above_target:t1' },
    { charterKey: 'amazon-bid-tuner', entityType: 'AD_TARGET', entityId: 't1', dedupeKey: 'bid-above-target-t1' },
  ] as never)
  db.agentShadowGrade.groupBy.mockResolvedValue([
    { engineKey: 'negative-candidates', agrees: true, _count: { _all: 8 } },
    { engineKey: 'negative-candidates', agrees: false, _count: { _all: 2 } },
  ] as never)
})

describe('getSweepReport', () => {
  it('groups runs into sweeps with validation/retry/cost stats', async () => {
    const r = await getSweepReport()
    expect(r.sweeps).toHaveLength(2)
    const s1 = r.sweeps.find((s) => s.orchestrationId === 'o1')!
    expect(s1.runs.total).toBe(2)
    expect(s1.runs.ok).toBe(2)
    expect(s1.validationFailures).toBe(1)
    expect(s1.findings).toBe(6)
    expect(s1.costUSD).toBeCloseTo(0.044)
    const s2 = r.sweeps.find((s) => s.orchestrationId === 'o2')!
    expect(s2.runs.failed).toBe(1)
    expect(s2.validationFailures).toBe(2)
    expect(s2.clean).toBe(false)
    expect(s1.clean).toBe(false) // one retry happened — not a zero-failure sweep
  })

  it('reports key stability — entities carrying more than one key family', async () => {
    const r = await getSweepReport()
    expect(r.keyStability.entitiesWithMultipleKeys).toBe(1)
    expect(r.keyStability.maxKeysPerEntity).toBe(2)
    expect(r.keyStability.entitiesTotal).toBe(2)
  })

  it('reports per-engine agreement rates', async () => {
    const r = await getSweepReport()
    expect(r.agreement['negative-candidates']).toEqual({
      graded: 10,
      agrees: 8,
      rate: 0.8,
    })
  })
})
