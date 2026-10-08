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
 *
 * MCP full control C5: a decision says who took it (`decisionVia`): a person in Nexus, or the business's rule for a
 * change Claude asked for (auto: scheduled as the person who asked, through the same window and commit). At commit, a
 * rule-run goes back to a person if the business paused Claude's rule-runs or lowered the tool's level meanwhile; a
 * rule-run that is stale or fails counts towards the automatic pause (claude-trust.service.ts). ADS AUTONOMY AA-W2-3:
 * a strategy-bound one is also judged again on the fresh dry run the staleness check makes (the ads strategy and the
 * day's counts as they are when it runs), and goes back to a person as `rule_refused` when that is outside.
 *
 * MCP full control C6: a change plan (toolName submit-change-plan) is approved once by a person who holds the
 * permissions of every step; after the window the commit hands it to the plan worker (change-plan.service.ts), which
 * re-checks each step; the sweep re-enqueues, or runs, a plan nobody runs.
 *
 * ADS AUTONOMY W1-3: a request whose preview (or a plan step's) carries `stepUp` — a raise of the ads strategy — is
 * approved only by a person with settings.security.manage who types their fresh authenticator code (decisionVia
 * `nexus-step-up`); nothing spends the code that the approve would refuse anyway. A bulk approve leaves such a request
 * out and says why. The tool's own `execute` checks the decision again (agents/step-up-approval.ts).
 */
import { FEATURES as F } from '@nexus/shared/permissions'
import prisma from '../../db.js'
import { hasPermission } from '../../lib/auth/rbac.js'
import { decideApproval, EXPIRY_HOURS } from '../agents/approval-gate.service.js'
import { getTool } from '../agents/tool-registry.js'
import type { Reversibility } from '../agents/tool-types.js'
import {
  actorLabel,
  approvableToolNames,
  callTool,
  missingPermissions,
  permissionMessage,
  requestPrincipal,
  systemPrincipal,
  ToolAccessError,
  type ToolPrincipal,
  type UserPrincipal,
} from '../agents/call-tool.js'
import type { FastifyRequest } from 'fastify'
import { recordControlChange, type ControlAction } from './control-audit.service.js'
import { mintExemplarFromDecision } from './exemplar.service.js'
import { logger } from '../../utils/logger.js'
import { resolvePermissions, type ResolvedPermissions } from '../../lib/auth/rbac.js'
import { WorkspaceError, type WorkspaceContext } from '../../lib/workspace-context.js'
import { createWorkspaceService } from '../workspace.service.js'
import { autoCommitRefusal, autoFreshRefusal, autoPlanCommitRefusal, mayRaise, noteAutoFailure, type RaiseWords } from '../agents/claude-trust.service.js'
import { drainPlans, enqueuePlan } from '../agents/change-plan.service.js'
import { approvalStepUp, stepUpOf, type StepUp } from '../agents/step-up-approval.js'
import { PLAN_TOOL } from '../agents/tool-types.js'
import type { QueueBulkResult } from '@nexus/shared/approval-queue'
import { BULK_MAX_IDS, bulkApproveRefusal } from './bulk-approve-policy.js'

/** The tools the fleet's own workers may propose. */
export const FLEET_TOOLS = ['create-negative-keyword', 'graduate-keyword', 'set-target-bid']

export type InboxView = 'waiting' | 'decided' | 'expired'

/**
 * `executing` is a transient claim inside approve; it belongs with decided.
 *
 * NAF.AQ.8 adds `superseded` — a proposal the operator EDITED rather than
 * answered. It belongs in the record for the reason ServiceNow keeps its "No
 * Longer Required" state: without somewhere to put an overtaken request, it
 * either rots in the queue or is deleted, and you lose the ability to tell
 * whether the fleet was wrong or merely corrected. It is not `rejected` —
 * the operator did not say no, they said "not that number".
 */
export const DECIDED_STATUSES = ['approved', 'executed', 'rejected', 'executing', 'superseded']

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
  // Honest fallback. Never claim a person took a decision we cannot
  // attribute — "operator" written unconditionally is what produced 18
  // unattributable rows.
  return { label: actorLabel(authUser), userId: authUser?.id ?? null }
}

/* ── reading ───────────────────────────────────────────────────────────── */

function whereFor(view: InboxView, now: Date = new Date()) {
  // `scheduled` belongs with waiting, not decided: the action has not run and
  // the operator can still take it back, so it must stay where they are
  // looking even after a reload.
  //
  // NAF.AQ — a snoozed request is hidden until it is due. The COUNTS use this
  // same clause, deliberately: if the badge counted what the queue hides, the
  // first thing the operator would learn is that the badge lies. Snoozing is
  // the counter to clearing a queue by approving it, and it only works if the
  // number moves too.
  if (view === 'waiting')
    return {
      status: { in: ['pending', 'scheduled'] },
      toolName: { in: FLEET_TOOLS },
      OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
    }
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

/** The person looking at the Approvals page; null when the caller is not a signed-in person (an API key). */
export async function inboxViewer(request: FastifyRequest): Promise<ToolPrincipal | null> {
  try {
    return await requestPrincipal(request)
  } catch (error) {
    if (error instanceof ToolAccessError) return null
    throw error
  }
}

/**
 * Why this viewer may NOT approve a request of this tool — the very sentence the approve would answer with
 * (`scheduleApproval`'s refusal) — or null when they may. The page shows it on the card instead of offering an Apply
 * that can only fail: a person whose permission was taken away while their approval waited, say, sees why it came
 * back and that it is no longer theirs to approve. Worked out once per request, then per row.
 */
export function cannotApproveFor(viewer: ToolPrincipal | null): (toolName: string) => string | null {
  if (!viewer) return () => 'Only a signed-in person can approve.'
  const approvable = approvableToolNames(viewer)
  return (toolName) => {
    if (approvable === null || approvable.includes(toolName)) return null
    const tool = getTool(toolName)
    const missing = tool ? missingPermissions(viewer, tool) : []
    return missing.length ? permissionMessage(toolName, missing) : `${toolName} is not a tool this workspace knows`
  }
}

export async function listInbox(view: InboxView, limit = 100) {
  const records = view === 'waiting' ? await trackRecords() : {}
  const approvals = await prisma.agentApproval.findMany({
    where: whereFor(view),
    orderBy: view === 'waiting' ? { requestedAt: 'asc' } : { decidedAt: 'desc' },
    take: Math.min(limit, 200),
  })
  const runs = await prisma.agentRun.findMany({
    where: { id: { in: approvals.map((a) => a.agentRunId) } },
    // NAF.AQ — `assignmentId` (SB.AS's column) so `?assignment=` can filter the
    // queue. Resolved through the run, exactly as `charterKey` is: the approval
    // itself stays free of both concepts.
    select: { id: true, agentKey: true, orchestrationId: true, assignmentId: true },
  })
  const runById = new Map(runs.map((r) => [r.id, r]))

  return approvals.map((a) => ({
    ...a,
    charterKey: runById.get(a.agentRunId)?.agentKey ?? null,
    orchestrationId: runById.get(a.agentRunId)?.orchestrationId ?? null,
    assignmentId: runById.get(a.agentRunId)?.assignmentId ?? null,
    /**
     * False for the pre-fleet ACP approvals. The UI labels those rather than
     * hiding them — see the header note.
     */
    isFleet: FLEET_TOOLS.includes(a.toolName),
    /** C1 — how far it can be put back, from the tool registry (the only place that states it). */
    reversibility: reversibilityOf(a.toolName),
    /**
     * AP.8 — how this worker's proposals of this kind have fared with you
     * before. Null when there is no history, which is itself worth saying.
     */
    trackRecord:
      records[`${runById.get(a.agentRunId)?.agentKey ?? 'unknown'}::${a.toolName}`] ?? null,
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
  /** A person approves only what their permissions cover (scheduleApproval). */
  actor: ToolPrincipal
  /**
   * W1-3 — the approver's fresh authenticator code. Needed (and only then read) to approve a request that raises: one
   * whose preview, or a plan step's, carries `stepUp`.
   */
  code?: unknown
}): Promise<DecideOutcome> {
  // AP.4 — an approve parks for the undo window instead of firing. The
  // decision is recorded immediately (attributable, durable); only the
  // execution waits.
  if (input.decision === 'approve') {
    // W1-3 — a raise: settings.security.manage and the code first. A request the approve would refuse anyway (gone,
    // decided, expired, not theirs) is refused before the code is checked, so a refusal never spends it.
    const stepUp = await approvalStepUp(input.id)
    if (stepUp) {
      const refused = (await approveRefusal(input.id, input.actor)) ?? (await approverStepUp(input.actor, input.code, stepUp))
      if (refused) return refused
    }
    const parked = await scheduleApproval({
      id: input.id,
      actor: input.actor,
      note: input.reason || undefined,
      via: stepUp ? 'nexus-step-up' : 'nexus',
    })
    if (!parked.ok) return parked
    await recordControlChange({
      charterKey: await charterKeyOf(input.id),
      action: 'approve_action',
      to: { approvalId: input.id, status: 'scheduled', executeAfter: parked.executeAfter, ...(stepUp ? { decisionVia: 'nexus-step-up' } : {}) },
      note: input.reason ?? (stepUp ? 'approved in Nexus with an authenticator code' : null),
      actor: input.actor.label,
    }).catch((err) =>
      logger.error('[naf-ap] control audit failed', { id: input.id, error: String(err) }),
    )
    return parked
  }

  const charterKey = await charterKeyOf(input.id)

  /*
   * Approvals grid (Owner, 2026-10-05) — a reject needs no reason. The person's words, when given, are stored (and go
   * back to Claude through approval-status); without them the row still says who rejected it, in a neutral system
   * sentence, so `reason` is never empty on a rejected row and is never mistaken for the person's own words
   * (`operatorNote` stays null).
   */
  const words = input.reason?.trim() || undefined
  const out = await decideApproval(
    input.id,
    input.decision,
    input.actor,
    words ?? rejectedBy(input.actor.label),
  )
  if (!out.ok) return out

  /* Both verbs write the operator's note to the same column. The gate stores
     the reject reason in `reason` as well, which is harmless — but the record
     quotes `operatorNote`, so there is exactly one field that can ever be
     attributed to a person. */
  try {
    /* try/catch rather than `.catch()` on the call: the decision has already
       committed and this is a side record, so it must not be able to fail the
       thing that already happened — and `await` survives a caller that returns
       something other than a promise, which `.catch()` does not. */
    await prisma.agentApproval.update({
      where: { id: input.id },
      data: { operatorNote: words ?? null },
    })
  } catch {
    /* recorded in the audit trail regardless; the row's copy is a convenience */
  }

  await mintExemplarFromDecision(input.id, input.decision, words).catch(
    (err) => logger.error('[naf-ap] exemplar minting failed', { id: input.id, error: String(err) }),
  )

  // `recordControlChange` swallows its own errors by contract — but the
  // decision has already committed, so this call must not be able to fail it
  // even if that contract changes underneath us.
  await recordControlChange({
    charterKey,
    action: 'reject_action', // approve returned early, above
    to: { approvalId: input.id, status: out.status ?? null },
    note: words ?? null,
    actor: input.actor.label,
  }).catch((err) =>
    logger.error('[naf-ap] control audit failed', { id: input.id, error: String(err) }),
  )

  return out
}

/** A decision's answer. `httpStatus`: a refusal that is not the default 403 (forbidden) or 409 (anything else). */
export interface DecideOutcome {
  ok: boolean
  status?: string
  result?: unknown
  error?: string
  executeAfter?: string
  code?: 'forbidden' | 'mfa_required' | 'mfa_not_enrolled' | 'mfa_invalid' | 'mfa_locked'
  httpStatus?: 400 | 403 | 429
  /** W1-3 — a raise refused for want of the permission or the code: what it raises, as a person reads it. */
  raises?: string[]
}

/** The words of a raise's refusals when it is approved (claude-trust.service.ts mayRaise). */
function approveRaiseWords(stepUp: StepUp): RaiseWords {
  return {
    act: `Approving a change that ${stepUp.what}`,
    before: `you approve a change that ${stepUp.what}`,
    free: 'Rejecting it does not.',
  }
}

/** W1-3 — the approver of a raise: a signed-in person with settings.security.manage, with their fresh code (used once). */
async function approverStepUp(actor: ToolPrincipal, code: unknown, stepUp: StepUp): Promise<DecideOutcome | null> {
  if (actor.kind !== 'user') {
    return { ok: false, code: 'forbidden', httpStatus: 403, error: `Only a signed-in person approves a change that ${stepUp.what}, with their authenticator code.`, raises: stepUp.raises }
  }
  const refused = await mayRaise(
    { userId: actor.userId, label: actor.label, canManage: hasPermission(actor.permissions, F.settingsSecurityManage) },
    code,
    approveRaiseWords(stepUp),
  )
  if (!refused) return null
  return { ok: false, code: refused.code as DecideOutcome['code'], httpStatus: refused.status as DecideOutcome['httpStatus'], error: refused.error, raises: stepUp.raises }
}

/** The reason stored on a request rejected without the person's own words. */
export const REJECTED_BY_PREFIX = 'rejected by '
export function rejectedBy(label: string): string {
  return `${REJECTED_BY_PREFIX}${label}`
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
  actor: ToolPrincipal
  /** S9.5 — the operator's own words. Previously not passed at all, so an
      approve note reached the audit trail and never the row. */
  note?: string
  /**
   * C5 — who decides: a person in Nexus (the default), the business's rule (auto) as the person who asked, or (C7) the
   * person who asked, confirming in Claude with their authenticator code. W1-3 — `nexus-step-up`: a person in Nexus who
   * typed their authenticator code (decideFleetApproval checked it), the only way a raise is approved in Nexus.
   */
  via?: 'nexus' | 'nexus-step-up' | 'auto' | 'claude-confirm'
}): Promise<{
  ok: boolean
  status?: string
  executeAfter?: string
  error?: string
  code?: 'forbidden'
}> {
  const now = new Date()
  const executeAfter = new Date(now.getTime() + UNDO_WINDOW_MS)
  // C6 — a plan is approved by a person who could have asked for every step of it.
  const planRefusal = await planApprovalRefusal(input.id, input.actor)
  if (planRefusal) return { ok: false, code: 'forbidden', error: planRefusal }
  // MCP.1 — a person may approve only the tools their permissions cover. The
  // check is part of the claim itself, so it costs no extra query.
  const approvable = approvableToolNames(input.actor)
  // Atomic pending→scheduled claim: two tabs cannot both schedule the same row.
  // A request past its expiresAt is not approvable, even in the seconds before
  // the maintenance sweep marks it expired.
  const claim = await prisma.agentApproval.updateMany({
    where: {
      id: input.id,
      status: 'pending',
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      ...(approvable ? { toolName: { in: approvable } } : {}),
    },
    data: {
      status: 'scheduled',
      decidedBy: input.actor.label,
      // The person, not only the name shown: the commit re-checks THEIR permissions when the window ends.
      decidedByUserId: input.actor.kind === 'user' ? input.actor.userId : null,
      decidedAt: new Date(),
      executeAfter,
      decisionVia: input.via ?? 'nexus',
      /* Into `operatorNote`, never `reason`: the gate overwrites `reason` with
         its own sentence for a preview-only tool, which would destroy the
         operator's words a few seconds later. */
      operatorNote: input.note ?? null,
    },
  })
  if (claim.count === 0) {
    return (await approveRefusal(input.id, input.actor, now)) ?? { ok: false, error: 'already taken' }
  }
  return { ok: true, status: 'scheduled', executeAfter: executeAfter.toISOString() }
}

/**
 * Why this person's approve of this request would be refused now — gone, already decided, expired, a tool (or a plan
 * step) their permissions do not cover — in the approve's own words; null when nothing stands in the way. Read only:
 * the reason a claim failed, and (W1-3) the check that runs before a raise's code is spent.
 */
async function approveRefusal(
  id: string,
  actor: ToolPrincipal,
  now: Date = new Date(),
): Promise<{ ok: false; error: string; code?: 'forbidden' } | null> {
  const cur = await prisma.agentApproval.findUnique({
    where: { id },
    select: { status: true, toolName: true, expiresAt: true },
  })
  if (!cur) return { ok: false, error: 'approval not found' }
  if (cur.status !== 'pending') return { ok: false, error: `already ${cur.status}` }
  if (cur.expiresAt && cur.expiresAt <= now) {
    return { ok: false, error: 'This request expired before anyone approved it. Nothing changed.' }
  }
  const approvable = approvableToolNames(actor)
  if (approvable && !approvable.includes(cur.toolName)) {
    const tool = getTool(cur.toolName)
    const missing = tool ? missingPermissions(actor, tool) : []
    return {
      ok: false,
      code: 'forbidden',
      error: missing.length
        ? permissionMessage(cur.toolName, missing)
        : `${cur.toolName} is not a tool this workspace knows`,
    }
  }
  const planRefusal = await planApprovalRefusal(id, actor)
  return planRefusal ? { ok: false, code: 'forbidden', error: planRefusal } : null
}

/** C6 — why this person may not approve this plan (a step's tool they lack the permissions of), or null. */
export async function planApprovalRefusal(id: string, actor: ToolPrincipal): Promise<string | null> {
  if (actor.kind !== 'user') return null
  const head = await prisma.agentApproval.findUnique({ where: { id }, select: { toolName: true } })
  if (head?.toolName !== PLAN_TOOL) return null
  const tools = await prisma.agentPlanStep.findMany({ where: { approvalId: id }, distinct: ['toolName'], select: { toolName: true } })
  for (const { toolName } of tools) {
    const tool = getTool(toolName)
    const missing = tool ? missingPermissions(actor, tool) : []
    if (missing.length) return `Approving this plan needs what each of its steps needs: ${permissionMessage(toolName, missing)}`
  }
  return null
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
    data: { status: 'pending', decidedBy: null, decidedByUserId: null, decidedAt: null, executeAfter: null, decisionVia: null },
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
 * The person who approved as they are NOW in the approval's business, from the same place a signed-in request reads
 * them (workspace-hook.ts): with business profiles on, their membership of that business — its permissions and the
 * business context a request gets; off, their login roles. Null when they can no longer act there at all
 * (membership, person or business no longer active).
 */
const workspaces = createWorkspaceService(prisma)
async function deciderNow(userId: string, workspaceId: string): Promise<{ permissions: ResolvedPermissions; workspace?: WorkspaceContext } | null> {
  if (process.env.NEXUS_WORKSPACES_ENABLED === '1') {
    try {
      const access = await workspaces.membership(userId, workspaceId)
      return { permissions: { isOwner: access.isOwner, permissions: access.permissions }, workspace: access.context }
    } catch (error) {
      if (error instanceof WorkspaceError) return null
      throw error
    }
  }
  const user = await prisma.userProfile.findUnique({
    where: { id: userId },
    select: { id: true, status: true, permissionsVersion: true, roleAssignments: { select: { role: { select: { key: true } } } } },
  })
  if (!user || user.status !== 'active') return null
  return { permissions: await resolvePermissions({ id: user.id, permissionsVersion: user.permissionsVersion, roleKeys: user.roleAssignments.map((a) => a.role.key) }) }
}

/**
 * The person who approved, as the principal the tool runs AS — their id, their permissions now, their business —
 * or why they may not run it now, in plain words. The same test the approve itself passed (`missingPermissions`:
 * `ai.run` and the tool's `requires`), on their permissions as they are at run time. The label stays the name shown.
 * An approval that does not say which person approved it is not run (fail closed): a person's decision never runs
 * as the system.
 */
export async function deciderPrincipal(ap: { toolName: string; decidedBy: string | null; decidedByUserId: string | null; workspaceId: string }): Promise<{ principal: UserPrincipal } | { refusal: string }> {
  const who = ap.decidedBy ?? 'the person who approved it'
  if (!ap.decidedByUserId) return { refusal: 'it could not be re-checked — it does not say which person approved it. Approve it again.' }
  const now = await deciderNow(ap.decidedByUserId, ap.workspaceId)
  if (!now) return { refusal: `${who} no longer has access to this business profile` }
  const principal: UserPrincipal = {
    kind: 'user',
    userId: ap.decidedByUserId,
    label: ap.decidedBy ?? 'unattributed',
    permissions: now.permissions,
    workspace: now.workspace,
    via: 'app', // the Approvals page, where the decision was taken
  }
  const tool = getTool(ap.toolName)
  const missing = tool ? missingPermissions(principal, tool) : [] // the gate answers for a tool it does not know
  if (missing.length) return { refusal: `${who} no longer holds ${missing.join(' and ')}, which ${ap.toolName.replace(/-/g, ' ')} needs` }
  return { principal }
}

/**
 * Back to pending with the reason on the row, never run: the operator's decision is handed back, not thrown away.
 * C5 — a rule-run (decisionVia auto) handed back as stale or refused counts towards the automatic pause.
 */
async function handBack(
  id: string,
  decidedBy: string | null,
  why: string,
  action: Extract<ControlAction, 'stale_refused' | 'permission_refused' | 'rule_refused'>,
  decisionVia: string | null = null,
): Promise<{ ok: false; error: string }> {
  await prisma.agentApproval.updateMany({
    where: { id, status: 'scheduled' },
    data: {
      status: 'pending',
      decidedBy: null,
      decidedByUserId: null,
      decidedAt: null,
      executeAfter: null,
      decisionVia: null,
      reason: `not run — ${why}`,
      /*
       * S9.4 — the clock restarts, because the REQUEST is being asked again.
       *
       * Without this the row keeps the deadline it was created with, so one
       * handed back at hour 23 gives the operator an hour and one handed
       * back after 24 is expired by the very next sweep — seconds after
       * being handed to them, with the fresh facts they were meant to judge.
       *
       * This does not contradict AP.5's one-clock design (see the comment on
       * runApprovalMaintenance): it is still ONE column and ONE sweep. The
       * clock is not duplicated, it is restamped, and the thing it measures
       * — how long this request has been waiting for an answer — genuinely
       * restarted when the answer was handed back.
       */
      expiresAt: new Date(Date.now() + EXPIRY_HOURS * 3600 * 1000),
    },
  })
  await recordControlChange({
    charterKey: await charterKeyOf(id),
    action,
    to: { approvalId: id, ...(decisionVia ? { decisionVia } : {}) },
    note: why,
    actor: decidedBy ?? 'unattributed',
  }).catch(() => undefined)
  if (decisionVia === 'auto' && action !== 'rule_refused') await noteAutoFailure()
  return { ok: false, error: `not run — ${why}` }
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
    select: { status: true, executeAfter: true, decidedBy: true, decidedByUserId: true, toolName: true, workspaceId: true, decisionVia: true, preview: true, args: true },
  })
  if (!ap) return { ok: false, error: 'approval not found' }
  if (ap.status !== 'scheduled') return { ok: false, error: `not scheduled (${ap.status})` }
  if (ap.executeAfter && ap.executeAfter > new Date()) {
    return { ok: false, error: 'still inside the undo window' }
  }

  // C5 — a change the business's rule scheduled runs by that rule only while the rule still allows it: a Pause, a
  // lowered level or tightened limits inside the window hand it to a person instead (W1-8: so does the ads strategy
  // narrowing it where it lands).
  if (ap.decisionVia === 'auto') {
    const ruleNow = ap.toolName === PLAN_TOOL ? await autoPlanCommitRefusal(id) : await autoCommitRefusal(ap.toolName, ap.preview, ap.args)
    if (ruleNow) return handBack(id, ap.decidedBy, ruleNow, 'rule_refused', ap.decisionVia)
  }

  // The person who approved must still be allowed to do this NOW, in this business: the window, or the sweep that
  // commits after it, can end after their role changed or their access was removed. Checked before anything runs.
  const decider = await deciderPrincipal(ap)
  if ('refusal' in decider) return handBack(id, ap.decidedBy, decider.refusal, 'permission_refused', ap.decisionVia)

  // C6 — a plan: each step is re-checked and run by the plan worker; the commit hands it over.
  if (ap.toolName === PLAN_TOOL) return handPlanToWorker(id, ap.decidedBy ?? 'unattributed')

  // AP.6 — the world may have moved while this sat parked. Re-validate
  // BEFORE releasing it: an approval describes a state of the world, and if
  // that state changed the approval no longer describes anything real.
  const staleness = await checkStaleness(id, { withFresh: ap.decisionVia === 'auto' })
  if (staleness.stale) return handBack(id, ap.decidedBy, staleness.why ?? 'it is no longer a valid action', 'stale_refused', ap.decisionVia)

  // AA-W2-3 — a strategy-bound change the rule scheduled is judged again on that fresh dry run, not on the stored
  // preview: the strategy, or the day's counts, may have moved inside the window. A person decides it then; that is a
  // refusal of the rule, not a failure, so it never counts towards the automatic pause.
  if (ap.decisionVia === 'auto') {
    const freshNow = await autoFreshRefusal(ap.toolName, staleness.fresh, ap.args)
    if (freshNow) return handBack(id, ap.decidedBy, freshNow, 'rule_refused', ap.decisionVia)
  }

  // Hand back to the gate, which owns execution. It expects `pending`, so
  // release the park atomically — if that loses a race, someone else has it.
  const release = await prisma.agentApproval.updateMany({
    where: { id, status: 'scheduled' },
    data: { status: 'pending', executeAfter: null },
  })
  if (release.count === 0) return { ok: false, error: 'already taken' }

  // The tool runs AS the person who approved — the principal just re-checked — in their business, so what it writes
  // (a price audit row, a queued push) names them by id. The label stays the name shown.
  const decidedBy = ap.decidedBy ?? 'unattributed'
  const out = await decideApproval(id, 'approve', decider.principal)
  if (!out.ok) {
    /*
     * S9.4 — a failed execution left the row lying about itself.
     *
     * `decideApproval` puts it back to `pending` with the failure in `reason`,
     * but leaves `decidedBy` and `decidedAt` set from the claim. So the row sat
     * in the queue waiting for a decision while carrying a decision — and the
     * card's comeback banner had to infer the truth from a reason string.
     *
     * The order here is the whole fix. This early return used to skip
     * `recordControlChange` entirely, so **nobody recorded that anyone had
     * approved the attempt**: clearing `decidedBy` without writing the audit
     * first would have erased the only trace that it happened. Audit, then
     * clear, then restamp the clock the operator now has to answer within.
     *
     * Scoped here rather than in `decideApproval`, which the copilot's own
     * route also calls. That path still leaves `decidedBy` set on a failed
     * execution; recorded in the study rather than changed from this stream.
     */
    await recordControlChange({
      charterKey: await charterKeyOf(id),
      action: 'execution_failed',
      to: { approvalId: id, status: out.status ?? 'pending', ...(ap.decisionVia ? { decisionVia: ap.decisionVia } : {}) },
      note: out.error ?? 'execution failed',
      actor: decidedBy,
    }).catch((err) => logger.error('[naf-ap] failure audit failed', { id, error: String(err) }))

    await prisma.agentApproval.updateMany({
      where: { id, status: 'pending' },
      data: {
        decidedBy: null,
        decidedByUserId: null,
        decidedAt: null,
        decisionVia: null,
        expiresAt: new Date(Date.now() + EXPIRY_HOURS * 3600 * 1000),
      },
    })
    // C5 — a rule-run that failed counts towards the automatic pause.
    if (ap.decisionVia === 'auto') await noteAutoFailure()
    return out
  }

  /*
   * S9.5 — with the note, not without it.
   *
   * This called `mintExemplarFromDecision(id, 'approve')` with no third
   * argument, so every exemplar minted from an APPROVE carried
   * `operatorNote: null`. The precedent panel tells the operator that
   * approving with a reason teaches the fleet; on the approve path it taught
   * it nothing at all. Read back off the row, which now holds it.
   */
  const noted = await prisma.agentApproval.findUnique({
    where: { id },
    select: { operatorNote: true },
  })
  await mintExemplarFromDecision(id, 'approve', noted?.operatorNote ?? undefined).catch((err) =>
    logger.error('[naf-ap] exemplar minting failed', { id, error: String(err) }),
  )
  await recordControlChange({
    charterKey: await charterKeyOf(id),
    action: 'approve_action',
    to: { approvalId: id, status: out.status ?? null },
    actor: decidedBy,
  }).catch((err) => logger.error('[naf-ap] control audit failed', { id, error: String(err) }))

  return out
}

/**
 * C6 — the commit of an approved plan: claimed (scheduled → executing), audited, and queued for the plan worker. With
 * no worker it is not run here (a browser's commit must answer at once): the approval sweep runs it.
 */
async function handPlanToWorker(id: string, decidedBy: string): Promise<{ ok: boolean; status?: string; error?: string }> {
  const claimed = await prisma.agentApproval.updateMany({ where: { id, status: 'scheduled' }, data: { status: 'executing', executeAfter: null } })
  if (claimed.count === 0) return { ok: false, error: 'already taken' }
  await recordControlChange({
    charterKey: await charterKeyOf(id),
    action: 'approve_action',
    to: { approvalId: id, status: 'executing' },
    actor: decidedBy,
  }).catch((err) => logger.error('[naf-ap] control audit failed', { id, error: String(err) }))
  await enqueuePlan(id).catch((err) => logger.warn('[naf-ap] plan not queued; the sweep runs it', { id, error: String(err) }))
  return { ok: true, status: 'executing' }
}

/* ── AP.6: an approval that no longer applies must not run ─────────────── */

/**
 * The fields whose change invalidates an approval. Not every difference
 * matters — a metrics window ticking over is noise — but the value the
 * operator was shown as the STARTING point does: "move this bid from €0.42
 * to €0.25" is a different decision if the bid is €0.60 by the time it runs.
 */
export const MATERIAL_PREVIEW_FIELDS: Record<string, string[]> = {
  /* The fleet's three ads tools, shared with Claude (MCP full control d1 = A). A4: set-target-bid executes —
     the bid it starts from, the bid that lands (after the CPC ceiling) and where it lands (live on which Amazon Ads
     profile, or sandbox) are what the person approved. W4-4 — and the bid a run by rule writes (stepped to the largest
     change), and what auto-bid does with the bid afterwards (held as a person's, or handed back). */
  'set-target-bid': ['currentBidCents', 'effectiveBidCents', 'byRuleBidCents', 'afterwards', 'reach'],
  // A6 — the budget or the adjustments it starts from, and where it lands. W4-7 — the list form: every campaign's budget
  // now and asked (basis).
  'set-campaign-budget': ['currentBudgetCents', 'basis', 'reach'],
  // W4-7 — budgets: the plan, schedule or pool as it is (and every give-back, allocation or rebalance it makes), each
  // budget a restore starts from and puts back, and where its writes land (Nexus only: none).
  'set-monthly-ad-budget': ['basis', 'reach'],
  'set-budget-schedule': ['basis', 'totals', 'reach'],
  'set-budget-pool': ['basis', 'totals', 'reach'],
  'restore-budget-baselines': ['basis', 'totals', 'reach'],
  'set-placement-multipliers': ['current', 'reach'],
  // A7 — how many change and why the rest do not, a fingerprint of every target's starting and new bid, where it lands.
  // W4-4 — the fingerprint holds the bids a run by rule writes too; and what auto-bid does with the bids afterwards.
  'bulk-ad-bid-change': ['totals', 'basis', 'afterwards', 'reach'],
  // A8 — what a suppression floors; whose suppression a restore lifts and every bid it puts back.
  'suppress-campaign': ['moves', 'reach'],
  'restore-campaign': ['suppressedBy', 'basis', 'reach'],
  // A12 — the allowlist setting it starts from.
  'set-campaign-live-writes': ['liveWrites'],
  // BB-6 — the bid brain enrollment it starts from (its mode, hold and last change) and the op.
  'set-bid-brain-enrollment': ['op', 'enrollment', 'basis'],
  // T5 — every campaign asked with the target it stores now and gets (basis), and the counts (a raise, a clear).
  'set-campaign-target-acos': ['basis', 'totals'],
  // A11 — the whole plan (products, targeting, budget and currency), the market's spend ceiling, where it lands.
  'create-ad-campaign': ['plan', 'ceiling', 'reach'],
  // B-3 — a one-off SP Super Wizard set: the whole launch (its basis), the market's ceiling and where it lands.
  'build-sp-wizard-campaigns': ['basis', 'ceiling', 'reach'],
  // B-2 — the goal's shape (its products, campaigns, budgets, targets, rules and plan; its evidence bids are frozen in the
  // approval, so they are not compared), the market's ceiling, where it lands.
  'create-ai-goal-campaigns': ['basis', 'ceiling', 'reach'],
  // PB-5a — the op, every campaign a build makes (or every binding of an adopt) with the row it is planned from, where it lands.
  // PB-5b — and what a start or a stop moves (its campaigns, the bids they spend at, its hourly plans and rules).
  'apply-ads-playbook': ['op', 'basis', 'reach', 'bindings', 'starts', 'stops'],
  // B-1 — every campaign a Replicate copy makes (from the source as it is now), the market's spend ceiling, where it lands.
  'replicate-ad-structure': ['basis', 'ceiling', 'reach'],
  // W4-1 — the op, the plan as it stood and after (its week, members, values, on/off, whose it is), the targets' values,
  // where it lands and the markets whose write gate refuses (what a give-back lifts moves with the engine's hours: execute
  // decides again whether it raises).
  'set-hourly-bid-plan': ['op', 'basis', 'reach', 'gateRefused'],
  // AA-W2-12 — every ad named with its status (an enable: the pause it lifts, the budget and the bids that serve again),
  // and where it lands. W4-2 — an enable: who paused each ad and when, frozen (a status change recorded since moves it).
  'pause-ads': ['basis', 'reach'],
  'enable-ads': ['basis', 'reach', 'whoPaused'],
  // AA-W2-13 — every ad named with its status, and where it lands.
  'archive-ads': ['basis', 'reach'],
  // W4-3 — every campaign named with each setting it starts from and gets (and the caps of the portfolios it leaves and
  // joins), and where it lands; a portfolio with its name, cap and state, what it sets, and where it lands.
  'set-campaign-settings': ['basis', 'reach'],
  'set-portfolio': ['basis', 'reach'],
  // W3-3 — every ad group named with its stock verdict, every bid it lowers or gives back, and where it lands.
  'lower-ad-bids-for-stock': ['basis', 'reach'],
  'restore-ad-bids-after-stock': ['basis', 'reach'],
  // W4-6 — a new ad group (every row, its bids and how they start, the products' rule-3 facts and its campaign's floor),
  // the product ads added (each product and the seller SKU it is created from), an ad group's op and every value it
  // starts from and sets (W4-4: and the default bid a run by rule writes); and where each lands.
  'create-ad-group': ['basis', 'reach'],
  'add-product-ads': ['basis', 'reach'],
  'set-ad-group': ['op', 'basis', 'byRuleBidCents', 'reach'],
  // A14/A15 — eBay: each rate, listing, budget or keyword it starts from and sets, and where it lands (live or sandbox).
  'set-ebay-ad-rates': ['changes', 'reach'],
  'promote-ebay-listings': ['adds', 'adGroup', 'reach'],
  'set-ebay-campaign-budget': ['currentBudgetCents', 'reach'],
  'ebay-keywords-change': ['bidChanges', 'adds', 'negatives', 'adGroup', 'reach'],
  'create-ebay-campaign': ['plan', 'account', 'ceiling', 'reach'],
  // A10 — what the undo restores (each write and the value it puts back), the negatives it retires, where it lands.
  'undo-ad-change': ['source', 'rows', 'negatives', 'reach'],
  /* ADS AUTONOMY — auto-undo's one undo: the judgement it carries out, what goes back (from → to) and where it lands. */
  'undo-worse-ad-change': ['judgement', 'restore', 'reach'],
  /* One brain AB-13 — the brain's painting of one hourly plan: which painting, the plan and week it stands on (basis), and
     where the engine's writes land. */
  'apply-brain-hourly-plan': ['proposalId', 'basis', 'reach', 'gateRefused'],
  /* ONE BRAIN AB-11 — the ads brain's harvest: the term, its destination, the start bid, the sources still owed (or what
     an undo puts back), and where it lands. */
  'apply-brain-harvest': ['basis', 'reach'],
  // W4-5 — every target or negative with its place and bids (a harvest: its term, source, destination, bid and negative
  // plan, a bid it worked out itself frozen in the approval; a retire: every negative with who made it), where it lands;
  // for negatives also the other products' places and the proven handovers they would close (never the numbers, which
  // move with every report). A harvest destination (Nexus only): the destination from → to.
  'add-ad-targets': ['basis', 'reach'],
  'add-negative-targets': ['basis', 'reach', 'otherProductPlaces', 'handovers'],
  'retire-negatives': ['basis', 'reach'],
  'harvest-search-term': ['basis', 'reach'],
  'set-harvest-destination': ['basis'],
  // A5 — executable too: the ad group it goes to, the destination and starting bid, where it lands.
  'create-negative-keyword': ['matchType', 'scope', 'alreadyNegated', 'adGroup', 'reach'],
  'graduate-keyword': ['suggestedBidCents', 'destination', 'destinationAdGroup', 'alreadyExact', 'reach'],

  /* NAF.AQ.2 — the four tools that CAN execute, and which had no material
     fields at all. The protection was inverted exactly as `TOOL_CARDS` was
     before AP.3: the three tools that can never reach Amazon were guarded,
     and the four that can were not. An empty list means the only staleness
     signal is the handler refusing outright, so field-level drift — the very
     thing this check exists for — went unnoticed on the rows with real
     consequences.

     Each handler is read-only (verified in mutate.tools.ts), so re-running it
     is safe; what follows is what it is worth comparing. */

  // `changes['base price'].from` is the LIVE price read at preview time.
  // "Move this from €49 to €39" is a different decision at €35.
  'set-price': ['changes'],

  // Same shape: `changes.{title,bulletPoints,description}.from` is the live
  // content. If someone edited the listing in between, the diff the operator
  // approved describes content that no longer exists.
  'apply-content': ['changes'],

  // MCP full control L5 — publish-listing runs the studio publish. `destination` is the channel, market, account and
  // alias; `publish` a first publish or a re-publish; `publishMode` whether the channel is live; `fingerprint` hashes
  // every field it sends with the channel value it replaces, so any move in Nexus or on the channel is a different
  // decision. Its execute compares the same fingerprint again against the approved preview (ctx.approvedPreview).
  'publish-listing': ['destination', 'publish', 'publishMode', 'fingerprint'],

  // `suppressed` is the one that matters most anywhere in this map: if the
  // customer opted out after the operator said yes, the message must not go.
  // `note` is prose, and included deliberately — it is the field that encodes
  // whether outbound email is live or dry-run, and that flip turns a recorded
  // no-op into an irreversible real send.
  // 07 O11 — the door's preview: the buyer it goes to (masked), its route, the live/dry-run mode, who it is sent as,
  // and the words. (An opted-out buyer or a missing e-mail is refused by the dry run itself.)
  'send-customer-message': ['to', 'route', 'mode', 'sendsAs', 'subject', 'body'],

  // MCP.10 — the bulk changes (tools/bulk.tools.ts). `changes` names the from → to the operator read, but
  // only for the first 20 of up to 250 products; `basis` fingerprints every product's starting value and
  // every listing that follows the price, so a move on product 21 is caught too. `totals` says how many; the
  // price tool's `change` carries the operation and the currency it is in.
  'bulk-price-change': ['change', 'changes', 'totals', 'basis'],
  // C2 — each product to its own price (the undo of a bulk price change): the same preview, the same fingerprint.
  'set-master-prices': ['change', 'changes', 'totals', 'basis'],
  'bulk-attribute-change': ['changes', 'totals', 'basis'],
  // MCP full control (section 03) — content changes. `changes` is from → to per field with the English meaning the
  // person read; `reach` names the listings that follow the shared text and those with their own pin (a pin added
  // in between changes who the text reaches); `basis` fingerprints what each field stores now and the language
  // row's version, so a sheet edit between preview and approval is caught even when the shown text did not move.
  'set-content': ['changes', 'reach', 'basis'],
  // `reach` names the one listing and its status: a draft published in between is a different decision.
  'set-listing-content': ['changes', 'reach', 'basis'],
  // `changes` keeps the first 20 lines; `totals` says how many; `basis` fingerprints every product's stored text, every
  // change and every listing reached, so a move on product 21 makes the approval stale too.
  'bulk-content-change': ['changes', 'totals', 'reach', 'basis'],
  // I10 — identity fixes: `changes.*.from` is the value read at preview time; a different one means a different decision.
  'set-product-sku': ['changes'],
  'set-gtin': ['changes'],
  'set-brand': ['changes', 'totals'],
  'set-listing-sku': ['changes'],
  // I11 — the parent read at preview time; for a merge, the whole plan (what moves where, what was safe).
  'fix-parent': ['changes'],
  'merge-duplicate-products': ['changes', 'plan'],
  // MCP full control L6 — the drafts it would start (and the account they land on); the untouched drafts it removes, each
  // at the version read; a listing change's fingerprint (what it holds now and what it gets; a projection's version).
  'create-draft-listings': ['destination', 'create'],
  'remove-draft-listings': ['remove'],
  'set-listing-fields': ['destination', 'fingerprint'],

  // MCP full control P7 — organizing changes (tools/organize-catalog.tools.ts, organize-platform.tools.ts).
  // `changes` is the from → to read when the person approved: the product's tags, its stage, the view as it was.
  // A tag added, a stage moved or a view edited since makes the request a different decision.
  'set-product-tags': ['changes'],
  'move-workflow-stage': ['changes'],
  'save-view': ['mode', 'changes'],
  // `changes` holds the from → to of each field and the state each alert or notification is in now; the image library
  // also carries `basis`, each asset's folder, label and tags as read: a rule edited, an alert triaged or an asset
  // organized by someone since makes the request a different decision.
  'set-alert-rule': ['mode', 'changes'],
  'acknowledge-alerts': ['mode', 'changes'],
  'organize-image-library': ['changes', 'basis'],
  // MCP full control P8 — structure changes (tools/structure-change.tools.ts, mapping-change.tools.ts).
  // From → to of each field and how many products (families, translations, categories) it touches: a structure change
  // whose impact grew, or whose starting value moved, is a different decision (structure-change.tools.ts).
  'save-attribute': ['action', 'changes', 'impact'],
  'save-product-family': ['action', 'changes', 'impact'],
  'save-category': ['action', 'changes', 'impact'],
  // `changes` the rules / translations / template fields from → to, `impact` the review's counts, `basis` the mapping
  // and input tokens (or the template's version): a mapping or an input that moved since is a different review.
  'save-channel-mapping': ['changes', 'impact', 'basis'],
  'save-listing-template': ['changes', 'impact', 'basis'],
  // MCP full control P10 — the business's settings (tools/business-settings.tools.ts).
  // Every field from → to (the values read when the person approved) and the legal identity documents will show.
  'set-business-settings': ['changes', 'legal'],

  // MCP full control R9 — a rule save: what changes, the level it lands at, and `basis`, the rule's updatedAt the
  // preview was made from — someone else's edit in between makes the approved change a different one.
  'save-ad-rule': ['changes', 'level', 'basis'],
  // R10 — a level move: from where to where, the row's updatedAt it was planned from, and whether it is a brake.
  'turn-up-automation': ['from', 'to', 'basis'],
  'turn-down-automation': ['from', 'to', 'basis', 'brake'],
  // R11 — each suggestion's status, its proposed change and the bid / budget there now: decided by someone else, or
  // the bid moved, and the approved batch is a different one.
  'decide-automation-suggestions': ['items'],
  // Ads autonomy W3-1 — each recommendation from the state it was in (shown, muted, settled) to the one it gets.
  'mute-ad-recommendations': ['changes'],
  // R12 — what the stop or resume changes (the halt, or which rules), and the state row it was planned from.
  'stop-automation': ['changes', 'ruleIds', 'basis'],
  'resume-automation': ['changes', 'ruleIds', 'basis'],
  // R13 — what the guardrail changes, whether that tightens or loosens, and the row it was planned from.
  'set-ad-guardrail': ['changes', 'direction', 'basis'],
  // Ads autonomy W3-2 — every write it cancels (from → to, who queued it, its window) and the rows it starts from: a
  // write sent or moved since makes the approved cancel a different one.
  'cancel-queued-ad-write': ['writes', 'basis'],
  // Ads autonomy W1-3 — every field from → to with the value in force before and after (an inherited value that moved
  // is a different decision), raise or lower, the row's version, and `basis` (the row, its terms and its campaigns).
  'set-ads-strategy': ['changes', 'direction', 'version', 'basis'],
  // ADS PLAYBOOK PB-3 — a playbook change: what it changes, raise or lower, the version it starts from, and its basis.
  'set-ads-playbook': ['changes', 'direction', 'version', 'basis'],
  // ADS AUTONOMY W4-1 — a run report: what it reports (start, finish, fail, withdraw) and the run it names, with whether
  // it is over: the same run reported or withdrawn since makes it a different report.
  'report-ads-run': ['op', 'run'],
  // W4-2 — the expected report time from → to: someone else's change of it since makes this a different one.
  'set-ads-report-time': ['changes'],
  'tune-ad-engine': ['changes', 'raises', 'basis'],
  // ADS AUTONOMY W4-8 — a rule's campaigns: every campaign bound before and after, its level and scope (basis), and what
  // can raise; a coverage set: every term's values from and to (or the seed's terms) and what can raise; a Run now: the
  // engine, what it may do now (its level), and a slow engine's last run (a tick since makes the approved run another one).
  'assign-ad-rules': ['basis', 'raises'],
  'set-coverage-set': ['basis', 'raises'],
  'run-ad-engine-now': ['engine', 'level', 'basis'],
  'steer-fleet': ['steer', 'changes', 'basis'],
  'save-price-rule': ['changes', 'bounds', 'basis'],
  'save-ops-rule': ['changes', 'level', 'basis'],

  // MCP full control 07 O7 — the order desk's changes. `changes` (update-order, update-customer) holds each part with
  // its starting value (the tags it had, the delivery state, the review state, the note it deletes); `reviews` each
  // review's triage before and after. A move in any of them is a different decision.
  'update-order': ['changes'],
  'update-customer': ['changes'],
  'triage-reviews': ['reviews'],
  // 07 O8 — shipments and labels: the orders/shipments and each one's starting state; for labels also each
  // estimated price and the carriers' live/dry-run modes (a flip to live turns a dry run into money spent).
  'create-shipments': ['create'],
  'update-shipment': ['shipments'],
  'buy-shipping-label': ['labels', 'returnLabels', 'modes'],
  'void-shipping-label': ['labels', 'modes'],
  // 07 O9 — each shipment's state, tracking number and how its tracking reaches the channel (live or dry run).
  'confirm-shipment': ['shipments'],
  // 07 O10 — the order's status and total, what the cancel undoes in Nexus, and the channel's live/dry-run mode.
  'cancel-order': ['order', 'inNexus', 'channelCancel'],
  // 07 O12 — returns: the order and its lines (create); each return's starting state and step (update); what each
  // restock puts back where (dispose); the refund, what is still refundable and the channel's mode (refund).
  'create-return': ['order', 'items', 'returnType'],
  'update-return': ['returns'],
  'dispose-return-items': ['returns', 'unitsBackInStock'],
  'issue-refund': ['return', 'order', 'refund', 'refundable', 'channelRefund'],
  // 07 O13 — the order, any earlier request and Amazon's live/dry-run mode; the review, the reply and eBay's mode.
  'request-review': ['order', 'earlier', 'mode'],
  'reply-to-review': ['review', 'reply', 'mode'],
  // 07 O14 — the series and, per document, whether a new number is taken.
  'issue-fiscal-document': ['series', 'invoices', 'creditNotes'],
  // 07 O17 — the pickup (carrier, day, warehouse) and Sendcloud's live/dry-run mode; the channel and its accounts.
  'schedule-pickup': ['pickup', 'mode'],
  'sync-orders-now': ['channel', 'accounts', 'account'],

  // MCP full control 08 S6 — stock moves with every sale, so each stock change compares the numbers it showed: a
  // count's from, a transfer's available units, a reconcile's stock now (`basis` fingerprints every row, past the 20
  // shown). A hold compares what it holds; its units are checked again when it runs (reserveStock refuses a short hold).
  'set-stock': ['changes', 'totals', 'basis'],
  'transfer-stock': ['changes', 'totals', 'basis'],
  'stock-count': ['action', 'count', 'changes', 'totals'],
  'reconcile-stock-count': ['variances', 'totals', 'basis'],
  'reserve-stock': ['action', 'hold'],
  'set-stock-location': ['action', 'location', 'changes'],
  // 08 S8 — every listing's number now and after: a sale or a pin moved since changes what the switch does.
  'set-stock-source': ['to', 'products', 'totals'],
  // 08 S7 — Sync Control: every row's stock mode as it was (`basis` fingerprints all of them, past the 20 shown) and what
  // the action makes of it; a policy's or a location's feeds before and after.
  'bulk-listing-stock': ['verb', 'cells', 'totals', 'basis'],
  'set-stock-policy': ['policy', 'location', 'changes'],

  // MCP full control 08 S12 — a pricing rule's fields and products as they were; a promotion's scope (how many listings
  // go on sale, how many sales end); a scheduled change's master price now (the percent it moves is worked out from it).
  'set-pricing-rule': ['action', 'rule', 'changes', 'products'],
  'set-promotion': ['action', 'promotion', 'scope'],
  'schedule-price-change': ['action', 'change', 'bounds'],
  // 08 S11 — every product's floor and ceiling and every listing's price as they were (`basis` fingerprints all of them,
  // with each listing's version), and what is sent again.
  'set-price-bounds': ['changes', 'totals', 'basis'],
  'bulk-listing-price-change': ['changes', 'totals', 'basis'],
  'resend-prices': ['send', 'totals', 'basis'],
  // 08 S9 — suppliers and purchase orders: the PO card shows supplier, e-mail, total and currency (decided S-1).
  'upsert-supplier': ['action', 'supplier', 'changes', 'products', 'totals'],
  'draft-purchase-order': ['action', 'purchaseOrder', 'lines', 'totals'],
  'advance-purchase-order': ['action', 'purchaseOrder', 'supplier', 'totalCents', 'currencyCode', 'email'],
  'cancel-purchase-order': ['action', 'purchaseOrder', 'totalCents', 'reason'],
  // 08 S9 — an e-mail to a supplier: who it goes to and from (the business's identity), about which PO, and the words.
  'email-supplier': ['supplier', 'purchaseOrder', 'email', 'message'],
  // 08 S10 — receiving (the counts and stock it saw), inbound shipments, costs, replenishment.
  'receive-stock': ['action', 'shipment', 'lines', 'totals', 'basis'],
  'update-inbound-shipment': ['action', 'shipment', 'status', 'changes', 'lineCosts', 'lines'],
  'set-product-costs': ['action', 'costs', 'landed', 'totals'],
  'replenishment-action': ['action', 'suggestions', 'preferred', 'substitutions', 'cashOnHandCents', 'totals'],
  // 08 S13 — an eBay promotion (live or dry run, the prices it sets), tier prices, an FBA plan's lines.
  'set-ebay-price-promotion': ['kind', 'live', 'dates', 'discount', 'listings', 'products', 'tiers', 'marketplace'],
  'set-tier-prices': ['product', 'tiers'],
  // Step 4 Send to FBA — where it leaves from (the warehouse and its address), the day, each SKU's cases / units / free
  // units / owners and the box totals: a sale or a changed owner between preview and approval changes what is held.
  'plan-fba-shipment': ['marketplace', 'from', 'readyToShipOn', 'lines', 'totals'],
  // `basis` fingerprints the Shopify sheet's own cell tokens and baselines: a draft edit or a store change in between.
  'set-shopify-content': ['changes', 'reach', 'basis'],
  // I9 — the id read at preview time (and for unlink, the quantity it was advertising); for link, the channel's proof.
  'unlink-channel-id': ['changes', 'liveQuantity'],
  'link-channel-id': ['changes', 'verdict'],
  // L7 — the product and its variations as asked (a SKU taken meanwhile refuses the re-check); the generator's own
  // plan token and the family version it was made from; the products binned or restored.
  'create-product': ['product', 'variations'],
  'create-variations': ['previewToken', 'familyVersion', 'counts'],
  'discard-new-products': ['restore', 'products'],
  // L8 — the Matrix door's own preview: the verb and every change it would make (from → to per cell; a sale's cell
  // version too). The run carries these changes and the door re-verifies each one again.
  'set-listing-stock': ['verb', 'changes'],
  'set-listing-price': ['verb', 'changes'],
  'revert-listing-change': ['operationId', 'status', 'cells'],
  // L9 — each listing and how its channel closes or reopens it (and the eBay quantity a reopen pins).
  'close-listing': ['listings', 'how'],
  'reopen-listing': ['listings', 'how', 'quantity'],
  // Phase 3 (T1) — End, Relist and Delete: each listing and what the engine does to it, every row's state as it was (its
  // from → to), and the engine's consequence. The FBA unit count in `warning` names its read time, so it is not material.
  'end-listing': ['listings', 'changes', 'how'],
  'relist-listing': ['listings', 'changes', 'how'],
  'delete-listing': ['listings', 'changes', 'how'],
  // L10 — the photo layer, the revision it was read at and the plan the edit leaves it with.
  'arrange-photos': ['layer', 'revision', 'after'],
  'add-photo-from-url': ['family', 'place', 'host', 'contentHash', 'bytes'],
  'remove-unused-photo': ['family', 'photo'],
  // MCP full control P9 — imports and their undo (tools/data-transfer.tools.ts). `counts` what changes, `basis` the
  // file, the mapping and a fingerprint of every write (or the job and what its undo writes): any of them moved since
  // the person approved is a different import.
  'import-catalog': ['counts', 'basis'],
  'rollback-bulk-operation': ['counts', 'basis'],
}

export interface StalenessVerdict {
  stale: boolean
  /** Plain sentence naming what moved. Null when nothing did. */
  why: string | null
  /**
   * AA-W2-3 — asked for (`withFresh`) and nothing moved: the preview of the dry run it just made (as the gate stores one:
   * `preview ?? data`), which a strategy-bound rule-run is judged again on. Never for a plan (its steps are checked when
   * each runs).
   */
  fresh?: unknown
}

/** AA-W2-3 — `withFresh`: also hand back the fresh dry run when nothing moved (StalenessVerdict.fresh). */
export interface StalenessOptions {
  withFresh?: boolean
}

// W4-4 — a value the fresh preview no longer carries reads "none", never "undefined".
const money = (c: unknown) => (typeof c === 'number' ? `€${(c / 100).toFixed(2)}` : c == null ? 'none' : String(c))

/**
 * One text per value whatever the order of its keys, for comparing a stored preview with a fresh one.
 *
 * The stored preview is jsonb, and jsonb re-orders an object's keys (shorter first): `{ from, to }` reads back as
 * `{ to, from }`. Compared through plain JSON.stringify, every object-valued material field therefore "moved" when
 * nothing had, and an approved set-price or apply-content was handed back as stale at every commit (measured on
 * PGlite). Keys are sorted at every depth; array order still counts, and values keep their types (5 is not "5",
 * null is not ""). The value goes through JSON first, as the stored copy did: a Date or a Decimal becomes the
 * string jsonb holds, and an undefined key is dropped as it was dropped there.
 */
function canonicalJson(value: unknown): string | undefined {
  const plain = JSON.stringify(value)
  if (plain === undefined) return undefined
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]))
        : v
  return JSON.stringify(sorted(JSON.parse(plain)))
}

