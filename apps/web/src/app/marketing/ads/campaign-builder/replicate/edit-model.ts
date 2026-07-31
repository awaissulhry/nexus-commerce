/**
 * AX3.7 — the edit model: one place that knows how to change a plan, how to put
 * a change back, and how to say what a change was.
 *
 * The review step used to spread edit-set surgery across the tree component —
 * every control hand-rolling its own `[...list.filter(x => x.id !== id), next]`.
 * That is why there was no undo for a single change and no way to list what you
 * had done: the knowledge of what an edit MEANS only existed at the call site.
 *
 * Everything here is pure. The plan still belongs to the server; this only ever
 * produces the edit set the server replays and re-gates.
 */
import type {
  PlanEdits, Plan, PlanCampaign, PlanAdGroup, PlanTarget, PlacementBid, PlanConflict,
} from './replicate-types'

// ── generic edit-set surgery ──────────────────────────────────────────────

/** The PlanEdits keys that are `[{ id, ...}]` lists addressed by plan id. */
type KeyedListKey = 'renamedCampaigns' | 'renamedAdGroups' | 'campaignBudgets'
  | 'adGroupBids' | 'targetBids' | 'targetExpressions' | 'targetMatchTypes'
  | 'campaignPlacements' | 'campaignBidding' | 'adGroupAsins'
/** The PlanEdits keys that are plain id lists. */
type IdListKey = 'removedCampaigns' | 'removedAdGroups' | 'removedTargets'

/** Upsert one keyed entry, dropping any earlier entry for the same id. */
export function setKeyed<K extends KeyedListKey>(
  edits: PlanEdits, key: K, entry: NonNullable<PlanEdits[K]>[number],
): PlanEdits {
  const list = ((edits[key] ?? []) as Array<{ id: string }>).filter((e) => e.id !== entry.id)
  return { ...edits, [key]: [...list, entry] as PlanEdits[K] }
}

/** Remove any entry for `id` — the per-change undo. */
export function clearKeyed(edits: PlanEdits, key: KeyedListKey, id: string): PlanEdits {
  const list = ((edits[key] ?? []) as Array<{ id: string }>).filter((e) => e.id !== id)
  const next = { ...edits, [key]: list as PlanEdits[typeof key] }
  if (!list.length) delete next[key]
  return next
}

/** Add or remove an id from one of the removal lists. */
export function toggleId(edits: PlanEdits, key: IdListKey, id: string): PlanEdits {
  const cur = new Set(edits[key] ?? [])
  if (cur.has(id)) cur.delete(id); else cur.add(id)
  const next = { ...edits, [key]: [...cur] }
  if (!cur.size) delete next[key]
  return next
}

/** Force a set of ids into (or out of) a removal list — the bulk actions. */
export function setIds(edits: PlanEdits, key: IdListKey, ids: string[], removed: boolean): PlanEdits {
  const cur = new Set(edits[key] ?? [])
  for (const id of ids) { if (removed) cur.add(id); else cur.delete(id) }
  const next = { ...edits, [key]: [...cur] }
  if (!cur.size) delete next[key]
  return next
}

/** How many individual changes the operator has made. */
export function countEdits(e: PlanEdits): number {
  return (e.removedCampaigns?.length ?? 0) + (e.removedAdGroups?.length ?? 0) + (e.removedTargets?.length ?? 0)
    + (e.renamedCampaigns?.length ?? 0) + (e.renamedAdGroups?.length ?? 0) + (e.campaignBudgets?.length ?? 0)
    + (e.adGroupBids?.length ?? 0) + (e.targetBids?.length ?? 0) + (e.addedTargets?.length ?? 0)
    + (e.targetExpressions?.length ?? 0) + (e.targetMatchTypes?.length ?? 0)
    + (e.campaignPlacements?.length ?? 0) + (e.campaignBidding?.length ?? 0) + (e.adGroupAsins?.length ?? 0)
}

// ── the effective plan: what the operator is actually looking at ──────────

