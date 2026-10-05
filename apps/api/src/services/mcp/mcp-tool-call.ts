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
 *
 * MCP full control C3 — the business, named. Every answer is a JSON object whose first key is
 * `business: { id, name }` (the token's; a tool's own field of that name never overrides it). Every
 * change names the business (`business: "<name>"`, required by its schema): a missing or different name
 * is refused before anything runs ("This connection works in X; you named Y. Nothing was queued."). A
 * read may name it and is held to it too. The name is a CHECK, never a selector: it is removed before
 * the tool sees the arguments, and the business always comes from the token.
 *
 * MCP full control C5 (D1 = B) — the trust decision replaces "a change always waits for a person". Every change is
 * still STORED as a request (forceAsk: one approval, one preview, one expiry, the same audit), and the business's
 * level for the tool decides who takes it (claude-trust.service.ts): off → refused before anything runs (and not
 * offered); ask → a person in Nexus (with no row, every tool: exactly as before); confirm → a person in Nexus until
 * confirm-change exists (C7); auto → scheduled by the rule as the person who asked (decisionVia auto), through the
 * normal undo window and commit, but only with the connection's nexus.run scope, outside a Pause, inside the tool's
 * limits and under the daily cap — otherwise a person decides and Claude is told why. An undo follows the level of
 * the change it asks for.
 *
 * C6 — a change plan (submit-change-plan; the undo of a plan) is one request: queued, its answer says how many steps,
 * the summary and the planHash; refused, it names each step's refusal. It runs by rule only when every step may.
 *
 * C7 — a change (or plan) at `confirm` answers with its summary, its planHash and "type your authenticator code"; the
 * person who asked approves it with confirm-change (claude-confirm.service.ts). A tool's secret arguments (the code)
 * are never written to the run.
 */

import { Prisma } from '@nexus/database'
import type { CallToolResult } from '@modelcontextprotocol/server'
import prisma from '../../db.js'
import { withAuthenticatedUser } from '../../lib/auth/identity-context.js'
import { withWorkspace } from '../../lib/workspace-context.js'
import { logger } from '../../utils/logger.js'
import { isAiKillSwitchOn } from '../ai/providers/index.js'
import { runOrQueueTool, type GateOutcome, type GateRule, type RuleVerdict } from '../agents/approval-gate.service.js'
import { runOrigin } from '../agents/call-tool.js'
import type { AgentTool } from '../agents/tool-types.js'
import { argumentsRefusal } from '../agents/tool-arguments.js'
import { getTool } from '../agents/tool-registry.js'
import { autoRefusal, claudeRuleOf, CONFIRM_IN_CLAUDE, overDailyCap, planRuleRefusal, withdrawRuleSchedule } from '../agents/claude-trust.service.js'
import { confirmByCode, prepareConfirm } from '../agents/claude-confirm.service.js'
import { scheduleApproval } from '../agent-fleet/approval-inbox.service.js'
import { oauthIssuer } from '../oauth/oauth-config.js'
import { BUSINESS_ARGUMENT, type McpPrincipal } from './mcp-auth.js'
import { marketRefusal } from '../agents/market-check.js'

/** The run of every call Claude makes; `via` and `oauthGrantId` say which connection. */
export const MCP_AGENT_KEY = 'claude'

const KILL_SWITCH_TEXT = 'Nexus has paused its AI tools (the AI kill switch is on). Nothing ran.'
const FAILED_TEXT = 'Nexus could not run this tool. Nothing changed. Try again later.'

/**
 * The page a person approves in — the business's own, when business profiles are on. Approvals grid (2026-10-05): with
 * the request's id it opens that row (`?item=<approvalId>`; for a change plan, the plan's approval id).
 */
export function approvalsPageUrl(workspaceId: string, approvalId?: string | null): string {
  const path =
    process.env.NEXUS_WORKSPACES_ENABLED === '1'
      ? `/w/${encodeURIComponent(workspaceId)}/fleet/approvals`
      : '/fleet/approvals'
  const item = approvalId ? `?item=${encodeURIComponent(approvalId)}` : ''
  return `${oauthIssuer()}${path}${item}`
}

const text = (value: unknown): CallToolResult['content'] => [
  { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) },
]

/**
 * C3 — an answer stamped with the token's business, first. An object keeps its own fields (but never its own
 * `business`); anything else (a list, a bare value) comes back under `data`.
 */
export function stamped(principal: McpPrincipal, value: unknown): Record<string, unknown> {
  const business = { id: principal.business.id, name: principal.business.name }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const { business: _own, ...rest } = value as Record<string, unknown>
    return { business, ...rest }
  }
  return { business, data: value ?? null }
}

const ok = (principal: McpPrincipal, value: unknown): CallToolResult => ({ content: text(stamped(principal, value)) })
const refused = (principal: McpPrincipal, message: string): CallToolResult => ({
  content: text(stamped(principal, { error: message })),
  isError: true,
})

/** C3 — one business name, as a person would compare two: case, spacing and Unicode form do not matter. */
export function sameBusinessName(a: string, b: string): boolean {
  const plain = (name: string) => name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en')
  return plain(a) === plain(b)
}

