/**
 * NAF.AC.3 — evals: a draft is scored against the running charter on the
 * same evidence, both sides preview (no writes), and the verdict is
 * conservative — worse on any hard measure means worse.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    agentShadowGrade: { findMany: vi.fn() },
    agentFinding: { findMany: vi.fn() },
    agentEvalRun: { create: vi.fn(), findFirst: vi.fn() },
  },
}))
vi.mock('./agent-executor.js', () => ({ executeCharter: vi.fn() }))
vi.mock('./charter-registry.js', () => ({ resolveCharter: vi.fn() }))

import prisma from '../../db.js'
import { executeCharter } from './agent-executor.js'
import { resolveCharter } from './charter-registry.js'
import { evaluateRevision } from './charter-eval.service.js'

const db = vi.mocked(prisma, true)
const exec = vi.mocked(executeCharter)
const resolve = vi.mocked(resolveCharter)

const finding = (entityId: string) => ({ entityId })

beforeEach(() => {
  vi.clearAllMocks()
  resolve.mockResolvedValue({ key: 'amazon-negative-miner' } as never)
  db.agentShadowGrade.findMany.mockResolvedValue([{ findingId: 'f1' }] as never)
  db.agentFinding.findMany.mockResolvedValue([{ entityId: 'good-1' }] as never)
  db.agentEvalRun.create.mockResolvedValue({ id: 'eval1' } as never)
})

describe('evaluateRevision', () => {
  it('runs BOTH sides in preview — an eval never writes findings', async () => {
    exec.mockResolvedValue({
      runId: 'r', ok: true, previewFindings: [finding('good-1')], costUSD: 0.001,
    } as never)
    await evaluateRevision({
      charterKey: 'amazon-negative-miner',
      candidatePrompt: 'draft',
      cases: 1,
    })
    expect(exec).toHaveBeenCalledTimes(2)
    for (const call of exec.mock.calls) {
      expect(call[1]!.preview).toBe(true)
    }
    // the candidate side carries the draft prompt, the baseline does not
    expect(exec.mock.calls[0]![1]!.promptOverride).toBeUndefined()
    expect(exec.mock.calls[1]![1]!.promptOverride).toBe('draft')
  })

  it('a draft that breaks its contract is WORSE, whatever else it does', async () => {
    exec
      .mockResolvedValueOnce({ runId: 'a', ok: true, previewFindings: [finding('good-1')], costUSD: 0.001 } as never)
      .mockResolvedValueOnce({ runId: 'b', ok: false, previewFindings: [], costUSD: 0.001 } as never)
    const r = await evaluateRevision({
      charterKey: 'amazon-negative-miner',
      candidatePrompt: 'draft',
      cases: 1,
    })
    expect(r.verdict).toBe('worse')
    expect(r.candidate.validRate).toBe(0)
  })

  it('better agreement with the engines is BETTER', async () => {
    exec
      // baseline: one hit, one miss → 0.5
      .mockResolvedValueOnce({ runId: 'a', ok: true, previewFindings: [finding('good-1'), finding('junk')], costUSD: 0.001 } as never)
      // candidate: one hit only → 1.0
      .mockResolvedValueOnce({ runId: 'b', ok: true, previewFindings: [finding('good-1')], costUSD: 0.001 } as never)
    const r = await evaluateRevision({
      charterKey: 'amazon-negative-miner',
      candidatePrompt: 'draft',
      cases: 1,
    })
    expect(r.baseline.agreement).toBeCloseTo(0.5, 5)
    expect(r.candidate.agreement).toBeCloseTo(1, 5)
    expect(r.verdict).toBe('better')
  })

  it('cheaper alone is never "better" — cheap nonsense is still nonsense', async () => {
    exec
      .mockResolvedValueOnce({ runId: 'a', ok: true, previewFindings: [finding('good-1')], costUSD: 0.01 } as never)
      .mockResolvedValueOnce({ runId: 'b', ok: true, previewFindings: [finding('good-1')], costUSD: 0.0001 } as never)
    const r = await evaluateRevision({
      charterKey: 'amazon-negative-miner',
      candidatePrompt: 'draft',
      cases: 1,
    })
    expect(r.verdict).toBe('inconclusive')
  })

  it('with no engine yardstick, agreement is unknown — never zero', async () => {
    db.agentShadowGrade.findMany.mockResolvedValue([] as never)
    exec.mockResolvedValue({ runId: 'r', ok: true, previewFindings: [finding('x')], costUSD: 0.001 } as never)
    const r = await evaluateRevision({
      charterKey: 'amazon-negative-miner',
      candidatePrompt: 'draft',
      cases: 1,
    })
    expect(r.baseline.agreement).toBeNull()
    expect(r.candidate.agreement).toBeNull()
    expect(r.verdict).toBe('inconclusive')
  })

  it('records the eval with its cost so the trial is auditable', async () => {
    exec.mockResolvedValue({ runId: 'r', ok: true, previewFindings: [], costUSD: 0.002 } as never)
    const r = await evaluateRevision({
      charterKey: 'amazon-negative-miner',
      candidatePrompt: 'draft',
      revisionId: 'rev7',
      cases: 2,
    })
    expect(exec).toHaveBeenCalledTimes(4) // 2 cases × both sides
    const data = (db.agentEvalRun.create.mock.calls[0]![0] as { data: Record<string, unknown> }).data
    expect(data.revisionId).toBe('rev7')
    expect(data.cases).toBe(2)
    expect(Number(data.costUSD)).toBeCloseTo(0.008, 6)
    expect(r.id).toBe('eval1')
  })
})
