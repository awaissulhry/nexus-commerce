/**
 * NAF.AP.1–AP.3 — the approval inbox.
 *
 * AP.1 (attribution): a decision names the person who took it. The route
 * used to pass the literal string `'operator'` for every decision while the
 * signed-in user sat on the request, so `decidedBy` was null-or-meaningless
 * on all 18 approvals in the database. Every decision now also writes to
 * `AgentControlAudit` (AC.7's table) — the EU AI Act posture the spec
 * commits to is only real if that record exists.
 *
 * AP.2 (memory): the inbox used to query `status='pending'` and nothing
 * else, so eighteen decisions with fifteen written reasons were invisible.
 * It now serves three views — waiting, decided, expired — with counts.
 *
 * Waiting stays fleet-tools-only, exactly as before: a pre-fleet approval is
 * not something this page can act on. Decided and expired include the
 * pre-fleet history, flagged, because the decision timeline already shows it
 * and two panels must not disagree about the same past (operator call
 * 2026-08-07).
 *
 * AP.4 (the brake): approving parks the action for a 20-second undo window
 * instead of firing it. The decision is durable at once; only the execution
 * waits. Bulk decisions state their blast radius before they run.
 *
 * AP.5 (one clock): `expiresAt` is now the expiry, swept on its own schedule
 * for every tool — see `runApprovalMaintenance`.
 */
import prisma from '../../db.js'
import { decideApproval } from '../agents/approval-gate.service.js'
import { getTool } from '../agents/tool-registry.js'
import { recordControlChange } from './control-audit.service.js'
import { mintExemplarFromDecision } from './exemplar.service.js'
import { logger } from '../../utils/logger.js'

/** The tools the fleet's own workers may propose. */
export const FLEET_TOOLS = ['create-negative-keyword', 'graduate-keyword', 'set-target-bid']

export type InboxView = 'waiting' | 'decided' | 'expired'

/**
 * `executing` is a transient claim inside approve; it belongs with decided.
 *
 * NAF.AQ.8 adds `superseded` — a proposal the operator EDITED rather than
 * answered. It belongs in the record for the reason ServiceNow keeps its "No
 * Longer Required" state: without somewhere to put an overtaken request, it
 * either rots in the queue or is deleted, and you lose the ability to tell
 * whether the fleet was wrong or merely corrected. It is not `rejected` —
 * the operator did not say no, they said "not that number".
 */
export const DECIDED_STATUSES = ['approved', 'executed', 'rejected', 'executing', 'superseded']

export interface InboxActor {
  /** What gets stored and shown. A name if we have one, never a bare id. */
  label: string
  userId: string | null
}

/**
 * Who is taking this decision. `req.authUser` is populated by the RBAC hook
 * from the session; the previous code ignored it entirely.
 */
export function resolveActor(authUser?: {
  id?: string
  email?: string
  displayName?: string
}): InboxActor {
  if (!authUser?.id) {
    // Honest fallback. Never claim a person took a decision we cannot
    // attribute — "operator" written unconditionally is what produced 18
    // unattributable rows.
    return { label: 'unattributed', userId: null }
  }
  return {
    label: authUser.displayName?.trim() || authUser.email || authUser.id,
    userId: authUser.id,
  }
}

/* ── reading ───────────────────────────────────────────────────────────── */

function whereFor(view: InboxView, now: Date = new Date()) {
  // `scheduled` belongs with waiting, not decided: the action has not run and
  // the operator can still take it back, so it must stay where they are
  // looking even after a reload.
  //
  // NAF.AQ — a snoozed request is hidden until it is due. The COUNTS use this
  // same clause, deliberately: if the badge counted what the queue hides, the
  // first thing the operator would learn is that the badge lies. Snoozing is
  // the counter to clearing a queue by approving it, and it only works if the
  // number moves too.
  if (view === 'waiting')
    return {
      status: { in: ['pending', 'scheduled'] },
      toolName: { in: FLEET_TOOLS },
      OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
    }
  if (view === 'expired') return { status: 'expired' }
  return { status: { in: DECIDED_STATUSES } }
}

