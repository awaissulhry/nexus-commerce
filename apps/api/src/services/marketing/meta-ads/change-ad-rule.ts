/**
 * Meta step 29 — set-meta-ad-rule and remove-meta-ad-rule as drafts (pure: the live rule, Meta's preview of it and the
 * rule in words come in from live-rules.ts). Meta's automated rules on the business's chosen ad account:
 *   create  POST act_<id>/adrules_library — a schedule rule (RU-003) or a trigger rule (RU-004 … RU-009), its conditions
 *           (RU-010 settings, RU-011 results, RU-012 advanced fields, RU-025 ROAS), its action (RU-013 … RU-021) and its
 *           schedule (RU-023); ALWAYS made DISABLED unless the request says `enable: true`
 *   update  POST /<rule id> — any part (every spec optional); Meta needs the WHOLE rule, unchanged parts too (RU-026): the
 *           parts not named are sent exactly as Meta has them
 *   status  POST /<rule id> status ENABLED | DISABLED (RU-027)
 *   run     POST /<rule id>/execute — a schedule rule now (RU-032)
 *   remove  DELETE /<rule id> (RU-028), only on the person's explicit ask
 * Meta's preview of a schedule rule (POST /<rule id>/preview, RU-031) is part of the preview of a run, a switch-on and an
 * update; for a run, the objects it lists are part of what the change stands on (a run that would act on other objects
 * than approved is not sent).
 *
 * Money in a request is in MINOR units of the account currency (`…Cents`, rule-units.ts ruleMoneyParam; Meta's base unit
 * of the currency): a condition on a money field (step 8's isMoneyRuleField: spend, budgets, bids, costs) takes
 * valueCents; a field on step 8's ALLOW-list of plain fields (isPlainRuleField: settings, statuses, counts, rates) takes
 * value; any other field (ROAS, a ratio, a formula, an aggregate, a field Nexus does not know) takes valueAsMeta — exactly
 * as Meta reads it. Spend safety: switching a rule on (or making it on, or running it) whose action can make the account
 * spend more (switch on, a budget or bid raise or a move towards a target, a budget rebalance — step 8's canRaiseSpend)
 * is SPENDS MONEY; so is switching off, changing or deleting a rule that is on and acts as a brake (pauses, cuts budgets
 * or bids): what it would have stopped keeps spending. Meta has no check (validate_only) for rules: the preview says so.
 * RU-024 `recommended_rule_key`: Meta documents no value anywhere (RECHECK-C3) — not offered. RU-022 (the reference enum's
 * other ten actions and is_once_off): no guide — not offered.
 */
import { changeLines, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import { isMoneyRuleField, isPlainRuleField, metaBudgetCents } from './live-optimize.js'
import { ruleMoneyParam, ruleMoneyRange } from './rule-units.js'
import { MetaUnitError } from './settings-units.js'
import { currencyExponent } from './money.js'
import type { LiveRule, LiveRuleSpecs, RulePreview, RuleWords } from './live-rules.js'
import { META_NAME_TEXT, typedTextOk } from '../../gateway/meta-settings-rules.js'
import {
  AD_RULE_READ_BACK, CHANGE_EXECUTION_TYPES, isRuleId, ruleFieldProblem, TODAY_TIME_PRESETS, TRIGGER_EXECUTION_TYPES, wholeRuleSpecsProblem,
  type RuleExecutionType, type RuleOperator,
} from '../../gateway/meta-ad-rule-rules.js'

type Row = Record<string, unknown>
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)

// ── the request ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type RuleScalar = string | number | boolean
export type RuleValue = RuleScalar | RuleScalar[]
export interface RuleConditionInput { field: string; operator: RuleOperator; value?: RuleValue; valueCents?: number | number[]; valueAsMeta?: number | number[] }
export interface RuleTriggerInput { type: 'METADATA_CREATION' | 'METADATA_UPDATE' | 'STATS_MILESTONE' | 'STATS_CHANGE' | 'DELIVERY_INSIGHTS_CHANGE'; field?: string; operator?: RuleOperator; value?: RuleValue; valueCents?: number | number[]; valueAsMeta?: number | number[] }
export interface RuleEvaluationInput { type?: 'SCHEDULE' | 'TRIGGER'; filters?: RuleConditionInput[]; trigger?: RuleTriggerInput }
export interface RuleChangeInput { unit?: 'ACCOUNT_CURRENCY' | 'PERCENTAGE'; amountCents?: number; amountPercent?: number; targetField?: string; targetValue?: number; targetValueCents?: number; targetValueAsMeta?: number; limitCents?: number | number[] }
export interface RuleRebalanceInput { type: 'EVEN' | 'PROPORTIONAL' | 'NO_PAUSE_PROPORTIONAL' | 'MATCHED_ONLY_PROPORTIONAL'; targetField?: string; targetCount?: number; crossCampaign?: boolean; inverse?: boolean }
export interface RuleExecutionInput { type: RuleExecutionType; change?: RuleChangeInput; rebalance?: RuleRebalanceInput; notifyUserIds?: string[]; maxActionsPerObject?: number; minMinutesBetweenActions?: number }
export interface RuleScheduleInput { type: 'DAILY' | 'HOURLY' | 'SEMI_HOURLY' | 'CUSTOM'; times?: Array<{ days?: number[]; startMinute?: number; endMinute?: number }> }
export interface AdRuleRequest {
  action: 'create' | 'update' | 'status' | 'run'
  ruleId?: string
  name?: string
  evaluation?: RuleEvaluationInput
  execution?: RuleExecutionInput
  schedule?: RuleScheduleInput
  /** create: true makes it ENABLED (else DISABLED). */
  enable?: boolean
  /** status: true ENABLED, false DISABLED. */
  enabled?: boolean
}

/** A rule as a create request takes it (remove-meta-ad-rule's undo makes it again). */
export interface RuleCreateArgs { action: 'create'; name: string; evaluation: RuleEvaluationInput; execution: RuleExecutionInput; schedule?: RuleScheduleInput; enable?: boolean }

export class RuleRefusal extends Error {
  constructor(message: string) { super(message); this.name = 'RuleRefusal' }
}
const refuse = (message: string): never => { throw new RuleRefusal(message) }

// ── fields: which way a value goes ──────────────────────────────────────────────────────────────────────────────────

/** Id fields and the aggregation id: their values are Meta ids (plain). */
const ID_LIKE = /^(?:(?:ad|adset|campaign)\.)?(?:id|adlabel_ids)$|^aggregation_id$/
/** Which value key a field takes: plain `value`, money `valueCents`, or `valueAsMeta` (step 8's allow-list decides). */
export function valueKeyOf(field: string): 'value' | 'valueCents' | 'valueAsMeta' {
  if (ID_LIKE.test(field) || isPlainRuleField(field)) return 'value'
  if (isMoneyRuleField(field)) return 'valueCents'
  return 'valueAsMeta'
}

