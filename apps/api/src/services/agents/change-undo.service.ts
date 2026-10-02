/**
 * MCP full control C8 — Undo on the Claude activity page: the person's click is the approval.
 *
 * The click asks for the inverse change exactly as undo-change does (change-record.service.ts builds it, refused while
 * what is stored is no longer what the change wrote, while another undo waits, and once undone), through the same gate
 * as the person (their permissions for the inverse tool, its preview, its approval and audit), and then approves it as
 * the Approvals page does (decideFleetApproval): parked for the same undo window, re-checked at commit (the person's
 * permissions, the preview), run by the sweep. Nothing here writes a value itself.
 */

import { Prisma } from '@nexus/database'
import prisma from '../../db.js'
import { decideFleetApproval } from '../agent-fleet/approval-inbox.service.js'
import { runOrQueueTool } from './approval-gate.service.js'
import { runOrigin, type UserPrincipal } from './call-tool.js'

export type UndoClickResult =
  | { ok: true; approvalId: string; tool: string; undoes: string; executeAfter: string }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string; approvalId?: string }

/** The status a refusal of the undo request answers with: not found, not allowed, or not now. */
function statusOf(error: string): 403 | 404 | 409 {
  if (/^Change not found/.test(error)) return 404
  if (/ needs the .+ permissions?\.?$/.test(error)) return 403
  return 409
}

/** Undo one recorded change now, as this person: queue the inverse change and approve it with the click. */
export async function undoChangeByClick(principal: UserPrincipal, changeId: string): Promise<UndoClickResult> {
  const id = changeId.trim()
  if (!id || id.length > 64) return { ok: false, status: 400, error: 'Name the change to undo.' }
  const run = await prisma.agentRun.create({
    data: {
      agentKey: 'manual-action',
      trigger: 'manual',
      status: 'running',
      input: { tool: 'undo-change', args: { changeId: id } } as Prisma.InputJsonValue,
      userId: principal.userId,
      ...runOrigin(principal),
    },
  })
  // forceAsk: the inverse change is always stored as a request, so the click approves it through the window.
  const asked = await runOrQueueTool('undo-change', { changeId: id }, principal, run.id, { forceAsk: true })
  const queued = asked.mode === 'queued' && !!asked.approvalId
  await prisma.agentRun.update({
    where: { id: run.id },
    data: queued
      ? { status: 'done', ok: true, endedAt: new Date(), output: { mode: 'queued', approvalId: asked.approvalId ?? null } }
      : { status: 'failed', ok: false, endedAt: new Date(), errorMessage: asked.error ?? null },
  })
  if (!queued) {
    const error = asked.error ?? 'This change cannot be undone here.'
    return { ok: false, status: statusOf(error), error }
  }
  const approvalId = asked.approvalId!
  const approved = await decideFleetApproval({ id: approvalId, decision: 'approve', actor: principal })
  if (!approved.ok || !approved.executeAfter) {
    // The undo request stays for a person who may approve it; the click could not.
    return {
      ok: false,
      status: approved.code === 'forbidden' ? 403 : 409,
      error: approved.error ?? 'The undo was asked for, but it could not be approved here. It waits in the Approvals page.',
      approvalId,
    }
  }
  const request = await prisma.agentApproval.findUnique({ where: { id: approvalId }, select: { toolName: true } })
  return { ok: true, approvalId, tool: request?.toolName ?? 'unknown', undoes: asked.undoes ?? id, executeAfter: approved.executeAfter }
}
