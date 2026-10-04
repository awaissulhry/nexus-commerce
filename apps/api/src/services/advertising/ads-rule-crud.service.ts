/**
 * R4 (MCP full control, part 06) — an Amazon ads rule's life: create, edit, delete, test, gate status, graduate,
 * pause-all.
 *
 * Moved unchanged out of `routes/advertising.routes.ts` (POST/PATCH/DELETE /advertising/automation-rules, …/:id/test,
 * …/:id/gate-status, …/:id/graduate, POST /advertising/autonomy/pause-all) so a Claude tool can run the same code. The
 * routes call these and answer byte for byte as before (automation-routes-parity.vitest.test.ts holds that).
 *
 * New here (part 06 gap 5): every create, edit, delete, graduation and pause-all leaves an `AdvertisingActionLog` row
 * (`create_rule` / `update_rule` / `delete_rule` / `set_rule_autonomy`, entity `RULE`) naming the person and what the
 * rule was before and after. A delete cascades the rule's run history, so its row is the only record of what the rule
 * was. An audit row never fails the change it describes.
 */
import type { AutomationRule } from '@prisma/client'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { evaluateRule, type EvaluateRuleResult } from '../automation-rule.service.js'
import type { AdsActor } from './ads-mutation.service.js'
import { done, isRefused, refused, type ServiceOutcome } from '../automation/service-outcome.js'
import { invalidValuesBody, readRuleCaps, ruleValueProblems } from './ads-rule-values.js'

/** The triggers the advertising evaluator emits. A rule on any other trigger would never run. */
export const ADS_RULE_TRIGGERS: ReadonlySet<string> = new Set([
  'FBA_AGE_THRESHOLD_REACHED',
  'AD_SPEND_PROFITABILITY_BREACH',
  'CAC_SPIKE',
  'AD_TARGET_UNDERPERFORMING',
  'CAMPAIGN_PERFORMANCE_BUDGET',
  'SCHEDULE',
  // evaluator also supports these keyword/search-term/conversion triggers
  'CVR_DROP',
  'KEYWORD_LOW_CTR',
  'KEYWORD_WASTED_SPEND',
  'KEYWORD_ZERO_IMPRESSIONS',
  'SEARCH_TERM_CONVERTING',
  // Engine expansion (E-series) — net-new triggers
  'KEYWORD_HIGH_ACOS',
  // 4f — builder Bid rules: every clicked, enabled, unsuppressed positive target
  'TARGET_PERFORMANCE',
  'KEYWORD_SCALE_OPPORTUNITY',
  'AD_GROUP_UNDERPERFORMING',
  'NEW_TO_BRAND_WINNER',
  'CAMPAIGN_NO_SALES',
  'SEARCH_TERM_WASTING',
  'CAMPAIGN_ROAS_DECLINING',
  'KEYWORD_RISING_STAR',
  // SK-series — keyword-bid-adjustment rules driven by Share-of-Voice / keyword-tracker rank data
  'SOV_BID',
  'KEYWORD_RANK_BID',
])

/** What a rule IS, for its audit rows: its configuration, never its counters. */
const RULE_AUDIT_KEYS = [
  'name', 'description', 'trigger', 'conditions', 'actions', 'enabled', 'dryRun', 'autonomyLevel', 'priority',
  'maxExecutionsPerDay', 'maxValueCentsEur', 'maxDailyAdSpendCentsEur', 'maxWritesPerDay',
  'scopeMarketplace', 'scopePortfolioId', 'scopeCampaignId', 'scopeProductId',
] as const

function ruleConfig(rule: Partial<AutomationRule>, keys: readonly string[] = RULE_AUDIT_KEYS): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) if (key in rule) out[key] = (rule as Record<string, unknown>)[key] ?? null
  return out
}

