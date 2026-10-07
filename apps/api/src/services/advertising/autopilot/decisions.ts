import { workspaceKey } from '@nexus/database/workspace-context'
/**
 * SG.8 — operator verbs for the A.I. Bids tab: approve / dismiss / restore one
 * AutopilotDecision, plus the status-aware list the tab reads.
 *
 * The ONE-ENGINE rule: approve executes through `applyPlanActions` — the exact path an AUTO
 * plan takes (write-gated, audited, sandbox-safe) — never a parallel write implementation.
 * Consequences the UI must tell truthfully:
 *   · a BID decision stores no target id; the plan's apply path re-runs the per-target bid
 *     optimizer at apply time, so the applied bids are computed FRESH and can differ from the
 *     proposed € figure if data moved since the tick that proposed it.
 *   · only bid | budget | placement have a live apply path today (apply.ts); other modules
 *     refuse honestly instead of pretending.
 *
 * Lifecycle truths this file leans on (ad-autopilot.job.ts):
 *   · every conductor tick DELETES a plan's PROPOSED autopilot rows and re-proposes — the
 *     queue is a rolling snapshot. A dismissal therefore only sticks because the conductor's
 *     SUGGEST branch suppresses re-proposals matching a DISMISSED row's fingerprint
 *     (module|campaignId|action — the family tabs' proposedKey semantics: the VALUE may
 *     wobble tick to tick; the decision identity is what the operator dismissed).
 *   · DISMISSED rows older than 7 days are pruned by the tick, which is what lets the
 *     proposal return — the same window the AdsRuleSuggestion re-propose sweep uses.
 *   · `at` is rewritten to the decision time on dismiss/restore: it is the suppression
 *     clock. The original propose time is given up on those rows (they left the queue).
 *   · a disabled plan is skipped by the conductor, so its PROPOSED rows are STALE by
 *     definition — approve refuses them (this also structurally protects seeded preview
 *     rows, which ride an enabled:false plan).
 */
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { applyPlanActions } from './apply.js'
import { DEFAULT_GUARDRAILS, type Goal, type Guardrails } from './presets.js'
import type { ProposedAction } from './modules.js'

export interface DecideResult {
  ok: boolean
  refused?: boolean
  /** approve only: 'applied' | 'skipped' — what actually happened, in the executor's words */
  outcome?: 'applied' | 'skipped'
  error?: string
  note?: string
}

/** The modules `applyPlanActions` can execute today. Everything else must refuse, not pretend. */
export const APPLYABLE_MODULES = new Set(['bid', 'budget', 'placement'])

type DecisionRow = {
  id: string; module: string; campaignId: string | null; action: string
  before: unknown; after: unknown; reason: string
}

const centsOf = (v: unknown): number | undefined => {
  const c = (v as { cents?: unknown } | null)?.cents
  return typeof c === 'number' && Number.isFinite(c) ? c : undefined
}

/** Reconstruct the conductor action a stored decision row froze — or say why it cannot run. */
export function actionFromDecision(row: DecisionRow): ProposedAction | { error: string } {
  if (!row.campaignId) return { error: 'This decision names no campaign to act on' }
  if (!APPLYABLE_MODULES.has(row.module)) {
    return { error: `The ${row.module} module has no live apply path yet — this row can only be dismissed` }
  }
  return {
    module: row.module as ProposedAction['module'],
    campaignId: row.campaignId,
    action: row.action as ProposedAction['action'],
    beforeCents: centsOf(row.before),
    afterCents: centsOf(row.after),
    before: row.before ?? undefined,
    after: row.after ?? undefined,
    reason: row.reason,
    priority: 50,
  }
}

/** The dismissal identity — module|campaign|action, NOT the value (family proposedKey semantics). */
export const decisionFingerprint = (d: { module: string; campaignId: string | null; action: string }): string =>
  `${d.module}|${d.campaignId ?? ''}|${d.action}`

/** Conductor-side: drop freshly-proposed actions the operator dismissed inside the window. */
export function suppressDismissed<T extends { module: string; campaignId: string; action: string }>(
  actions: T[],
  dismissed: Array<{ module: string; campaignId: string | null; action: string }>,
): T[] {
  if (!dismissed.length) return actions
  const fps = new Set(dismissed.map(decisionFingerprint))
  return actions.filter((a) => !fps.has(decisionFingerprint(a)))
}

