/**
 * NAF.AC.2 — Preview: real evidence, a real model call, real validation —
 * and nothing written to the blackboard. The run row still exists because
 * the cost is real, and it is visibly marked `preview`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    agentCharter: { findMany: vi.fn() },
    agentCharterRevision: { findMany: vi.fn() },
    agentRun: { create: vi.fn(), update: vi.fn() },
    agentStep: { create: vi.fn() },
    agentFinding: { upsert: vi.fn(), findMany: vi.fn() },
    agentPlan: { create: vi.fn(), update: vi.fn() },
    agentObservation: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    agentExemplar: { findMany: vi.fn() },
  },
}))
vi.mock('../ai/model-resolver.service.js', () => ({
  getProviderForFeature: vi.fn(),
  resolveModelForFeature: vi.fn(async () => 'claude-haiku-4-5'),
}))
vi.mock('../ai/providers/index.js', () => ({
  isAiKillSwitchOn: vi.fn(() => false),
  getProvider: vi.fn(() => null),
}))
vi.mock('../ai/usage-logger.service.js', () => ({ logUsage: vi.fn() }))
vi.mock('./fleet-state.service.js', () => ({
  getFleetState: vi.fn(async () => ({
    halted: false,
    haltReason: null,
    dailyCeilingUSD: 2,
    degraded: false,
  })),
}))
vi.mock('./budget-guard.js', () => ({
  checkCharterDayBudget: vi.fn(async () => ({ ok: true })),
  checkFleetDayBudget: vi.fn(async () => ({ ok: true })),
  checkRunBudget: vi.fn(() => ({ ok: true })),
}))
vi.mock('./observation-builder.js', () => ({ getObservation: vi.fn() }))
vi.mock('./exemplar.service.js', () => ({
  retrieveExemplars: vi.fn(async () => []),
  renderExemplarBlock: vi.fn(() => ''),
}))

import prisma from '../../db.js'
import { getProviderForFeature } from '../ai/model-resolver.service.js'
import { getObservation } from './observation-builder.js'
import { executeCharter } from './agent-executor.js'
import { bustCharterCache } from './charter-registry.js'

const db = vi.mocked(prisma, true)
const provider = vi.mocked(getProviderForFeature)
const observation = vi.mocked(getObservation)

const VALID_FINDING = {
  entityType: 'SEARCH_TERM',
  entityId: '218394170642485:giacca moto',
  kind: 'waste_term',
  severity: 'high',
  confidence: 0.9,
  observation: { spend: 40 },
  evidenceRefs: ['obs1'],
  dataVintage: '2026-08-07T00:00:00.000Z',
  rationale: 'spent with no orders',
  dedupeKey: 'waste_term:218394170642485:giacca moto',
  expiresInHours: 240,
}

function mockGenerate(text: string) {
  provider.mockResolvedValue({
    name: 'anthropic',
    generate: vi.fn(async () => ({
      text,
      usage: {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        inputTokens: 900,
        outputTokens: 200,
        costUSD: 0.002,
      },
    })),
  } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  bustCharterCache()
  db.agentCharter.findMany.mockResolvedValue([
    {
      key: 'amazon-negative-miner',
      version: 1,
      enabled: false, // deliberately OFF — a preview must still run
      autonomyLevel: 'OFF',
      scopeMarketplaces: [], scopePortfolioIds: [], scopeCampaignIds: [],
      maxFindingsPerRun: 20, maxToolCallsPerRun: 12, maxTokensPerRun: 20000,
      dailyBudgetUSD: 0.1, maxProposedValueCents: null, toolNames: [],
      modelProviderOverride: null, modelNameOverride: null,
      pausedUntil: null, pausedReason: null,
    },
  ] as never)
  db.agentCharterRevision.findMany.mockResolvedValue([] as never)
  db.agentRun.create.mockResolvedValue({ id: 'run_prev' } as never)
  db.agentRun.update.mockResolvedValue({} as never)
  db.agentStep.create.mockResolvedValue({} as never)
  observation.mockResolvedValue({
    id: 'obs1',
    key: 'negative-candidates',
    payload: { candidates: [] },
    dataVintage: new Date(),
    computedAt: new Date(),
    cached: false,
  } as never)
  mockGenerate(JSON.stringify({ findings: [VALID_FINDING], scanned: 12 }))
})

describe('executeCharter({ preview: true })', () => {
  it('runs a DISABLED charter and writes no findings', async () => {
    const r = await executeCharter('amazon-negative-miner', {
      trigger: 'manual',
      mode: 'ask',
      preview: true,
    })
    expect(r.ok).toBe(true)
    expect(r.previewFindings).toHaveLength(1)
    expect(db.agentFinding.upsert).not.toHaveBeenCalled()
    expect(db.agentPlan.create).not.toHaveBeenCalled()
  })

  it("marks the run mode 'preview' so the trace never lies", async () => {
    await executeCharter('amazon-negative-miner', {
      trigger: 'manual',
      mode: 'sweep',
      preview: true,
    })
    const data = (db.agentRun.create.mock.calls[0]![0] as { data: Record<string, unknown> }).data
    expect(data.mode).toBe('preview')
  })

  it('reports cost and tokens — a preview is not free', async () => {
    const r = await executeCharter('amazon-negative-miner', {
      trigger: 'manual',
      mode: 'ask',
      preview: true,
    })
    expect(r.costUSD).toBeCloseTo(0.002, 6)
    expect(r.inputTokens).toBe(900)
  })

  it('a draft prompt is used verbatim without being activated', async () => {
    await executeCharter('amazon-negative-miner', {
      trigger: 'manual',
      mode: 'ask',
      preview: true,
      promptOverride: 'DRAFT: only report French waste.',
    })
    const gen = (await provider.mock.results[0]!.value).generate as ReturnType<typeof vi.fn>
    expect(gen.mock.calls[0]![0].prompt).toContain('DRAFT: only report French waste.')
  })

  it('a draft that breaks the contract SHOWS the error instead of throwing', async () => {
    mockGenerate('this is not json at all')
    const r = await executeCharter('amazon-negative-miner', {
      trigger: 'manual',
      mode: 'ask',
      preview: true,
    })
    expect(r.ok).toBe(false)
    expect(r.validationError).toBeTruthy()
    expect(db.agentFinding.upsert).not.toHaveBeenCalled()
  })
})

describe('a normal run is unaffected', () => {
  it('a disabled charter is still a silent no-op without preview', async () => {
    const r = await executeCharter('amazon-negative-miner', {
      trigger: 'schedule',
      mode: 'sweep',
    })
    expect(r.skipped).toBe('disabled')
    expect(db.agentRun.create).not.toHaveBeenCalled()
  })
})
