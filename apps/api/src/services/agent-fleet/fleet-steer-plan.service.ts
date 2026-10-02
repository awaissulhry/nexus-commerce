/**
 * R15 (MCP full control, part 06 §3) — steer-fleet: Claude steers the agent fleet through the operator's own controls
 * (fleet-steer.service.ts, assignment.service.ts), never its prompts, revisions, tools, models or budgets (D R-3).
 *
 *   run-now            run a worker (or one assignment) once now: one model call, AI spend          outside the limits
 *   pause              stop a worker until a time, with a reason (a pause always expires)          inside
 *   resume             lift a worker's pause                                                       outside (AI spend resumes)
 *   set-level          a worker's level: down inside; up only to its charter's cap, AUTO only      outside
 *                      through the promotion gate
 *   assign             give a worker a target (campaigns, a portfolio or a market) to work on      outside (it will spend)
 *   cancel-assignment  cancel an assignment that never ran                                         inside
 *
 * `planSteer` is the dry run (a pure read); `applySteer` writes through the same services the Fleet pages use, with
 * the person named in the control audit.
 */
import prisma from '../../db.js'
import { isRefused } from '../automation/service-outcome.js'
import type { TargetKind } from './assignment-scope.js'

// The registry loads this module with every tool: the fleet's own modules (charters, the AI providers) load when a
// steer is planned, not before.
const fleet = async () => {
  const [registry, promotion, providers] = await Promise.all([import('./charter-registry.js'), import('./promotion.service.js'), import('../ai/providers/index.js')])
  return { FLEET_CHARTERS: registry.FLEET_CHARTERS, isAutoPromotionAllowed: promotion.isAutoPromotionAllowed, isAiKillSwitchOn: providers.isAiKillSwitchOn }
}
/** The fleet's autonomy ladder (ads-autonomy.ts AUTONOMY_LEVELS). */
const AUTONOMY_LEVELS = ['OFF', 'OBSERVE', 'PROPOSE', 'AUTO'] as const

export const STEER_ACTIONS = ['run-now', 'pause', 'resume', 'set-level', 'assign', 'cancel-assignment'] as const
export type SteerAction = (typeof STEER_ACTIONS)[number]
export const STEER_LEVELS = ['OFF', 'OBSERVE', 'PROPOSE', 'AUTO'] as const
type Level = (typeof STEER_LEVELS)[number]

export interface SteerInput {
  action: SteerAction
  charterKey?: string
  assignmentId?: string
  until?: string
  reason?: string
  level?: Level
  targetKind?: TargetKind
  targetIds?: string[]
  wantBack?: string
  dueAt?: string
  title?: string
}

/** A worker as steer-fleet records it (before / after) and its undo puts back. */
export interface CharterState {
  steer: 'charter'
  charterKey: string
  name: string
  level: Level
  cap: string
  pausedUntil: string | null
  pausedReason: string | null
}
export interface AssignmentRecord {
  steer: 'assign' | 'cancel-assignment'
  charterKey: string
  assignmentId: string | null
  title: string | null
  state: string | null
}
export interface RunRecord {
  steer: 'run-now'
  charterKey: string
  assignmentId: string | null
  runId: string | null
  ok: boolean | null
}
export type SteerRecord = CharterState | AssignmentRecord | RunRecord

export interface SteerPlan {
  action: 'steer-fleet'
  steer: SteerAction
  worker: { key: string; name: string; cap: string }
  assignment: { id: string; title: string; state: string } | null
  changes: Record<string, { from: unknown; to: unknown }>
  /** Spends AI money (now or when the work starts). */
  aiSpend: boolean
  /** Why it needs a person; null when it is inside steer-fleet's limits (a pause, a level down, a cancel). */
  needsPerson: string | null
  basis: string | null
  effect: string
}

type Planned = { ok: true; plan: SteerPlan; before: SteerRecord } | { ok: false; error: string }

const rank = (level: string) => (AUTONOMY_LEVELS as readonly string[]).indexOf(level)

/**
 * A worker of this business: a code charter and its row here (instances are steered in Nexus). Read from the row, not
 * the registry's cache, so the state a change records is the state it replaced. The level is what the registry
 * enforces: OFF when switched off, else the stored level capped by the charter.
 */
