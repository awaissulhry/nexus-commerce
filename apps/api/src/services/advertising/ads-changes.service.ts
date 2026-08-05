/**
 * HX.4 — the unified change feed.
 *
 * Ten surfaces read five tables and each picks a different subset, so "what changed" has no single
 * answer today. This is that answer: one row shape over every recorded write, with the two facts
 * that matter kept apart — what we INTENDED (the field change) and whether Amazon TOOK it (delivery).
 *
 * WHAT IS AND ISN'T IN THE FEED
 *  · `CampaignBidHistory` is the SPINE. Every value change lands there: one row per field, with the
 *    actor and reason.
 *  · `AdvertisingActionLog` contributes only operations that produced NO field rows — creates,
 *    deletes, portfolio ops, operator annotations. The queued write path writes to BOTH tables (N
 *    field rows + 1 operation row), so emitting both unfiltered would double-count every bid change.
 *    Deduped by proximity rather than by a hand-maintained actionType allowlist — see dedupe().
 *  · `AdMutation` is joined for delivery state, never emitted as its own row.
 *  · `AutomationRuleExecution` is deliberately EXCLUDED. A rule firing is a different grain from a
 *    field change ("did the rule run and what did it match" vs "what value moved"), and mixing
 *    grains makes a feed you cannot read. Rule-caused changes still appear — carried by their actor,
 *    which resolves to origin.kind === 'rule'.
 */

import prisma from '../../db.js'
import { rollbackWindowMsFor, rollbackWindowLabel } from './rollback.service.js'

export type ChangeSource = 'automation' | 'operator' | 'system' | 'external'
export interface ChangeOrigin { kind: 'schedule' | 'plan' | 'rule' | 'job' | 'manual' | 'unknown'; id: string | null; name: string }

export interface ChangeRow {
  id: string
  at: Date
  actor: string | null
  source: ChangeSource
  origin: ChangeOrigin
  entity: { type: string; id: string; name: string | null }
  /** The campaign this change belongs to, when one is resolvable. A bid change is on an
   *  AD_TARGET, but an operator reads it as "which campaign moved". */
  campaign: { id: string; name: string | null } | null
  field: string
  oldValue: string | null
  newValue: string | null
  reason: string | null
  /**
   * ADX G6 — WHY the change happened, from AdvertisingActionLog.evidence (A2).
   *
   * `reason` is prose an engine wrote for a human; this is the numbers behind it —
   * metric, observed, threshold, windowDays, sampleSize, targetKey. The pair is what
   * makes "why did this bid move" answerable without reading code.
   *
   * null on every historical row and on any writer that has not been taught to emit
   * it yet, which is most of them. Absent evidence is normal, not an error.
   */
  evidence: Record<string, unknown> | null
  delivery: { state: string; attempts: number; lastError: string | null } | null
  undoable: boolean
  /**
   * ACR.4.3 — the AdvertisingActionLog id `POST /advertising/changes/:id/undo` needs.
   *
   * A CampaignBidHistory row has no such id of its own, so an undoable field row carries the id
   * of the operation row it was paired with. Null when there is nothing to undo — the UI must
   * key the button on this, not on `undoable` alone, or it has nowhere to send the request.
   */
  undoActionLogId: string | null
  /** Why this row cannot be undone, when it cannot. Absent on undoable rows. */
  undoBlockedReason?: string
}

/**
 * The actor string is the ONLY reliable signal for who caused a change, and reading it correctly is
 * the fix for a real defect: `ads-events.service.listEvents` derives source from which COLUMN is
 * populated (`executionId ? automation : userId ? operator : system`), but the mutation path stores
 * automation actors in `userId` — so every automated write was reported as an operator action.
 *
 * Pure, and unit-tested, because every row in the feed is classified by it.
 */
