/**
 * NAF.SB.AS — assignments: one worker, one target, one job.
 *
 * The container is this row; each Start mints one `AgentRun` stamped with
 * `assignmentId`. Machine states are DERIVED from those runs rather than
 * mutated onto the assignment, so every attempt keeps its own error, cost,
 * duration and evidence vintage — a counter on the container would lose
 * every previous failure reason.
 *
 * Auditing is written HERE, in the service, not in the route layer. The
 * known hole this avoids is recorded in the Workers study: audit that lives
 * in routes means a script changing state on prod leaves no trace.
 */
import prisma from '../../db.js'
import { executeCharter } from './agent-executor.js'
import { resolveCharter } from './charter-registry.js'
import { narrowKindsFor } from './observation-builder.js'
import { narrowKindFor, type TargetKind } from './assignment-scope.js'
import { reclaimStuckRuns } from './orchestrator.js'
import { recordControlChange } from './control-audit.service.js'

export type AssignmentState =
  | 'not_started'
  | 'running'
  | 'finished'
  | 'stopped'
  | 'failed'
  | 'abandoned'
  | 'closed'
  | 'cancelled'

/** Terminal-but-reversible. Nothing in the fleet is ever truly deleted once
 *  it has run — these two are human endings, and Reopen undoes both. */
const HUMAN_STATES = new Set<AssignmentState>(['closed', 'cancelled'])

export interface RunRollup {
  id: string
  status: string
  ok: boolean
  findingCount: number
  costUSD: number
  haltedReason: string | null
  errorMessage: string | null
  createdAt: Date
  endedAt: Date | null
}

/**
 * The machine states, derived from the runs. Human states win, because the
 * operator's "I am done with this" outranks the machine's opinion.
 *
 * `abandoned` is matched BEFORE `stopped`: reclaimStuckRuns writes a
 * haltedReason like every other guard, but it means something different —
 * nobody stopped this on purpose, it stopped reporting, and because the
 * reclaimer's updateMany never writes costUSD we cannot say what it spent.
 */
export function deriveState(stored: string, runs: RunRollup[]): AssignmentState {
  if (HUMAN_STATES.has(stored as AssignmentState)) return stored as AssignmentState
  if (runs.some((r) => r.status === 'running')) return 'running'
  const finished = runs.filter((r) => r.status !== 'running')
  if (finished.length === 0) return 'not_started'
  const latest = finished[0] // callers order desc by createdAt
  if (latest.haltedReason?.startsWith('orphaned:')) return 'abandoned'
  if (latest.haltedReason) return 'stopped'
  if (!latest.ok) return 'failed'
  return 'finished'
}

export interface AssignableWorker {
  key: string
  name: string
  tier: string
  description: string | null
  /** Target kinds this worker's evidence can honestly honour. */
  targetKinds: TargetKind[]
  /** Set when the worker cannot be assigned at all, with the operator-facing
   *  reason. The picker prints it rather than greying a row silently. */
  refusal?: string
}

/**
 * Which workers may be assigned, and to what — DERIVED, never a hardcoded
 * list, so a worker becomes assignable the day its evidence gains a narrow()
 * rather than the day someone remembers to edit an array.
 *
 * The three v1 refusals are stated individually because their reasons are
 * genuinely different and an operator deserves to know which wall they hit
 * (docs/2026-08-07-naf-sbas-assignments-page.md §6.5).
 */
export async function listAssignableWorkers(): Promise<AssignableWorker[]> {
  const { listCharters } = await import('./charter-registry.js')
  const charters = await listCharters()
  const out: AssignableWorker[] = []

  for (const c of charters) {
    const base = {
      key: c.key,
      name: c.name,
      tier: c.tier,
      description: c.description ?? null,
    }

    if (c.outputSchemaKey === 'director-output') {
      out.push({
        ...base,
        targetKinds: [],
        refusal:
          'This worker writes a plan, and only the weekly council can pick a plan up. A plan made outside a council is never checked, never queued and never approved — so an assignment here would cost money and produce something you could not act on.',
      })
      continue
    }
    if (c.outputSchemaKey === 'critic-output') {
      out.push({
        ...base,
        targetKinds: [],
        refusal:
          'This worker checks a plan it did not write. With no plan in its evidence it stops before it can report anything — and it stops after the model call, so it would cost money and tell you nothing.',
      })
      continue
    }

    // Derived per kind, never a hardcoded list: a worker gains a target kind
    // the day its evidence can honour it. EVERY observation it reads must
    // support the kind — one unnarrowable feed and the run would read part of
    // the account while claiming to be scoped.
    const kinds: TargetKind[] = (['CAMPAIGN', 'MARKETPLACE', 'PORTFOLIO'] as const).filter(
      (k) => c.observationKeys.every((key) => narrowKindsFor(key).includes(narrowKindFor(k))),
    )
    if (kinds.length === 0) {
      out.push({
        ...base,
        targetKinds: [],
        refusal:
          'This worker reads your whole account every time. Its evidence has nowhere to put a target, so an assignment could not narrow it — and a target that narrows nothing is worse than no target. Run it from Workers.',
      })
      continue
    }

    out.push({ ...base, targetKinds: kinds })
  }
  return out
}

