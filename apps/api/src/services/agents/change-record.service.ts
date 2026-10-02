/**
 * MCP full control C2 — the change record (AgentChange) and the undo request built from it.
 *
 *   record   when an approval's `execute` succeeds, the gate stores what it changed (`ToolResult.change`: before →
 *            after), the door the request came through, who it ran as, the tool's reversibility and the request
 *            that would put it back. One row per executed approval. A change that ran as the undo of another
 *            marks that one undone.
 *   undo     `undo-change` (tools/control.tools.ts) reads a row and builds the inverse request with the tool's own
 *            `undo`. It is refused while what is stored now is no longer `after` (someone changed it since: undo
 *            would overwrite that), while another undo of it waits, and once it is undone. The gate then queues the
 *            request as a NEW change of the inverse tool (approval-gate.service.ts): its permissions, preview,
 *            approval, staleness check and audit are that tool's own.
 *
 * Every read and write here is business-scoped by the row-level policy: a change of another business is not found.
 *
 * C8 — the record and its events are written together (one transaction): agent.change.executed for the change,
 * agent.change.undone for the change it put back. Ids and names only.
 *
 * C6 — a change plan: each step's change is its own row (planStepId), and a step of an undo plan marks undone only the
 * change IT puts back. The undo of a plan is one plan of the inverse steps, in reverse order of how they ran.
 */

import { Prisma } from '@nexus/database'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { publishEvent } from '../../lib/events/publish.js'
import { getTool } from './tool-registry.js'
import { PLAN_TOOL, type AgentTool, type PlanRequest, type ToolChange, type ToolDoor, type ToolRequest, type ToolResult } from './tool-types.js'

/** Approval states in which an undo request is still alive: a second one is refused meanwhile. */
const LIVE_STATUSES = ['pending', 'scheduled', 'executing']

/** One text per value whatever the order of its keys (jsonb re-orders them), for comparing what is stored. */
function canonical(value: unknown): string {
  const plain = JSON.stringify(value ?? null)
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]))
        : v
  return JSON.stringify(sorted(JSON.parse(plain)))
}

const shown = (value: unknown) => {
  const text = JSON.stringify(value ?? null)
  return text.length > 80 ? `${text.slice(0, 79)}…` : text
}

/**
 * Where what is stored now differs from what the change wrote, in words: up to five places, each "what it wrote,
 * what is there now". A key of a map that is a product id is named by its SKU when the change kept one.
 */
function movedSince(after: unknown, now: unknown, labels: Record<string, string>): string {
  const lines: string[] = []
  const walk = (a: unknown, b: unknown, path: string[]) => {
    if (canonical(a) === canonical(b) || lines.length >= 5) return
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b) && path.length < 2) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        walk((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], [...path, labels[key] ?? key])
      }
      return
    }
    lines.push(`${path.join(' ') || 'the value'}: it wrote ${shown(a)}, it is now ${shown(b)}`)
  }
  walk(after, now, [])
  return lines.join('; ')
}

/** The SKUs a change kept beside product ids (`before.skus`), to name products in a sentence. */
function labelsOf(change: ToolChange): Record<string, string> {
  const skus = (change.before as { skus?: unknown } | null)?.skus
  return skus && typeof skus === 'object' ? (skus as Record<string, string>) : {}
}

export interface RecordInput {
  approvalId: string
  tool: AgentTool
  raw: ToolResult
  /** The door the request came through (AgentRun of the approval). */
  via: ToolDoor
  oauthGrantId: string | null
  /** The person it ran as; null for a system run. */
  executedByUserId: string | null
  /** C8 — who decided it (AgentApproval.decisionVia): nexus | auto | claude-confirm; null when not recorded. */
  decisionVia?: string | null
  /** C6 — the plan step this change ran as. */
  planStepId?: string | null
  /** C6 — a step of an undo plan: the one change it puts back (the plan's other changes are not undone by it). */
  undoesChangeId?: string | null
}

/**
 * Store what an executed approval changed, and mark undone the change it put back (if it was an undo). Called by
 * the gate after the approval is marked executed: a failure here is logged and never runs the change again.
 */