/** One audit row; it never fails the change it describes. */
async function auditRule(actor: AdsActor, actionType: string, ruleId: string, before: object, after: object, note: string): Promise<void> {
  await prisma.advertisingActionLog.create({
    data: {
      userId: actor,
      actionType, entityType: 'RULE', entityId: ruleId,
      payloadBefore: before as object, payloadAfter: after as object, amazonResponseStatus: 'SUCCESS',
      evidence: { metric: 'operator_rule_edit', note },
    },
  }).catch((error: unknown) => logger.warn('[ADS-RULE-AUDIT] audit row not written', { ruleId, actionType, error: String(error) }))
}

/** BUD-P2 — mirror a builder BUDGET rule's picker list into `CampaignRuleAssignment`. Never fatal. */
async function mirrorBinding(ruleId: string, actions: unknown, actor: AdsActor, when: 'create' | 'patch'): Promise<void> {
  try {
    const { syncRuleCampaignBinding } = await import('./rule-campaign-binding.service.js')
    await syncRuleCampaignBinding(ruleId, actions as never, actor)
  } catch (e) {
    logger.error(`[ADS-RULE-BINDING] ${when} mirror failed`, { ruleId, error: String(e) })
  }
}

const untranslatableBody = (metrics: string[], full: boolean) => ({
  error: 'untranslatable_conditions',
  metrics,
  message: full
    ? `No engine signal exists for: ${metrics.join(', ')}. Remove those conditions — a rule saved with them could never evaluate as written.`
    : `No engine signal exists for: ${metrics.join(', ')}.`,
})

export interface AdsRuleCreateInput {
  name: string
  description?: string
  trigger: string
  conditions?: object[]
  actions?: object[]
  maxExecutionsPerDay?: number
  maxValueCentsEur?: number
  maxDailyAdSpendCentsEur?: number
  maxWritesPerDay?: number
  scopeMarketplace?: string
}

/**
 * R9 — what only a service caller may set (Claude's save-ad-rule): never read from a request body, so the routes keep
 * their exact behaviour and a PATCH cannot set a level past the level route's ceiling check.
 */
export interface AdsRuleServiceExtra {
  enabled?: boolean
  dryRun?: boolean
  autonomyLevel?: 'OFF' | 'OBSERVE' | 'PROPOSE'
  scopePortfolioId?: string | null
  scopeCampaignId?: string | null
  scopeProductId?: string | null
  /** An edit's new trigger (the route never changes one); checked by the caller against the conditions. */
  trigger?: string
  /** Said in the audit row: who asked, through which door. */
  note?: string
}

/** POST /advertising/automation-rules. A new rule is born disabled and dry-run. */
export async function createAdsRule(body: AdsRuleCreateInput, actor: AdsActor, extra: AdsRuleServiceExtra = {}): Promise<ServiceOutcome<{ rule: AutomationRule }>> {
  if (!body?.name || !body.trigger) return refused(400, { error: 'name + trigger required' })
  // 4b (review 4.1) — every number readable (a decimal comma is fine) and in range, checked BEFORE the untranslatable
  // refusal below so a typo is answered with what is wrong with it, not as a missing engine signal. A cap that cannot
  // be read is refused — it never becomes "no cap" — and one sent as text is stored as the number it says.
  const { caps, problems } = readRuleCaps(body)
  problems.unshift(...ruleValueProblems(body))
  if (problems.length) return refused(400, invalidValuesBody(problems))
  // P2.1 — refuse an untranslatable builder rule AT SAVE. The adapter used to drop unmapped
  // AND-conditions at evaluation, which made the rule LOOSER than the author wrote; now the
  // adapter fails such a rule closed and this refuses to store one at all, naming the metrics.
  {
    const { listUntranslatableMetrics } = await import('./ads-rule-adapter.service.js')
    const bad = listUntranslatableMetrics({ actions: body.actions, conditions: body.conditions })
    if (bad.length) return refused(400, untranslatableBody(bad, true))
  }
  if (!ADS_RULE_TRIGGERS.has(body.trigger)) return refused(400, { error: `unknown trigger: ${body.trigger}` })
  const rule = await prisma.automationRule.create({
    data: {
      name: body.name,
      description: body.description ?? null,
      domain: 'advertising',
      trigger: body.trigger,
      conditions: (body.conditions ?? []) as object,
      actions: (body.actions ?? []) as object,
      // Safe defaults: every new advertising rule starts disabled +
      // dry-run; operator must explicitly opt in to live writes.
      enabled: false,
      dryRun: true,
      maxExecutionsPerDay: caps.maxExecutionsPerDay ?? 10,
      maxValueCentsEur: caps.maxValueCentsEur ?? null,
      maxDailyAdSpendCentsEur: caps.maxDailyAdSpendCentsEur ?? 10000,
      // P2.2 — the demote-to-dry-run write cap (CAP step 6). Builder rules could not set it at
      // all before, so every one arrived with the second brake unset.
      maxWritesPerDay: caps.maxWritesPerDay ?? null,
      scopeMarketplace: body.scopeMarketplace ?? null,
      createdBy: 'user',
      ...withoutNote(extra),
    },
  })
  await auditRule(actor, 'create_rule', rule.id, {}, ruleConfig(rule), `${rule.name} created${extra.note ? ` (${extra.note})` : ''}`)
  // BUD-P2 — mirror a builder BUDGET rule's picker list into `CampaignRuleAssignment`, so the
  // Apply Rules Budget-Rule column shows what this rule actually governs. Never fatal: the rule
  // is saved and the engine reads the rule's own list, so a failed mirror leaves the COLUMN
  // stale, not the rule broken.
  await mirrorBinding(rule.id, body.actions, actor, 'create')
  return done({ rule })
}

