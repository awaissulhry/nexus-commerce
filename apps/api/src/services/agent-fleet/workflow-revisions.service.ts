/**
 * NAF.WF.2 — workflow revisions, mirroring charter-revisions.service.ts
 * byte-for-byte in contract: revisions are immutable (editing writes a NEW
 * revision), activation moves a pointer, every activation supersedes its
 * predecessor with a timestamp, and revert-to-built-in supersedes everything
 * and activates nothing — which is why it can never fail. Two versioning
 * grammars in one fleet would teach the operator two different lies; this is
 * deliberately the same one the charters already taught.
 */

import prisma from '../../db.js'
import type { Prisma } from '@nexus/database'

export interface WorkflowRevisionRow {
  id: string
  workflowKey: string
  revision: number
  definition: Prisma.JsonValue
  note: string
  author: string | null
  createdAt: Date
  activatedAt: Date | null
  supersededAt: Date | null
}

export async function listWorkflowRevisions(workflowKey: string): Promise<WorkflowRevisionRow[]> {
  return prisma.agentWorkflowRevision.findMany({
    where: { workflowKey },
    orderBy: { revision: 'desc' },
    take: 50,
  })
}

export async function getActiveWorkflowRevision(
  workflowKey: string,
): Promise<WorkflowRevisionRow | null> {
  return prisma.agentWorkflowRevision.findFirst({
    where: { workflowKey, activatedAt: { not: null }, supersededAt: null },
    orderBy: { activatedAt: 'desc' },
  })
}

/** Never auto-activates — a draft is a draft until someone says otherwise. */
export async function createWorkflowRevision(input: {
  workflowKey: string
  definition: Prisma.InputJsonValue
  note: string
  author?: string | null
}): Promise<WorkflowRevisionRow> {
  if (!input.note.trim()) throw new Error('a revision needs a note — the change log IS the audit')
  const last = await prisma.agentWorkflowRevision.findFirst({
    where: { workflowKey: input.workflowKey },
    orderBy: { revision: 'desc' },
    select: { revision: true },
  })
  return prisma.agentWorkflowRevision.create({
    data: {
      workflowKey: input.workflowKey,
      revision: (last?.revision ?? 0) + 1,
      definition: input.definition,
      note: input.note.trim(),
      author: input.author ?? null,
    },
  })
}

/** Supersede-all-then-point. Null if the revision belongs to another workflow. */
export async function activateWorkflowRevision(
  workflowKey: string,
  revisionId: string,
): Promise<WorkflowRevisionRow | null> {
  const target = await prisma.agentWorkflowRevision.findUnique({ where: { id: revisionId } })
  if (!target || target.workflowKey !== workflowKey) return null
  const now = new Date()
  await prisma.agentWorkflowRevision.updateMany({
    where: { workflowKey, activatedAt: { not: null }, supersededAt: null },
    data: { supersededAt: now },
  })
  return prisma.agentWorkflowRevision.update({
    where: { id: revisionId },
    data: { activatedAt: now, supersededAt: null },
  })
}

/** Supersede everything, activate nothing — always one click, cannot fail. */
export async function revertWorkflowToBuiltin(workflowKey: string): Promise<{ superseded: number }> {
  const res = await prisma.agentWorkflowRevision.updateMany({
    where: { workflowKey, activatedAt: { not: null }, supersededAt: null },
    data: { supersededAt: new Date() },
  })
  return { superseded: res.count }
}
