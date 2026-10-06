/**
 * MCP full control C6 — change plans: up to 200 changes approved once (section 05 §3.1).
 *
 *   queue    every step is dry-run as the person through the one door (callTool: permissions, business, arguments,
 *            preview). All must preview, or nothing is stored and each step's refusal comes back. Then ONE approval
 *            (toolName submit-change-plan, a Nexus-written one-line summary, a planHash of the title and steps) and one
 *            AgentPlanStep per step (its args and raw preview). The door's rule decides who takes it: a person, or —
 *            only when every step may — the business's rule (claude-trust.service.ts).
 *   approve  a person needs the permissions of every step (approval-inbox.service.ts scheduleApproval). The normal undo
 *            window follows; the commit hands the plan to the worker (job agent-plan-<approvalId>).
 *   run      `runPlan`, step by step in order: claim (pending → executing); the approver's permissions for that step's
 *            tool re-checked now; the step's preview re-checked (staleness, as for any approval); a rule-run re-checks
 *            the rule. Then the tool's execute as the approver, and its change recorded (AgentChange.planStepId). A stale
 *            or refused step is skipped with its reason, a failing one is failed; the others go on. The pending steps
 *            are the durable record: a stopped worker resumes there; a step left `executing` past a lease is marked
 *            failed (it may or may not have run — never run twice); the approval sweep re-enqueues a plan nobody runs,
 *            or runs it itself when there are no workers.
 *   amend    unticking steps supersedes a waiting plan with a smaller one, re-checked as the person (the AQ.8 amend rule).
 *
 * Everything is business-scoped by the row-level policies: a plan, its steps and its changes are its business's.
 */

import { createHash } from 'node:crypto'
import { Prisma } from '@nexus/database'
import prisma from '../../db.js'
import { addJobSafely, agentPlanQueue } from '../../lib/queue.js'
import { logger } from '../../utils/logger.js'
import { recordControlChange, type ControlAction } from '../agent-fleet/control-audit.service.js'
import { deciderPrincipal, previewStaleness } from '../agent-fleet/approval-inbox.service.js'
import { decideByRule, EXPIRY_HOURS, requestDoor, type GateOutcome, type GateRule } from './approval-gate.service.js'
import { callTool, executeTool, ToolAccessError, type ToolPrincipal, type UserPrincipal } from './call-tool.js'
import { recordExecutedChangeSafely } from './change-record.service.js'
import { autoPlanStepRefusal, noteAutoFailure } from './claude-trust.service.js'
import { resolveToolPolicy } from './tool-policy.service.js'
import { getTool } from './tool-registry.js'
import { PLAN_MAX_STEPS, PLAN_TOOL, type AgentTool, type PlanRequest, type ToolRequest } from './tool-types.js'

/** How many steps a preview lists in full; the rest are counted. */
const PREVIEW_STEPS = 20
/** A step still `executing` this long after it started belongs to a worker that stopped. */
const INTERRUPTED_AFTER_MS = 10 * 60_000
/** A plan with no step started or ended for this long, and workers on, is re-enqueued by the sweep. */
const STUCK_AFTER_MS = 2 * 60_000

export interface PlanRefusal {
  step: number
  tool: string
  error: string
}

/** One kind of consequence: every step of one tool. The plan card asks one tick per kind. */
export interface PlanKind {
  tool: string
  title: string
  count: number
  /** Its changes reach a marketplace or a buyer. */
  outbound: boolean
  reversibility: string
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function canonical(value: unknown): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]))
        : v
  return JSON.stringify(sorted(JSON.parse(JSON.stringify(value ?? null))))
}

/** sha256 of the plan's title and steps, whatever the order of each object's keys. */
export function planHashOf(plan: { title: string; steps: ToolRequest[] }): string {
  return createHash('sha256')
    .update(canonical({ title: plan.title, steps: plan.steps.map((step) => ({ tool: step.tool, args: step.args ?? {} })) }))
    .digest('hex')
}

/** The kinds of consequence, in the order their first step comes. */
export function kindsOf(tools: AgentTool[]): PlanKind[] {
  const kinds = new Map<string, PlanKind>()
  for (const tool of tools) {
    const kind = kinds.get(tool.name)
    if (kind) kind.count++
    else kinds.set(tool.name, { tool: tool.name, title: tool.title, count: 1, outbound: !!tool.openWorld, reversibility: tool.reversibility ?? 'none' })
  }
  return [...kinds.values()]
}

