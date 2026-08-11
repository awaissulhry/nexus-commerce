/**
 * NAF.SB.M.1a — the Fleet map's one read.
 *
 * Study: docs/2026-08-07-naf-sbm-fleet-map-page.md (§M9) and the section
 * studies that follow it.
 *
 * WHY THIS EXISTS. Today every number on the map is derived in the browser
 * from paginated lists — `runs?limit=60` and `findings?limit=60` — so a card
 * reading "12 open" means "12 within the last 60 rows fetched", and the edge
 * labels are worse: `FleetTab.tsx:430-440` labels a finding edge with the
 * SOURCE worker's open-findings count and the director→critic edge with
 * `plans.length`, every plan that has ever existed. Nothing has crossed those
 * edges. This service replaces guesses with counted facts.
 *
 * THREE RULES IT IS BUILT ON, each of which cost something to learn.
 *
 * 1. THE WIRING IS NOT `FLEET_GRAPH`. Since WF.4a the orchestrator walks the
 *    stored definition (`orchestrator.ts:198-227`), and WF.6a added custom
 *    workflows that can wire workers `FLEET_GRAPH` never declares. Drawing the
 *    code constant would be provably wrong the first time a revision is
 *    published. We read `getEffectiveWiring()` — every ENABLED workflow's
 *    effective definition with its source — and draw the UNION (locks doc §5
 *    decision 6, reviewed by the Workflows stream 2026-08-07).
 *
 * 2. ...BUT THE WIRING IS NOT THE WHOLE FLEET EITHER. `getEffectiveWiring`'s
 *    own doc comment says it: job furniture — the auditor's post-scorecards
 *    run, grading, report cards — is deliberately NOT in any stored definition
 *    because its ordering is code (`workflow-defs.ts:9-14`, and `walkSteps()`
 *    filters `!n.standalone` at `:50`). A map built purely from definitions
 *    silently omits `fleet-auditor`, a worker the nightly job really runs. So
 *    furniture is overlaid from `FLEET_GRAPH` and LABELLED as furniture via
 *    `lane`. The page states the distinction rather than hiding it.
 *
 * 3. STATUS IS NOT DERIVED HERE. The five-way failure taxonomy and the six
 *    status words live in `apps/web/src/app/fleet/_shared/run-health.ts`,
 *    which the Workers stream owns and the Workers roster calls. If this
 *    service derived status independently, the map and the roster would
 *    eventually disagree about what "failed" means — which is the exact
 *    failure that module's header says it exists to prevent. We ship the RAW
 *    fields the classifier needs and the browser calls the shared function.
 *    Relocating that module server-side is a REQUEST to the Workers stream,
 *    not a claim, so nothing here depends on it.
 *
 * Everything is read-only. The map never writes (operator decision D3).
 */
import prisma from '../../db.js'
import { listCharters } from './charter-registry.js'
import { FLEET_GRAPH } from './fleet-graph.js'
import { resolveFleetLabels } from './fleet-labels.service.js'
import { getFleetSchedule, type FleetScheduleJob } from './fleet-schedule.service.js'
import { getFleetState, type FleetStateView } from './fleet-state.service.js'
import { defToGraph } from './workflow-defs.js'
import { topoLevels } from './fleet-graph.js'
import { getEffectiveWiring } from './workflow-registry.service.js'

/* ── the window ────────────────────────────────────────────────────────── */

export type WindowKey = '24h' | '7d' | '30d' | 'all'

const WINDOW_DAYS: Record<WindowKey, number | null> = {
  '24h': 1,
  '7d': 7,
  '30d': 30,
  all: null,
}

export function parseWindow(raw: string | undefined): WindowKey {
  return raw != null && raw in WINDOW_DAYS ? (raw as WindowKey) : '7d'
}

/* ── the payload ───────────────────────────────────────────────────────── */

/** One run, raw. The browser classifies it with the shared `classifyFailure`;
 *  this is exactly the field set that function reads, plus identity. */
export interface MapRun {
  id: string
  createdAt: Date
  endedAt: Date | null
  status: string
  ok: boolean
  mode: string | null
  trigger: string
  errorMessage: string | null
  haltedReason: string | null
  findingCount: number
  costUSD: number
  latencyMs: number | null
  model: string | null
  provider: string | null
  workflowKey: string | null
  assignmentId: string | null
}