/**
 * Re-validate an approval against the world as it is NOW.
 *
 * It re-runs the tool's OWN dry-run handler — the same code that produced
 * the preview the operator read — so this check can never drift from what
 * they were shown. If the handler now refuses (the term is already negated,
 * a pin was added, the target vanished), that refusal is the answer.
 */
export async function checkStaleness(approvalId: string, opts: StalenessOptions = {}): Promise<StalenessVerdict> {
  const ap = await prisma.agentApproval.findUnique({
    where: { id: approvalId },
    select: { toolName: true, args: true, preview: true },
  })
  if (!ap) return { stale: true, why: 'the request no longer exists' }
  // C6 — a plan is re-checked step by step, when each step runs (change-plan.service.ts).
  if (ap.toolName === PLAN_TOOL) return { stale: false, why: null }
  return previewStaleness(ap.toolName, (ap.args ?? {}) as Record<string, unknown>, ap.preview, approvalId, opts)
}

/**
 * C6 — the staleness check of one change (an approval, or a step of a plan): its tool's own dry run now, compared with
 * the preview the person approved on the tool's MATERIAL_PREVIEW_FIELDS.
 */
export async function previewStaleness(
  toolName: string,
  args: Record<string, unknown>,
  preview: unknown,
  approvalId: string,
  opts: StalenessOptions = {},
): Promise<StalenessVerdict> {
  const ap = { toolName, args, preview }
  const tool = getTool(ap.toolName)
  const canExecute = typeof tool?.execute === 'function'

  /**
   * NAF.AQ.2 — fail CLOSED for anything that can reach the outside world.
   *
   * The map above previously defaulted to SILENCE: a tool with no entry got
   * `?? []`, compared nothing, and passed without complaint. That is how the
   * four executable tools went unguarded for months — not because anyone
   * decided they were safe, but because nobody noticed they were missing.
   * A guard whose omission is invisible is not a guard.
   *
   * So: an action that can execute and has no declared material fields is
   * treated as stale. The cost of being wrong in this direction is a refusal
   * the operator can read and someone can fix; the cost in the other
   * direction is an unguarded write.
   */
  if (canExecute && !MATERIAL_PREVIEW_FIELDS[ap.toolName]) {
    return {
      stale: true,
      why: `it could not be re-checked — nobody has declared which facts matter for "${ap.toolName.replace(/-/g, ' ')}", and an action that can change something is never run unchecked`,
    }
  }

  if (!tool?.handler) {
    // No dry-run to compare against. Harmless for a preview-only tool;
    // disqualifying for one that can act.
    return canExecute
      ? { stale: true, why: 'it could not be re-checked — this action has no dry-run to compare against' }
      : { stale: false, why: null }
  }

  const fresh = await freshDryRun(ap.toolName, (ap.args ?? {}) as Record<string, unknown>, approvalId)
  if (!fresh.ok) return { stale: true, why: fresh.why ?? 'it is no longer a valid action' }

  const moved = movedFields(ap.toolName, ap.preview, fresh.preview)
  if (moved.length > 0) {
    return {
      stale: true,
      why: `the facts moved since you approved it — ${moved.join('; ')}`,
    }
  }
  return opts.withFresh ? { stale: false, why: null, fresh: fresh.preview ?? fresh.data } : { stale: false, why: null }
}