export interface TargetView {
  /** Plan id, or `add:<adGroupId>:<n>` for one the operator typed. */
  id: string
  source: PlanTarget | null
  campaignId: string
  campaignName: string
  adGroupId: string
  adGroupName: string
  expression: string
  matchType: string
  kind: string
  isNegative: boolean
  bidCents: number | null
  /** Inherited from the ad group when the target carries no bid of its own. */
  effectiveBidCents: number | null
  autoClause: string | null
  removed: boolean
  /** The operator changed something about this row. */
  touched: boolean
  added: boolean
  conflict: Array<{ campaignName: string; campaignId: string }> | null
  decision: 'skip' | 'accept' | undefined
}

export interface AdGroupView {
  id: string
  source: PlanAdGroup
  campaignId: string
  campaignName: string
  name: string
  defaultBidCents: number | null
  asins: string[]
  removed: boolean
  targets: TargetView[]
}

export interface CampaignView {
  id: string
  source: PlanCampaign
  name: string
  dailyBudget: number
  biddingStrategy: string
  placementBidding: PlacementBid[]
  targetingType: 'AUTO' | 'MANUAL'
  removed: boolean
  adGroups: AdGroupView[]
}

export interface PlanView {
  campaigns: CampaignView[]
  /** Every target in the plan, flattened — the flat view, the filters, the counts. */
  targets: TargetView[]
}

const idx = <T extends { id: string }>(list: T[] | undefined) => new Map((list ?? []).map((e) => [e.id, e]))

/**
 * Fold the edit set onto the server's plan to get what the screen should show.
 *
 * Removals are kept VISIBLE (struck through, restorable) rather than filtered
 * out — the server evaluates the same edits into a second plan for the verdict,
 * so this view's job is to let the operator see and reverse what they did, not
 * to predict totals. Totals always come from the server's edited plan.
 */
