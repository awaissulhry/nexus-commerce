/**
 * R4 (MCP full control, part 06) — deciding the ads rule suggestions a PROPOSE rule queued: apply, dismiss, restore,
 * and the bulk decide that commits a staged batch.
 *
 * Moved unchanged out of `routes/advertising.routes.ts` (the SG.0 closures behind POST /advertising/suggestions/:id/
 * apply|dismiss|restore and POST /advertising/suggestions/bulk) so a Claude tool decides through the same code. The
 * routes answer byte for byte as before (automation-routes-parity.vitest.test.ts).
 *
 * Not here, on purpose: `/suggestions/:id/pause-target` — a person's click that pauses a target. A rule's suggestion is
 * never applied as a pause (a temporary stop is lower bids; Claude's real pause is pause-ads, its own request), so that
 * route keeps its logic to itself.
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

/**
 * The action an apply runs, with the operator's override (ApplyOverride) — the one translation every caller shares:
 * W4-9 — Claude's decide-automation-suggestions judges its limits on this action, so the edited value is the one the
 * limits judge and the one that lands. Moved unchanged out of applySuggestion. Pure.
 */
export function overriddenAction(proposed: unknown, ov: ApplyOverride = {}): { action: Record<string, unknown>; overridden: boolean; overrideRecord: Record<string, number> | null } {
  let action = { ...((proposed ?? {}) as Record<string, unknown>) }
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
  return { action, overridden, overrideRecord }
}

/** The rule fields that decide WHAT a rule proposes; an edit to any of them makes its older proposals stale. */
const PROPOSING_FIELDS: Record<string, string> = {
  trigger: 'trigger', conditions: 'conditions', actions: 'actions',
  scopeMarketplace: 'scope', scopePortfolioId: 'scope', scopeCampaignId: 'scope', scopeProductId: 'scope',
}

/**
 * 4l (review 2.8) — whether the rule that proposed this change would still propose it; a sentence when it would not.
 *
 * Approving applied a suggestion whatever had become of its rule since: deleted, switched Off, or edited (conditions,
 * actions, trigger, scope) so it no longer proposes the change. A suggestion is the rule's proposal, so it is applied
 * only while the rule stands behind it. "Edited" is read from the rule's audit rows (every edit writes one, the scope
 * route too since 4l) newer than `lastSeenAt` — the newest run that still proposed this change. If the edited rule
 * still proposes it, its next run stamps `lastSeenAt` again and the change can be applied. Nothing is written here.
 */
export async function staleRuleSentence(sug: { ruleId: string; ruleName: string | null; lastSeenAt: Date }): Promise<string | null> {
  const rule = await prisma.automationRule.findUnique({
    where: { id: sug.ruleId }, select: { id: true, name: true, domain: true, enabled: true, dryRun: true, autonomyLevel: true },
  })
  if (!rule || rule.domain !== 'advertising') {
    return `This change can no longer be applied: the rule that proposed it${sug.ruleName ? ` (${sug.ruleName})` : ''} was deleted. Dismiss it.`
  }
  const { resolveAutonomy } = await import('./ads-autonomy.js')
  if (resolveAutonomy(rule) === 'OFF') {
    return `This change can no longer be applied: ${rule.name} is Off, and a rule that is Off changes nothing. Switch it back on; if the change still holds, it will propose it again.`
  }
  const edits = await prisma.advertisingActionLog.findMany({
    where: { entityType: 'RULE', entityId: rule.id, actionType: 'update_rule', createdAt: { gt: sug.lastSeenAt } },
    select: { payloadAfter: true }, take: 50,
  })
  const what = new Set<string>()
  for (const e of edits) {
    const after = e.payloadAfter
    if (after && typeof after === 'object' && !Array.isArray(after)) for (const k of Object.keys(after)) if (PROPOSING_FIELDS[k]) what.add(PROPOSING_FIELDS[k])
  }
  if (what.size) {
    return `This change cannot be applied now: ${rule.name} was edited (${[...what].join(', ')}) after it proposed this, and it has not proposed it again since. If the edited rule still wants this change, it will propose it on its next run.`
  }
  return null
}

