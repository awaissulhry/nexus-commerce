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
 */

import { Prisma } from '@nexus/database'
import prisma from '../../db.js'
import { getTool } from './tool-registry.js'
import { resolveToolPolicy } from './tool-policy.service.js'
import type { ToolContext } from './tool-types.js'

const EXPIRY_HOURS = 24

export interface GateOutcome {
  ok: boolean
  mode: 'executed' | 'queued' | 'preview' | 'error'
  approvalId?: string
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
  ctx: ToolContext,
  agentRunId: string,
): Promise<GateOutcome> {
  const policy = await resolveToolPolicy(name)
  const tool = getTool(name)
  if (!policy || !tool)
    return { ok: false, mode: 'error', error: `unknown tool: ${name}` }
  if (!policy.enabled)
    return { ok: false, mode: 'error', error: `tool ${name} is disabled` }

  // Read/draft + no-approval tools run immediately.
  if (!policy.requiresApproval) {
    const res = await tool.handler(args, ctx)
    return {
      ok: res.ok,
      mode: 'executed',
      data: res.data ?? res.preview,
      error: res.error,
    }
  }

  // Requires approval — build the dry-run preview.
  const pv = await tool.handler(args, ctx)
  if (!pv.ok) return { ok: false, mode: 'error', error: pv.error }
  // A preview-only tool (no execute()) can never be queued — it just
  // returns its dry-run preview.
  if (!tool.execute) {
    return { ok: true, mode: 'preview', preview: pv.preview ?? pv.data }
  }
  const ap = await prisma.agentApproval.create({
    data: {
      agentRunId,
      toolName: name,
      riskTier: policy.riskTier,
      args: args as Prisma.InputJsonValue,
      preview: (pv.preview ?? pv.data) as Prisma.InputJsonValue,
      status: 'pending',
      expiresAt: new Date(Date.now() + EXPIRY_HOURS * 3600 * 1000),
    },
  })
  return {
    ok: true,
    mode: 'queued',
    approvalId: ap.id,
    preview: pv.preview ?? pv.data,
  }
}

/**
 * Standalone request (the copilot "Request approval" button / testing) —
 * creates a lightweight AgentRun to attach the approval to.
 */
export async function requestApproval(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext = {},
): Promise<GateOutcome> {
  const run = await prisma.agentRun.create({
    data: {
      agentKey: 'manual-action',
      trigger: 'manual',
      status: 'done',
      ok: true,
      input: { tool: name, args } as Prisma.InputJsonValue,
      userId: ctx.userId ?? null,
      endedAt: new Date(),
    },
  })
  return runOrQueueTool(name, args, ctx, run.id)
}

export async function decideApproval(
  id: string,
  decision: 'approve' | 'reject',
  decidedBy?: string | null,
  reason?: string,
): Promise<{ ok: boolean; status?: string; result?: unknown; error?: string }> {
  const ap = await prisma.agentApproval.findUnique({ where: { id } })
  if (!ap) return { ok: false, error: 'approval not found' }
  if (ap.status !== 'pending') return { ok: false, error: `already ${ap.status}` }

  if (decision === 'reject') {
    await prisma.agentApproval.update({
      where: { id },
      data: {
        status: 'rejected',
        decidedBy: decidedBy ?? null,
        decidedAt: new Date(),
        reason: reason ?? null,
      },
    })
    return { ok: true, status: 'rejected' }
  }

  // Approve — atomic pending→executing claim makes execution idempotent.
  const claim = await prisma.agentApproval.updateMany({
    where: { id, status: 'pending' },
    data: { status: 'executing', decidedBy: decidedBy ?? null, decidedAt: new Date() },
  })
  if (claim.count === 0) return { ok: false, error: 'already taken' }

  const tool = getTool(ap.toolName)
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
    const res = await tool.execute(ap.args as Record<string, unknown>, {
      userId: decidedBy,
    })
    await prisma.agentApproval.update({
      where: { id },
      data: {
        status: res.ok ? 'executed' : 'pending',
        reason: res.ok ? null : `execution failed: ${res.error}`,
      },
    })
    return {
      ok: res.ok,
      status: res.ok ? 'executed' : 'pending',
      result: res.data,
      error: res.error,
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