export interface AdsRuleUpdateInput {
  name?: string
  description?: string | null
  enabled?: boolean
  dryRun?: boolean
  conditions?: object[]
  actions?: object[]
  maxExecutionsPerDay?: number | null
  maxValueCentsEur?: number | null
  maxDailyAdSpendCentsEur?: number | null
  maxWritesPerDay?: number | null
  scopeMarketplace?: string | null
  priority?: number
}

const withoutNote = ({ note: _note, ...rest }: AdsRuleServiceExtra) => rest

/** PATCH /advertising/automation-rules/:id. */
export async function updateAdsRule(id: string, body: AdsRuleUpdateInput, actor: AdsActor, extra: AdsRuleServiceExtra = {}): Promise<ServiceOutcome<{ rule: AutomationRule }>> {
  const existing = await prisma.automationRule.findUnique({ where: { id } })
  if (!existing || existing.domain !== 'advertising') return refused(404, { error: 'not_found' })
  // 4b — as the create: numbers readable and in range, the MERGED pair checked as P2.1 checks it just below.
  const { caps, problems } = readRuleCaps(body)
  if (body.actions !== undefined || body.conditions !== undefined) {
    problems.unshift(...ruleValueProblems({ actions: body.actions ?? existing.actions, conditions: body.conditions ?? existing.conditions }))
  }
  if (problems.length) return refused(400, invalidValuesBody(problems))
  // P2.1 — same save-time refusal as the create route. Validate the MERGED rule: a PATCH that
  // touches neither actions nor conditions cannot introduce an untranslatable metric, but one
  // that changes either half must be checked against the pair it will actually store.
  if (body.actions !== undefined || body.conditions !== undefined) {
    const { listUntranslatableMetrics } = await import('./ads-rule-adapter.service.js')
    const bad = listUntranslatableMetrics({
      actions: body.actions ?? (existing.actions as object[]),
      conditions: body.conditions ?? (existing.conditions as object[]),
    })
    if (bad.length) return refused(400, untranslatableBody(bad, true))
  }
  const data: Record<string, unknown> = {}
  if (body.name !== undefined) data.name = body.name
  if (body.description !== undefined) data.description = body.description
  if (body.enabled !== undefined) data.enabled = body.enabled
  if (body.dryRun !== undefined) data.dryRun = body.dryRun
  if (body.conditions !== undefined) {
    /**
     * 🔴 EA5 — an ENGINE-NATIVE rule keeps its shape.
     *
     * The builder always sends nested groups. Storing those on a rule whose actions are engine
     * types would leave a pair nothing handles: `maybeTranslateAdsRule` fires on builder-shaped
     * ACTIONS only, so the nested conditions would reach `evaluateFlatList`, whose leaves have no
     * `field`, and throw mid-tick — taking every remaining trigger down with it.
     *
     * `conditionsForStorage` translates them back to flat leaves with the same maps the forward
     * direction uses. A builder-shaped rule is passed through untouched.
     */
    const { conditionsForStorage } = await import('./ads-rule-adapter.service.js')
    const stored = conditionsForStorage({ actions: existing.actions }, body.conditions)
    if (stored.unmapped.length) return refused(400, untranslatableBody(stored.unmapped, false))
    data.conditions = stored.conditions
  }
  if (body.actions !== undefined) data.actions = body.actions
  /**
   * EA7 — run order. Clamped to 1..999 so a value cannot be set outside the band the UI shows,
   * and rejected rather than coerced if it is not a number: silently turning a typo into 0 would
   * promote a rule to first place without saying so.
   */
  if (body.priority !== undefined) {
    if (!Number.isFinite(body.priority) || body.priority < 1 || body.priority > 999) {
      return refused(400, { error: 'priority must be a number between 1 and 999 (lower runs first)' })
    }
    data.priority = Math.round(body.priority)
  }
  Object.assign(data, caps) // 4b — the four caps as read above: only the ones the body sent, in this order
  if (body.scopeMarketplace !== undefined) data.scopeMarketplace = body.scopeMarketplace
  Object.assign(data, withoutNote(extra))
  const rule = await prisma.automationRule.update({ where: { id }, data })
  const changed = Object.keys(data)
  if (changed.length) {
    await auditRule(actor, 'update_rule', rule.id, ruleConfig(existing, changed), ruleConfig(rule, changed), `${rule.name}: ${changed.join(', ')}${extra.note ? ` (${extra.note})` : ''}`)
  }
  // BUD-P2 — the picker list changed only if `actions` was sent; re-mirror from the SAVED rule
  // so the column follows an edit that removed campaigns as faithfully as one that added them.
  if (body.actions !== undefined) await mirrorBinding(rule.id, rule.actions, actor, 'patch')
  return done({ rule })
}

