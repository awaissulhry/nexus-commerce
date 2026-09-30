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
 */

import { Prisma } from '@nexus/database'
import prisma from '../../db.js'
import { getTool } from './tool-registry.js'
import { resolveToolPolicy } from './tool-policy.service.js'
import {
  callTool,
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
}

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
  } = {},
): Promise<GateOutcome> {
  const policy = await resolveToolPolicy(name)
  if (!policy) return { ok: false, mode: 'error', error: `unknown tool: ${name}` }
  if (!policy.enabled)
    return { ok: false, mode: 'error', error: `tool ${name} is disabled` }

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
  return {
    ok: true,
    mode: 'queued',
    approvalId: ap.id,
    expiresAt: ap.expiresAt,
    preview: visible.preview ?? visible.data,
  }
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
  const ap = await prisma.agentApproval.findUnique({ where: { id } })
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
    const { raw, visible } = await executeTool(
      decider,
      ap.toolName,
      ap.args as Record<string, unknown>,
    )
    await prisma.agentApproval.update({
      where: { id },
      data: {
        status: raw.ok ? 'executed' : 'pending',
        reason: raw.ok ? null : `execution failed: ${raw.error}`,
      },
    })
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