export async function recordExecutedChange(input: RecordInput): Promise<string | null> {
  const { tool, raw } = input
  const change = raw.change
  let undo: ToolRequest | null = null
  if (change && tool.undo) {
    // The planned undo is kept for a person to read; the record itself never depends on it.
    try {
      const built = tool.undo.request(change)
      if (!('refusal' in built)) undo = built
    } catch (error) {
      logger.warn('[agent-change] could not plan the undo of a change', { tool: tool.name, error: String(error) })
    }
  }
  return prisma.$transaction(async (tx) => {
    const row = await tx.agentChange.create({
      data: {
        approvalId: input.approvalId,
        toolName: tool.name,
        via: input.via,
        oauthGrantId: input.oauthGrantId,
        executedByUserId: input.executedByUserId,
        ...(input.planStepId ? { planStepId: input.planStepId } : {}),
        reversibility: tool.reversibility ?? 'none',
        ...(change ? { before: (change.before ?? null) as Prisma.InputJsonValue, after: (change.after ?? null) as Prisma.InputJsonValue } : {}),
        ...(undo ? { undoTool: undo.tool, undoArgs: undo.args as Prisma.InputJsonValue } : {}),
        outbound: !!tool.openWorld,
      },
      select: { id: true },
    })
    // This approval may have been the undo of an earlier change: that one is undone now. A step of an undo plan undoes
    // only its own target; the plan's other targets wait for their own steps.
    const undone = input.planStepId
      ? input.undoesChangeId
        ? await tx.agentChange.findMany({ where: { id: input.undoesChangeId, undoneAt: null }, select: { id: true } })
        : []
      : await tx.agentChange.findMany({ where: { undoneByApprovalId: input.approvalId, undoneAt: null }, select: { id: true } })
    if (undone.length) {
      await tx.agentChange.updateMany({ where: { id: { in: undone.map((u) => u.id) }, undoneAt: null }, data: { undoneAt: new Date() } })
    }
    await publishEvent(tx, 'agent.change.executed', {
      changeId: row.id,
      approvalId: input.approvalId,
      tool: tool.name,
      via: input.via,
      decisionVia: input.decisionVia ?? null,
    })
    for (const earlier of undone) {
      await publishEvent(tx, 'agent.change.undone', { changeId: earlier.id, undoneByApprovalId: input.approvalId })
    }
    return row.id
  })
}