/** DELETE /advertising/automation-rules/:id. The run history goes with the rule; its audit row keeps what it was. */
export async function deleteAdsRule(id: string, actor: AdsActor): Promise<ServiceOutcome<{ ok: true }>> {
  const existing = await prisma.automationRule.findUnique({ where: { id } })
  if (!existing || existing.domain !== 'advertising') return refused(404, { error: 'not_found' })
  // Cascading delete on AutomationRuleExecution covered by the FK.
  await prisma.automationRule.delete({ where: { id } })
  await auditRule(actor, 'delete_rule', id, ruleConfig(existing), {}, `${existing.name} deleted (its run history went with it)`)
  return done({ ok: true })
}

/**
 * POST /advertising/automation-rules/:id/test — a rule against a hand-supplied context, as a preview: always a dry
 * run, and (R3) no run row and no counter.
 */
export async function testAdsRule(id: string, context: unknown): Promise<ServiceOutcome<{ result: EvaluateRuleResult }>> {
  if (context == null) return refused(400, { error: 'context required' })
  const rule = await prisma.automationRule.findUnique({ where: { id } })
  if (!rule || rule.domain !== 'advertising') return refused(404, { error: 'not_found' })
  // RA.AUTO — a disabled rule is evaluated via `ignoreEnabled`, not by arming it.
  //
  // This used to write `enabled: true`, evaluate, and write it back in a `finally`. For the
  // duration the database held a genuinely armed rule, against an evaluator cron that ticks
  // every 15 minutes — and if the process died in between, the rule stayed armed. The flag
  // reaches the same result with no window and no write. Behaviour for callers is identical.
  const result = await evaluateRule({
    ruleId: id, context, forceDryRun: true, isTestRun: true,
    ignoreEnabled: !rule.enabled, noPersist: true,
  })
  return done({ result })
}

