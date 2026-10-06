/**
 * ADS AUTONOMY W2 (AA-W2-11, Owner decision D-W2-4 = A) — what Claude's rule may do with the automations themselves
 * (design: agent-results/5 §3a rows save-ad-rule / tune-ad-engine / turn-up-automation, §6):
 *
 *   turn-up-automation  up to the level the business's limits allow (`maxLevel`, PROPOSE by default). AUTO only for an
 *                       automation the business lists (`automations`, empty by default) and only once its graduation
 *                       gate is open — the evidence the switch reads for the row (LevelSwitch.gateEvidence: 14 days, 10
 *                       runs, 1 match or decision). A rule going to AUTO acts as itself, held by its own caps: they must
 *                       be set and inside these limits. The ads dial, an engine the server env switches and a kind with
 *                       no gate Nexus can check stay a person's click. A person's own click is held by the switch's own
 *                       refusal, as before: none of this binds him.
 *   save-ad-rule        strategy-bound: an Amazon ads rule saved by rule lands in the ads strategy of its scope (the
 *                       kit's checks; a rule for the whole account cannot be placed) and carries every cap, each above 0
 *                       and inside these limits (0 by default: every rule waits for a person). A new rule is born
 *                       OBSERVE and an edit never raises its level, so a save by rule acts on nothing by itself.
 *   tune-ad-engine      a change that can raise spend runs by rule only when every raise is one value rising by a
 *                       percent (`largestRaisePct`) within `maxRaisePct` (0 by default); a raise with no percent — a
 *                       cleared cap, a new strategy, a window, a looser harvest, a breaker that trips later — waits.
 *   strategy            turn-up-automation and tune-ad-engine are the strategy's `automation` kind (fields.ts), so both
 *                       are strategy-bound: judged by the kit where the automation acts (automation-scope.ts: its
 *                       products, else its market). One for the whole account, or across markets, waits for a person;
 *                       one outside Amazon ads (eBay, marketing, operations) is not the strategy's to judge.
 *
 * Every check is pure: what it needs is in the preview the dry run stored.
 */
import { z } from 'zod'
import { LEVELS, type AutomationLevel, type GateEvidence } from '../../automation/automation-levels.js'
import type { RuleCaps, RuleScope } from '../../automation/automation-rule-guard.js'
import { adKitLimits, buildLimitFacts, commonRefusal, limitFactsOf, type KitItem, type LimitFacts } from './ads-autonomy-kit.js'
import type { AdEntityRef } from '../../advertising/ads-strategy/autonomy.js'
import { automationEntity, type AutomationScope } from '../../advertising/ads-strategy/automation-scope.js'

const A_PERSON = 'a person decides'
type Limits = Record<string, unknown>
const numberIn = (limits: Limits, key: string) => (typeof limits[key] === 'number' ? (limits[key] as number) : 0)
const rank = (level: AutomationLevel) => LEVELS.indexOf(level)

// ── where an automation move lands (turn-up-automation, tune-ad-engine) ─────────────────────────────────────

/** Where an automation move lands, as its preview stores it: placed in one market, outside the strategy, or not placed. */
export interface AutomationScopeFacts { placed: boolean; outside: boolean; why: string | null }

/** The kit's facts of an automation move where it acts, and where that is. `exceptIds`: the automation itself (C4). */
export async function automationFacts(scope: AutomationScope, tool: string, approvalId?: string | null, exceptIds: readonly string[] = []): Promise<{ limitFacts: LimitFacts; automationScope: AutomationScopeFacts }> {
  const entity = await automationEntity(scope)
  const items: KitItem[] = entity ? [{ entity, change: { field: 'automation' }, nexusOnly: true }] : []
  return {
    limitFacts: await buildLimitFacts({ tool, items, approvalId, exceptIds }),
    automationScope: 'outside' in scope ? { placed: true, outside: true, why: scope.why } : 'unplaced' in scope ? { placed: false, outside: false, why: scope.unplaced } : { placed: true, outside: false, why: null },
  }
}