export interface MapNode {
  key: string
  name: string
  description: string | null
  tier: string
  domain: string
  diagnostic: boolean
  templateKey: string | null
  /** Where this worker sits in the picture. `ranked` = a step of some enabled
   *  workflow. `standalone` = job furniture, run by the job rather than by the
   *  wiring (see rule 2 in the header). `unwired` = in the registry, named by
   *  no enabled workflow — an operator instance today, because nothing yet
   *  gives an instance its template's edges. */
  lane: 'ranked' | 'standalone' | 'unwired'
  /** Topological level within the union wiring; null off the ranked lane, and
   *  null for everything if the union could not be ordered. */
  rank: number | null
  charter: {
    enabled: boolean
    autonomyLevel: string
    autonomyCap: string
    degraded: boolean
    provisioned: boolean | null
    pausedUntil: Date | null
    pausedReason: string | null
    activeRevisionNumber: number | null
    modelProvider: string | null
    modelName: string | null
    cadence: string | null
    scopeMarketplaces: string[]
    scopePortfolioIds: string[]
    scopeCampaignIds: string[]
    dailyBudgetUSD: number
    maxTokensPerRun: number
    maxFindingsPerRun: number
    maxToolCallsPerRun: number
  }
  lastRun: MapRun | null
  /*
   * S9.c/S9.d — REMOVED HERE: `recentRuns` and `runs.notOkWindow`.
   *
   * `recentRuns` carried the comment *"the inspector rail renders these"*. It
   * does not, and never did — the rail imports only `ago` from run-health and
   * ends in links to Activity, which is where run history lives. The field was
   * 28% of a 27.1 KB payload (27.1 → 19.5 KB) and was read by nothing.
   *
   * `notOkWindow` was the sole consumer of a JS derivation over the `take: 400`
   * slice, while `runs.window` beside it came from an uncapped `groupBy` — two
   * numbers on one card from two populations. Also read by nothing.
   *
   * ⚠ THE LESSON THAT COMMENT CARRIED, KEPT because it outlives the field: an
   * `AgentRun` is created `ok: false` and only flips true at completion, so
   * counting `!ok` counts the run that is still in flight. It cost the Workers
   * stream three separate bugs. Nothing in this file counts `!ok` any more; if
   * something ever does again, exclude `status === 'running'`.
   */
  runs: {
    window: number
    lifetime: number
    runningNow: boolean
    /**
     * ⚠ S9.e — AWAITING A READER, and kept deliberately. Nothing renders these
     * two, but they are unread because the fleet is OFF, not because the design
     * moved past them: `runningNow` (which IS read, via run-health) can only
     * say THAT something is running, and the moment the fleet is lit an
     * operator needs to know which run and for how long. Deleting them would
     * have to be undone that day.
     *
     * This is the distinction S9 drew: delete what the design has moved past,
     * mark what only the fleet being off explains.
     */
    runningRunId: string | null
    runningSince: Date | null
  }
  findings: {
    open: number
    openExpired: number
    bySeverity: Record<string, number>
  }
  plans: {
    authoredWindow: number
    verdictsWindow: { pass: number; revise: number; block: number }
  }
  approvals: { waiting: number; scheduled: number }
  cost: {
    currency: 'USD'
    windowUSD: number
    /** How many runs produced `windowUSD`. Without it, $0.00 over three runs
     *  and $0.00 over no runs render identically — one is a measured zero and
     *  the other is no data, and the overlay must not colour them the same.
     *  S7.c made the card honour this; it is the most load-bearing field here. */
    runs: number
    /* S9.d — `todayUSD` (per node), `inputTokensWindow` and `outputTokensWindow`
       removed: all three were read by nothing. The FLEET-level `spentTodayUSD`
       on `state` is read, and stays — it is the one the census band spends
       against the daily cap. */
    lifetimeUSD: number
  }
  declaredBy: Array<{ workflowKey: string; kind: string; source: string }>
}

export interface MapEdge {
  /** Server-assigned, and the unit the URL uses. One edge per
   *  (from, to, artifact) however many workflows declare it. */
  id: string
  from: string
  to: string
  artifact: string
  declaredBy: Array<{ workflowKey: string; kind: string; source: string }>
  counts: { crossed: number; dropped: number; conflicted: number }
  /** LIFETIME, deliberately. It drives the stroke, and a 24-hour window must
   *  not be able to un-solid an edge that has genuinely carried work. */
  everCrossed: boolean
  dropped: Array<{ findingId: string; charterKey: string | null; reason: string }>
  conflicts: Array<{ findingIds: string[]; kind: string | null; resolution: string | null }>
  samples: Array<{
    id: string
    kind: string
    entityId: string
    entityName: string | null
    severity: string
  }>
  verdicts: { pass: number; revise: number; block: number } | null
  /**
   * S4 — `summary` is the critic's OWN SENTENCE about the plan, and it was
   * already being read and thrown away: this service selects `criticNotes` and
   * extracted nothing from it but `blockedItems.length`.
   *
   * That mattered because of an asymmetry the map made visible. The finding
   * edge accounts for every dropped item in the director's own words; the plan
   * edge could say `Blocked = 1` and never say why — on the most consequential
   * verdict the fleet produces. `overrideNote` carries the other case:
   * `fleet-council.service.ts` can flip a `pass` to `block` from deterministic
   * pre-checks, and when it does, the critic's summary describes a verdict that
   * is no longer the one in force.
   */
  lastCritique: {
    planId: string
    verdict: string
    blockedCount: number
    summary: string | null
    overrideNote: string | null
  } | null
  /** How `crossed` was counted, so the tooltip can say it honestly.
   *  `plan-items` — resolved from AgentPlan.items[].findingId, the join
   *  scorecard.service.ts already runs. `none` — this edge cannot carry a
   *  volume at all: the critic UPDATES the plan row in place rather than
   *  authoring an artifact, so there is no second row to count. */
  /**
   * S4.k — the most recent verdict IGNORING the window, so "nothing reviewed"
   * can tell the two cases apart.
   *
   * The page already draws this distinction everywhere else: `overlays.ts`
   * separates "never run" from "has run before, but not inside the time window
   * you are looking at", because they are different facts. The plan edge did
   * not, and it mattered — this fleet's only critique is a 9-item BLOCK with a
   * 945-character reason, and at the default 7-day window the panel said
   * "Nothing has been reviewed yet", which reads as *never happened*.
   *
   * Out-of-window content is NOT promoted into the window. The panel says where
   * to look; it does not quietly show older data under an in-window heading.
   */
  latestCritique: { verdict: string; at: string; inWindow: boolean } | null
  lineageNote: string
}