/** The metadata fields (evaluation-spec.md "Metadata filters"): any other field is a result (insights) and needs a time_preset. */
const METADATA_FIELDS = new Set([
  'id', 'entity_type', 'name', 'adlabel_ids', 'objective', 'start_time', 'stop_time', 'buying_type', 'billing_event', 'optimization_goal', 'is_autobid',
  'daily_budget', 'lifetime_budget', 'spend_cap', 'bid_amount', 'created_time', 'updated_time', 'effective_status', 'placement.page_types',
  'budget_reset_period', 'hours_since_creation', 'estimated_budget_spending_percentage', 'audience_reached_percentage', 'active_time', 'current_time',
  'time_preset', 'attribution_window', 'aggregation_id',
])
/** Metadata filters Meta supports for schedule rules only. */
const SCHEDULE_ONLY_METADATA = new Set(['effective_status', 'placement.page_types', 'budget_reset_period', 'hours_since_creation', 'estimated_budget_spending_percentage', 'audience_reached_percentage', 'active_time', 'current_time'])
/** Insights fields Meta's table marks "not allowed for trigger based rules". */
const NOT_FOR_TRIGGERS = /^(mobile_app_purchase_roas|website_purchase_roas|offline_conversion(\..+)?|cost_per_offline_conversion|cost_per_offline_other|cost_per_post_engagement|lifetime_impressions|lifetime_spent|today_spent|yesterday_spent)$/
const levelLess = (field: string) => field.replace(/^(ad|adset|campaign)\./, '')
const isMetadata = (field: string) => METADATA_FIELDS.has(levelLess(field)) || METADATA_FIELDS.has(field)
/** An advanced field (schedule rules only): a formula, an aggregate, an attribution prefix, an alias. */
const isAdvanced = (field: string) => field.includes(' ') || field.startsWith('aggregate(') || field.includes(':') || /^(daily|lifetime)_ratio_spent$/.test(field)
/** STATS_MILESTONE minimums (trigger-based-rules.md): spent in the currency's base unit. */
const MILESTONE_MINIMUM: Readonly<Record<string, number>> = { impressions: 1000, unique_impressions: 1000, reach: 1000, clicks: 10, unique_clicks: 10, spent: 1000, results: 5 }

// ── request → Meta ──────────────────────────────────────────────────────────────────────────────────────────────────

/** A plain value as Meta takes it: ids as text (a number is taken only while it is exact). */
function plainValue(field: string, value: RuleValue, where: string): RuleValue {
  if (!ID_LIKE.test(field)) return value
  const asId = (v: RuleScalar) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? String(v) : v)
  const out = Array.isArray(value) ? value.map(asId) : asId(value)
  for (const v of Array.isArray(out) ? out : [out]) if (!isRuleId(v)) refuse(`${where}: ${field} takes Meta ids, as text of digits.`)
  return out
}

/** One value of a condition or trigger, in the key its field takes, as Meta reads it. */
function metaValueOf(c: { field: string; value?: RuleValue; valueCents?: number | number[]; valueAsMeta?: number | number[] }, currency: string | null, where: string): RuleValue {
  const key = valueKeyOf(c.field)
  const given = (['value', 'valueCents', 'valueAsMeta'] as const).filter((k) => c[k] !== undefined)
  if (given.length !== 1 || given[0] !== key) {
    const how = key === 'valueCents' ? 'is money: give valueCents (minor units of the account currency)'
      : key === 'value' ? 'takes a plain value (value)'
        : 'is neither money Nexus knows nor a plain field: give valueAsMeta, exactly as Meta reads it (a ROAS or a ratio as a number, money in Meta\'s base unit of the currency)'
    return refuse(`${where}: ${c.field} ${how}.`)
  }
  if (key === 'value') return plainValue(c.field, c.value!, where)
  if (key === 'valueAsMeta') return c.valueAsMeta!
  const cents = c.valueCents!
  try {
    return Array.isArray(cents) ? (cents.length === 2 ? ruleMoneyRange([cents[0], cents[1]], currency, `${where} (${c.field})`) : refuse(`${where}: a range is [low, high].`)) : ruleMoneyParam(cents, currency, `${where} (${c.field})`)
  } catch (err) {
    if (err instanceof MetaUnitError) return refuse(err.message)
    throw err
  }
}

function filterOf(c: RuleConditionInput, currency: string | null, i: number): Row {
  const where = `condition ${i + 1}`
  const problem = ruleFieldProblem(c.field)
  if (problem) refuse(`${where}: ${problem}.`)
  return { field: c.field, value: metaValueOf(c, currency, where), operator: c.operator }
}

function triggerOf(t: RuleTriggerInput, currency: string | null): Row {
  const out: Row = { type: t.type }
  if (t.field !== undefined) out.field = t.field
  const hasValue = t.value !== undefined || t.valueCents !== undefined || t.valueAsMeta !== undefined
  if (hasValue) {
    if (!t.field) refuse('the trigger names its field with its value.')
    out.value = metaValueOf({ field: t.field!, value: t.value, valueCents: t.valueCents, valueAsMeta: t.valueAsMeta }, currency, 'the trigger')
  }
  if (t.operator !== undefined) out.operator = t.operator
  return out
}

export function executionOf(x: RuleExecutionInput, currency: string | null): Row {
  const options: Row[] = []
  const option = (field: string, value: unknown) => options.push({ field, value, operator: 'EQUAL' })
  if (x.notifyUserIds?.length) option('user_ids', x.notifyUserIds)
  if (x.change) {
    const c = x.change
    const value: Row = {}
    try {
      if (c.targetField !== undefined) {
        const key = valueKeyOf(c.targetField)
        const given = (['targetValue', 'targetValueCents', 'targetValueAsMeta'] as const).filter((k) => c[k] !== undefined)
        const wanted = key === 'value' ? 'targetValue' : key === 'valueCents' ? 'targetValueCents' : 'targetValueAsMeta'
        if (given.length !== 1 || given[0] !== wanted) refuse(`the change's target ${c.targetField} takes ${wanted}${wanted === 'targetValueCents' ? ' (minor units)' : wanted === 'targetValueAsMeta' ? ' (exactly as Meta reads it: a ROAS as a number)' : ''}.`)
        if (c.amountCents !== undefined || c.amountPercent !== undefined || c.unit !== undefined) refuse('a change towards a target names the target (targetField and its value), not an amount or a unit.')
        value.amount = wanted === 'targetValueCents' ? ruleMoneyParam(c.targetValueCents!, currency, 'The target') : (c[wanted] as number)
        if (c.limitCents !== undefined) {
          if (!Array.isArray(c.limitCents) || c.limitCents.length !== 2) refuse('a change towards a target takes its limit as [lowest, highest] (limitCents).')
          value.limit = ruleMoneyRange([(c.limitCents as number[])[0], (c.limitCents as number[])[1]], currency, 'The limit')
        }
        value.target_field = c.targetField
      } else {
        if (c.unit === 'ACCOUNT_CURRENCY') {
          if (c.amountCents === undefined || c.amountPercent !== undefined) refuse('a change in the account currency names amountCents (minor units; negative cuts).')
          value.amount = ruleMoneyParam(c.amountCents!, currency, 'The amount')
        } else if (c.unit === 'PERCENTAGE') {
          if (c.amountPercent === undefined || c.amountCents !== undefined) refuse('a change in percent names amountPercent (negative cuts).')
          value.amount = c.amountPercent
        } else refuse('the change names its unit: ACCOUNT_CURRENCY (amountCents) or PERCENTAGE (amountPercent) — or a target (targetField).')
        if (c.limitCents !== undefined) {
          if (Array.isArray(c.limitCents)) refuse('a change by an amount takes one limit (limitCents: the most a raise reaches, the least a cut leaves).')
          value.limit = ruleMoneyParam(c.limitCents as number, currency, 'The limit')
        }
        value.unit = c.unit
      }
    } catch (err) {
      if (err instanceof MetaUnitError) refuse(err.message)
      throw err
    }
    option('change_spec', value)
  }
  if (x.rebalance) {
    const r = x.rebalance
    option('rebalance_spec', {
      type: r.type,
      ...(r.targetField !== undefined ? { target_field: r.targetField } : {}),
      ...(r.targetCount !== undefined ? { target_count: r.targetCount } : {}),
      ...(r.crossCampaign !== undefined ? { is_cross_campaign: r.crossCampaign } : {}),
      ...(r.inverse !== undefined ? { is_inverse: r.inverse } : {}),
    })
  }
  if (x.maxActionsPerObject !== undefined) option('execution_count_limit', x.maxActionsPerObject)
  if (x.minMinutesBetweenActions !== undefined) option('action_frequency', x.minMinutesBetweenActions)
  return { execution_type: x.type, ...(options.length ? { execution_options: options } : {}) }
}