export const GRADUATION_OBSERVATION_DAYS = 14

export interface GateCheck { id: string; label: string; detail: string; passed: boolean }
export interface GateStatus { gateOpen: boolean; daysInDryRun: number; observationDaysRequired: number; checks: GateCheck[] }

/**
 * GET /advertising/automation-rules/:id/gate-status — Phase 9. The 8 checks a rule must pass before it may graduate
 * from dry-run to live. OBSERVATION_WINDOW uses rule.createdAt as a conservative proxy for "how long has this rule been
 * deployed". We require 14 full days.
 */
export async function adsRuleGateStatus(id: string): Promise<ServiceOutcome<GateStatus>> {
  const rule = await prisma.automationRule.findUnique({
    where: { id },
    select: {
      id: true, domain: true, enabled: true, dryRun: true,
      createdAt: true, evaluationCount: true, matchCount: true,
      executionCount: true,
    },
  })
  if (!rule || rule.domain !== 'advertising') return refused(404, { error: 'not_found' })

  const conn = await prisma.amazonAdsConnection.findFirst({
    where: { isActive: true },
    select: { mode: true, writesEnabledAt: true },
  })

  const daysInDryRun = Math.floor(
    (Date.now() - rule.createdAt.getTime()) / (1000 * 60 * 60 * 24),
  )
  const OBSERVATION_DAYS = GRADUATION_OBSERVATION_DAYS
  const liveMode = (process.env.NEXUS_AMAZON_ADS_MODE ?? 'sandbox') === 'live'

  const checks = [
    {
      id: 'RULE_ENABLED',
      label: 'Rule is enabled',
      detail: rule.enabled ? 'Enabled' : 'Rule must be enabled (toggle it on first)',
      passed: rule.enabled,
    },
    {
      id: 'RULE_DRY_RUN',
      label: 'Rule is in dry-run mode',
      detail: rule.dryRun ? 'Currently dry-run (safe to graduate)' : 'Already live — nothing to graduate',
      passed: rule.dryRun,
    },
    {
      id: 'OBSERVATION_WINDOW',
      label: `${OBSERVATION_DAYS}-day observation period`,
      detail: daysInDryRun >= OBSERVATION_DAYS
        ? `${daysInDryRun} days since rule created — window complete`
        : `${daysInDryRun}/${OBSERVATION_DAYS} days — ${OBSERVATION_DAYS - daysInDryRun} days remaining`,
      passed: daysInDryRun >= OBSERVATION_DAYS,
    },
    {
      id: 'HAS_EVALUATIONS',
      label: 'Rule has evaluation history',
      detail: rule.evaluationCount >= 10
        ? `${rule.evaluationCount} evaluations recorded`
        : `${rule.evaluationCount} evaluations — need at least 10 to prove the rule has run`,
      passed: rule.evaluationCount >= 10,
    },
    {
      id: 'HAS_MATCHES',
      label: 'Rule has matched at least once',
      detail: rule.matchCount > 0
        ? `${rule.matchCount} matches — rule has found real candidates`
        : 'Zero matches — rule may not be triggering correctly (check conditions)',
      passed: rule.matchCount > 0,
    },
    {
      id: 'CONNECTION_PRODUCTION',
      label: 'Ads connection in production mode',
      detail: conn?.mode === 'production'
        ? 'AmazonAdsConnection.mode = production'
        : `AmazonAdsConnection.mode = ${conn?.mode ?? 'none'} (must be production)`,
      passed: conn?.mode === 'production',
    },
    {
      id: 'WRITES_ENABLED',
      label: 'Live writes explicitly enabled',
      detail: conn?.writesEnabledAt != null
        ? `Writes enabled at ${conn.writesEnabledAt.toISOString()}`
        : 'Run /advertising/connection/preview-writes + /enable-writes first',
      passed: conn?.writesEnabledAt != null,
    },
    {
      id: 'LIVE_MODE_ENV',
      label: 'NEXUS_AMAZON_ADS_MODE=live deployed',
      detail: liveMode
        ? 'Environment variable confirmed'
        : 'Set NEXUS_AMAZON_ADS_MODE=live on Railway and redeploy',
      passed: liveMode,
    },
  ]

  const gateOpen = checks.every((c) => c.passed)
  return done({ gateOpen, daysInDryRun, observationDaysRequired: OBSERVATION_DAYS, checks })
}