/**
 * C6 — a change's own dry run now, as the re-check takes it (the system, `approval-recheck`, naming the approval it
 * re-checks). Never throws: a dry run that cannot run, or that refuses, says why — and is never permission to proceed.
 */
export async function freshDryRun(
  toolName: string,
  args: Record<string, unknown>,
  approvalId: string,
): Promise<{ ok: boolean; why: string | null; preview?: unknown; data?: unknown }> {
  let fresh: Awaited<ReturnType<typeof callTool>>['raw']
  try {
    // C1 — the tool may know which approval it is re-checking
    fresh = (await callTool(systemPrincipal('approval-recheck'), toolName, args, { approvalId })).raw
  } catch (err) {
    // A re-check that cannot run is not permission to proceed.
    return { ok: false, why: `it could not be re-checked: ${String(err)}` }
  }
  if (!fresh.ok) return { ok: false, why: fresh.error ?? 'it is no longer a valid action' }
  return { ok: true, why: null, preview: fresh.preview, data: fresh.data }
}

/**
 * The material fields (MATERIAL_PREVIEW_FIELDS) of a tool that differ between the preview approved and a fresh one, each
 * as the sentence the re-check says; empty when none moved. A field the approved preview did not carry is not compared.
 * Pure.
 */
export function movedFields(toolName: string, approved: unknown, now: unknown): string[] {
  const before = (approved ?? {}) as Record<string, unknown>
  const after = (now ?? {}) as Record<string, unknown>
  const moved: string[] = []
  for (const key of MATERIAL_PREVIEW_FIELDS[toolName] ?? []) {
    if (!(key in before)) continue
    if (canonicalJson(before[key]) !== canonicalJson(after[key])) {
      moved.push(
        key.toLowerCase().includes('cents')
          ? `${key} changed from ${money(before[key])} to ${money(after[key])}`
          : `${key} changed from ${JSON.stringify(before[key]) ?? 'none'} to ${JSON.stringify(after[key]) ?? 'none'}`,
      )
    }
  }
  return moved
}

