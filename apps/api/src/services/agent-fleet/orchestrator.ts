/**
 * NAF.A — the only thing that starts agents (design law L3 — nothing
 * recursive; fan-out is the declared graph, executed here).
 *
 * runFleet walks topoLevels(FLEET_GRAPH) level by level with an inline
 * concurrency limiter (no new dependency). BEFORE each agent it re-checks
 * kill switch, fleet halt and the fleet day budget — any trip
 * short-circuits the remainder as `skipped` with the reason recorded.
 * A failing agent never stops its siblings. Disabled charters no-op inside
 * the executor and count as skipped: that is the dark ship.
 *
 * Not scheduled in Phase A — no cron registration; the only callers are
 * tests and later phases.
 */
import { randomUUID } from 'node:crypto'
import prisma from '../../db.js'
import { isAiKillSwitchOn } from '../ai/providers/index.js'
import { executeCharter } from './agent-executor.js'
import { checkFleetDayBudget } from './budget-guard.js'
import { FLEET_GRAPH, topoLevels } from './fleet-graph.js'
import { getFleetState } from './fleet-state.service.js'
import { MODE_WORKFLOW_KEY, defToGraph, stepGatesOf } from './workflow-defs.js'
// (runStoredWorkflow also reads getEffectiveDefinition/isWorkflowEnabled below)
import { getEffectiveDefinition, isWorkflowEnabled } from './workflow-registry.service.js'

export interface FleetRunResult {
  orchestrationId: string
  started: number
  succeeded: number
  failed: number
  skipped: number
  haltedReason?: string
  /** WF.4b — the resolved stored definition's per-step gates; absent when
   *  the code path walked (and then every gate is effectively `inherit`). */
  stepGates?: Record<string, 'ask' | 'act' | 'inherit'>
  workflowKey?: string
  workflowRevisionId?: string
}

const DEFAULT_CONCURRENCY = 3

/** Minimal promise pool — runs thunks with at most `limit` in flight. */
async function pool<T>(
  thunks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(thunks.length)
  let next = 0
  async function worker() {
    while (next < thunks.length) {
      const i = next++
      results[i] = await thunks[i]!()
    }
  }
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, thunks.length)) },
    () => worker(),
  )
  await Promise.all(workers)
  return results
}

/** WF.6b — the walk itself, shared by every stored-execution entry point:
 *  level by level, per-node re-checked gates, per-agent failure isolation. */
async function executeWalk(args: {
  levels: string[][]
  mode: 'sweep' | 'council' | 'custom'
  trigger: 'schedule' | 'manual'
  orchestrationId: string
  concurrency: number
  workflowKey?: string
  workflowRevisionId?: string
}): Promise<Omit<FleetRunResult, 'stepGates' | 'workflowKey' | 'workflowRevisionId'>> {
  const { levels, mode, trigger, orchestrationId, concurrency } = args
  let started = 0
  let succeeded = 0
  let failed = 0
  let skipped = 0
  let haltedReason: string | undefined

  for (const level of levels) {
    const thunks = level.map((key) => async () => {
      // Short-circuit: once anything trips, the rest of the fleet is
      // skipped — checked per agent so a mid-level trip stops the tail.
      if (!haltedReason) {
        if (isAiKillSwitchOn()) haltedReason = 'kill_switch'
      }
      if (!haltedReason) {
        const fleet = await getFleetState()
        if (fleet.halted) {
          haltedReason = fleet.degraded
            ? 'fleet_state_unreadable'
            : `fleet_halted${fleet.haltReason ? `: ${fleet.haltReason}` : ''}`
        } else {
          const budget = await checkFleetDayBudget(fleet.dailyCeilingUSD)
          if (!budget.ok) haltedReason = `${budget.reason}: ${budget.detail}`
        }
      }
      if (haltedReason) {
        skipped++
        return
      }

      started++
      try {
        const r = await executeCharter(key, {
          trigger,
          mode,
          orchestrationId,
          workflowKey: args.workflowKey,
          workflowRevisionId: args.workflowRevisionId,
        })
        if (r.skipped) skipped++
        else if (r.ok) succeeded++
        else failed++
      } catch {
        // An agent failure is that agent's failure — never the fleet's.
        failed++
      }
    })
    await pool(thunks, concurrency)
  }

  return { orchestrationId, started, succeeded, failed, skipped, haltedReason }
}

/** WF.6b — run a stored workflow (customs' Run-now). Refuses honestly when
 *  there is nothing to run; OFF workers still skip inside the executor —
 *  the dials and the fleet gates decide what actually executes. One run
 *  per workflow at a time. */