/** A move the strategy cannot place waits for a person; then the kit's checks. Null when both pass. Pure. */
function scopeAndCommonRefusal(preview: unknown, limits: Limits): string | null {
  const scope = (preview as { automationScope?: AutomationScopeFacts } | null)?.automationScope
  if (scope && !scope.placed) return `${scope.why}; ${A_PERSON}`
  return commonRefusal(preview, limits)
}

// ── turn-up-automation ────────────────────────────────────────────────────────────────────────────────────────

export const TURN_UP_LIMITS = adKitLimits({ maxItems: 1 }, {
  maxLevel: z.enum(['OBSERVE', 'PROPOSE', 'AUTO']).default('PROPOSE')
    .describe('the highest level Claude may turn an automation up to without a person; AUTO also needs the automation on `automations` and its graduation gate open'),
  automations: z.array(z.string().trim().min(1).max(64)).max(64).default([])
    .describe('the automations Claude may take to AUTO without a person once their graduation gate is open — their number from list-automations (A1 … N17) or key; empty = none'),
  maxRuleWritesPerDay: z.number().int().min(0).max(1_000_000).default(0)
    .describe('a rule taken to AUTO without a person must have a daily writes cap of its own, at most this; 0 = no rule goes to AUTO without a person'),
  maxRuleValueCentsEur: z.number().int().min(0).max(1_000_000_000).default(0)
    .describe('a rule taken to AUTO without a person must have a cap on what one run may commit (euro cents), at most this; 0 = no rule goes to AUTO without a person'),
})

/** What turn-up-automation's preview carries (automation-switch.service.ts SwitchPlan). */
interface SwitchPreview {
  to?: AutomationLevel
  env?: unknown
  automation?: { id: string; key: string; name: string }
  row?: { name: string }
  gate?: GateEvidence | null
}

/** Is this move up inside the business's limits for Claude's rule? Null when it is, else the sentence. Pure. */
export function turnUpRefusal(preview: unknown, limits: Limits): string | null {
  const p = preview as SwitchPreview | null
  if (!p?.to) return 'there is no preview of this move to check'
  // R16 / D-R2, D-W2-4 — an engine the server env switches goes up only with a person's click.
  if (p.env) return 'an engine switched up is never inside the limits: a person clicks it'
  const placed = scopeAndCommonRefusal(preview, limits)
  if (placed) return placed
  const max = (LEVELS as readonly string[]).includes(String(limits.maxLevel)) ? (limits.maxLevel as AutomationLevel) : 'PROPOSE'
  if (rank(p.to) > rank(max)) return `${p.to} is above ${max}, the highest level allowed without a person`
  if (p.to !== 'AUTO') return null
  const name = p.row?.name ?? p.automation?.name ?? 'this automation'
  const listed = Array.isArray(limits.automations) ? (limits.automations as string[]) : []
  const who = p.automation
  if (!who || !listed.some((key) => key === who.id || key === who.key)) {
    return `${who?.name ?? name} is not on the automations Claude may take to AUTO without a person (automations): a person clicks it`
  }
  if (!p.gate) return `${name} has no graduation gate Nexus can check (${who.name}), so AUTO stays a person's click`
  if (!p.gate.open) {
    const missing = p.gate.checks.filter((c) => !c.passed).map((c) => `${c.check}: ${c.detail}`)
    return `the graduation gate of ${name} is not open (${missing.join('; ') || 'not all checks pass'}; from ${p.gate.from}); ${A_PERSON}`
  }
  if (p.gate.caps) {
    const caps = p.gate.caps
    const capped = (value: number | null, limit: string, words: string, unit: string) => {
      const allowed = numberIn(limits, limit)
      if (value == null || value <= 0) return `${name} has no ${words} of its own: a rule goes to AUTO without a person only with every cap set; ${A_PERSON}`
      return value > allowed ? `${name} may make up to ${value} ${unit}, more than the ${allowed} this tool's limits allow a rule taken to AUTO without a person${allowed === 0 ? ' (0: none goes without a person)' : ''}; ${A_PERSON}` : null
    }
    return capped(caps.maxWritesPerDay, 'maxRuleWritesPerDay', 'daily writes cap', 'writes a day')
      ?? capped(caps.maxValueCentsEur, 'maxRuleValueCentsEur', 'cap on what one run may commit', 'euro cents in one run')
  }
  return null
}

