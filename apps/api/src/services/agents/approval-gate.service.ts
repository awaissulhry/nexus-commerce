/**
 * ACP.3a — the governed-action approval gate.
 *
 *   tool wants to mutate
 *     → requiresApproval? → create AgentApproval(pending) + dry-run preview
 *          → operator Approve → execute the real action (idempotent) → record
 *          → operator Reject  → discarded
 *     → else (low/medium no-approval) → execute now
 *
 * Dry-run first (you approve the actual diff), idempotent (an approval
 * executes exactly once via an atomic pending→executing claim), and fully
 * audited on AgentApproval + AgentRun. The execute() returns an undo
 * snapshot so applied changes are reversible.
 *
 * MCP.1 — every call names its principal. A person may run, queue or approve
 * only what their permissions cover (call-tool.ts); the stored preview is the
 * raw one, and what goes back to the caller is filtered for them.
 *
 * MCP full control C5 — a door may bring a RULE (`GateRule`): Claude's door brings the business's trust level for
 * each tool it asks for (an undo's inverse tool included). The rule may refuse a tool before anything runs (level
 * off), and once the request is stored it decides who takes the decision: the business's rule (auto: scheduled as
 * the person who asked, through the normal undo window and commit) or a person in Nexus (with the reason).
 */

import { Prisma } from '@nexus/database'
import prisma from '../../db.js'
import { getTool } from './tool-registry.js'
import { resolveToolPolicy } from './tool-policy.service.js'
import type { AgentTool, ClaudeTrust, ToolDoor } from './tool-types.js'
import type { StrategyNarrowing } from '../advertising/ads-strategy/claude.js'
import { logger } from '../../utils/logger.js'
import { linkUndoRequest, recordExecutedChangeSafely } from './change-record.service.js'
import { queuePlan } from './change-plan.service.js'
import {
  callTool,
  doorOf,
  executeTool,
  missingPermissions,
  permissionMessage,
  runOrigin,
  ToolAccessError,
  type ToolCall,
  type ToolPrincipal,
  type UserPrincipal,
} from './call-tool.js'

/**
 * How long an unanswered approval lives. NAF.AQ.0 exports it: the fleet
 * glossary told the operator "approvals expire after 7 days" while this said
 * 24 hours, so a UI retyping the number is how the two drifted apart. Any
 * surface stating the clock must read it from here.
 */
export const EXPIRY_HOURS = 24

export interface GateOutcome {
  ok: boolean
  mode: 'executed' | 'queued' | 'preview' | 'error'
  approvalId?: string
  /** MCP.7 — when a queued approval stops waiting (the row's own clock, EXPIRY_HOURS). */
  expiresAt?: Date | null
  preview?: unknown
  data?: unknown
  error?: string
  /** C2 — set when the request is the undo of a recorded change (AgentChange id). */
  undoes?: string
  /** C5 — who decides a queued request: the business's rule, or a person (and why, when the rule could not). */
  rule?: RuleVerdict
  /** C6 — a queued change plan: how many steps, the Nexus-written summary, and its hash. */
  plan?: { steps: number; summary: string; planHash: string }
  /** C6 — a plan that was not stored: each step's refusal, to fix and submit again. */
  refusals?: Array<{ step: number; tool: string; error: string }>
}

/**
 * C5 — who decides a stored request. `rule`: the business's rule scheduled it (auto) as the person who asked; it runs
 * at `executeAfter` unless someone stops it. `person`: it waits for a person in Nexus; `why` says why the tool's level
 * (above ask) did not decide it.
 */
export type RuleVerdict =
  | { by: 'rule'; level: 'auto'; executeAfter: string }
  | {
      by: 'person'
      level: ClaudeTrust
      why?: string
      confirm?: { summary: string; planHash: string }
      /** W1-8 — the ads strategy row that narrowed it below the business's level (`business`). */
      strategy?: StrategyNarrowing & { business: ClaudeTrust }
    }

/** C5 — a door's rule for the tools it asks for (Claude's: mcp-tool-call.ts, from claude-trust.service.ts). */
export interface GateRule {
  /**
   * Before anything runs: why this tool may not be used through this door at all (its level is off), or null. W1-8 —
   * with the arguments, an ad change is judged where it lands (the ads strategy may turn it off there).
   */
  refusal(tool: AgentTool, args?: Record<string, unknown>): Promise<string | null>
  /**
   * After the request is stored (raw preview): schedule it by the rule, or say why a person decides it. C6 — a plan
   * brings its steps (each tool, its arguments and raw preview): it runs by the rule only when every step may.
   */
  decide(queued: {
    approvalId: string
    tool: AgentTool
    preview: unknown
    args?: Record<string, unknown>
    steps?: Array<{ tool: AgentTool; preview: unknown; args?: Record<string, unknown> }>
  }): Promise<RuleVerdict>
  /** C7 — confirm a waiting request with the person's code (confirm-change); a door without it cannot. */
  confirm?(input: { approvalId: string; planHash: string; code: string }): Promise<GateOutcome>
}