export interface InboxCounts {
  waiting: number
  decided: number
  expired: number
}

export async function inboxCounts(): Promise<InboxCounts> {
  const [waiting, decided, expired] = await Promise.all([
    prisma.agentApproval.count({ where: whereFor('waiting') }),
    prisma.agentApproval.count({ where: whereFor('decided') }),
    prisma.agentApproval.count({ where: whereFor('expired') }),
  ])
  return { waiting, decided, expired }
}

export async function listInbox(view: InboxView, limit = 100) {
  const records = view === 'waiting' ? await trackRecords() : {}
  const approvals = await prisma.agentApproval.findMany({
    where: whereFor(view),
    orderBy: view === 'waiting' ? { requestedAt: 'asc' } : { decidedAt: 'desc' },
    take: Math.min(limit, 200),
  })
  const runs = await prisma.agentRun.findMany({
    where: { id: { in: approvals.map((a) => a.agentRunId) } },
    select: { id: true, agentKey: true, orchestrationId: true },
  })
  const runById = new Map(runs.map((r) => [r.id, r]))

  return approvals.map((a) => ({
    ...a,
    charterKey: runById.get(a.agentRunId)?.agentKey ?? null,
    orchestrationId: runById.get(a.agentRunId)?.orchestrationId ?? null,
    /**
     * False for the pre-fleet ACP approvals. The UI labels those rather than
     * hiding them — see the header note.
     */
    isFleet: FLEET_TOOLS.includes(a.toolName),
    /**
     * AP.8 — how this worker's proposals of this kind have fared with you
     * before. Null when there is no history, which is itself worth saying.
     */
    trackRecord:
      records[`${runById.get(a.agentRunId)?.agentKey ?? 'unknown'}::${a.toolName}`] ?? null,
  }))
}

/* ── deciding ──────────────────────────────────────────────────────────── */

/** The charter an approval belongs to, for the audit row. */
async function charterKeyOf(approvalId: string): Promise<string> {
  const ap = await prisma.agentApproval.findUnique({
    where: { id: approvalId },
    select: { agentRun: { select: { agentKey: true } } },
  })
  return ap?.agentRun?.agentKey ?? 'unknown'
}

/**
 * One decision, attributed and audited. Exemplar minting and the audit write
 * are both best-effort: the decision has already committed, and failing it
 * after the fact would be worse than a missing side record.
 */
export async function decideFleetApproval(input: {
  id: string
  decision: 'approve' | 'reject'
  reason?: string
  actor: InboxActor
}): Promise<{
  ok: boolean
  status?: string
  result?: unknown
  error?: string
  executeAfter?: string
}> {
  // AP.4 — an approve parks for the undo window instead of firing. The
  // decision is recorded immediately (attributable, durable); only the
  // execution waits.
  if (input.decision === 'approve') {
    const parked = await scheduleApproval({ id: input.id, actor: input.actor })
    if (!parked.ok) return parked
    await recordControlChange({
      charterKey: await charterKeyOf(input.id),
      action: 'approve_action',
      to: { approvalId: input.id, status: 'scheduled', executeAfter: parked.executeAfter },
      note: input.reason ?? null,
      actor: input.actor.label,
    }).catch((err) =>
      logger.error('[naf-ap] control audit failed', { id: input.id, error: String(err) }),
    )
    return parked
  }

  const charterKey = await charterKeyOf(input.id)

  const out = await decideApproval(
    input.id,
    input.decision,
    input.actor.label,
    input.reason || undefined,
  )
  if (!out.ok) return out

  await mintExemplarFromDecision(input.id, input.decision, input.reason || undefined).catch(
    (err) => logger.error('[naf-ap] exemplar minting failed', { id: input.id, error: String(err) }),
  )

  // `recordControlChange` swallows its own errors by contract — but the
  // decision has already committed, so this call must not be able to fail it
  // even if that contract changes underneath us.
  await recordControlChange({
    charterKey,
    action: 'reject_action', // approve returned early, above
    to: { approvalId: input.id, status: out.status ?? null },
    note: input.reason ?? null,
    actor: input.actor.label,
  }).catch((err) =>
    logger.error('[naf-ap] control audit failed', { id: input.id, error: String(err) }),
  )

  return out
}

