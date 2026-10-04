/**
 * R4 (MCP full control, part 06) — deciding the ads rule suggestions a PROPOSE rule queued: apply, dismiss, restore,
 * and the bulk decide that commits a staged batch.
 *
 * Moved unchanged out of `routes/advertising.routes.ts` (the SG.0 closures behind POST /advertising/suggestions/:id/
 * apply|dismiss|restore and POST /advertising/suggestions/bulk) so a Claude tool decides through the same code. The
 * routes answer byte for byte as before (automation-routes-parity.vitest.test.ts).
 *
 * Not here, on purpose: `/suggestions/:id/pause-target` — a person's click that pauses a target. Nothing Claude runs
 * may pause (Owner rule: lower bids, never pause), so that route keeps its logic to itself.
 *
 * Each helper returns a plain outcome instead of writing to `reply`, so the bulk decide can report per-row results and
 * the single routes can map the same outcome to an HTTP code. `httpStatus` is set only for the outcomes that are
 * protocol-level (404/409/422/423); a REFUSAL is not one of them — see applySuggestion.
 */
import prisma from '../../db.js'
import { muteSuggestion, unmuteSuggestion, type DecideResult } from './ads-suggestions.service.js'
import { done, refused, type ServiceOutcome } from '../automation/service-outcome.js'

export type { DecideResult }

/**
 * SG.2b — the operator's override, in either of two grammars:
 *   value            replaces the action's own magnitude (the drawer's edit: decPct 15 → 20).
 *   resultBidCents / resultBudgetEur
 *                    replaces the RESULT (H10's inline staging input: type €0.35 in the row).
 *                    Expressed by rewriting the action to the setValue op of its family — the
 *                    one honest translation of "make it exactly this" — with every other field
 *                    (entity ids, context) preserved. The write gate still binds either way,
 *                    and `appliedResult.override` records the edit, which graduation reads as
 *                    agreement-with-correction.
 */
export type ApplyOverride = { value?: number; resultBidCents?: number; resultBudgetEur?: number }

// Approve → re-run the proposed action LIVE against the frozen execution context (respects the
// automation halt + the handlers' own spend caps). The operator already approved, so we apply
// the action directly rather than re-evaluating conditions.
export async function applySuggestion(id: string, ov: ApplyOverride = {}): Promise<DecideResult> {
  const sug = await prisma.adsRuleSuggestion.findUnique({ where: { id } })
  if (!sug) return { ok: false, httpStatus: 404, error: 'not_found' }
  if (sug.status !== 'pending') return { ok: false, httpStatus: 409, error: `already ${sug.status}` }
  const { isAutomationHalted } = await import('./ads-automation-state.service.js')
  if (await isAutomationHalted()) return { ok: false, httpStatus: 423, error: 'automation_halted' }
  // The frozen execution context is pruned after a few days. Don't hard-fail a stale
  // suggestion: budget/bid/placement actions are self-contained (they carry campaignId + op +
  // value and read current values live from the DB), so they re-apply correctly against an
  // empty context. Context-dependent actions (e.g. search-term harvest) fail CLOSED inside the
  // handler ("No campaign.id in context") — never a blind write.
  const exec = sug.executionId
    ? await prisma.automationRuleExecution.findUnique({ where: { id: sug.executionId }, select: { triggerData: true } })
    : null
  const triggerData = exec?.triggerData ?? {}
  await import('./automation-action-handlers.js') // ensure handlers registered
  const { ACTION_HANDLERS } = await import('../automation-rule.service.js')
  // S.5 — optional edit-before-apply: the operator may override the action's magnitude
  // (`value`) from the detail drawer. The handler still clamps to the action's own min/max
  // bounds (e.g. minEur/maxEur), so an override can't escape the rule's guardrails.
  let action = { ...(sug.proposedAction as Record<string, unknown>) }
  let overridden = false
  let overrideRecord: Record<string, number> | null = null
  if (typeof ov.resultBidCents === 'number' && Number.isFinite(ov.resultBidCents) && ov.resultBidCents > 0) {
    action = { ...action, type: 'bid_apply', op: 'setValue', value: ov.resultBidCents / 100 }
    overridden = true
    overrideRecord = { resultBidCents: ov.resultBidCents }
  } else if (typeof ov.resultBudgetEur === 'number' && Number.isFinite(ov.resultBudgetEur) && ov.resultBudgetEur > 0) {
    action = { ...action, type: 'budget_apply', op: 'setValue', value: ov.resultBudgetEur }
    overridden = true
    overrideRecord = { resultBudgetEur: ov.resultBudgetEur }
  } else if (typeof ov.value === 'number' && Number.isFinite(ov.value) && ov.value !== action.value) {
    action.value = ov.value
    overridden = true
    overrideRecord = { value: ov.value }
  }
  const handler = ACTION_HANDLERS[String(action.type)]
  if (!handler) return { ok: false, httpStatus: 422, error: `no handler for ${action.type}` }
  // 4e — `operatorApproved`: a person approved this change, so a placement lane the rank engine holds is written, not skipped.
  const result = await handler(action as never, triggerData, { dryRun: false, ruleId: sug.ruleId, operatorApproved: true })
  /**
   * 🔴 SG.0 — a refused apply STAYS PENDING.
   *
   * This route used to mark the row `applied` unconditionally, so a write-gate denial or a
   * protectConverting refusal landed in the Applied tab looking like a success — two rows with
   * identical status meaning "landed at Amazon" and "refused at the gate". A refusal is a
   * governed stop, not a decision the operator made: the row keeps waiting, and the caller
   * gets the server's own sentence to show.
   */
  if (result.ok === false) {
    return { ok: false, refused: true, error: result.error ?? 'refused', result }
  }
  await prisma.adsRuleSuggestion.update({
    where: { id }, data: { status: 'applied', decidedAt: new Date(), decidedBy: 'operator', appliedResult: { ...(result as object), ...(overridden && overrideRecord ? { override: overrideRecord } : {}) } as object },
  })
  return { ok: true, result }
}

