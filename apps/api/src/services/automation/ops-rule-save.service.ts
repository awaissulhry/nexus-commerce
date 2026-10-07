/**
 * R18 (MCP full control, part 06 §3) — save-ops-rule: Claude creates or edits an operations rule — listing, replenishment,
 * review or bulk-operation — in one service, with each domain's own triggers, actions and permission.
 *
 *   domain            automation  triggers                         actions Claude may give it              born
 *   listings          N5          LISTING_TRIGGERS                 price / stock sync, translate           OBSERVE (and never scheduled)
 *   replenishment     N6          recommendation, stockout, …      approve a recommendation, draft a PO    OBSERVE
 *   reviews           N7          REVIEW_SPIKE_DETECTED            bullets / A+ ideas from reviews         OFF (its actions call the AI even dry)
 *   bulk-operations   N9          BULK_OPS_TRIGGERS                apply a template, create a bulk job     OBSERVE
 *
 * Every domain also allows notify and log_only. Refused, in words: a pausing action (a rule Claude saves never pauses; a
 * person sets that in Nexus), an action or trigger outside the domain's own list, no conditions (an empty list matches everything),
 * no daily run cap, and — for replenishment, whose actions commit money — no value cap. An AUTO rule's edit drops it to
 * PROPOSE. No delete: OFF is how a rule is retired (turn-down-automation).
 */
import prisma from '../../db.js'
import { FEATURES } from '@nexus/shared/permissions'
import type { ToolPermission } from '../agents/tool-types.js'
import { resolveAutonomy } from '../advertising/ads-autonomy.js'
import { ruleBasis } from './row-basis.js'
import { validateConditions, type ConditionsPayload } from './conditions-tree.js'
import { BULK_OPS_ACTION_TYPES, BULK_OPS_TRIGGERS } from './bulk-ops-actions.js'
import { LISTING_ACTION_TYPES, LISTING_TRIGGERS } from '../listing-automation/triggers.js'

export const OPS_DOMAINS = ['listings', 'replenishment', 'reviews', 'bulk-operations'] as const
export type OpsDomain = (typeof OPS_DOMAINS)[number]
type Level = 'OFF' | 'OBSERVE' | 'PROPOSE' | 'AUTO'

export interface OpsDomainSpec {
  automation: 'N5' | 'N6' | 'N7' | 'N9'
  name: string
  manage: ToolPermission
  triggers: readonly string[]
  actions: readonly string[]
  born: Level
  bornWhy: string
  needsValueCap: boolean
}

const BUILTIN_ACTIONS = ['notify', 'log_only']

export const OPS_DOMAIN_SPECS: Record<OpsDomain, OpsDomainSpec> = {
  listings: {
    automation: 'N5', name: 'listing rule', manage: FEATURES.listingsEdit, triggers: LISTING_TRIGGERS, actions: LISTING_ACTION_TYPES,
    born: 'OBSERVE', bornWhy: 'Born OBSERVE: it records what it would do. Listing rules are never scheduled — a person presses Run.', needsValueCap: false,
  },
  replenishment: {
    automation: 'N6', name: 'replenishment rule', manage: FEATURES.replenishmentRun,
    triggers: ['recommendation_generated', 'stockout_imminent', 'cron_tick', 'recommendation_approved', 'demand_spike_detected', 'imbalance_detected'],
    actions: ['auto_approve_recommendation', 'create_po_from_recommendation'],
    born: 'OBSERVE', bornWhy: 'Born OBSERVE: it records what it would approve or draft, and does neither.', needsValueCap: true,
  },
  reviews: {
    automation: 'N7', name: 'review rule', manage: FEATURES.reviewsManage, triggers: ['REVIEW_SPIKE_DETECTED'],
    actions: ['update_product_bullets_from_review', 'create_aplus_module_from_review'],
    born: 'OFF', bornWhy: 'Born OFF: its actions call the AI even in a dry run (AI spend), so it starts only when a person turns it up.', needsValueCap: false,
  },
  'bulk-operations': {
    automation: 'N9', name: 'bulk-operation rule', manage: FEATURES.productsBulkRun, triggers: BULK_OPS_TRIGGERS,
    // pause_schedules_matching pauses: refused below, like every pause.
    actions: BULK_OPS_ACTION_TYPES.filter((t) => !t.startsWith('pause_')),
    born: 'OBSERVE', bornWhy: 'Born OBSERVE: it records the bulk jobs it would create, and creates none.', needsValueCap: false,
  },
}

