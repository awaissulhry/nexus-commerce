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
 *
 * AP.4 (the brake): approving parks the action for a 20-second undo window
 * instead of firing it. The decision is durable at once; only the execution
 * waits. Bulk decisions state their blast radius before they run.
 *
 * AP.5 (one clock): `expiresAt` is now the expiry, swept on its own schedule
 * for every tool — see `runApprovalMaintenance`.
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
  // `scheduled` belongs with waiting, not decided: the action has not run and
  // the operator can still take it back, so it must stay where they are
  // looking even after a reload.
  if (view === 'waiting')
    return { status: { in: ['pending', 'scheduled'] }, toolName: { in: FLEET_TOOLS } }
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
}): Promise<{
  ok: boolean
  status?: string
  result?: unknown
  error?: string
  executeAfter?: string
}> {
  // AP.4 — an approve parks for the undo window instead of firing. The
  // decision is recorded immediately (attributable, durable); only the
  // execution waits.
  if (input.decision === 'approve') {
    const parked = await scheduleApproval({ id: input.id, actor: input.actor })
    if (!parked.ok) return parked
    await recordControlChange({
      charterKey: await charterKeyOf(input.id),
      action: 'approve_action',
      to: { approvalId: input.id, status: 'scheduled', executeAfter: parked.executeAfter },
      note: input.reason ?? null,
      actor: input.actor.label,
    }).catch((err) =>
      logger.error('[naf-ap] control audit failed', { id: input.id, error: String(err) }),
    )
    return parked
  }

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
    action: 'reject_action', // approve returned early, above
    to: { approvalId: input.id, status: out.status ?? null },
    note: input.reason ?? null,
    actor: input.actor.label,
  }).catch((err) =>
    logger.error('[naf-ap] control audit failed', { id: input.id, error: String(err) }),
  )

  return out
}

/* ── AP.4: the undo window ─────────────────────────────────────────────── */

/**
 * How long an approved action waits before it runs. Long enough to catch a
 * misclick, short enough that nobody plans around it.
 */
export const UNDO_WINDOW_MS = 20_000

/**
 * Approving no longer executes on the spot. It records the decision — who,
 * when, why — and parks the action for {@link UNDO_WINDOW_MS}. Nothing
 * reaches Amazon inside the window. Either the operator's browser commits it
 * when the window closes, or the maintenance sweep does; the decision is
 * durable the moment it is taken, so closing the tab cannot lose it.
 */
export async function scheduleApproval(input: {
  id: string
  actor: InboxActor
}): Promise<{ ok: boolean; status?: string; executeAfter?: string; error?: string }> {
  const executeAfter = new Date(Date.now() + UNDO_WINDOW_MS)
  // Atomic pending→scheduled claim: two tabs cannot both schedule the same row.
  const claim = await prisma.agentApproval.updateMany({
    where: { id: input.id, status: 'pending' },
    data: {
      status: 'scheduled',
      decidedBy: input.actor.label,
      decidedAt: new Date(),
      executeAfter,
    },
  })
  if (claim.count === 0) {
    const cur = await prisma.agentApproval.findUnique({
      where: { id: input.id },
      select: { status: true },
    })
    return { ok: false, error: cur ? `already ${cur.status}` : 'approval not found' }
  }
  return { ok: true, status: 'scheduled', executeAfter: executeAfter.toISOString() }
}

/**
 * Take it back. Only possible while the action is still parked — once it has
 * run, it has run, and saying otherwise would be the dishonest kind of undo.
 */
export async function undoScheduledApproval(input: {
  id: string
  actor: InboxActor
}): Promise<{ ok: boolean; error?: string }> {
  const undone = await prisma.agentApproval.updateMany({
    where: { id: input.id, status: 'scheduled' },
    data: { status: 'pending', decidedBy: null, decidedAt: null, executeAfter: null },
  })
  if (undone.count === 0) {
    const cur = await prisma.agentApproval.findUnique({
      where: { id: input.id },
      select: { status: true },
    })
    return {
      ok: false,
      error:
        cur?.status && cur.status !== 'pending'
          ? `too late — this action is already ${cur.status}`
          : 'nothing to undo',
    }
  }
  await recordControlChange({
    charterKey: await charterKeyOf(input.id),
    action: 'undo_approval',
    to: { approvalId: input.id },
    note: 'taken back inside the undo window',
    actor: input.actor.label,
  }).catch((err) => logger.error('[naf-ap] audit failed', { error: String(err) }))
  return { ok: true }
}

/**
 * Run a parked action whose window has closed. The `executeAfter` guard is
 * enforced HERE, so a client that calls early is refused rather than trusted.
 */