/** The one line Nexus writes about a plan: how many changes of which kind, and how many reach outside Nexus. */
export function planSummary(kinds: PlanKind[]): string {
  const total = kinds.reduce((n, kind) => n + kind.count, 0)
  const outbound = kinds.filter((kind) => kind.outbound).reduce((n, kind) => n + kind.count, 0)
  const parts = kinds.map((kind) => `${kind.count} × ${kind.title}`).join(', ')
  const reach = outbound === 0
    ? 'None reaches a marketplace or a buyer.'
    : outbound === total
      ? `${total === 1 ? 'It reaches' : 'All reach'} a marketplace or a buyer.`
      : `${outbound} of them reach a marketplace or a buyer.`
  return `${plural(total, 'change')}: ${parts}. ${reach}`
}

/**
 * Store a plan as ONE request — or nothing, with each step's refusal. Every step is dry-run as the principal through
 * the one door, exactly as if it were asked for alone; a read, a control tool, a preview-only or a disabled tool cannot
 * be a step, nor one the door's rule turned off.
 */
export async function queuePlan(
  plan: PlanRequest,
  principal: ToolPrincipal,
  agentRunId: string,
  opts: { rule?: GateRule } = {},
): Promise<GateOutcome> {
  const title = (plan.title ?? '').trim().slice(0, 120)
  if (!title || !plan.steps?.length) return { ok: false, mode: 'error', error: 'A plan needs a title and at least one step. Nothing was queued.' }
  if (plan.steps.length > PLAN_MAX_STEPS) {
    return { ok: false, mode: 'error', error: `A plan holds at most ${PLAN_MAX_STEPS} steps; this one has ${plan.steps.length}. Nothing was queued.` }
  }
  const planTool = getTool(PLAN_TOOL)!
  const refusals: PlanRefusal[] = []
  const checked: Array<{ tool: AgentTool; args: Record<string, unknown>; raw: unknown; visible: unknown; undoes: string | null }> = []
  for (const [index, step] of plan.steps.entries()) {
    const refuse = (error: string) => refusals.push({ step: index + 1, tool: step.tool, error })
    const tool = getTool(step.tool)
    if (!tool || tool.readOnly || tool.control || !tool.execute) {
      refuse(`${step.tool} is not a change a plan can run (a read, a control tool, a preview-only or an unknown tool)`)
      continue
    }
    const policy = await resolveToolPolicy(step.tool)
    if (!policy?.enabled) {
      refuse(`tool ${step.tool} is disabled`)
      continue
    }
    const off = opts.rule ? await opts.rule.refusal(tool, step.args ?? {}) : null
    if (off) {
      refuse(off)
      continue
    }
    try {
      const call = await callTool(principal, step.tool, step.args ?? {})
      if (!call.raw.ok) {
        refuse(call.raw.error ?? 'refused')
        continue
      }
      checked.push({
        tool,
        args: step.args ?? {},
        raw: call.raw.preview ?? call.raw.data ?? null,
        visible: call.visible.preview ?? call.visible.data ?? null,
        undoes: plan.undoes?.[index] || null,
      })
    } catch (error) {
      if (!(error instanceof ToolAccessError)) throw error
      refuse(error.message)
    }
  }
  if (refusals.length) {
    const shown = refusals.slice(0, 3).map((r) => `step ${r.step} (${r.tool}): ${r.error}`).join('; ')
    return {
      ok: false,
      mode: 'error',
      error:
        `The plan was not stored: ${refusals.length} of ${plural(plan.steps.length, 'step')} ${refusals.length === 1 ? 'was' : 'were'} refused — ` +
        `${shown}${refusals.length > 3 ? `; and ${refusals.length - 3} more` : ''}. Fix them and submit it again; nothing was queued.`,
      refusals,
    }
  }

  const kinds = kindsOf(checked.map((c) => c.tool))
  const summary = planSummary(kinds)
  const planHash = planHashOf({ title, steps: plan.steps })
  const outbound = kinds.filter((kind) => kind.outbound).reduce((n, kind) => n + kind.count, 0)
  const preview = { action: PLAN_TOOL, title, summary, kinds, totals: { steps: checked.length, reachOutside: outbound } }
  const approval = await prisma.$transaction(async (tx) => {
    const created = await tx.agentApproval.create({
      data: {
        agentRunId,
        toolName: PLAN_TOOL,
        riskTier: 'high',
        args: { title, steps: checked.length } as Prisma.InputJsonValue,
        preview: preview as unknown as Prisma.InputJsonValue,
        summary,
        planHash,
        status: 'pending',
        expiresAt: new Date(Date.now() + EXPIRY_HOURS * 3600 * 1000),
      },
    })
    await tx.agentPlanStep.createMany({
      data: checked.map((step, index) => ({
        approvalId: created.id,
        position: index + 1,
        toolName: step.tool.name,
        args: step.args as Prisma.InputJsonValue,
        preview: step.raw == null ? Prisma.JsonNull : (step.raw as Prisma.InputJsonValue),
        undoesChangeId: step.undoes,
      })),
    })
    return created
  })
  const rule = opts.rule
    ? await decideByRule(opts.rule, { approvalId: approval.id, tool: planTool, preview, steps: checked.map((c) => ({ tool: c.tool, preview: c.raw, args: c.args })) })
    : undefined
  return {
    ok: true,
    mode: 'queued',
    approvalId: approval.id,
    expiresAt: approval.expiresAt,
    preview: {
      title,
      summary,
      kinds,
      steps: checked.slice(0, PREVIEW_STEPS).map((step, index) => ({ step: index + 1, tool: step.tool.name, preview: step.visible })),
      ...(checked.length > PREVIEW_STEPS ? { moreSteps: checked.length - PREVIEW_STEPS } : {}),
    },
    plan: { steps: checked.length, summary, planHash },
    ...(rule ? { rule } : {}),
  }
}