export interface CreateInput {
  charterKey: string
  targetKind?: TargetKind | null
  targetIds?: string[]
  targetLabels?: string[]
  wantBack?: string | null
  dueAt?: string | null
  title?: string
  createdBy?: string | null
}

export interface CreateResult {
  ok: boolean
  id?: string
  error?: string
}

/**
 * Create — and REFUSE, with the reason in the body, any (worker, target)
 * pair the evidence layer cannot honour. Mirrors the two-marketplace refusal
 * at agent-fleet-workers.routes.ts:128-135, and for the same reason: this
 * series' rule is that a control which is not enforced must not be rendered,
 * so a target we cannot bind is refused rather than stored and ignored.
 */
export async function createAssignment(input: CreateInput): Promise<CreateResult> {
  const charter = await resolveCharter(input.charterKey)
  if (!charter) return { ok: false, error: `unknown worker: ${input.charterKey}` }

  const assignable = await listAssignableWorkers()
  const row = assignable.find((a) => a.key === input.charterKey)
  if (!row) return { ok: false, error: `unknown worker: ${input.charterKey}` }
  if (row.refusal) return { ok: false, error: row.refusal }

  const kind = input.targetKind ?? null
  const ids = (input.targetIds ?? []).filter(Boolean)
  if (kind && !row.targetKinds.includes(kind)) {
    return { ok: false, error: `${row.name} cannot be pointed at a ${kind.toLowerCase()}.` }
  }
  if (kind && ids.length === 0) {
    return { ok: false, error: 'Pick at least one target, or leave the target empty.' }
  }
  if (kind === 'MARKETPLACE' && ids.length !== 1) {
    return {
      ok: false,
      error:
        'A marketplace assignment names exactly one marketplace — the evidence layer honours one at a time.',
    }
  }
  if (!kind && ids.length) {
    return { ok: false, error: 'A target was named without a target kind.' }
  }

  const labels = input.targetLabels?.length ? input.targetLabels : ids
  const title =
    input.title?.trim() ||
    defaultTitle(charter.name, kind, labels)

  const created = await prisma.agentAssignment.create({
    data: {
      charterKey: input.charterKey,
      title,
      targetKind: kind,
      targetIds: ids,
      targetLabels: labels,
      wantBack: input.wantBack?.trim() || null,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      createdBy: input.createdBy ?? null,
    },
  })
  return { ok: true, id: created.id }
}

/** Worker + target, in that order — the sentence an operator would say. The
 *  Approvals page renders this verbatim as provenance, so it is never empty. */
export function defaultTitle(
  workerName: string,
  kind: string | null,
  labels: string[],
): string {
  if (!kind || labels.length === 0) return `${workerName} — whole account`
  if (labels.length === 1) return `${workerName} on ${labels[0]}`
  return `${workerName} on ${labels.length} ${kind === 'CAMPAIGN' ? 'campaigns' : 'marketplaces'}`
}

export interface StartResult {
  ok: boolean
  runId?: string | null
  alreadyRunning?: boolean
  error?: string
  haltedReason?: string
}

/**
 * Start — IDEMPOTENT. Starting an assignment that already has an open run
 * returns that run instead of creating a second one (Temporal's
 * WorkflowIdConflictPolicy: UseExisting). This is the one control on the page
 * that spends money, and without this a double-click is two charges on a
 * fleet the operator deliberately switched off.
 */