const RULE_FAILED = 'Nexus could not apply the business’s rule to it, so a person approves it in Nexus'

/**
 * Run a tool now, queue it for approval, or return a preview — by policy.
 * `agentRunId` is the run this action belongs to (required to attach an
 * approval).
 */
export async function runOrQueueTool(
  name: string,
  args: Record<string, unknown>,
  principal: ToolPrincipal,
  agentRunId: string,
  opts: {
    /** NAF.WF.4b — a workflow step's `ask` gate. Tighten-only by
     *  construction: true forces the approval branch; false/absent changes
     *  nothing. Loosening below policy is structurally impossible here. */
    forceAsk?: boolean
    /** C5 — the door's rule (Claude's trust levels): may refuse a tool, and decides who takes a stored request. */
    rule?: GateRule
  } = {},
): Promise<GateOutcome> {
  const policy = await resolveToolPolicy(name)
  if (!policy) return { ok: false, mode: 'error', error: `unknown tool: ${name}` }
  if (!policy.enabled)
    return { ok: false, mode: 'error', error: `tool ${name} is disabled` }
  const listed = getTool(name)
  const refusal = opts.rule && listed ? await opts.rule.refusal(listed, args) : null
  if (refusal) return { ok: false, mode: 'error', error: refusal }

  const requiresApproval = policy.requiresApproval || opts.forceAsk === true

  // The dry run, as the principal: refused without the permission, run in
  // their business. Read/draft + no-approval tools stop here.
  let call: ToolCall
  try {
    call = await callTool(principal, name, args, { hourlyLimit: policy.rateLimitPerHour })
  } catch (err) {
    if (err instanceof ToolAccessError) return { ok: false, mode: 'error', error: err.message }
    throw err
  }
  const { tool, raw, visible } = call
  // C2 — a control tool (undo-change) is never queued itself: what it asks for is a NEW request through this gate.
  if (tool.control) return askedFor(name, raw, visible, principal, agentRunId, opts)
  if (!requiresApproval) {
    return {
      ok: raw.ok,
      mode: 'executed',
      data: visible.data ?? visible.preview,
      error: raw.error,
    }
  }

  if (!raw.ok) return { ok: false, mode: 'error', error: raw.error }
  // A preview-only tool (no execute()) can never be queued — it just
  // returns its dry-run preview.
  if (!tool.execute) {
    return { ok: true, mode: 'preview', preview: visible.preview ?? visible.data }
  }
  // The row keeps the raw preview: whoever reads it is filtered for their own
  // permissions then, and an approver cleared for money sees all of it.
  const ap = await prisma.agentApproval.create({
    data: {
      agentRunId,
      toolName: name,
      riskTier: policy.riskTier,
      args: args as Prisma.InputJsonValue,
      preview: (raw.preview ?? raw.data) as Prisma.InputJsonValue,
      status: 'pending',
      expiresAt: new Date(Date.now() + EXPIRY_HOURS * 3600 * 1000),
    },
  })
  const rule = opts.rule ? await decideByRule(opts.rule, { approvalId: ap.id, tool, preview: raw.preview ?? raw.data, args }) : undefined
  return {
    ok: true,
    mode: 'queued',
    approvalId: ap.id,
    expiresAt: ap.expiresAt,
    preview: visible.preview ?? visible.data,
    ...(rule ? { rule } : {}),
  }
}

/** C5 — the rule's verdict on a stored request; a rule that fails leaves it with a person, never runs it. */
export async function decideByRule(rule: GateRule, queued: Parameters<GateRule['decide']>[0]): Promise<RuleVerdict> {
  try {
    return await rule.decide(queued)
  } catch (error) {
    logger.error('[approval-gate] the door rule failed; the request waits for a person', {
      approvalId: queued.approvalId,
      tool: queued.tool.name,
      error: error instanceof Error ? error.message : String(error),
    })
    return { by: 'person', level: 'ask', why: RULE_FAILED }
  }
}

/**
 * C2 — what a control tool asked for, through the same gate as any request: the requested tool's own policy,
 * permissions, dry run, approval and expiry (`forceAsk` from Claude's door carries over). An undo request is tied to
 * the change it puts back; if another undo of that change won the race, this one is withdrawn, never left waiting.
 */
