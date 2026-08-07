/**
 * NAF.C — the council: run the DAG (analysts → director → critic), then
 * deterministically enforce the verdict and queue the survivors.
 *
 * Post-processing is code, not model: forced blocks from the pre-checks
 * override a passing critic (the model may add blocks, never remove);
 * passing items queue as AgentApproval rows via the EXISTING gate
 * (runOrQueueTool with the DIRECTOR's run id, so the decision timeline
 * stays coherent).
 *
 * Expiry used to live here and only here. NAF.AP.5 moved it to
 * `runApprovalMaintenance`, which owns the single `expiresAt` clock on its
 * own schedule and covers every tool — do not reintroduce a second one.
 */
import type { PlanItemT } from '@nexus/shared/agent-fleet'
import { Prisma } from '@nexus/database'
import prisma from '../../db.js'
import { runApprovalMaintenance } from './approval-inbox.service.js'
import { runOrQueueTool } from '../agents/approval-gate.service.js'
import { runFleet } from './orchestrator.js'
import { runPreChecks } from './plan-critic.service.js'
import { resolveItemGate } from './workflow-defs.js'

const FLEET_TOOL_NAMES = [
  'create-negative-keyword',
  'graduate-keyword',
  'set-target-bid',
]

export interface CouncilResult {
  orchestrationId: string
  fleet: { started: number; succeeded: number; failed: number; skipped: number }
  planId: string | null
  finalVerdict: string | null
  queued: number
  blocked: number
  expired: number
  haltedReason?: string
}

export async function runFleetCouncilOnce(): Promise<CouncilResult> {
  // 1 — NAF.AP.5: expiry is no longer the council's job. It used to run
  // HERE and only here, keyed on `requestedAt` against a private constant,
  // restricted to fleet tools — while every approval also carried an
  // `expiresAt` that nothing read. Two clocks, and the live one was dead.
  // `runApprovalMaintenance` now owns it on its own schedule, for every
  // tool. Called once here too so a council still reports what it swept;
  // do NOT reintroduce a second clock in this file.
  const maintenance = await runApprovalMaintenance()
  const expired = { count: maintenance.expired }

  // 2 — the DAG. Dark charters no-op inside; a failed agent never stops
  // its siblings; the critic runs only after the director's level.
  const fleet = await runFleet('council')

  // 3 — find this council's critiqued plan (the director run's artifact).
  const directorRun = await prisma.agentRun.findFirst({
    where: {
      orchestrationId: fleet.orchestrationId,
      agentKey: 'amazon-ads-director',
      ok: true,
    },
    select: { id: true, output: true },
  })
  const planId =
    (directorRun?.output as { planId?: string } | null)?.planId ?? null
  if (!planId) {
    return {
      orchestrationId: fleet.orchestrationId,
      fleet,
      planId: null,
      finalVerdict: null,
      queued: 0,
      blocked: 0,
      expired: expired.count,
      haltedReason: fleet.haltedReason,
    }
  }

  const plan = await prisma.agentPlan.findUnique({ where: { id: planId } })
  if (!plan || plan.status !== 'critiqued') {
    // Director produced a plan but the critic never annotated it (dark
    // critic, failed run, …) — it stays draft; honest no-op.
    return {
      orchestrationId: fleet.orchestrationId,
      fleet,
      planId,
      finalVerdict: plan?.criticVerdict ?? null,
      queued: 0,
      blocked: 0,
      expired: expired.count,
      haltedReason: fleet.haltedReason,
    }
  }

  // 4 — deterministic enforcement: recompute pre-checks and override a
  // passing verdict on any forced block.
  const items = plan.items as unknown as PlanItemT[]
  const prechecks = await runPreChecks({
    items,
    conflicts: (plan.conflicts as unknown[]) ?? [],
  })
  const forcedFindingIds = new Set(
    prechecks.forcedBlocks.map((b) => b.findingId),
  )
  const criticBlocked = new Set(
    ((plan.criticNotes as { blockedItems?: string[] } | null)?.blockedItems ??
      []) as string[],
  )
  const planWideForce = forcedFindingIds.has('*')

  let finalVerdict = plan.criticVerdict ?? 'block'
  if (prechecks.forcedBlocks.length > 0 && finalVerdict === 'pass') {
    finalVerdict = 'block'
    await prisma.agentPlan.update({
      where: { id: plan.id },
      data: {
        criticVerdict: 'block',
        criticNotes: {
          ...(plan.criticNotes as Record<string, unknown> | null),
          forcedBlocks: prechecks.forcedBlocks,
          note: 'verdict overridden by deterministic pre-checks',
        } as unknown as Prisma.InputJsonValue,
      },
    })
  }

  // 5 — queue the survivors of a passing plan.
  //
  // WF.4b — per-step gates from the stored definition this walk executed
  // (study decision D-WF4.1): an item is gated by its ORIGIN analyst's step
  // — the worker whose finding it enacts — falling back to the director's.
  // `ask` forces the approval branch at the gate; tighten-only, so tool
  // floors and `alwaysAsk` are untouched.
  const gates = fleet.stepGates ?? {}
  const originByFinding = new Map<string, string>()
  if (Object.keys(gates).length > 0 && finalVerdict === 'pass' && !planWideForce) {
    const findingIds = items
      .map((i) => i.findingId)
      .filter((id): id is string => typeof id === 'string')
    if (findingIds.length > 0) {
      const findings = await prisma.agentFinding.findMany({
        where: { id: { in: findingIds } },
        select: { id: true, charterKey: true },
      })
      for (const f of findings) originByFinding.set(f.id, f.charterKey)
    }
  }

  let queued = 0
  let blocked = 0
  if (finalVerdict === 'pass' && !planWideForce) {
    const approvalIds: string[] = []
    for (const item of items) {
      if (forcedFindingIds.has(item.findingId) || criticBlocked.has(item.findingId)) {
        blocked++
        continue
      }
      const gate = resolveItemGate(
        gates,
        originByFinding.get(item.findingId) ?? null,
        'amazon-ads-director',
      )
      const outcome = await runOrQueueTool(
        item.tool,
        item.args as Record<string, unknown>,
        { userId: null },
        directorRun!.id,
        { forceAsk: gate === 'ask' },
      )
      if (outcome.mode === 'queued' && outcome.approvalId) {
        approvalIds.push(outcome.approvalId)
        queued++
      } else {
        blocked++
      }
    }
    await prisma.agentPlan.update({
      where: { id: plan.id },
      data: { status: queued > 0 ? 'queued' : 'critiqued', approvalIds },
    })
  } else {
    blocked = items.length
  }

  return {
    orchestrationId: fleet.orchestrationId,
    fleet,
    planId,
    finalVerdict,
    queued,
    blocked,
    expired: expired.count,
    haltedReason: fleet.haltedReason,
  }
}
