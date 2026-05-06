/**
 * Persists AiUsageLog rows for cost + telemetry analytics.
 *
 * Fire-and-forget: the LLM call already paid the latency, the user is
 * waiting on the response, so we don't make them wait on a DB INSERT.
 * Logging failures are caught and logged but never propagated — the
 * audit trail is best-effort, not load-bearing.
 *
 * If you need synchronous accounting (e.g. cost-cap enforcement before
 * the next call), read AiUsageLog directly with a recent createdAt
 * range; don't try to make this writer synchronous.
 */

import prisma from '../../db.js'
import type { ProviderName } from './providers/types.js'

export interface UsageLogInput {
  provider: ProviderName
  model: string
  feature?: string
  entityType?: string
  entityId?: string
  inputTokens: number
  outputTokens: number
  costUSD: number
  metadata?: Record<string, unknown>
  latencyMs?: number
  ok: boolean
  errorCode?: string
  errorMessage?: string
  userId?: string
}

export function logUsage(input: UsageLogInput): void {
  // Schedule, don't await — keeps the request hot path off the DB
  // round-trip. setImmediate over Promise.resolve().then so we
  // unwind to the event loop tick boundary cleanly.
  setImmediate(() => {
    void prisma.aiUsageLog
      .create({
        data: {
          provider: input.provider,
          model: input.model,
          feature: input.feature ?? null,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          costUSD: input.costUSD,
          metadata: (input.metadata ?? null) as any,
          latencyMs: input.latencyMs ?? null,
          ok: input.ok,
          errorCode: input.errorCode ?? null,
          errorMessage: input.errorMessage ?? null,
          userId: input.userId ?? null,
        },
      })
      .catch((err) => {
        // Use console; logger may not be available in every context
        // and we don't want a missing logger to silently swallow
        // logging errors in dev.
        // eslint-disable-next-line no-console
        console.error('[ai-usage] failed to write log row:', err)
      })
  })
}
