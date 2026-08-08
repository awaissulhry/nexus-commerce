/**
 * NAF.A — executor pipeline tests. Only the DB and the model layer are
 * mocked; charter-registry, observation-builder, fleet-state and
 * budget-guard run for real so the test exercises the same seams prod does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    agentCharterRevision: { findMany: vi.fn(async () => []) },
    agentCharter: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    agentRun: { create: vi.fn(), update: vi.fn(), aggregate: vi.fn() },
    agentObservation: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    agentFinding: { upsert: vi.fn() },
    // NAF.SB.AS.5 — the executor records which runs detected which
    // finding. Declared here because a missing model on the mock throws
    // on property access, before any .catch can attach.
    agentFindingRun: { createMany: vi.fn(async () => ({ count: 0 })) },
    agentStep: { create: vi.fn() },
    agentFleetState: { upsert: vi.fn() },
    cronRun: { groupBy: vi.fn() },
  },
}))
vi.mock('../ai/model-resolver.service.js', () => ({
  getProviderForFeature: vi.fn(),
  resolveModelForFeature: vi.fn(),
}))
vi.mock('../ai/usage-logger.service.js', () => ({
  logUsage: vi.fn(),
}))

import prisma from '../../db.js'
import {
  getProviderForFeature,
  resolveModelForFeature,
} from '../ai/model-resolver.service.js'
import { logUsage } from '../ai/usage-logger.service.js'
import { executeCharter } from './agent-executor.js'
import { bustCharterCache } from './charter-registry.js'

const db = vi.mocked(prisma, true)
const getProvider = vi.mocked(getProviderForFeature)
const resolveModel = vi.mocked(resolveModelForFeature)

const generate = vi.fn()
const fakeProvider = {
  name: 'anthropic' as const,
  defaultModel: 'claude-haiku-4-5',
  isConfigured: () => true,
  generate,
}

function charterRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chr_1',
    key: 'fleet-selftest',
    version: 1,
    enabled: true,
    autonomyLevel: 'OBSERVE',
    scopeMarketplaces: [],
    scopePortfolioIds: [],
    scopeCampaignIds: [],
    maxFindingsPerRun: 10,
    maxToolCallsPerRun: 2,
    maxTokensPerRun: 20_000,
    dailyBudgetUSD: 0.25,
    maxProposedValueCents: null,
    ...overrides,
  } as never
}

const VALID_REPLY = JSON.stringify({
  findings: [
    {
      entityType: 'COMPONENT',
      entityId: 'cron:ads-tos-is-ingest',
      kind: 'cron_failing',
      severity: 'high',
      confidence: 0.9,
      observation: { failures: 9, runs: 9 },
      evidenceRefs: ['obs_1'],
      dataVintage: '2026-08-06T04:00:00.000Z',
      rationale:
        'Nine failures and zero successes in the last 24 hours; the job never completes its report poll.',
      dedupeKey: 'cron_failing:ads-tos-is-ingest',
      expiresInHours: 48,
    },
  ],
  scanned: 3,
})

function usage(overrides: Record<string, unknown> = {}) {
  return {
    inputTokens: 1500,
    outputTokens: 400,
    costUSD: 0.0012,
    model: 'claude-haiku-4-5',
    provider: 'anthropic' as const,
    ...overrides,
  }
}

const OPTS = { trigger: 'manual', mode: 'ask' } as const

beforeEach(() => {
  vi.clearAllMocks()
  bustCharterCache()
  db.agentCharter.findMany.mockResolvedValue([charterRow()] as never)
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
  db.agentObservation.findFirst.mockResolvedValue({
    id: 'obs_1',
    payload: { windowHours: 24, jobs: [{ jobName: 'ads-tos-is-ingest', failures: 9, runs: 9 }] },
    dataVintage: new Date('2026-08-06T04:00:00.000Z'),
    computedAt: new Date(),
    expiresAt: new Date(Date.now() + 10 * 60_000),
  } as never)
  db.agentFinding.upsert.mockResolvedValue({} as never)
  db.agentStep.create.mockResolvedValue({} as never)
  getProvider.mockResolvedValue(fakeProvider as never)
  resolveModel.mockResolvedValue('claude-haiku-4-5')
})

describe('executeCharter — happy path', () => {
  it('persists findings, steps and a costed success run', async () => {
    generate.mockResolvedValue({ text: VALID_REPLY, usage: usage() })
    const r = await executeCharter('fleet-selftest', { ...OPTS })

    expect(r.ok).toBe(true)
    expect(r.runId).toBe('run_1')
    expect(r.findingCount).toBe(1)

    // create-first: run row exists before any work
    const createData = db.agentRun.create.mock.calls[0]![0]!.data as Record<string, unknown>
    expect(createData.status).toBe('running')
    expect(createData.agentKey).toBe('fleet-selftest')
    expect(createData.charterVersion).toBe(1)
    expect(createData.mode).toBe('ask')

    // finding persisted via dedupe-aware upsert on the compound key
    expect(db.agentFinding.upsert).toHaveBeenCalledTimes(1)
    const up = db.agentFinding.upsert.mock.calls[0]![0]! as Record<string, never>
    expect(up.where).toHaveProperty('charterKey_entityType_entityId_dedupeKey')

    // steps: observation + model + validation at minimum
    const stepTypes = db.agentStep.create.mock.calls.map(
      (c) => (c[0]!.data as { type: string }).type,
    )
    expect(stepTypes).toContain('observation')
    expect(stepTypes).toContain('model')
    expect(stepTypes).toContain('validation')

    // success update carries cost + findingCount
    const updData = db.agentRun.update.mock.calls.at(-1)![0]!.data as Record<string, unknown>
    expect(updData.status).toBe('done')
    expect(updData.ok).toBe(true)
    expect(updData.findingCount).toBe(1)
    expect(updData.costUSD).toBeCloseTo(0.0012)

    // spend mirrored into AI-2 telemetry — the non-optional convention
    expect(logUsage).toHaveBeenCalledTimes(1)
  })

  it('parses a markdown-fenced JSON reply', async () => {
    generate.mockResolvedValue({
      text: '```json\n' + VALID_REPLY + '\n```',
      usage: usage(),
    })
    const r = await executeCharter('fleet-selftest', { ...OPTS })
    expect(r.ok).toBe(true)
    expect(r.findingCount).toBe(1)
  })
})

describe('executeCharter — validation retry', () => {
  it('retries once with the validation error appended, then succeeds', async () => {
    const invalid = JSON.stringify({ findings: [{ entityType: 'COMPONENT' }], scanned: 1 })
    generate
      .mockResolvedValueOnce({ text: invalid, usage: usage() })
      .mockResolvedValueOnce({ text: VALID_REPLY, usage: usage() })
    const r = await executeCharter('fleet-selftest', { ...OPTS })
    expect(r.ok).toBe(true)
    expect(generate).toHaveBeenCalledTimes(2)
    const retryPrompt = (generate.mock.calls[1]![0] as { prompt: string }).prompt
    expect(retryPrompt).toMatch(/failed validation/i)
    expect(db.agentFinding.upsert).toHaveBeenCalledTimes(1)
  })

  it('a reply citing evidence ids it was never shown is a validation failure', async () => {
    const phantomRef = VALID_REPLY.replace('obs_1', 'obs_999')
    generate
      .mockResolvedValueOnce({ text: phantomRef, usage: usage() })
      .mockResolvedValueOnce({ text: VALID_REPLY, usage: usage() })
    const r = await executeCharter('fleet-selftest', { ...OPTS })
    expect(r.ok).toBe(true)
    expect(generate).toHaveBeenCalledTimes(2)
    const retryPrompt = (generate.mock.calls[1]![0] as { prompt: string }).prompt
    expect(retryPrompt).toContain('obs_999')
  })

  it('twice invalid fails the run and writes NOTHING to the blackboard', async () => {
    const invalid = '{"not":"the schema"}'
    generate.mockResolvedValue({ text: invalid, usage: usage() })
    const r = await executeCharter('fleet-selftest', { ...OPTS })
    expect(r.ok).toBe(false)
    expect(generate).toHaveBeenCalledTimes(2)
    expect(db.agentFinding.upsert).not.toHaveBeenCalled()
    const updData = db.agentRun.update.mock.calls.at(-1)![0]!.data as Record<string, unknown>
    expect(updData.status).toBe('failed')
    expect(updData.ok).toBe(false)
  })
})

describe('executeCharter — gates', () => {
  it('day-budget denial records a halted run and never calls the provider', async () => {
    // charter budget is $0.25/day; today's spend already equals it
    db.agentRun.aggregate.mockResolvedValue({ _sum: { costUSD: 0.25 } } as never)
    const r = await executeCharter('fleet-selftest', { ...OPTS })
    expect(r.ok).toBe(false)
    expect(r.haltedReason).toContain('charter_day')
    expect(generate).not.toHaveBeenCalled()
    const createData = db.agentRun.create.mock.calls[0]![0]!.data as Record<string, unknown>
    expect(createData.status).toBe('done')
    expect(createData.ok).toBe(false)
    expect(createData.haltedReason).toContain('charter_day')
  })

  it('a halted fleet blocks execution with the halt reason', async () => {
    db.agentFleetState.upsert.mockResolvedValue({
      id: 'singleton',
      halted: true,
      haltedAt: new Date(),
      haltReason: 'operator stop',
      haltedBy: 'operator:awais',
      dailyCeilingUSD: 2.0,
      updatedAt: new Date(),
    } as never)
    const r = await executeCharter('fleet-selftest', { ...OPTS })
    expect(r.ok).toBe(false)
    expect(r.haltedReason).toContain('fleet_halted')
    expect(generate).not.toHaveBeenCalled()
  })

  it('a disabled charter is a no-op with NO run row', async () => {
    db.agentCharter.findMany.mockResolvedValue([] as never) // no policy row ⇒ OFF
    const r = await executeCharter('fleet-selftest', { ...OPTS })
    expect(r.ok).toBe(true)
    expect(r.skipped).toBe('disabled')
    expect(r.runId).toBeNull()
    expect(db.agentRun.create).not.toHaveBeenCalled()
  })

  it('manual run-now ignores enabled, like the existing agents', async () => {
    db.agentCharter.findMany.mockResolvedValue([] as never)
    generate.mockResolvedValue({ text: VALID_REPLY, usage: usage() })
    const r = await executeCharter('fleet-selftest', {
      ...OPTS,
      ignoreEnabled: true,
    })
    expect(r.ok).toBe(true)
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('unknown charter key resolves to an error without a run row', async () => {
    const r = await executeCharter('no-such-charter', { ...OPTS })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/unknown charter/)
    expect(db.agentRun.create).not.toHaveBeenCalled()
  })
})