/** `recordExecutedChange`, never failing the decision that already ran. The change's id, or null when not recorded. */
export async function recordExecutedChangeSafely(input: RecordInput): Promise<string | null> {
  try {
    return await recordExecutedChange(input)
  } catch (error) {
    logger.error('[agent-change] could not record an executed change', {
      approvalId: input.approvalId,
      tool: input.tool.name,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

export type UndoAnswer =
  | { error: string }
  | {
      request: ToolRequest & { undoes: string }
      preview: Record<string, unknown>
    }
  | {
      /** C6 — the undo of a plan: one plan of the inverse steps, in reverse order; `undoes` aligned with the steps. */
      plan: PlanRequest & { undoes: string[] }
      preview: Record<string, unknown>
    }

const NOTHING = 'Nothing was queued.'

/** The change a caller names: by its id, or the change of an approval (one per approval until plans exist). */
async function findChange(ref: { changeId?: string; approvalId?: string }) {
  if (ref.changeId) return prisma.agentChange.findUnique({ where: { id: ref.changeId } })
  const rows = await prisma.agentChange.findMany({ where: { approvalId: ref.approvalId }, orderBy: { executedAt: 'desc' }, take: 2 })
  if (rows.length > 1) return 'many' as const
  return rows[0] ?? null
}

/**
 * The request that undoes a change, or why it cannot be undone now. A pure read: it queues nothing (the gate does,
 * from the control tool's `request`), and it reads only in the caller's business.
 */
export async function undoRequestFor(ref: { changeId?: string; approvalId?: string }): Promise<UndoAnswer> {
  if (!ref.changeId && !ref.approvalId) return { error: `Name the change to undo: changeId or approvalId. ${NOTHING}` }
  if (!ref.changeId && ref.approvalId) {
    const asked = await prisma.agentApproval.findUnique({ where: { id: ref.approvalId }, select: { toolName: true, args: true } })
    if (asked?.toolName === PLAN_TOOL) return planUndo(ref.approvalId, (asked.args as { title?: unknown } | null)?.title)
  }
  const row = await findChange(ref)
  if (row === 'many') return { error: `That approval made several changes; name one by its changeId. ${NOTHING}` }
  if (!row) {
    return {
      error: ref.changeId
        ? `Change not found. ${NOTHING}`
        : `No change was recorded for that approval: it has not run, or it ran before changes were recorded. ${NOTHING}`,
    }
  }
  if (row.undoneAt) {
    return { error: `This change was already undone (by approval ${row.undoneByApprovalId ?? 'unknown'}). ${NOTHING}` }
  }
  if (row.undoneByApprovalId) {
    const waiting = await prisma.agentApproval.findUnique({ where: { id: row.undoneByApprovalId }, select: { status: true } })
    if (waiting && LIVE_STATUSES.includes(waiting.status)) {
      return {
        error: `An undo of this change is already waiting: approval ${row.undoneByApprovalId} (${waiting.status}). ` +
          `Follow it with approval-status. ${NOTHING}`,
      }
    }
  }
  const tool = getTool(row.toolName)
  if (row.reversibility === 'none' || tool?.reversibility === 'none') {
    return { error: `${row.toolName} cannot be undone: what it did cannot be taken back. ${NOTHING}` }
  }
  if (!tool?.undo) {
    return { error: `A change made by ${row.toolName} cannot be undone here yet: change it back in Nexus, or ask for the opposite change. ${NOTHING}` }
  }
  if (row.before == null || row.after == null) {
    return { error: `This change kept no record of the value it replaced, so it cannot be undone here. ${NOTHING}` }
  }
  const change: ToolChange = { before: row.before, after: row.after }

  // Compare-and-swap, first half: undo only while what is stored is still what the change wrote. The second half is
  // the gate's own staleness check when the undo runs (the inverse preview's starting values must not move).
  const now = await tool.undo.current(change)
  if (canonical(now) !== canonical(change.after)) {
    return {
      error: `Not undone: it has changed since this change ran — ${movedSince(change.after, now, labelsOf(change))}. ` +
        `Undo would overwrite that later change. ${NOTHING}`,
    }
  }
  const built = tool.undo.request(change)
  if ('refusal' in built) return { error: `${built.refusal} ${NOTHING}` }
  return {
    request: { ...built, undoes: row.id },
    preview: {
      action: 'undo-change',
      changeId: row.id,
      undoes: { tool: row.toolName, approvalId: row.approvalId, executedAt: row.executedAt, reversibility: row.reversibility },
      asks: built,
      note:
        `Asks for a new ${built.tool} change that puts back what ${row.toolName} replaced. It waits for a person like any ` +
        'change, and is refused when it runs if the value moved again meanwhile.',
    },
  }
}

/**
 * C6 — the undo of a plan: the inverse of every step that ran, as ONE plan, newest first (the last change is put back
 * first). Every step's undo is checked now, exactly as for a single change; one that cannot be undone stops the whole
 * plan's undo (a partial undo would leave a mix nobody approved), and says which.
 */
async function planUndo(approvalId: string, title: unknown): Promise<UndoAnswer> {
  const ran = await prisma.agentPlanStep.findMany({
    where: { approvalId, status: 'done', changeId: { not: null } },
    orderBy: { position: 'desc' },
    select: { position: true, toolName: true, changeId: true },
  })
  if (!ran.length) return { error: `No step of that plan has run, so there is nothing to undo. ${NOTHING}` }
  const steps: ToolRequest[] = []
  const undoes: string[] = []
  const refused: string[] = []
  const refusedSteps: number[] = []
  for (const step of ran) {
    const one = await undoRequestFor({ changeId: step.changeId! })
    if ('error' in one) {
      refusedSteps.push(step.position)
      refused.push(`step ${step.position} (${step.toolName}): ${one.error.replace(` ${NOTHING}`, '')}`)
    }
    else if ('request' in one) {
      steps.push({ tool: one.request.tool, args: one.request.args })
      undoes.push(one.request.undoes)
    }
  }
  if (refused.length) {
    // Every step that cannot be put back is named; the reasons of the first five follow.
    const named = refusedSteps.length === 1
      ? `step ${refusedSteps[0]}`
      : `steps ${refusedSteps.slice(0, -1).join(', ')} and ${refusedSteps[refusedSteps.length - 1]}`
    return {
      error:
        `The plan cannot be undone as a whole: ${named} cannot be put back — ${refused.slice(0, 5).join('; ')}` +
        `${refused.length > 5 ? `; and ${refused.length - 5} more` : ''}. ${NOTHING}`,
    }
  }
  const name = typeof title === 'string' && title.trim() ? title.trim() : 'a change plan'
  return {
    plan: { title: `Undo: ${name}`.slice(0, 120), steps, undoes },
    preview: {
      action: 'undo-change',
      undoesPlan: approvalId,
      steps: steps.length,
      note:
        `Asks for ONE new plan of ${steps.length} change${steps.length === 1 ? '' : 's'} that put back what the plan replaced, the last ` +
        'change first. It waits for a person like any plan, and each step is refused when it runs if its value moved again meanwhile.',
    },
  }
}

/**
 * Tie a queued undo request to its change — only while the change is not undone and no other undo of it is alive
 * (compare-and-set on what was read). False when another undo won the race.
 */
export async function linkUndoRequest(changeId: string, approvalId: string): Promise<boolean> {
  const row = await prisma.agentChange.findUnique({ where: { id: changeId }, select: { undoneAt: true, undoneByApprovalId: true } })
  if (!row || row.undoneAt) return false
  if (row.undoneByApprovalId && row.undoneByApprovalId !== approvalId) {
    const other = await prisma.agentApproval.findUnique({ where: { id: row.undoneByApprovalId }, select: { status: true } })
    if (other && LIVE_STATUSES.includes(other.status)) return false
  }
  const linked = await prisma.agentChange.updateMany({
    where: { id: changeId, undoneAt: null, undoneByApprovalId: row.undoneByApprovalId },
    data: { undoneByApprovalId: approvalId },
  })
  return linked.count === 1
}
