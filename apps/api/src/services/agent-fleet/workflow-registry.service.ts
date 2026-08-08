/**
 * NAF.WF.2 — the workflow registry: code truth ⊕ DB rows, the same shape the
 * charter registry taught the fleet (session-locks doc §4, REVIEWED).
 *
 * The pure layer — contract types, the derived built-ins, defToGraph —
 * lives in ./workflow-defs.ts (importable without a database; WF.4a) and is
 * re-exported here so callers keep one import path. This file owns what
 * needs the DB: seed, list, the effective definition, enablement, and
 * save-time validation.
 *
 * A built-in's stored row adds presence and an enabled toggle; its
 * DEFINITION comes from an active revision when one exists, else from code —
 * revert-to-built-in can never fail. A custom workflow with no active
 * revision is simply disabled: its floor is "nothing", never a code
 * fallback it does not have.
 *
 * Steps reference charter keys resolved via `resolveCharter` — never
 * `FLEET_CHARTERS` directly — which is the one meeting point with the
 * Workers stream's future instances (§4 contract).
 */

import prisma from '../../db.js'
import { topoLevels, type FleetGraph } from './fleet-graph.js'
import { resolveCharter } from './charter-registry.js'
import { nextCronFire } from './cron-eval.js'
import { getActiveWorkflowRevision } from './workflow-revisions.service.js'
import {
  BUILTIN_WORKFLOWS,
  builtinByKey,
  chainOf,
  type WorkflowDefinitionV1,
} from './workflow-defs.js'

export {
  BUILTIN_WORKFLOWS,
  MODE_WORKFLOW_KEY,
  builtinByKey,
  defToGraph,
} from './workflow-defs.js'
export type {
  BuiltinWorkflow,
  WorkflowDefinitionV1,
  WorkflowEdgeV1,
  WorkflowStepV1,
  WorkflowTriggerV1,
} from './workflow-defs.js'

/* ── seed & list ───────────────────────────────────────────────────────── */

/** Create-if-absent, never clobbers — the seedCharters contract. */
export async function seedWorkflows(): Promise<{ created: number }> {
  let created = 0
  for (const b of BUILTIN_WORKFLOWS) {
    const existing = await prisma.agentWorkflow.findUnique({ where: { key: b.key } })
    if (!existing) {
      await prisma.agentWorkflow.create({
        data: { key: b.key, name: b.name, description: b.description, kind: 'builtin' },
      })
      created++
    }
  }
  return { created }
}

export interface WorkflowListRow {
  key: string
  name: string
  description: string | null
  kind: 'builtin' | 'custom'
  enabled: boolean
  /** Where the effective definition comes from right now. */
  source: 'code' | 'revision' | 'none'
  activeRevision: { id: string; revision: number; note: string; activatedAt: Date } | null
  revisionCount: number
  /** Row exists in the DB (seeded) — presence of built-ins never depends on it. */
  seeded: boolean
  /** NAF.WF-S1R / S1.c — the EFFECTIVE definition's steps in execution order,
   *  so a list surface can draw who hands to whom without one fetch per row.
   *  `null` when there is no effective definition at all (a custom with no
   *  published wiring runs nothing, and an empty array would imply otherwise).
   *  Presentation only: job furniture — the auditor's post-scorecards run,
   *  grading, report cards — is code ordering and is NOT in a definition, so
   *  a caller drawing a built-in's full story must overlay it (the same
   *  caveat `getEffectiveWiring` carries). */
  chain: string[] | null
}

/** Code-first union: built-ins are always present, whatever the DB holds. */
export async function listWorkflows(): Promise<WorkflowListRow[]> {
  const rows = await prisma.agentWorkflow.findMany({ orderBy: { createdAt: 'asc' } })
  const byKey = new Map(rows.map((r) => [r.key, r]))
  const counts = await prisma.agentWorkflowRevision.groupBy({
    by: ['workflowKey'],
    _count: { _all: true },
  })
  const countByKey = new Map(counts.map((c) => [c.workflowKey, c._count._all]))

  const out: WorkflowListRow[] = []
  const seen = new Set<string>()
  for (const b of BUILTIN_WORKFLOWS) {
    seen.add(b.key)
    const row = byKey.get(b.key)
    const active = await getActiveWorkflowRevision(b.key)
    out.push({
      key: b.key,
      name: row?.name ?? b.name,
      description: row?.description ?? b.description,
      kind: 'builtin',
      enabled: row?.enabled ?? true,
      source: active ? 'revision' : 'code',
      activeRevision: active
        ? { id: active.id, revision: active.revision, note: active.note, activatedAt: active.activatedAt! }
        : null,
      revisionCount: countByKey.get(b.key) ?? 0,
      seeded: row != null,
      chain: chainOf(
        active ? (active.definition as unknown as WorkflowDefinitionV1) : b.definition(),
      ),
    })
  }
  for (const row of rows) {
    if (seen.has(row.key)) continue
    const active = await getActiveWorkflowRevision(row.key)
    out.push({
      key: row.key,
      name: row.name,
      description: row.description,
      kind: 'custom',
      enabled: row.enabled,
      source: active ? 'revision' : 'none',
      activeRevision: active
        ? { id: active.id, revision: active.revision, note: active.note, activatedAt: active.activatedAt! }
        : null,
      revisionCount: countByKey.get(row.key) ?? 0,
      seeded: true,
      chain: active
        ? chainOf(active.definition as unknown as WorkflowDefinitionV1)
        : null,
    })
  }
  return out
}

/** Active revision's definition (with its id, for run stamping — WF.4a),
 *  else the code default (built-ins only). */