/* ── AP.4: the undo window ─────────────────────────────────────────────── */

/**
 * How long an approved action waits before it runs. Long enough to catch a
 * misclick, short enough that nobody plans around it.
 */
export const UNDO_WINDOW_MS = 20_000

/**
 * Approving no longer executes on the spot. It records the decision — who,
 * when, why — and parks the action for {@link UNDO_WINDOW_MS}. Nothing
 * reaches Amazon inside the window. Either the operator's browser commits it
 * when the window closes, or the maintenance sweep does; the decision is
 * durable the moment it is taken, so closing the tab cannot lose it.
 */
export async function scheduleApproval(input: {
  id: string
  actor: InboxActor
}): Promise<{ ok: boolean; status?: string; executeAfter?: string; error?: string }> {
  const executeAfter = new Date(Date.now() + UNDO_WINDOW_MS)
  // Atomic pending→scheduled claim: two tabs cannot both schedule the same row.
  const claim = await prisma.agentApproval.updateMany({
    where: { id: input.id, status: 'pending' },
    data: {
      status: 'scheduled',
      decidedBy: input.actor.label,
      decidedAt: new Date(),
      executeAfter,
    },
  })
  if (claim.count === 0) {
    const cur = await prisma.agentApproval.findUnique({
      where: { id: input.id },
      select: { status: true },
    })
    return { ok: false, error: cur ? `already ${cur.status}` : 'approval not found' }
  }
  return { ok: true, status: 'scheduled', executeAfter: executeAfter.toISOString() }
}

/**
 * Take it back. Only possible while the action is still parked — once it has
 * run, it has run, and saying otherwise would be the dishonest kind of undo.
 */
export async function undoScheduledApproval(input: {
  id: string
  actor: InboxActor
}): Promise<{ ok: boolean; error?: string }> {
  const undone = await prisma.agentApproval.updateMany({
    where: { id: input.id, status: 'scheduled' },
    data: { status: 'pending', decidedBy: null, decidedAt: null, executeAfter: null },
  })
  if (undone.count === 0) {
    const cur = await prisma.agentApproval.findUnique({
      where: { id: input.id },
      select: { status: true },
    })
    return {
      ok: false,
      error:
        cur?.status && cur.status !== 'pending'
          ? `too late — this action is already ${cur.status}`
          : 'nothing to undo',
    }
  }
  await recordControlChange({
    charterKey: await charterKeyOf(input.id),
    action: 'undo_approval',
    to: { approvalId: input.id },
    note: 'taken back inside the undo window',
    actor: input.actor.label,
  }).catch((err) => logger.error('[naf-ap] audit failed', { error: String(err) }))
  return { ok: true }
}

/**
 * Run a parked action whose window has closed. The `executeAfter` guard is
 * enforced HERE, so a client that calls early is refused rather than trusted.
 */