/** What each handler's skip means, for one that says no sentence of its own (automation-action-handlers.ts). */
const SKIP_WORDS: Record<string, string> = {
  'campaign-not-selected': "its campaign is not one the rule's campaign picker selects",
  'rank-owned': 'the hourly bid plans hold this campaign',
  contested_by_rank_engine: 'the hourly bid plans hold this placement lane, and a change decided by rule leaves it to them',
  'protected-product': 'the ads strategy protects a product this ad group advertises',
  suppressed_flag: 'its target is held at the floor bid by no-pause suppression',
  suppressed_by_bid: 'its target sits at the floor bid (suppressed)',
  campaign_suppressed: "its campaign's bids are suppressed: the next restore would overwrite the change",
  'source-ad-group-not-in-mappings': "the search term's ad group is not in the rule's mappings",
  'term-filter': "the search term does not pass the rule's term filters",
}

/** AA-W2-10 — why the rule's handler passed an apply over, in a sentence; null when it did not. Pure. */
export function skipSentence(result: unknown): string | null {
  const output = (result as { output?: Record<string, unknown> } | null)?.output
  const code = typeof output?.skipped === 'string' ? output.skipped : null
  if (!code) return null
  const said = [output!.why, output!.reason].find((v): v is string => typeof v === 'string' && !!v.trim())
  return `Skipped — nothing was written, and it stays waiting: ${said ?? SKIP_WORDS[code] ?? `the rule passed it over (${code})`}.`
}

/**
 * AA-W2-10 — how an approval carries an apply out (Claude's decide-automation-suggestions). `operatorApproved`: a person
 * decided it (in Nexus, or with his code in Claude); false when the business's rule decided it — a rule's run is not a
 * person's write, so it does not take a placement lane the rank engine holds. `approval` (D7): the change set and the
 * audit reason every write of the apply carries (the rule stays the writer).
 */
export interface ApplyAs {
  operatorApproved?: boolean
  approval?: { changeSetId: string; reason: string }
}

// Approve → re-run the proposed action LIVE against the frozen execution context (respects the
// automation halt + the handlers' own spend caps). The operator already approved, so we apply
// the action directly rather than re-evaluating conditions — but only while its rule still stands behind it (4l).
export async function applySuggestion(id: string, ov: ApplyOverride = {}, decidedBy = 'operator', as: ApplyAs = {}): Promise<DecideResult & { negatives?: string[] }> {
  const sug = await prisma.adsRuleSuggestion.findUnique({ where: { id } })
  if (!sug) return { ok: false, httpStatus: 404, error: 'not_found' }
  if (sug.status !== 'pending') return { ok: false, httpStatus: 409, error: `already ${sug.status}` }
  const { isAutomationHalted } = await import('./ads-automation-state.service.js')
  if (await isAutomationHalted()) return { ok: false, httpStatus: 423, error: 'automation_halted' }
  // 4l (review 2.8) — a refusal like the gate's (SG.0 below): the row stays pending and the caller shows the sentence.
  const stale = await staleRuleSentence(sug)
  if (stale) return { ok: false, refused: true, error: stale }
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
  const { action, overridden, overrideRecord } = overriddenAction(sug.proposedAction, ov)
  const handler = ACTION_HANDLERS[String(action.type)]
  if (!handler) return { ok: false, httpStatus: 422, error: `no handler for ${action.type}` }
  // 4e — `operatorApproved`: a person approved this change, so a placement lane the rank engine holds is written, not skipped.
  // AA-W2-10 — the Suggestions page is always a person; an approval says who decided it (ApplyAs).
  const approval = as.approval ? { ...as.approval, negatives: [] as string[] } : undefined
  // BB-9 — on a campaign the bid brain owns, the approved change is stored as the brain's input (a BidDirective from this
  // rule), not written: the brain is the campaign's one bid writer. Every other campaign is applied as before.
  const { ruleBrainInput } = await import('./bid-brain/rule-directives.js')
  const meta = { dryRun: false, ruleId: sug.ruleId, operatorApproved: as.operatorApproved ?? true, ...(approval ? { approval } : {}) }
  const trigger = typeof (triggerData as { trigger?: unknown } | null)?.trigger === 'string' ? (triggerData as { trigger: string }).trigger : null
  const result = await ruleBrainInput(action as never, triggerData, { ruleId: sug.ruleId, trigger, dryRun: false }, (a) => handler(a as never, triggerData, { ...meta, dryRun: true }))
    ?? await handler(action as never, triggerData, meta)
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
    return { ok: false, refused: true, error: result.error ?? 'refused', result, ...(approval?.negatives.length ? { negatives: approval.negatives } : {}) }
  }
  // AA-W2-10 — a handler that passed it over wrote nothing: it is not applied. Said as a refusal, with the reason, and
  // the row keeps waiting (SG.0's rule for a refusal), never "applied" with nothing behind it.
  const skipped = skipSentence(result)
  if (skipped) return { ok: false, refused: true, skipped: true, error: skipped, result }
  await prisma.adsRuleSuggestion.update({
    where: { id }, data: { status: 'applied', decidedAt: new Date(), decidedBy, appliedResult: { ...(result as object), ...(overridden && overrideRecord ? { override: overrideRecord } : {}) } as object },
  })
  return { ok: true, result, ...(approval?.negatives.length ? { negatives: approval.negatives } : {}) }
}