export async function dismissSuggestion(id: string): Promise<DecideResult> {
  const sug = await prisma.adsRuleSuggestion.findUnique({ where: { id }, select: { status: true } })
  if (!sug) return { ok: false, httpStatus: 404, error: 'not_found' }
  if (sug.status !== 'pending') return { ok: false, httpStatus: 409, error: `already ${sug.status}` }
  await prisma.adsRuleSuggestion.update({ where: { id }, data: { status: 'dismissed', decidedAt: new Date(), decidedBy: 'operator' } })
  return { ok: true }
}

// S.4 — Undo a dismiss: put a dismissed (or SG.0-expired) suggestion back to pending.
// SG.3 — an APPLIED row may come back too, but ONLY when its write never landed (the gate
// refused it after the approve, or delivery dead-lettered). A change that reached Amazon is
// not un-applied here — that is the rollback path's job, from the Change Log handle.
export async function restoreSuggestion(id: string): Promise<DecideResult> {
  const sug = await prisma.adsRuleSuggestion.findUnique({
    where: { id },
    select: { status: true, entityType: true, entityId: true, decidedAt: true, appliedResult: true },
  })
  if (!sug) return { ok: false, httpStatus: 404, error: 'not_found' }
  if (sug.status === 'applied') {
    const { attachDeliveryData } = await import('./ads-suggestions.service.js')
    const [row] = await attachDeliveryData([sug])
    if (row.delivery.state !== 'refused' && row.delivery.state !== 'failed') {
      return { ok: false, httpStatus: 409, error: 'this change was delivered — undo it from the Change Log instead of restoring the suggestion' }
    }
    // the appliedResult (the refusal, in the server's words) stays on the row as history
    await prisma.adsRuleSuggestion.update({ where: { id }, data: { status: 'pending', decidedAt: null, decidedBy: null } })
    return { ok: true }
  }
  if (sug.status !== 'dismissed' && sug.status !== 'expired') return { ok: false, httpStatus: 409, error: `cannot restore ${sug.status}` }
  await prisma.adsRuleSuggestion.update({ where: { id }, data: { status: 'pending', decidedAt: null, decidedBy: null } })
  return { ok: true }
}

export type SuggestionDecision = 'apply' | 'dismiss' | 'restore' | 'mute' | 'unmute'

export interface BulkDecideInput {
  ids?: unknown
  kind?: string
  /** SG.2b — H10's staged batch: accepts and removals COMMIT TOGETHER on "Apply N Changes",
   *  each accept optionally carrying the operator's inline override. */
  ops?: Array<{ id?: unknown; kind?: unknown; value?: unknown; resultBidCents?: unknown; resultBudgetEur?: unknown }>
}

export interface BulkDecideResult {
  ok: boolean
  okCount: number
  failCount: number
  results: Array<{ id: string; kind: SuggestionDecision; ok: boolean; refused?: true; error?: string }>
}