export async function commitScheduledApproval(
  id: string,
): Promise<{ ok: boolean; status?: string; error?: string }> {
  const ap = await prisma.agentApproval.findUnique({
    where: { id },
    select: { status: true, executeAfter: true, decidedBy: true },
  })
  if (!ap) return { ok: false, error: 'approval not found' }
  if (ap.status !== 'scheduled') return { ok: false, error: `not scheduled (${ap.status})` }
  if (ap.executeAfter && ap.executeAfter > new Date()) {
    return { ok: false, error: 'still inside the undo window' }
  }

  // AP.6 — the world may have moved while this sat parked. Re-validate
  // BEFORE releasing it: an approval describes a state of the world, and if
  // that state changed the approval no longer describes anything real.
  const staleness = await checkStaleness(id)
  if (staleness.stale) {
    // Back to pending, with the reason on the row. Expiring it would throw
    // the operator's decision away; this hands it back with fresh facts.
    await prisma.agentApproval.updateMany({
      where: { id, status: 'scheduled' },
      data: {
        status: 'pending',
        decidedBy: null,
        decidedAt: null,
        executeAfter: null,
        reason: `not run — ${staleness.why}`,
      },
    })
    await recordControlChange({
      charterKey: await charterKeyOf(id),
      action: 'stale_refused',
      to: { approvalId: id },
      note: staleness.why,
      actor: ap.decidedBy ?? 'unattributed',
    }).catch(() => undefined)
    return { ok: false, error: `not run — ${staleness.why}` }
  }

  // Hand back to the gate, which owns execution. It expects `pending`, so
  // release the park atomically — if that loses a race, someone else has it.
  const release = await prisma.agentApproval.updateMany({
    where: { id, status: 'scheduled' },
    data: { status: 'pending', executeAfter: null },
  })
  if (release.count === 0) return { ok: false, error: 'already taken' }

  const actorLabel = ap.decidedBy ?? 'unattributed'
  const out = await decideApproval(id, 'approve', actorLabel)
  if (!out.ok) return out

  await mintExemplarFromDecision(id, 'approve').catch((err) =>
    logger.error('[naf-ap] exemplar minting failed', { id, error: String(err) }),
  )
  await recordControlChange({
    charterKey: await charterKeyOf(id),
    action: 'approve_action',
    to: { approvalId: id, status: out.status ?? null },
    actor: actorLabel,
  }).catch((err) => logger.error('[naf-ap] control audit failed', { id, error: String(err) }))

  return out
}

/* ── AP.6: an approval that no longer applies must not run ─────────────── */

/**
 * The fields whose change invalidates an approval. Not every difference
 * matters — a metrics window ticking over is noise — but the value the
 * operator was shown as the STARTING point does: "move this bid from €0.42
 * to €0.25" is a different decision if the bid is €0.60 by the time it runs.
 */
export const MATERIAL_PREVIEW_FIELDS: Record<string, string[]> = {
  /* The fleet's three propose-tools. All preview-only: they cannot execute,
     so a stale one costs nothing. */
  'set-target-bid': ['currentBidCents'],
  'create-negative-keyword': ['matchType', 'scope', 'alreadyNegated'],
  'graduate-keyword': ['suggestedBidCents'],

  /* NAF.AQ.2 — the four tools that CAN execute, and which had no material
     fields at all. The protection was inverted exactly as `TOOL_CARDS` was
     before AP.3: the three tools that can never reach Amazon were guarded,
     and the four that can were not. An empty list means the only staleness
     signal is the handler refusing outright, so field-level drift — the very
     thing this check exists for — went unnoticed on the rows with real
     consequences.

     Each handler is read-only (verified in mutate.tools.ts), so re-running it
     is safe; what follows is what it is worth comparing. */

  // `changes['base price'].from` is the LIVE price read at preview time.
  // "Move this from €49 to €39" is a different decision at €35.
  'set-price': ['changes'],

  // Same shape: `changes.{title,bulletPoints,description}.from` is the live
  // content. If someone edited the listing in between, the diff the operator
  // approved describes content that no longer exists.
  'apply-content': ['changes'],

  // `currentlyPublished` — publishing something already published is a
  // different act. `publishMode` is the important one: if the channel flipped
  // to live between the approval and the run, the operator approved a gated
  // queue-up and would get a real publish.
  'publish-listing': ['currentlyPublished', 'publishMode'],

  // `suppressed` is the one that matters most anywhere in this map: if the
  // customer opted out after the operator said yes, the message must not go.
  // `note` is prose, and included deliberately — it is the field that encodes
  // whether outbound email is live or dry-run, and that flip turns a recorded
  // no-op into an irreversible real send.
  'send-customer-message': ['suppressed', 'emailOnFile', 'note'],
}

export interface StalenessVerdict {
  stale: boolean
  /** Plain sentence naming what moved. Null when nothing did. */
  why: string | null
}