export async function dismissSuggestion(id: string, decidedBy = 'operator'): Promise<DecideResult> {
  const sug = await prisma.adsRuleSuggestion.findUnique({ where: { id }, select: { status: true } })
  if (!sug) return { ok: false, httpStatus: 404, error: 'not_found' }
  if (sug.status !== 'pending') return { ok: false, httpStatus: 409, error: `already ${sug.status}` }
  await prisma.adsRuleSuggestion.update({ where: { id }, data: { status: 'dismissed', decidedAt: new Date(), decidedBy } })
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

/** One decision Claude asks for. W4-9 — an apply may carry an edited value (`override`), as the Suggestions page's edit. */
export interface ClaudeDecisionInput { suggestionId: string; decide: ClaudeDecision; override?: ApplyOverride }

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
  /**
   * D7 — an apply only: where its write lands, for the write gate the tool asks (live / sandbox / refused). `campaign`:
   * the campaign the write gate judges (null when it is not found); `sweep`: a market- or account-wide action with no
   * single campaign. `term` is a negative's search term (keyword protection binds it).
   */
  landsOn?: { scope: 'campaign' | 'sweep'; campaignId: string | null; marketplace: string | null; term: string | null }
  /** W4-9 — an apply's edited value: the action the limits judge and the apply runs is the edited one (overriddenAction). */
  override?: ApplyOverride
}

/**
 * The dry run of a batch of decisions: every suggestion found here and still waiting (restore: one dismissed or
 * expired), and every apply allowed — never a pause, a switch-on or an archive (a rule's change never is one; the
 * substitute is named), never a target held at the floor by no-pause suppression (applying would lift it: A3 guard),
 * never while ads automation is halted. Refused as a whole, naming each reason; nothing is written.
 */
