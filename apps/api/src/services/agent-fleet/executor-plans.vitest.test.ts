/**
 * NAF.C — executor persistence for director and critic outputs. Registry
 * mocked with synthetic charters; observation cache mocked so no C3
 * builders are needed here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    agentRun: { create: vi.fn(), update: vi.fn(), aggregate: vi.fn() },
    agentObservation: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    agentFinding: { upsert: vi.fn() },
    agentPlan: { create: vi.fn(), update: vi.fn() },
    agentStep: { create: vi.fn() },
    agentFleetState: { upsert: vi.fn() },
    cronRun: { groupBy: vi.fn() },
  },
}))
vi.mock('./charter-registry.js', () => ({
  resolveCharter: vi.fn(),
  FLEET_CHARTERS: {},
}))
vi.mock('../ai/model-resolver.service.js', () => ({
  getProviderForFeature: vi.fn(),
  resolveModelForFeature: vi.fn(),
}))
vi.mock('../ai/usage-logger.service.js', () => ({ logUsage: vi.fn() }))

import prisma from '../../db.js'
import {
  getProviderForFeature,
  resolveModelForFeature,
} from '../ai/model-resolver.service.js'
import { executeCharter } from './agent-executor.js'
import { resolveCharter } from './charter-registry.js'
import type { EffectiveCharter } from './charter-types.js'

const db = vi.mocked(prisma, true)
const resolve = vi.mocked(resolveCharter)
const getProvider = vi.mocked(getProviderForFeature)
const resolveModel = vi.mocked(resolveModelForFeature)
const generate = vi.fn()

function charter(overrides: Partial<EffectiveCharter>): EffectiveCharter {
  return {
    key: 'x',
    version: 1,
    tier: 'director',
    domain: 'amazon-ads',
    name: 'X',
    systemPrompt: 'You are X.',
    outputSchemaKey: 'director-output',
    toolNames: [],
    observationKeys: ['cron-health'],
    modelFeature: 'agent-fleet-director',
    autonomyCap: 'PROPOSE',
    maxFindingsPerRun: 20,
    maxToolCallsPerRun: 2,
    maxTokensPerRun: 30_000,
    dailyBudgetUSD: 0.3,
    enabled: true,
    autonomyLevel: 'PROPOSE',
    scopeMarketplaces: [],
    scopePortfolioIds: [],
    scopeCampaignIds: [],
    degraded: false,
    ...overrides,
  }
}

const DIRECTOR_REPLY = JSON.stringify({
  headline: 'Cut waste on IT phrase match',
  narrative:
    'Two negative candidates survive dedupe and one bid reduction is overdue; the remainder fall below the evidence floor and are dropped with reasons.',
  items: [
    {
      findingId: 'f1',
      rank: 1,
      tool: 'create-negative-keyword',
      args: { externalCampaignId: 'ec1', keywordText: 'giacca pelle', matchType: 'NEGATIVE_EXACT', scope: 'AD_GROUP' },
      expectedEffect: { metric: 'spend', direction: 'decrease', magnitudePct: 4, horizonDays: 14, basis: 'engine negative candidate: €40 spend, 0 orders over 60d' },
      dependsOn: [],
      reversible: true,
    },
  ],
  dropped: [{ findingId: 'f2', reason: 'duplicate of f1 on the same entity' }],
  conflicts: [],
  changeBudgetUsed: { entities: 1, valueCents: 0 },
})

const CRITIC_REPLY = JSON.stringify({
  verdict: 'pass',
  checks: [
    { check: 'evidence_sufficient', result: 'pass' },
    { check: 'respects_protected_terms', result: 'pass' },
  ],
  blockedItems: [],
  summary: 'Both items evidence-backed; no protected terms touched.',
})

function usage() {
  return { inputTokens: 2000, outputTokens: 800, costUSD: 0.006, model: 'claude-sonnet-4-6', provider: 'anthropic' as const }
}

const OPTS = { trigger: 'manual', mode: 'council' } as const

beforeEach(() => {
  vi.clearAllMocks()
  db.agentFleetState.upsert.mockResolvedValue({
    id: 'singleton', halted: false, haltedAt: null, haltReason: null, haltedBy: null, dailyCeilingUSD: 2.0, updatedAt: new Date(),
  } as never)
  db.agentRun.aggregate.mockResolvedValue({ _sum: { costUSD: 0 } } as never)
  db.agentRun.create.mockResolvedValue({ id: 'run_d' } as never)
  db.agentRun.update.mockResolvedValue({} as never)
  db.agentObservation.findFirst.mockResolvedValue({
    id: 'obs_1',
    payload: { planId: 'p1', anything: true },
    dataVintage: new Date(),
    computedAt: new Date(),
    expiresAt: new Date(Date.now() + 10 * 60_000),
  } as never)
  db.agentPlan.create.mockResolvedValue({ id: 'p_new' } as never)
  db.agentPlan.update.mockResolvedValue({} as never)
  db.agentStep.create.mockResolvedValue({} as never)
  getProvider.mockResolvedValue({
    name: 'anthropic', defaultModel: 'claude-sonnet-4-6', isConfigured: () => true, generate,
  } as never)
  resolveModel.mockResolvedValue('claude-sonnet-4-6')
})

describe('director-output persistence', () => {
  it('creates a draft AgentPlan with the folded blast radius', async () => {
    resolve.mockResolvedValue(charter({}))
    generate.mockResolvedValue({ text: DIRECTOR_REPLY, usage: usage() })
    const r = await executeCharter('x', { ...OPTS })
    expect(r.ok).toBe(true)
    expect(r.planId).toBe('p_new')
    expect(db.agentPlan.create).toHaveBeenCalledTimes(1)
    const data = db.agentPlan.create.mock.calls[0]![0]!.data as Record<string, unknown>
    expect(data.status).toBe('draft')
    expect(data.headline).toBe('Cut waste on IT phrase match')
    const blast = data.blastRadius as { input: { changedRows: number }; verdict: { proceed: boolean } }
    expect(blast.input.changedRows).toBe(1)
    expect(blast.verdict.proceed).toBe(true)
    expect(db.agentFinding.upsert).not.toHaveBeenCalled()
  })
})

describe('critic-output persistence', () => {
  it('annotates the plan named by its evidence', async () => {
    resolve.mockResolvedValue(
      charter({ tier: 'critic', outputSchemaKey: 'critic-output', modelFeature: 'agent-fleet-critic', autonomyCap: 'OBSERVE', autonomyLevel: 'OBSERVE' }),
    )
    generate.mockResolvedValue({ text: CRITIC_REPLY, usage: usage() })
    const r = await executeCharter('x', { ...OPTS })
    expect(r.ok).toBe(true)
    expect(r.planId).toBe('p1')
    expect(db.agentPlan.update).toHaveBeenCalledTimes(1)
    const call = db.agentPlan.update.mock.calls[0]![0]! as { where: { id: string }; data: Record<string, unknown> }
    expect(call.where.id).toBe('p1')
    expect(call.data.criticVerdict).toBe('pass')
    expect(call.data.status).toBe('critiqued')
  })

  it('fails the run when the evidence carries no planId', async () => {
    resolve.mockResolvedValue(
      charter({ tier: 'critic', outputSchemaKey: 'critic-output', autonomyCap: 'OBSERVE', autonomyLevel: 'OBSERVE' }),
    )
    db.agentObservation.findFirst.mockResolvedValue({
      id: 'obs_1', payload: { noPlan: true }, dataVintage: new Date(), computedAt: new Date(), expiresAt: new Date(Date.now() + 600_000),
    } as never)
    generate.mockResolvedValue({ text: CRITIC_REPLY, usage: usage() })
    const r = await executeCharter('x', { ...OPTS })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/no planId/)
    expect(db.agentPlan.update).not.toHaveBeenCalled()
  })
})