export async function startAssignment(
  id: string,
  userId?: string | null,
): Promise<StartResult> {
  const a = await prisma.agentAssignment.findUnique({ where: { id } })
  if (!a) return { ok: false, error: 'assignment not found' }
  if (a.state === 'cancelled') {
    return { ok: false, error: 'This assignment was cancelled. Reopen it before starting it.' }
  }

  const open = await prisma.agentRun.findFirst({
    where: { assignmentId: id, status: 'running' },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })
  if (open) return { ok: true, runId: open.id, alreadyRunning: true }

  const result = await executeCharter(a.charterKey, {
    trigger: 'manual',
    mode: 'ask',
    // The same clause POST /agent/fleet/run/:key already uses. It bypasses
    // ONLY the OFF/pause gate; kill switch, fleet halt, both day budgets,
    // evidence staleness and the run token budget all still bind.
    ignoreEnabled: true,
    userId: userId ?? null,
    assignmentId: id,
    assignmentTarget: a.targetKind
      ? {
          kind: a.targetKind as TargetKind,
          ids: a.targetIds,
          labels: a.targetLabels,
        }
      : undefined,
  })

  await prisma.agentAssignment.update({
    where: { id },
    data: { state: 'not_started', closedAt: null },
  })
  await recordControlChange({
    action: 'run_now',
    charterKey: a.charterKey,
    actor: userId ?? null,
    note: `assignment ${id}: ${a.title}`,
  }).catch(() => undefined)

  return {
    ok: result.ok,
    runId: result.runId,
    haltedReason: result.haltedReason,
    error: result.error,
  }
}

export async function setAssignmentState(
  id: string,
  state: 'closed' | 'cancelled' | 'not_started',
  opts: { note?: string | null; userId?: string | null } = {},
): Promise<{ ok: boolean; error?: string }> {
  const a = await prisma.agentAssignment.findUnique({ where: { id } })
  if (!a) return { ok: false, error: 'assignment not found' }

  if (state === 'cancelled') {
    const everRan = await prisma.agentRun.count({ where: { assignmentId: id } })
    if (everRan > 0) {
      return {
        ok: false,
        error:
          'This has already run, so it cannot be cancelled — close it instead. Its runs are the record.',
      }
    }
  }

  await prisma.agentAssignment.update({
    where: { id },
    data: {
      state,
      closeNote: state === 'closed' ? (opts.note?.trim() || null) : null,
      closedAt: state === 'not_started' ? null : new Date(),
    },
  })
  await recordControlChange({
    action: state === 'cancelled' ? 'assignment_cancelled' : 'assignment_closed',
    charterKey: a.charterKey,
    actor: opts.userId ?? null,
    note: `assignment ${id} → ${state}`,
  }).catch(() => undefined)
  return { ok: true }
}

/**
 * Delete — only before anything has run. Once a run exists the runs ARE the
 * record and Close is the correct ending; deleting would orphan run rows that
 * still carry cost. This exists because bulk-create's whole safety argument
 * is that creating is reversible.
 */
export async function deleteAssignment(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const runs = await prisma.agentRun.count({ where: { assignmentId: id } })
  if (runs > 0) {
    return {
      ok: false,
      error: 'This has already run. Close it instead — its runs are part of the record.',
    }
  }
  await prisma.agentAssignment.delete({ where: { id } })
  return { ok: true }
}

function toRollup(r: {
  id: string
  status: string
  ok: boolean
  findingCount: number
  costUSD: unknown
  haltedReason: string | null
  errorMessage: string | null
  createdAt: Date
  endedAt: Date | null
}): RunRollup {
  return {
    id: r.id,
    status: r.status,
    ok: r.ok,
    findingCount: r.findingCount,
    // Decimal → string over JSON; Number() it once, here, so no caller has to.
    costUSD: Number(r.costUSD ?? 0),
    haltedReason: r.haltedReason,
    errorMessage: r.errorMessage,
    createdAt: r.createdAt,
    endedAt: r.endedAt,
  }
}

const RUN_SELECT = {
  id: true,
  status: true,
  ok: true,
  findingCount: true,
  costUSD: true,
  haltedReason: true,
  errorMessage: true,
  createdAt: true,
  endedAt: true,
} as const