export function parseActor(actor: string | null | undefined): { source: ChangeSource; origin: ChangeOrigin } {
  if (!actor || actor === 'system') {
    return { source: 'system', origin: { kind: 'unknown', id: null, name: 'System' } }
  }
  if (actor.startsWith('external:')) {
    return { source: 'external', origin: { kind: 'unknown', id: null, name: actor.slice(9) || 'External' } }
  }
  if (!actor.startsWith('automation:')) {
    // Anything else is a human: 'user:<id>' from the console, or a bare id from older call sites.
    const id = actor.startsWith('user:') ? actor.slice(5) : actor
    return { source: 'operator', origin: { kind: 'manual', id, name: id } }
  }
  const rest = actor.slice('automation:'.length)
  // Ordered longest-prefix-first: 'rank-defend-' must be tested before any shorter 'rank-' prefix.
  const typed: Array<[string, ChangeOrigin['kind']]> = [
    ['rank-defend-', 'schedule'],
    ['rank-plan-', 'plan'],
    ['rule-', 'rule'],
  ]
  for (const [prefix, kind] of typed) {
    if (rest.startsWith(prefix)) {
      const id = rest.slice(prefix.length)
      // `name` is a placeholder until resolveOrigins() swaps in the real one; showing the id is
      // better than showing nothing if resolution fails.
      return { source: 'automation', origin: { kind, id: id || null, name: id || kind } }
    }
  }
  // Standing jobs with no per-instance id: autopilot, ads-write-reconcile, tos-optimizer.
  return { source: 'automation', origin: { kind: 'job', id: null, name: rest.replace(/-/g, ' ') } }
}

/**
 * Swap placeholder origin names for real ones: a schedule's name, a plan's marketplace, a rule's
 * name. This is what turns "automation:rank-defend-clx9f2..." into "IT AIREON" — the difference
 * between a log an operator can read and one they cannot.
 */
async function resolveOrigins(rows: ChangeRow[]): Promise<void> {
  const scheduleIds = new Set<string>(), planIds = new Set<string>(), ruleIds = new Set<string>()
  for (const r of rows) {
    if (!r.origin.id) continue
    if (r.origin.kind === 'schedule') scheduleIds.add(r.origin.id)
    else if (r.origin.kind === 'plan') planIds.add(r.origin.id)
    else if (r.origin.kind === 'rule') ruleIds.add(r.origin.id)
  }
  const [scheds, plans, rules] = await Promise.all([
    scheduleIds.size
      // The actor carries the AdSchedule id, but the operator thinks in named GROUPS — so resolve
      // through to the group's name and fall back to the per-campaign row's name if it has none.
      ? prisma.adSchedule.findMany({ where: { id: { in: [...scheduleIds] } }, select: { id: true, name: true, group: { select: { name: true } } } })
      : Promise.resolve([]),
    planIds.size ? prisma.productRankPlan.findMany({ where: { id: { in: [...planIds] } }, select: { id: true, parentAsin: true, marketplace: true } }) : Promise.resolve([]),
    ruleIds.size ? prisma.automationRule.findMany({ where: { id: { in: [...ruleIds] } }, select: { id: true, name: true } }) : Promise.resolve([]),
  ])
  const sName = new Map(scheds.map((s) => [s.id, s.group?.name ?? s.name]))
  const pName = new Map(plans.map((p) => [p.id, `${p.parentAsin ?? 'family'} · ${p.marketplace}`]))
  const rName = new Map(rules.map((r) => [r.id, r.name]))
  for (const r of rows) {
    if (!r.origin.id) continue
    const hit = r.origin.kind === 'schedule' ? sName.get(r.origin.id)
      : r.origin.kind === 'plan' ? pName.get(r.origin.id)
        : r.origin.kind === 'rule' ? rName.get(r.origin.id) : undefined
    // A deleted schedule leaves its history behind on purpose — say so rather than showing a cuid.
    r.origin.name = hit ?? `${r.origin.kind} (deleted)`
  }
}

/**
 * Drop the operation rows that merely summarise field rows we already have.
 *
 * Proximity-based, NOT an actionType allowlist: the queued path writes its operation row and its
 * field rows in the same call, so an operation row with any field row on the same entity within a
 * few seconds is that operation's header. A list of "action types that also write bid history"
 * would need updating every time a write path is added, and would silently double-count when
 * somebody forgot.
 */