/**
 * SG.0 — bulk decide. One round trip for "Apply N changes" instead of N client-side POSTs, and — the part the client
 * loop could never give — a PER-ROW outcome list, so a partial result can name which rows were refused and why
 * instead of dissolving into a count. Applies run with concurrency 3 (each is a live write path: local DB write +
 * queue enqueue), matching the old client loop's pacing.
 */
export async function decideSuggestionsBulk(b: BulkDecideInput): Promise<ServiceOutcome<BulkDecideResult>> {
  // SG.9 — `mute` / `unmute` join the staged batch: H10 commits all three row verbs through
  // the one "Apply N Changes", so the third one cannot be a side-channel POST.
  type Op = { id: string; kind: SuggestionDecision; ov: ApplyOverride }
  const KINDS = ['apply', 'dismiss', 'restore', 'mute', 'unmute']
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  let ops: Op[] = []
  if (Array.isArray(b.ops)) {
    const seen = new Set<string>()
    for (const o of b.ops) {
      const id = typeof o?.id === 'string' ? o.id : ''
      const kind = String(o?.kind ?? '')
      if (!id || seen.has(id) || !KINDS.includes(kind)) continue
      seen.add(id)
      ops.push({ id, kind: kind as Op['kind'], ov: { value: num(o.value), resultBidCents: num(o.resultBidCents), resultBudgetEur: num(o.resultBudgetEur) } })
    }
  } else {
    const ids = Array.isArray(b.ids) ? [...new Set(b.ids.filter((x): x is string => typeof x === 'string'))] : []
    const kind = String(b.kind ?? '')
    if (KINDS.includes(kind)) ops = ids.map((id) => ({ id, kind: kind as Op['kind'], ov: {} }))
  }
  if (!ops.length || ops.length > 200) {
    return refused(400, { error: 'ops (1–200 of {id, kind apply|dismiss|restore|mute|unmute}) or ids+kind required' })
  }
  if (ops.some((o) => o.kind === 'apply')) {
    const { isAutomationHalted } = await import('./ads-automation-state.service.js')
    if (await isAutomationHalted()) return refused(423, { error: 'automation_halted' })
  }
  const byId = new Map<string, DecideResult>()
  let i = 0
  const worker = async () => {
    while (i < ops.length) {
      const op = ops[i++]
      try {
        byId.set(op.id, op.kind === 'apply' ? await applySuggestion(op.id, op.ov)
          : op.kind === 'dismiss' ? await dismissSuggestion(op.id)
          : op.kind === 'mute' ? await muteSuggestion(op.id)
          : op.kind === 'unmute' ? await unmuteSuggestion(op.id)
          : await restoreSuggestion(op.id))
      } catch (e) {
        byId.set(op.id, { ok: false, error: (e as Error).message })
      }
    }
  }
  await Promise.all([worker(), worker(), worker()])
  const results = ops.map(({ id, kind }) => {
    const out = byId.get(id) ?? { ok: false, error: 'not_processed' }
    return { id, kind, ok: out.ok, ...(out.refused ? { refused: true as const } : {}), ...(out.error ? { error: out.error } : {}) }
  })
  const okCount = results.filter((r) => r.ok).length
  return done({ ok: okCount === results.length, okCount, failCount: results.length - okCount, results })
}

// ── R11 (MCP full control, part 06 §3) — Claude's decide-automation-suggestions ─────────────────────────

export type ClaudeDecision = 'apply' | 'dismiss' | 'restore'

export interface DecisionItem {
  suggestionId: string
  decide: ClaudeDecision
  rule: string | null
  entity: string
  family: string
  status: string
  /** What the suggestion would change, and what is there now (bids in cents, budgets in euros). */
  proposed: Record<string, unknown>
  current: number | null
  projected: number | null
}

/**
 * The dry run of a batch of decisions: every suggestion found here and still waiting (restore: one dismissed or
 * expired), and every apply allowed — never a pause, a switch-on or an archive (Owner rule: never pause; the
 * substitute is named), never a target held at the floor by no-pause suppression (applying would lift it: A3 guard),
 * never while ads automation is halted. Refused as a whole, naming each reason; nothing is written.
 */