/** How long a dismissal suppresses re-proposals (mirrors the suggestions re-propose sweep). */
export const DISMISS_SUPPRESSION_MS = 7 * 24 * 60 * 60 * 1000

// ── the list the tab reads ──────────────────────────────────────────────────
// Ported from GET /advertising/suggestions/ai-bids (SG.4) + a status axis. `applied` is the
// decided history: APPLIED plus the executor's own DENIED/SKIPPED rows (AUTO writes those
// too), each row carrying its status so the chip column can tell the truth per row.
const STATUS_SETS: Record<string, string[]> = {
  proposed: ['PROPOSED'],
  applied: ['APPLIED', 'SKIPPED', 'DENIED'],
  dismissed: ['DISMISSED'],
  muted: [], // not a row status — the muted view lists MUTES, see listAiMutes
}

/**
 * SG.9 — delivery truth for a decided row, the same join `attachDeliveryData` does for
 * suggestions (SG.3). An APPLIED decision was recorded at ENQUEUE; only the queue row says
 * whether Amazon took it. A row with no queue handle is `unknown` — never a confident
 * "delivered", because most of these predate the handle existing.
 */
type Delivery = { state: 'delivered' | 'pending' | 'refused' | 'failed' | 'unknown'; detail: string | null }
async function deliveryByQueueId(ids: string[]): Promise<Map<string, Delivery>> {
  const out = new Map<string, Delivery>()
  if (!ids.length) return out
  const rows = await prisma.outboundSyncQueue.findMany({
    where: { id: { in: ids } },
    select: { id: true, syncStatus: true, errorCode: true, errorMessage: true, isDead: true },
  })
  for (const q of rows) {
    const s = String(q.syncStatus)
    const state: Delivery['state'] =
      s === 'SUCCESS' ? 'delivered'
      : s === 'SKIPPED' ? 'refused'
      : q.isDead || s === 'FAILED' ? 'failed'
      : 'pending'
    out.set(q.id, {
      state,
      detail: state === 'refused'
        ? (q.errorMessage ?? (q.errorCode === 'WRITE_GATE_DENIED' ? 'The write gate declined this write' : q.errorCode ?? 'refused before it reached Amazon'))
        : state === 'failed' ? (q.errorMessage ?? q.errorCode ?? 'the write failed')
        : state === 'pending' ? 'Queued — the drain worker has not settled this write yet.'
        : 'The change reached Amazon.',
    })
  }
  return out
}

export async function listAiDecisions(statusKey: string): Promise<{ items: unknown[]; total: number }> {
  const statuses = STATUS_SETS[statusKey] ?? STATUS_SETS.proposed
  const rows = await prisma.autopilotDecision.findMany({
    where: { status: { in: statuses }, source: { not: 'rule-setting' } },
    orderBy: { at: 'desc' },
    take: 500,
    include: { plan: { select: { id: true, name: true, enabled: true } } },
  })
  const campIds = [...new Set(rows.map((r) => r.campaignId).filter((x): x is string => !!x))]
  const camps = campIds.length
    ? await prisma.campaign.findMany({ where: { id: { in: campIds } }, select: { id: true, name: true } })
    : []
  const nameById = new Map(camps.map((c) => [c.id, c.name]))
  const delivery = await deliveryByQueueId(rows.map((r) => r.outboundQueueId).filter((x): x is string => !!x))
  /**
   * SG.10 — the undo handle, and whether it has already been used. `executionId` on a decided
   * row is an AdvertisingActionLog id (budget: its own write; bid: any log from the batch's
   * change set — rollback follows the set, so one handle reverses them all). Read
   * `rolledBackAt` so a reload cannot re-offer an undo that already happened; a handle whose
   * log has vanished offers nothing rather than a doomed request.
   */
  const logIds = rows.map((r) => r.executionId).filter((x): x is string => !!x)
  const logs = logIds.length
    ? await prisma.advertisingActionLog.findMany({ where: { id: { in: logIds } }, select: { id: true, rolledBackAt: true } })
    : []
  const logById = new Map(logs.map((l) => [l.id, l]))
  return {
    items: rows.map((r) => ({
      id: r.id, at: r.at, module: r.module, cycle: r.cycle, action: r.action,
      campaignId: r.campaignId,
      campaignName: r.campaignId ? nameById.get(r.campaignId) ?? null : null,
      before: r.before, after: r.after, reason: r.reason,
      planId: r.planId, planName: r.plan?.name ?? null,
      status: r.status,
      planEnabled: r.plan?.enabled ?? false,
      // null on PROPOSED rows (nothing written yet) and on pre-SG.9 history.
      delivery: r.outboundQueueId ? delivery.get(r.outboundQueueId) ?? null : null,
      // null ⇒ "no undo is offered from here", never "cannot be undone" (the change may still
      // be reversible from the Change Log — this queue just holds no handle to it).
      undo: r.executionId && logById.has(r.executionId)
        ? { actionLogId: r.executionId, rolledBack: !!logById.get(r.executionId)!.rolledBackAt }
        : null,
    })),
    total: rows.length,
  }
}