/**
 * The list, with each assignment's run rollup folded in.
 *
 * Deliberately NOT a client-side join against `/agent/fleet/runs?limit=100`:
 * that feed is capped server-side and is global, so an assignment older than
 * the newest 100 fleet runs would render "never run" when it had.
 *
 * Calls the reaper first. reclaimStuckRuns fires only from the sweep and
 * council crons, which on a dark fleet may never run at all — so without this
 * an assignment could sit in `running` forever. It is an idempotent
 * updateMany over an indexed predicate.
 */
export async function listAssignments(filter: { charterKey?: string } = {}) {
  await reclaimStuckRuns().catch(() => 0)

  const rows = await prisma.agentAssignment.findMany({
    where: filter.charterKey ? { charterKey: filter.charterKey } : undefined,
    orderBy: { createdAt: 'desc' },
    take: 200,
  })
  if (rows.length === 0) return []

  const runs = await prisma.agentRun.findMany({
    where: { assignmentId: { in: rows.map((r) => r.id) } },
    orderBy: { createdAt: 'desc' },
    select: { ...RUN_SELECT, assignmentId: true },
  })
  const byAssignment = new Map<string, RunRollup[]>()
  for (const r of runs) {
    if (!r.assignmentId) continue
    const list = byAssignment.get(r.assignmentId) ?? []
    list.push(toRollup(r))
    byAssignment.set(r.assignmentId, list)
  }

  const resolves = await targetsThatStillResolve(rows)

  return rows.map((a) => {
    const rs = byAssignment.get(a.id) ?? []
    const last = rs[0] ?? null
    return {
      ...a,
      state: deriveState(a.state, rs),
      storedState: a.state,
      runCount: rs.length,
      targetResolves: resolves.get(a.id) ?? true,
      lastRun: last,
      costUSD: rs.reduce(
        // An abandoned run's cost is unknown, not zero — the reclaimer never
        // writes costUSD. Excluded from the sum and footnoted rather than
        // quietly added as a 0 that makes the total look precise.
        (sum, r) => sum + (r.haltedReason?.startsWith('orphaned:') ? 0 : r.costUSD),
        0,
      ),
      hasUnknownCost: rs.some((r) => r.haltedReason?.startsWith('orphaned:')),
      findingCount: rs.reduce((s, r) => s + r.findingCount, 0),
    }
  })
}

/**
 * NAF.SB.AS-S1R / S1.f — does each assignment still point at something?
 *
 * The list has never been able to say this. `.as-target.gone` was written into
 * the stylesheet at AS.1 and applied by nothing, because nothing on the read
 * path resolved a target — so the only way to learn that a campaign had been
 * archived was to START the run and pay for the model call that told you it had
 * stopped. On a fleet the operator switched off precisely to avoid spending,
 * that is the wrong place to find out.
 *
 * TWO QUERIES FOR THE WHOLE PAGE, not two per row: every campaign id across
 * every assignment goes into one indexed `IN`, and every portfolio id into a
 * second. At the 200-row cap that is still two.
 *
 * **The rule is copied from the executor, deliberately, and it is `some` not
 * `every`:** `resolveAssignmentScope` stops with `target_gone` only when NONE
 * of the named campaigns survive — a partially-archived target still runs, on
 * what is left. A red chip on a row that would run fine would be a new lie
 * replacing the old silence. The two must agree, so this asks the same
 * question: *would a run stop before it started?*
 */
export async function targetsThatStillResolve(
  rows: { id: string; targetKind: string | null; targetIds: string[] }[],
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>()
  const campaignIds = new Set<string>()
  const portfolioIds = new Set<string>()
  for (const r of rows) {
    if (r.targetKind === 'CAMPAIGN') r.targetIds.forEach((i) => i && campaignIds.add(i))
    else if (r.targetKind === 'PORTFOLIO') r.targetIds.forEach((i) => i && portfolioIds.add(i))
  }

  const live = new Set<string>()
  if (campaignIds.size) {
    const found = await prisma.campaign.findMany({
      where: { externalCampaignId: { in: [...campaignIds] } },
      select: { externalCampaignId: true },
    })
    for (const c of found) if (c.externalCampaignId) live.add(c.externalCampaignId)
  }

  const stocked = new Set<string>()
  if (portfolioIds.size) {
    // A portfolio resolves only if it still HOLDS campaigns — an emptied
    // portfolio narrows to nothing and the executor refuses it, so an existence
    // check on the portfolio alone would disagree with the run.
    const found = await prisma.campaign.findMany({
      where: { portfolioId: { in: [...portfolioIds] } },
      select: { portfolioId: true },
      distinct: ['portfolioId'],
    })
    for (const c of found) if (c.portfolioId) stocked.add(c.portfolioId)
  }

  for (const r of rows) {
    if (r.targetKind === 'CAMPAIGN') {
      out.set(r.id, r.targetIds.some((i) => live.has(i)))
    } else if (r.targetKind === 'PORTFOLIO') {
      out.set(r.id, r.targetIds.some((i) => stocked.has(i)))
    } else {
      // A marketplace is a constant and the whole account is always there.
      out.set(r.id, true)
    }
  }
  return out
}

