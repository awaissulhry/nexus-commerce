/**
 * ACP.0 — minimal agent runtime (the thin vertical slice).
 *
 * Proves the control-plane spine end-to-end: tool registry → runtime →
 * AI-2 model routing → AgentRun audit. Read-only and deterministic: the
 * runtime runs one read-only tool (when an entity is supplied), then asks
 * the AI-2-routed model to answer. Phase 2 replaces the deterministic
 * tool step with a real tool-use loop where the model picks tools; Phase
 * 3 adds the approval gate for mutating tools. Everything is recorded on
 * AgentRun so the run is fully observable from day one.
 */

import { Prisma } from '@nexus/database'
import prisma from '../../db.js'
import {
  getProviderForFeature,
  resolveModelForFeature,
} from '../ai/model-resolver.service.js'
import { isAiKillSwitchOn } from '../ai/providers/index.js'
import { logUsage } from '../ai/usage-logger.service.js'
import { getTool } from './tool-registry.js'
import { resolveToolPolicy } from './tool-policy.service.js'

const FEATURE = 'products-copilot'

interface RunAgentInput {
  agentKey: string
  input: string
  entityType?: string | null
  entityId?: string | null
  userId?: string | null
}

interface Step {
  type: 'tool' | 'model'
  name: string
  args?: unknown
  result?: unknown
  ms: number
  costUSD?: number
}

export interface RunAgentOutput {
  runId: string
  ok: boolean
  answer?: string
  model?: string
  costUSD?: number
  error?: string
}

export async function runAgent(inp: RunAgentInput): Promise<RunAgentOutput> {
  const started = Date.now()
  const run = await prisma.agentRun.create({
    data: {
      agentKey: inp.agentKey,
      trigger: 'manual',
      status: 'running',
      entityType: inp.entityType ?? null,
      entityId: inp.entityId ?? null,
      input: { input: inp.input } as Prisma.InputJsonValue,
      userId: inp.userId ?? null,
    },
  })

  const steps: Step[] = []
  try {
    if (isAiKillSwitchOn())
      throw new Error('AI is temporarily disabled (kill switch).')

    // Step 1 — read-only tool. ACP.0 runs product-snapshot when given a
    // Product entity; Phase 2 lets the model choose tools itself.
    let toolData: unknown = null
    if (inp.entityType === 'Product' && inp.entityId) {
      const tool = getTool('product-snapshot')
      if (tool) {
        const t0 = Date.now()
        const res = await tool.handler(
          { productId: inp.entityId },
          { userId: inp.userId },
        )
        steps.push({
          type: 'tool',
          name: tool.name,
          args: { productId: inp.entityId },
          result: res,
          ms: Date.now() - t0,
        })
        if (!res.ok) throw new Error(res.error ?? 'tool failed')
        toolData = res.data
      }
    }

    // Step 2 — model via AI-2 routing (provider-pinning + per-feature).
    const provider = await getProviderForFeature(FEATURE)
    if (!provider) throw new Error('No AI provider configured.')
    const model = await resolveModelForFeature(FEATURE, provider)

    const prompt = [
      'You are the Nexus products copilot. Answer the operator concisely',
      'and helpfully. You may only SUGGEST — never claim to have changed',
      'anything (you are read-only at this stage).',
      '',
      `Operator request: ${inp.input}`,
      toolData
        ? `\nProduct snapshot (read-only):\n${JSON.stringify(toolData, null, 2)}`
        : '',
    ].join('\n')

    const t1 = Date.now()
    const result = await provider.generate({
      prompt,
      model,
      feature: FEATURE,
      temperature: 0.3,
      maxOutputTokens: 1024,
      entityType: inp.entityType ?? undefined,
      entityId: inp.entityId ?? undefined,
    })
    const modelMs = Date.now() - t1
    steps.push({
      type: 'model',
      name: result.usage.model,
      ms: modelMs,
      costUSD: result.usage.costUSD,
    })

    // Mirror spend into AI-2 usage telemetry so the copilot shows up in
    // /settings/ai alongside every other AI call.
    logUsage({
      provider: result.usage.provider,
      model: result.usage.model,
      feature: FEATURE,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUSD: result.usage.costUSD,
      latencyMs: modelMs,
      ok: true,
      entityType: inp.entityType ?? undefined,
      entityId: inp.entityId ?? undefined,
    })

    await prisma.agentRun.update({
      where: { id: run.id },
      data: {
        status: 'done',
        ok: true,
        output: { answer: result.text } as Prisma.InputJsonValue,
        steps: steps as unknown as Prisma.InputJsonValue,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costUSD: result.usage.costUSD,
        model: result.usage.model,
        provider: result.usage.provider,
        latencyMs: Date.now() - started,
        endedAt: new Date(),
      },
    })
    return {
      runId: run.id,
      ok: true,
      answer: result.text,
      model: result.usage.model,
      costUSD: result.usage.costUSD,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await prisma.agentRun
      .update({
        where: { id: run.id },
        data: {
          status: 'failed',
          ok: false,
          errorMessage: msg,
          steps: steps as unknown as Prisma.InputJsonValue,
          latencyMs: Date.now() - started,
          endedAt: new Date(),
        },
      })
      .catch(() => {})
    return { runId: run.id, ok: false, error: msg }
  }
}

export interface InvokeResult {
  tool: string
  ok: boolean
  data?: unknown
  preview?: unknown
  error?: string
  requiresApproval?: boolean
  riskTier?: string
}

/**
 * Policy-guarded single-tool invocation — used by the tool endpoint and,
 * in Phase 2, by the copilot's tool-use loop. Read/draft tools run; a tool
 * that `requiresApproval` returns its dry-run preview WITHOUT executing
 * (the approval gate + real execution land in Phase 3).
 */
export async function invokeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { userId?: string | null } = {},
): Promise<InvokeResult> {
  if (isAiKillSwitchOn())
    return { tool: name, ok: false, error: 'AI is temporarily disabled.' }
  const policy = await resolveToolPolicy(name)
  if (!policy) return { tool: name, ok: false, error: `unknown tool: ${name}` }
  if (!policy.enabled)
    return { tool: name, ok: false, error: `tool ${name} is disabled` }
  const tool = getTool(name)
  if (!tool) return { tool: name, ok: false, error: `unknown tool: ${name}` }
  const res = await tool.handler(args, ctx)
  return {
    tool: name,
    ok: res.ok,
    data: policy.requiresApproval ? undefined : res.data,
    preview: res.preview ?? (policy.requiresApproval ? res.data : undefined),
    error: res.error,
    requiresApproval: policy.requiresApproval,
    riskTier: policy.riskTier,
  }
}