/**
 * POST /advertising/automation-rules/:id/graduate — Phase 9. Flips dryRun=false (and the dial to AUTO) after
 * re-running the gate checks server-side; 409 with the failures otherwise. The operator watches the first live runs.
 */
export async function graduateAdsRule(id: string, actor: AdsActor): Promise<ServiceOutcome<{ ok: true; rule: { id: string; name: string; dryRun: boolean; enabled: boolean; autonomyLevel: string }; graduatedAt: string }>> {
  const rule = await prisma.automationRule.findUnique({
    where: { id },
    select: {
      id: true, domain: true, name: true, enabled: true, dryRun: true,
      createdAt: true, evaluationCount: true, matchCount: true, actions: true, conditions: true,
    },
  })
  if (!rule || rule.domain !== 'advertising') return refused(404, { error: 'not_found' })

  // ADX N3 — the eight checks below are about EVIDENCE: has this rule run long enough,
  // matched often enough, is the connection live. None of them ask what the rule
  // actually DOES, so a rule that creates negatives could graduate on the strength of
  // having done so quietly for a fortnight.
  //
  // A bid is a number the engine can move back. A negative is a thing that now exists
  // and that nobody will notice later. The ceiling is judged by the rule's most
  // dangerous action and it is not overridable here — a structural rule stays at
  // PROPOSE until it has a retirement path, which is a design decision, not a
  // question of how much evidence has accumulated.
  const { graduationCeiling } = await import('./ads-graduation.js')
  // BP.P1 — op-aware: a builder rule is judged by the actions its translation actually emits
  // (a set/raise/lower Bid rule is reversible; only a Pause/Unpause one is structural).
  const { producedActionTypes } = await import('./ads-rule-adapter.service.js')
  const protectionCount = await prisma.adKeywordProtection.count({ where: { mode: 'WHITELIST' } })
  const ceiling = graduationCeiling({
    actionTypes: producedActionTypes(rule),
    hasKeywordProtections: protectionCount > 0,
  })
  if (ceiling.maxLevel !== 'AUTO') {
    return refused(409, {
      error: 'above_graduation_ceiling',
      maxLevel: ceiling.maxLevel,
      blockedBy: ceiling.blockedBy,
      message: ceiling.reason,
    })
  }

  // Re-validate gate server-side — never trust the client's gate result
  const conn = await prisma.amazonAdsConnection.findFirst({
    where: { isActive: true },
    select: { profileId: true, mode: true, writesEnabledAt: true },
  })
  const daysInDryRun = Math.floor((Date.now() - rule.createdAt.getTime()) / (1000 * 60 * 60 * 24))
  const liveMode = (process.env.NEXUS_AMAZON_ADS_MODE ?? 'sandbox') === 'live'

  const failures: string[] = []
  if (!rule.enabled)            failures.push('RULE_ENABLED')
  if (!rule.dryRun)             failures.push('RULE_DRY_RUN')
  if (daysInDryRun < 14)        failures.push(`OBSERVATION_WINDOW (${daysInDryRun}/14 days)`)
  if (rule.evaluationCount < 10) failures.push(`HAS_EVALUATIONS (${rule.evaluationCount}/10)`)
  if (rule.matchCount < 1)      failures.push('HAS_MATCHES')
  if (conn?.mode !== 'production') failures.push('CONNECTION_PRODUCTION')
  if (!conn?.writesEnabledAt)   failures.push('WRITES_ENABLED')
  if (!liveMode)                failures.push('LIVE_MODE_ENV')

  if (failures.length > 0) {
    return refused(409, {
      error: 'gate_not_open',
      failures,
      message: 'Not all gate checks passed — resolve the listed items first',
    })
  }

  const updated = await prisma.automationRule.update({
    where: { id },
    // ADX N2 — set the dial as well as the legacy binary, so the two cannot disagree
    // about whether this rule acts.
    data: { dryRun: false, autonomyLevel: 'AUTO' },
    select: { id: true, name: true, dryRun: true, enabled: true, autonomyLevel: true },
  })
  logger.info('[ADS-GRADUATE] rule graduated to live', {
    ruleId: id, ruleName: rule.name, profileId: conn?.profileId,
  })
  await auditRule(actor, 'set_rule_autonomy', id, { dryRun: true }, { level: 'AUTO', dryRun: false }, `${rule.name} → AUTO (graduated through the gate)`)
  return done({ ok: true as const, rule: updated, graduatedAt: new Date().toISOString() })
}

