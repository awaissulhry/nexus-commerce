/**
 * MCP.7 — one tools/call from Claude, through the one door.
 *
 *   read tool     runs as the person, in the business the token names; the answer is the
 *                 money-filtered copy (call-tool.ts)
 *   change tool   runs its dry run only and queues an AgentApproval (approval-gate.service.ts).
 *                 Claude gets the preview, the approval id, when it expires and the Approvals
 *                 page a person decides in. Nothing here can approve or execute (D1 = A).
 *
 * Every call leaves one AgentRun: who, via 'claude', over which connection (runOrigin), and how
 * it ended. A queued approval hangs off that run, so Nexus can say it was requested via Claude.
 * The AI kill switch refuses every call before any tool runs.
 */

import { Prisma } from '@nexus/database'
import type { CallToolResult } from '@modelcontextprotocol/server'
import prisma from '../../db.js'
import { withAuthenticatedUser } from '../../lib/auth/identity-context.js'
import { withWorkspace } from '../../lib/workspace-context.js'
import { logger } from '../../utils/logger.js'
import { isAiKillSwitchOn } from '../ai/providers/index.js'
import { runOrQueueTool, type GateOutcome } from '../agents/approval-gate.service.js'
import { runOrigin } from '../agents/call-tool.js'
import type { AgentTool } from '../agents/tool-types.js'
import { oauthIssuer } from '../oauth/oauth-config.js'
import type { McpPrincipal } from './mcp-auth.js'

/** The run of every call Claude makes; `via` and `oauthGrantId` say which connection. */
export const MCP_AGENT_KEY = 'claude'

const KILL_SWITCH_TEXT = 'Nexus has paused its AI tools (the AI kill switch is on). Nothing ran.'
const FAILED_TEXT = 'Nexus could not run this tool. Nothing changed. Try again later.'

/** The page a person approves in — the business's own, when business profiles are on. */
export function approvalsPageUrl(workspaceId: string): string {
  const path =
    process.env.NEXUS_WORKSPACES_ENABLED === '1'
      ? `/w/${encodeURIComponent(workspaceId)}/fleet/approvals`
      : '/fleet/approvals'
  return `${oauthIssuer()}${path}`
}

const text = (value: unknown): CallToolResult['content'] => [
  { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) },
]
const refused = (message: string): CallToolResult => ({ content: text(message), isError: true })

/** What Claude reads for each way the gate can end. */
function answer(outcome: GateOutcome, principal: McpPrincipal): CallToolResult {
  switch (outcome.mode) {
    case 'queued':
      return {
        content: text({
          status: 'waiting_for_approval',
          approvalId: outcome.approvalId,
          expiresAt: outcome.expiresAt ?? null,
          approveAt: approvalsPageUrl(principal.workspace.workspaceId),
          preview: outcome.preview ?? null,
          next:
            'Nothing has changed yet. A person with the right permission must approve this in the Nexus ' +
            'Approvals page before it runs; you cannot approve it. Call approval-status with the approvalId ' +
            'to see what became of it.',
        }),
      }
    case 'preview':
      return {
        content: text({
          status: 'preview_only',
          preview: outcome.preview ?? null,
          next: 'This action can only be previewed today. Nothing was queued and nothing changed.',
        }),
      }
    case 'executed':
      return outcome.ok ? { content: text(outcome.data ?? null) } : refused(outcome.error ?? 'The tool found nothing.')
    default:
      return refused(outcome.error ?? FAILED_TEXT)
  }
}

/** How the run ends, for each way the gate can end. */
function ending(outcome: GateOutcome): Prisma.AgentRunUpdateInput {
  if (outcome.mode === 'queued') {
    return { status: 'awaiting_approval', ok: true, output: { mode: 'queued', approvalId: outcome.approvalId ?? null } }
  }
  if (outcome.mode === 'error') return { status: 'failed', ok: false, errorMessage: outcome.error ?? null }
  return { status: 'done', ok: outcome.ok, errorMessage: outcome.ok ? null : (outcome.error ?? null), output: { mode: outcome.mode } }
}

/** Run one tool for Claude, as the person, in their business, and record it. */
export async function runToolForClaude(
  principal: McpPrincipal,
  tool: AgentTool,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  // Bound here, not only by the route: the audit rows are row-level secured to this business.
  return withAuthenticatedUser(principal.userId, () =>
    withWorkspace(principal.workspace, async () => {
      const started = Date.now()
      const run = await prisma.agentRun.create({
        data: {
          agentKey: MCP_AGENT_KEY,
          trigger: 'manual',
          status: 'running',
          input: { tool: tool.name, args } as Prisma.InputJsonValue,
          userId: principal.userId,
          ...runOrigin(principal),
        },
      })
      const finish = (data: Prisma.AgentRunUpdateInput) =>
        prisma.agentRun.update({
          where: { id: run.id },
          data: { ...data, latencyMs: Date.now() - started, endedAt: new Date() },
        })

      if (isAiKillSwitchOn()) {
        await finish({ status: 'failed', ok: false, errorMessage: 'AI is temporarily disabled (kill switch).' })
        return refused(KILL_SWITCH_TEXT)
      }
      try {
        const outcome = await runOrQueueTool(tool.name, args, principal, run.id)
        await finish(ending(outcome))
        return answer(outcome, principal)
      } catch (error) {
        // An unexpected failure stays in the log and on the run; Claude gets no internals.
        const message = error instanceof Error ? error.message : String(error)
        logger.error('[mcp] tool call failed', { tool: tool.name, runId: run.id, error: message })
        await finish({ status: 'failed', ok: false, errorMessage: message }).catch(() => undefined)
        return refused(FAILED_TEXT)
      }
    }),
  )
}