/** C3 — why this call may not go ahead in this business, or null: a change must name it; a read may. */
export function businessRefusal(principal: McpPrincipal, tool: Pick<AgentTool, 'readOnly'>, args: Record<string, unknown>): string | null {
  const own = principal.business.name
  const nothing = tool.readOnly ? 'Nothing was read.' : 'Nothing was queued.'
  if (!(BUSINESS_ARGUMENT in args) || args[BUSINESS_ARGUMENT] === undefined) {
    return tool.readOnly ? null : `Name the business this change is for: business: "${own}" (this connection works in ${own}). ${nothing}`
  }
  const named = args[BUSINESS_ARGUMENT]
  if (typeof named === 'string' && sameBusinessName(named, own)) return null
  const shown = typeof named === 'string' ? named : JSON.stringify(named)
  return `This connection works in ${own}; you named ${shown}. ${nothing}`
}

/**
 * C5 — the business's rule for each tool Claude asks for (an undo's inverse tool included): off refuses before
 * anything runs; once the request is stored, auto schedules it as the person who asked when everything allows it.
 */
export function claudeGateRule(principal: McpPrincipal): GateRule {
  const runScope = principal.scopes?.includes('nexus.run') ?? false
  return {
    async refusal(tool) {
      const rule = await claudeRuleOf(tool.name)
      if (rule?.level !== 'off') return null
      return `${tool.name} is turned off for Claude in ${principal.business.name}. ${tool.readOnly ? 'Nothing ran.' : 'Nothing was queued.'}`
    },
    async confirm(input) {
      return confirmByCode(principal, input, { runScope })
    },
    async decide({ approvalId, tool, preview, steps }): Promise<RuleVerdict> {
      // C7 — at confirm: the summary and planHash the person's code will be bound to (with nexus.run only).
      const confirmable = async (why: string): Promise<RuleVerdict> => {
        const confirm = runScope ? await prepareConfirm(approvalId) : null
        const noScope = 'this business set it to "confirm in Claude", but this Claude connection may not confirm changes (it was connected without nexus.run); a person approves it in Nexus'
        return { by: 'person', level: 'confirm', why: runScope ? why : noScope, ...(confirm ? { confirm } : {}) }
      }
      if (steps) {
        // C6 — a plan: by rule only when every step may.
        const refused = await planRuleRefusal(steps, { runScope })
        if (refused?.level === 'confirm') return confirmable(refused.why ?? CONFIRM_IN_CLAUDE)
        if (refused) return { by: 'person', ...refused }
      } else {
        const rule = await claudeRuleOf(tool.name)
        if (!rule || rule.level === 'ask' || rule.level === 'off') return { by: 'person', level: 'ask' }
        if (rule.level === 'confirm') return confirmable(CONFIRM_IN_CLAUDE)
        const refusal = await autoRefusal(tool, preview, { runScope, rule })
        if (refusal) return { by: 'person', level: 'auto', why: refusal }
      }
      // As the person who asked: the commit re-checks their permissions in this business when the window ends.
      const parked = await scheduleApproval({ id: approvalId, actor: principal, via: 'auto' })
      if (!parked.ok || !parked.executeAfter) {
        return { by: 'person', level: 'auto', why: `it could not be scheduled (${parked.error ?? 'unknown'}); a person approves it in Nexus` }
      }
      const over = await overDailyCap()
      if (over) {
        await withdrawRuleSchedule(approvalId, over)
        return { by: 'person', level: 'auto', why: over }
      }
      return { by: 'rule', level: 'auto', executeAfter: parked.executeAfter }
    },
  }
}

