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
import { nextCronFire } from './cron-eval'
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
  workflowKey?: string | null
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

/** The one sentence a schedule the fleet cannot evaluate is allowed to say. */
export const CRON_UNREADABLE = 'not a schedule this fleet can read'

/**
 * S5.b — is this an expression the fleet can actually evaluate? Delegates to
 * the mirrored `nextCronFire`, which is the SAME rule `validateDefinition`
 * applies server-side, so the client can never disagree with the save.
 */
export function cronIsEvaluable(expr: string): boolean {
  return nextCronFire(expr, new Date()) !== null
}

/** The next `n` fire times, in order. Empty for anything unevaluable. */
export function nextCronFires(expr: string, n: number, from: Date = new Date()): Date[] {
  const out: Date[] = []
  let cursor = from
  for (let i = 0; i < n; i++) {
    const next = nextCronFire(expr, cursor)
    if (!next) break
    out.push(next)
    cursor = next
  }
  return out
}

/**
 * The fleet's crons in plain words.
 *
 * S5.b — this used to check only that the minute and hour were INTEGERS, and
 * never that they were in range, so `99 99 * * *` rendered on prod as
 * "Nightly at 99:99 UTC": a confident sentence about an impossible schedule.
 * That is worse than no preview at all. The whole value of a plain-English
 * restatement is that a wrong expression READS wrong — this one read right.
 *
 * So validity is now decided by the same evaluator the server saves against,
 * and anything it refuses gets one honest sentence instead of a fabricated
 * time. Anything valid but beyond the phrasings below echoes as cron, which
 * is not a claim about when it fires; the next-fire list beside it is.
 */