/** POST /advertising/autonomy/pause-all — switch every enabled ads rule off (the rules, not any campaign). */
export async function pauseAllAdsRules(actor: AdsActor): Promise<{ ok: true; pausedRuleIds: string[] }> {
  const enabled = await prisma.automationRule.findMany({ where: { domain: 'advertising', enabled: true }, select: { id: true } })
  const ids = enabled.map((r) => r.id)
  if (ids.length) await prisma.automationRule.updateMany({ where: { id: { in: ids } }, data: { enabled: false } })
  if (ids.length) {
    await prisma.advertisingActionLog.createMany({
      data: ids.map((ruleId) => ({
        userId: actor, actionType: 'update_rule', entityType: 'RULE', entityId: ruleId,
        payloadBefore: { enabled: true }, payloadAfter: { enabled: false }, amazonResponseStatus: 'SUCCESS',
        evidence: { metric: 'operator_rule_edit', note: 'every ads rule switched off (pause-all)' },
      })),
    }).catch((error: unknown) => logger.warn('[ADS-RULE-AUDIT] pause-all audit rows not written', { rules: ids.length, error: String(error) }))
  }
  return { ok: true, pausedRuleIds: ids }
}

/**
 * PATCH /advertising/autonomy/rules/:id — the A12 level dial: OFF · OBSERVE · PROPOSE · AUTO, held under the rule's
 * graduation ceiling (what it DOES) and, for a placement rule at AUTO, the rank engine's lanes (who else writes them).
 * Moved unchanged from advertising.routes.ts (R10), so the route and Claude's turn-up / turn-down share it.
 */
export async function setAdsRuleLevel(id: string, level: unknown, actor: AdsActor): Promise<ServiceOutcome<{ ok: true; rule: { id: string; name: string; autonomyLevel: string; enabled: boolean; dryRun: boolean } }>> {
  const allowed = await adsRuleLevelRefusal(id, level)
  if (isRefused(allowed)) return allowed
  const rule = allowed.value
  // `enabled` remains the on/off, and dryRun is kept in step so the two cannot disagree
  // about whether this rule acts.
  const updated = await prisma.automationRule.update({
    where: { id },
    data: {
      autonomyLevel: level as string,
      enabled: level !== 'OFF',
      dryRun: level !== 'AUTO',
    },
    select: { id: true, name: true, autonomyLevel: true, enabled: true, dryRun: true },
  })
  await prisma.advertisingActionLog.create({
    data: {
      userId: actor,
      actionType: 'set_rule_autonomy', entityType: 'RULE', entityId: id,
      payloadBefore: {}, payloadAfter: { level: level as string }, amazonResponseStatus: 'SUCCESS',
      evidence: { metric: 'operator_autonomy', note: `${rule.name} → ${String(level)}` },
    },
  }).catch(() => { /* an audit row must never fail the write it describes */ })
  return done({ ok: true as const, rule: updated })
}

/**
 * R10 — whether a rule may be set to `level`, writing nothing: the level is a level, the rule is an ads rule here, the
 * graduation ceiling allows it, a placement rule is not contested at AUTO, and AUTO passed the gate (D-R1). The dry run
 * of turn-up-automation asks this before a person is asked.
 */