/** What Claude reads for each way the gate can end. */
function answer(outcome: GateOutcome, principal: McpPrincipal): CallToolResult {
  switch (outcome.mode) {
    case 'queued':
      if (outcome.rule?.by === 'rule') {
        return ok(principal, {
          status: 'runs_by_rule',
          approvalId: outcome.approvalId,
          runsAt: outcome.rule.executeAfter,
          stopAt: approvalsPageUrl(principal.workspace.workspaceId, outcome.approvalId),
          preview: outcome.preview ?? null,
          trust: { level: 'auto' },
          ...(outcome.plan ? { plan: outcome.plan } : {}),
          ...(outcome.undoes ? { undoes: { changeId: outcome.undoes } } : {}),
          next:
            `${principal.business.name} lets Claude run this change by its rule (auto, inside its limits): nobody needs ` +
            'to approve it. It runs at runsAt, after a short window in which anyone with permission can stop it in the ' +
            'Nexus Approvals page. Call approval-status with the approvalId to see what became of it; undo-change puts it back.',
        })
      }
      return ok(principal, {
        status: 'waiting_for_approval',
        approvalId: outcome.approvalId,
        expiresAt: outcome.expiresAt ?? null,
        approveAt: approvalsPageUrl(principal.workspace.workspaceId, outcome.approvalId),
        preview: outcome.preview ?? null,
        // C6 — a plan: how many steps, the summary a person reads, and its hash.
        ...(outcome.plan ? { plan: outcome.plan } : {}),
        // C2 — an undo says which change it puts back.
        ...(outcome.undoes ? { undoes: { changeId: outcome.undoes } } : {}),
        // C5 — when a level above ask (or a plan's mixed levels) still leaves it to a person: why.
        ...(outcome.rule && outcome.rule.by === 'person' && (outcome.rule.level !== 'ask' || outcome.rule.why)
          ? { trust: { level: outcome.rule.level, why: outcome.rule.why ?? null } }
          : {}),
        // C7 — set to confirm: what the person's code approves, and how.
        ...(outcome.rule?.by === 'person' && outcome.rule.confirm
          ? {
              confirm: {
                summary: outcome.rule.confirm.summary,
                planHash: outcome.rule.confirm.planHash,
                next:
                  'Type your authenticator code to approve: ask the person who asked for the 6-digit code from their ' +
                  'authenticator app, then call confirm-change with this approvalId, this planHash and the code. Or a ' +
                  'person approves it in Nexus.',
              },
            }
          : {}),
        next:
          'Nothing has changed yet. A person with the right permission must approve this in the Nexus ' +
          'Approvals page before it runs; you cannot approve it. Call approval-status with the approvalId ' +
          'to see what became of it.',
      })
    case 'preview':
      return ok(principal, {
        status: 'preview_only',
        preview: outcome.preview ?? null,
        next: 'This action can only be previewed today. Nothing was queued and nothing changed.',
      })
    case 'executed':
      return outcome.ok ? ok(principal, outcome.data ?? null) : refused(principal, outcome.error ?? 'The tool found nothing.')
    default:
      // C6 — a plan that was not stored names each step's refusal.
      if (outcome.refusals?.length) {
        return { content: text(stamped(principal, { error: outcome.error ?? FAILED_TEXT, refusals: outcome.refusals })), isError: true }
      }
      return refused(principal, outcome.error ?? FAILED_TEXT)
  }
}

/** How the run ends, for each way the gate can end. */
function ending(outcome: GateOutcome): Prisma.AgentRunUpdateInput {
  // C5 — scheduled by the business's rule: Claude's call is done; the approval carries the rest.
  if (outcome.mode === 'queued' && outcome.rule?.by === 'rule') {
    return { status: 'done', ok: true, output: { mode: 'auto', approvalId: outcome.approvalId ?? null } }
  }
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
      // C3 — the business name is the door's check, never the tool's argument: recorded apart, then removed.
      const { [BUSINESS_ARGUMENT]: named, ...toolArgs } = args ?? {}
      // C7 — a secret argument (an authenticator code) is never written to the run.
      const recordedArgs = Object.fromEntries(
        Object.entries(toolArgs).map(([key, value]) => [key, tool.secretArgs?.includes(key) ? '[redacted]' : value]),
      )
      const run = await prisma.agentRun.create({
        data: {
          agentKey: MCP_AGENT_KEY,
          trigger: 'manual',
          status: 'running',
          input: { tool: tool.name, args: recordedArgs, ...(named !== undefined ? { business: named } : {}) } as Prisma.InputJsonValue,
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
        return refused(principal, KILL_SWITCH_TEXT)
      }
      const wrongBusiness = businessRefusal(principal, tool, args ?? {})
      if (wrongBusiness) {
        await finish({ status: 'failed', ok: false, errorMessage: wrongBusiness })
        return refused(principal, wrongBusiness)
      }
      // N1 — an argument name the tool does not take is refused with the name it likely meant, never dropped.
      const wrongArguments = argumentsRefusal(tool, toolArgs, getTool)
      if (wrongArguments) {
        await finish({ status: 'failed', ok: false, errorMessage: wrongArguments })
        return refused(principal, wrongArguments)
      }
      try {
        // Every change from Claude is stored as a request, even when the tool's policy needs no approval (forceAsk
        // only ever tightens the gate). C5 — the business's rule then says who decides it: a person, or the rule.
        // N1 — first: a market this business does not have is refused with the codes it has.
        const wrongMarket = await marketRefusal(tool, toolArgs)
        if (wrongMarket) {
          await finish({ status: 'failed', ok: false, errorMessage: wrongMarket })
          return refused(principal, wrongMarket)
        }
        const outcome = await runOrQueueTool(tool.name, toolArgs, principal, run.id, { forceAsk: !tool.readOnly, rule: claudeGateRule(principal) })
        await finish(ending(outcome))
        return answer(outcome, principal)
      } catch (error) {
        // An unexpected failure stays in the log and on the run; Claude gets no internals.
        const message = error instanceof Error ? error.message : String(error)
        logger.error('[mcp] tool call failed', { tool: tool.name, runId: run.id, error: message })
        // C8 — marked, so the activity list never repeats an internal error to Claude or a person.
        await finish({ status: 'failed', ok: false, errorMessage: message, output: { mode: 'crashed' } }).catch(() => undefined)
        return refused(principal, FAILED_TEXT)
      }
    }),
  )
}