const money = (c: unknown) => (typeof c === 'number' ? `€${(c / 100).toFixed(2)}` : String(c))

/**
 * Re-validate an approval against the world as it is NOW.
 *
 * It re-runs the tool's OWN dry-run handler — the same code that produced
 * the preview the operator read — so this check can never drift from what
 * they were shown. If the handler now refuses (the term is already negated,
 * a pin was added, the target vanished), that refusal is the answer.
 */
export async function checkStaleness(approvalId: string): Promise<StalenessVerdict> {
  const ap = await prisma.agentApproval.findUnique({
    where: { id: approvalId },
    select: { toolName: true, args: true, preview: true },
  })
  if (!ap) return { stale: true, why: 'the request no longer exists' }

  const tool = getTool(ap.toolName)
  const canExecute = typeof tool?.execute === 'function'

  /**
   * NAF.AQ.2 — fail CLOSED for anything that can reach the outside world.
   *
   * The map above previously defaulted to SILENCE: a tool with no entry got
   * `?? []`, compared nothing, and passed without complaint. That is how the
   * four executable tools went unguarded for months — not because anyone
   * decided they were safe, but because nobody noticed they were missing.
   * A guard whose omission is invisible is not a guard.
   *
   * So: an action that can execute and has no declared material fields is
   * treated as stale. The cost of being wrong in this direction is a refusal
   * the operator can read and someone can fix; the cost in the other
   * direction is an unguarded write.
   */
  if (canExecute && !MATERIAL_PREVIEW_FIELDS[ap.toolName]) {
    return {
      stale: true,
      why: `it could not be re-checked — nobody has declared which facts matter for "${ap.toolName.replace(/-/g, ' ')}", and an action that can change something is never run unchecked`,
    }
  }

  if (!tool?.handler) {
    // No dry-run to compare against. Harmless for a preview-only tool;
    // disqualifying for one that can act.
    return canExecute
      ? { stale: true, why: 'it could not be re-checked — this action has no dry-run to compare against' }
      : { stale: false, why: null }
  }

  let fresh: Awaited<ReturnType<NonNullable<typeof tool.handler>>>
  try {
    fresh = await tool.handler((ap.args ?? {}) as Record<string, unknown>, { userId: null })
  } catch (err) {
    // A re-check that cannot run is not permission to proceed.
    return { stale: true, why: `it could not be re-checked: ${String(err)}` }
  }
  if (!fresh.ok) {
    return { stale: true, why: fresh.error ?? 'it is no longer a valid action' }
  }

  const before = (ap.preview ?? {}) as Record<string, unknown>
  const after = (fresh.preview ?? {}) as Record<string, unknown>
  const moved: string[] = []
  for (const key of MATERIAL_PREVIEW_FIELDS[ap.toolName] ?? []) {
    if (!(key in before)) continue
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      moved.push(
        key.toLowerCase().includes('cents')
          ? `${key} changed from ${money(before[key])} to ${money(after[key])}`
          : `${key} changed from ${JSON.stringify(before[key])} to ${JSON.stringify(after[key])}`,
      )
    }
  }
  if (moved.length > 0) {
    return {
      stale: true,
      why: `the facts moved since you approved it — ${moved.join('; ')}`,
    }
  }
  return { stale: false, why: null }
}

/* ── AP.7: the precedent a decision actually created ───────────────────── */

export interface PrecedentRow {
  charterKey: string
  label: string
  note: string | null
  toolName: string | null
  createdAt: string
}

/**
 * The card promises that a decision "becomes precedent the workers read on
 * their next run". That promise was unverifiable — this makes it visible.
 * Recency-first, matching how the charter prompt actually retrieves them.
 */
export async function recentPrecedents(limit = 20): Promise<PrecedentRow[]> {
  const rows = await prisma.agentExemplar.findMany({
    where: { active: true },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 100),
    select: {
      charterKey: true,
      label: true,
      operatorNote: true,
      situation: true,
      createdAt: true,
    },
  })
  return rows.map((r) => ({
    charterKey: r.charterKey,
    label: r.label,
    note: r.operatorNote,
    toolName: (r.situation as { toolName?: string } | null)?.toolName ?? null,
    createdAt: r.createdAt.toISOString(),
  }))
}