// ── save-ad-rule ──────────────────────────────────────────────────────────────────────────────────────────────

export const SAVE_RULE_LIMITS = adKitLimits({ maxItems: 1 }, {
  maxWritesPerDay: z.number().int().min(0).max(1_000_000).default(0)
    .describe('a rule saved without a person: the highest daily writes cap it may carry; 0 = every rule waits for a person'),
  maxValueCentsEur: z.number().int().min(0).max(1_000_000_000).default(0)
    .describe('a rule saved without a person: the highest cap on what one run may commit, in euro cents; 0 = every rule waits for a person'),
  maxDailyAdSpendCentsEur: z.number().int().min(0).max(1_000_000_000).default(0)
    .describe('a rule saved without a person: the highest daily ad spend cap it may carry, in euro cents; 0 = every rule waits for a person'),
})

/** What a save by rule is judged on, beyond the kit's facts: the scope placed, the caps, the level after the save. */
export interface RuleSaveFacts {
  scope: { placed: boolean; why: string | null }
  caps: { maxWritesPerDay: number | null; maxValueCentsEur: number | null; maxDailyAdSpendCentsEur: number | null }
  levelAfter: AutomationLevel
}

/** Where an Amazon ads rule's scope lands in the ads strategy (one item), or why it cannot be placed. Pure. */
export function ruleScopeItem(scope: RuleScope): { item: KitItem } | { why: string } {
  const market = scope.marketplace?.trim().toUpperCase() || null
  let entity: AdEntityRef
  if (scope.wholeAccount) return { why: 'a rule for the whole account cannot be placed in one market\'s ads strategy' }
  if (scope.campaignId) entity = { kind: 'campaign', id: scope.campaignId }
  else if (scope.productId) {
    if (!market) return { why: 'a rule for a product names no market, so Nexus cannot tell which ads strategy covers it' }
    entity = { kind: 'products', market, productIds: [scope.productId], label: 'a rule for one product' }
  } else if (market) entity = { kind: 'products', market, productIds: [], label: scope.portfolioId ? `a rule for a portfolio in ${market}` : `a rule for the whole of ${market}` }
  else return { why: 'a rule whose scope names no market, campaign or product cannot be placed in an ads strategy' }
  return { item: { entity, change: { field: 'automation' }, nexusOnly: true } }
}

/** The facts an Amazon save-ad-rule preview stores for its rule: the kit's for its scope, and its caps and level. */
export async function ruleSaveFacts(plan: { kind: string; ruleId: string | null; scope: RuleScope; caps?: RuleCaps; level: { to: AutomationLevel } }, approvalId?: string | null): Promise<{ limitFacts: LimitFacts; ruleFacts: RuleSaveFacts } | Record<string, never>> {
  if (plan.kind !== 'amazon-ads') return {}
  const placed = ruleScopeItem(plan.scope)
  const limitFacts = await buildLimitFacts({
    tool: 'save-ad-rule', items: 'item' in placed ? [placed.item] : [], approvalId,
    // The rule being edited is not an engine that also moves its own scope.
    exceptIds: plan.ruleId ? [plan.ruleId] : [],
  })
  const caps = plan.caps ?? {}
  return {
    limitFacts,
    ruleFacts: {
      scope: 'item' in placed ? { placed: true, why: null } : { placed: false, why: placed.why },
      caps: { maxWritesPerDay: caps.maxWritesPerDay ?? null, maxValueCentsEur: caps.maxValueCentsEur ?? null, maxDailyAdSpendCentsEur: caps.maxDailyAdSpendCentsEur ?? null },
      levelAfter: plan.level.to,
    },
  }
}