/* ── AP.7: the precedent a decision actually created ───────────────────── */

export interface PrecedentRow {
  charterKey: string
  label: string
  note: string | null
  toolName: string | null
  createdAt: string
}

/**
 * The card promises that a decision "becomes precedent the workers read on
 * their next run". That promise was unverifiable — this makes it visible.
 * Recency-first, matching how the charter prompt actually retrieves them.
 */
export async function recentPrecedents(limit = 20): Promise<PrecedentRow[]> {
  const rows = await prisma.agentExemplar.findMany({
    where: { active: true },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 100),
    select: {
      charterKey: true,
      label: true,
      operatorNote: true,
      situation: true,
      createdAt: true,
    },
  })
  return rows.map((r) => ({
    charterKey: r.charterKey,
    label: r.label,
    note: r.operatorNote,
    toolName: (r.situation as { toolName?: string } | null)?.toolName ?? null,
    createdAt: r.createdAt.toISOString(),
  }))
}

/* ── AP.8: the track record, against automation bias ───────────────────── */

export interface TrackRecord {
  approved: number
  rejected: number
  total: number
}

/**
 * How this worker's proposals of this kind have fared with you before.
 * Article 14 names automation bias — over-relying on the machine's output —
 * as the thing an oversight interface must counter. A worker whose last six
 * suggestions of this exact kind you rejected deserves a slower read.
 */