const DEDUPE_WINDOW_MS = 10_000
function dedupe(operations: ChangeRow[], fields: ChangeRow[]): ChangeRow[] {
  if (!operations.length || !fields.length) return operations
  const byEntity = new Map<string, ChangeRow[]>()
  for (const f of fields) {
    const arr = byEntity.get(f.entity.id) ?? []
    arr.push(f)
    byEntity.set(f.entity.id, arr)
  }
  return operations.filter((op) => {
    const rows = byEntity.get(op.entity.id)
    if (!rows) return true
    const t = op.at.getTime()
    const covered = rows.filter((f) => Math.abs(f.at.getTime() - t) <= DEDUPE_WINDOW_MS)
    if (!covered.length) return true

    // The operation row is the ONLY carrier of evidence — CampaignBidHistory has no such
    // column, so its rows are built with evidence: null. Dropping the operation row therefore
    // discarded every why-chip on the feed: 722 rows carried evidence and the endpoint
    // returned it on 0 of 500. Hand it to the field rows that replace it before letting go.
    if (op.evidence) {
      for (const f of covered) if (!f.evidence) f.evidence = op.evidence
    }
    return false
  })
}

export interface ListChangesOpts {
  /** Scope to one rank-schedule group: resolved to its member schedules' actor strings. A group
   *  has N member AdSchedule rows and therefore N actors, which is why a single originId cannot
   *  express it. */
  groupId?: string
  from?: Date
  to?: Date
  source?: ChangeSource
  originKind?: ChangeOrigin['kind']
  originId?: string
  entityType?: string
  entityId?: string
  campaignId?: string
  field?: string
  deliveryState?: string
  limit?: number
}

const UNDO_WINDOW_MS = 24 * 3600 * 1000

/**
 * Action types `reverseOne` can genuinely put back. Anything absent renders as not-undoable
 * rather than as a button that fails — an undo that 409s is worse than no undo, because the
 * operator has already decided to trust it by the time they find out.
 */
const REVERSIBLE_ACTIONS = new Set([
  'update_placement_bidding',
  'AD_BUDGET_UPDATE',
  'adjust_ad_budget',
  'AD_BID_UPDATE',
])

/**
 * `payloadBefore` is NOT NULL in the schema, so "it exists" is not evidence of anything —
 * `reverseOne` restores FROM it, and `{}` produces an empty patch and a no-op undo. An object
 * with at least one key is the weakest honest test that there is a prior state to go back to.
 */
function hasRestorableBefore(before: unknown): boolean {
  return before != null && typeof before === 'object' && Object.keys(before as object).length > 0
}

/** Money and percentages, compared at the precision they are stored with. */
function sameNumber(a: unknown, b: string | null): boolean {
  if (b == null) return false
  const x = Number(a), y = Number(b)
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < 0.005
}

/**
 * Does this operation row describe the SAME change as this field row?
 *
 * Exact agreement on the before AND after value, not proximity. Both sides must match: an op
 * that happens to share a starting value with a neighbouring change is still the wrong row to
 * undo, and on this account the same campaign's budget is rewritten repeatedly within seconds.
 */
export function opMatchesField(
  op: { payloadBefore: unknown; payloadAfter: unknown },
  row: { field: string; oldValue: string | null; newValue: string | null },
  actionType: string,
): boolean {
  const before = op.payloadBefore as Record<string, unknown> | null
  const after = op.payloadAfter as Record<string, unknown> | null
  if (!before || !after) return false

  if (actionType === 'AD_BUDGET_UPDATE') {
    return sameNumber(before.dailyBudget, row.oldValue) && sameNumber(after.dailyBudget, row.newValue)
  }

  if (actionType === 'update_placement_bidding') {
    // The field name IS the placement key ('PLACEMENT_TOP'), and the payload carries an array of
    // adjustments. A placement ABSENT from the array means 0% — the rank engine writes a partial
    // list — so a missing entry must compare as zero rather than fail to match, or a genuine
    // 45% → 0% change would never find its own record.
    const pct = (adj: unknown): number => {
      const arr = Array.isArray(adj) ? adj as Array<{ placement?: string; percentage?: number }> : []
      const hit = arr.find((a) => a?.placement === row.field)
      return Number(hit?.percentage ?? 0)
    }
    /**
     * "Absent" means 0% on BOTH sides, and it has two spellings: a placement missing from the
     * payload's adjustment array, and a null oldValue on the history row. Mapping only the
     * payload side left 96 of 200 rows — every `null → 0` placement change, which is most of
     * them — unable to match a record that described them perfectly. Same one-concept-two-
     * spellings defect this programme keeps finding; here it was mine, and it made the safety
     * check refuse work it should have allowed.
     *
     * Budgets get NO such coercion: a null budget is unknown, and unknown is not zero.
     */
    const rowPct = (v: string | null): string => (v == null ? '0' : v)
    return sameNumber(pct(before.adjustments), rowPct(row.oldValue))
      && sameNumber(pct(after.adjustments), rowPct(row.newValue))
  }

  return false
}

