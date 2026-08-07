/**
 * NAF.WF — shapes and derivations shared by the routine list (S1) and the
 * routine detail (S2/S3). One module so the two surfaces cannot disagree
 * about what a run group is or what a routine's status means.
 *
 * Failure semantics live in `../_shared/run-health` (SB.W's taxonomy) — this
 * module never re-derives "is this broken"; it only groups runs into
 * orchestrations and computes the ONE effective routine status.
 */

import { ago as agoIso } from '../_shared/run-health'
import type { BuiltinRoutine, RoutineStory } from './routines'
import { CRITIC_KEY, DIRECTOR_KEY } from './routines'

export const DAY = 24 * 3600 * 1000

/* ── shapes, mirrored from the fleet API ───────────────────────────────── */

export interface ScheduleJob {
  key: string
  label: string
  schedule: string
  enabled: boolean
  nextFireAt: string | null
  lastRun: { startedAt: string; status: string; outputSummary: string | null } | null
}
export interface RunRow {
  id: string
  agentKey: string
  ok: boolean
  status: string
  mode: string | null
  trigger: string // manual | event | schedule
  costUSD: string | number // Decimal serializes as a string — Number() it
  findingCount: number
  orchestrationId: string | null
  haltedReason: string | null
  errorMessage?: string | null
  createdAt: string
  endedAt: string | null
  /** WF.4a — the stored workflow revision this run served; null = code path. */
  workflowRevisionId?: string | null
}
export interface CharterRow {
  key: string
  name?: string
  tier: string
  enabled: boolean
  autonomyLevel: string
  degraded: boolean
}
export interface FleetState {
  halted?: boolean
  haltReason?: string | null
}

/** One orchestration of a routine: its runs collapsed to a single record. */
export interface RunGroup {
  id: string
  startedAt: number
  /** Every FINISHED run ok, none halted. False while nothing has finished. */
  ok: boolean
  halted: boolean
  /** A run in this orchestration is still in flight. */
  running: boolean
  costUSD: number
  findings: number
  runs: number
  /** The group's member runs, newest first — the expansion renders these. */
  rows: RunRow[]
  /** Wall-clock span across the group's finished runs; null if none ended. */
  durationMs: number | null
}

export type StatusKind = 'on' | 'ready' | 'idle' | 'off' | 'halted'
export interface RoutineStatus {
  kind: StatusKind
  label: string
  why: string
}

export const CHIP_CLASS: Record<StatusKind, string> = {
  on: 'running',
  halted: 'halted',
  idle: 'wf-chip-idle',
  off: 'wf-chip-off',
  ready: 'wf-chip-ready',
}

/* ── plain-sentence time helpers ───────────────────────────────────────── */

export function agoTs(ts: number | null): string {
  return ts ? agoIso(new Date(ts).toISOString()) : 'never'
}