export function viewPlan(
  plan: Plan,
  edits: PlanEdits,
  conflictDecisions: Record<string, 'skip' | 'accept'>,
  /**
   * The gate's verdict over the EDITED plan.
   *
   * `plan` is the un-edited one — that is what keeps node ids stable and lets a
   * removed row stay visible and restorable. But a keyword the operator typed,
   * or one they rewrote, only exists in the edited plan, so its conflict is only
   * ever reported there. Without this the gate would block on a keyword the
   * review table showed as perfectly fine.
   */
  serverConflicts: PlanConflict[] = [],
): PlanView {
  const rmC = new Set(edits.removedCampaigns ?? [])
  const rmG = new Set(edits.removedAdGroups ?? [])
  const rmT = new Set(edits.removedTargets ?? [])
  const renC = idx(edits.renamedCampaigns)
  const renG = idx(edits.renamedAdGroups)
  const budC = idx(edits.campaignBudgets)
  const bidG = idx(edits.adGroupBids)
  const bidT = idx(edits.targetBids)
  const exprT = idx(edits.targetExpressions)
  const mtT = idx(edits.targetMatchTypes)
  const placeC = idx(edits.campaignPlacements)
  const stratC = idx(edits.campaignBidding)
  const asinsG = idx(edits.adGroupAsins)

  // Only consulted for rows the client cannot classify itself — added and
  // rewritten ones. A copied row's own `conflictsWith` is already authoritative,
  // and matching by text alone would flag a brand keyword that merely shares its
  // wording with a gated category term.
  const fromServer = new Map(serverConflicts.map((c) => [c.expression.toLowerCase(), c.existing]))

  const addedByAg = new Map<string, NonNullable<PlanEdits['addedTargets']>>()
  for (const a of edits.addedTargets ?? []) {
    const l = addedByAg.get(a.adGroupId) ?? []
    l.push(a)
    addedByAg.set(a.adGroupId, l)
  }

  const all: TargetView[] = []
  const campaigns = plan.campaigns.map((c) => {
    const cRemoved = rmC.has(c.id)
    const cName = renC.get(c.id)?.name ?? c.name
    const adGroups = c.adGroups.map((g) => {
      const gRemoved = cRemoved || rmG.has(g.id)
      const gName = renG.get(g.id)?.name ?? g.name
      const defaultBidCents = bidG.get(g.id)?.defaultBidCents ?? g.defaultBidCents
      const targets: TargetView[] = g.targets.map((t) => {
        const expression = exprT.get(t.id)?.expression ?? t.expression
        const matchType = mtT.get(t.id)?.expressionType ?? t.expressionType
        const bidCents = bidT.get(t.id)?.bidCents ?? t.bidCents
        const rewritten = exprT.has(t.id)
        const conflict = rewritten
          ? (fromServer.get(expression.toLowerCase()) ?? null)
          : (t.conflictsWith?.length ? t.conflictsWith : null)
        return {
          id: t.id,
          source: t,
          campaignId: c.id,
          campaignName: cName,
          adGroupId: g.id,
          adGroupName: gName,
          expression,
          matchType,
          kind: t.kind,
          isNegative: t.isNegative,
          bidCents,
          effectiveBidCents: bidCents ?? defaultBidCents,
          autoClause: t.autoClause ?? null,
          removed: gRemoved || rmT.has(t.id),
          touched: exprT.has(t.id) || mtT.has(t.id) || bidT.has(t.id),
          added: false,
          conflict,
          decision: conflict ? conflictDecisions[expression.toLowerCase()] : undefined,
        }
      })
      ;(addedByAg.get(g.id) ?? []).forEach((a, i) => {
        targets.push({
          id: `add:${g.id}:${i}`,
          source: null,
          campaignId: c.id,
          campaignName: cName,
          adGroupId: g.id,
          adGroupName: gName,
          expression: a.expression,
          matchType: a.expressionType,
          kind: a.kind ?? 'KEYWORD',
          isNegative: !!a.isNegative,
          bidCents: a.bidCents ?? null,
          effectiveBidCents: a.bidCents ?? defaultBidCents,
          autoClause: null,
          removed: gRemoved,
          touched: true,
          added: true,
          conflict: fromServer.get(a.expression.toLowerCase()) ?? null,
          decision: conflictDecisions[a.expression.toLowerCase()],
        })
      })
      all.push(...targets)
      return {
        id: g.id,
        source: g,
        campaignId: c.id,
        campaignName: cName,
        name: gName,
        defaultBidCents,
        asins: asinsG.get(g.id)?.asins ?? g.asins,
        removed: gRemoved,
        targets,
      }
    })
    return {
      id: c.id,
      source: c,
      name: cName,
      dailyBudget: budC.get(c.id)?.dailyBudget ?? c.dailyBudget ?? 0,
      biddingStrategy: stratC.get(c.id)?.biddingStrategy ?? c.biddingStrategy ?? 'LEGACY_FOR_SALES',
      placementBidding: placeC.get(c.id)?.placementBidding ?? c.placementBidding ?? [],
      targetingType: c.targetingType,
      removed: cRemoved,
      adGroups,
    }
  })
  return { campaigns, targets: all }
}

// ── conflicts ─────────────────────────────────────────────────────────────

/**
 * Every conflicting keyword, once per EXPRESSION rather than once per row.
 *
 * The gate reports one conflict per expression, and a structure repeats the same
 * category term across its match-type tiers — so "giacca moto" is typically in
 * three or four ad groups at once. Resolving it has to mean resolving all of
 * them, or the operator clicks a button that visibly does nothing.
 */
export interface ConflictGroup {
  expression: string
  key: string
  rows: TargetView[]
  competitors: Array<{ campaignName: string; campaignId: string }>
  decision: 'skip' | 'accept' | undefined
  /** Still counted against the operator by the server's gate. */
  unresolved: boolean
}