async function askedFor(
  name: string,
  raw: ToolCall['raw'],
  visible: ToolCall['visible'],
  principal: ToolPrincipal,
  agentRunId: string,
  opts: { forceAsk?: boolean; rule?: GateRule },
): Promise<GateOutcome> {
  if (!raw.ok) return { ok: false, mode: 'error', error: raw.error }
  // C6 — a change plan (submit-change-plan, or the undo of a plan): every step dry-run as the caller, ONE approval.
  if (raw.plan) return askedForPlan(name, raw.plan, principal, agentRunId, opts)
  // C7 — a confirmation with the person's code: only a door that knows how (Claude's) may take it.
  if (raw.confirm) {
    return opts.rule?.confirm
      ? opts.rule.confirm(raw.confirm)
      : { ok: false, mode: 'error', error: 'A change can be confirmed with an authenticator code only in Claude. Nothing was approved.' }
  }
  const request = raw.request
  if (!request) return { ok: true, mode: 'executed', data: visible.data ?? visible.preview }
  if (getTool(request.tool)?.control) {
    return { ok: false, mode: 'error', error: `${name} cannot ask for ${request.tool}. Nothing was queued.` }
  }
  const asked = await runOrQueueTool(request.tool, request.args, principal, agentRunId, opts)
  if (!request.undoes) return asked
  if (asked.mode === 'queued' && asked.approvalId && !(await linkUndoRequest(request.undoes, asked.approvalId))) {
    // C5 — `scheduled` too: the business's rule may already have scheduled it.
    await prisma.agentApproval.updateMany({
      where: { id: asked.approvalId, status: { in: ['pending', 'scheduled'] } },
      data: {
        status: 'rejected',
        decidedBy: name,
        decidedAt: new Date(),
        executeAfter: null,
        decisionVia: null,
        reason: 'withdrawn: another undo of the same change was asked for at the same time',
      },
    })
    return {
      ok: false,
      mode: 'error',
      error: 'Another undo of this change was asked for at the same moment and is waiting for a person. Nothing was queued.',
    }
  }
  return { ...asked, undoes: request.undoes }
}

/**
 * C6 — a plan a control tool asked for: queued as one approval (change-plan.service.ts). An undo plan is tied to each
 * change it puts back; if another undo of any of them won the race, the whole plan is withdrawn, never left waiting.
 */
async function askedForPlan(
  name: string,
  plan: NonNullable<ToolCall['raw']['plan']>,
  principal: ToolPrincipal,
  agentRunId: string,
  opts: { forceAsk?: boolean; rule?: GateRule },
): Promise<GateOutcome> {
  const asked = await queuePlan(plan, principal, agentRunId, opts)
  if (asked.mode !== 'queued' || !asked.approvalId || !plan.undoes?.length) return asked
  for (const changeId of plan.undoes) {
    if (await linkUndoRequest(changeId, asked.approvalId)) continue
    await prisma.agentApproval.updateMany({
      where: { id: asked.approvalId, status: { in: ['pending', 'scheduled'] } },
      data: {
        status: 'rejected',
        decidedBy: name,
        decidedAt: new Date(),
        executeAfter: null,
        decisionVia: null,
        reason: 'withdrawn: another undo of one of its changes was asked for at the same time',
      },
    })
    await prisma.agentChange.updateMany({ where: { undoneByApprovalId: asked.approvalId, undoneAt: null }, data: { undoneByApprovalId: null } })
    return {
      ok: false,
      mode: 'error',
      error: 'Another undo of one of these changes was asked for at the same moment and is waiting. Nothing was queued.',
    }
  }
  return asked
}

/**
 * Standalone request (the copilot "Request approval" button / testing) —
 * creates a lightweight AgentRun to attach the approval to.
 */
export async function requestApproval(
  name: string,
  args: Record<string, unknown>,
  principal: UserPrincipal,
): Promise<GateOutcome> {
  const run = await prisma.agentRun.create({
    data: {
      agentKey: 'manual-action',
      trigger: 'manual',
      status: 'done',
      ok: true,
      input: { tool: name, args } as Prisma.InputJsonValue,
      userId: principal.userId,
      ...runOrigin(principal),
      endedAt: new Date(),
    },
  })
  return runOrQueueTool(name, args, principal, run.id)
}

/**
 * C1 — the front door an approval's request came through, from its run (AgentRun.via): a person in Nexus or Claude;
 * a fleet run (it has a `mode`); otherwise something in-process. Undefined when the run is not known.
 */