async function workerOf(key: string | undefined): Promise<{ state: CharterState; provisioned: boolean; basis: string | null } | string> {
  if (!key) return 'name the worker (charterKey), from list-automations (F1)'
  const { FLEET_CHARTERS } = await fleet()
  const def = FLEET_CHARTERS[key]
  if (!def) return `there is no worker ${key} (not found)`
  const row = await prisma.agentCharter.findFirst({ where: { key, version: def.version }, select: { enabled: true, autonomyLevel: true, pausedUntil: true, pausedReason: true, updatedAt: true } })
  const stored = row?.autonomyLevel ?? 'OFF'
  const level = (!row?.enabled ? 'OFF' : rank(stored) > rank(def.autonomyCap) ? def.autonomyCap : stored) as Level
  return {
    provisioned: !!row,
    basis: row?.updatedAt.toISOString() ?? null,
    state: {
      steer: 'charter', charterKey: key, name: def.name, level, cap: def.autonomyCap,
      pausedUntil: row?.pausedUntil ? row.pausedUntil.toISOString() : null, pausedReason: row?.pausedReason ?? null,
    },
  }
}

/** The worker's state now, in the shape steer-fleet stores (undo compares it with `after`). */
export async function charterStateNow(key: string): Promise<CharterState | null> {
  const w = await workerOf(key)
  return typeof w === 'string' ? null : w.state
}

export async function assignmentStateNow(record: AssignmentRecord): Promise<AssignmentRecord> {
  const a = record.assignmentId ? await prisma.agentAssignment.findUnique({ where: { id: record.assignmentId }, select: { title: true, state: true } }) : null
  return { ...record, title: a?.title ?? record.title, state: a?.state ?? null }
}

/** Targets must be this business's: campaigns and portfolios that exist here, one market. Labels are their names. */
async function targetsOf(kind: TargetKind | undefined, ids: string[]): Promise<{ labels: string[] } | string> {
  if (!kind) return ids.length ? 'a target was named without targetKind' : { labels: [] }
  if (ids.length === 0) return 'name at least one target (targetIds), or leave the target out'
  if (kind === 'CAMPAIGN') {
    const found = await prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
    const missing = ids.filter((id) => !found.some((c) => c.id === id))
    if (missing.length) return `there is no campaign ${missing.join(', ')} in this business (not found)`
    return { labels: ids.map((id) => found.find((c) => c.id === id)!.name) }
  }
  if (kind === 'PORTFOLIO') {
    const found = await prisma.campaign.findMany({ where: { portfolioId: { in: ids } }, select: { portfolioId: true } })
    const missing = ids.filter((id) => !found.some((c) => c.portfolioId === id))
    if (missing.length) return `there is no portfolio ${missing.join(', ')} in this business (not found)`
    return { labels: ids.map((id) => `portfolio ${id}`) }
  }
  return { labels: ids.map((code) => code.toUpperCase()) }
}

