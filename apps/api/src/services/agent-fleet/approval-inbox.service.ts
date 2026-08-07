/**
 * NAF.AP.1–AP.3 — the approval inbox.
 *
 * AP.1 (attribution): a decision names the person who took it. The route
 * used to pass the literal string `'operator'` for every decision while the
 * signed-in user sat on the request, so `decidedBy` was null-or-meaningless
 * on all 18 approvals in the database. Every decision now also writes to
 * `AgentControlAudit` (AC.7's table) — the EU AI Act posture the spec
 * commits to is only real if that record exists.
 *
 * AP.2 (memory): the inbox used to query `status='pending'` and nothing
 * else, so eighteen decisions with fifteen written reasons were invisible.
 * It now serves three views — waiting, decided, expired — with counts.
 *
 * Waiting stays fleet-tools-only, exactly as before: a pre-fleet approval is
 * not something this page can act on. Decided and expired include the
 * pre-fleet history, flagged, because the decision timeline already shows it
 * and two panels must not disagree about the same past (operator call
 * 2026-08-07).
 */
import prisma from '../../db.js'
import { decideApproval } from '../agents/approval-gate.service.js'
import { recordControlChange } from './control-audit.service.js'
import { mintExemplarFromDecision } from './exemplar.service.js'
import { logger } from '../../utils/logger.js'

/** The tools the fleet's own workers may propose. */
export const FLEET_TOOLS = ['create-negative-keyword', 'graduate-keyword', 'set-target-bid']

export type InboxView = 'waiting' | 'decided' | 'expired'

/** `executing` is a transient claim inside approve; it belongs with decided. */
const DECIDED_STATUSES = ['approved', 'executed', 'rejected', 'executing']

export interface InboxActor {
  /** What gets stored and shown. A name if we have one, never a bare id. */
  label: string
  userId: string | null
}

/**
 * Who is taking this decision. `req.authUser` is populated by the RBAC hook
 * from the session; the previous code ignored it entirely.
 */
export function resolveActor(authUser?: {
  id?: string
  email?: string
  displayName?: string
}): InboxActor {
  if (!authUser?.id) {
    // Honest fallback. Never claim a person took a decision we cannot
    // attribute — "operator" written unconditionally is what produced 18
    // unattributable rows.
    return { label: 'unattributed', userId: null }
  }
  return {
    label: authUser.displayName?.trim() || authUser.email || authUser.id,
    userId: authUser.id,
  }
}

/* ── reading ───────────────────────────────────────────────────────────── */

function whereFor(view: InboxView) {
  if (view === 'waiting') return { status: 'pending', toolName: { in: FLEET_TOOLS } }
  if (view === 'expired') return { status: 'expired' }
  return { status: { in: DECIDED_STATUSES } }
}

export interface InboxCounts {
  waiting: number
  decided: number
  expired: number
}

export async function inboxCounts(): Promise<InboxCounts> {
  const [waiting, decided, expired] = await Promise.all([
    prisma.agentApproval.count({ where: whereFor('waiting') }),
    prisma.agentApproval.count({ where: whereFor('decided') }),
    prisma.agentApproval.count({ where: whereFor('expired') }),
  ])
  return { waiting, decided, expired }
}

export async function listInbox(view: InboxView, limit = 100) {
  const approvals = await prisma.agentApproval.findMany({
    where: whereFor(view),
    orderBy: view === 'waiting' ? { requestedAt: 'asc' } : { decidedAt: 'desc' },
    take: Math.min(limit, 200),
  })
  const runs = await prisma.agentRun.findMany({
    where: { id: { in: approvals.map((a) => a.agentRunId) } },
    select: { id: true, agentKey: true, orchestrationId: true },
  })
  const runById = new Map(runs.map((r) => [r.id, r]))

  return approvals.map((a) => ({
    ...a,
    charterKey: runById.get(a.agentRunId)?.agentKey ?? null,
    orchestrationId: runById.get(a.agentRunId)?.orchestrationId ?? null,
    /**
     * False for the pre-fleet ACP approvals. The UI labels those rather than
     * hiding them — see the header note.
     */
    isFleet: FLEET_TOOLS.includes(a.toolName),
  }))
}

/* ── deciding ──────────────────────────────────────────────────────────── */

/** The charter an approval belongs to, for the audit row. */
async function charterKeyOf(approvalId: string): Promise<string> {
  const ap = await prisma.agentApproval.findUnique({
    where: { id: approvalId },
    select: { agentRun: { select: { agentKey: true } } },
  })
  return ap?.agentRun?.agentKey ?? 'unknown'
}

/**
 * One decision, attributed and audited. Exemplar minting and the audit write
 * are both best-effort: the decision has already committed, and failing it
 * after the fact would be worse than a missing side record.
 */
export async function decideFleetApproval(input: {
  id: string
  decision: 'approve' | 'reject'
  reason?: string
  actor: InboxActor
}): Promise<{ ok: boolean; status?: string; result?: unknown; error?: string }> {
  const charterKey = await charterKeyOf(input.id)

  const out = await decideApproval(
    input.id,
    input.decision,
    input.actor.label,
    input.reason || undefined,
  )
  if (!out.ok) return out

  await mintExemplarFromDecision(input.id, input.decision, input.reason || undefined).catch(
    (err) => logger.error('[naf-ap] exemplar minting failed', { id: input.id, error: String(err) }),
  )

  // `recordControlChange` swallows its own errors by contract — but the
  // decision has already committed, so this call must not be able to fail it
  // even if that contract changes underneath us.
  await recordControlChange({
    charterKey,
    action: input.decision === 'approve' ? 'approve_action' : 'reject_action',
    to: { approvalId: input.id, status: out.status ?? null },
    note: input.reason ?? null,
    actor: input.actor.label,
  }).catch((err) =>
    logger.error('[naf-ap] control audit failed', { id: input.id, error: String(err) }),
  )

  return out
}

export async function rejectAllForCharter(input: {
  charterKey: string
  reason: string
  actor: InboxActor
}): Promise<{ ok: true; rejected: number; of: number }> {
  const runs = await prisma.agentRun.findMany({
    where: { agentKey: input.charterKey },
    select: { id: true },
  })
  const pending = await prisma.agentApproval.findMany({
    where: {
      status: 'pending',
      toolName: { in: FLEET_TOOLS },
      agentRunId: { in: runs.map((r) => r.id) },
    },
    select: { id: true },
  })
  let rejected = 0
  for (const p of pending) {
    const out = await decideFleetApproval({
      id: p.id,
      decision: 'reject',
      reason: input.reason,
      actor: input.actor,
    })
    if (out.ok) rejected++
  }
  return { ok: true, rejected, of: pending.length }
}
