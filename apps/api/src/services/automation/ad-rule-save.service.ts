/**
 * R9 (MCP full control, part 06 §3) — saving an ads rule for Claude: an Amazon ads rule, an eBay ads rule or a
 * marketing campaign rule, new or edited, through the rules' own services (R4) and their audit rows.
 *
 *   · born OBSERVE: a new Amazon or marketing rule runs and records, proposes nothing and writes nothing. eBay rules
 *     have no observe mode, so a new one is saved switched off (OFF). Up the ladder is turn-up-automation (R10), one
 *     step per request, and AUTO only through the graduation gate and a person's click (D-R1).
 *   · the rule guard (automation-rule-guard.ts) refuses, in words: a pause or any action Claude may not automate,
 *     a missing scope, a cap that is missing or 0, a percent written where a fraction belongs, a condition on a field
 *     the trigger never hands the rule, an empty condition list.
 *   · an edit of an AUTO rule drops it to PROPOSE (eBay: AUTOPILOT → PROPOSE): a changed rule earns AUTO again.
 *   · the plan names the rule's settings and level (`basis`, row-basis.ts), so an approval is refused when someone changed
 *     the rule since — never because its evaluator ran (it moves `updatedAt` every 15 minutes).
 *
 * `planAdRuleSave` is the dry run (a pure read); `applyAdRuleSave` writes. Nothing here reaches a marketplace: a rule
 * acts only once a person turns it up.
 */
import prisma from '../../db.js'
import { auditLogService } from '../audit-log.service.js'
import { resolveAutonomy } from '../advertising/ads-autonomy.js'
import { guardRule, type RuleCaps, type RuleDraft, type RuleKind, type RuleScope } from './automation-rule-guard.js'
import { isRefused } from './service-outcome.js'
import { basisOf } from './row-basis.js'
import type { AutomationLevel } from './automation-levels.js'

/** A saved rule as save-ad-rule reads it, and as its undo puts it back (the tool's own arguments). */
export interface SavedRuleConfig {
  kind: RuleKind
  ruleId: string
  name: string
  description?: string | null
  trigger: unknown
  conditions?: unknown[]
  actions?: unknown[]
  action?: unknown
  guardrails?: unknown
  scope: RuleScope
  caps?: RuleCaps
  cooldownHours?: number
}

/** What save-ad-rule is asked: a new rule (no ruleId) or changes to one. Absent fields keep the rule's own. */
export interface SaveRuleInput {
  kind: RuleKind
  ruleId?: string
  name?: string
  description?: string | null
  trigger?: unknown
  conditions?: unknown[]
  actions?: unknown[]
  action?: unknown
  guardrails?: unknown
  /** Replaces the rule's scope when given. */
  scope?: RuleScope
  /** Merged into the rule's caps. */
  caps?: RuleCaps
  cooldownHours?: number
}

export interface SavePlan {
  action: 'save-ad-rule'
  kind: RuleKind
  mode: 'create' | 'edit'
  ruleId: string | null
  name: string
  /** field → { from, to }: what the save changes (a new rule: from nothing). */
  changes: Record<string, { from: unknown; to: unknown }>
  level: { from: AutomationLevel | null; to: AutomationLevel; says: string }
  scope: RuleScope
  reach: { campaigns: number; total: number; applied: string[] } | null
  /**
   * The rule's settings and level the plan was made from (a fingerprint, row-basis.ts); an approval runs only while they
   * are unchanged. Not its `updatedAt`: the rule evaluator moves that on every tick.
   */
  basis: string | null
  effect: string
  config: Omit<SavedRuleConfig, 'ruleId'> & { ruleId: string | null }
}

export type PlanAnswer = { ok: true; plan: SavePlan; before: SavedRuleConfig | null } | { ok: false; error: string }