const CAP_WORDS: Record<keyof RuleSaveFacts['caps'], string> = {
  maxWritesPerDay: 'daily writes cap',
  maxValueCentsEur: 'cap on what one run may commit (euro cents)',
  maxDailyAdSpendCentsEur: 'daily ad spend cap (euro cents)',
}

/** Is this save-ad-rule preview inside the business's rule? Null when it is, else the sentence. Pure. */
export function ruleSaveRefusal(preview: unknown, limits: Limits): string | null {
  const p = preview as { kind?: unknown; ruleFacts?: RuleSaveFacts } | null
  if (p?.kind && p.kind !== 'amazon-ads') return `only an Amazon ads rule may be saved by rule (the ads strategy covers Amazon); ${A_PERSON}`
  if (p?.ruleFacts && !p.ruleFacts.scope.placed) return `${p.ruleFacts.scope.why}; ${A_PERSON}`
  const common = commonRefusal(preview, limits)
  if (common) return common
  const f = p?.ruleFacts
  if (!f) return `there are no rule facts in this preview; ${A_PERSON}`
  if (f.levelAfter === 'AUTO') return `a save by rule never leaves a rule at AUTO; ${A_PERSON}`
  for (const key of Object.keys(CAP_WORDS) as Array<keyof RuleSaveFacts['caps']>) {
    const value = f.caps[key]
    const allowed = numberIn(limits, key)
    if (value == null || value <= 0) return `the rule has no ${CAP_WORDS[key]}: a rule saved without a person carries every cap; ${A_PERSON}`
    if (value > allowed) return `its ${CAP_WORDS[key]} is ${value}, more than the ${allowed} this tool's limits allow a rule saved without a person${allowed === 0 ? ' (0: every rule waits for a person)' : ''}; ${A_PERSON}`
  }
  return null
}

// ── tune-ad-engine ────────────────────────────────────────────────────────────────────────────────────────────

export const TUNE_LIMITS = adKitLimits({ maxItems: 1 }, {
  maxRaisePct: z.number().min(0).max(1000).default(0)
    .describe('the largest raise, in percent of the value before, a setting change may make without a person (a higher budget, cap or target ACOS); 0 = every change that can raise spend waits for a person. A raise with no percent (a cleared cap, a new strategy, a window, a looser harvest, a breaker that trips later) always waits'),
})

/** Is this tune-ad-engine preview inside the business's rule? Null when it is, else the sentence. Pure. */
export function tuneRefusal(preview: unknown, limits: Limits): string | null {
  const p = preview as { raises?: unknown; largestRaisePct?: number | null } | null
  if (!p || !Array.isArray(p.raises)) return 'there is no preview of this setting change to check'
  if (!p.raises.length) {
    // A change that cannot raise spend tightens: one for the whole account is not held to one market's strategy (the
    // door already holds it to the strictest level the business's strategy sets for automations).
    const scope = (preview as { automationScope?: AutomationScopeFacts }).automationScope
    if (scope && !scope.placed) return limitFactsOf(preview) ? null : commonRefusal(preview, limits)
    return commonRefusal(preview, limits)
  }
  const placed = scopeAndCommonRefusal(preview, limits)
  if (placed) return placed
  const raises = (p.raises as string[]).join('; ')
  if (typeof p.largestRaisePct !== 'number') return `it can raise spend in a way that has no percent (${raises}); ${A_PERSON}`
  const max = numberIn(limits, 'maxRaisePct')
  return p.largestRaisePct > max
    ? `it can raise spend by up to ${p.largestRaisePct} % (${raises}), more than the ${max} % this tool's limits let run without a person${max === 0 ? ' (0: every raise waits for a person)' : ''}; ${A_PERSON}`
    : null
}