export function until(iso: string | null): string | null {
  if (!iso) return null
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'due now'
  const m = Math.round(ms / 60_000)
  if (m < 60) return `in ${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return m % 60 ? `in ${h}h ${m % 60}m` : `in ${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `in ${d}d ${h % 24}h` : `in ${d}d`
}

export function fmtDuration(ms: number | null): string {
  if (ms == null || ms <= 0) return '—'
  if (ms < 1000) return '<1s'
  const s = Math.round(ms / 1000)
  if (s < 90) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** The two fleet crons in plain words; anything unrecognized stays as cron. */
export function prettyCron(expr: string): string {
  const f = expr.trim().split(/\s+/)
  if (f.length !== 5) return expr
  const [min, hr, dom, mon, dow] = f
  const m = Number(min)
  const h = Number(hr)
  if (!Number.isInteger(m) || !Number.isInteger(h)) return `${expr} (UTC)`
  const hhmm = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} UTC`
  if (dom === '*' && mon === '*' && dow === '*') return `Nightly at ${hhmm}`
  if (dom === '*' && mon === '*' && /^[0-6]$/.test(dow ?? '')) {
    return `${DAYS[Number(dow)]}s at ${hhmm}`
  }
  return `${expr} (UTC)`
}

/* ── assembly ──────────────────────────────────────────────────────────── */

export function groupRuns(runs: RunRow[], mode: BuiltinRoutine['mode']): RunGroup[] {
  const byId = new Map<string, RunRow[]>()
  for (const r of runs) {
    if (r.mode !== mode) continue
    const k = r.orchestrationId ?? r.id
    const list = byId.get(k)
    if (list) list.push(r)
    else byId.set(k, [r])
  }
  const groups: RunGroup[] = []
  for (const [id, list] of byId) {
    const started = Math.min(...list.map((r) => new Date(r.createdAt).getTime()))
    const ends = list
      .map((r) => (r.endedAt ? new Date(r.endedAt).getTime() : null))
      .filter((t): t is number => t != null)
    // The SB.W trap (locks doc §3): a run is created ok:false and flips true
    // only when it finishes — so outcome derives from FINISHED runs only, or
    // an orchestration in flight reads as a failure.
    const finished = list.filter((r) => r.status !== 'running')
    const halted = finished.some((r) => r.haltedReason != null)
    groups.push({
      id,
      startedAt: started,
      halted,
      running: finished.length < list.length,
      ok: finished.length > 0 && finished.every((r) => r.ok) && !halted,
      costUSD: list.reduce((s, r) => s + Number(r.costUSD || 0), 0),
      findings: list.reduce((s, r) => s + r.findingCount, 0),
      runs: list.length,
      rows: [...list].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
      durationMs: ends.length ? Math.max(...ends) - started : null,
    })
  }
  return groups.sort((a, b) => b.startedAt - a.startedAt)
}

/* ── the stored definition, mirrored from the API contract v1 ──────────── */

export interface WfStep {
  charterKey: string
  gate: 'ask' | 'act' | 'inherit'
}
export interface WfEdge {
  from: string
  to: string
  artifact: 'finding' | 'plan' | 'strategy'
}
export type WfTrigger = { type: 'schedule'; cron: string } | { type: 'manual' }
export interface WfDefinition {
  v: 1
  trigger: WfTrigger
  steps: WfStep[]
  edges: WfEdge[]
}

/** Kahn's by levels — the client mirror of the server's `topoLevels` law.
 *  Validated definitions cannot be cyclic; a mid-edit draft CAN, so leftover
 *  nodes are parked in a final column and `cyclic` says so. */
export function topoCols(
  steps: WfStep[],
  edges: WfEdge[],
): { cols: Map<string, number>; cyclic: boolean } {
  const keys = new Set(steps.map((s) => s.charterKey))
  const indeg = new Map<string, number>()
  for (const k of keys) indeg.set(k, 0)
  for (const e of edges) {
    if (keys.has(e.to) && keys.has(e.from)) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1)
  }
  const cols = new Map<string, number>()
  let frontier = [...keys].filter((k) => (indeg.get(k) ?? 0) === 0)
  let level = 0
  while (frontier.length) {
    const next: string[] = []
    for (const k of frontier) cols.set(k, level)
    for (const e of edges) {
      if (cols.get(e.from) === level && keys.has(e.to) && !cols.has(e.to)) {
        const d = (indeg.get(e.to) ?? 1) - 1
        indeg.set(e.to, d)
        if (d === 0) next.push(e.to)
      }
    }
    frontier = next
    level++
  }
  let cyclic = false
  for (const k of keys) {
    if (!cols.has(k)) {
      cols.set(k, level)
      cyclic = true
    }
  }
  return { cols, cyclic }
}

const TIER_SUB: Record<string, string> = {
  analyst: 'Reads evidence, reports findings',
  director: 'Compiles one ranked plan',
  critic: 'Rules on the plan',
  auditor: 'Writes your brief',
  strategist: 'Sets the period strategy',
}

/** A stored definition rendered in the canvas's story shape, with live
 *  charter names. Pure; the caller supplies its own surrounding sentence. */
export function definitionToStory(def: WfDefinition, charters: CharterRow[]): RoutineStory {
  const byKey = new Map(charters.map((c) => [c.key, c]))
  const { cols } = topoCols(def.steps, def.edges)
  return {
    sentence: '',
    steps: def.steps.map((s) => {
      const c = byKey.get(s.charterKey)
      return {
        id: s.charterKey,
        kind: 'worker' as const,
        charterKey: s.charterKey,
        label: c?.name ?? s.charterKey,
        sub:
          s.gate === 'ask'
            ? 'Asks you first — every proposal waits'
            : s.gate === 'act'
              ? 'May act — the tool’s own policy decides'
              : (TIER_SUB[c?.tier ?? ''] ?? 'Worker'),
        col: cols.get(s.charterKey) ?? 0,
      }
    }),
    edges: def.edges.map((e) => ({
      from: e.from,
      to: e.to,
      label: e.artifact === 'finding' ? 'findings' : e.artifact,
    })),
  }
}

/** Artifact a step of this tier hands on — derived, shown, never asked. */
export function tierArtifact(tier: string | undefined): WfEdge['artifact'] | null {
  if (tier === 'analyst') return 'finding'
  if (tier === 'director') return 'plan'
  if (tier === 'strategist') return 'strategy'
  return null // critic and auditor are terminal: code reads their output
}

export interface WfDiff {
  stepsAdded: string[]
  stepsRemoved: string[]
  gatesChanged: Array<{ charterKey: string; from: string; to: string }>
  edgesAdded: string[]
  edgesRemoved: string[]
  triggerChanged: boolean
}

/** Categorized structural diff (the Make grouping): what a publish changes. */
export function computeDiff(a: WfDefinition, b: WfDefinition): WfDiff {
  const aSteps = new Map(a.steps.map((s) => [s.charterKey, s]))
  const bSteps = new Map(b.steps.map((s) => [s.charterKey, s]))
  const edgeKey = (e: WfEdge) => `${e.from} → ${e.to} (${e.artifact}s)`
  const aEdges = new Set(a.edges.map(edgeKey))
  const bEdges = new Set(b.edges.map(edgeKey))
  return {
    stepsAdded: [...bSteps.keys()].filter((k) => !aSteps.has(k)),
    stepsRemoved: [...aSteps.keys()].filter((k) => !bSteps.has(k)),
    gatesChanged: [...bSteps.values()]
      .filter((s) => aSteps.has(s.charterKey) && aSteps.get(s.charterKey)!.gate !== s.gate)
      .map((s) => ({ charterKey: s.charterKey, from: aSteps.get(s.charterKey)!.gate, to: s.gate })),
    edgesAdded: [...bEdges].filter((e) => !aEdges.has(e)),
    edgesRemoved: [...aEdges].filter((e) => !bEdges.has(e)),
    triggerChanged: JSON.stringify(a.trigger) !== JSON.stringify(b.trigger),
  }
}

export function diffIsEmpty(d: WfDiff): boolean {
  return (
    d.stepsAdded.length === 0 &&
    d.stepsRemoved.length === 0 &&
    d.gatesChanged.length === 0 &&
    d.edgesAdded.length === 0 &&
    d.edgesRemoved.length === 0 &&
    !d.triggerChanged
  )
}

/** The one honest status. Precedence: halt → clock → dials. */
export function routineStatus(
  r: BuiltinRoutine,
  state: FleetState | null,
  jobs: ScheduleJob[],
  charters: CharterRow[],
): RoutineStatus {
  if (state?.halted) {
    return {
      kind: 'halted',
      label: 'Halted',
      // A halt blocks manual runs too — executeCharter gates them.
      why: state.haltReason ? `Stopped: ${state.haltReason}` : 'Stopped by the operator.',
    }
  }
  if (!r.scheduleKey) {
    return { kind: 'ready', label: 'Ready', why: 'Runs the moment you start it.' }
  }
  const job = jobs.find((j) => j.key === r.scheduleKey)
  if (!job || !job.enabled) {
    return { kind: 'off', label: 'Off', why: 'The fleet clock is off — nothing runs on schedule.' }
  }
  const on = (c: CharterRow) => c.enabled && c.autonomyLevel !== 'OFF'
  const analystsOn = charters.filter((c) => c.tier === 'analyst' && on(c)).length
  if (r.mode === 'sweep') {
    if (analystsOn === 0) {
      return { kind: 'idle', label: 'Idle', why: 'The clock ticks, but every worker is off.' }
    }
    return {
      kind: 'on',
      label: 'On',
      why: `${analystsOn} worker${analystsOn === 1 ? '' : 's'} will report.`,
    }
  }
  const directorOn = charters.some((c) => c.key === DIRECTOR_KEY && on(c))
  const criticOn = charters.some((c) => c.key === CRITIC_KEY && on(c))
  if (!directorOn || !criticOn) {
    return { kind: 'idle', label: 'Idle', why: 'Needs the director and the critic switched on.' }
  }
  if (analystsOn === 0) {
    return { kind: 'idle', label: 'Idle', why: 'Director and critic are on, but no workers report.' }
  }
  return {
    kind: 'on',
    label: 'On',
    why: `${analystsOn} report → director plans → critic rules.`,
  }
}