export interface OpsRuleInput {
  domain: OpsDomain
  opsRuleId?: string
  name?: string
  description?: string | null
  trigger?: string
  conditions?: unknown
  actions?: unknown[]
  maxExecutionsPerDay?: number | null
  maxValueCentsEur?: number | null
}

/** A rule as save-ops-rule records it (before / after) and its undo puts back. */
export interface OpsRuleConfig {
  domain: OpsDomain
  opsRuleId: string | null
  name: string
  description: string | null
  trigger: string
  conditions: unknown
  actions: unknown[]
  maxExecutionsPerDay: number | null
  maxValueCentsEur: number | null
}

export interface OpsRulePlan {
  action: 'save-ops-rule'
  domain: OpsDomain
  automation: string
  rule: { id: string | null; name: string }
  changes: Record<string, { from: unknown; to: unknown }>
  level: { from: Level | null; to: Level }
  basis: string | null
  effect: string
}

const FIELDS = ['name', 'description', 'trigger', 'conditions', 'actions', 'maxExecutionsPerDay', 'maxValueCentsEur'] as const
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const isEmptyConditions = (c: unknown) => c == null || (Array.isArray(c) && c.length === 0) || (typeof c === 'object' && !Array.isArray(c) && Object.keys(c as object).length === 0)

/** What a rule of this domain must be. Pure. Each problem in words, naming what to do instead. */
export function guardOpsRule(domain: OpsDomain, draft: OpsRuleConfig): string[] {
  const spec = OPS_DOMAIN_SPECS[domain]
  const out: string[] = []
  if (!draft.name?.trim()) out.push('name: required')
  if (!spec.triggers.includes(draft.trigger)) out.push(`trigger: one of ${spec.triggers.join(', ')}`)
  if (isEmptyConditions(draft.conditions)) out.push('conditions: at least one — an empty list matches everything')
  else {
    const check = validateConditions(draft.conditions as ConditionsPayload)
    if (!check.ok) out.push(`conditions: ${check.error}`)
  }
  const actions = Array.isArray(draft.actions) ? draft.actions : []
  if (actions.length === 0) out.push('actions: at least one')
  for (const [i, a] of actions.entries()) {
    const type = String((a as { type?: unknown })?.type ?? '')
    if (/(^|_)pause(_|$)/.test(type)) out.push(`${type}: refused — a rule Claude saves never pauses (Owner rule); a person sets that in Nexus`)
    else if (!BUILTIN_ACTIONS.includes(type) && !spec.actions.includes(type)) out.push(`actions[${i}] ${type || '(no type)'}: not an action a ${spec.name} may carry — ${[...spec.actions, ...BUILTIN_ACTIONS].join(', ')}`)
  }
  if (!(Number.isInteger(draft.maxExecutionsPerDay) && (draft.maxExecutionsPerDay as number) > 0)) out.push('maxExecutionsPerDay: required, a whole number above 0 (runs per day it may act on)')
  if (spec.needsValueCap && !(Number.isInteger(draft.maxValueCentsEur) && (draft.maxValueCentsEur as number) > 0)) out.push('maxValueCentsEur: required, a whole number above 0 (euro cents one run may commit — its actions approve and draft orders)')
  return out
}

async function ruleOf(domain: OpsDomain, id: string) {
  return prisma.automationRule.findFirst({ where: { id, domain } })
}

function configOf(domain: OpsDomain, r: { id: string; name: string; description: string | null; trigger: string; conditions: unknown; actions: unknown; maxExecutionsPerDay: number | null; maxValueCentsEur: number | null }): OpsRuleConfig {
  return {
    domain, opsRuleId: r.id, name: r.name, description: r.description, trigger: r.trigger, conditions: r.conditions,
    actions: Array.isArray(r.actions) ? r.actions : [], maxExecutionsPerDay: r.maxExecutionsPerDay, maxValueCentsEur: r.maxValueCentsEur,
  }
}

/** The rule as stored now (undo compares it with `after`). */
export async function opsRuleNow(domain: OpsDomain, id: string): Promise<OpsRuleConfig | null> {
  const r = await ruleOf(domain, id)
  return r ? configOf(domain, r) : null
}

type Planned = { ok: true; plan: OpsRulePlan; before: OpsRuleConfig | null; after: OpsRuleConfig; level: Level } | { ok: false; error: string }