export async function planSteer(input: SteerInput): Promise<Planned> {
  const assignment = input.assignmentId
    ? await prisma.agentAssignment.findUnique({ where: { id: input.assignmentId }, select: { id: true, charterKey: true, title: true, state: true, updatedAt: true } })
    : null
  if (input.assignmentId && !assignment) return { ok: false, error: `There is no assignment ${input.assignmentId} in this business (not found).` }
  const worker = await workerOf(assignment?.charterKey ?? input.charterKey)
  if (typeof worker === 'string') return { ok: false, error: `Agent fleet: ${worker}.` }
  const w = worker.state
  const base = { action: 'steer-fleet' as const, steer: input.action, worker: { key: w.charterKey, name: w.name, cap: w.cap }, assignment: assignment ? { id: assignment.id, title: assignment.title, state: assignment.state } : null }
  const refuse = (why: string): Planned => ({ ok: false, error: `${w.name}: ${why}` })

  switch (input.action) {
    case 'run-now': {
      if ((await fleet()).isAiKillSwitchOn()) return refuse('AI is temporarily disabled (kill switch).')
      if (assignment?.state === 'cancelled') return refuse('this assignment was cancelled — reopen it in Nexus before it runs.')
      return {
        ok: true,
        before: { steer: 'run-now', charterKey: w.charterKey, assignmentId: assignment?.id ?? null, runId: null, ok: null },
        plan: {
          ...base, changes: { run: { from: null, to: assignment ? `assignment "${assignment.title}"` : 'now' } }, aiSpend: true,
          needsPerson: 'a run spends AI money', basis: assignment?.updatedAt.toISOString() ?? worker.basis,
          effect: `${w.name} runs once now${assignment ? ` on "${assignment.title}"` : ''} — even if it is off or paused, as the Run button does; the kill switch, the fleet halt and the day budgets still bind. What it finds waits in Approvals.`,
        },
      }
    }
    case 'pause': {
      const until = input.until ? new Date(input.until) : null
      if (!until || Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) return refuse('until must be a future date — a pause always expires.')
      if (!input.reason?.trim()) return refuse('say why (reason): it is shown on the worker and in its control history.')
      if (!worker.provisioned) return refuse('it is not set up in this business yet (its charter row is missing), so there is nothing to pause.')
      return {
        ok: true, before: w,
        plan: {
          ...base, changes: { pausedUntil: { from: w.pausedUntil, to: until.toISOString() } }, aiSpend: false, needsPerson: null, basis: worker.basis,
          effect: `${w.name} does not run until ${until.toISOString()} (then it runs again by itself).`,
        },
      }
    }
    case 'resume': {
      if (!w.pausedUntil || new Date(w.pausedUntil).getTime() <= Date.now()) return refuse('it is not paused.')
      return {
        ok: true, before: w,
        plan: {
          ...base, changes: { pausedUntil: { from: w.pausedUntil, to: null } }, aiSpend: true, needsPerson: 'a resumed worker spends AI money again', basis: worker.basis,
          effect: `${w.name} runs again at its next scheduled run${w.level === 'OFF' ? ' — but it is OFF, so it will not until its level is raised' : ''}.`,
        },
      }
    }
    case 'set-level': {
      const to = input.level
      if (!to) return refuse('name the level (OFF, OBSERVE, PROPOSE or AUTO).')
      if (to === w.level) return refuse(`it is already ${to}.`)
      if (!worker.provisioned) return refuse('it is not set up in this business yet (its charter row is missing) — set it up in Nexus first.')
      const up = rank(to) > rank(w.level)
      if (up && rank(to) > rank(w.cap)) return refuse(`${to} is above its charter's cap (${w.cap}).`)
      if (to === 'AUTO' && !(await (await fleet()).isAutoPromotionAllowed(w.charterKey))) return refuse('it has not earned AUTO — its latest scorecard is not promotion-eligible (30 days, acceptance ≥ 70 %, calibration ≤ 0.15, no rollbacks).')
      return {
        ok: true, before: w,
        plan: {
          ...base, changes: { level: { from: w.level, to } }, aiSpend: up, needsPerson: up ? 'a higher level lets the worker do (and spend) more' : null, basis: worker.basis,
          effect: to === 'OFF' ? `${w.name} stops running on its schedule.` : `${w.name} runs at ${to} (its cap is ${w.cap}).`,
        },
      }
    }
    case 'assign': {
      const { listAssignableWorkers } = await import('./assignment.service.js')
      const row = (await listAssignableWorkers()).find((a) => a.key === w.charterKey)
      if (!row) return refuse('it cannot be assigned.')
      if (row.refusal) return refuse(row.refusal)
      if (input.targetKind && !row.targetKinds.includes(input.targetKind)) return refuse(`it cannot be pointed at a ${input.targetKind.toLowerCase()}.`)
      if (input.targetKind === 'MARKETPLACE' && (input.targetIds ?? []).length !== 1) return refuse('a marketplace assignment names exactly one market.')
      const targets = await targetsOf(input.targetKind, input.targetIds ?? [])
      if (typeof targets === 'string') return refuse(`${targets}.`)
      return {
        ok: true,
        before: { steer: 'assign', charterKey: w.charterKey, assignmentId: null, title: null, state: null },
        plan: {
          ...base, changes: { assignment: { from: null, to: { targetKind: input.targetKind ?? null, targets: targets.labels, wantBack: input.wantBack ?? null, dueAt: input.dueAt ?? null } } },
          aiSpend: true, needsPerson: 'an assignment is work the worker will spend AI money on', basis: worker.basis,
          effect: `${w.name} gets an assignment${targets.labels.length ? ` on ${targets.labels.join(', ')}` : ''}; it runs when it is started (run-now with its assignmentId) or by a person in Nexus.`,
        },
      }
    }
    case 'cancel-assignment': {
      if (!assignment) return refuse('name the assignment (assignmentId).')
      if (assignment.state === 'cancelled') return refuse('this assignment is already cancelled.')
      if ((await prisma.agentRun.count({ where: { assignmentId: assignment.id } })) > 0) return refuse('this assignment has already run, so it cannot be cancelled — close it in Nexus; its runs are the record.')
      return {
        ok: true,
        before: { steer: 'cancel-assignment', charterKey: w.charterKey, assignmentId: assignment.id, title: assignment.title, state: assignment.state },
        plan: { ...base, changes: { state: { from: assignment.state, to: 'cancelled' } }, aiSpend: false, needsPerson: null, basis: assignment.updatedAt.toISOString(), effect: `The assignment "${assignment.title}" is cancelled; it never ran, so nothing is lost.` },
      }
    }
  }
  return { ok: false, error: `action: one of ${STEER_ACTIONS.join(', ')}` }
}