export function conflictGroups(
  view: PlanView,
  conflictDecisions: Record<string, 'skip' | 'accept'>,
): ConflictGroup[] {
  const by = new Map<string, ConflictGroup>()
  for (const t of view.targets) {
    if (!t.conflict) continue
    const key = t.expression.toLowerCase()
    const g = by.get(key) ?? {
      expression: t.expression,
      key,
      rows: [],
      competitors: t.conflict,
      decision: conflictDecisions[key],
      unresolved: false,
    }
    g.rows.push(t)
    by.set(key, g)
  }
  for (const g of by.values()) {
    // A conflict is settled when it is accepted, or when every row carrying it
    // is gone. Dropping three of four instances leaves it live — and the server
    // would still block, which is exactly the surprise this recomputation avoids.
    g.unresolved = g.decision !== 'accept' && g.rows.some((r) => !r.removed)
  }
  return [...by.values()].sort((a, b) => a.expression.localeCompare(b.expression))
}

/** Drop every row carrying these expressions, and record the decision. */
export function dropConflicts(
  edits: PlanEdits, groups: ConflictGroup[],
): { edits: PlanEdits; decisions: Record<string, 'skip'> } {
  const ids = groups.flatMap((g) => g.rows.filter((r) => !r.added).map((r) => r.id))
  const decisions: Record<string, 'skip'> = {}
  for (const g of groups) decisions[g.key] = 'skip'
  let next = setIds(edits, 'removedTargets', ids, true)
  // A conflicting keyword the operator TYPED is un-added rather than removed —
  // it has no plan id for `removedTargets` to address.
  const keys = new Set(groups.map((g) => g.key))
  if (next.addedTargets?.some((a) => keys.has(a.expression.toLowerCase()))) {
    next = { ...next, addedTargets: next.addedTargets.filter((a) => !keys.has(a.expression.toLowerCase())) }
  }
  return { edits: next, decisions }
}

/** Put every row carrying these expressions back, and clear the decision. */
export function restoreConflicts(edits: PlanEdits, groups: ConflictGroup[]): PlanEdits {
  const ids = groups.flatMap((g) => g.rows.map((r) => r.id))
  return setIds(edits, 'removedTargets', ids, false)
}

// ── the change ledger ─────────────────────────────────────────────────────

export interface Change {
  key: string
  scope: 'Campaign' | 'Ad group' | 'Keyword' | 'Plan'
  subject: string
  detail: string
  undo: PlanEdits
}

const eur = (cents: number | null | undefined) => `€${((cents ?? 0) / 100).toFixed(2)}`

/**
 * Everything the operator changed, in words, each one individually reversible.
 *
 * Built from the plan rather than stored alongside it, so it survives a re-plan:
 * the edit set is the only state, and this is a projection of it.
 */