/* ── AP.8: the track record, against automation bias ───────────────────── */

export interface TrackRecord {
  approved: number
  rejected: number
  total: number
}

/**
 * How this worker's proposals of this kind have fared with you before.
 * Article 14 names automation bias — over-relying on the machine's output —
 * as the thing an oversight interface must counter. A worker whose last six
 * suggestions of this exact kind you rejected deserves a slower read.
 */
export async function trackRecords(): Promise<Record<string, TrackRecord>> {
  const rows = await prisma.agentApproval.findMany({
    where: { status: { in: ['approved', 'executed', 'rejected'] } },
    select: { toolName: true, status: true, agentRunId: true },
  })
  const runs = await prisma.agentRun.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.agentRunId))] } },
    select: { id: true, agentKey: true },
  })
  const keyOf = new Map(runs.map((r) => [r.id, r.agentKey]))
  const out: Record<string, TrackRecord> = {}
  for (const r of rows) {
    const k = `${keyOf.get(r.agentRunId) ?? 'unknown'}::${r.toolName}`
    const rec = (out[k] ??= { approved: 0, rejected: 0, total: 0 })
    if (r.status === 'rejected') rec.rejected++
    else rec.approved++
    rec.total++
  }
  return out
}

/* ── AP.5: one expiry clock ────────────────────────────────────────────── */

/**
 * The single maintenance pass over the approval queue.
 *
 * Before this, `expiresAt` was written on every approval at creation and read
 * by NOTHING; the only expiry lived inside the weekly council, keyed on a
 * different column against a different constant, restricted to fleet tools —
 * and the council has run twice in its life. So a non-fleet approval never
 * expired and a fleet one expired by weekly accident.
 *
 * Now: `expiresAt` is the clock, every tool is covered, and this runs on its
 * own schedule instead of riding an agent job.
 */
export async function runApprovalMaintenance(): Promise<{
  expired: number
  committed: number
  failed: number
}> {
  const now = new Date()

  const expired = await prisma.agentApproval.updateMany({
    where: { status: 'pending', expiresAt: { not: null, lt: now } },
    data: { status: 'expired' },
  })

  const due = await prisma.agentApproval.findMany({
    where: { status: 'scheduled', executeAfter: { not: null, lte: now } },
    select: { id: true },
    take: 100,
  })
  let committed = 0
  let failed = 0
  for (const d of due) {
    const out = await commitScheduledApproval(d.id).catch((err) => {
      logger.error('[naf-ap] commit threw', { id: d.id, error: String(err) })
      return { ok: false as const }
    })
    if (out.ok) committed++
    else failed++
  }

  if (expired.count || committed || failed) {
    logger.info('[naf-ap] approval maintenance', {
      expired: expired.count,
      committed,
      failed,
    })
  }
  return { expired: expired.count, committed, failed }
}

/* ── AP.4: bulk, with the blast radius stated ──────────────────────────── */

export interface BulkPreview {
  count: number
  /** One sentence naming what this will do, before it does it. */
  sentence: string
  byTool: Record<string, number>
  highRisk: number
  irreversible: number
  /**
   * NAF.AQ.6 — the money, where it can be computed HONESTLY. Null when it
   * cannot: a fabricated euro figure on a confirmation is worse than none,
   * because it is the number the operator will remember.
   */
  euro: { amount: number; label: string } | null
  /**
   * UiPath's rule, and the single most transferable safety constraint found in
   * the research: bulk is permitted only across structurally identical items —
   * same worker, same action. It is what stops "approve all" spanning a €0.02
   * bid nudge and a customer email.
   */
  homogeneous: boolean
  /** Set when a bulk APPROVE is refused. Rejecting a mixed set stays fine. */
  blockedReason: string | null
}

const IRREVERSIBLE_TOOLS = ['send-customer-message']