export async function adsRuleLevelRefusal(id: string, level: unknown): Promise<ServiceOutcome<{ id: string; name: string }>> {
  const { isAutonomyLevel } = await import('./ads-autonomy.js')
  const { graduationCeiling, isLevelAllowed } = await import('./ads-graduation.js')
  if (!isAutonomyLevel(level)) return refused(400, { ok: false, error: 'level must be OFF | OBSERVE | PROPOSE | AUTO' })

  const rule = await prisma.automationRule.findUnique({
    where: { id }, select: { id: true, name: true, domain: true, actions: true, conditions: true },
  })
  if (!rule || rule.domain !== 'advertising') return refused(404, { ok: false, error: 'not_found' })

  const protectionCount = await prisma.adKeywordProtection.count({ where: { mode: 'WHITELIST' } })
  // BP.P1 — op-aware ceiling: a builder Bid rule whose THEN sets/raises/lowers a bid produces
  // only `bid_apply` and may reach AUTO; one whose THEN pauses produces `pause_target` and
  // stays capped. Judged by the translation's own output, never by the slug's full repertoire.
  const { producedActionTypes } = await import('./ads-rule-adapter.service.js')
  const ceiling = graduationCeiling({
    actionTypes: producedActionTypes(rule),
    hasKeywordProtections: protectionCount > 0,
  })
  // The ceiling is not overridable from here. A structural rule stays gated because of
  // what it does, not because of how much evidence has accumulated.
  if (!isLevelAllowed(level, ceiling.maxLevel)) {
    return refused(409, { ok: false, error: 'above_ceiling', maxLevel: ceiling.maxLevel, message: ceiling.reason, blockedBy: ceiling.blockedBy })
  }

  /**
   * D-PLC-2 — a Placement rule may not be armed to AUTO against the rank engine.
   *
   * Not a ceiling: the ceiling judges what a rule DOES, and this judges who else is already
   * writing the same field on the same campaigns. `ad-rank-defend` made 7,818 lane writes across
   * 34 campaigns in 7 days, so on Auto such a rule sets a modifier and has it reverted within the
   * hour, forever. Refused with the same 409 shape the ceiling uses, so the grid renders it
   * through the path it already has (`message`).
   *
   * 🔴 Product Pages is exempt — the engine wrote it twice in 30 days against 12,197 on Top of
   * Search. Blocking that lane would forbid the one placement automation that works on the
   * governed half of the account. See `ads-placement-autonomy.ts`.
   */
  const { checkPlacementAutoAllowed } = await import('./ads-placement-autonomy.js')
  const placementVerdict = await checkPlacementAutoAllowed(rule, level, producedActionTypes(rule))
  if (placementVerdict.blocked) {
    return refused(409, { ok: false, error: 'contested_by_rank_engine', maxLevel: 'PROPOSE', message: placementVerdict.message, blockedBy: placementVerdict.lanes })
  }

  /**
   * D-R1 (Owner, 2026-10-01; MCP full control part 06) — AUTO only after the graduation gate, then a person's click.
   * The dial used to skip the evidence the graduate route requires (14 days watched, 10 real runs, 1 match, a live
   * production connection): two roads to AUTO, one without the gate (gap 8). Both roads now check the same gate.
   */
  if (level === 'AUTO') {
    const current = await prisma.automationRule.findUnique({ where: { id }, select: { autonomyLevel: true, enabled: true, dryRun: true } })
    const { resolveAutonomy } = await import('./ads-autonomy.js')
    if (current && resolveAutonomy(current) !== 'AUTO') {
      const gate = await adsRuleGateStatus(id)
      if (!isRefused(gate) && !gate.value.gateOpen) {
        return refused(409, {
          ok: false, error: 'gate_not_open', maxLevel: 'PROPOSE',
          failures: gate.value.checks.filter((c) => !c.passed).map((c) => c.id),
          message: `AUTO only after the graduation gate: ${gate.value.checks.filter((c) => !c.passed).map((c) => c.detail).join('; ')}.`,
        })
      }
    }
  }

  return done({ id: rule.id, name: rule.name })
}