export async function listChanges(opts: ListChangesOpts = {}): Promise<{ items: ChangeRow[]; count: number; from: Date; to: Date; members: Array<{ campaignId: string; name: string }> }> {
  // A group scope resolves to its members' actor strings up front, so the DB filters on
  // changedBy rather than post-filtering a wide read.
  let groupActors: string[] | null = null
  let groupMembers: Array<{ campaignId: string; name: string }> = []
  if (opts.groupId) {
    const members = await prisma.adSchedule.findMany({ where: { groupId: opts.groupId }, select: { id: true, campaignId: true } })
    groupActors = members.map((m) => `automation:rank-defend-${m.id}`)
    if (members.length) {
      const camps = await prisma.campaign.findMany({ where: { id: { in: members.map((m) => m.campaignId) } }, select: { id: true, name: true } })
      const nm = new Map(camps.map((c) => [c.id, c.name]))
      groupMembers = members.map((m) => ({ campaignId: m.campaignId, name: nm.get(m.campaignId) ?? m.campaignId }))
    }
  }

  const to = opts.to ?? new Date()
  const from = opts.from ?? new Date(to.getTime() - 30 * 24 * 3600 * 1000)
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100))
  // Over-fetch each source: dedupe and post-filtering both shrink the set, and a limit applied per
  // table would silently starve whichever one is busier.
  const fetchN = Math.min(1500, limit * 5)

  const [hist, ops] = await Promise.all([
    prisma.campaignBidHistory.findMany({
      where: {
        changedAt: { gte: from, lte: to },
        ...(opts.entityType ? { entityType: opts.entityType } : {}),
        ...(opts.entityId ? { entityId: opts.entityId } : {}),
        ...(opts.campaignId ? { campaignId: opts.campaignId } : {}),
        ...(opts.field ? { field: opts.field } : {}),
        ...(groupActors ? { changedBy: { in: groupActors } } : {}),
      },
      orderBy: { changedAt: 'desc' },
      take: fetchN,
      select: { id: true, entityType: true, entityId: true, campaignId: true, field: true, oldValue: true, newValue: true, changedAt: true, changedBy: true, reason: true },
    }),
    prisma.advertisingActionLog.findMany({
      where: {
        createdAt: { gte: from, lte: to },
        ...(opts.entityType ? { entityType: opts.entityType } : {}),
        ...(opts.entityId ? { entityId: opts.entityId } : {}),
        ...(groupActors ? { userId: { in: groupActors } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: fetchN,
      // payloadBefore is selected for the undo test only. The column is NOT NULL in the schema,
      // so its mere presence proves nothing — `reverseOne` restores FROM it, and an empty object
      // yields an empty patch. Cheap here because this query is bounded by `take`; the same
      // column over an unbounded week cost 1.9s in the weekly digest, which is why that one
      // reads it for a single action type instead.
      select: { id: true, createdAt: true, actionType: true, entityType: true, entityId: true, userId: true, amazonResponseStatus: true, rolledBackAt: true, payloadBefore: true, payloadAfter: true, evidence: true },
    }),
  ])

  const now = Date.now()
  const fieldRows: ChangeRow[] = hist.map((h) => {
    const { source, origin } = parseActor(h.changedBy)
    return {
      id: `h:${h.id}`, at: h.changedAt, actor: h.changedBy, source, origin,
      entity: { type: h.entityType, id: h.entityId, name: null },
      campaign: h.campaignId ? { id: h.campaignId, name: null } : null,
      field: h.field, oldValue: h.oldValue, newValue: h.newValue, reason: h.reason,
      // CampaignBidHistory has no evidence column — these rows carry the value change,
      // and the paired AdvertisingActionLog row carries the reasoning.
      evidence: null,
      delivery: null,
      // Mirrors the rule /campaigns/:id/history already applies: only a target bid, only while the
      // prior value is known and recent. HX.7 is what will make this actionable.
      // A bid. 24h on purpose — see rollbackWindowMsFor: the rank engine supersedes these hourly.
      undoable: h.entityType === 'AD_TARGET' && h.field === 'bid' && h.oldValue != null && now - h.changedAt.getTime() < UNDO_WINDOW_MS,
      // Filled by the pairing pass below for placement and budget rows. A bid row keeps null:
      // its undo runs through the per-campaign history path, not this action-log endpoint.
      undoActionLogId: null,
    }
  })

  const opRows: ChangeRow[] = ops.map((o) => {
    const { source, origin } = parseActor(o.userId)
    const after = (o.payloadAfter ?? {}) as { note?: string; error?: string }
    return {
      id: `a:${o.id}`, at: o.createdAt, actor: o.userId, source, origin,
      entity: { type: o.entityType, id: o.entityId, name: null },
      campaign: o.entityType === 'CAMPAIGN' ? { id: o.entityId, name: null } : null,
      field: o.actionType, oldValue: null, newValue: after.note ?? null,
      reason: after.error ?? (o.rolledBackAt ? 'rolled back' : null),
      // ADX G6 — the numbers behind the prose. Null on historical rows and on any
      // writer not yet emitting it, which is most of them; absent is normal.
      evidence: (o.evidence ?? null) as Record<string, unknown> | null,
      delivery: o.amazonResponseStatus
        ? { state: o.amazonResponseStatus === 'SUCCESS' ? 'APPLIED' : o.amazonResponseStatus, attempts: 1, lastError: after.error ?? null }
        : null,
      /**
       * ACR.4.3 — these were hard-coded `false` while a working undo endpoint sat behind them.
       * `POST /advertising/changes/:actionLogId/undo` reverses exactly these rows — placement
       * snapshots, campaign budget/status, and bulksheet creates — so the feed was hiding a
       * capability rather than lacking one.
       *
       * The conditions mirror what `reverseOne` will actually accept, so the affordance cannot
       * promise something the server then refuses: it must have reached Amazon, it must not be
       * already undone, it must carry a before-snapshot to restore, and it must be inside the
       * window for ITS kind of change. Same rule object as the rollback service — one rule, two
       * readers, which is the only way these two stay in agreement.
       */
      undoable:
        (o.amazonResponseStatus === 'SUCCESS' || o.amazonResponseStatus === 'PENDING')
        && o.rolledBackAt == null
        && hasRestorableBefore(o.payloadBefore)
        && REVERSIBLE_ACTIONS.has(o.actionType)
        && now - o.createdAt.getTime() < rollbackWindowMsFor(o.actionType),
      undoActionLogId: o.id,
    }
  })

  /**
   * HX.3, carried over — delivery for the INLINE path.
   *
   * Placement writes push to Amazon directly rather than through the queue, so they create no
   * AdMutation row and the join below finds nothing for them. Their outcome lives on the
   * AdvertisingActionLog row instead (truthful since HX.1). Indexed here BEFORE dedupe, because
   * dedupe is about to discard exactly those op rows as duplicates of the field rows.
   * Without this every placement change reads "no delivery record" — technically true, and
   * misleading, since we do know what happened.
   */
  const PLACEMENT_FIELDS = new Set(['PLACEMENT_TOP', 'PLACEMENT_REST_OF_SEARCH', 'PLACEMENT_PRODUCT_PAGE'])
  /**
   * ACR.4.3 — the same pairing now carries the UNDO HANDLE as well as delivery.
   *
   * A field row is the readable half of an event (before → after) and the operation row is the
   * reversible half (it owns the id `POST /changes/:id/undo` takes and the snapshot `reverseOne`
   * restores from). The feed shows the readable half and dedupe discards the other, so undo was
   * unreachable for exactly the two action types that are reversible for seven days — placement
   * and budget. Measured before this change: 200 automation rows, 0 undoable, of which 172 were
   * placements and 28 were budgets, every one of them backed by a reversible operation row.
   *
   * Budget field rows are paired the same way placement rows already were. Both match on entity
   * and then NEAREST IN TIME, because an entity can be written repeatedly within one feed window
   * and the newest operation row is not necessarily the one this field row describes.
   */
  const PAIRED: Array<{ fieldMatches: (f: string) => boolean; actionType: string }> = [
    { fieldMatches: (f) => PLACEMENT_FIELDS.has(f), actionType: 'update_placement_bidding' },
    { fieldMatches: (f) => f === 'dailyBudget', actionType: 'AD_BUDGET_UPDATE' },
  ]
  for (const pair of PAIRED) {
    const cand = ops.filter((o) => o.actionType === pair.actionType)
    if (!cand.length) continue
    const byEntity = new Map<string, typeof cand>()
    for (const o of cand) { const a = byEntity.get(o.entityId) ?? []; a.push(o); byEntity.set(o.entityId, a) }
    for (const r of fieldRows) {
      if (!pair.fieldMatches(r.field)) continue
      const cands = byEntity.get(r.entity.id)
      if (!cands?.length) continue
      let best = cands[0], gap = Math.abs(cands[0].createdAt.getTime() - r.at.getTime())
      for (const c of cands.slice(1)) { const g = Math.abs(c.createdAt.getTime() - r.at.getTime()); if (g < gap) { gap = g; best = c } }
      const err = (best.payloadAfter as { error?: string } | null)?.error ?? null
      // Delivery keeps the looser nearest-in-time match it has always had: mis-attributing a
      // delivery chip is cosmetic, and tightening it here would regress rows that resolve today.
      r.delivery = { state: best.amazonResponseStatus === 'FAILED' ? 'FAILED' : 'APPLIED', attempts: 1, lastError: err }

      /**
       * The UNDO handle is held to a much higher bar than the delivery chip, because the two
       * failure modes are not comparable: a wrong delivery chip misinforms, a wrong undo handle
       * WRITES THE WRONG VALUE TO AMAZON.
       *
       * Nearest-in-time alone is not safe enough for that. Measured on prod: every campaign with
       * budget activity has more than one budget op within six hours, the busiest has 36, and two
       * of them landed NINE SECONDS apart carrying different values (4.14 → 6.46, then
       * 6.46 → 5.17). Pairing by proximity could hand undo the wrong snapshot and restore 4.14
       * where 6.46 belonged.
       *
       * So the undo handle requires the operation row's own before/after to MATCH the field row's
       * — an exact agreement about which change this is, not an estimate. No match, no handle:
       * the row simply says it cannot be undone rather than offering a button aimed at its
       * neighbour.
       */
      const exact = cands.filter((c) => opMatchesField(c, r, pair.actionType))
      if (exact.length === 0) {
        r.undoBlockedReason = 'This change could not be matched to a reversible record with certainty, so undo is not offered.'
        continue
      }
      let chosen = exact[0], eGap = Math.abs(exact[0].createdAt.getTime() - r.at.getTime())
      for (const c of exact.slice(1)) { const g = Math.abs(c.createdAt.getTime() - r.at.getTime()); if (g < eGap) { eGap = g; chosen = c } }

      // The undo verdict is the operation row's, not the field row's — it is the thing that
      // would actually be reversed. Same predicate the op rows use, so a paired row and a bare
      // op row can never disagree about the same event.
      const landed = chosen.amazonResponseStatus === 'SUCCESS' || chosen.amazonResponseStatus === 'PENDING'
      const inWindow = now - chosen.createdAt.getTime() < rollbackWindowMsFor(chosen.actionType)
      if (chosen.rolledBackAt != null) r.undoBlockedReason = 'Already undone.'
      else if (!landed) r.undoBlockedReason = 'This change never reached Amazon, so there is nothing to reverse.'
      else if (!inWindow) r.undoBlockedReason = `Older than the ${rollbackWindowLabel(chosen.actionType)} undo window for this kind of change.`
      else if (!hasRestorableBefore(chosen.payloadBefore)) r.undoBlockedReason = 'No prior value was recorded, so there is nothing to restore.'

      if (landed && chosen.rolledBackAt == null && inWindow && hasRestorableBefore(chosen.payloadBefore)) {
        r.undoable = true
        r.undoActionLogId = chosen.id
      }
    }
  }

  let items = [...fieldRows, ...dedupe(opRows, fieldRows)].sort((a, b) => b.at.getTime() - a.at.getTime())

  // Delivery for the queued path. Matched on (entityId, field, previousValue, intendedValue) and
  // then NEAREST IN TIME — taking the newest instead would stamp last night's failure onto this
  // morning's successful write of the same value.
  const fieldEntityIds = [...new Set(fieldRows.map((r) => r.entity.id))]
  if (fieldEntityIds.length) {
    try {
      const muts = await prisma.adMutation.findMany({
        where: { entityId: { in: fieldEntityIds }, createdAt: { gte: new Date(from.getTime() - 60_000) } },
        select: { entityId: true, field: true, previousValue: true, intendedValue: true, state: true, attempts: true, lastError: true, createdAt: true },
      })
      const key = (e: string, f: string, p: string | null, n: string | null) => `${e}|${f}|${p ?? ''}|${n ?? ''}`
      const byKey = new Map<string, typeof muts>()
      for (const m of muts) { const k = key(m.entityId, m.field, m.previousValue, m.intendedValue); const a = byKey.get(k) ?? []; a.push(m); byKey.set(k, a) }
      for (const r of items) {
        if (r.delivery || !r.id.startsWith('h:')) continue // inline delivery already resolved above
        const cands = byKey.get(key(r.entity.id, r.field, r.oldValue, r.newValue))
        if (!cands?.length) continue
        let best = cands[0], gap = Math.abs(cands[0].createdAt.getTime() - r.at.getTime())
        for (const c of cands.slice(1)) { const g = Math.abs(c.createdAt.getTime() - r.at.getTime()); if (g < gap) { gap = g; best = c } }
        r.delivery = { state: best.state, attempts: best.attempts, lastError: best.lastError }
      }
    } catch { /* best-effort — delivery enrichment must never blank the feed */ }
  }

  // Post-filters: these read derived fields (source/origin/delivery), so they cannot be pushed
  // into the queries above.
  if (opts.source) items = items.filter((r) => r.source === opts.source)
  if (opts.originKind) items = items.filter((r) => r.origin.kind === opts.originKind)
  if (opts.originId) items = items.filter((r) => r.origin.id === opts.originId)
  if (opts.deliveryState) items = items.filter((r) => r.delivery?.state === opts.deliveryState)

  await resolveOrigins(items.slice(0, limit))
  items = items.slice(0, limit)

  // Campaign names, so a row reads as a campaign rather than a cuid — for the entity itself and
  // for the campaign a target-level change belongs to.
  const campIds = [...new Set([
    ...items.filter((r) => r.entity.type === 'CAMPAIGN').map((r) => r.entity.id),
    ...items.map((r) => r.campaign?.id).filter(Boolean) as string[],
  ])]
  if (campIds.length) {
    try {
      const camps = await prisma.campaign.findMany({ where: { id: { in: campIds } }, select: { id: true, name: true } })
      const byId = new Map(camps.map((c) => [c.id, c.name]))
      for (const r of items) {
        if (r.entity.type === 'CAMPAIGN') r.entity.name = byId.get(r.entity.id) ?? null
        if (r.campaign) r.campaign.name = byId.get(r.campaign.id) ?? null
      }
    } catch { /* best-effort */ }
  }

  // `members` rides along only on a group scope. A client offering a per-campaign filter needs the
  // group's FULL membership, not just the campaigns that happen to appear in this page of rows —
  // otherwise narrowing to one campaign empties the picker you would need to widen it again.
  return { items, count: items.length, from, to, members: groupMembers }
}