export async function trackRecords(): Promise<Record<string, TrackRecord>> {
  const rows = await prisma.agentApproval.findMany({
    where: { status: { in: ['approved', 'executed', 'rejected'] } },
    select: { toolName: true, status: true, agentRunId: true },
  })
  const runs = await prisma.agentRun.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.agentRunId))] } },
    select: { id: true, agentKey: true },
  })
  const keyOf = new Map(runs.map((r) => [r.id, r.agentKey]))
  const out: Record<string, TrackRecord> = {}
  for (const r of rows) {
    const k = `${keyOf.get(r.agentRunId) ?? 'unknown'}::${r.toolName}`
    const rec = (out[k] ??= { approved: 0, rejected: 0, total: 0 })
    if (r.status === 'rejected') rec.rejected++
    else rec.approved++
    rec.total++
  }
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
/**
 * MCP full control d1 = A — the fleet's ads tools now execute once approved. A request of one of them made BEFORE
 * that switch was approved-as-a-record, never as a write: it carries no stored live reach (`preview.reach`). It must
 * not start running because the tool changed under it, so it expires here, and the tool's own `execute` refuses it
 * too (ads-change-kit.ts PRE_SWITCH_REFUSAL) should a person approve it before this sweep runs.
 */
export async function expirePreSwitchAdRequests(): Promise<number> {
  const executable = FLEET_TOOLS.filter((name) => typeof getTool(name)?.execute === 'function')
  if (!executable.length) return 0
  const stale = await prisma.agentApproval.findMany({
    where: { status: 'pending', toolName: { in: executable } },
    select: { id: true, preview: true },
  })
  const ids = stale
    .filter((row) => !((row.preview ?? null) as { reach?: unknown } | null)?.reach)
    .map((row) => row.id)
  if (!ids.length) return 0
  const expired = await prisma.agentApproval.updateMany({
    where: { id: { in: ids }, status: 'pending' },
    data: {
      status: 'expired',
      reason: 'expired: asked before approved ad changes could reach Amazon. Ask again to see where it would land.',
    },
  })
  return expired.count
}