export async function planSuggestionDecisions(
  decisions: ClaudeDecisionInput[],
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
  // SEARCH_TERM entity ids are `${externalCampaignId}:${query}` (the query may itself contain ':').
  const termOf = (entityId: string) => { const at = entityId.indexOf(':'); return at >= 0 ? { ext: entityId.slice(0, at), query: entityId.slice(at + 1) } : { ext: entityId, query: '' } }
  const termExtIds = [...new Set(rows.filter((r) => r.entityType === 'SEARCH_TERM').map((r) => termOf(r.entityId).ext))]
  const [targets, campaigns, termCampaigns] = await Promise.all([
    prisma.adTarget.findMany({ where: { id: { in: targetIds } }, select: { id: true, bidCents: true, suppressedFromBidCents: true, adGroup: { select: { campaign: { select: { id: true, marketplace: true } } } } } }),
    prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true, dailyBudget: true, marketplace: true } }),
    termExtIds.length ? prisma.campaign.findMany({ where: { externalCampaignId: { in: termExtIds } }, select: { id: true, externalCampaignId: true, marketplace: true } }) : Promise.resolve([]),
  ])
  const targetById = new Map(targets.map((t) => [t.id, t]))
  const budgetById = new Map(campaigns.map((c) => [c.id, Number(c.dailyBudget)]))
  const campaignById = new Map(campaigns.map((c) => [c.id, c]))
  /** D7 — where an apply's write lands (DecisionItem.landsOn). */
  const landsOn = (r: (typeof rows)[number]): NonNullable<DecisionItem['landsOn']> => {
    if (r.entityType === 'AD_TARGET') {
      const c = targetById.get(r.entityId)?.adGroup?.campaign
      return { scope: 'campaign', campaignId: c?.id ?? null, marketplace: c?.marketplace ?? r.marketplace, term: null }
    }
    if (r.entityType === 'CAMPAIGN') {
      const c = campaignById.get(r.entityId)
      return { scope: 'campaign', campaignId: c?.id ?? null, marketplace: c?.marketplace ?? r.marketplace, term: null }
    }
    if (r.entityType === 'SEARCH_TERM') {
      const { ext, query } = termOf(r.entityId)
      const c = termCampaigns.find((x) => x.externalCampaignId === ext && x.marketplace === r.marketplace) ?? termCampaigns.find((x) => x.externalCampaignId === ext)
      return { scope: 'campaign', campaignId: c?.id ?? null, marketplace: c?.marketplace ?? r.marketplace, term: query || r.entityName }
    }
    return { scope: 'sweep', campaignId: null, marketplace: r.entityType === 'MARKETPLACE' ? r.entityId : r.marketplace, term: null }
  }
  const problems: string[] = []
  const items: DecisionItem[] = []
  for (const d of decisions) {
    const r = byId.get(d.suggestionId)!
    const family = familyOfRow(r)
    const label = `${r.ruleName ?? 'a rule'} on ${r.entityName ?? r.entityType}`
    // W4-9 — an edited value fits an apply of one target's bid or one campaign's budget (the page's inline edit).
    const edit = d.override && (d.override.resultBidCents != null || d.override.resultBudgetEur != null || d.override.value != null) ? d.override : null
    if (edit) {
      if (d.decide !== 'apply') problems.push(`${label}: only an apply takes a value of its own`)
      else if (edit.resultBidCents != null && (family !== 'bids' || r.entityType !== 'AD_TARGET')) problems.push(`${label}: a bid of its own fits a bid suggestion on one target, and this is a ${family} suggestion`)
      else if (edit.resultBudgetEur != null && (family !== 'budget' || r.entityType !== 'CAMPAIGN')) problems.push(`${label}: a daily budget of its own fits a budget suggestion on one campaign, and this is a ${family} suggestion`)
    }
    const action = (edit && d.decide === 'apply' ? overriddenAction(r.proposedAction, edit).action : (r.proposedAction ?? {})) as Record<string, unknown>
    const denied = can(family)
    if (denied) problems.push(`${label}: ${denied}`)
    if (d.decide === 'restore' ? !['dismissed', 'expired'].includes(r.status) : r.status !== 'pending') problems.push(`${label}: it is ${r.status}`)
    if (d.decide === 'apply') {
      const asked = String(((r.proposedAction ?? {}) as Record<string, unknown>).type ?? '')
      for (const refused of refusedActionsOf([...new Set([asked, String(action.type ?? '')])])) problems.push(`${label}: ${refused.type} refused — ${refused.why}; dismiss it and use ${refused.instead}`)
      const target = r.entityType === 'AD_TARGET' ? targetById.get(r.entityId) : undefined
      if (target?.suppressedFromBidCents != null) problems.push(`${label}: its target is held at the floor bid by no-pause suppression — applying would lift it; dismiss it, or wait until its campaign resumes`)
      const stale = await staleRuleSentence(r) // 4l — refused before a person is asked, not after
      if (stale) problems.push(`${label}: ${stale}`)
    }
    const current = r.entityType === 'AD_TARGET' ? targetById.get(r.entityId)?.bidCents ?? null : r.entityType === 'CAMPAIGN' ? budgetById.get(r.entityId) ?? null : null
    const projected = family === 'bids' ? projectBidCents(action, current) : family === 'budget' ? projectBudgetEur(action, current) : null
    items.push({ suggestionId: r.id, decide: d.decide, rule: r.ruleName, entity: r.entityName ?? r.entityType, family, status: r.status, proposed: { type: action.type ?? null, op: action.op ?? null, value: action.value ?? null }, current, projected, ...(d.decide === 'apply' ? { landsOn: landsOn(r) } : {}), ...(edit && d.decide === 'apply' ? { override: edit } : {}) })
  }
  if (decisions.some((d) => d.decide === 'apply')) {
    const { isAutomationHalted } = await import('./ads-automation-state.service.js')
    if (await isAutomationHalted()) problems.push('ads automation is halted: nothing may be applied until it is resumed')
  }
  if (problems.length) return { ok: false, error: `Not decided — ${problems.join('; ')}.` }
  return { ok: true, items }
}

