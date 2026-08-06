/**
 * NAF.E — E2: the exemplar store (spec Part 10). Every operator decision
 * on a fleet approval is minted as a labelled precedent; the most recent
 * five per charter are rendered back into that charter's prompt. This is
 * the cheapest form of "training" the fleet gets — and the reject reason
 * (mandatory at the route) is the highest-value datapoint in the system.
 *
 * Retrieval v1 is recency-first (take 5, newest first). Embedding
 * retrieval stays deferred per A-D6 — with tens of exemplars, recency
 * beats similarity infrastructure.
 */
import type { Prisma } from '@nexus/database'
import prisma from '../../db.js'

export async function mintExemplarFromDecision(
  approvalId: string,
  decision: 'approve' | 'reject',
  reason?: string,
): Promise<string | null> {
  const approval = await prisma.agentApproval.findUnique({
    where: { id: approvalId },
    select: { id: true, toolName: true, args: true, preview: true, agentRunId: true },
  })
  if (!approval) return null
  const run = await prisma.agentRun.findUnique({
    where: { id: approval.agentRunId },
    select: { agentKey: true },
  })
  const created = await prisma.agentExemplar.create({
    data: {
      charterKey: run?.agentKey ?? 'unknown',
      label: decision === 'approve' ? 'accepted' : 'rejected',
      situation: {
        toolName: approval.toolName,
        preview: approval.preview,
      } as Prisma.InputJsonValue,
      proposal: (approval.args ?? {}) as Prisma.InputJsonValue,
      operatorNote: reason ?? null,
    },
  })
  return created.id
}

export interface ExemplarRow {
  label: string
  situation: unknown
  proposal: unknown
  operatorNote: string | null
  createdAt: Date
}

export async function retrieveExemplars(
  charterKey: string,
  limit = 5,
): Promise<ExemplarRow[]> {
  return prisma.agentExemplar.findMany({
    where: { charterKey, active: true },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      label: true,
      situation: true,
      proposal: true,
      operatorNote: true,
      createdAt: true,
    },
  })
}

/** Markdown block for the prompt; empty when there is no precedent —
 *  never a fabricated section. */
export function renderExemplarBlock(exemplars: ExemplarRow[]): string {
  if (exemplars.length === 0) return ''
  const parts = [
    '## Operator precedent (most recent decisions on this desk — align with these)',
  ]
  for (const e of exemplars) {
    const situation = e.situation as { toolName?: string } | null
    parts.push(
      `- ${e.label.toUpperCase()} · ${situation?.toolName ?? 'unknown-tool'} · ${e.createdAt.toISOString().slice(0, 10)}`,
      `  proposal: ${JSON.stringify(e.proposal)}`,
    )
    if (e.operatorNote) parts.push(`  operator: ${e.operatorNote}`)
  }
  return parts.join('\n')
}