export function scheduleOf(s: RuleScheduleInput): Row {
  if (s.type !== 'CUSTOM') return s.times?.length ? refuse('only a CUSTOM schedule lists its times.') : { schedule_type: s.type }
  if (!s.times?.length) refuse('a CUSTOM schedule lists its times (days and / or startMinute).')
  return {
    schedule_type: 'CUSTOM',
    schedule: s.times!.map((t) => ({
      ...(t.startMinute !== undefined ? { start_minute: t.startMinute } : {}),
      ...(t.endMinute !== undefined ? { end_minute: t.endMinute } : {}),
      ...(t.days !== undefined ? { days: t.days } : {}),
    })),
  }
}

// ── Meta → request (a rule as Nexus can send it again: undo, the record) ──────────────────────────────────────────────

/** A number past JavaScript's exact range (an id Meta wrote as a JSON number): never sent back. */
function unsafeNumber(v: unknown, depth = 0): boolean {
  if (depth > 10) return true
  if (typeof v === 'number') return Number.isInteger(v) && !Number.isSafeInteger(v)
  if (Array.isArray(v)) return v.some((x) => unsafeNumber(x, depth + 1))
  if (v && typeof v === 'object') return Object.values(v).some((x) => unsafeNumber(x, depth + 1))
  return false
}

/** A value as a request can name it again: text the tool's input takes (≤ 400, no control or format character), a number, true / false. */
const asScalar = (v: unknown): RuleScalar | null => (typeof v === 'string' ? (typedTextOk(v, META_NAME_TEXT, 400) ? v : null) : typeof v === 'number' || typeof v === 'boolean' ? v : null)
/** A rule's name a request can name again (the tool's own check), else null. */
const nameAgain = (name: string | null): string | null => (typedTextOk(name, META_NAME_TEXT, 400) ? name : null)
const cents = (v: unknown, currency: string | null): number | number[] | null => {
  if (Array.isArray(v)) { const out = v.map((x) => metaBudgetCents(x, currency)); return out.length === 2 && out.every((x) => x !== null) ? out as number[] : null }
  return metaBudgetCents(v, currency)
}

/** One condition as a request names it, or null when Nexus cannot name it again exactly. */
function conditionInputOf(raw: unknown, currency: string | null): RuleConditionInput | null {
  const f = obj(raw)
  if (!f || typeof f.field !== 'string' || typeof f.operator !== 'string') return null
  const key = valueKeyOf(f.field)
  if (key === 'value') {
    const value = Array.isArray(f.value) ? f.value.map(asScalar) : asScalar(f.value)
    if (value === null || (Array.isArray(value) && value.some((x) => x === null))) return null
    const ids = ID_LIKE.test(f.field) ? (Array.isArray(value) ? value : [value]).map((x) => (typeof x === 'number' && Number.isSafeInteger(x) ? String(x) : x)) : null
    return { field: f.field, operator: f.operator as RuleOperator, value: ids ? (Array.isArray(value) ? ids as RuleScalar[] : ids[0] as RuleScalar) : value as RuleValue }
  }
  if (key === 'valueCents') {
    const value = cents(f.value, currency)
    return value === null ? null : { field: f.field, operator: f.operator as RuleOperator, valueCents: value }
  }
  const n = (x: unknown) => (typeof x === 'number' ? x : typeof x === 'string' && x.trim() && Number.isFinite(Number(x)) ? Number(x) : null)
  const value = Array.isArray(f.value) ? f.value.map(n) : n(f.value)
  if (value === null || (Array.isArray(value) && value.some((x) => x === null))) return null
  return { field: f.field, operator: f.operator as RuleOperator, valueAsMeta: value as number | number[] }
}

