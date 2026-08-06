/**
 * NAF.B — the two charter-opt-in executor contracts: pinned dedupeKey
 * grammar (validation-stage, retry-once path) and evidence staleness
 * (pre-model gate, $0 denial). Charter-registry is mocked with a synthetic
 * charter so these tests don't depend on the Phase B charters existing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    agentRun: { create: vi.fn(), update: vi.fn(), aggregate: vi.fn() },
    agentObservation: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    agentFinding: { upsert: vi.fn() },
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
const fakeProvider = {
  name: 'anthropic' as const,
  defaultModel: 'claude-haiku-4-5',
  isConfigured: () => true,
  generate,
}

const PATTERN = '^[a-z_]{3,40}:.+$'

function charter(overrides: Partial<EffectiveCharter> = {}): EffectiveCharter {
  return {
    key: 'test-analyst',
    version: 1,
    tier: 'analyst',
    domain: 'amazon-ads',
    name: 'Test analyst',
    systemPrompt: 'You are a test analyst.',
    outputSchemaKey: 'analyst-output',
    toolNames: [],
    observationKeys: ['cron-health'],
    modelFeature: 'agent-fleet-analyst',
    autonomyCap: 'OBSERVE',
    maxFindingsPerRun: 10,
    maxToolCallsPerRun: 2,
    maxTokensPerRun: 20_000,
    dailyBudgetUSD: 0.25,
    dedupeKeyPattern: PATTERN,
    maxEvidenceAgeHours: 26,
    enabled: true,
    autonomyLevel: 'OBSERVE',
    scopeMarketplaces: [],
    scopePortfolioIds: [],
    scopeCampaignIds: [],
    degraded: false,
    ...overrides,
  }
}

function reply(dedupeKey: string): string {
  return JSON.stringify({
    findings: [
      {
        entityType: 'COMPONENT',
        entityId: 'cron:sqp-ingest',
        kind: 'cron_failing',
        severity: 'high',
        confidence: 0.9,
        observation: { failures: 9 },
        evidenceRefs: ['obs_1'],
        dataVintage: '2026-08-06T04:00:00.000Z',
        rationale:
          'Nine failures and zero successes across the whole 24 hour window under test.',
        dedupeKey,
        expiresInHours: 48,
      },
    ],
    scanned: 1,
  })
}

const GOOD_KEY = 'cron_failing:cron:sqp-ingest'
const BAD_KEY = 'cron_failing_sqp-ingest_1_1' // the measured Haiku family — no colon form

function usage() {
  return {
    inputTokens: 1000,
    outputTokens: 300,
    costUSD: 0.002,
    model: 'claude-haiku-4-5',
    provider: 'anthropic' as const,
  }
}

function freshObservation(ageMs = 0) {
  return {
    id: 'obs_1',
    payload: { jobs: [] },
    dataVintage: new Date(Date.now() - ageMs),
    computedAt: new Date(Date.now() - ageMs),
    expiresAt: new Date(Date.now() + 10 * 60_000),
  } as never
}

const OPTS = { trigger: 'manual', mode: 'ask' } as const

beforeEach(() => {
  vi.clearAllMocks()
  resolve.mockResolvedValue(charter())
  db.agentFleetState.upsert.mockResolvedValue({
    id: 'singleton',
    halted: false,
    haltedAt: null,
    haltReason: null,
    haltedBy: null,
    dailyCeilingUSD: 2.0,
    updatedAt: new Date(),
  } as never)
  db.agentRun.aggregate.mockResolvedValue({ _sum: { costUSD: 0 } } as never)
  db.agentRun.create.mockResolvedValue({ id: 'run_1' } as never)
  db.agentRun.update.mockResolvedValue({} as never)
  db.agentObservation.findFirst.mockResolvedValue(freshObservation())
  db.agentFinding.upsert.mockResolvedValue({} as never)
  db.agentStep.create.mockResolvedValue({} as never)
  getProvider.mockResolvedValue(fakeProvider as never)
  resolveModel.mockResolvedValue('claude-haiku-4-5')
})

describe('dedupeKey grammar (charter-opt-in)', () => {
  it('a non-conforming key is a validation failure, retried with the pattern named', async () => {
    generate
      .mockResolvedValueOnce({ text: reply(BAD_KEY), usage: usage() })
      .mockResolvedValueOnce({ text: reply(GOOD_KEY), usage: usage() })
    const r = await executeCharter('test-analyst', { ...OPTS })
    expect(r.ok).toBe(true)
    expect(generate).toHaveBeenCalledTimes(2)
    const retryPrompt = (generate.mock.calls[1]![0] as { prompt: string }).prompt
    expect(retryPrompt).toContain(BAD_KEY)
    expect(retryPrompt).toContain(PATTERN)
    expect(db.agentFinding.upsert).toHaveBeenCalledTimes(1)
  })

  it('twice non-conforming fails the run with zero blackboard writes', async () => {
    generate.mockResolvedValue({ text: reply(BAD_KEY), usage: usage() })
    const r = await executeCharter('test-analyst', { ...OPTS })
    expect(r.ok).toBe(false)
    expect(generate).toHaveBeenCalledTimes(2)
    expect(db.agentFinding.upsert).not.toHaveBeenCalled()
  })

  it('a conforming key passes first try', async () => {
    generate.mockResolvedValue({ text: reply(GOOD_KEY), usage: usage() })
    const r = await executeCharter('test-analyst', { ...OPTS })
    expect(r.ok).toBe(true)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(r.findingCount).toBe(1)
  })

  it('a charter WITHOUT a pattern accepts any key — Phase A behaviour unchanged', async () => {
    resolve.mockResolvedValue(charter({ dedupeKeyPattern: undefined }))
    generate.mockResolvedValue({ text: reply(BAD_KEY), usage: usage() })
    const r = await executeCharter('test-analyst', { ...OPTS })
    expect(r.ok).toBe(true)
    expect(generate).toHaveBeenCalledTimes(1)
  })
})

describe('evidence staleness (charter-opt-in)', () => {
  it('stale evidence denies the run BEFORE the provider is called — $0', async () => {
    db.agentObservation.findFirst.mockResolvedValue(
      freshObservation(27 * 3600_000), // 27h > 26h tolerance
    )
    const r = await executeCharter('test-analyst', { ...OPTS })
    expect(r.ok).toBe(false)
    expect(r.haltedReason).toContain('stale_evidence')
    expect(generate).not.toHaveBeenCalled()
    // gate step recorded
    const gateSteps = db.agentStep.create.mock.calls
      .map((c) => c[0]!.data as { type: string; name: string })
      .filter((d) => d.type === 'gate')
    expect(gateSteps.some((d) => d.name === 'evidence-staleness')).toBe(true)
    // run row closed with the reason
    const upd = db.agentRun.update.mock.calls.at(-1)![0]!.data as Record<string, unknown>
    expect(String(upd.haltedReason)).toContain('stale_evidence')
  })

  it('fresh evidence proceeds', async () => {
    db.agentObservation.findFirst.mockResolvedValue(
      freshObservation(1 * 3600_000), // 1h old — fine
    )
    generate.mockResolvedValue({ text: reply(GOOD_KEY), usage: usage() })
    const r = await executeCharter('test-analyst', { ...OPTS })
    expect(r.ok).toBe(true)
  })

  it('a charter WITHOUT a tolerance never checks age — Phase A behaviour unchanged', async () => {
    resolve.mockResolvedValue(charter({ maxEvidenceAgeHours: undefined }))
    db.agentObservation.findFirst.mockResolvedValue(
      freshObservation(100 * 3600_000), // ancient
    )
    generate.mockResolvedValue({ text: reply(GOOD_KEY), usage: usage() })
    const r = await executeCharter('test-analyst', { ...OPTS })
    expect(r.ok).toBe(true)
  })
})
