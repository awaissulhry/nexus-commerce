/**
 * MCP.7 — what became of a change that waits for a person's decision.
 *
 * Claude cannot approve anything (D1 = A): a change it asks for is queued, and a person decides
 * in the Nexus Approvals page. `approval-status` lets it follow up. It reads approvals of the
 * caller's own business only (call-tool.ts binds it, the row-level policy holds it), and shows
 * the stored preview only to a caller who may use the tool that made it, filtered for money.
 */

import prisma from '../../../db.js'
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool } from '../tool-types.js'

/** Each stored status, said plainly: the model repeats it to a person. */
const MEANING: Record<string, string> = {
  pending: 'Waiting for a person to approve or reject it in Nexus. Nothing has changed yet.',
  scheduled: 'Approved. It runs when the short undo window closes.',
  executing: 'Approved, and running now.',
  executed: 'Approved and done.',
  approved: 'Approved. This tool only previews, so nothing ran.',
  rejected: 'A person rejected it. Nothing changed.',
  expired: 'Nobody decided in time. Nothing changed.',
  superseded: 'A person replaced it with an edited request.',
}

const approvalStatus: AgentTool = {
  name: 'approval-status',
  title: 'Approval status',
  input: z.object({ approvalId: z.string().min(1).describe('the approvalId a change tool returned') }),
  requires: [F.aiView],
  category: 'approvals',
  riskTier: 'low',
  readOnly: true,
  description:
    'Check a change that was queued for approval: whether a person approved or rejected it, when, and when it expires.',
  async handler(args, ctx) {
    const id = String(args.approvalId ?? '')
    if (!id) return { ok: false, error: 'approvalId is required' }
    const ap = await prisma.agentApproval.findUnique({
      where: { id },
      select: {
        id: true,
        toolName: true,
        status: true,
        requestedAt: true,
        expiresAt: true,
        decidedAt: true,
        decidedBy: true,
        executeAfter: true,
        reason: true,
        preview: true,
      },
    })
    if (!ap) return { ok: false, error: 'Approval not found' }
    const preview = ap.preview == null ? null : (ctx.storedOutput?.(ap.toolName, ap.preview) ?? null)
    return {
      ok: true,
      data: {
        approvalId: ap.id,
        tool: ap.toolName,
        status: ap.status,
        meaning: MEANING[ap.status] ?? null,
        requestedAt: ap.requestedAt,
        expiresAt: ap.expiresAt,
        decidedAt: ap.decidedAt,
        decidedBy: ap.decidedBy,
        runsAt: ap.executeAfter,
        note: ap.reason,
        preview,
        ...(ap.preview != null && preview === null
          ? { previewHidden: `The preview needs the permissions of ${ap.toolName}.` }
          : {}),
      },
    }
  },
}

export const APPROVAL_TOOLS: AgentTool[] = [approvalStatus]