export async function runApprovalMaintenance(): Promise<{
  expired: number
  committed: number
  failed: number
  /** C6 — plans handed to the worker again, or run here when there is none. */
  plans: number
}> {
  const now = new Date()

  const expiredByClock = await prisma.agentApproval.updateMany({
    where: { status: 'pending', expiresAt: { not: null, lt: now } },
    data: { status: 'expired' },
  })
  const expired = { count: expiredByClock.count + (await expirePreSwitchAdRequests()) }

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

  // C6 — a plan handed over and not finished: queued again, or (no workers) run here.
  const plans = await drainPlans().catch((err) => {
    logger.error('[naf-ap] plan drain failed', { error: String(err) })
    return 0
  })

  if (expired.count || committed || failed || plans) {
    logger.info('[naf-ap] approval maintenance', {
      expired: expired.count,
      committed,
      failed,
      plans,
    })
  }
  return { expired: expired.count, committed, failed, plans }
}

/* ── AP.4: bulk, with the blast radius stated ──────────────────────────── */

export interface BulkPreview {
  count: number
  /** One sentence naming what this will do, before it does it. */
  sentence: string
  byTool: Record<string, number>
  highRisk: number
  irreversible: number
  /**
   * S8.1 — counted separately from `irreversible` so the sentence can say
   * "partly" instead of rounding it up to "not at all", which would over-warn.
   * Since the Owner's decision 1 = A (2026-10-05) a bulk approve of a partly
   * reversible kind can proceed, so its prose is reachable now.
   */
  partlyReversible: number
  /**
   * NAF.AQ.6 — the money, where it can be computed HONESTLY. Null when it
   * cannot: a fabricated euro figure on a confirmation is worse than none,
   * because it is the number the operator will remember.
   */
  euro: { amount: number; label: string } | null
  /**
   * UiPath's rule, and the single most transferable safety constraint found in
   * the research: bulk is permitted only across structurally identical items —
   * same worker, same action. It is what stops "approve all" spanning a €0.02
   * bid nudge and a customer email.
   */
  homogeneous: boolean
  /**
   * Set when the bulk decision is refused: an APPROVE that breaks a bulk rule (two kinds, two workers, a kind that is
   * never approved together — bulk-approve-policy.ts), or more than BULK_MAX_IDS at once (either verb). Rejecting a
   * mixed set stays fine.
   */
  blockedReason: string | null
}