const liveStoredRuns = new Set<string>()

export async function runStoredWorkflow(
  workflowKey: string,
  opts: { trigger?: 'schedule' | 'manual'; concurrency?: number } = {},
): Promise<FleetRunResult> {
  const orchestrationId = `wfrun_${randomUUID()}`
  if (liveStoredRuns.has(workflowKey)) {
    return {
      orchestrationId,
      started: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      haltedReason: 'already_running: one run per workflow at a time',
    }
  }
  if (!(await isWorkflowEnabled(workflowKey))) {
    return {
      orchestrationId,
      started: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      haltedReason: `workflow_disabled: ${workflowKey} was switched off by the operator`,
    }
  }
  const eff = await getEffectiveDefinition(workflowKey)
  if (!eff.definition || eff.definition.steps.length === 0) {
    return {
      orchestrationId,
      started: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      haltedReason: 'no_wiring: nothing published to run',
    }
  }
  liveStoredRuns.add(workflowKey)
  try {
    const result = await executeWalk({
      levels: topoLevels(defToGraph(eff.definition)),
      mode: 'custom',
      trigger: opts.trigger ?? 'manual',
      orchestrationId,
      concurrency: opts.concurrency ?? DEFAULT_CONCURRENCY,
      workflowKey,
      workflowRevisionId: eff.revisionId ?? undefined,
    })
    return {
      ...result,
      stepGates: stepGatesOf(eff.definition),
      workflowKey,
      workflowRevisionId: eff.revisionId ?? undefined,
    }
  } finally {
    liveStoredRuns.delete(workflowKey)
  }
}

export async function runFleet(
  mode: 'sweep' | 'council',
  opts: { concurrency?: number } = {},
): Promise<FleetRunResult> {
  const orchestrationId = `orch_${randomUUID()}`
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY

  // WF.4a — the walk source is the STORED definition (active revision, else
  // the code-derived built-in). An unreadable stored layer means the CODE
  // path runs — the same law that makes revert-to-built-in unfailable. The
  // workflow row's `enabled` is the operator's soft off switch.
  const workflowKey = MODE_WORKFLOW_KEY[mode]
  let graph = FLEET_GRAPH
  let stampKey: string | null = null
  let stampRevisionId: string | null = null
  let stepGates: Record<string, 'ask' | 'act' | 'inherit'> | undefined
  try {
    if (!(await isWorkflowEnabled(workflowKey))) {
      return {
        orchestrationId,
        started: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        haltedReason: `workflow_disabled: ${workflowKey} was switched off by the operator`,
      }
    }
    const eff = await getEffectiveDefinition(workflowKey)
    if (eff.definition) {
      graph = defToGraph(eff.definition)
      stampKey = workflowKey
      stampRevisionId = eff.revisionId
      stepGates = stepGatesOf(eff.definition)
    }
  } catch {
    /* stored layer unreadable ⇒ FLEET_GRAPH walks, stamps stay null */
  }

  // WF.6b — the walk is shared machinery now; runFleet is its mode-keyed
  // caller and runStoredWorkflow (customs' Run-now) its other.
  const walk = await executeWalk({
    levels: topoLevels(graph),
    mode,
    trigger: 'schedule',
    orchestrationId,
    concurrency,
    workflowKey: stampKey ?? undefined,
    workflowRevisionId: stampRevisionId ?? undefined,
  })

  return {
    ...walk,
    stepGates,
    workflowKey: stampKey ?? undefined,
    workflowRevisionId: stampRevisionId ?? undefined,
  }
}

/**
 * Pre-F hardening — a builder hang or process death mid-run leaves an
 * AgentRun stuck 'running' with no executor timeout to close it. The
 * sweep and council call this first: fleet runs (mode NOT NULL — the
 * ACP copilot's runs are not ours to touch) stuck past the cutoff are
 * closed done/not-ok with the reason on the row. Reclaimed, never
 * deleted — a stuck run is evidence.
 */
export async function reclaimStuckRuns(maxAgeHours = 2): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeHours * 3600_000)
  const r = await prisma.agentRun.updateMany({
    where: { status: 'running', mode: { not: null }, createdAt: { lt: cutoff } },
    data: {
      status: 'done',
      ok: false,
      haltedReason: `orphaned: stuck running >${maxAgeHours}h, reclaimed`,
      endedAt: new Date(),
    },
  })
  return r.count
}