export interface FleetMapView {
  asOf: Date
  window: { key: WindowKey; days: number | null; since: Date | null }
  state: FleetStateView & { spentTodayUSD: number }
  schedule: FleetScheduleJob[]
  wiring: {
    workflows: Array<{
      workflowKey: string
      kind: string
      source: string
      trigger: string
    }>
    /** True when the stored layer could not be read at all and the picture
     *  fell back to the code graph — the same fail-open law the orchestrator
     *  uses, surfaced instead of hidden. */
    degraded: boolean
    /**
     * Null when the union could be topologically ordered. Otherwise the reason,
     * and every `rank` is null.
     *
     * ⚠ S9.e — AWAITING A READER. Nothing renders this today, while its twin
     * `degraded` is read nine times and the warning that accompanies it IS
     * rendered. It is kept rather than deleted because a cycle in the wiring is
     * exactly the state an operator must be able to see, and the missing piece
     * is a reader, not the field. Do not delete it as dead code; give it one.
     */
    unorderedReason: string | null
  }
  nodes: MapNode[]
  edges: MapEdge[]
  /** Only the lifetime scalars that are NOT derivable from `nodes`. Anything
   *  countable from the node array is counted there, once. */
  totals: { runsLifetime: number; crossedLifetime: number }
  /** Things the reader is owed rather than protected from. */
  warnings: string[]
}

/* ── helpers ───────────────────────────────────────────────────────────── */

const num = (d: unknown): number => (d == null ? 0 : Number(d))

const edgeId = (from: string, to: string, artifact: string) => `${from}~${to}~${artifact}`

/**
 * UTC day start. The fleet's budget guard bounds a day this way, in JS, never
 * `AT TIME ZONE` in SQL — matched here so the map's "today" and the guard's
 * "today" cannot disagree. That part is unchanged and is the reason for it.
 *
 * S9.f — THE SECOND HALF OF THIS COMMENT WAS A CLAIM ABOUT ANOTHER SURFACE,
 * AND IT WAS NOT TRUE. It said "§M1 discloses the difference rather than
 * quietly showing a third number". §M1's own definition still reads "since
 * midnight", unqualified, and said nothing about UTC for months.
 *
 * The disclosure DOES exist now — S7.d's window sentence under the band and
 * S8.c's drawer both say "today means a UTC day" — but they were written days
 * later, they are different surfaces, and NEITHER mentions the Workers roster's
 * figure, which is what this comment claimed was disclosed.
 *
 * The disagreement itself is real and cannot be deployed away: `WorkersClient`
 * computes `setHours(0,0,0,0)` IN THE BROWSER, so it is the operator's local
 * midnight. At UTC+2 the two pages describe different two-hour windows every
 * night. Measured 2026-08-11: UTC boundary 00:00Z, roster boundary 22:00Z the
 * previous day; both read $0.00 that day, so the disagreement was structural
 * and invisible.
 *
 * Whether the roster should change is the Workers stream's call and is posted
 * to the locks doc. What this file owes is to stop asserting a disclosure it
 * does not control.
 */
function utcDayStart(now: Date): Date {
  const d = new Date(now)
  d.setUTCHours(0, 0, 0, 0)
  return d
}

interface PlanItem {
  findingId?: string
  rank?: number
  tool?: string
}
interface DroppedItem {
  findingId?: string
  reason?: string
}
interface ConflictItem {
  findingIds?: string[]
  kind?: string
  resolution?: string
}

/* ── the read ──────────────────────────────────────────────────────────── */