export async function getEffectiveDefinition(key: string): Promise<{
  source: 'code' | 'revision' | 'none'
  definition: WorkflowDefinitionV1 | null
  revisionId: string | null
}> {
  const active = await getActiveWorkflowRevision(key)
  if (active) {
    return {
      source: 'revision',
      definition: active.definition as unknown as WorkflowDefinitionV1,
      revisionId: active.id,
    }
  }
  const b = builtinByKey(key)
  if (b) return { source: 'code', definition: b.definition(), revisionId: null }
  return { source: 'none', definition: null, revisionId: null }
}

/** Locks-doc §5 decision 6 — the Fleet map's read contract: every ENABLED
 *  workflow's effective definition with its source, in one read. Read-only
 *  and owned HERE so the map (and anyone else) never re-derives what
 *  "effective" means. A custom with no active revision contributes nothing —
 *  it runs nothing. NOTE for consumers: job furniture (the auditor's
 *  post-scorecards run, grading, report cards) is deliberately NOT in these
 *  definitions — its ordering is code; draw it as presentation or state the
 *  omission. */
export interface EffectiveWiringRow {
  workflowKey: string
  kind: 'builtin' | 'custom'
  source: 'code' | 'revision'
  definition: WorkflowDefinitionV1
}

export async function getEffectiveWiring(): Promise<EffectiveWiringRow[]> {
  const rows = await listWorkflows()
  const out: EffectiveWiringRow[] = []
  for (const row of rows) {
    if (!row.enabled) continue
    const eff = await getEffectiveDefinition(row.key)
    if (!eff.definition) continue
    out.push({
      workflowKey: row.key,
      kind: row.kind,
      source: eff.source as 'code' | 'revision',
      definition: eff.definition,
    })
  }
  return out
}

/** The operator's off switch on a workflow row. Missing row = enabled (the
 *  built-ins' presence never depends on seeding); unreadable DB = enabled,
 *  because the fleet's real floors are the charter dark-ship and the halt —
 *  a soft toggle must not become a third, phantom kill switch. */
export async function isWorkflowEnabled(key: string): Promise<boolean> {
  try {
    const row = await prisma.agentWorkflow.findUnique({
      where: { key },
      select: { enabled: true },
    })
    return row?.enabled ?? true
  } catch {
    return true
  }
}

/* ── validation: Layer 2 checked against Layer 1 on save ───────────────── */

const GATES = new Set(['ask', 'act', 'inherit'])
const ARTIFACTS = new Set(['finding', 'plan', 'strategy'])

/** Every rejection is a sentence an operator can act on. The union carries
 *  an optional `error` member because apps/api compiles with strict:false,
 *  where discriminated-union narrowing does not survive (the recorded fleet
 *  convention — see BudgetVerdict). */
export async function validateDefinition(
  def: unknown,
): Promise<{ ok: boolean; error?: string }> {
  if (typeof def !== 'object' || def === null) return { ok: false, error: 'definition must be an object' }
  const d = def as Partial<WorkflowDefinitionV1>
  if (d.v !== 1) return { ok: false, error: 'definition.v must be 1 — the only contract this build understands' }
  if (!d.trigger || typeof d.trigger !== 'object') return { ok: false, error: 'a workflow needs a trigger' }
  if (d.trigger.type === 'schedule') {
    if (typeof d.trigger.cron !== 'string' || !nextCronFire(d.trigger.cron, new Date())) {
      return { ok: false, error: `the schedule "${String((d.trigger as { cron?: unknown }).cron)}" is not a cron expression this fleet can evaluate` }
    }
  } else if (d.trigger.type !== 'manual') {
    return { ok: false, error: 'trigger.type must be "schedule" or "manual"' }
  }
  if (!Array.isArray(d.steps)) return { ok: false, error: 'steps must be a list' }
  if (!Array.isArray(d.edges)) return { ok: false, error: 'edges must be a list' }
  if (d.steps.length === 0 && d.trigger.type === 'schedule') {
    return { ok: false, error: 'a scheduled workflow needs at least one step — a clock that starts nothing teaches nothing' }
  }
  const keys = new Set<string>()
  for (const s of d.steps) {
    if (!s || typeof s.charterKey !== 'string') return { ok: false, error: 'every step names a charterKey' }
    if (keys.has(s.charterKey)) return { ok: false, error: `the worker "${s.charterKey}" appears twice — one step per worker in contract v1` }
    keys.add(s.charterKey)
    if (!GATES.has(s.gate)) return { ok: false, error: `step "${s.charterKey}": gate must be ask, act or inherit` }
    // The §4 meeting point: resolveCharter (async), never FLEET_CHARTERS
    // directly — the day worker instances exist they are wireable with zero
    // change here.
    if (!(await resolveCharter(s.charterKey))) {
      return { ok: false, error: `"${s.charterKey}" is not a worker this fleet can resolve — a workflow cannot invent workers (law L3)` }
    }
  }
  for (const e of d.edges) {
    if (!e || typeof e.from !== 'string' || typeof e.to !== 'string') return { ok: false, error: 'every edge needs from and to' }
    if (!keys.has(e.from) || !keys.has(e.to)) return { ok: false, error: `edge ${e.from} → ${e.to} names a step that is not in this workflow` }
    if (!ARTIFACTS.has(e.artifact)) return { ok: false, error: `edge ${e.from} → ${e.to}: artifact must be finding, plan or strategy` }
  }
  // Acyclicity via the SAME code law the orchestrator runs on — a malformed
  // graph is a save error here for the same reason it is a build error there.
  try {
    const g: FleetGraph = {
      nodes: [...keys].map((k) => ({ key: k, tier: 'analyst' })),
      edges: d.edges.map((e) => ({ from: e.from, to: e.to, artifact: e.artifact })),
    }
    topoLevels(g)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'the graph has a cycle' }
  }
  return { ok: true }
}
