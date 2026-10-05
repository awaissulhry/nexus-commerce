/**
 * MCP full control C8 — "what did Claude do" in one business: every call Claude made (AgentRun via claude), with what
 * became of it — the request it queued (AgentApproval), who decided and how, the change it made (AgentChange), whether
 * that can still be undone, and the marketplace queue rows a price or publish change made.
 *
 * Read by the Settings page (route GET /api/claude/activity, ai.view) and by Claude itself (the read tool
 * claude-activity, ai.view). Previews are shown through the READER's money filter (`storedOutput`): hidden from a
 * person who may not use the tool that made them, money fields stripped for one who may not see them. Arguments are
 * never shown: the preview says what changes. Everything is read in the business the caller is bound to (row-level
 * security): another business's calls are not there.
 *
 * Outcome of a row, in the order it is decided:
 *   read        a read that answered            refused   a call refused before anything ran (or that failed)
 *   preview     a preview-only change           queued    waiting for a person
 *   handed-back approved, then handed back to a person without running (stale, a permission lost, a rule changed)
 *   failed      approved, ran, and the tool said no: waiting for a person again
 *   auto        run (or about to run) by the business's rule     approved   by a person in Nexus
 *   confirmed   confirmed in Claude (C7)        rejected · expired · superseded
 *   undone      it ran, and its undo ran since
 * Filters: a time window, a connection, a tool (the call's, or the change's — an undo asks for the inverse tool), an
 * outcome. The cursor walks the calls newest first: a page with an outcome filter may hold fewer rows than asked, and
 * the last page may be empty; `nextCursor` null means there is nothing older.
 */

import { z } from 'zod'
import { Prisma } from '@nexus/database'
import prisma from '../../db.js'
import { actorLabel } from './call-tool.js'
import { getTool } from './tool-registry.js'
import { channelQueueOf, type ChannelQueue } from './tools/approval.tools.js'
import { PLAN_TOOL } from './tool-types.js'

export const ACTIVITY_OUTCOMES = [
  'read', 'refused', 'preview', 'queued', 'handed-back', 'failed', 'auto', 'approved', 'confirmed', 'rejected',
  'expired', 'superseded', 'undone',
] as const
export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number]

export const ACTIVITY_PAGE_MAX = 100
/** The most calls one page looks at, whatever the filters keep: a page is answered in bounded time. */
const SCAN_MAX = 1000
const BATCH = 100
const LIVE = ['pending', 'scheduled', 'executing']

const moment = z.string().trim().datetime({ offset: true })

/** The filters, as the route's query and the tool's arguments both give them. */
export const ACTIVITY_FILTERS = z.object({
  from: moment.optional().describe('only calls at or after this moment (ISO 8601, e.g. 2026-10-01T00:00:00Z)'),
  to: moment.optional().describe('only calls at or before this moment (ISO 8601)'),
  tool: z.string().trim().min(1).max(64).optional().describe('only calls of this tool, or that changed with it (e.g. set-price: an undo asks for one too)'),
  outcome: z.enum(ACTIVITY_OUTCOMES).optional().describe(
    'only rows with this outcome: read, refused, preview, queued (waits for a person), handed-back (approved, then handed back '
    + 'without running), failed, auto (run by the business\'s rule), approved (by a person), confirmed, rejected, expired, '
    + 'superseded, undone',
  ),
  connectionId: z.string().trim().min(1).max(64).optional().describe('only calls over this Claude connection (its id, as each row names it)'),
  cursor: z.string().trim().min(1).max(200).optional().describe('the nextCursor of the previous page, to read further back'),
  limit: z.coerce.number().int().min(1).max(ACTIVITY_PAGE_MAX).default(25).describe(`rows per page, 1 to ${ACTIVITY_PAGE_MAX} (25 when not given)`),
})
export type ActivityFilters = z.input<typeof ACTIVITY_FILTERS>

/** A filter that cannot be read: the route answers 400 with its message; the tool refuses with it. */
export class ActivityQueryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ActivityQueryError'
  }
}