/** The A.I. Muted view: campaigns the operator told the plans to stop proposing for. */
export async function listAiMutes(): Promise<{ items: unknown[]; total: number }> {
  const rows = await prisma.adsSuggestionMute.findMany({ where: { scope: 'ai' }, orderBy: { createdAt: 'desc' }, take: 500 })
  const ids = rows.map((r) => r.entityId)
  const camps = ids.length ? await prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []
  const nameById = new Map(camps.map((c) => [c.id, c.name]))
  return {
    items: rows.map((r) => ({
      id: r.id, at: r.createdAt, campaignId: r.entityId,
      // the denormalised label survives a deleted campaign; the live name wins while it exists
      campaignName: nameById.get(r.entityId) ?? r.entityName ?? null,
      reason: r.reason, createdBy: r.createdBy,
    })),
    total: rows.length,
  }
}

/**
 * SG.9 — "stop suggesting changes for this campaign" (H10's third verb, `scope:'ai'`). The
 * campaign keeps running and its budget/bids are untouched; the conductor simply stops
 * proposing for it, and its currently-proposed rows leave the queue.
 */
export async function muteAiDecision(id: string): Promise<DecideResult> {
  const row = await prisma.autopilotDecision.findUnique({ where: { id }, include: { plan: { select: { marketplace: true } } } })
  if (!row) return { ok: false, error: 'This proposal no longer exists — the plan re-evaluated and superseded it' }
  if (!row.campaignId) return { ok: false, refused: true, error: 'This decision names no campaign to mute' }
  const camp = await prisma.campaign.findUnique({ where: { id: row.campaignId }, select: { name: true } })
  await prisma.adsSuggestionMute.upsert({
    where: { scope_entityType_entityId: workspaceKey({ scope: 'ai', entityType: 'CAMPAIGN', entityId: row.campaignId }) },
    create: {
      scope: 'ai', entityType: 'CAMPAIGN', entityId: row.campaignId, entityName: camp?.name ?? null,
      marketplace: row.plan?.marketplace ?? null, reason: 'muted from the A.I. Bids tab', createdBy: 'operator',
    },
    update: {},
  })
  const { count } = await prisma.autopilotDecision.updateMany({
    where: { campaignId: row.campaignId, status: 'PROPOSED', source: { not: 'rule-setting' } },
    data: { status: 'DISMISSED', at: new Date() },
  })
  return { ok: true, note: `Muted — ${count} proposal${count === 1 ? '' : 's'} left the queue` }
}

/** Un-mute a campaign: the plans may propose for it again on their next tick. */
export async function unmuteAiCampaign(campaignId: string): Promise<DecideResult> {
  const { count } = await prisma.adsSuggestionMute.deleteMany({ where: { scope: 'ai', entityType: 'CAMPAIGN', entityId: campaignId } })
  if (!count) return { ok: false, error: 'That campaign is not muted' }
  return { ok: true }
}

// ── the verbs ───────────────────────────────────────────────────────────────

