/**
 * ACP.4a — autonomous agent runtime.
 *
 * The scheduled / triggered sibling of the interactive copilot
 * (agent-runtime.runChat). An autonomous agent SCANS some scope and
 * QUEUES proposals through the same approval gate the copilot uses — it
 * never auto-applies a high-stakes action. Every run is wrapped in an
 * AgentRun so the whole thing is observable (and, later, drives the
 * Control Center) exactly like an interactive run.
 *
 * Agents are defined in code (an in-repo registry, like the tool
 * registry) and surfaced by key. Phase 4a ships one: the Listing-Quality
 * Keeper. Phase 4b adds the Pricing Watchdog.
 */

import { Prisma } from '@nexus/database'
import prisma from '../../db.js'
import { isAiKillSwitchOn } from '../ai/providers/index.js'
import { logger } from '../../utils/logger.js'
import { listingQualityKeeper } from './autonomous/listing-quality-keeper.js'
import { pricingWatchdog } from './autonomous/pricing-watchdog.js'

export interface AutonomousAgentResult {
  scanned: number
  flagged: number
  proposed: number
  skippedExisting: number
  errors: number
  proposals: {
    productId: string
    sku: string
    approvalId: string
    summary: string
  }[]
}

export interface AutonomousAgent {
  key: string
  name: string
  description: string
  run(ctx: { runId: string; maxItems: number }): Promise<AutonomousAgentResult>
}

const DEFAULT_MAX_ITEMS = 5

const AGENTS: Record<string, AutonomousAgent> = {
  [listingQualityKeeper.key]: listingQualityKeeper,
  [pricingWatchdog.key]: pricingWatchdog,
}

export function getAutonomousAgent(key: string): AutonomousAgent | undefined {
  return AGENTS[key]
}

export function listAutonomousAgents(): {
  key: string
  name: string
  description: string
}[] {
  return Object.values(AGENTS).map((a) => ({
    key: a.key,
    name: a.name,
    description: a.description,
  }))
}

export interface RunAutonomousOutput {
  runId: string
  ok: boolean
  agentKey: string
  result?: AutonomousAgentResult
  error?: string
}

/**
 * Run an autonomous agent once. Records an AgentRun (trigger 'schedule'
 * for cron, 'manual' for an operator/API run), invokes the agent's scan +
 * propose, and persists the summary. The agent itself queues each
 * proposal via the approval gate, attaching it to this run.
 */
export async function runAutonomousAgent(
  key: string,
  trigger: 'schedule' | 'manual',
  opts: { maxItems?: number; userId?: string | null } = {},
): Promise<RunAutonomousOutput> {
  const agent = getAutonomousAgent(key)
  if (!agent)
    return { runId: '', ok: false, agentKey: key, error: `unknown agent: ${key}` }

  const maxItems = Math.max(1, Math.min(opts.maxItems ?? DEFAULT_MAX_ITEMS, 25))
  const started = Date.now()
  const run = await prisma.agentRun.create({
    data: {
      agentKey: key,
      trigger,
      status: 'running',
      input: { maxItems } as Prisma.InputJsonValue,
      userId: opts.userId ?? null,
    },
  })

  try {
    if (isAiKillSwitchOn())
      throw new Error('AI is temporarily disabled (kill switch).')

    const result = await agent.run({ runId: run.id, maxItems })

    await prisma.agentRun.update({
      where: { id: run.id },
      data: {
        status: 'done',
        ok: true,
        output: result as unknown as Prisma.InputJsonValue,
        latencyMs: Date.now() - started,
        endedAt: new Date(),
      },
    })
    logger.info('autonomous-agent: run complete', {
      agentKey: key,
      trigger,
      proposed: result.proposed,
      flagged: result.flagged,
      scanned: result.scanned,
    })
    return { runId: run.id, ok: true, agentKey: key, result }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await prisma.agentRun
      .update({
        where: { id: run.id },
        data: {
          status: 'failed',
          ok: false,
          errorMessage: msg,
          latencyMs: Date.now() - started,
          endedAt: new Date(),
        },
      })
      .catch(() => {})
    return { runId: run.id, ok: false, agentKey: key, error: msg }
  }
}