export async function commitScheduledApproval(
  id: string,
): Promise<{ ok: boolean; status?: string; error?: string }> {
  const ap = await prisma.agentApproval.findUnique({
    where: { id },
    select: { status: true, executeAfter: true, decidedBy: true },
  })
  if (!ap) return { ok: false, error: 'approval not found' }
  if (ap.status !== 'scheduled') return { ok: false, error: `not scheduled (${ap.status})` }
  if (ap.executeAfter && ap.executeAfter > new Date()) {
    return { ok: false, error: 'still inside the undo window' }
  }

  // Hand back to the gate, which owns execution. It expects `pending`, so
  // release the park atomically — if that loses a race, someone else has it.
  const release = await prisma.agentApproval.updateMany({
    where: { id, status: 'scheduled' },
    data: { status: 'pending', executeAfter: null },
  })
  if (release.count === 0) return { ok: false, error: 'already taken' }

  const actorLabel = ap.decidedBy ?? 'unattributed'
  const out = await decideApproval(id, 'approve', actorLabel)
  if (!out.ok) return out

  await mintExemplarFromDecision(id, 'approve').catch((err) =>
    logger.error('[naf-ap] exemplar minting failed', { id, error: String(err) }),
  )
  await recordControlChange({
    charterKey: await charterKeyOf(id),
    action: 'approve_action',
    to: { approvalId: id, status: out.status ?? null },
    actor: actorLabel,
  }).catch((err) => logger.error('[naf-ap] control audit failed', { id, error: String(err) }))

  return out
}

/* ── AP.5: one expiry clock ────────────────────────────────────────────── */

/**
 * The single maintenance pass over the approval queue.
 *
 * Before this, `expiresAt` was written on every approval at creation and read
 * by NOTHING; the only expiry lived inside the weekly council, keyed on a
 * different column against a different constant, restricted to fleet tools —
 * and the council has run twice in its life. So a non-fleet approval never
 * expired and a fleet one expired by weekly accident.
 *
 * Now: `expiresAt` is the clock, every tool is covered, and this runs on its
 * own schedule instead of riding an agent job.
 */
export async function runApprovalMaintenance(): Promise<{
  expired: number
  committed: number
  failed: number
}> {
  const now = new Date()

  const expired = await prisma.agentApproval.updateMany({
    where: { status: 'pending', expiresAt: { not: null, lt: now } },
    data: { status: 'expired' },
  })

  const due = await prisma.agentApproval.findMany({
    where: { status: 'scheduled', executeAfter: { not: null, lte: now } },
    select: { id: true },
    take: 100,
  })
  let committed = 0
  let failed = 0
  for (const d of due) {
    const out = await commitScheduledApproval(d.id).catch((err) => {
      logger.error('[naf-ap] commit threw', { id: d.id, error: String(err) })
      return { ok: false as const }
    })
    if (out.ok) committed++
    else failed++
  }

  if (expired.count || committed || failed) {
    logger.info('[naf-ap] approval maintenance', {
      expired: expired.count,
      committed,
      failed,
    })
  }
  return { expired: expired.count, committed, failed }
}

/* ── AP.4: bulk, with the blast radius stated ──────────────────────────── */

export interface BulkPreview {
  count: number
  /** One sentence naming what this will do, before it does it. */
  sentence: string
  byTool: Record<string, number>
  highRisk: number
  irreversible: number
}

const IRREVERSIBLE_TOOLS = ['send-customer-message']

/**
 * What a bulk decision is about to do, in a sentence. Built server-side from
 * the rows themselves, so the confirmation cannot drift from the action.
 */
export async function previewBulk(
  ids: string[],
  decision: 'approve' | 'reject',
): Promise<BulkPreview> {
  const rows = await prisma.agentApproval.findMany({
    where: { id: { in: ids }, status: 'pending' },
    select: { toolName: true, riskTier: true },
  })
  const byTool: Record<string, number> = {}
  for (const r of rows) byTool[r.toolName] = (byTool[r.toolName] ?? 0) + 1
  const highRisk = rows.filter((r) => r.riskTier === 'high').length
  const irreversible = rows.filter((r) => IRREVERSIBLE_TOOLS.includes(r.toolName)).length

  const kinds = Object.entries(byTool)
    .map(([tool, n]) => `${n} × ${tool.replace(/-/g, ' ')}`)
    .join(', ')
  const verb = decision === 'approve' ? 'approves' : 'rejects'
  const tail =
    decision === 'approve'
      ? highRisk > 0
        ? ` — ${highRisk} of them high risk. You have 20 seconds to take it back.`
        : ' You have 20 seconds to take it back.'
      : ''
  return {
    count: rows.length,
    sentence: rows.length === 0 ? 'Nothing is selected.' : `This ${verb} ${rows.length} action${rows.length === 1 ? '' : 's'}: ${kinds}.${tail}`,
    byTool,
    highRisk,
    irreversible,
  }
}

export async function bulkDecide(input: {
  ids: string[]
  decision: 'approve' | 'reject'
  reason?: string
  actor: InboxActor
}): Promise<{ ok: true; done: number; of: number; failed: string[] }> {
  const failed: string[] = []
  let done = 0
  for (const id of input.ids) {
    const out = await decideFleetApproval({
      id,
      decision: input.decision,
      reason: input.reason,
      actor: input.actor,
    })
    if (out.ok) done++
    else failed.push(out.error ?? id)
  }
  return { ok: true, done, of: input.ids.length, failed }
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