/*
 * S8.1 / MCP full control C1 — reversibility comes from ONE place: the tool registry (`AgentTool.reversibility`).
 *
 * It used to be two lists here and a third copy in the web card (DecisionCard.tsx `undoable`), and they drifted
 * (`publish-listing` was `partial` on the card and fully reversible here). Now the API states it on every approval
 * row (`reversibility`, below) and the web reads that; nothing else states it. A tool the registry does not know —
 * or one that states nothing — is treated as irreversible, the safe direction to be wrong in.
 */
export function reversibilityOf(toolName: string): Reversibility {
  return getTool(toolName)?.reversibility ?? 'none'
}

/**
 * What a bulk decision is about to do, in a sentence. Built server-side from
 * the rows themselves, so the confirmation cannot drift from the action.
 */
/**
 * The euro exposure of a set of proposals, computed per tool from the preview
 * the operator was shown — never estimated, never modelled.
 *
 * Only bid changes and price changes yield an honest figure today. A negative
 * keyword saves money in a way nobody can put a number on before the fact, and
 * saying "€0.00" about it would be a lie of precision.
 */
function euroExposure(
  rows: Array<{ toolName: string; preview: unknown }>,
): { amount: number; label: string } | null {
  let bidDeltaCents = 0
  let bidCount = 0
  let priceDeltaCents = 0
  let priceCount = 0
  // MCP full control A6 — a daily budget change, euros only (each campaign keeps its own currency).
  let budgetDeltaCents = 0
  let budgetCount = 0

  for (const r of rows) {
    const p = (r.preview ?? {}) as Record<string, any>
    if (r.toolName === 'set-target-bid') {
      // MCP full control A4 — the bid that lands (after the clamps), and only in euros: a bid in pounds or kronor
      // added to one in euros is not a figure (each campaign keeps its own currency; nothing is converted).
      if (p.currency != null && p.currency !== 'EUR') return null
      const from = typeof p.currentBidCents === 'number' ? p.currentBidCents : null
      const to = typeof p.effectiveBidCents === 'number' ? p.effectiveBidCents : typeof p.proposedBidCents === 'number' ? p.proposedBidCents : null
      if (from != null && to != null) {
        bidDeltaCents += to - from
        bidCount++
      }
    }
    if (r.toolName === 'bulk-ad-bid-change') {
      // A7 — the per-click total of a bulk bid change, euros only.
      const byCurrency = (p.byCurrency ?? {}) as Record<string, { targets?: number; deltaCents?: number }>
      if (Object.keys(byCurrency).some((cur) => cur !== 'EUR')) return null
      if (byCurrency.EUR && typeof byCurrency.EUR.deltaCents === 'number') {
        bidDeltaCents += byCurrency.EUR.deltaCents
        bidCount += byCurrency.EUR.targets ?? 0
      }
    }
    if (r.toolName === 'set-campaign-budget') {
      if (p.currency != null && p.currency !== 'EUR') return null
      if (typeof p.currentBudgetCents === 'number' && typeof p.proposedBudgetCents === 'number') {
        budgetDeltaCents += p.proposedBudgetCents - p.currentBudgetCents
        budgetCount++
      }
    }
    if (r.toolName === 'set-price') {
      const ch = p.changes?.['base price']
      if (ch && typeof ch.from === 'number' && typeof ch.to === 'number') {
        priceDeltaCents += Math.round((ch.to - ch.from) * 100)
        priceCount++
      }
    }
  }

  if (budgetCount > 0 && bidCount === 0 && priceCount === 0) {
    const dir = budgetDeltaCents >= 0 ? 'raises' : 'lowers'
    return {
      amount: budgetDeltaCents,
      // A daily ceiling, not spend: what is spent depends on the auctions.
      label: `${dir} daily budgets by €${Math.abs(budgetDeltaCents / 100).toFixed(2)} in total across ${budgetCount} campaign${budgetCount === 1 ? '' : 's'}`,
    }
  }
  if (bidCount > 0 && priceCount === 0 && budgetCount === 0) {
    const dir = bidDeltaCents >= 0 ? 'raises' : 'lowers'
    return {
      amount: bidDeltaCents,
      // Deliberately "per click", not "per day": a bid is a ceiling on one
      // click, and calling it daily spend would invent a volume nobody knows.
      label: `${dir} what you pay per click by €${Math.abs(bidDeltaCents / 100).toFixed(2)} in total across ${bidCount} keyword${bidCount === 1 ? '' : 's'}`,
    }
  }
  if (priceCount > 0 && bidCount === 0 && budgetCount === 0) {
    const dir = priceDeltaCents >= 0 ? 'raises' : 'lowers'
    return {
      amount: priceDeltaCents,
      label: `${dir} your prices by €${Math.abs(priceDeltaCents / 100).toFixed(2)} in total across ${priceCount} product${priceCount === 1 ? '' : 's'}`,
    }
  }
  return null
}

/** One selected request, as a bulk decision reads it. */
interface BulkRow {
  id: string
  toolName: string
  riskTier: string
  preview: unknown
  status: string
  agentRun: { agentKey: string } | null
}

async function bulkRows(ids: string[]): Promise<BulkRow[]> {
  return (await prisma.agentApproval.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      toolName: true,
      riskTier: true,
      preview: true,
      status: true,
      // One query, via the relation — the same idiom `charterKeyOf` uses just
      // above. A second `agentRun.findMany` worked but cost an extra round
      // trip to learn something the join already knows.
      agentRun: { select: { agentKey: true } },
    },
  })) as BulkRow[]
}

const tooMany = (n: number) =>
  `You selected ${n}; at most ${BULK_MAX_IDS} can be decided at once. Decide them in smaller groups.`

/**
 * What a bulk decision would do, before it does it. `viewer` (the person looking, null for a caller who is not a
 * person): on an approve, the rows they may not approve are counted out and named, exactly as bulkDecide skips them.
 */
export async function previewBulk(
  ids: string[],
  decision: 'approve' | 'reject',
  viewer?: ToolPrincipal | null,
): Promise<BulkPreview> {
  const unique = [...new Set(ids)]
  if (unique.length > BULK_MAX_IDS) {
    const why = tooMany(unique.length)
    return { count: 0, sentence: why, byTool: {}, highRisk: 0, irreversible: 0, partlyReversible: 0, euro: null, homogeneous: false, blockedReason: why }
  }
  return bulkPreviewOf(await bulkRows(unique), decision, viewer)
}

/** A kind as the page names it: the registry title ("Set master price"), never the tool id ("set price"). */
const kindTitle = (toolName: string): string => getTool(toolName)?.title ?? toolName.replace(/-/g, ' ')