export function describeChanges(plan: Plan, edits: PlanEdits): Change[] {
  const out: Change[] = []
  const camps = new Map(plan.campaigns.map((c) => [c.id, c]))
  const groups = new Map(plan.campaigns.flatMap((c) => c.adGroups.map((g) => [g.id, { g, c }] as const)))
  const targets = new Map(plan.campaigns.flatMap((c) => c.adGroups.flatMap((g) => g.targets.map((t) => [t.id, { t, g, c }] as const))))
  const cName = (id: string) => camps.get(id)?.name ?? id
  const gName = (id: string) => groups.get(id)?.g.name ?? id
  const tName = (id: string) => targets.get(id)?.t.expression ?? id

  for (const id of edits.removedCampaigns ?? []) {
    out.push({ key: `rc:${id}`, scope: 'Campaign', subject: cName(id), detail: 'will not be created', undo: toggleId(edits, 'removedCampaigns', id) })
  }
  for (const id of edits.removedAdGroups ?? []) {
    out.push({ key: `rg:${id}`, scope: 'Ad group', subject: gName(id), detail: 'will not be created', undo: toggleId(edits, 'removedAdGroups', id) })
  }
  for (const id of edits.removedTargets ?? []) {
    out.push({ key: `rt:${id}`, scope: 'Keyword', subject: tName(id), detail: 'dropped', undo: toggleId(edits, 'removedTargets', id) })
  }
  for (const e of edits.renamedCampaigns ?? []) {
    out.push({ key: `nc:${e.id}`, scope: 'Campaign', subject: camps.get(e.id)?.name ?? e.id, detail: `renamed to "${e.name}"`, undo: clearKeyed(edits, 'renamedCampaigns', e.id) })
  }
  for (const e of edits.renamedAdGroups ?? []) {
    out.push({ key: `ng:${e.id}`, scope: 'Ad group', subject: groups.get(e.id)?.g.name ?? e.id, detail: `renamed to "${e.name}"`, undo: clearKeyed(edits, 'renamedAdGroups', e.id) })
  }
  for (const e of edits.campaignBudgets ?? []) {
    out.push({ key: `bc:${e.id}`, scope: 'Campaign', subject: cName(e.id), detail: `daily budget €${camps.get(e.id)?.dailyBudget ?? 0} → €${e.dailyBudget}`, undo: clearKeyed(edits, 'campaignBudgets', e.id) })
  }
  for (const e of edits.adGroupBids ?? []) {
    out.push({ key: `bg:${e.id}`, scope: 'Ad group', subject: gName(e.id), detail: `default bid ${eur(groups.get(e.id)?.g.defaultBidCents)} → ${eur(e.defaultBidCents)}`, undo: clearKeyed(edits, 'adGroupBids', e.id) })
  }
  for (const e of edits.targetBids ?? []) {
    out.push({ key: `bt:${e.id}`, scope: 'Keyword', subject: tName(e.id), detail: `bid ${eur(targets.get(e.id)?.t.bidCents)} → ${eur(e.bidCents)}`, undo: clearKeyed(edits, 'targetBids', e.id) })
  }
  for (const e of edits.targetExpressions ?? []) {
    out.push({ key: `et:${e.id}`, scope: 'Keyword', subject: tName(e.id), detail: `rewritten as "${e.expression}"`, undo: clearKeyed(edits, 'targetExpressions', e.id) })
  }
  for (const e of edits.targetMatchTypes ?? []) {
    out.push({ key: `mt:${e.id}`, scope: 'Keyword', subject: tName(e.id), detail: `match type → ${e.expressionType.toLowerCase()}`, undo: clearKeyed(edits, 'targetMatchTypes', e.id) })
  }
  for (const e of edits.campaignPlacements ?? []) {
    const parts = e.placementBidding.filter((p) => p.percentage > 0).map((p) => `${p.placement.replace('PLACEMENT_', '').replace(/_/g, ' ').toLowerCase()} +${p.percentage}%`)
    out.push({ key: `pc:${e.id}`, scope: 'Campaign', subject: cName(e.id), detail: parts.length ? `placements ${parts.join(', ')}` : 'placement modifiers cleared', undo: clearKeyed(edits, 'campaignPlacements', e.id) })
  }
  for (const e of edits.campaignBidding ?? []) {
    out.push({ key: `sc:${e.id}`, scope: 'Campaign', subject: cName(e.id), detail: `bidding strategy → ${e.biddingStrategy.replace(/_/g, ' ').toLowerCase()}`, undo: clearKeyed(edits, 'campaignBidding', e.id) })
  }
  for (const e of edits.adGroupAsins ?? []) {
    out.push({ key: `ac:${e.id}`, scope: 'Ad group', subject: gName(e.id), detail: `advertises ${e.asins.length} of the selected products`, undo: clearKeyed(edits, 'adGroupAsins', e.id) })
  }
  ;(edits.addedTargets ?? []).forEach((a, i) => {
    out.push({
      key: `at:${i}`,
      scope: 'Keyword',
      subject: a.expression,
      detail: `added to ${gName(a.adGroupId)}${a.isNegative ? ' as a negative' : ''}`,
      undo: { ...edits, addedTargets: (edits.addedTargets ?? []).filter((_, j) => j !== i) },
    })
  })
  return out
}