/**
 * What a bulk decision is about to do, in a sentence. Built server-side from
 * the rows themselves, so the confirmation cannot drift from the action.
 */
/**
 * The euro exposure of a set of proposals, computed per tool from the preview
 * the operator was shown — never estimated, never modelled.
 *
 * Only bid changes and price changes yield an honest figure today. A negative
 * keyword saves money in a way nobody can put a number on before the fact, and
 * saying "€0.00" about it would be a lie of precision.
 */
function euroExposure(
  rows: Array<{ toolName: string; preview: unknown }>,
): { amount: number; label: string } | null {
  let bidDeltaCents = 0
  let bidCount = 0
  let priceDeltaCents = 0
  let priceCount = 0

  for (const r of rows) {
    const p = (r.preview ?? {}) as Record<string, any>
    if (r.toolName === 'set-target-bid') {
      const from = typeof p.currentBidCents === 'number' ? p.currentBidCents : null
      const to = typeof p.proposedBidCents === 'number' ? p.proposedBidCents : null
      if (from != null && to != null) {
        bidDeltaCents += to - from
        bidCount++
      }
    }
    if (r.toolName === 'set-price') {
      const ch = p.changes?.['base price']
      if (ch && typeof ch.from === 'number' && typeof ch.to === 'number') {
        priceDeltaCents += Math.round((ch.to - ch.from) * 100)
        priceCount++
      }
    }
  }

  if (bidCount > 0 && priceCount === 0) {
    const dir = bidDeltaCents >= 0 ? 'raises' : 'lowers'
    return {
      amount: bidDeltaCents,
      // Deliberately "per click", not "per day": a bid is a ceiling on one
      // click, and calling it daily spend would invent a volume nobody knows.
      label: `${dir} what you pay per click by €${Math.abs(bidDeltaCents / 100).toFixed(2)} in total across ${bidCount} keyword${bidCount === 1 ? '' : 's'}`,
    }
  }
  if (priceCount > 0 && bidCount === 0) {
    const dir = priceDeltaCents >= 0 ? 'raises' : 'lowers'
    return {
      amount: priceDeltaCents,
      label: `${dir} your prices by €${Math.abs(priceDeltaCents / 100).toFixed(2)} in total across ${priceCount} product${priceCount === 1 ? '' : 's'}`,
    }
  }
  return null
}

