/**
 * FX.1 — the run trace: plain labels, evidence previews (bounded, flagged
 * when truncated), both run shapes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    agentRun: { findUnique: vi.fn() },
    agentStep: { findMany: vi.fn() },
    agentFinding: { findMany: vi.fn() },
    agentObservation: { findMany: vi.fn() },
  },
}))

import prisma from '../../db.js'
import { getRunTrace, stepLabel } from './fleet-trace.service.js'

const db = vi.mocked(prisma, true)

beforeEach(() => {
  vi.clearAllMocks()
  db.agentRun.findUnique.mockResolvedValue({
    id: 'run1',
    agentKey: 'amazon-negative-miner',
    mode: 'sweep',
    trigger: 'schedule',
    status: 'done',
    ok: true,
    costUSD: '0.0264',
    latencyMs: 16000,
    haltedReason: null,
    errorMessage: null,
    createdAt: new Date('2026-08-06T04:45:00Z'),
    findingCount: 7,
    output: { findings: [] },
    steps: null,
  } as never)
  db.agentStep.findMany.mockResolvedValue([
    { seq: 1, type: 'observation', name: 'negative-candidates', ok: true, latencyMs: 89, costUSD: '0', inputTokens: 0, outputTokens: 0, errorMessage: null, output: { id: 'obs1' } },
    { seq: 2, type: 'model', name: 'claude-haiku-4-5', ok: true, latencyMs: 15701, costUSD: '0.0264', inputTokens: 9000, outputTokens: 1200, errorMessage: null, output: null },
    { seq: 3, type: 'validation', name: 'analyst-output', ok: true, latencyMs: 2, costUSD: '0', inputTokens: 0, outputTokens: 0, errorMessage: null, output: null },
  ] as never)
  db.agentFinding.findMany.mockResolvedValue([
    { id: 'f1', kind: 'waste_term', entityType: 'search_term', entityId: '218394170642485:giacca moto uomo', severity: 'high', confidence: '0.9', rationale: 'spent with no orders' },
  ] as never)
  db.agentObservation.findMany.mockResolvedValue([
    { id: 'obs1', key: 'negative-candidates', dataVintage: new Date('2026-08-06T00:00:00Z'), payload: { candidates: [{ term: 'x' }] } },
  ] as never)
})

describe('stepLabel', () => {
  it.each([
    ['observation', 'negative-candidates', 'Read the evidence: negative candidates'],
    ['observation', 'exemplars', 'Recalled your past decisions'],
    ['model', 'claude-haiku-4-5', 'Thought it through (claude-haiku-4-5)'],
    ['validation', 'analyst-output', 'Checked its own work against the contract'],
    ['gate', 'evidence-staleness', 'Safety gate: evidence staleness'],
  ])('%s:%s → %s', (type, name, expected) => {
    expect(stepLabel(type, name)).toBe(expected)
  })
})

describe('getRunTrace', () => {
  it('assembles the story: labelled steps, evidence preview, findings, model', async () => {
    const t = await getRunTrace('run1')
    expect(t!.shape).toBe('agent-step')
    expect(t!.run.model).toBe('claude-haiku-4-5')
    expect(t!.steps[0]!.label).toBe('Read the evidence: negative candidates')
    expect(t!.evidence[0]).toMatchObject({ key: 'negative-candidates', truncated: false })
    expect(t!.evidence[0]!.preview).toContain('candidates')
    expect(t!.findings).toHaveLength(1)
  })

  it('flags a truncated evidence preview instead of silently cutting', async () => {
    db.agentObservation.findMany.mockResolvedValue([
      { id: 'obs1', key: 'big', dataVintage: new Date(), payload: { blob: 'x'.repeat(9000) } },
    ] as never)
    const t = await getRunTrace('run1')
    expect(t!.evidence[0]!.truncated).toBe(true)
    expect(t!.evidence[0]!.preview.length).toBeLessThanOrEqual(4000)
  })

  it('a legacy ACP run comes back as legacy-json, untouched', async () => {
    db.agentRun.findUnique.mockResolvedValue({
      id: 'runL', agentKey: 'copilot', mode: null, trigger: 'manual', status: 'done',
      ok: true, costUSD: '0', latencyMs: null, haltedReason: null, errorMessage: null,
      createdAt: new Date(), findingCount: 0, output: null, steps: [{ legacy: true }],
    } as never)
    const t = await getRunTrace('runL')
    expect(t!.shape).toBe('legacy-json')
    expect(t!.output).toEqual([{ legacy: true }])
    expect(db.agentStep.findMany).not.toHaveBeenCalled()
  })

  it('unknown run → null', async () => {
    db.agentRun.findUnique.mockResolvedValue(null as never)
    expect(await getRunTrace('ghost')).toBeNull()
  })
})