export async function getAssignment(id: string) {
  await reclaimStuckRuns().catch(() => 0)
  const a = await prisma.agentAssignment.findUnique({ where: { id } })
  if (!a) return null

  const runs = await prisma.agentRun.findMany({
    where: { assignmentId: id },
    orderBy: { createdAt: 'desc' },
    select: RUN_SELECT,
  })
  const rollups = runs.map(toRollup)

  /**
   * NAF.SB.AS.5 — findings THIS assignment's runs detected, read through the
   * join rather than `AgentFinding.runId`.
   *
   * `runId` is rewritten by the upsert's update branch on every re-detection,
   * so reading it here would quietly hand this assignment's findings to
   * whichever run noticed them most recently — usually the next nightly sweep.
   * The join records every run that detected a finding, which is the true
   * relationship and survives re-detection by anyone.
   */
  const links = runs.length
    ? await prisma.agentFindingRun.findMany({
        where: { runId: { in: runs.map((r) => r.id) } },
        orderBy: { detectedAt: 'desc' },
        select: { findingId: true },
        take: 200,
      })
    : []
  const findingIds = [...new Set(links.map((l) => l.findingId))]
  const findings = findingIds.length
    ? await prisma.agentFinding.findMany({
        where: { id: { in: findingIds } },
        orderBy: { createdAt: 'desc' },
        take: 12,
        select: {
          id: true,
          severity: true,
          kind: true,
          entityType: true,
          entityId: true,
          entityName: true,
          rationale: true,
          evidenceRefs: true,
          dataVintage: true,
          createdAt: true,
        },
      })
    : []

  /**
   * NAF.SB.AS.5 — the evidence the findings cite, with its vintage. This is
   * what makes a stale-evidence stop explainable without opening a trace, and
   * what makes "what it was allowed to see" auditable after the fact.
   */
  const evidenceIds = [...new Set(findings.flatMap((f) => f.evidenceRefs))]
  const evidence = evidenceIds.length
    ? await prisma.agentObservation.findMany({
        where: { id: { in: evidenceIds } },
        select: { id: true, key: true, dataVintage: true, computedAt: true },
      })
    : []

  const charter = await resolveCharter(a.charterKey)

  return {
    ...a,
    state: deriveState(a.state, rollups),
    storedState: a.state,
    worker: charter
      ? {
          key: charter.key,
          name: charter.name,
          tier: charter.tier,
          autonomyLevel: charter.autonomyLevel,
          autonomyCap: charter.autonomyCap,
          dailyBudgetUSD: charter.dailyBudgetUSD,
        }
      : null,
    runs: rollups,
    findings,
    evidence,
    /** Total detected, so the capped list can say what it is a slice of. */
    findingTotal: findingIds.length,
    costUSD: rollups.reduce(
      (s, r) => s + (r.haltedReason?.startsWith('orphaned:') ? 0 : r.costUSD),
      0,
    ),
    hasUnknownCost: rollups.some((r) => r.haltedReason?.startsWith('orphaned:')),
  }
}

/**
 * NAF.SB.AS.2 — portfolios an assignment can actually be pointed at.
 *
 * Derived from the campaigns that reference them, so a portfolio only appears
 * if it has campaigns to narrow to. `Campaign.portfolioId` holds the EXTERNAL
 * Amazon portfolio id, which is the same value `AmazonAdsPortfolio.portfolioId`
 * carries — that join is what supplies the human name.
 */
export async function listAssignablePortfolios(): Promise<
  { portfolioId: string; name: string; campaignCount: number; marketplaces: string[] }[]