export async function getFleetMap(windowKey: WindowKey = '7d'): Promise<FleetMapView> {
  const asOf = new Date()
  const days = WINDOW_DAYS[windowKey]
  const since = days == null ? null : new Date(asOf.getTime() - days * 24 * 3600_000)
  const warnings: string[] = []

  /* 1 — who exists. Retired workers are excluded here, once: they cannot run
     (`resolveCharter` refuses them), so they are not part of the fleet AS IT
     IS, which is this page's whole sentence. Their history lives on Workers. */
  const charters = (await listCharters()).filter((c) => !c.retired)
  const byKey = new Map(charters.map((c) => [c.key, c]))

  /* 2 — the wiring: the union of every ENABLED workflow's effective
     definition. Fail-open to the code graph, matching the orchestrator's law
     that an unreadable stored layer runs the code path rather than nothing. */
  let wiringRows: Awaited<ReturnType<typeof getEffectiveWiring>> = []
  let wiringDegraded = false
  try {
    wiringRows = await getEffectiveWiring()
  } catch {
    wiringDegraded = true
    warnings.push(
      'The stored workflow layer could not be read, so this map shows the code-declared wiring. That is what would run.',
    )
  }

  const declaredByNode = new Map<string, MapNode['declaredBy']>()
  const declaredByEdge = new Map<string, MapEdge['declaredBy']>()
  const edgeSeed = new Map<string, { from: string; to: string; artifact: string }>()
  const unionNodes = new Set<string>()

  const addWiring = (
    workflowKey: string,
    kind: string,
    source: string,
    steps: Array<{ charterKey: string }>,
    edges: Array<{ from: string; to: string; artifact: string }>,
  ) => {
    for (const s of steps) {
      unionNodes.add(s.charterKey)
      const list = declaredByNode.get(s.charterKey) ?? []
      list.push({ workflowKey, kind, source })
      declaredByNode.set(s.charterKey, list)
    }
    for (const e of edges) {
      const id = edgeId(e.from, e.to, e.artifact)
      edgeSeed.set(id, { from: e.from, to: e.to, artifact: e.artifact })
      const list = declaredByEdge.get(id) ?? []
      list.push({ workflowKey, kind, source })
      declaredByEdge.set(id, list)
    }
  }

  if (wiringRows.length > 0) {
    for (const row of wiringRows) {
      addWiring(row.workflowKey, row.kind, row.source, row.definition.steps, row.definition.edges)
    }
  } else {
    // No enabled workflow contributed a definition. The code graph is what the
    // fallback path walks, so it is what the map must show.
    if (!wiringDegraded) {
      warnings.push(
        'No enabled workflow declares any wiring, so this map shows the code-declared wiring.',
      )
    }
    addWiring(
      'fleet-sweep',
      'builtin',
      'code',
      FLEET_GRAPH.nodes.filter((n) => !n.standalone).map((n) => ({ charterKey: n.key })),
      FLEET_GRAPH.edges,
    )
  }

  /* 3 — rank, from the union. `topoLevels` throws on a cycle or an unknown
     endpoint; a union across several workflows can produce either, and a
     thrown layout is not a reason to show no map. */
  const rankOf = new Map<string, number>()
  let unorderedReason: string | null = null
  try {
    const unionGraph = defToGraph({
      v: 1,
      trigger: { type: 'manual' },
      steps: [...unionNodes].sort().map((charterKey) => ({ charterKey, gate: 'inherit' as const })),
      edges: [...edgeSeed.values()].map((e) => ({
        from: e.from,
        to: e.to,
        artifact: e.artifact as 'finding' | 'plan' | 'strategy',
      })),
    })
    topoLevels(unionGraph).forEach((level, i) => {
      for (const k of level) rankOf.set(k, i)
    })
  } catch (err) {
    unorderedReason = String(err instanceof Error ? err.message : err)
    warnings.push(
      'The enabled workflows do not combine into one ordered picture, so the columns are not ranked.',
    )
  }

  /* 4 — job furniture. Not in any stored definition, by design; overlaid so a
     worker that really runs nightly does not vanish from the map. */
  const furniture = new Set(FLEET_GRAPH.nodes.filter((n) => n.standalone).map((n) => n.key))

  const laneOf = (key: string): MapNode['lane'] =>
    unionNodes.has(key) ? 'ranked' : furniture.has(key) ? 'standalone' : 'unwired'

  /* 5 — the aggregates. One grouped query per fact, never a query per node. */
  const runWhere = { mode: { not: null }, ...(since ? { createdAt: { gte: since } } : {}) }

  const [
    runsWindow,
    runsLifetime,
    runningRows,
    lastRunRows,
    findingRows,
    planRows,
    approvalRows,
    todayRows,
  ] = await Promise.all([
    prisma.agentRun.groupBy({
      by: ['agentKey'],
      where: runWhere,
      _count: { _all: true },
      _sum: { costUSD: true, inputTokens: true, outputTokens: true },
    }),
    prisma.agentRun.groupBy({
      by: ['agentKey'],
      where: { mode: { not: null } },
      _count: { _all: true },
      _sum: { costUSD: true },
    }),
    prisma.agentRun.findMany({
      where: { mode: { not: null }, status: 'running' },
      select: { id: true, agentKey: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.agentRun.findMany({
      where: { mode: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 400,
      select: {
        id: true,
        agentKey: true,
        createdAt: true,
        endedAt: true,
        status: true,
        ok: true,
        mode: true,
        trigger: true,
        errorMessage: true,
        haltedReason: true,
        findingCount: true,
        costUSD: true,
        latencyMs: true,
        model: true,
        provider: true,
        workflowKey: true,
        assignmentId: true,
      },
    }),
    prisma.agentFinding.findMany({
      where: { status: 'open' },
      select: {
        id: true,
        charterKey: true,
        severity: true,
        expiresAt: true,
        kind: true,
        entityId: true,
        entityName: true,
        planId: true,
      },
    }),
    prisma.agentPlan.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        charterKey: true,
        createdAt: true,
        items: true,
        droppedItems: true,
        conflicts: true,
        criticVerdict: true,
        criticNotes: true,
      },
    }),
    prisma.agentApproval.findMany({
      where: { status: { in: ['pending', 'scheduled'] } },
      select: { id: true, status: true, agentRunId: true },
    }),
    prisma.agentRun.groupBy({
      by: ['agentKey'],
      where: { mode: { not: null }, createdAt: { gte: utcDayStart(asOf) } },
      _sum: { costUSD: true },
    }),
  ])

  /* runs → per key */
  const windowByKey = new Map(runsWindow.map((r) => [r.agentKey, r]))
  const lifetimeByKey = new Map(runsLifetime.map((r) => [r.agentKey, r]))
  const runningByKey = new Map<string, { id: string; createdAt: Date }>()
  for (const r of runningRows) {
    if (!runningByKey.has(r.agentKey)) runningByKey.set(r.agentKey, { id: r.id, createdAt: r.createdAt })
  }

  const recentByKey = new Map<string, MapRun[]>()
  const toMapRun = (r: (typeof lastRunRows)[number]): MapRun => ({
    id: r.id,
    createdAt: r.createdAt,
    endedAt: r.endedAt,
    status: r.status,
    ok: r.ok,
    mode: r.mode,
    trigger: r.trigger,
    errorMessage: r.errorMessage,
    haltedReason: r.haltedReason,
    findingCount: r.findingCount,
    costUSD: num(r.costUSD),
    latencyMs: r.latencyMs,
    model: r.model,
    provider: r.provider,
    workflowKey: r.workflowKey,
    assignmentId: r.assignmentId,
  })
  for (const r of lastRunRows) {
    const list = recentByKey.get(r.agentKey) ?? []
    if (list.length < 5) {
      list.push(toMapRun(r))
      recentByKey.set(r.agentKey, list)
    }
  }
  if (lastRunRows.length === 400) {
    warnings.push(
      'Run detail is read from the most recent 400 fleet runs; totals and costs are counted over all of them.',
    )
  }

  /* findings → per key */
  const findingsByKey = new Map<
    string,
    { open: number; openExpired: number; bySeverity: Record<string, number> }
  >()
  const findingById = new Map(findingRows.map((f) => [f.id, f]))
  const charterOfFinding = new Map(findingRows.map((f) => [f.id, f.charterKey]))
  for (const f of findingRows) {
    const cur =
      findingsByKey.get(f.charterKey) ?? { open: 0, openExpired: 0, bySeverity: {} }
    cur.open += 1
    if (f.expiresAt <= asOf) cur.openExpired += 1
    cur.bySeverity[f.severity] = (cur.bySeverity[f.severity] ?? 0) + 1
    findingsByKey.set(f.charterKey, cur)
  }

  /* approvals → per key, one batched two-hop (AgentApproval has no charterKey) */
  const approvalRuns = await prisma.agentRun.findMany({
    where: { id: { in: approvalRows.map((a) => a.agentRunId) } },
    select: { id: true, agentKey: true },
  })
  const keyOfRun = new Map(approvalRuns.map((r) => [r.id, r.agentKey]))
  const approvalsByKey = new Map<string, { waiting: number; scheduled: number }>()
  for (const a of approvalRows) {
    const key = keyOfRun.get(a.agentRunId)
    if (!key) continue
    const cur = approvalsByKey.get(key) ?? { waiting: 0, scheduled: 0 }
    if (a.status === 'scheduled') cur.scheduled += 1
    else cur.waiting += 1
    approvalsByKey.set(key, cur)
  }

  /* plans → per key, and the edge lineage */
  const plansByKey = new Map<
    string,
    { authoredWindow: number; verdictsWindow: { pass: number; revise: number; block: number } }
  >()
  const crossedByPair = new Map<string, number>()
  const crossedLifetimeByPair = new Map<string, number>()
  const droppedByPair = new Map<string, MapEdge['dropped']>()
  const conflictsByPair = new Map<string, MapEdge['conflicts']>()
  const samplesByPair = new Map<string, MapEdge['samples']>()
  const verdictsByPair = new Map<string, { pass: number; revise: number; block: number }>()
  const lastCritiqueByPair = new Map<string, MapEdge['lastCritique']>()
  const latestCritiqueByPair = new Map<string, MapEdge['latestCritique']>()

  for (const p of planRows) {
    const inWindow = !since || p.createdAt >= since
    if (inWindow) {
      const cur =
        plansByKey.get(p.charterKey) ?? {
          authoredWindow: 0,
          verdictsWindow: { pass: 0, revise: 0, block: 0 },
        }
      cur.authoredWindow += 1
      if (p.criticVerdict === 'pass') cur.verdictsWindow.pass += 1
      else if (p.criticVerdict === 'revise') cur.verdictsWindow.revise += 1
      else if (p.criticVerdict === 'block') cur.verdictsWindow.block += 1
      plansByKey.set(p.charterKey, cur)
    }

    // Analyst → director: a finding CROSSED when the director named it in the
    // plan's items. `AgentFinding.planId` exists and is indexed but is never
    // written by any code path (`agent-executor.ts` omits it on both the
    // create and the update branch), so this join is the honest substitute —
    // and it is the same one `scorecard.service.ts` already runs to compute
    // `promoted`. It is exact for what the director KEPT.
    const items = (p.items as PlanItem[] | null) ?? []
    for (const it of items) {
      if (!it.findingId) continue
      const src = charterOfFinding.get(it.findingId)
      if (!src) continue
      const id = edgeId(src, p.charterKey, 'finding')
      crossedLifetimeByPair.set(id, (crossedLifetimeByPair.get(id) ?? 0) + 1)
      if (inWindow) {
        crossedByPair.set(id, (crossedByPair.get(id) ?? 0) + 1)
        const f = findingById.get(it.findingId)
        if (f) {
          const s = samplesByPair.get(id) ?? []
          if (s.length < 5) {
            s.push({
              id: f.id,
              kind: f.kind,
              entityId: f.entityId,
              entityName: f.entityName,
              severity: f.severity,
            })
            samplesByPair.set(id, s)
          }
        }
      }
    }

    // The other half of the truth, and the half no other page can show: the
    // charter REQUIRES the director to list every open finding it did not
    // carry, with a reason. "4 carried, 11 considered and dropped" is a fact
    // about the handoff that a node count cannot express.
    const dropped = (p.droppedItems as DroppedItem[] | null) ?? []
    for (const d of dropped) {
      if (!d.findingId) continue
      const src = charterOfFinding.get(d.findingId)
      if (!src || !inWindow) continue
      const id = edgeId(src, p.charterKey, 'finding')
      const list = droppedByPair.get(id) ?? []
      if (list.length < 10) {
        list.push({ findingId: d.findingId, charterKey: src, reason: d.reason ?? '' })
        droppedByPair.set(id, list)
      }
    }

    const conflicts = (p.conflicts as ConflictItem[] | null) ?? []
    for (const c of conflicts) {
      const ids = c.findingIds ?? []
      const src = ids.map((i) => charterOfFinding.get(i)).find(Boolean)
      if (!src || !inWindow) continue
      const id = edgeId(src, p.charterKey, 'finding')
      const list = conflictsByPair.get(id) ?? []
      list.push({ findingIds: ids, kind: c.kind ?? null, resolution: c.resolution ?? null })
      conflictsByPair.set(id, list)
    }

    // Director → critic. This edge can never carry a volume: the critic does
    // not author an artifact, it UPDATES the plan row in place with a verdict
    // (`agent-executor.ts` critic branch). So it carries the verdict instead,
    // which is the honest thing that crossed it.
    if (p.criticVerdict) {
      for (const seed of edgeSeed.values()) {
        if (seed.from !== p.charterKey || seed.artifact !== 'plan') continue
        const lid = edgeId(seed.from, seed.to, seed.artifact)
        // `planRows` is ordered createdAt desc and is NOT window-filtered, so
        // the first verdict seen for a pair is the most recent one there is.
        if (!latestCritiqueByPair.has(lid)) {
          latestCritiqueByPair.set(lid, {
            verdict: p.criticVerdict,
            at: p.createdAt.toISOString(),
            inWindow,
          })
        }
      }
    }

    if (p.criticVerdict && inWindow) {
      for (const seed of edgeSeed.values()) {
        if (seed.from !== p.charterKey || seed.artifact !== 'plan') continue
        const id = edgeId(seed.from, seed.to, seed.artifact)
        const v = verdictsByPair.get(id) ?? { pass: 0, revise: 0, block: 0 }
        if (p.criticVerdict === 'pass') v.pass += 1
        else if (p.criticVerdict === 'revise') v.revise += 1
        else if (p.criticVerdict === 'block') v.block += 1
        verdictsByPair.set(id, v)
        if (!lastCritiqueByPair.has(id)) {
          const notes =
            (p.criticNotes as {
              blockedItems?: unknown[]
              summary?: unknown
              note?: unknown
            } | null) ?? null
          const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
          lastCritiqueByPair.set(id, {
            planId: p.id,
            verdict: p.criticVerdict,
            blockedCount: Array.isArray(notes?.blockedItems) ? notes.blockedItems.length : 0,
            summary: str(notes?.summary),
            overrideNote: str(notes?.note),
          })
        }
      }
    }
  }

  /* 6 — fleet state and schedule */
  const state = await getFleetState()
  // The ledger read succeeded if we got here — `todayRows` is part of the
  // Promise.all above, so an unreadable spend ledger throws before this point
  // rather than silently reporting $0.00, which would read as "spent nothing".
  const spentTodayUSD = todayRows.reduce((s, r) => s + num(r._sum.costUSD), 0)
  /*
   * S9.a — THE LAST PLACE ON THIS PAGE WHERE ABSENCE AND FAILURE LOOKED ALIKE.
   *
   * This `catch` returned `[]` and said nothing, so "the fleet has no scheduled
   * jobs" and "the schedule could not be read" rendered identically. That is
   * the defect class every other section of this page has removed — and the
   * same file gets it right three lines of code away, where an unreadable
   * wiring layer sets `degraded` AND pushes a warning.
   *
   * Degrading is still the right call here: a schedule that cannot be read is
   * no reason to deny the operator seven workers, four edges and a spend
   * figure. It just has to say so.
   */
  const schedule = await getFleetSchedule(asOf)
    .then((s) => s.jobs)
    .catch(() => {
      warnings.push(
        'The schedule could not be read, so no next-run times are shown. Everything else on this page is unaffected.',
      )
      return [] as FleetScheduleJob[]
    })

  /* 7 — assemble the nodes */
  const nodes: MapNode[] = charters.map((c) => {
    const w = windowByKey.get(c.key)
    const l = lifetimeByKey.get(c.key)
    const running = runningByKey.get(c.key)
    const recent = recentByKey.get(c.key) ?? []
    const f = findingsByKey.get(c.key) ?? { open: 0, openExpired: 0, bySeverity: {} }
    const p =
      plansByKey.get(c.key) ?? {
        authoredWindow: 0,
        verdictsWindow: { pass: 0, revise: 0, block: 0 },
      }
    const a = approvalsByKey.get(c.key) ?? { waiting: 0, scheduled: 0 }

    return {
      key: c.key,
      name: c.name,
      description: c.description ?? null,
      tier: c.tier,
      domain: c.domain,
      diagnostic: c.diagnostic === true,
      templateKey: c.templateKey ?? null,
      lane: laneOf(c.key),
      rank: rankOf.has(c.key) ? (rankOf.get(c.key) as number) : null,
      charter: {
        enabled: c.enabled,
        autonomyLevel: c.autonomyLevel,
        autonomyCap: c.autonomyCap,
        degraded: c.degraded,
        provisioned: c.provisioned,
        pausedUntil: c.pausedUntil ?? null,
        pausedReason: c.pausedReason ?? null,
        activeRevisionNumber: c.activeRevisionNumber ?? null,
        modelProvider: c.modelProvider ?? null,
        modelName: c.modelName ?? null,
        cadence: c.cadence ?? null,
        scopeMarketplaces: c.scopeMarketplaces,
        scopePortfolioIds: c.scopePortfolioIds,
        scopeCampaignIds: c.scopeCampaignIds,
        dailyBudgetUSD: c.dailyBudgetUSD,
        maxTokensPerRun: c.maxTokensPerRun,
        maxFindingsPerRun: c.maxFindingsPerRun,
        maxToolCallsPerRun: c.maxToolCallsPerRun,
      },
      lastRun: recent[0] ?? null,
      runs: {
        window: w?._count._all ?? 0,
        lifetime: l?._count._all ?? 0,
        runningNow: running != null,
        runningRunId: running?.id ?? null,
        runningSince: running?.createdAt ?? null,
      },
      findings: f,
      plans: p,
      approvals: a,
      cost: {
        currency: 'USD',
        windowUSD: num(w?._sum.costUSD),
        runs: w?._count._all ?? 0,
        lifetimeUSD: num(l?._sum.costUSD),
      },
      declaredBy: declaredByNode.get(c.key) ?? [],
    }
  })

  /* 7b — resolve the sample findings' entity ids to something a person can
     read. `AgentFinding.entityName` is nullable and is null for every bid
     finding on prod, so without this the inspector prints a bare cuid —
     `cmpsr2iyx00rwry01ji8d1pec` — which tells the operator nothing. The
     resolver already exists and already handles both shapes the fleet emits:
     a numeric external campaign id and an `AdTarget` cuid, which it turns into
     the keyword text plus its match type. Resolving here rather than in the
     browser is the rule: the client is never handed a bare id to render. */
  const sampleEntityIds = [
    ...new Set(
      [...samplesByPair.values()].flat().map((s) => s.entityId).filter((v): v is string => !!v),
    ),
  ]
  let labels: Awaited<ReturnType<typeof resolveFleetLabels>> = { campaigns: {}, targets: {} }
  if (sampleEntityIds.length > 0) {
    labels = await resolveFleetLabels({ args: [], entityIds: sampleEntityIds }).catch(() => ({
      campaigns: {},
      targets: {},
    }))
  }
  /**
   * The fleet emits four shapes of `entityId`, and the resolver keys campaigns
   * by the HEAD of a composite one (`fleet-labels.service.ts:42-44` splits on
   * `:`), so reading it back has to split the same way or every composite id
   * misses and renders raw:
   *   · an AdTarget cuid                      → the keyword and its match type
   *   · `<externalCampaignId>:<search term>`  → the term, and the campaign it
   *                                             was searched in
   *   · `ngram:<phrase>`                      → a phrase seen across campaigns
   *   · a bare external campaign id           → the campaign name
   * Anything else stays as itself. That is the house rule from the entity
   * graph — "an unresolved id is shown as itself — honest, never invented".
   */
  const labelFor = (entityId: string): string | null => {
    const t = labels.targets[entityId]
    if (t) return `${t.text} (${t.matchType.toLowerCase()}) in ${t.campaignName}`
    const c = labels.campaigns[entityId]
    if (c) return c.name
    const idx = entityId.indexOf(':')
    if (idx > 0) {
      const head = entityId.slice(0, idx)
      const tail = entityId.slice(idx + 1)
      if (head === 'ngram') return `“${tail}” — a phrase seen across campaigns`
      const hc = labels.campaigns[head]
      return hc ? `“${tail}” in ${hc.name}` : `“${tail}”`
    }
    return null
  }

  /* 8 — assemble the edges. One per (from, to, artifact), however many
     workflows declare it; `declaredBy` carries the provenance. */
  const known = new Set(nodes.map((n) => n.key))
  const edges: MapEdge[] = [...edgeSeed.values()]
    .filter((e) => known.has(e.from) && known.has(e.to))
    .map((e) => {
      const id = edgeId(e.from, e.to, e.artifact)
      const isPlan = e.artifact === 'plan'
      const crossed = crossedByPair.get(id) ?? 0
      const crossedLifetime = crossedLifetimeByPair.get(id) ?? 0
      const dropped = droppedByPair.get(id) ?? []
      const conflicts = conflictsByPair.get(id) ?? []
      const verdicts = verdictsByPair.get(id) ?? null
      return {
        id,
        from: e.from,
        to: e.to,
        artifact: e.artifact,
        declaredBy: declaredByEdge.get(id) ?? [],
        counts: { crossed, dropped: dropped.length, conflicted: conflicts.length },
        /**
         * S7.a — this field's own doc comment says LIFETIME, and for a plan
         * edge it was windowed.
         *
         * `verdictsByPair` is built under `if (p.criticVerdict && inWindow)`
         * below, so reading it here made the stroke follow the window — the
         * exact thing the comment on `everCrossed` forbids. Measured on
         * production: `amazon-ads-director → plan-critic`, this fleet's only
         * critique edge and the one carrying a 9-item BLOCK, drew solid at 7d
         * and went dashed grey at 24h. A 24-hour window said a link that has
         * genuinely carried work never had.
         *
         * `latestCritiqueByPair` is the lifetime answer and already exists:
         * S4.k populates it under a bare `if (p.criticVerdict)`, deliberately
         * ignoring the window, for this same class of question. Both it and
         * `crossedLifetime` are bounded by the `take: 200` on `planRows` — the
         * same bound the finding edges have always had, not a new one.
         *
         * `counts.crossed`, `verdicts` and `lastCritique` stay windowed. The
         * label is windowed on purpose; only the stroke is not.
         */
        everCrossed: isPlan ? latestCritiqueByPair.has(id) : crossedLifetime > 0,
        dropped,
        conflicts,
        samples: (samplesByPair.get(id) ?? []).map((s) => ({
          ...s,
          entityName: s.entityName ?? labelFor(s.entityId),
        })),
        verdicts: isPlan ? (verdicts ?? { pass: 0, revise: 0, block: 0 }) : null,
        lastCritique: lastCritiqueByPair.get(id) ?? null,
        latestCritique: isPlan ? (latestCritiqueByPair.get(id) ?? null) : null,
        lineageNote: isPlan
          ? 'The critic does not write an artifact — it records a verdict on the plan itself, so there is nothing to count crossing here.'
          : 'Counted from the findings the director named in its plan. A finding it read and dropped is counted separately, with its reason.',
      }
    })

  /* today's spend, per worker and for the fleet, from one grouped read */
  return {
    asOf,
    window: { key: windowKey, days, since },
    state: { ...state, spentTodayUSD },
    schedule,
    wiring: {
      workflows: wiringRows.map((r) => ({
        workflowKey: r.workflowKey,
        kind: r.kind,
        source: r.source,
        trigger: r.definition.trigger.type,
      })),
      degraded: wiringDegraded,
      unorderedReason,
    },
    nodes,
    edges,
    totals: {
      runsLifetime: runsLifetime.reduce((s, r) => s + r._count._all, 0),
      crossedLifetime: [...crossedLifetimeByPair.values()].reduce((s, n) => s + n, 0),
    },
    warnings,
  }
}