export async function approveDecision(id: string): Promise<DecideResult> {
  const row = await prisma.autopilotDecision.findUnique({ where: { id }, include: { plan: true } })
  if (!row) return { ok: false, error: 'This proposal no longer exists — the plan re-evaluated and superseded it' }
  if (row.status !== 'PROPOSED') return { ok: false, error: `Already ${row.status.toLowerCase().replace('_', ' ')}` }
  if (row.source === 'rule-setting') {
    return { ok: false, refused: true, error: 'This is a mirrored rule suggestion — decide it on its own family tab' }
  }
  const plan = row.plan
  if (!plan.enabled || plan.autonomy === 'OFF') {
    return { ok: false, refused: true, error: 'This plan is disabled — its proposals are stale. Enable it in AI Advertising first.' }
  }
  const act = actionFromDecision(row)
  if ('error' in act) return { ok: false, refused: true, error: act.error }

  // Signals feed the bid path's margin-aware target ACoS — gathered fresh, the AUTO way.
  // Lazy import: the job module statically imports this file for the suppression helper.
  const { gatherSignals } = await import('../../../jobs/ad-autopilot.job.js')
  const signals = await gatherSignals([act.campaignId])
  const guardrails: Guardrails = { ...DEFAULT_GUARDRAILS, ...((plan.guardrails ?? {}) as Partial<Guardrails>) }

  let res: Awaited<ReturnType<typeof applyPlanActions>>
  try {
    res = await applyPlanActions({
      planId: plan.id, goal: plan.goal as Goal, marketplace: plan.marketplace,
      guardrails, actions: [act], signals,
      // W0 — a target the plan stores itself is explicit (wins over the campaign's); the merged default is not.
      planSetsTargetAcos: typeof ((plan.guardrails ?? {}) as Partial<Guardrails>).targetAcosPct === 'number',
    })
  } catch (e) {
    logger.warn('[ai-decisions] approve failed', { id, error: (e as Error).message })
    return { ok: false, error: `The apply failed: ${(e as Error).message}` }
  }

  const entry = res.decisions[0]
  if (!entry) {
    if (row.module === 'bid') {
      // The bid path pushes NO entry when the optimizer finds no bids worth moving RIGHT NOW —
      // the proposal is moot: settle the row instead of leaving a verb that will never act.
      const note = 'The optimizer found nothing to change at apply time — the proposal is settled with no write'
      await prisma.autopilotDecision.updateMany({ where: { id, status: 'PROPOSED' }, data: { status: 'SKIPPED', reason: `${row.reason} — ${note}`, at: new Date() } })
      return { ok: true, outcome: 'skipped', note }
    }
    // budget/placement push an entry on every path EXCEPT an exception (caught + logged in
    // apply.ts) — an empty result there means the write did NOT happen. Never settle that.
    return { ok: false, error: 'The apply did not complete — nothing was written; the row stays proposed' }
  }
  if (entry.status === 'DENIED') {
    // A governed stop, in the gate's words. The row STAYS proposed (family semantics).
    return { ok: false, refused: true, error: entry.reason }
  }
  // APPLIED or SKIPPED: record what ACTUALLY happened (the executor's before/after/reason) so
  // the decided view describes the real event, not the stale proposal. If the 15-min tick
  // deleted the row mid-apply, the write still landed — recreate the row so the audit holds.
  const data = {
    status: entry.status,
    before: (entry.before ?? row.before ?? undefined) as object | undefined,
    after: (entry.after ?? row.after ?? undefined) as object | undefined,
    reason: entry.reason,
    executionId: entry.executionId ?? null,
    // SG.9 — the delivery handle. APPLIED here means ENQUEUED; the tab reads the queue row.
    outboundQueueId: entry.outboundQueueId ?? null,
    at: new Date(),
  }
  const updated = await prisma.autopilotDecision.updateMany({ where: { id, status: 'PROPOSED' }, data })
  if (updated.count === 0) {
    await prisma.autopilotDecision.create({
      data: {
        planId: plan.id, cycle: row.cycle, module: row.module, campaignId: row.campaignId,
        action: row.action, source: 'autopilot', ...data,
      },
    })
  }
  return entry.status === 'APPLIED'
    ? { ok: true, outcome: 'applied', note: entry.reason }
    : { ok: true, outcome: 'skipped', note: entry.reason }
}

export async function dismissDecision(id: string): Promise<DecideResult> {
  // `at` becomes the dismissal time — the 7-day suppression clock the conductor reads.
  const r = await prisma.autopilotDecision.updateMany({
    where: { id, status: 'PROPOSED' },
    data: { status: 'DISMISSED', at: new Date() },
  })
  if (r.count === 0) return { ok: false, error: 'No longer pending — the plan re-evaluated and superseded it' }
  return { ok: true }
}

export async function restoreDecision(id: string): Promise<DecideResult> {
  const r = await prisma.autopilotDecision.updateMany({
    where: { id, status: 'DISMISSED' },
    data: { status: 'PROPOSED', at: new Date() },
  })
  if (r.count === 0) return { ok: false, error: 'Only a dismissed decision can be restored' }
  return { ok: true }
}