const DOMAIN: Record<Exclude<RuleKind, 'ebay-ads'>, string> = { 'amazon-ads': 'advertising', marketing: 'marketing' }
const KIND_NAME: Record<RuleKind, string> = { 'amazon-ads': 'Amazon ads rule', 'ebay-ads': 'eBay ads rule', marketing: 'marketing rule' }


function scopeOfRule(r: { scopeMarketplace: string | null; scopePortfolioId?: string | null; scopeCampaignId?: string | null; scopeProductId?: string | null }): RuleScope {
  const s: RuleScope = {}
  if (r.scopeMarketplace) s.marketplace = r.scopeMarketplace
  if (r.scopePortfolioId) s.portfolioId = r.scopePortfolioId
  if (r.scopeCampaignId) s.campaignId = r.scopeCampaignId
  if (r.scopeProductId) s.productId = r.scopeProductId
  return Object.keys(s).length ? s : { wholeAccount: true }
}

/** The rule as it is stored now, in save-ad-rule's shape; null when it is not a rule of that kind in this business. */
export async function readRuleConfig(kind: RuleKind, ruleId: string): Promise<{ config: SavedRuleConfig; level: AutomationLevel; updatedAt: Date } | null> {
  if (kind === 'ebay-ads') {
    const { ebayRuleForSave } = await import('../marketing/ebay-ads-rule-crud.service.js')
    const r = await ebayRuleForSave(ruleId)
    if (!r) return null
    const scope: RuleScope = r.marketplace || r.campaignIds?.length
      ? { ...(r.marketplace ? { marketplace: r.marketplace } : {}), ...(r.campaignIds?.length ? { campaignIds: r.campaignIds } : {}) }
      : { wholeAccount: true }
    return {
      config: { kind, ruleId: r.id, name: r.name, trigger: r.trigger, action: r.action, guardrails: r.guardrails ?? null, scope, cooldownHours: r.cooldownHours },
      level: !r.enabled ? 'OFF' : r.mode === 'AUTOPILOT' ? 'AUTO' : 'PROPOSE',
      updatedAt: r.updatedAt,
    }
  }
  const r = await prisma.automationRule.findFirst({ where: { id: ruleId, domain: DOMAIN[kind] } })
  if (!r) return null
  return {
    config: {
      kind, ruleId: r.id, name: r.name, description: r.description, trigger: r.trigger,
      conditions: Array.isArray(r.conditions) ? (r.conditions as unknown[]) : [], actions: Array.isArray(r.actions) ? (r.actions as unknown[]) : [],
      scope: scopeOfRule(r),
      caps: { maxExecutionsPerDay: r.maxExecutionsPerDay, maxWritesPerDay: r.maxWritesPerDay, maxValueCentsEur: r.maxValueCentsEur, maxDailyAdSpendCentsEur: r.maxDailyAdSpendCentsEur },
    },
    level: resolveAutonomy(r),
    updatedAt: r.updatedAt,
  }
}

/** The fields save-ad-rule compares and shows, in order. */
const FIELDS = ['name', 'description', 'trigger', 'conditions', 'actions', 'action', 'guardrails', 'scope', 'caps', 'cooldownHours'] as const

function diff(before: Partial<SavedRuleConfig> | null, after: Partial<SavedRuleConfig>): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {}
  for (const key of FIELDS) {
    if (!(key in after)) continue
    const from = before ? (before as Record<string, unknown>)[key] ?? null : null
    const to = (after as Record<string, unknown>)[key] ?? null
    if (JSON.stringify(from) !== JSON.stringify(to)) out[key] = { from, to }
  }
  return out
}