// ── Running a plan ─────────────────────────────────────────────────────────────────────────────────────

export interface PlanRunResult {
  /** Steps this run claimed. */
  ran: number
  /** Every step has ended and the approval is executed. */
  finished: boolean
  counts?: Record<string, number>
}

type PlanApproval = {
  id: string
  status: string
  toolName: string
  decidedBy: string | null
  decidedByUserId: string | null
  workspaceId: string
  decisionVia: string | null
  agentRun: { via: string | null; mode: string | null; oauthGrantId: string | null; agentKey: string } | null
}

type StepRow = { id: string; position: number; toolName: string; args: Prisma.JsonValue; preview: Prisma.JsonValue; undoesChangeId: string | null }

async function stepAudit(ap: PlanApproval, step: StepRow, action: ControlAction, note: string): Promise<void> {
  await recordControlChange({
    charterKey: ap.agentRun?.agentKey ?? 'unknown',
    action,
    to: { approvalId: ap.id, step: step.position, tool: step.toolName, ...(ap.decisionVia ? { decisionVia: ap.decisionVia } : {}) },
    note,
    actor: ap.decidedBy ?? 'unattributed',
  })
}

/** One step: re-checked, then run as the approver; its fate on its row. Never throws. */
async function runStep(ap: PlanApproval, step: StepRow): Promise<void> {
  const end = (status: 'done' | 'skipped' | 'failed', data: { reason?: string | null; changeId?: string | null } = {}) =>
    prisma.agentPlanStep.update({ where: { id: step.id }, data: { status, endedAt: new Date(), ...data } })
  const auto = ap.decisionVia === 'auto'
  try {
    // C5 — a plan run by the rule stops running by it the moment the business pauses or lowers a step's level.
    if (auto) {
      const ruleNow = await autoPlanStepRefusal(step.toolName, step.preview, step.args)
      if (ruleNow) {
        await end('skipped', { reason: `not run — ${ruleNow}` })
        await stepAudit(ap, step, 'rule_refused', ruleNow)
        return
      }
    }
    // The approver, as they are NOW in this business, with this step's tool's permissions.
    const decider = await deciderPrincipal({ ...ap, toolName: step.toolName })
    if ('refusal' in decider) {
      await end('skipped', { reason: `not run — ${decider.refusal}` })
      await stepAudit(ap, step, 'permission_refused', decider.refusal)
      if (auto) await noteAutoFailure()
      return
    }
    const args = (step.args ?? {}) as Record<string, unknown>
    const stale = await previewStaleness(step.toolName, args, step.preview, ap.id)
    if (stale.stale) {
      const why = stale.why ?? 'it is no longer a valid action'
      await end('skipped', { reason: `not run — ${why}` })
      await stepAudit(ap, step, 'stale_refused', why)
      if (auto) await noteAutoFailure()
      return
    }
    const tool = getTool(step.toolName)!
    const { raw } = await executeTool(decider.principal, step.toolName, args, {
      approvalId: ap.id,
      approvedPreview: step.preview ?? undefined,
      via: requestDoor(ap.agentRun),
    })
    if (!raw.ok) {
      const why = raw.error ?? 'the tool refused it'
      await end('failed', { reason: `execution failed: ${why}` })
      await stepAudit(ap, step, 'execution_failed', why)
      if (auto) await noteAutoFailure()
      return
    }
    const changeId = await recordExecutedChangeSafely({
      approvalId: ap.id,
      planStepId: step.id,
      undoesChangeId: step.undoesChangeId,
      tool,
      raw,
      via: requestDoor(ap.agentRun) ?? 'app',
      oauthGrantId: ap.agentRun?.oauthGrantId ?? null,
      executedByUserId: decider.principal.userId,
      decisionVia: ap.decisionVia,
    })
    await end('done', { changeId })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error('[agent-plan] a step failed', { approvalId: ap.id, step: step.position, tool: step.toolName, error: message })
    await end('failed', { reason: `execution error: ${message.slice(0, 300)}` }).catch(() => undefined)
    await stepAudit(ap, step, 'execution_failed', message.slice(0, 300)).catch(() => undefined)
    if (auto) await noteAutoFailure()
  }
}