export async function previewBulk(
  ids: string[],
  decision: 'approve' | 'reject',
): Promise<BulkPreview> {
  /*
   * AQ.6, after a test caught me getting this wrong.
   *
   * The study claimed a selection containing a PARKED row "under-reports its
   * blast radius", and the first version of this widened the query to include
   * `scheduled`. That is wrong: a parked row is already approved and counting
   * down. It is not part of THIS decision, and counting it would over-report
   * just as badly as omitting it under-reported.
   *
   * The honest answer is neither. Count what this decision will actually do —
   * the pending rows — and if the selection contains anything else, SAY so,
   * rather than silently dropping it and leaving the operator to wonder why
   * three selected became two.
   */
  const all = await prisma.agentApproval.findMany({
    where: { id: { in: ids } },
    select: { toolName: true, riskTier: true, preview: true, status: true },
  })
  const rows = all.filter((r) => r.status === 'pending')
  const notActionable = all.length - rows.length
  const byTool: Record<string, number> = {}
  for (const r of rows) byTool[r.toolName] = (byTool[r.toolName] ?? 0) + 1
  const highRisk = rows.filter((r) => r.riskTier === 'high').length
  const irreversible = rows.filter((r) => IRREVERSIBLE_TOOLS.includes(r.toolName)).length
  const euro = euroExposure(rows)

  // Homogeneity: one action kind. Same-worker is enforced by the caller's
  // grouping today; the action kind is what actually differs in consequence.
  const homogeneous = Object.keys(byTool).length <= 1
  const blockedReason =
    decision === 'approve' && !homogeneous
      ? `These are ${Object.keys(byTool).length} different kinds of action (${Object.keys(byTool)
          .map((t) => t.replace(/-/g, ' '))
          .join(', ')}). Approve one kind at a time — a single yes should never span two different consequences.`
      : null

  const kinds = Object.entries(byTool)
    .map(([tool, n]) => `${n} × ${tool.replace(/-/g, ' ')}`)
    .join(', ')
  const verb = decision === 'approve' ? 'approves' : 'rejects'
  const money = euro ? ` It ${euro.label}.` : ''
  // Never silently drop a selected row.
  const skipped =
    notActionable > 0
      ? ` ${notActionable} other${notActionable === 1 ? '' : 's'} you selected ${notActionable === 1 ? 'is' : 'are'} already decided or counting down, and ${notActionable === 1 ? 'is' : 'are'} not affected.`
      : ''
  const tail =
    decision === 'approve'
      ? highRisk > 0
        ? ` — ${highRisk} of them high risk.${money} You have 20 seconds to take it back.`
        : `.${money} You have 20 seconds to take it back.`
      : ''

  return {
    count: rows.length,
    sentence:
      all.length === 0
        ? 'Nothing is selected.'
        : rows.length === 0
          ? `Nothing here can be decided — ${all.length === 1 ? 'the one you selected has' : `all ${all.length} you selected have`} already been decided or ${all.length === 1 ? 'is' : 'are'} counting down.`
        : blockedReason
          ? blockedReason
          : // The kinds clause takes its own full stop only when nothing
            // follows it. The shipped version always added one and then began
            // the tail with an em-dash, producing "…set target bid. — 2 of
            // them high risk." — a period followed by a dash, which reads as a
            // typo on the one sentence that has to be trusted.
            `This ${verb} ${rows.length} action${rows.length === 1 ? '' : 's'}: ${kinds}${tail ? '' : '.'}${tail}${skipped}`,
    byTool,
    highRisk,
    irreversible,
    euro,
    homogeneous,
    blockedReason,
  }
}

export async function bulkDecide(input: {
  ids: string[]
  decision: 'approve' | 'reject'
  reason?: string
  actor: InboxActor
}): Promise<{ ok: boolean; done: number; of: number; failed: string[]; error?: string }> {
  // NAF.AQ.6 — the homogeneity rule is enforced HERE, not only in the
  // confirmation. A preview a client can choose not to read is a suggestion;
  // the rule has to hold for anything that calls this, including the next
  // caller nobody has written yet.
  //
  // Approve only. Rejecting a mixed set is safe — saying no to forty different
  // things at once cannot hurt anyone — and blocking it would be friction on
  // the safe path, which is the asymmetry AQ.4 exists to remove.
  if (input.decision === 'approve') {
    const check = await previewBulk(input.ids, 'approve')
    if (check.blockedReason) {
      return { ok: false, done: 0, of: input.ids.length, failed: [], error: check.blockedReason }
    }
  }

  const failed: string[] = []
  let done = 0
  for (const id of input.ids) {
    const out = await decideFleetApproval({
      id,
      decision: input.decision,
      reason: input.reason,
      actor: input.actor,
    })
    if (out.ok) done++
    else failed.push(out.error ?? id)
  }
  return { ok: true, done, of: input.ids.length, failed }
}

export async function rejectAllForCharter(input: {
  charterKey: string
  reason: string
  actor: InboxActor
}): Promise<{ ok: true; rejected: number; of: number }> {
  const runs = await prisma.agentRun.findMany({
    where: { agentKey: input.charterKey },
    select: { id: true },
  })
  const pending = await prisma.agentApproval.findMany({
    where: {
      status: 'pending',
      toolName: { in: FLEET_TOOLS },
      agentRunId: { in: runs.map((r) => r.id) },
    },
    select: { id: true },
  })
  let rejected = 0
  for (const p of pending) {
    const out = await decideFleetApproval({
      id: p.id,
      decision: 'reject',
      reason: input.reason,
      actor: input.actor,
    })
    if (out.ok) rejected++
  }
  return { ok: true, rejected, of: pending.length }
}