/** Amazon scope ids that exist here, and the campaigns the scope reaches (the evaluator's own reach). */
async function amazonReach(scope: RuleScope): Promise<{ ok: true; reach: SavePlan['reach'] } | { ok: false; error: string }> {
  if (scope.campaignId && !(await prisma.campaign.findUnique({ where: { id: scope.campaignId }, select: { id: true } }))) return { ok: false, error: `scope.campaignId ${scope.campaignId}: not found in this business` }
  if (scope.portfolioId && !(await prisma.amazonAdsPortfolio.findFirst({ where: { externalPortfolioId: scope.portfolioId }, select: { id: true } }))) return { ok: false, error: `scope.portfolioId ${scope.portfolioId}: not found in this business` }
  if (scope.productId && !(await prisma.product.findUnique({ where: { id: scope.productId }, select: { id: true } }))) return { ok: false, error: `scope.productId ${scope.productId}: not found in this business` }
  if (scope.marketplace && !(await prisma.campaign.findFirst({ where: { marketplace: scope.marketplace }, select: { id: true } }))) return { ok: false, error: `scope.marketplace ${scope.marketplace}: no campaign of this business is in that market` }
  const { resolveScopeReach } = await import('../advertising/ads-scope-reach.js')
  const reach = await resolveScopeReach({ marketplace: scope.marketplace ?? null, portfolioId: scope.portfolioId ?? null, campaignId: scope.campaignId ?? null, productId: scope.productId ?? null })
  if (reach.contradiction) return { ok: false, error: `scope matches no campaign: ${reach.contradiction}` }
  return { ok: true, reach: { campaigns: reach.campaignIds.length, total: reach.total, applied: reach.applied } }
}

/** The dry run: everything the save would do, checked, and nothing written. */
export async function planAdRuleSave(input: SaveRuleInput): Promise<PlanAnswer> {
  const existing = input.ruleId ? await readRuleConfig(input.kind, input.ruleId) : null
  if (input.ruleId && !existing) return { ok: false, error: `There is no ${KIND_NAME[input.kind]} ${input.ruleId} in this business (not found).` }
  const base: Partial<SavedRuleConfig> = existing?.config ?? {}
  const pick = <K extends keyof SaveRuleInput>(key: K) => (input[key] !== undefined ? input[key] : (base as Record<string, unknown>)[key])
  const merged: Omit<SavedRuleConfig, 'ruleId'> = input.kind === 'ebay-ads'
    ? {
      kind: input.kind, name: String(pick('name') ?? '').trim(), trigger: pick('trigger'), action: pick('action'),
      guardrails: pick('guardrails') ?? null, scope: (input.scope ?? base.scope ?? {}) as RuleScope,
      cooldownHours: (pick('cooldownHours') as number | undefined) ?? 24,
    }
    : {
      kind: input.kind, name: String(pick('name') ?? '').trim(), description: (pick('description') as string | null | undefined) ?? null,
      trigger: pick('trigger'), conditions: pick('conditions') as unknown[] | undefined, actions: pick('actions') as unknown[] | undefined,
      scope: (input.scope ?? base.scope ?? {}) as RuleScope,
      caps: { ...(base.caps ?? {}), ...(input.caps ?? {}) },
    }

  const draft: RuleDraft = { kind: input.kind, name: merged.name, trigger: merged.trigger, conditions: merged.conditions, actions: merged.actions, action: merged.action, guardrails: merged.guardrails, scope: merged.scope, caps: merged.caps }
  const problems = guardRule(draft)
  if (input.kind === 'ebay-ads') {
    const { ebayRuleProblems } = await import('../marketing/ebay-ads-rule-crud.service.js')
    problems.push(...(await ebayRuleProblems({
      name: merged.name, trigger: merged.trigger as never, action: merged.action as never, guardrails: merged.guardrails as never,
      scope: merged.scope.campaignIds?.length ? { campaignIds: merged.scope.campaignIds } : null, marketplace: merged.scope.marketplace ?? null, cooldownHours: merged.cooldownHours,
    })).filter((p) => !problems.includes(p)))
  }
  const label = existing ? `${existing.config.name}: ` : ''
  if (problems.length) return { ok: false, error: `${label}Not saved — ${problems.join('; ')}.` }

  const changes = diff(existing?.config ?? null, merged)
  if (existing && !Object.keys(changes).length) return { ok: false, error: `${existing.config.name}: nothing to change — every field given is what the rule already holds.` }

  let reach: SavePlan['reach'] = null
  if (input.kind === 'amazon-ads') {
    const r = await amazonReach(merged.scope)
    if ('error' in r) return { ok: false, error: `${label}Not saved — ${r.error}.` }
    reach = r.reach
  }

  const from = existing?.level ?? null
  const to: AutomationLevel = !existing
    ? (input.kind === 'ebay-ads' ? 'OFF' : 'OBSERVE')
    : from === 'AUTO' ? 'PROPOSE' : (from ?? 'OFF')
  const says = !existing
    ? input.kind === 'ebay-ads'
      ? 'A new eBay rule is saved switched off (eBay rules have no observe mode); turn it up when you trust it.'
      : 'A new rule is born OBSERVE: it runs and records, proposes nothing and writes nothing.'
    : from === 'AUTO'
      ? 'The rule is AUTO: an edit drops it to PROPOSE, so a changed rule proposes before it acts again.'
      : `The rule stays at ${to}.`
  const reachText = reach ? ` It reaches ${reach.campaigns} of ${reach.total} campaigns${merged.scope.wholeAccount ? ' (the whole account)' : ''}.` : ''
  const plan: SavePlan = {
    action: 'save-ad-rule',
    kind: input.kind,
    mode: existing ? 'edit' : 'create',
    ruleId: existing?.config.ruleId ?? null,
    name: merged.name,
    changes,
    level: { from, to, says },
    scope: merged.scope,
    reach,
    basis: existing ? `rule:${basisOf({ config: existing.config, level: existing.level })}` : null,
    effect: `${existing ? 'Changes' : 'Creates'} the ${KIND_NAME[input.kind]} "${merged.name}". ${says}${reachText} Nothing reaches a marketplace from this save.`,
    config: { ...merged, ruleId: existing?.config.ruleId ?? null },
  }
  return { ok: true, plan, before: existing?.config ?? null }
}