export function prettyCron(expr: string): string {
  // WF.4c — the schedule feed reports a stored manual trigger as 'manual'.
  if (expr === 'manual') return 'When you start it'
  if (!cronIsEvaluable(expr)) return CRON_UNREADABLE
  const [min, hr, dom, mon, dow] = expr.trim().split(/\s+/)
  const m = Number(min)
  const h = Number(hr)
  const everyDate = dom === '*' && mon === '*'
  if (everyDate && min === '0' && hr === '*') return 'Every hour, on the hour'
  if (!Number.isInteger(m) || !Number.isInteger(h)) return `${expr} (UTC)`
  const hhmm = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} UTC`
  if (!everyDate) return `${expr} (UTC)`
  if (dow === '*') return `Nightly at ${hhmm}`
  if (/^[0-6]$/.test(dow ?? '')) return `${DAYS[Number(dow)]}s at ${hhmm}`
  if (dow === '1-5') return `Weekdays at ${hhmm}`
  return `${expr} (UTC)`
}

/* ── assembly ──────────────────────────────────────────────────────────── */

/** Select a routine's runs by MODE (built-ins) or by WORKFLOW KEY (customs —
 *  WF.6a, riding the WF.4a stamps). The key branch must exclude preview
 *  rows, or test runs would pollute a custom's history. */
export type RunSelector = BuiltinRoutine['mode'] | { workflowKey: string }

export function groupRuns(runs: RunRow[], sel: RunSelector): RunGroup[] {
  const matches = (r: RunRow) =>
    typeof sel === 'string'
      ? r.mode === sel
      : r.workflowKey === sel.workflowKey && r.mode !== 'preview'
  const byId = new Map<string, RunRow[]>()
  for (const r of runs) {
    if (!matches(r)) continue
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
 *  nodes are parked in a final column and `cyclic` says so.
 *
 *  S5.c — it also returns WHICH steps the peel could not reach. Those are
 *  exactly the ones in the loop, and the editor marks them on their own cards
 *  instead of only naming the problem in a checklist at the bottom of the
 *  column. One peel answers both questions, so the summary and the cards can
 *  never disagree about which steps are at fault. */
export function topoCols(
  steps: WfStep[],
  edges: WfEdge[],
): { cols: Map<string, number>; cyclic: boolean; cyclicKeys: Set<string> } {
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
  const cyclicKeys = new Set<string>()
  for (const k of keys) {
    if (!cols.has(k)) {
      cols.set(k, level)
      cyclicKeys.add(k)
    }
  }
  return { cols, cyclic: cyclicKeys.size > 0, cyclicKeys }
}

/** Who hands work TO this step. The editor's cards only ever stated the
 *  outgoing direction, so the operator rebuilt the graph by reading every
 *  other card; at six steps that is twenty-five checkboxes to hold in
 *  your head. Derived from the same edges the pickers write. */
export function incomingFor(charterKey: string, edges: WfEdge[]): string[] {
  return edges.filter((e) => e.to === charterKey).map((e) => e.from)
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

/** NAF.WF-S2R / S2.a — the version chip, shared by the list card and the
 *  detail header so the two surfaces cannot describe the same routine
 *  differently. Every routine carries one: a built-in on the code default has
 *  no revision, which is a fact worth stating rather than an absence to hide. */
export interface VersionChip {
  label: string
  /** True for the two non-numbered states — rendered quiet, not blue. */
  neutral: boolean
  hint: string
}
export function versionChipFor(v: {
  activeRevisionNo: number | null
  source: 'code' | 'revision' | 'none'
}): VersionChip {
  if (v.activeRevisionNo != null) {
    return {
      label: `rev ${v.activeRevisionNo}`,
      neutral: false,
      hint: `Running published revision ${v.activeRevisionNo}. Every run stamps the revision that served it.`,
    }
  }
  if (v.source === 'code') {
    return {
      /* Not "built-in wiring" — it sits beside a "Built-in" badge and the pair
         read as a stutter. "As shipped" says the same thing to a beginner. */
      label: 'as shipped',
      neutral: true,
      hint: 'No revision published — this routine runs the wiring that ships in code. Reverting to it can never fail.',
    }
  }
  return {
    label: 'not composed yet',
    neutral: true,
    hint: 'No wiring published, so there is nothing to run. Compose it in the editor and publish a first revision.',
  }
}

/** NAF.WF-S2R / S2.a — the trigger as one line, shared by the list card and
 *  the detail status band. Every branch is the WF.1/WF.6 wording moved
 *  verbatim: a routine with no clock evidence says so rather than inventing
 *  one, and the two surfaces cannot phrase the same clock differently. */
export function triggerLineFor(v: {
  job: ScheduleJob | null
  kind: 'builtin' | 'custom'
  statusKind: StatusKind
}): { main: string; sub: string } {
  if (v.job) {
    return {
      /* prettyCron already answers 'manual' with "When you start it" — the
         schedule feed reports a stored manual trigger that way (WF.4c). */
      main: prettyCron(v.job.schedule),
      sub: v.job.enabled
        ? (until(v.job.nextFireAt) ? `next ${until(v.job.nextFireAt)}` : 'next time unknown')
        : 'not scheduled — the clock is off',
    }
  }
  if (v.kind === 'builtin') {
    return { main: 'When you start it', sub: 'from a worker’s page, or the console' }
  }
  return {
    main: 'When you start it',
    sub:
      v.statusKind === 'ready'
        ? 'Run now, above — or publish a schedule'
        : v.statusKind === 'off'
          ? 'turn it back on, or publish a first revision'
          : 'publish a first revision to run it',
  }
}

/** The capability each kind badge states — not a category label. */
export const KIND_HINT: Record<'builtin' | 'custom', string> = {
  builtin:
    'Ships with the fleet. Its wiring comes from code; publish a revision to change it, and reverting to the built-in can never fail.',
  custom:
    'You created this one. It runs only what you published, and it can be switched off from its own page.',
}

/** WF.6a/6c — the one honest status for a CUSTOM workflow. Precedence:
 *  halt → switched off → no wiring → armed clock → ready-by-hand. */
export function customStatus(
  state: FleetState | null,
  meta: { enabled: boolean; source: 'code' | 'revision' | 'none' },
  job?: ScheduleJob | null,
): RoutineStatus {
  if (state?.halted) {
    return {
      kind: 'halted',
      label: 'Halted',
      why: state.haltReason ? `Stopped: ${state.haltReason}` : 'Stopped by the operator.',
    }
  }
  if (!meta.enabled) {
    return { kind: 'off', label: 'Off', why: 'Switched off by the operator.' }
  }
  if (meta.source !== 'revision') {
    return {
      kind: 'off',
      label: 'Off',
      why: 'No published wiring yet — compose and publish from the editor.',
    }
  }
  // WF.6c — a stored schedule trigger arms a real clock for this custom.
  if (job && job.enabled) {
    return {
      kind: 'on',
      label: 'On',
      why: 'Its clock is armed — and you can still run it by hand.',
    }
  }
  // WF.6b — a published custom is runnable by hand. OFF workers still skip
  // inside the executor; the dials decide what actually executes.
  return {
    kind: 'ready',
    label: 'Ready',
    why: 'Runs the moment you start it — workers that are OFF still skip.',
  }
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