/**
 * Run a plan the commit handed over (status executing): every pending step, in order. Safe to call twice at once and
 * again after a stop: a step is claimed before it runs, and only pending steps are claimed. `maxSteps` stops early (as a
 * worker that stops would).
 */
export async function runPlan(approvalId: string, opts: { maxSteps?: number } = {}): Promise<PlanRunResult> {
  const ap = await prisma.agentApproval.findUnique({
    where: { id: approvalId },
    select: {
      id: true, status: true, toolName: true, decidedBy: true, decidedByUserId: true, workspaceId: true, decisionVia: true,
      agentRun: { select: { via: true, mode: true, oauthGrantId: true, agentKey: true } },
    },
  })
  if (!ap || ap.toolName !== PLAN_TOOL || ap.status !== 'executing') return { ran: 0, finished: false }

  // A step left running by a worker that stopped: it may or may not have changed something. Never run twice.
  await prisma.agentPlanStep.updateMany({
    where: { approvalId, status: 'executing', startedAt: { lt: new Date(Date.now() - INTERRUPTED_AFTER_MS) } },
    data: {
      status: 'failed',
      endedAt: new Date(),
      reason: 'interrupted while it ran (the worker stopped): it may or may not have changed something — check it before running it again',
    },
  })

  let ran = 0
  for (;;) {
    if (opts.maxSteps != null && ran >= opts.maxSteps) return { ran, finished: false }
    const step = await prisma.agentPlanStep.findFirst({
      where: { approvalId, status: 'pending' },
      orderBy: { position: 'asc' },
      select: { id: true, position: true, toolName: true, args: true, preview: true, undoesChangeId: true },
    })
    if (!step) break
    const claimed = await prisma.agentPlanStep.updateMany({ where: { id: step.id, status: 'pending' }, data: { status: 'executing', startedAt: new Date() } })
    if (claimed.count === 0) continue
    ran++
    await runStep(ap, step)
  }

  const open = await prisma.agentPlanStep.count({ where: { approvalId, status: { in: ['pending', 'executing'] } } })
  if (open > 0) return { ran, finished: false }
  const counts = await stepCounts(approvalId)
  const total = Object.values(counts).reduce((n, c) => n + c, 0)
  const notRun = [counts.skipped ? `${counts.skipped} skipped` : '', counts.failed ? `${counts.failed} failed` : ''].filter(Boolean).join(', ')
  await prisma.agentApproval.updateMany({
    where: { id: approvalId, status: 'executing' },
    data: {
      status: 'executed',
      reason: notRun ? `${counts.done ?? 0} of ${total} changes ran; ${notRun}. Each step says why.` : null,
    },
  })
  return { ran, finished: true, counts }
}

