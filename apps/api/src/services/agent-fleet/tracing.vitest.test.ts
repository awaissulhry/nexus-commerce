/**
 * NAF.A — tracing: pure OTel GenAI attribute shaping + the AgentStep
 * appender whose failure must never fail a run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    agentStep: {
      create: vi.fn(),
    },
  },
}))

import prisma from '../../db.js'
import { otelAttributes, recordStep } from './tracing.js'

const create = vi.mocked(prisma.agentStep.create)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('otelAttributes', () => {
  it('shapes the golden attribute object', () => {
    const attrs = otelAttributes(
      { key: 'fleet-selftest', version: 1, modelFeature: 'agent-fleet-analyst' },
      {
        agentRunId: 'run_1',
        seq: 2,
        type: 'model',
        name: 'claude-haiku-4-5',
        inputTokens: 1200,
        outputTokens: 300,
      },
      'orch_abc',
    )
    expect(attrs).toEqual({
      'gen_ai.agent.name': 'fleet-selftest',
      'gen_ai.operation.name': 'model:claude-haiku-4-5',
      'gen_ai.usage.input_tokens': 1200,
      'gen_ai.usage.output_tokens': 300,
      'naf.charter_key': 'fleet-selftest',
      'naf.charter_version': 1,
      'naf.model_feature': 'agent-fleet-analyst',
      'naf.orchestration_id': 'orch_abc',
      'naf.seq': 2,
    })
  })

  it('omits the orchestration id when the run is not orchestrated', () => {
    const attrs = otelAttributes(
      { key: 'fleet-selftest', version: 1, modelFeature: 'agent-fleet-analyst' },
      { agentRunId: 'run_1', seq: 1, type: 'observation', name: 'cron-health' },
    )
    expect('naf.orchestration_id' in attrs).toBe(false)
    expect(attrs['gen_ai.usage.input_tokens']).toBe(0)
  })
})

describe('recordStep', () => {
  it('persists a step row', async () => {
    create.mockResolvedValue({} as never)
    await recordStep({
      agentRunId: 'run_1',
      seq: 1,
      type: 'observation',
      name: 'cron-health',
      output: { id: 'obs_1', cached: true },
      latencyMs: 12,
    })
    expect(create).toHaveBeenCalledTimes(1)
    const data = create.mock.calls[0]![0]!.data as Record<string, unknown>
    expect(data.agentRunId).toBe('run_1')
    expect(data.seq).toBe(1)
    expect(data.ok).toBe(true)
  })

  it('swallows a rejecting create — a trace write must never fail a run', async () => {
    create.mockRejectedValue(new Error('down'))
    await expect(
      recordStep({ agentRunId: 'run_1', seq: 1, type: 'gate', name: 'halt' }),
    ).resolves.toBeUndefined()
  })
})