export async function planOpsRuleSave(input: OpsRuleInput): Promise<Planned> {
  const spec = OPS_DOMAIN_SPECS[input.domain]
  if (!spec) return { ok: false, error: `domain: one of ${OPS_DOMAINS.join(', ')}` }
  let before: OpsRuleConfig | null = null
  let from: Level | null = null
  let basis: string | null = null
  if (input.opsRuleId) {
    const r = await ruleOf(input.domain, input.opsRuleId)
    if (!r) return { ok: false, error: `There is no ${spec.name} ${input.opsRuleId} in this business (not found).` }
    before = configOf(input.domain, r)
    from = resolveAutonomy(r) as Level
    // The rule's settings, never the evaluator's counters (row-basis.ts): each run moves updatedAt.
    basis = ruleBasis(r)
  }
  const after: OpsRuleConfig = before
    ? { ...before }
    : { domain: input.domain, opsRuleId: null, name: '', description: null, trigger: '', conditions: [], actions: [], maxExecutionsPerDay: null, maxValueCentsEur: null }
  for (const field of FIELDS) if (input[field] !== undefined) (after as unknown as Record<string, unknown>)[field] = input[field]
  if (typeof after.name === 'string') after.name = after.name.trim()
  const problems = guardOpsRule(input.domain, after)
  const label = after.name || `the new ${spec.name}`
  if (problems.length) return { ok: false, error: `${label}: ${problems.join('; ')}.` }
  const changes: OpsRulePlan['changes'] = {}
  for (const field of FIELDS) {
    const was = before ? (before as unknown as Record<string, unknown>)[field] : null
    const now = (after as unknown as Record<string, unknown>)[field]
    if (!before || !same(was, now)) changes[field] = { from: was ?? null, to: now ?? null }
  }
  if (before && Object.keys(changes).length === 0) return { ok: false, error: `${label}: nothing to change.` }
  // Born at its domain's level; an AUTO rule's edit drops it to PROPOSE (a person looks again before it acts).
  const to: Level = !before ? spec.born : from === 'AUTO' ? 'PROPOSE' : (from as Level)
  return {
    ok: true, before, after, level: to,
    plan: {
      action: 'save-ops-rule', domain: input.domain, automation: spec.automation, rule: { id: before?.opsRuleId ?? null, name: after.name },
      changes, level: { from, to }, basis,
      effect: !before ? spec.bornWhy : from === 'AUTO' ? 'It was AUTO: the edit drops it to PROPOSE until a person turns it up again.' : `It stays ${to}.`,
    },
  }
}

export async function applyOpsRuleSave(input: OpsRuleInput, actorUserId: string | null): Promise<{ ok: true; plan: OpsRulePlan; before: OpsRuleConfig | { created: true; domain: OpsDomain; opsRuleId: string; name: string; born: Level }; after: OpsRuleConfig } | { ok: false; error: string }> {
  const planned = await planOpsRuleSave(input)
  if ('error' in planned) return planned
  const { after, level } = planned
  const data = {
    name: after.name, description: after.description, trigger: after.trigger, conditions: after.conditions as never, actions: after.actions as never,
    maxExecutionsPerDay: after.maxExecutionsPerDay, maxValueCentsEur: after.maxValueCentsEur,
  }
  const actor = actorUserId ? `user:${actorUserId}` : 'claude'
  const saved = planned.before
    ? await prisma.automationRule.update({ where: { id: planned.before.opsRuleId! }, data: { ...data, ...(planned.plan.level.from === 'AUTO' ? { autonomyLevel: 'PROPOSE', dryRun: true } : {}) } })
    : await prisma.automationRule.create({ data: { ...data, domain: input.domain, enabled: level !== 'OFF', dryRun: true, autonomyLevel: level, createdBy: actor } })
  const now = configOf(input.domain, saved)
  const { auditLogService } = await import('../audit-log.service.js')
  await auditLogService.write({ userId: actorUserId, entityType: 'AutomationRule', entityId: saved.id, action: planned.before ? 'update_rule' : 'create_rule', before: planned.before ?? undefined, after: { ...now, level }, metadata: { domain: input.domain, via: 'save-ops-rule' } }).catch(() => undefined)
  return {
    ok: true, plan: planned.plan, after: now,
    before: planned.before ?? { created: true, domain: input.domain, opsRuleId: saved.id, name: saved.name, born: level },
  }
}