/** The rule's specs as a request names them, or why Nexus cannot name them again exactly. */
export function ruleInputOf(specs: LiveRuleSpecs, currency: string | null): { evaluation: RuleEvaluationInput; execution: RuleExecutionInput; schedule?: RuleScheduleInput } | { why: string } {
  if (!specs.evaluation || !specs.execution) return { why: 'Meta did not send the rule\'s conditions and action back.' }
  if (unsafeNumber(specs.evaluation) || unsafeNumber(specs.execution) || unsafeNumber(specs.schedule)) return { why: 'Meta wrote an id in this rule as a number too long to read exactly.' }
  const e = specs.evaluation
  const type = e.evaluation_type
  if (type !== 'SCHEDULE' && type !== 'TRIGGER') return { why: `its evaluation type (${String(type)}) is not one Nexus sends.` }
  const filters = (Array.isArray(e.filters) ? e.filters : []).map((f) => conditionInputOf(f, currency))
  if (filters.some((f) => f === null)) return { why: 'a condition holds a value Nexus cannot name again exactly.' }
  let trigger: RuleTriggerInput | undefined
  if (type === 'TRIGGER') {
    const t = obj(e.trigger)
    if (!t || typeof t.type !== 'string') return { why: 'its trigger is not readable.' }
    trigger = { type: t.type as RuleTriggerInput['type'] }
    if (typeof t.field === 'string') trigger.field = t.field
    if (typeof t.operator === 'string') trigger.operator = t.operator as RuleOperator
    if (t.value !== undefined) {
      if (typeof t.field !== 'string') return { why: 'its trigger has a value without a field.' }
      const c = conditionInputOf({ field: t.field, operator: t.operator ?? 'EQUAL', value: t.value }, currency)
      if (!c) return { why: 'its trigger holds a value Nexus cannot name again exactly.' }
      Object.assign(trigger, c.value !== undefined ? { value: c.value } : c.valueCents !== undefined ? { valueCents: c.valueCents } : { valueAsMeta: c.valueAsMeta })
    }
  }
  const x = specs.execution
  if (x.is_once_off === true) return { why: 'Meta\'s is_once_off is on for it, which Nexus does not send (RU-022).' }
  const execution: RuleExecutionInput = { type: x.execution_type as RuleExecutionType }
  for (const raw of Array.isArray(x.execution_options) ? x.execution_options : []) {
    const o = obj(raw)
    const value = typeof o?.value === 'string' && /^[[{]/.test(o.value) ? (() => { try { return JSON.parse(o.value as string) as unknown } catch { return o?.value } })() : o?.value
    if (!o) return { why: 'an action option is not readable.' }
    if (o.field === 'user_ids') {
      const ids = (Array.isArray(value) ? value : [value]).map((v) => (typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : v))
      if (!ids.every(isRuleId)) return { why: 'the people it notifies are not readable.' }
      execution.notifyUserIds = ids as string[]
    } else if (o.field === 'change_spec') {
      const c = obj(value)
      if (!c) return { why: 'its change is not readable.' }
      const change: RuleChangeInput = {}
      if (typeof c.target_field === 'string') {
        change.targetField = c.target_field
        const key = valueKeyOf(c.target_field)
        const n = typeof c.amount === 'number' ? c.amount : Number(c.amount)
        if (!Number.isFinite(n)) return { why: 'its change\'s target is not readable.' }
        if (key === 'valueCents') { const v = metaBudgetCents(c.amount, currency); if (v === null) return { why: 'its change\'s target is not readable.' }; change.targetValueCents = v } else if (key === 'value') change.targetValue = n
        else change.targetValueAsMeta = n
        if (c.limit !== undefined) { const v = cents(c.limit, currency); if (!Array.isArray(v)) return { why: 'its change\'s limit is not readable.' }; change.limitCents = v }
      } else {
        if (c.unit !== 'ACCOUNT_CURRENCY' && c.unit !== 'PERCENTAGE') return { why: 'its change\'s unit is not readable.' }
        change.unit = c.unit
        if (c.unit === 'ACCOUNT_CURRENCY') { const v = metaBudgetCents(c.amount, currency); if (v === null) return { why: 'its change\'s amount is not readable.' }; change.amountCents = v } else {
          const n = typeof c.amount === 'number' ? c.amount : Number(c.amount)
          if (!Number.isFinite(n)) return { why: 'its change\'s amount is not readable.' }
          change.amountPercent = n
        }
        if (c.limit !== undefined) { const v = metaBudgetCents(c.limit, currency); if (v === null) return { why: 'its change\'s limit is not readable.' }; change.limitCents = v }
      }
      execution.change = change
    } else if (o.field === 'rebalance_spec') {
      const r = obj(value)
      if (!r || typeof r.type !== 'string') return { why: 'its budget rebalance is not readable.' }
      execution.rebalance = {
        type: r.type as RuleRebalanceInput['type'],
        ...(typeof r.target_field === 'string' ? { targetField: r.target_field } : {}),
        ...(typeof r.target_count === 'number' ? { targetCount: r.target_count } : {}),
        ...(typeof r.is_cross_campaign === 'boolean' ? { crossCampaign: r.is_cross_campaign } : {}),
        ...(typeof r.is_inverse === 'boolean' ? { inverse: r.is_inverse } : {}),
      }
    } else if (o.field === 'execution_count_limit' && typeof value === 'number') execution.maxActionsPerObject = value
    else if (o.field === 'action_frequency' && typeof value === 'number') execution.minMinutesBetweenActions = value
    else return { why: `its action option ${String(o.field)} is not one Nexus sends.` }
  }
  let schedule: RuleScheduleInput | undefined
  if (type === 'SCHEDULE') {
    const s = specs.schedule
    if (!s || typeof s.schedule_type !== 'string') return { why: 'its schedule is not readable.' }
    schedule = { type: s.schedule_type as RuleScheduleInput['type'] }
    if (Array.isArray(s.schedule)) {
      schedule.times = s.schedule.map((raw) => {
        const t = obj(raw) ?? {}
        return {
          ...(typeof t.start_minute === 'number' ? { startMinute: t.start_minute } : {}),
          ...(typeof t.end_minute === 'number' ? { endMinute: t.end_minute } : {}),
          ...(Array.isArray(t.days) ? { days: t.days as number[] } : {}),
        }
      })
    }
  }
  const evaluation: RuleEvaluationInput = { type, filters: filters as RuleConditionInput[], ...(trigger ? { trigger } : {}) }
  // Written again, it must be exactly what Nexus would send for it (the gateway's judges agree).
  try {
    const again = specsOf({ evaluation, execution, schedule }, currency)
    const problem = wholeRuleSpecsProblem(again.evaluation, again.execution, again.schedule)
    if (problem) return { why: `Nexus would not send it as Meta has it (${problem}).` }
  } catch (err) {
    if (err instanceof RuleRefusal) return { why: err.message }
    throw err
  }
  return { evaluation, execution, ...(schedule ? { schedule } : {}) }
}

/** The three specs of a request as Meta takes them (each filter converted; schedule undefined for a trigger rule). */
export function specsOf(r: { evaluation: RuleEvaluationInput; execution: RuleExecutionInput; schedule?: RuleScheduleInput }, currency: string | null): { evaluation: Row; execution: Row; schedule: Row | undefined } {
  const type = r.evaluation.type
  if (!type) refuse('the conditions name their type: SCHEDULE (checked on a schedule) or TRIGGER (real time).')
  if (!r.evaluation.filters?.length) refuse('the conditions list their filters (at least an entity_type or an id filter).')
  const evaluation: Row = { evaluation_type: type, filters: r.evaluation.filters!.map((f, i) => filterOf(f, currency, i)) }
  if (type === 'TRIGGER') {
    if (!r.evaluation.trigger) refuse('a trigger rule names its trigger.')
    evaluation.trigger = triggerOf(r.evaluation.trigger!, currency)
  } else if (r.evaluation.trigger) refuse('a schedule rule has no trigger.')
  const schedule = type === 'SCHEDULE' ? (r.schedule ? scheduleOf(r.schedule) : refuse('a schedule rule names its schedule (DAILY, HOURLY, SEMI_HOURLY or CUSTOM times).')) : (r.schedule ? refuse('a trigger rule has no schedule (Meta checks it in real time).') : undefined)
  return { evaluation, execution: executionOf(r.execution, currency), schedule }
}

// ── what a rule does, for a person ──────────────────────────────────────────────────────────────────────────────────

const OPERATOR_WORDS: Readonly<Record<string, string>> = {
  GREATER_THAN: '>', LESS_THAN: '<', EQUAL: '=', NOT_EQUAL: '≠', IN_RANGE: 'between', NOT_IN_RANGE: 'not between', IN: 'in', NOT_IN: 'not in',
  CONTAIN: 'contains', NOT_CONTAIN: 'does not contain', ANY: 'any of', ALL: 'all of', NONE: 'none of',
}
function moneyText(c: number, currency: string | null): string {
  const exp = currencyExponent(currency)
  return `${(c / 10 ** exp).toFixed(exp)} ${currency ?? ''}`.trim()
}
function conditionText(c: RuleConditionInput, currency: string | null): string {
  const value = c.valueCents !== undefined
    ? (Array.isArray(c.valueCents) ? c.valueCents.map((v) => moneyText(v, currency)).join(' and ') : moneyText(c.valueCents, currency))
    : JSON.stringify(c.value ?? c.valueAsMeta)
  return `${c.field} ${OPERATOR_WORDS[c.operator] ?? c.operator} ${value}`
}
/** The rule's conditions in one line (at most 600 characters). */
export function conditionsText(e: RuleEvaluationInput | null | undefined, currency: string | null): string | null {
  if (!e) return null
  const parts = (e.filters ?? []).map((f) => conditionText(f, currency))
  if (e.trigger) parts.unshift(`trigger ${e.trigger.type}${e.trigger.field ? ` on ${e.trigger.field}` : ''}`)
  const line = `${e.type ?? ''}: ${parts.join('; ')}`
  return line.length > 600 ? `${line.slice(0, 599)}…` : line
}
function scheduleText(s: RuleScheduleInput | undefined): string | null {
  if (!s) return null
  if (s.type !== 'CUSTOM') return s.type
  return `CUSTOM: ${(s.times ?? []).map((t) => `${t.days ? `days ${t.days.join(',')}` : 'every day'}${t.startMinute !== undefined ? ` from minute ${t.startMinute}${t.endMinute !== undefined ? ` to ${t.endMinute}` : ''}` : ''}`).join('; ')}`
}

/** A brake: a rule that pauses or cuts (its absence lets spend go on) — PAUSE, a cut by an amount, a rebalance that pauses donors. */
export function ruleIsBrake(execution: Row | null): boolean {
  if (!execution) return false
  const type = execution.execution_type
  if (type === 'PAUSE') return true
  const options = Array.isArray(execution.execution_options) ? execution.execution_options.map(obj) : []
  const value = (field: string) => { const o = options.find((x) => x?.field === field); const v = o?.value; return typeof v === 'string' ? (() => { try { return obj(JSON.parse(v)) } catch { return null } })() : obj(v) }
  if (type === 'REBALANCE_BUDGET') { const r = value('rebalance_spec'); return r?.type === 'EVEN' || r?.type === 'PROPORTIONAL' }
  if (CHANGE_EXECUTION_TYPES.has(type as string)) { const c = value('change_spec'); return !!c && c.target_field === undefined && Number(c.amount) < 0 }
  return false
}

const raw = (name: string | null, specs: { evaluation: Row | null; execution: Row | null; schedule: Row | null | undefined }, status: string | null): Row => ({
  name, status, evaluation_spec: specs.evaluation, execution_spec: specs.execution, ...(specs.schedule ? { schedule_spec: specs.schedule } : {}),
})

// ── the record (what undo reads and compares) ───────────────────────────────────────────────────────────────────────

export interface RuleRecord {
  kind: 'adrule'
  action: AdRuleRequest['action'] | 'remove'
  id: string
  exists: 'yes' | 'no'
  /** The rule's name, status and specs as Meta sends them back (as Nexus sent them when Meta's read-back had none) — compared by undo. */
  rule?: { name: string | null; status: string | null; specs: LiveRuleSpecs }
  /** What puts it back (a request of set-meta-ad-rule or remove-meta-ad-rule), or null. */
  undo?: Record<string, unknown> | null
  noUndo?: string[]
}

/** The rule as a record and a basis compare it: its name, status and its three specs as Meta has them. */
export function ruleStateOf(name: string | null, status: string | null, specs: LiveRuleSpecs): NonNullable<RuleRecord['rule']> {
  return { name, status, specs: { evaluation: specs.evaluation, execution: specs.execution, schedule: specs.schedule } }
}

// ── drafts ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RuleDraftContext {
  adAccountId: string
  currency: string | null
  /** update / status / run: the rule as Meta has it now. */
  live: LiveRule | null
  /** run / switch-on / update of a schedule rule: Meta's preview of it now. */
  preview: RulePreview | null
  words: RuleWords
}

const META_NO_CHECK = 'Meta has no check (validate_only) for a rule: the preview is built from the rule as Meta has it, and the run reads it again first.'
const PING_WARNING = 'Meta calls this app\'s ads_rules_engine webhook (PING_ENDPOINT): the app needs that webhook subscription, and Nexus\'s receiver for it is not built yet (Meta step 30) — until then each call reaches nothing.'

function liveFrom(ctx: RuleDraftContext): LiveRule {
  if (!ctx.live) refuse('Nexus could not read the rule.')
  if (ctx.live!.status === 'DELETED') refuse(`Rule ${ctx.live!.id} is deleted on Meta: nothing can change it.`)
  return ctx.live!
}
const ruleWho = (live: LiveRule) => `rule "${live.name ?? live.id}" (${live.id})`

/** Checks a person's rule before anything is built: what Meta documents for each kind of rule, in words. */
function ruleProblems(r: { evaluation: RuleEvaluationInput; execution: RuleExecutionInput }, currency: string | null): void {
  const type = r.evaluation.type
  const filters = r.evaluation.filters ?? []
  const fields = filters.map((f) => f.field)
  const trigger = r.evaluation.trigger
  const results = fields.some((f) => !isMetadata(f)) || (!!trigger && (trigger.type === 'STATS_CHANGE' || trigger.type === 'STATS_MILESTONE'))
  const preset = filters.find((f) => f.field === 'time_preset')
  if (results && !preset) refuse('A condition on results (an insights field) or a results trigger needs a time_preset filter (Meta: "required as long as any Insights filter or trigger is present"), e.g. {"field":"time_preset","operator":"EQUAL","value":"LAST_7D"}.')
  const entity = filters.find((f) => f.field === 'entity_type')?.value
  const x = r.execution
  if (type === 'TRIGGER') {
    if (!TRIGGER_EXECUTION_TYPES.has(x.type)) refuse(`A trigger rule takes NOTIFICATION, PAUSE, UNPAUSE or PING_ENDPOINT (Meta): ${x.type} is for schedule rules.`)
    const scheduleOnly = fields.find((f) => SCHEDULE_ONLY_METADATA.has(levelLess(f)) || isAdvanced(f) || NOT_FOR_TRIGGERS.test(f) || f === 'attribution_window')
    if (scheduleOnly) refuse(`${scheduleOnly} is a condition for schedule rules only (Meta's tables).`)
    if (preset && !(TODAY_TIME_PRESETS as readonly unknown[]).includes(preset.value)) refuse('A trigger rule takes only a time_preset that includes today (LIFETIME, TODAY, LAST_7_DAYS …; Meta).')
    if (trigger?.type === 'STATS_MILESTONE') {
      if (preset?.value !== 'LIFETIME') refuse('A milestone trigger needs time_preset LIFETIME (Meta).')
      const min = trigger.field ? MILESTONE_MINIMUM[trigger.field] : undefined
      const given = trigger.valueCents !== undefined && !Array.isArray(trigger.valueCents) ? ruleMoneyParam(trigger.valueCents, currency) : typeof trigger.value === 'number' ? trigger.value : null
      if (min !== undefined && given !== null && given < min) refuse(`A milestone on ${trigger.field} is at least ${min}${trigger.field === 'spent' ? ' in Meta\'s base unit of the currency (cents for EUR)' : ''} (Meta).`)
    }
    if (trigger?.field && NOT_FOR_TRIGGERS.test(trigger.field)) refuse(`${trigger.field} is not allowed as a trigger (Meta's insights table).`)
  } else if (x.type === 'PING_ENDPOINT') refuse('PING_ENDPOINT is for trigger rules only (Meta).')
  if ((x.type === 'CHANGE_BUDGET' || x.type === 'CHANGE_BID' || x.type === 'REBALANCE_BUDGET') && entity !== undefined && entity !== 'ADSET') refuse(`${x.type} applies to ad sets only (Meta): its entity_type is ADSET.`)
  if (x.type === 'CHANGE_CAMPAIGN_BUDGET' && entity !== undefined && entity !== 'CAMPAIGN') refuse('CHANGE_CAMPAIGN_BUDGET applies to campaigns only (Meta): its entity_type is CAMPAIGN.')
  if (x.type === 'ROTATE' && !(entity === 'AD' && fields.some((f) => f === 'id' || f === 'adset.id'))) refuse('ROTATE needs an entity_type AD filter and an id filter of ad sets (Meta).')
  if (CHANGE_EXECUTION_TYPES.has(x.type) !== !!x.change) refuse(CHANGE_EXECUTION_TYPES.has(x.type) ? `${x.type} names its change (unit and amount, or a target).` : `Only a budget or bid change takes a change (not ${x.type}).`)
  if ((x.type === 'REBALANCE_BUDGET') !== !!x.rebalance) refuse(x.type === 'REBALANCE_BUDGET' ? 'REBALANCE_BUDGET names its rebalance (type, …).' : `Only REBALANCE_BUDGET takes a rebalance (not ${x.type}).`)
}

/** Warnings a person reads about the rule as it will be. */
function ruleWarnings(r: { evaluation: RuleEvaluationInput; execution: RuleExecutionInput }, on: boolean): string[] {
  const out: string[] = []
  const fields = (r.evaluation.filters ?? []).map((f) => f.field)
  const x = r.execution
  if (r.evaluation.type === 'TRIGGER') out.push('A trigger rule runs on Meta in real time (seconds for settings, about 7.5 minutes for results) and Ads Manager never shows it: meta-ad-rules lists it.')
  if (r.evaluation.trigger?.type === 'DELIVERY_INSIGHTS_CHANGE') out.push('DELIVERY_INSIGHTS_CHANGE is a Meta beta with no fields documented: Meta\'s answer decides.')
  if (r.evaluation.trigger?.type === 'STATS_CHANGE') out.push('A STATS_CHANGE trigger acts when its conditions turn true, not again while they stay true (Meta); a milestone (STATS_MILESTONE) acts at each multiple of its value.')
  if (x.type === 'PING_ENDPOINT') out.push(PING_WARNING)
  if (x.type === 'NOTIFICATION' && !x.notifyUserIds?.length) out.push('Without notifyUserIds Meta notifies the rule\'s creator — this business\'s system user, which no person reads: name the people.')
  if (x.notifyUserIds?.length) out.push(`Meta notifies the Facebook people ${x.notifyUserIds.join(', ')}${r.evaluation.type === 'SCHEDULE' ? ' (and e-mails them a daily summary at 00:30 in the account\'s time zone)' : ''}: Nexus cannot check who they are — name only people of this business.`)
  if (x.type === 'UNPAUSE' && !fields.includes('effective_status')) out.push('Without an effective_status filter, Meta\'s default for a switch-on rule takes every object that is not deleted or archived (paused ones too): scope it tightly (an id, a name or effective_status).')
  const cost = [...fields, r.evaluation.trigger?.field ?? ''].some((f) => f && valueKeyOf(f) === 'valueCents' && !isMetadata(f))
  if ((x.type === 'PAUSE' || x.type === 'REBALANCE_BUDGET') && cost) out.push('Meta may refuse this (its error 2703: "Rules that turn off ads can\'t have cost conditions"): if it does, change the conditions (no spend or cost condition) or the action (notify instead).')
  if ([...fields, x.change?.targetField ?? '', x.rebalance?.targetField ?? ''].some((f) => /(^|\.)(7d|28d)_view(_\d+d_click)?:/.test(f))) out.push('A 7-day or 28-day view attribution window returns no data since 2026-01-12 (Meta): a condition on it never matches.')
  if (x.type === 'ROTATE') out.push('ROTATE pauses the ad running now and switches the next ad of the ad set on.')
  if (x.type === 'REBALANCE_BUDGET' && (x.rebalance?.type === 'EVEN' || x.rebalance?.type === 'PROPORTIONAL')) out.push(`${x.rebalance.type} pauses the ad sets that match and moves their budget to the others (Meta).`)
  if (x.type === 'REBALANCE_BUDGET') out.push('Meta rebalances daily and lifetime budgets apart (a daily budget only to daily ones), and from a lifetime budget it moves only what is left of it.')
  if (x.type === 'CHANGE_BID') out.push('CHANGE_BID changes the bid of ad sets that bid by hand (a bid cap or a cost cap); others have no bid to change.')
  if (!on && r.evaluation.type === 'SCHEDULE') out.push('It is made switched OFF: set-meta-ad-rule action status enabled true switches it on — that preview shows Meta\'s own preview of the objects it would act on.')
  return out
}

/** Why a rule can make the account spend more when it acts, in words (null when it cannot): step 8's canRaiseSpend. */
function raiseWords(words: ReturnType<RuleWords>): string | null {
  return words.canRaiseSpend ? `it ${words.action.text ?? words.action.type ?? 'acts'}` : null
}

const describeOrNull = (words: RuleWords, r: Row) => { try { return words(r) } catch { return null } }

/** create: one POST act_<id>/adrules_library; DISABLED unless `enable: true`. */
export function createRuleDraft(request: AdRuleRequest, ctx: RuleDraftContext): MetaChangeDraft {
  if (request.ruleId) refuse('A new rule names no ruleId (Meta gives it one).')
  if (!request.name?.trim()) refuse('A new rule names its name.')
  if (!request.evaluation || !request.execution) refuse('A new rule names its conditions (evaluation) and its action (execution).')
  if (request.enabled !== undefined) refuse('A new rule is switched on with enable (true), not enabled.')
  const r = { evaluation: request.evaluation!, execution: request.execution!, schedule: request.schedule }
  ruleProblems(r, ctx.currency)
  const specs = specsOf(r, ctx.currency)
  const problem = wholeRuleSpecsProblem(specs.evaluation, specs.execution, specs.schedule)
  if (problem) refuse(`Nexus would not send this rule: ${problem}.`)
  const on = request.enable === true
  const status = on ? 'ENABLED' : 'DISABLED'
  const words = ctx.words(raw(request.name!, specs, status))
  const raises = on ? raiseWords(words) : null
  const params: Record<string, string> = {
    name: request.name!.trim(), evaluation_spec: JSON.stringify(specs.evaluation), execution_spec: JSON.stringify(specs.execution),
    ...(specs.schedule ? { schedule_spec: JSON.stringify(specs.schedule) } : {}), status,
  }
  const { changes } = changeLines([
    ['Rule', null, request.name!.trim()],
    ['Status', null, on ? 'ON (ENABLED)' : 'off (DISABLED)'],
    ['Conditions', null, conditionsText(r.evaluation, ctx.currency)],
    ['Action', null, words.action.text ?? r.execution.type],
    ['Schedule', null, scheduleText(r.schedule) ?? 'real time (trigger)'],
  ])
  const request1: MetaChangeRequest = {
    step: 1, label: `Make the rule "${request.name!.trim()}" (${on ? 'switched on' : 'switched off'})`, kind: 'campaign', objectKind: 'adaccount', objectId: `act_${ctx.adAccountId}`,
    params, check: 'none', raisesSpend: !!raises, readBackInPost: false, budget: false, undoable: true, operation: 'adRule.create', edge: 'adrules_library',
    expect: { status }, readBackFields: AD_RULE_READ_BACK,
  }
  const before: RuleRecord = { kind: 'adrule', action: 'create', id: '', exists: 'no', undo: null, noUndo: [] }
  const after: RuleRecord = { kind: 'adrule', action: 'create', id: '', exists: 'yes', rule: ruleStateOf(request.name!.trim(), status, { evaluation: specs.evaluation, execution: specs.execution, schedule: specs.schedule ?? null }) }
  return {
    summary: `Make the Meta rule "${request.name!.trim()}" on ad account ${ctx.adAccountId}, switched ${on ? 'ON' : 'off'}: ${words.action.text ?? r.execution.type}.`,
    changes, totals: { rules: 1 },
    warnings: [META_NO_CHECK, 'Meta previews a rule (the objects it would act on now) only once it exists: Nexus makes it first.', ...ruleWarnings(r, on)],
    spendsMoney: raises ? [`The new rule is made ON and ${raises}: from its first run it can make the account spend more on every object it matches.`] : [],
    skipped: [], requests: [request1],
    stands: { adAccountId: ctx.adAccountId, create: params },
    before, after,
  }
}

/** update: the whole rule, the parts not named as Meta has them (RU-026). */
export function updateRuleDraft(request: AdRuleRequest, ctx: RuleDraftContext): MetaChangeDraft {
  const live = liveFrom(ctx)
  if (request.enable !== undefined || request.enabled !== undefined) refuse('A change of a rule\'s parts does not switch it on or off: that is action status.')
  const who = ruleWho(live)
  const skipped: string[] = []
  const params: Record<string, string> = {}
  const name = request.name?.trim()
  if (name !== undefined) { if (name === live.name) skipped.push(`${who} is already named "${name}".`); else params.name = name }
  const partsNamed = request.evaluation !== undefined || request.execution !== undefined || request.schedule !== undefined
  let specs: { evaluation: Row; execution: Row; schedule: Row | undefined } | null = null
  let ruleNow: { evaluation: RuleEvaluationInput; execution: RuleExecutionInput; schedule?: RuleScheduleInput } | null = null
  if (partsNamed) {
    const liveInput = ruleInputOf(live.specs, ctx.currency)
    // The parts not named go exactly as Meta has them — only when Nexus can name them again exactly.
    const needLive = !request.evaluation?.filters || !request.execution || (request.evaluation?.type ?? live.specs.evaluation?.evaluation_type) === 'TRIGGER' && !request.evaluation?.trigger
      || (request.evaluation?.type ?? live.specs.evaluation?.evaluation_type) === 'SCHEDULE' && !request.schedule
    if (needLive && 'why' in liveInput) refuse(`${who} holds parts Nexus cannot send back exactly (${liveInput.why}) — and Meta needs the whole rule on a change: name every part (evaluation with its filters, execution, schedule), or change it in Ads Manager.`)
    const base = 'why' in liveInput ? null : liveInput
    const liveType = live.specs.evaluation?.evaluation_type === 'TRIGGER' || live.specs.evaluation?.evaluation_type === 'SCHEDULE' ? live.specs.evaluation.evaluation_type as 'TRIGGER' | 'SCHEDULE' : undefined
    const type = request.evaluation?.type ?? base?.evaluation.type ?? liveType
    const evaluation: RuleEvaluationInput = {
      type,
      filters: request.evaluation?.filters ?? base?.evaluation.filters,
      ...(type === 'TRIGGER' ? { trigger: request.evaluation?.trigger ?? base?.evaluation.trigger } : {}),
    }
    if (type === 'SCHEDULE' && request.evaluation?.trigger) refuse('A schedule rule has no trigger.')
    ruleNow = { evaluation, execution: request.execution ?? base!.execution, ...(type === 'SCHEDULE' ? { schedule: request.schedule ?? base?.schedule } : {}) }
    if (type === 'TRIGGER' && request.schedule) refuse('A trigger rule has no schedule (Meta checks it in real time).')
    ruleProblems(ruleNow, ctx.currency)
    specs = specsOf(ruleNow, ctx.currency)
    const problem = wholeRuleSpecsProblem(specs.evaluation, specs.execution, specs.schedule)
    if (problem) refuse(`Nexus would not send this rule: ${problem}.`)
    const same = base && JSON.stringify(specsOf(base, ctx.currency)) === JSON.stringify(specs)
    if (same) skipped.push(`${who} already has these conditions, action and schedule.`)
    else Object.assign(params, { evaluation_spec: JSON.stringify(specs.evaluation), execution_spec: JSON.stringify(specs.execution), ...(specs.schedule ? { schedule_spec: JSON.stringify(specs.schedule) } : {}) })
  }
  const specsChanged = 'evaluation_spec' in params
  const on = live.status === 'ENABLED'
  const after = specsChanged ? describeOrNull(ctx.words, raw(params.name ?? live.name, specs!, live.status)) : live.words
  const spends: string[] = []
  if (on && specsChanged && after?.canRaiseSpend) spends.push(`${who} is on: from its next run the changed rule ${after.action.text ?? 'acts'} — it can make the account spend more on every object it matches.`)
  else if (on && specsChanged && ruleIsBrake(live.specs.execution)) spends.push(`${who} is on and it ${live.words.action.text ?? 'acts as a brake'}: changed, it may stop or cut less — what it would have stopped keeps spending.`)
  const liveInput = ruleInputOf(live.specs, ctx.currency)
  const noUndo: string[] = []
  let undo: Record<string, unknown> | null = null
  if (specsChanged && 'why' in liveInput) noUndo.push(`Its old parts cannot be sent back exactly (${liveInput.why})`)
  else if (Object.keys(params).length) {
    const oldName = nameAgain(live.name)
    undo = {
      action: 'update', ruleId: live.id,
      ...('name' in params && oldName ? { name: oldName } : {}),
      ...(specsChanged && !('why' in liveInput) ? { evaluation: liveInput.evaluation, execution: liveInput.execution, ...(liveInput.schedule ? { schedule: liveInput.schedule } : {}) } : {}),
    }
    if ('name' in params && !oldName) { noUndo.push('Its old name cannot be named again exactly.'); if (!specsChanged) undo = null }
  }
  const requests: MetaChangeRequest[] = Object.keys(params).length ? [{
    step: 1, label: `Change ${who}`, kind: 'campaign', objectKind: 'adrule', objectId: live.id, params, check: 'none', raisesSpend: spends.length > 0,
    readBackInPost: false, budget: false, undoable: !!undo, operation: 'adRule.update', expect: { ...(live.status ? { status: live.status } : {}), ...(params.name ? { name: params.name } : {}) }, readBackFields: AD_RULE_READ_BACK,
  }] : []
  const lines: Array<[string, unknown, unknown]> = []
  if (params.name) lines.push(['Rule name', live.name, params.name])
  if (specsChanged) {
    const before = 'why' in liveInput ? null : liveInput
    lines.push(['Conditions', conditionsText(before?.evaluation, ctx.currency) ?? 'as Meta has them', conditionsText(ruleNow!.evaluation, ctx.currency)])
    lines.push(['Action', live.words.action.text ?? live.words.action.type, after?.action.text ?? ruleNow!.execution.type])
    lines.push(['Schedule', scheduleText(before?.schedule) ?? (live.specs.schedule ? 'as Meta has it' : 'real time (trigger)'), scheduleText(ruleNow!.schedule) ?? 'real time (trigger)'])
  }
  const previewLine = specsChanged && ctx.preview ? [`${ctx.preview.sentence} (Meta previews the rule as it is now, before this change.)`] : []
  return {
    summary: `Change ${who} on ad account ${ctx.adAccountId}${params.name ? `: name "${params.name}"` : ''}${specsChanged ? `${params.name ? ', and' : ':'} its conditions, action and schedule (sent whole)` : ''}.`,
    changes: changeLines(lines).changes, totals: { rules: requests.length, objectsMatchingNow: ctx.preview?.read ? ctx.preview.objects.length : 0 },
    warnings: [META_NO_CHECK, ...(specsChanged ? ['Meta needs the whole rule on a change: the parts not named are sent exactly as Meta has them.', ...ruleWarnings(ruleNow!, true)] : []), ...previewLine],
    spendsMoney: spends, skipped, requests,
    stands: { rule: ruleStateOf(live.name, live.status, live.specs) },
    before: { kind: 'adrule', action: 'update', id: live.id, exists: 'yes', rule: ruleStateOf(live.name, live.status, live.specs), undo, noUndo } satisfies RuleRecord,
    after: { kind: 'adrule', action: 'update', id: live.id, exists: 'yes', rule: specs ? ruleStateOf(params.name ?? live.name, live.status, { evaluation: specs.evaluation, execution: specs.execution, schedule: specs.schedule ?? null }) : ruleStateOf(params.name ?? live.name, live.status, live.specs) } satisfies RuleRecord,
  }
}

/** status: switch a rule on or off (RU-027). */
export function statusRuleDraft(request: AdRuleRequest, ctx: RuleDraftContext): MetaChangeDraft {
  const live = liveFrom(ctx)
  if (request.enabled === undefined) refuse('action status names enabled: true (switch the rule on) or false (off).')
  if (request.name !== undefined || request.evaluation || request.execution || request.schedule || request.enable !== undefined) refuse('A switch on or off goes on its own (Meta: it needs no spec); change the rule\'s parts with action update.')
  const who = ruleWho(live)
  const to = request.enabled ? 'ENABLED' : 'DISABLED'
  const skipped = live.status === to ? [`${who} is already ${request.enabled ? 'on' : 'off'}.`] : []
  const warnings = [META_NO_CHECK]
  if (live.status === 'HAS_ISSUES') warnings.push(`Meta stopped ${who} (HAS_ISSUES${live.disableErrorCode !== null ? `, code ${live.disableErrorCode}` : ''}; Meta does not document the codes)${request.enabled ? ': switching it on may be refused until its issue is fixed' : ''}.`)
  if (request.enabled && live.words.action.type === 'PING_ENDPOINT') warnings.push(PING_WARNING)
  if (request.enabled && ctx.preview) warnings.push(ctx.preview.sentence)
  if (request.enabled && live.words.evaluationType === 'TRIGGER') warnings.push('A trigger rule acts in real time once on (Meta has no preview for trigger rules): its conditions decide.')
  const spends: string[] = []
  if (!skipped.length && request.enabled && live.words.canRaiseSpend) {
    spends.push(`Switching ${who} on lets it ${live.words.action.text ?? 'act'} on every object it matches${ctx.preview?.read ? ` (Meta's preview: ${ctx.preview.objects.length}${ctx.preview.more ? '+' : ''} now)` : ''}: it can make the account spend more.`)
  }
  if (!skipped.length && !request.enabled && live.status === 'ENABLED' && ruleIsBrake(live.specs.execution)) {
    spends.push(`${who} is on and it ${live.words.action.text ?? 'acts as a brake'}: switched off, what it would have stopped keeps spending.`)
  }
  const back = live.status === 'ENABLED' || live.status === 'DISABLED' ? live.status === 'ENABLED' : null
  const requests: MetaChangeRequest[] = skipped.length ? [] : [{
    step: 1, label: `Switch ${who} ${request.enabled ? 'on' : 'off'}`, kind: 'campaign', objectKind: 'adrule', objectId: live.id, params: { status: to }, check: 'none',
    raisesSpend: spends.length > 0, readBackInPost: false, budget: false, undoable: back !== null, operation: 'adRule.status', expect: { status: to }, readBackFields: AD_RULE_READ_BACK,
  }]
  return {
    summary: `Switch ${who} ${request.enabled ? 'ON' : 'off'} on ad account ${ctx.adAccountId}.`,
    changes: changeLines([['Status', live.status, to]]).changes, totals: { rules: requests.length, objectsMatchingNow: ctx.preview?.read ? ctx.preview.objects.length : 0 },
    warnings, spendsMoney: spends, skipped, requests,
    stands: { rule: ruleStateOf(live.name, live.status, live.specs) },
    before: { kind: 'adrule', action: 'status', id: live.id, exists: 'yes', rule: ruleStateOf(live.name, live.status, live.specs), undo: back === null ? null : { action: 'status', ruleId: live.id, enabled: back }, noUndo: back === null ? [`Meta had stopped it (${live.status}): Nexus does not set that back.`] : [] } satisfies RuleRecord,
    after: { kind: 'adrule', action: 'status', id: live.id, exists: 'yes', rule: ruleStateOf(live.name, to, live.specs) } satisfies RuleRecord,
  }
}

/** run: a schedule rule now (RU-032); the objects Meta's preview lists are part of what it stands on. */
export function runRuleDraft(request: AdRuleRequest, ctx: RuleDraftContext): MetaChangeDraft {
  const live = liveFrom(ctx)
  if (request.name !== undefined || request.evaluation || request.execution || request.schedule || request.enable !== undefined || request.enabled !== undefined) refuse('action run names only the rule (ruleId).')
  const who = ruleWho(live)
  if (live.words.evaluationType !== 'SCHEDULE') refuse(`${who} is a trigger rule: Meta runs it when its trigger fires and documents no way to run it by hand (only schedule rules, RU-032).`)
  const warnings = [META_NO_CHECK, 'A run cannot be taken back by Nexus at once: meta-ad-rules view history lists what it did to each object (old and new values) — put those back with set-meta-status, set-meta-ad-set or set-meta-campaign.']
  if (ctx.preview) warnings.push(ctx.preview.sentence)
  if (ctx.preview?.read && ctx.preview.objects.length === 0) warnings.push('Meta\'s preview finds no object the rule would act on now: running it changes nothing.')
  if (live.status !== 'ENABLED') warnings.push(`${who} is ${live.status === 'HAS_ISSUES' ? 'stopped by Meta (HAS_ISSUES)' : 'off'}: Meta does not document whether a rule that is not on runs when asked — its answer decides (LIVE-PROBES RU-032).`)
  const spends = live.words.canRaiseSpend
    ? [`Running ${who} now: it ${live.words.action.text ?? 'acts'}${ctx.preview?.read ? ` on the ${ctx.preview.objects.length}${ctx.preview.more ? '+' : ''} object(s) Meta's preview lists` : ' on every object it matches'} — it can make the account spend more.`]
    : []
  return {
    summary: `Run ${who} now on ad account ${ctx.adAccountId}: it ${live.words.action.text ?? live.words.action.type ?? 'acts'}.`,
    changes: changeLines([['Run now', null, `${live.words.action.text ?? live.words.action.type}${ctx.preview?.read ? ` — ${ctx.preview.objects.length}${ctx.preview.more ? '+' : ''} object(s) match now` : ''}`]]).changes,
    totals: { rules: 1, objectsMatchingNow: ctx.preview?.read ? ctx.preview.objects.length : 0 },
    warnings, spendsMoney: spends, skipped: [],
    requests: [{
      step: 1, label: `Run ${who} now`, kind: 'campaign', objectKind: 'adrule', objectId: live.id, params: {}, check: 'none', raisesSpend: spends.length > 0,
      readBackInPost: false, budget: false, undoable: false, operation: 'adRule.run', edge: 'execute',
    }],
    // A run that would act on other objects than the person approved is not sent.
    stands: { rule: ruleStateOf(live.name, live.status, live.specs), matches: ctx.preview?.read ? { ids: ctx.preview.objects.map((o) => o.id).sort(), more: ctx.preview.more } : null },
    before: { kind: 'adrule', action: 'run', id: live.id, exists: 'yes', undo: null, noUndo: ['What a rule did when it ran cannot be taken back by Nexus at once: meta-ad-rules view history lists each object it changed (old and new values); set-meta-status, set-meta-ad-set and set-meta-campaign put them back.'] } satisfies RuleRecord,
    after: { kind: 'adrule', action: 'run', id: live.id, exists: 'yes' } satisfies RuleRecord,
  }
}

/** remove-meta-ad-rule: DELETE /<rule id> (RU-028); undo makes it again from what it was (a new rule, a new id). */
export function removeRuleDraft(ctx: RuleDraftContext): MetaChangeDraft {
  const live = liveFrom(ctx)
  const who = ruleWho(live)
  const input = ruleInputOf(live.specs, ctx.currency)
  const name = nameAgain(live.name)
  const back: RuleCreateArgs | null = 'why' in input || !name ? null : { action: 'create', name, ...input, ...(live.status === 'ENABLED' ? { enable: true } : {}) }
  const spends = live.status === 'ENABLED' && ruleIsBrake(live.specs.execution) ? [`${who} is on and it ${live.words.action.text ?? 'acts as a brake'}: without it, what it would have stopped keeps spending.`] : []
  return {
    summary: `Delete ${who} on ad account ${ctx.adAccountId} (${live.words.action.text ?? live.words.action.type ?? 'its action'}).`,
    changes: changeLines([['Rule', `${live.name ?? live.id} (${live.status ?? 'status unknown'})`, 'deleted']]).changes, totals: { rules: 1 },
    warnings: [META_NO_CHECK, `Deleting a rule is for good on Meta: undo makes a NEW rule with the same name, conditions, action, schedule and status (a new id; this one's run history does not come back).${back ? '' : ` This one cannot be made again by Nexus (${'why' in input ? input.why : 'its name cannot be named again exactly.'})`}`],
    spendsMoney: spends, skipped: [],
    requests: [{
      step: 1, label: `Delete ${who}`, kind: 'campaign', objectKind: 'adrule', objectId: live.id, params: {}, check: 'none', raisesSpend: spends.length > 0,
      readBackInPost: false, budget: false, undoable: false, operation: 'adRule.delete', method: 'DELETE',
    }],
    stands: { rule: ruleStateOf(live.name, live.status, live.specs) },
    before: { kind: 'adrule', action: 'remove', id: live.id, exists: 'yes', rule: ruleStateOf(live.name, live.status, live.specs), undo: back as unknown as Record<string, unknown> | null, noUndo: back ? [] : ['It cannot be made again by Nexus: its parts or name were not readable exactly.'] } satisfies RuleRecord,
    after: { kind: 'adrule', action: 'remove', id: live.id, exists: 'no' } satisfies RuleRecord,
  }
}

/** The draft of set-meta-ad-rule for its action. */
export function adRuleDraft(request: AdRuleRequest, ctx: RuleDraftContext): MetaChangeDraft {
  switch (request.action) {
    case 'create': return createRuleDraft(request, ctx)
    case 'update': return updateRuleDraft(request, ctx)
    case 'status': return statusRuleDraft(request, ctx)
    case 'run': return runRuleDraft(request, ctx)
  }
}