// ── the staging bar's one round trip ────────────────────────────────────────
export interface DecisionOp { id: string; kind: 'approve' | 'dismiss' | 'restore' | 'mute' }
export interface DecisionOpResult extends DecideResult { id: string; kind: DecisionOp['kind'] }

export async function bulkDecide(ops: DecisionOp[]): Promise<{ okCount: number; results: DecisionOpResult[] }> {
  const results: DecisionOpResult[] = []
  // Sequential on purpose — clean audit ordering, and the bid path can do real work per row.
  for (const op of ops) {
    const fn = op.kind === 'approve' ? approveDecision
      : op.kind === 'dismiss' ? dismissDecision
      : op.kind === 'mute' ? muteAiDecision
      : restoreDecision
    try {
      results.push({ id: op.id, kind: op.kind, ...(await fn(op.id)) })
    } catch (e) {
      results.push({ id: op.id, kind: op.kind, ok: false, error: (e as Error).message })
    }
  }
  return { okCount: results.filter((r) => r.ok).length, results }
}

// ── W4-9 — Claude: a decision read, carried out by an approved request, or dismissed by its identity ──────────
//
// Claude never approves a decision here (approveDecision writes as the plan and re-runs the optimizer when it is
// applied, so the value that lands is not the value a person or the limits judged). Instead apply-ad-recommendations
// freezes the decision's values into a change request of the existing change tools, and when that request runs, its
// source settles the row (settleDecisionsCarried). The conductor's 15-minute tick replaces a plan's PROPOSED rows, so
// a row may be gone by the time a person approves: its IDENTITY (the plan + module|campaign|action, the dismissal
// fingerprint) is what a request keeps, with the facts frozen when it was asked.

/** A decision as Claude's tools read and freeze it: the row, its plan, and whether the plan still runs. */
export interface DecisionFacts {
  id: string
  planId: string
  planName: string | null
  /** The plan is enabled and not OFF: its proposals are current (a disabled plan's are stale, as approve says). */
  planOn: boolean
  cycle: string
  module: string
  campaignId: string | null
  action: string
  before: unknown
  after: unknown
  reason: string
  status: string
  source: string
  at: string
}

/** These decisions as Claude reads them, by id (a row this business does not have is absent). Read only. */
export async function decisionFacts(ids: string[]): Promise<Map<string, DecisionFacts>> {
  const unique = [...new Set(ids.filter(Boolean))]
  const rows = unique.length
    ? await prisma.autopilotDecision.findMany({ where: { id: { in: unique } }, include: { plan: { select: { name: true, enabled: true, autonomy: true } } } })
    : []
  return new Map(rows.map((r) => [r.id, {
    id: r.id, planId: r.planId, planName: r.plan?.name ?? null, planOn: !!r.plan?.enabled && r.plan?.autonomy !== 'OFF',
    cycle: r.cycle, module: r.module, campaignId: r.campaignId, action: r.action, before: r.before ?? null, after: r.after ?? null,
    reason: r.reason, status: r.status, source: r.source, at: r.at.toISOString(),
  }]))
}

/** Where a decision's identity stands now: waiting, dismissed, decided (applied, skipped, denied) or gone. */
export type DecisionState = 'proposed' | 'dismissed' | 'decided' | 'gone'
const stateOfStatus = (status: string): DecisionState => (status === 'PROPOSED' ? 'proposed' : status === 'DISMISSED' ? 'dismissed' : 'decided')

/**
 * A decision's identity now: its row by id; when the tick replaced it, the plan's current row of the same decision
 * (module|campaign|action, waiting or dismissed) — `rowId` is the row a dismissal or a settle then acts on. Read only.
 */
export async function decisionStateNow(frozen: Pick<DecisionFacts, 'id' | 'planId' | 'module' | 'campaignId' | 'action'>): Promise<{ state: DecisionState; rowId: string | null; status: string | null }> {
  const row = await prisma.autopilotDecision.findUnique({ where: { id: frozen.id }, select: { id: true, status: true } })
  if (row) return { state: stateOfStatus(row.status), rowId: row.id, status: row.status }
  const same = await prisma.autopilotDecision.findFirst({
    where: { planId: frozen.planId, module: frozen.module, campaignId: frozen.campaignId, action: frozen.action, source: 'autopilot', status: { in: ['PROPOSED', 'DISMISSED'] } },
    orderBy: { at: 'desc' },
    select: { id: true, status: true },
  })
  return same ? { state: stateOfStatus(same.status), rowId: same.id, status: same.status } : { state: 'gone', rowId: null, status: null }
}