function bulkPreviewOf(
  all: BulkRow[],
  decision: 'approve' | 'reject',
  viewer?: ToolPrincipal | null,
): BulkPreview {
  /*
   * AQ.6, after a test caught me getting this wrong.
   *
   * The study claimed a selection containing a PARKED row "under-reports its
   * blast radius", and the first version of this widened the query to include
   * `scheduled`. That is wrong: a parked row is already approved and counting
   * down. It is not part of THIS decision, and counting it would over-report
   * just as badly as omitting it under-reported.
   *
   * The honest answer is neither. Count what this decision will actually do —
   * the pending rows — and if the selection contains anything else, SAY so,
   * rather than silently dropping it and leaving the operator to wonder why
   * three selected became two.
   */
  const rows = all.filter((r) => r.status === 'pending')

  /*
   * S8.1 — same WORKER, not just same action kind.
   *
   * The comment below used to say same-worker was "enforced by the caller's
   * grouping today". That is a UI convention, not an invariant: the endpoint
   * takes a list of ids and will happily preview any mixture, so the guarantee
   * held only for as long as every caller grouped first. UiPath's rule is the
   * one worth copying — same action type AND same producing version — and this
   * is the half of it the data supports today.
   *
   * The worker lives on the run, exactly as `charterKey` does everywhere else
   * on this page; the approval itself stays free of the concept.
   */
  const workers = new Set(rows.map((r) => r.agentRun?.agentKey ?? 'unknown'))
  const sameWorker = workers.size <= 1
  const kinds = [...new Set(rows.map((r) => r.toolName))]

  /*
   * Approvals grid, Owner decision 1 = A (2026-10-05) — replaces S8.4.
   *
   * S8.4 refused a bulk approve containing any row that can execute, which since every Claude and fleet tool executes
   * meant a bulk approve could never succeed. The Owner chose: bulk approve for rows of the SAME kind (and the same
   * worker, above), never for a kind that cannot be undone, reaches a buyer or a supplier, spends money or removes
   * something, and never for a change plan (bulk-approve-policy.ts names each with its why).
   *
   * What made S8.4 worth having is kept: a bulk approve is not a shortcut past any check. Each row goes through exactly
   * the path a single approve takes (decideFleetApproval → the claim with the approver's permission → the 20-second
   * stop window → the commit, which re-checks staleness against MATERIAL_PREVIEW_FIELDS, the approver's permission now
   * and the rule). A row whose facts moved is handed back, never run. Asked of the live registry, so a kind that loses
   * its undo is caught the day it does.
   *
   * Approve only. Rejecting many is always safe and is the operator's escape
   * hatch — refusing it would be friction with no hazard behind it.
   */
  const kindRefusal = decision === 'approve' ? (kinds.map(bulkApproveRefusal).find((why) => why) ?? null) : null

  // Homogeneity: one action kind AND one worker. Either alone is insufficient
  // — two workers proposing the same kind of change are still two different
  // things to agree with, and that is the case the caller's grouping used to
  // hide rather than prevent.
  const homogeneous = kinds.length <= 1 && sameWorker
  const blockedReason =
    decision === 'approve' && kinds.length > 1
      ? `These are ${kinds.length} different kinds of action (${kinds
          .map(kindTitle)
          .join(', ')}). Approve one kind at a time — a single yes should never span two different consequences.`
      : decision === 'approve' && !sameWorker
        ? `These come from ${workers.size} different workers. Approve one worker at a time — a single yes should never span two workers' judgement.`
        : kindRefusal

  /*
   * Per row, never for the whole call: a row this viewer may not approve (their permissions do not cover its tool) is
   * left out with its reason — the very sentence a single approve would answer with — and the rest go ahead.
   */
  const notYours = decision === 'approve' && viewer !== undefined ? cannotApproveFor(viewer) : null
  const theirs = notYours ? rows.filter((r) => notYours(r.toolName)) : []
  const mayApprove = notYours ? rows.filter((r) => !notYours(r.toolName)) : rows
  // W1-3 — a raise is approved on its own, with the approver's authenticator code: never in a bulk approve.
  const coded = decision === 'approve' ? mayApprove.filter((r) => stepUpOf(r.preview)) : []
  const acting = coded.length ? mayApprove.filter((r) => !coded.includes(r)) : mayApprove

  const notActionable = all.length - rows.length
  const byTool: Record<string, number> = {}
  for (const r of acting) byTool[r.toolName] = (byTool[r.toolName] ?? 0) + 1
  const highRisk = acting.filter((r) => r.riskTier === 'high').length
  const irreversible = acting.filter((r) => reversibilityOf(r.toolName) === 'none').length
  const partlyReversible = acting.filter((r) => reversibilityOf(r.toolName) === 'partial').length
  const euro = euroExposure(acting)

  const kindsClause = Object.entries(byTool)
    .map(([tool, n]) => `${n} × ${kindTitle(tool)}`)
    .join(', ')
  const verb = decision === 'approve' ? 'approves' : 'rejects'
  const money = euro ? ` It ${euro.label}.` : ''
  // Never silently drop a selected row.
  const skipped =
    notActionable > 0
      ? ` ${notActionable} other${notActionable === 1 ? '' : 's'} you selected ${notActionable === 1 ? 'is' : 'are'} already decided or counting down, and ${notActionable === 1 ? 'is' : 'are'} not affected.`
      : ''
  const notYoursWhy = theirs.length ? notYours!(theirs[0].toolName) : null
  const codedWhy = coded.length ? needsCodeWhy(stepUpOf(coded[0].preview)!, coded.length) : null
  const leftOut =
    (theirs.length > 0
      ? ` ${theirs.length} you may not approve ${theirs.length === 1 ? 'is' : 'are'} left out: ${notYoursWhy}`
      : '')
    + (coded.length > 0 ? ` ${coded.length} ${coded.length === 1 ? 'is' : 'are'} left out: ${codedWhy}` : '')
  /*
   * S8.1 — reversibility, said EITHER WAY.
   *
   * The spec's complaint was that the server computes `irreversible` and never
   * speaks it. So the sentence states the reversibility of the batch in every
   * case. "All of these can be put back" is the common answer and it is worth
   * reading: it is the fact that makes a bulk yes reasonable at all.
   *
   * Since decision 1 = A, "only partly undone" is reachable on an approve (a
   * partly reversible kind may be approved together). "Cannot be undone" is
   * not: such a kind is refused above, so the branch speaks only if that
   * policy is ever relaxed — and then it is already correct rather than
   * silently reassuring.
   */
  const reversibility =
    irreversible > 0
      ? ` ${irreversible} of them cannot be undone once ${irreversible === 1 ? 'it runs' : 'they run'}.`
      : partlyReversible > 0
        ? ` ${partlyReversible} of them can only be partly undone.`
        : ' All of these can be put back.'
  const tail =
    decision === 'approve'
      ? `${highRisk > 0 ? ` — ${highRisk} of them high risk` : ''}.${money}${reversibility} You have 20 seconds to take it back.`
      : ''

  return {
    count: acting.length,
    sentence:
      all.length === 0
        ? 'Nothing is selected.'
        : rows.length === 0
          ? `Nothing here can be decided — ${all.length === 1 ? 'the one you selected has' : `all ${all.length} you selected have`} already been decided or ${all.length === 1 ? 'is' : 'are'} counting down.`
          : blockedReason
            ? blockedReason
            : acting.length === 0
              ? theirs.length
                ? `You may not approve ${rows.length === 1 ? 'this one' : `any of these ${rows.length}`}: ${notYoursWhy}${coded.length ? ` ${coded.length} ${coded.length === 1 ? 'is' : 'are'} left out: ${codedWhy}` : ''}`
                : `${rows.length === 1 ? 'This one is' : `None of these ${rows.length} is`} approved in a bulk approve: ${codedWhy}`
              : // The kinds clause takes its own full stop only when nothing
                // follows it. The shipped version always added one and then began
                // the tail with an em-dash, producing "…set target bid. — 2 of
                // them high risk." — a period followed by a dash, which reads as a
                // typo on the one sentence that has to be trusted.
                `This ${verb} ${acting.length} action${acting.length === 1 ? '' : 's'}: ${kindsClause}${tail ? '' : '.'}${tail}${skipped}${leftOut}`,
    byTool,
    highRisk,
    irreversible,
    partlyReversible,
    euro,
    homogeneous,
    blockedReason,
  }
}

/** W1-3 — why a raise stays out of a bulk approve: it is approved on its own, with the approver's code. */
function needsCodeWhy(stepUp: StepUp, count = 1): string {
  const raises = stepUp.raises.length ? ` (${stepUp.raises.join(', ')})` : ''
  return count === 1
    ? `it ${stepUp.what}${raises}, so it is approved on its own, with your authenticator code.`
    : `each ${stepUp.what}, so each is approved on its own, with your authenticator code.`
}

/** The plain reason a selected row was not decided. */
const NOT_FOUND = 'Nexus cannot find this request in this business.'
const STATUS_WORDS: Record<string, string> = {
  scheduled: 'already approved and counting down',
  executing: 'already running',
  executed: 'already done',
  approved: 'already approved',
  rejected: 'already rejected',
  expired: 'expired',
  superseded: 'replaced by an edited request',
}
const alreadyWhy = (status: string) => `Not decided: it is ${STATUS_WORDS[status] ?? `already ${status}`}.`
function plainDecideError(error: string | undefined): string {
  if (!error) return 'It could not be decided.'
  if (error === 'approval not found') return NOT_FOUND
  const already = /^already (\w+)$/.exec(error)
  return already ? alreadyWhy(already[1]) : error
}

/** bulk-decide's answer: the queue contract, plus the old page's `failed` until the clean-up wave removes that page. */
export type BulkDecideResult = QueueBulkResult & {
  /** The reasons of `skipped`, in order (the old Approvals page reads this field). */
  failed: string[]
}

export async function bulkDecide(input: {
  ids: string[]
  decision: 'approve' | 'reject'
  /** Optional: the person's words. Without them each rejected row says who rejected it. */
  reason?: string
  actor: ToolPrincipal
}): Promise<BulkDecideResult> {
  const ids = [...new Set(input.ids)]
  const of = ids.length
  const refused = (error: string): BulkDecideResult => ({ ok: false, done: 0, of, skipped: [], failed: [], error })
  if (of === 0) return refused('Nothing is selected.')
  if (of > BULK_MAX_IDS) return refused(tooMany(of))

  const rows = await bulkRows(ids)
  // NAF.AQ.6 — the bulk rule is enforced HERE, not only in the confirmation.
  // A preview a client can choose not to read is a suggestion; the rule has to
  // hold for anything that calls this, including the next caller nobody has
  // written yet. Same rows, same function as the preview, so the two agree.
  //
  // Approve only. Rejecting a mixed set is safe — saying no to forty different
  // things at once cannot hurt anyone — and blocking it would be friction on
  // the safe path, which is the asymmetry AQ.4 exists to remove.
  if (input.decision === 'approve') {
    const check = bulkPreviewOf(rows, 'approve', input.actor)
    if (check.blockedReason) return refused(check.blockedReason)
  }

  const byId = new Map(rows.map((r) => [r.id, r]))
  const notYours = input.decision === 'approve' ? cannotApproveFor(input.actor) : null
  const skipped: Array<{ id: string; why: string }> = []
  let done = 0
  for (const id of ids) {
    const row = byId.get(id)
    if (!row) {
      skipped.push({ id, why: NOT_FOUND })
      continue
    }
    if (row.status !== 'pending') {
      skipped.push({ id, why: alreadyWhy(row.status) })
      continue
    }
    const notTheirs = notYours?.(row.toolName)
    if (notTheirs) {
      skipped.push({ id, why: notTheirs })
      continue
    }
    // W1-3 — a raise is approved on its own, with the approver's code (decideFleetApproval would refuse it without one).
    const stepUp = input.decision === 'approve' ? stepUpOf(row.preview) : null
    if (stepUp) {
      const why = needsCodeWhy(stepUp)
      skipped.push({ id, why: `Not approved: ${why}` })
      continue
    }
    // Exactly the path of a single decision: an approve is claimed with the approver's permissions and parked for the
    // stop window; the commit after it re-checks the facts, the approver and the rule, row by row.
    const out = await decideFleetApproval({
      id,
      decision: input.decision,
      reason: input.reason,
      actor: input.actor,
    })
    if (out.ok) done++
    else skipped.push({ id, why: plainDecideError(out.error) })
  }
  return { ok: true, done, of, skipped, failed: skipped.map((s) => s.why) }
}

export async function rejectAllForCharter(input: {
  charterKey: string
  reason: string
  actor: ToolPrincipal
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