export type UndoState = 'possible' | 'waiting' | 'done' | 'not possible'

export interface ActivityRow {
  runId: string
  at: string
  who: { userId: string | null; name: string | null }
  connection: { id: string | null; app: string | null }
  /** The tool Claude called. */
  tool: string
  outcome: ActivityOutcome
  /** Why a call was refused, in the words Claude was given; never an internal error. */
  note?: string
  approval?: {
    id: string
    /** The tool of the request (an undo-change call queues the inverse tool). */
    tool: string
    status: string
    requestedAt: string
    decidedBy: string | null
    decidedAt: string | null
    /** nexus (a person) | auto (the business's rule) | claude-confirm; null while nobody decided. */
    decisionVia: string | null
    runsAt: string | null
    expiresAt: string | null
    /** What the system recorded ("not run — …", "execution failed: …"). */
    note: string | null
  }
  change?: {
    id: string
    executedAt: string
    reversibility: string
    undo: UndoState
    undoneAt: string | null
    undoneByApprovalId: string | null
    /** The change was sent on to a marketplace or a buyer. */
    outbound: boolean
  }
  /** For a price or publish change that ran: its marketplace queue rows, by state. */
  channels?: ChannelQueue
  /** C6 — a change plan: how many steps, and how many are done, skipped, failed or still to run. */
  plan?: { steps: number; byStatus: Record<string, number> }
  preview?: unknown
  previewHidden?: string
}

export interface ActivityPage {
  rows: ActivityRow[]
  /** Pass it back as `cursor` for older calls; null when there are none. */
  nextCursor: string | null
}

type Cursor = { at: Date; id: string }

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.at.toISOString(), cursor.id])).toString('base64url')
}

function decodeCursor(raw: string): Cursor {
  try {
    const [at, id] = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as [string, string]
    const date = new Date(at)
    if (typeof id !== 'string' || !id || Number.isNaN(date.getTime())) throw new Error('shape')
    return { at: date, id }
  } catch {
    throw new ActivityQueryError('cursor: not one this list gave out. Start again without it.')
  }
}

const RUN_SELECT = {
  id: true,
  createdAt: true,
  userId: true,
  oauthGrantId: true,
  input: true,
  output: true,
  status: true,
  ok: true,
  errorMessage: true,
  approvals: {
    orderBy: { requestedAt: 'asc' },
    select: {
      id: true, toolName: true, status: true, requestedAt: true, decidedBy: true, decidedAt: true, decisionVia: true,
      executeAfter: true, expiresAt: true, reason: true, preview: true, args: true,
      changes: {
        orderBy: { executedAt: 'desc' },
        take: 1,
        select: { id: true, executedAt: true, reversibility: true, undoneAt: true, undoneByApprovalId: true, outbound: true, toolName: true },
      },
    },
  },
} satisfies Prisma.AgentRunSelect

type RunRow = Prisma.AgentRunGetPayload<{ select: typeof RUN_SELECT }>
type ApprovalRow = RunRow['approvals'][number]
type ChangeRow = ApprovalRow['changes'][number]

const toolOf = (run: RunRow) => String((run.input as { tool?: unknown } | null)?.tool ?? 'unknown')
const modeOf = (run: RunRow) => (run.output as { mode?: unknown } | null)?.mode
const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null)

function outcomeOf(run: RunRow, approval: ApprovalRow | undefined, change: ChangeRow | undefined): ActivityOutcome {
  if (!approval) {
    if (run.status === 'failed' || !run.ok) return 'refused'
    return modeOf(run) === 'preview' ? 'preview' : 'read'
  }
  if (change?.undoneAt) return 'undone'
  const reason = approval.reason ?? ''
  const decided = approval.decisionVia === 'auto' ? 'auto' : approval.decisionVia === 'claude-confirm' ? 'confirmed' : 'approved'
  switch (approval.status) {
    case 'pending':
      if (reason.startsWith('not run')) return 'handed-back'
      if (reason.startsWith('execution failed') || reason.startsWith('execution error')) return 'failed'
      return 'queued'
    case 'scheduled':
    case 'executing':
    case 'executed':
      return decided
    case 'approved':
      return 'approved'
    case 'rejected':
    case 'expired':
    case 'superseded':
      return approval.status
    default:
      return 'queued'
  }
}