> {
  const campaigns = await prisma.campaign.findMany({
    where: { portfolioId: { not: null }, externalCampaignId: { not: null } },
    select: { portfolioId: true, marketplace: true },
  })
  if (campaigns.length === 0) return []

  const byPortfolio = new Map<string, { count: number; markets: Set<string> }>()
  for (const c of campaigns) {
    if (!c.portfolioId) continue
    const e = byPortfolio.get(c.portfolioId) ?? { count: 0, markets: new Set<string>() }
    e.count++
    e.markets.add(c.marketplace)
    byPortfolio.set(c.portfolioId, e)
  }

  // The join field is externalPortfolioId — that is the Amazon-side id
  // Campaign.portfolioId holds. AmazonAdsPortfolio has no `portfolioId`.
  const named = await prisma.amazonAdsPortfolio.findMany({
    where: { externalPortfolioId: { in: [...byPortfolio.keys()] } },
    select: { externalPortfolioId: true, name: true },
  })
  const nameById = new Map(named.map((p) => [p.externalPortfolioId, p.name]))

  return [...byPortfolio.entries()]
    .map(([portfolioId, e]) => ({
      portfolioId,
      // An unnamed portfolio is shown by id rather than hidden — it is real
      // and assignable; only its label is missing.
      name: nameById.get(portfolioId) ?? `Portfolio ${portfolioId}`,
      campaignCount: e.count,
      marketplaces: [...e.markets].sort(),
    }))
    .sort((a, b) => b.campaignCount - a.campaignCount)
}

/**
 * NAF.SB.AS.6 — make many at once.
 *
 * ONE assignment per target, which is a different thing from one assignment
 * covering many targets — and the create drawer now asks which the operator
 * means rather than silently picking one. Both are legitimate: "look at these
 * three campaigns together" is one job; "look at each of these three" is three.
 *
 * Creating is NOT starting. Every row lands `not_started`, so a mis-fired bulk
 * costs nothing and is undone by deleting rows that have never run. There is
 * deliberately no bulk Start: bulk creation is reversible, bulk spending is
 * not, and spending on a fleet the operator switched off is the one thing this
 * page must never make easy.
 */
export const BULK_CAP = 25

export interface BulkTarget {
  id: string
  label?: string
}

export interface BulkResult {
  created: { id: string; target: string }[]
  refused: { target: string; reason: string }[]
}

export async function createAssignmentsBulk(input: {
  charterKey: string
  targetKind: TargetKind
  targets: BulkTarget[]
  wantBack?: string | null
  dueAt?: string | null
  createdBy?: string | null
}): Promise<{ ok: boolean; error?: string; result?: BulkResult }> {
  const targets = input.targets.filter((t) => t.id)
  if (targets.length === 0) return { ok: false, error: 'no targets given' }
  if (targets.length > BULK_CAP) {
    // Refused, never truncated: silently creating 25 of 40 is a wrong answer
    // that looks like a right one.
    return {
      ok: false,
      error: `${targets.length} is more than the ${BULK_CAP} this can make at once. Narrow the selection and repeat.`,
    }
  }

  const result: BulkResult = { created: [], refused: [] }
  for (const t of targets) {
    const label = t.label || t.id
    // Every row goes through the SAME create — and therefore the same
    // refusals — as a single assignment. A bulk path with its own validation
    // is a bulk path that eventually disagrees with the single one.
    const one = await createAssignment({
      charterKey: input.charterKey,
      targetKind: input.targetKind,
      targetIds: [t.id],
      targetLabels: [label],
      wantBack: input.wantBack ?? null,
      dueAt: input.dueAt ?? null,
      createdBy: input.createdBy ?? null,
    })
    if (one.ok && one.id) result.created.push({ id: one.id, target: label })
    else result.refused.push({ target: label, reason: one.error ?? 'refused' })
  }
  return { ok: true, result }
}

/**
 * Undo a bulk. Only rows that have never run can go — once a run exists the
 * runs are the record, and `deleteAssignment` refuses individually rather than
 * this making a blanket exception.
 */
export async function deleteAssignmentsBulk(
  ids: string[],
): Promise<{ deleted: number; kept: { id: string; reason: string }[] }> {
  const kept: { id: string; reason: string }[] = []
  let deleted = 0
  for (const id of ids.slice(0, BULK_CAP)) {
    const r = await deleteAssignment(id)
    if (r.ok) deleted++
    else kept.push({ id, reason: r.error ?? 'kept' })
  }
  return { deleted, kept }
}
