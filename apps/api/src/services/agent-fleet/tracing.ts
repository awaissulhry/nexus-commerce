/**
 * NAF.A — the fleet's step trace (design law L6): every stage of a run
 * lands on AgentStep, OTel GenAI-shaped so per-step cost is indexable and
 * summable (plan D12 — the deliberate divergence from AgentRun.steps Json).
 *
 * recordStep is .catch-suppressed: a trace write must never fail a run.
 */
import { Prisma } from '@nexus/database'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

export interface StepInput {
  agentRunId: string
  seq: number
  type: 'observation' | 'model' | 'validation' | 'gate'
  name: string
  input?: unknown
  output?: unknown
  inputTokens?: number
  outputTokens?: number
  costUSD?: number
  latencyMs?: number
  ok?: boolean
  errorMessage?: string
}

/** Pure OTel GenAI attribute shaping — what a future exporter would emit;
 *  today it documents the trace vocabulary and feeds tests. */
export function otelAttributes(
  charter: { key: string; version: number; modelFeature: string },
  step: StepInput,
  orchestrationId?: string | null,
): Record<string, unknown> {
  const attrs: Record<string, unknown> = {
    'gen_ai.agent.name': charter.key,
    'gen_ai.operation.name': `${step.type}:${step.name}`,
    'gen_ai.usage.input_tokens': step.inputTokens ?? 0,
    'gen_ai.usage.output_tokens': step.outputTokens ?? 0,
    'naf.charter_key': charter.key,
    'naf.charter_version': charter.version,
    'naf.model_feature': charter.modelFeature,
    'naf.seq': step.seq,
  }
  if (orchestrationId) attrs['naf.orchestration_id'] = orchestrationId
  return attrs
}

export async function recordStep(step: StepInput): Promise<void> {
  await prisma.agentStep
    .create({
      data: {
        agentRunId: step.agentRunId,
        seq: step.seq,
        type: step.type,
        name: step.name,
        input: (step.input ?? undefined) as Prisma.InputJsonValue | undefined,
        output: (step.output ?? undefined) as Prisma.InputJsonValue | undefined,
        inputTokens: step.inputTokens ?? 0,
        outputTokens: step.outputTokens ?? 0,
        costUSD: step.costUSD ?? 0,
        latencyMs: step.latencyMs ?? null,
        ok: step.ok ?? true,
        errorMessage: step.errorMessage ?? null,
      },
    })
    .then(() => {})
    .catch((err) => {
      logger.error('[agent-fleet] step trace write failed (suppressed)', {
        agentRunId: step.agentRunId,
        seq: step.seq,
        error: String(err),
      })
    })
}