async function stepCounts(approvalId: string): Promise<Record<string, number>> {
  const rows = await prisma.agentPlanStep.groupBy({ by: ['status'], where: { approvalId }, _count: { _all: true } })
  return Object.fromEntries(rows.map((row) => [row.status, row._count._all]))
}

/** Hand an approved plan to the worker. False when it could not be queued (no workers): the sweep then runs it. */
export async function enqueuePlan(approvalId: string): Promise<boolean> {
  if (!agentPlanQueue) return false
  const out = await addJobSafely(agentPlanQueue, 'agent-plan', { approvalId }, { jobId: `agent-plan-${approvalId}` })
  return out.enqueued
}

/**
 * The approval sweep's share: a plan handed over and not finished. With workers, one nobody has touched for a while
 * is queued again (the job id keeps one per plan); without, the sweep runs it here. Returns how many it moved.
 */
export async function drainPlans(): Promise<number> {
  const executing = await prisma.agentApproval.findMany({
    where: { toolName: PLAN_TOOL, status: 'executing' },
    select: { id: true, decidedAt: true },
    orderBy: { decidedAt: 'asc' },
    take: 20,
  })
  const since = new Date(Date.now() - STUCK_AFTER_MS)
  let moved = 0
  for (const plan of executing) {
    if (process.env.ENABLE_QUEUE_WORKERS === '1') {
      if (plan.decidedAt && plan.decidedAt > since) continue
      const touched = await prisma.agentPlanStep.findFirst({
        where: { approvalId: plan.id, OR: [{ startedAt: { gte: since } }, { endedAt: { gte: since } }] },
        select: { id: true },
      })
      if (touched) continue
      if (await enqueuePlan(plan.id)) moved++
      continue
    }
    await runPlan(plan.id).catch((error) => logger.error('[agent-plan] the sweep could not run a plan', { approvalId: plan.id, error: String(error) }))
    moved++
  }
  return moved
}

// ── Reading a plan ─────────────────────────────────────────────────────────────────────────────────────

export interface PlanStepView {
  step: number
  tool: string
  title: string
  status: string
  reason: string | null
  changeId: string | null
  undoesChangeId: string | null
  outbound: boolean
  preview?: unknown
  previewHidden?: string
}

export interface PlanView {
  approvalId: string
  status: string
  title: string
  summary: string | null
  planHash: string | null
  kinds: PlanKind[]
  steps: number
  byStatus: Record<string, number>
  list: PlanStepView[]
}

/**
 * A plan as a reader may see it: each step's fate, and (with `storedOutput`) its preview through the reader's money
 * filter. `limit` bounds the list (approval-status shows 20; the Approvals card all of them). Null when it is not a plan.
 */
export async function planView(
  approvalId: string,
  opts: { storedOutput?: (toolName: string, value: unknown) => unknown | null; limit?: number } = {},
): Promise<PlanView | null> {
  const ap = await prisma.agentApproval.findUnique({
    where: { id: approvalId },
    select: { id: true, toolName: true, status: true, args: true, summary: true, planHash: true, preview: true },
  })
  if (!ap || ap.toolName !== PLAN_TOOL) return null
  const steps = await prisma.agentPlanStep.findMany({
    where: { approvalId },
    orderBy: { position: 'asc' },
    take: opts.limit ?? PLAN_MAX_STEPS,
    select: { position: true, toolName: true, status: true, reason: true, changeId: true, undoesChangeId: true, preview: true },
  })
  const all = await stepCounts(approvalId)
  const kinds = ((ap.preview as { kinds?: PlanKind[] } | null)?.kinds ?? []) as PlanKind[]
  return {
    approvalId: ap.id,
    status: ap.status,
    title: String((ap.args as { title?: unknown } | null)?.title ?? ''),
    summary: ap.summary,
    planHash: ap.planHash,
    kinds,
    steps: Object.values(all).reduce((n, c) => n + c, 0),
    byStatus: all,
    list: steps.map((step) => {
      const tool = getTool(step.toolName)
      const view: PlanStepView = {
        step: step.position,
        tool: step.toolName,
        title: tool?.title ?? step.toolName,
        status: step.status,
        reason: step.reason,
        changeId: step.changeId,
        undoesChangeId: step.undoesChangeId,
        outbound: !!tool?.openWorld,
      }
      if (opts.storedOutput && step.preview != null) {
        const visible = opts.storedOutput(step.toolName, step.preview)
        view.preview = visible ?? null
        if (visible == null) view.previewHidden = `The preview needs the permissions of ${step.toolName}.`
      }
      return view
    }),
  }
}