export function requestDoor(run: { via?: string | null; mode?: string | null } | null | undefined): ToolDoor | undefined {
  if (!run) return undefined
  if (run.via === 'app' || run.via === 'claude') return run.via
  return run.mode ? 'fleet' : 'system'
}

/**
 * The person behind a decision (`decidedByUserId`), written beside the name shown (`decidedBy`). Only a person sets
 * it: a system decider (the sweep running a decision a person already took) leaves the stored person in place.
 */
function deciderId(decider: ToolPrincipal): { decidedByUserId?: string } {
  return decider.kind === 'user' ? { decidedByUserId: decider.userId } : {}
}

/**
 * Approve or reject one request. A person may approve only what they could
 * have done themselves (the tool's `requires`), checked before the claim. A
 * system decider is the sweep running a decision already taken and checked.
 */
export async function decideApproval(
  id: string,
  decision: 'approve' | 'reject',
  decider: ToolPrincipal,
  reason?: string,
): Promise<{
  ok: boolean
  status?: string
  result?: unknown
  error?: string
  /** Set when the decider lacks the tool's permission; a route answers 403. */
  code?: 'forbidden'
}> {
  const ap = await prisma.agentApproval.findUnique({
    where: { id },
    // C1 — the door the request came through, for the tool's context when it runs (and C2's change record).
    include: { agentRun: { select: { via: true, mode: true, oauthGrantId: true } } },
  })
  if (!ap) return { ok: false, error: 'approval not found' }
  if (ap.status !== 'pending') return { ok: false, error: `already ${ap.status}` }

  if (decision === 'reject') {
    await prisma.agentApproval.update({
      where: { id },
      data: {
        status: 'rejected',
        decidedBy: decider.label,
        ...deciderId(decider),
        decidedAt: new Date(),
        reason: reason ?? null,
      },
    })
    return { ok: true, status: 'rejected' }
  }

  const tool = getTool(ap.toolName)
  const missing = tool ? missingPermissions(decider, tool) : []
  if (missing.length > 0) {
    return { ok: false, code: 'forbidden', error: permissionMessage(ap.toolName, missing) }
  }

  // Approve — atomic pending→executing claim makes execution idempotent.
  const claim = await prisma.agentApproval.updateMany({
    where: { id, status: 'pending' },
    data: { status: 'executing', decidedBy: decider.label, ...deciderId(decider), decidedAt: new Date() },
  })
  if (claim.count === 0) return { ok: false, error: 'already taken' }

  if (!tool?.execute) {
    await prisma.agentApproval.update({
      where: { id },
      data: { status: 'approved', reason: 'approved; this tool is preview-only (no execute)' },
    })
    return {
      ok: true,
      status: 'approved',
      error: 'this tool is preview-only — there is no action to execute',
    }
  }
  try {
    // C1 — the tool learns which approval it carries out, the preview the person approved, and the door the
    // request came through (the decider always decides in Nexus).
    const { raw, visible } = await executeTool(
      decider,
      ap.toolName,
      ap.args as Record<string, unknown>,
      // 4A — approved by a person (in Nexus or with his code in Claude), not by a standing rule.
      { approvalId: id, approvedPreview: ap.preview ?? undefined, via: requestDoor(ap.agentRun), approvedByPerson: ap.decisionVia !== 'auto' },
    )
    await prisma.agentApproval.update({
      where: { id },
      data: {
        status: raw.ok ? 'executed' : 'pending',
        reason: raw.ok ? null : `execution failed: ${raw.error}`,
      },
    })
    // C2 — what it changed, kept for the record and for undo. After the status: a failure to record is logged and
    // never makes the change run a second time.
    if (raw.ok) {
      await recordExecutedChangeSafely({
        approvalId: id,
        tool,
        raw,
        via: requestDoor(ap.agentRun) ?? doorOf(decider),
        oauthGrantId: ap.agentRun?.oauthGrantId ?? null,
        executedByUserId: decider.kind === 'user' ? decider.userId : null,
        decisionVia: ap.decisionVia ?? null,
      })
    }
    return {
      ok: raw.ok,
      status: raw.ok ? 'executed' : 'pending',
      result: visible.data,
      error: raw.error,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Revert to pending so it can be retried, not silently lost.
    await prisma.agentApproval.update({
      where: { id },
      data: { status: 'pending', reason: `execution error: ${msg}` },
    })
    return { ok: false, error: msg }
  }
}

export async function listApprovals(status?: string) {
  return prisma.agentApproval.findMany({
    where: status ? { status } : {},
    orderBy: { requestedAt: 'desc' },
    take: 50,
  })
}