/** Whether a recorded change can still be put back (also the approvals grid's drawer, approval-queue.service.ts). */
export function undoStateOf(change: { undoneAt: Date | null; reversibility: string; undoneByApprovalId: string | null; toolName: string }, liveUndos: Set<string>): UndoState {
  if (change.undoneAt) return 'done'
  if (change.reversibility === 'none') return 'not possible'
  if (change.undoneByApprovalId && liveUndos.has(change.undoneByApprovalId)) return 'waiting'
  return getTool(change.toolName)?.undo ? 'possible' : 'not possible'
}

/** The words Claude was given for a refused call; an unexpected failure stays in the log. */
function noteOf(run: RunRow): string | undefined {
  if (run.ok && run.status !== 'failed') return undefined
  if (modeOf(run) === 'crashed') return 'Nexus could not run this tool (an unexpected error; it is in the log). Nothing changed.'
  return run.errorMessage ? run.errorMessage.slice(0, 500) : undefined
}

/** Claude's calls in this business, newest first, with what became of each. */
export async function claudeActivity(
  raw: ActivityFilters,
  storedOutput: (toolName: string, value: unknown) => unknown | null,
): Promise<ActivityPage> {
  const parsed = ACTIVITY_FILTERS.safeParse(raw ?? {})
  if (!parsed.success) {
    throw new ActivityQueryError(parsed.error.issues.map((issue) => `${issue.path.join('.') || 'filters'}: ${issue.message}`).join('; '))
  }
  const filters = parsed.data
  let cursor = filters.cursor ? decodeCursor(filters.cursor) : null

  const base: Prisma.AgentRunWhereInput = {
    via: 'claude',
    ...(filters.from || filters.to
      ? { createdAt: { ...(filters.from ? { gte: new Date(filters.from) } : {}), ...(filters.to ? { lte: new Date(filters.to) } : {}) } }
      : {}),
    ...(filters.connectionId ? { oauthGrantId: filters.connectionId } : {}),
    ...(filters.tool
      ? { OR: [{ input: { path: ['tool'], equals: filters.tool } }, { approvals: { some: { toolName: filters.tool } } }] }
      : {}),
  }

  const kept: Array<{ run: RunRow; approval?: ApprovalRow; change?: ChangeRow; outcome: ActivityOutcome }> = []
  let scanned = 0
  let exhausted = false
  while (kept.length < filters.limit && scanned < SCAN_MAX) {
    const after: Prisma.AgentRunWhereInput = cursor
      ? { OR: [{ createdAt: { lt: cursor.at } }, { createdAt: cursor.at, id: { lt: cursor.id } }] }
      : {}
    const batch = await prisma.agentRun.findMany({
      where: { AND: [base, after] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: BATCH,
      select: RUN_SELECT,
    })
    let consumed = 0
    for (const run of batch) {
      consumed++
      scanned++
      cursor = { at: run.createdAt, id: run.id }
      // One request per call today; a change plan (C6) will add several steps to one request.
      const approval = run.approvals[0]
      // A plan's changes are one per step: the row counts its steps instead (C6).
      const change = approval?.toolName === PLAN_TOOL ? undefined : approval?.changes[0]
      const outcome = outcomeOf(run, approval, change)
      if (!filters.outcome || outcome === filters.outcome) kept.push({ run, approval, change, outcome })
      if (kept.length >= filters.limit) break
    }
    if (batch.length < BATCH && consumed === batch.length) {
      exhausted = true
      break
    }
  }

  const rows = await inWords(kept, storedOutput)
  return { rows, nextCursor: exhausted || !cursor ? null : encodeCursor(cursor) }
}

/** The page's rows in words: who, which app, the change's undo state, the queue rows, the money-filtered preview. */
async function inWords(
  kept: Array<{ run: RunRow; approval?: ApprovalRow; change?: ChangeRow; outcome: ActivityOutcome }>,
  storedOutput: (toolName: string, value: unknown) => unknown | null,
): Promise<ActivityRow[]> {
  const userIds = [...new Set(kept.map(({ run }) => run.userId).filter((id): id is string => !!id))]
  const grantIds = [...new Set(kept.map(({ run }) => run.oauthGrantId).filter((id): id is string => !!id))]
  const undoIds = [...new Set(kept.map(({ change }) => change?.undoneByApprovalId).filter((id): id is string => !!id))]
  const [people, grants, undos] = await Promise.all([
    userIds.length
      ? prisma.userProfile.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, displayName: true } })
      : Promise.resolve([]),
    grantIds.length
      ? prisma.oAuthGrant.findMany({ where: { id: { in: grantIds } }, select: { id: true, client: { select: { clientName: true } } } })
      : Promise.resolve([]),
    undoIds.length
      ? prisma.agentApproval.findMany({ where: { id: { in: undoIds } }, select: { id: true, status: true } })
      : Promise.resolve([]),
  ])
  const nameOf = new Map(people.map((p) => [p.id, actorLabel({ id: p.id, email: p.email, displayName: p.displayName ?? undefined })]))
  const appOf = new Map(grants.map((g) => [g.id, g.client?.clientName ?? null]))
  const liveUndos = new Set(undos.filter((u) => LIVE.includes(u.status)).map((u) => u.id))

  const rows: ActivityRow[] = []
  for (const { run, approval, change, outcome } of kept) {
    const note = noteOf(run)
    const row: ActivityRow = {
      runId: run.id,
      at: run.createdAt.toISOString(),
      who: { userId: run.userId, name: run.userId ? (nameOf.get(run.userId) ?? null) : null },
      connection: { id: run.oauthGrantId, app: run.oauthGrantId ? (appOf.get(run.oauthGrantId) ?? null) : null },
      tool: toolOf(run),
      outcome,
      ...(note && !approval ? { note } : {}),
    }
    if (approval) {
      row.approval = {
        id: approval.id,
        tool: approval.toolName,
        status: approval.status,
        requestedAt: approval.requestedAt.toISOString(),
        decidedBy: approval.decidedBy,
        decidedAt: iso(approval.decidedAt),
        decisionVia: approval.decisionVia,
        runsAt: iso(approval.executeAfter),
        expiresAt: iso(approval.expiresAt),
        note: approval.reason,
      }
      if (change) {
        row.change = {
          id: change.id,
          executedAt: change.executedAt.toISOString(),
          reversibility: change.reversibility,
          undo: undoStateOf(change, liveUndos),
          undoneAt: iso(change.undoneAt),
          undoneByApprovalId: change.undoneByApprovalId,
          outbound: change.outbound,
        }
      }
      if (approval.toolName === PLAN_TOOL) {
        const counts = await prisma.agentPlanStep.groupBy({ by: ['status'], where: { approvalId: approval.id }, _count: { _all: true } })
        const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count._all]))
        row.plan = { steps: Object.values(byStatus).reduce((n, c) => n + c, 0), byStatus }
      } else if (approval.status === 'executed') {
        const args = (approval.args && typeof approval.args === 'object' && !Array.isArray(approval.args) ? approval.args : {}) as Record<string, unknown>
        const channels = await channelQueueOf(approval.toolName, args, approval.decidedAt)
        if (channels) row.channels = channels
      }
      if (approval.preview != null) {
        const visible = storedOutput(approval.toolName, approval.preview)
        row.preview = visible ?? null
        if (visible == null) row.previewHidden = `The preview needs the permissions of ${approval.toolName}.`
      }
    }
    rows.push(row)
  }
  return rows
}