export async function applySteer(input: SteerInput, actorUserId: string | null): Promise<{ ok: true; plan: SteerPlan; before: SteerRecord; after: SteerRecord; data?: Record<string, unknown> } | { ok: false; error: string }> {
  const planned = await planSteer(input)
  if ('error' in planned) return planned
  const { plan, before } = planned
  const actor = actorUserId ? `user:${actorUserId}` : null
  const steer = await import('./fleet-steer.service.js')
  const key = plan.worker.key
  const failed = (body: Record<string, unknown>) => ({ ok: false as const, error: `${plan.worker.name}: not changed — ${String(body.error ?? 'refused')}` })
  switch (input.action) {
    case 'run-now': {
      if (plan.assignment) {
        const { startAssignment } = await import('./assignment.service.js')
        const out = await startAssignment(plan.assignment.id, actorUserId)
        if (!out.ok && out.error) return failed({ error: out.error })
        return { ok: true, plan, before, after: { ...(before as RunRecord), runId: out.runId ?? null, ok: out.ok }, data: { runId: out.runId ?? null, alreadyRunning: out.alreadyRunning ?? false, haltedReason: out.haltedReason ?? null } }
      }
      const out = await steer.runCharterNow(key, actorUserId)
      if (isRefused(out)) return failed(out.body)
      const { recordControlChange } = await import('./control-audit.service.js')
      await recordControlChange({ charterKey: key, action: 'run_now', actor, note: 'run now (steer-fleet)' }).catch(() => undefined)
      return { ok: true, plan, before, after: { ...(before as RunRecord), runId: out.value.runId ?? null, ok: out.value.ok }, data: { runId: out.value.runId ?? null, haltedReason: (out.value as { haltedReason?: string }).haltedReason ?? null } }
    }
    case 'pause': {
      const out = await steer.pauseCharter(key, new Date(input.until!).toISOString(), input.reason, actor)
      if (isRefused(out)) return failed(out.body)
      break
    }
    case 'resume': {
      const out = await steer.resumeCharter(key, actor)
      if (isRefused(out)) return failed(out.body)
      break
    }
    case 'set-level': {
      const out = await steer.patchCharter(key, input.level === 'OFF' ? { enabled: false } : { enabled: true, autonomyLevel: input.level }, actor)
      if (isRefused(out)) return failed(out.body)
      break
    }
    case 'assign': {
      const { createAssignment } = await import('./assignment.service.js')
      const targets = await targetsOf(input.targetKind, input.targetIds ?? [])
      const out = await createAssignment({
        charterKey: key, targetKind: input.targetKind ?? null, targetIds: input.targetIds ?? [], targetLabels: typeof targets === 'string' ? [] : targets.labels,
        wantBack: input.wantBack ?? null, dueAt: input.dueAt ?? null, title: input.title, createdBy: actorUserId,
      })
      if (!out.ok || !out.id) return failed({ error: out.error })
      const after = await assignmentStateNow({ ...(before as AssignmentRecord), assignmentId: out.id })
      return { ok: true, plan, before, after, data: { assignmentId: out.id } }
    }
    case 'cancel-assignment': {
      const { setAssignmentState } = await import('./assignment.service.js')
      const out = await setAssignmentState(plan.assignment!.id, 'cancelled', { userId: actorUserId })
      if (!out.ok) return failed({ error: out.error })
      return { ok: true, plan, before, after: await assignmentStateNow(before as AssignmentRecord) }
    }
  }
  const after = await charterStateNow(key)
  return { ok: true, plan, before, after: after ?? before }
}

/** steer-fleet's arguments that put a worker back as `before` records it, or why it cannot be put back (its undo). */
export function steerUndoOf(before: SteerRecord, after: SteerRecord): { tool: string; args: Record<string, unknown> } | { refusal: string } {
  if (before.steer === 'run-now') return { refusal: 'a run cannot be taken back: its AI spend is spent, and what it found waits in Approvals to be rejected one by one.' }
  if (before.steer === 'cancel-assignment') return { refusal: 'a cancelled assignment is reopened by a person in Nexus (Fleet → Assignments).' }
  if (before.steer === 'assign') {
    const id = (after as AssignmentRecord).assignmentId
    return id ? { tool: 'steer-fleet', args: { action: 'cancel-assignment', assignmentId: id } } : { refusal: 'the assignment was not created.' }
  }
  const was = before as CharterState
  const now = after as CharterState
  if (now.level !== was.level) return { tool: 'steer-fleet', args: { action: 'set-level', charterKey: was.charterKey, level: was.level } }
  if (!was.pausedUntil) return { tool: 'steer-fleet', args: { action: 'resume', charterKey: was.charterKey } }
  return { tool: 'steer-fleet', args: { action: 'pause', charterKey: was.charterKey, until: was.pausedUntil, reason: was.pausedReason ?? 'undo of a resume' } }
}