/** Dismiss the decision's identity now (its row, or the tick's re-proposal of it): the conductor stops proposing it for 7 days. */
export async function dismissDecisionIdentity(frozen: Pick<DecisionFacts, 'id' | 'planId' | 'module' | 'campaignId' | 'action'>): Promise<DecideResult & { rowId?: string }> {
  const now = await decisionStateNow(frozen)
  if (now.state !== 'proposed' || !now.rowId) return { ok: false, error: 'No longer waiting — the plan re-evaluated it, or it was decided' }
  const out = await dismissDecision(now.rowId)
  return out.ok ? { ...out, rowId: now.rowId } : out
}

/**
 * An approved request carried these decisions out (its change steps wrote the values frozen when it was asked): each
 * row is settled APPLIED as approve settles one, its reason naming the request, `executionId` the request's change set
 * (its writes carry it; undo-change of the request puts them back). A bid decision records how many bids it wrote.
 * When the 15-minute tick replaced the row meanwhile, a decided row is created from the frozen facts under the same id
 * (as approve recreates a row the tick deletes mid-apply), so the A.I. Bids tab's history holds and the id Claude and
 * the person saw still names it. A row decided meanwhile is left as it is. Returns how many were settled.
 */
export async function settleDecisionsCarried(carried: Array<{ facts: DecisionFacts; targets?: number }>, approvalId: string): Promise<number> {
  let settled = 0
  for (const { facts, targets } of carried) {
    const data = {
      status: 'APPLIED',
      reason: `${facts.reason} — carried out by request ${approvalId}`,
      executionId: approvalId,
      at: new Date(),
      ...(facts.module === 'bid' && targets != null ? { after: { targets } } : {}),
    }
    const updated = await prisma.autopilotDecision.updateMany({ where: { id: facts.id, status: 'PROPOSED' }, data })
    if (updated.count) { settled++; continue }
    if (await prisma.autopilotDecision.findUnique({ where: { id: facts.id }, select: { id: true } })) continue
    await prisma.autopilotDecision.create({
      data: {
        id: facts.id, planId: facts.planId, cycle: facts.cycle, module: facts.module, campaignId: facts.campaignId, action: facts.action, source: 'autopilot',
        before: (facts.before ?? undefined) as object | undefined, after: (facts.after ?? undefined) as object | undefined, ...data,
      },
    })
    settled++
  }
  return settled
}

/** The request that carried these decisions out was put back: their history says so (the change ran, then was undone). */
export async function noteDecisionsUndone(ids: string[], approvalId: string): Promise<number> {
  const rows = ids.length ? await prisma.autopilotDecision.findMany({ where: { id: { in: [...new Set(ids)] }, executionId: approvalId, status: 'APPLIED' }, select: { id: true, reason: true } }) : []
  for (const r of rows) {
    if (r.reason.endsWith(' — put back by an undo')) continue
    await prisma.autopilotDecision.update({ where: { id: r.id }, data: { reason: `${r.reason} — put back by an undo` } })
  }
  return rows.length
}

/**
 * W4-9 — the bids a BID decision moves now, as its plan's own apply computes them: planBidChanges at the plan's effective
 * target (the campaign's signals, the plan's guardrails). Read only; null when its plan or campaign is not found.
 */
export async function decisionBidChanges(facts: Pick<DecisionFacts, 'planId' | 'campaignId'>): Promise<Awaited<ReturnType<typeof import('./apply.js').planBidChanges>> | null> {
  const plan = await prisma.autopilotPlan.findUnique({ where: { id: facts.planId }, select: { goal: true, guardrails: true } })
  if (!plan || !facts.campaignId) return null
  // Lazy imports: the job module imports this file (the dismissal fingerprint).
  const [{ planBidChanges }, { gatherSignals }] = await Promise.all([import('./apply.js'), import('../../../jobs/ad-autopilot.job.js')])
  const own = (plan.guardrails ?? {}) as Partial<Guardrails>
  const [signal] = await gatherSignals([facts.campaignId])
  return planBidChanges({
    campaignId: facts.campaignId, goal: plan.goal as Goal, guardrails: { ...DEFAULT_GUARDRAILS, ...own },
    marginPct: signal?.marginPct ?? null,
    // W0 — a target the plan stores itself is explicit (wins over the campaign's); the merged default is not.
    planSetsTargetAcos: typeof own.targetAcosPct === 'number',
  })
}