export async function planSuggestionDecisions(
  decisions: Array<{ suggestionId: string; decide: ClaudeDecision }>,
  can: (family: string) => string | null,
): Promise<{ ok: true; items: DecisionItem[] } | { ok: false; error: string }> {
  const ids = [...new Set(decisions.map((d) => d.suggestionId))]
  if (ids.length !== decisions.length) return { ok: false, error: 'Each suggestion may be named once.' }
  const rows = await prisma.adsRuleSuggestion.findMany({ where: { id: { in: ids } } })
  const byId = new Map(rows.map((r) => [r.id, r]))
  const missing = ids.filter((id) => !byId.has(id))
  if (missing.length) return { ok: false, error: `Suggestions not found in this business: ${missing.join(', ')} (not found).` }
  const { familyOfRow, projectBidCents, projectBudgetEur } = await import('./ads-suggestions.service.js')
  const { refusedActionsOf } = await import('../automation/no-pause.js')
  const targetIds = rows.filter((r) => r.entityType === 'AD_TARGET').map((r) => r.entityId)
  const campaignIds = rows.filter((r) => r.entityType === 'CAMPAIGN').map((r) => r.entityId)
  const [targets, campaigns] = await Promise.all([
    prisma.adTarget.findMany({ where: { id: { in: targetIds } }, select: { id: true, bidCents: true, suppressedFromBidCents: true } }),
    prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true, dailyBudget: true } }),
  ])
  const targetById = new Map(targets.map((t) => [t.id, t]))
  const budgetById = new Map(campaigns.map((c) => [c.id, Number(c.dailyBudget)]))
  const problems: string[] = []
  const items: DecisionItem[] = []
  for (const d of decisions) {
    const r = byId.get(d.suggestionId)!
    const action = (r.proposedAction ?? {}) as Record<string, unknown>
    const family = familyOfRow(r)
    const label = `${r.ruleName ?? 'a rule'} on ${r.entityName ?? r.entityType}`
    const denied = can(family)
    if (denied) problems.push(`${label}: ${denied}`)
    if (d.decide === 'restore' ? !['dismissed', 'expired'].includes(r.status) : r.status !== 'pending') problems.push(`${label}: it is ${r.status}`)
    if (d.decide === 'apply') {
      for (const refused of refusedActionsOf([String(action.type ?? '')])) problems.push(`${label}: ${refused.type} refused — ${refused.why}; dismiss it and use ${refused.instead}`)
      const target = r.entityType === 'AD_TARGET' ? targetById.get(r.entityId) : undefined
      if (target?.suppressedFromBidCents != null) problems.push(`${label}: its target is held at the floor bid by no-pause suppression — applying would lift it; dismiss it, or wait until its campaign resumes`)
    }
    const current = r.entityType === 'AD_TARGET' ? targetById.get(r.entityId)?.bidCents ?? null : r.entityType === 'CAMPAIGN' ? budgetById.get(r.entityId) ?? null : null
    const projected = family === 'bids' ? projectBidCents(action, current) : family === 'budget' ? projectBudgetEur(action, current) : null
    items.push({ suggestionId: r.id, decide: d.decide, rule: r.ruleName, entity: r.entityName ?? r.entityType, family, status: r.status, proposed: { type: action.type ?? null, op: action.op ?? null, value: action.value ?? null }, current, projected })
  }
  if (decisions.some((d) => d.decide === 'apply')) {
    const { isAutomationHalted } = await import('./ads-automation-state.service.js')
    if (await isAutomationHalted()) problems.push('ads automation is halted: nothing may be applied until it is resumed')
  }
  if (problems.length) return { ok: false, error: `Not decided — ${problems.join('; ')}.` }
  return { ok: true, items }
}

/** The approved run: each decision through the same apply / dismiss / restore the Suggestions page uses. */
export async function applySuggestionDecisions(decisions: Array<{ suggestionId: string; decide: ClaudeDecision }>): Promise<Array<{ suggestionId: string; decide: ClaudeDecision; ok: boolean; status: string; detail: string | null }>> {
  const out = []
  for (const d of decisions) {
    const result = d.decide === 'apply' ? await applySuggestion(d.suggestionId) : d.decide === 'dismiss' ? await dismissSuggestion(d.suggestionId) : await restoreSuggestion(d.suggestionId)
    const now = await prisma.adsRuleSuggestion.findUnique({ where: { id: d.suggestionId }, select: { status: true } })
    out.push({ suggestionId: d.suggestionId, decide: d.decide, ok: result.ok, status: now?.status ?? 'gone', detail: result.error ?? null })
  }
  return out
}

/** The statuses of these suggestions now (undo compares them with what the decision left). */
export async function suggestionStatuses(ids: string[]): Promise<Array<{ id: string; status: string }>> {
  const rows = await prisma.adsRuleSuggestion.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } })
  const byId = new Map(rows.map((r) => [r.id, r.status]))
  return ids.map((id) => ({ id, status: byId.get(id) ?? 'gone' }))
}