// ── Unticking steps ────────────────────────────────────────────────────────────────────────────────────

export type AmendResult =
  | { ok: true; supersededId: string; approvalId: string }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string; refusals?: PlanRefusal[] }

/**
 * Untick steps of a waiting plan: a NEW, smaller plan of the steps kept, each dry-run again as the person (a step they
 * could not ask for themselves is refused), waiting for a person; the original is superseded. As the AQ.8 amend rule.
 */
export async function amendPlan(approvalId: string, keep: unknown, principal: UserPrincipal): Promise<AmendResult> {
  const original = await prisma.agentApproval.findUnique({
    where: { id: approvalId },
    select: { id: true, toolName: true, status: true, agentRunId: true, args: true },
  })
  if (!original || original.toolName !== PLAN_TOOL) return { ok: false, status: 404, error: 'plan not found' }
  if (original.status !== 'pending') {
    return { ok: false, status: 409, error: `only a waiting plan can be edited (this one is ${original.status})` }
  }
  const steps = await prisma.agentPlanStep.findMany({
    where: { approvalId },
    orderBy: { position: 'asc' },
    select: { position: true, toolName: true, args: true, undoesChangeId: true },
  })
  const wanted = new Set(Array.isArray(keep) ? keep.filter((n): n is number => Number.isInteger(n)) : [])
  const kept = steps.filter((step) => wanted.has(step.position))
  if (kept.length === 0) return { ok: false, status: 400, error: 'Keep at least one step; to drop the whole plan, reject it.' }
  if (kept.length === steps.length) return { ok: false, status: 400, error: 'Untick at least one step to make a smaller plan, or approve it as it is.' }

  const title = String((original.args as { title?: unknown } | null)?.title ?? 'A change plan')
  const plan: PlanRequest = {
    title,
    steps: kept.map((step) => ({ tool: step.toolName, args: (step.args ?? {}) as Record<string, unknown> })),
    ...(kept.some((step) => step.undoesChangeId) ? { undoes: kept.map((step) => step.undoesChangeId ?? '') } : {}),
  }
  const queued = await queuePlan(plan, principal, original.agentRunId)
  if (queued.mode !== 'queued' || !queued.approvalId) {
    return { ok: false, status: 400, error: queued.error ?? 'the smaller plan could not be checked', ...(queued.refusals ? { refusals: queued.refusals } : {}) }
  }
  const dropped = steps.length - kept.length
  const superseded = await prisma.agentApproval.updateMany({
    where: { id: approvalId, status: 'pending' },
    data: {
      status: 'superseded',
      decidedBy: principal.label,
      decidedByUserId: principal.userId,
      decidedAt: new Date(),
      reason: `superseded — a person unticked ${plural(dropped, 'step')} before approving`,
    },
  })
  if (superseded.count === 0) {
    await prisma.agentApproval.updateMany({ where: { id: queued.approvalId, status: 'pending' }, data: { status: 'rejected', reason: 'withdrawn: the plan it replaced was decided meanwhile' } })
    return { ok: false, status: 409, error: 'The plan was decided meanwhile; nothing was changed.' }
  }
  // An undo plan: the kept steps' changes now wait on the new plan; the unticked ones are free to be undone again.
  const keptUndoes = kept.map((step) => step.undoesChangeId).filter((id): id is string => !!id)
  if (keptUndoes.length) {
    await prisma.agentChange.updateMany({ where: { id: { in: keptUndoes }, undoneByApprovalId: approvalId }, data: { undoneByApprovalId: queued.approvalId } })
  }
  await prisma.agentChange.updateMany({ where: { undoneByApprovalId: approvalId, undoneAt: null }, data: { undoneByApprovalId: null } })
  await recordControlChange({
    charterKey: 'operator-edit',
    action: 'amend_action',
    from: { approvalId, steps: steps.length },
    to: { approvalId: queued.approvalId, steps: kept.length, kept: kept.map((step) => step.position) },
    note: `unticked ${plural(dropped, 'step')} of a change plan before approving it`,
    actor: principal.label,
  })
  return { ok: true, supersededId: approvalId, approvalId: queued.approvalId }
}