/**
 * The approved run: each decision through the same apply / dismiss / restore the Suggestions page uses. D7 — a decision
 * records the person who approved it (`user:<id>`), not the page's anonymous 'operator'. AA-W2-10 — what an apply writes
 * carries the rule's own actor, the approval's change set and an audit reason naming the request and who decided it
 * (`as`): undo-ad-change finds the writes by the approval id, and the negatives an apply created are returned
 * (`negatives`, their Nexus rows) for it to retire.
 */
export async function applySuggestionDecisions(
  decisions: ClaudeDecisionInput[],
  approverId: string | null = null,
  as: ApplyAs = {},
): Promise<{ results: Array<{ suggestionId: string; decide: ClaudeDecision; ok: boolean; status: string; detail: string | null; skipped?: true }>; negatives: string[] }> {
  const decidedBy = approverId ? `user:${approverId}` : 'operator'
  const results = []
  const negatives: string[] = []
  for (const d of decisions) {
    const result = d.decide === 'apply' ? await applySuggestion(d.suggestionId, d.override ?? {}, decidedBy, as) : d.decide === 'dismiss' ? await dismissSuggestion(d.suggestionId, decidedBy) : await restoreSuggestion(d.suggestionId)
    for (const id of (result as { negatives?: string[] }).negatives ?? []) if (!negatives.includes(id)) negatives.push(id)
    const now = await prisma.adsRuleSuggestion.findUnique({ where: { id: d.suggestionId }, select: { status: true } })
    results.push({ suggestionId: d.suggestionId, decide: d.decide, ok: result.ok, status: now?.status ?? 'gone', detail: result.error ?? null, ...(result.skipped ? { skipped: true as const } : {}) })
  }
  return { results, negatives }
}

/** AA-W2-10 — what each suggestion would apply and where, for the limits its tool is judged on by rule (suggestion-limits.ts). */
export async function suggestionSubjects(ids: string[]): Promise<Array<{ id: string; ruleId: string; entityType: string; entityId: string; proposedAction: unknown; proposedKey: string }>> {
  if (!ids.length) return []
  return prisma.adsRuleSuggestion.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, ruleId: true, entityType: true, entityId: true, proposedAction: true, proposedKey: true },
  })
}

/** W4-9 — these suggestions as a dismissal or a restore names them: status, rule and what it acts on. */
export async function suggestionLabels(ids: string[]): Promise<Array<{ id: string; status: string; ruleName: string | null; entityName: string | null; entityType: string }>> {
  if (!ids.length) return []
  return prisma.adsRuleSuggestion.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, status: true, ruleName: true, entityName: true, entityType: true } })
}

/** The statuses of these suggestions now (undo compares them with what the decision left). */
export async function suggestionStatuses(ids: string[]): Promise<Array<{ id: string; status: string }>> {
  const rows = await prisma.adsRuleSuggestion.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } })
  const byId = new Map(rows.map((r) => [r.id, r.status]))
  return ids.map((id) => ({ id, status: byId.get(id) ?? 'gone' }))
}