/** The write: the plan again (it must still pass), then the rule's own service. Returns what it replaced and wrote. */
export async function applyAdRuleSave(input: SaveRuleInput, actorUserId: string | null): Promise<{ ok: true; ruleId: string; before: SavedRuleConfig | null; after: SavedRuleConfig; level: AutomationLevel } | { ok: false; error: string }> {
  const planned = await planAdRuleSave(input)
  if ('error' in planned) return { ok: false, error: planned.error }
  const { plan } = planned
  const c = plan.config
  const scope = c.scope
  const note = 'saved by Claude through save-ad-rule'
  let ruleId: string
  if (input.kind === 'amazon-ads') {
    const crud = await import('../advertising/ads-rule-crud.service.js')
    const actor = `user:${actorUserId ?? 'anonymous'}` as never
    const caps = c.caps ?? {}
    const extra = {
      scopePortfolioId: scope.portfolioId ?? null, scopeCampaignId: scope.campaignId ?? null, scopeProductId: scope.productId ?? null, note,
      ...(plan.mode === 'create' ? { enabled: true, dryRun: true, autonomyLevel: 'OBSERVE' as const } : {}),
      ...(plan.mode === 'edit' && plan.level.from === 'AUTO' ? { autonomyLevel: 'PROPOSE' as const, dryRun: true } : {}),
      ...(plan.mode === 'edit' && plan.changes.trigger ? { trigger: String(c.trigger) } : {}),
    }
    const out = plan.mode === 'create'
      ? await crud.createAdsRule({
        name: c.name, description: c.description ?? undefined, trigger: String(c.trigger), conditions: c.conditions as object[], actions: c.actions as object[],
        maxExecutionsPerDay: caps.maxExecutionsPerDay ?? undefined, maxValueCentsEur: caps.maxValueCentsEur ?? undefined,
        maxDailyAdSpendCentsEur: caps.maxDailyAdSpendCentsEur ?? undefined, maxWritesPerDay: caps.maxWritesPerDay ?? undefined,
        scopeMarketplace: scope.marketplace ?? undefined,
      }, actor, extra)
      : await crud.updateAdsRule(plan.ruleId!, {
        ...(plan.changes.name ? { name: c.name } : {}),
        ...(plan.changes.description ? { description: c.description ?? null } : {}),
        ...(plan.changes.conditions ? { conditions: c.conditions as object[] } : {}),
        ...(plan.changes.actions ? { actions: c.actions as object[] } : {}),
        ...(plan.changes.caps ? { maxExecutionsPerDay: caps.maxExecutionsPerDay ?? null, maxValueCentsEur: caps.maxValueCentsEur ?? null, maxDailyAdSpendCentsEur: caps.maxDailyAdSpendCentsEur ?? null, maxWritesPerDay: caps.maxWritesPerDay ?? null } : {}),
        ...(plan.changes.scope ? { scopeMarketplace: scope.marketplace ?? null } : {}),
      }, actor, plan.changes.scope ? extra : { note, ...(extra.autonomyLevel ? { autonomyLevel: extra.autonomyLevel, dryRun: true } : {}), ...(extra.trigger ? { trigger: extra.trigger } : {}) })
    if (isRefused(out)) return { ok: false, error: `Not saved — ${String(out.body.message ?? out.body.error)}` }
    ruleId = out.value.rule.id
  } else if (input.kind === 'marketing') {
    const caps = c.caps ?? {}
    const data = {
      name: c.name, description: c.description ?? null, trigger: String(c.trigger), conditions: c.conditions as object, actions: c.actions as object,
      scopeMarketplace: scope.marketplace ?? null,
      maxExecutionsPerDay: caps.maxExecutionsPerDay ?? null, maxWritesPerDay: caps.maxWritesPerDay ?? null,
      maxValueCentsEur: caps.maxValueCentsEur ?? null, maxDailyAdSpendCentsEur: caps.maxDailyAdSpendCentsEur ?? null,
    }
    const rule = plan.mode === 'create'
      ? await prisma.automationRule.create({ data: { ...data, domain: 'marketing', enabled: true, dryRun: true, autonomyLevel: 'OBSERVE', createdBy: actorUserId ? `user:${actorUserId}` : 'claude' } })
      : await prisma.automationRule.update({ where: { id: plan.ruleId! }, data: { ...data, ...(plan.level.from === 'AUTO' ? { autonomyLevel: 'PROPOSE', dryRun: true } : {}) } })
    ruleId = rule.id
    await auditLogService.write({ userId: actorUserId, entityType: 'AutomationRule', entityId: rule.id, action: plan.mode === 'create' ? 'create' : 'update', before: planned.before, after: c, metadata: { domain: 'marketing', note } })
  } else {
    const crud = await import('../marketing/ebay-ads-rule-crud.service.js')
    const body = {
      name: c.name, trigger: c.trigger, action: c.action, guardrails: c.guardrails ?? undefined,
      scope: scope.campaignIds?.length ? { campaignIds: scope.campaignIds } : null, marketplace: scope.marketplace ?? null, cooldownHours: c.cooldownHours,
    }
    const out = plan.mode === 'create'
      ? await crud.createEbayAdsRule(body, actorUserId)
      : await crud.updateEbayAdsRule(plan.ruleId!, { ...body, ...(plan.level.from === 'AUTO' ? { mode: 'PROPOSE' as const } : {}) }, actorUserId)
    if (isRefused(out)) return { ok: false, error: `Not saved — ${String(out.body.error)}` }
    ruleId = out.value.id
  }
  const after = await readRuleConfig(input.kind, ruleId)
  return { ok: true, ruleId, before: planned.before, after: after!.config, level: after!.level }
}
